/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Every function exported here becomes an IPC handler that any renderer script can call (even with the
// plugin disabled), so each one validates its arguments and never runs a shell. Only functions may be
// exported from this file.

import { RendererSettings } from "@main/settings";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { BrowserWindow, dialog, IpcMainInvokeEvent, OpenDialogOptions, shell } from "electron";
// Bundled at build time (scripts/build/common.mjs fileUrlPlugin), so no file is read at runtime.
import dcefTemplate from "file://dcef-template.html";
import { closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "path";

import { CATBOX_USERHASH_RE, CF_ACCOUNT_RE, CF_PROJECT_RE, CF_TOKEN_RE, EXPORT_FILENAME_RE, EXPORT_SNIFF_BYTES, looksLikeExportHead, MAX_SHARE_BYTES } from "./validation";

/**
 * Exact wrangler version run through npx for sharing. Pinned so a new (or hijacked) wrangler release
 * never runs with the user's Cloudflare token. 4.63.0 is the newest version found in the local npm
 * cache when this was written (offline); bump it deliberately after checking the release.
 */
const WRANGLER_VERSION = "4.63.0";

/** Sanity cap for a locally saved export (Base64-media exports can be big). */
const MAX_EXPORT_CHARS = 1024 * 1024 * 1024;
/** Largest text attachment inlined into an export. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Hosts whose media may be re-hosted on catbox (Discord's CDN and media proxy, Twemoji for reactions). */
function isCatboxSourceHost(host: string): boolean {
    return host === "cdn.discordapp.com"
        || host === "media.discordapp.net"
        || /^images-ext-\d+\.discordapp\.net$/.test(host)
        || host === "cdn.jsdelivr.net";
}

/** Hosts text attachments may be fetched from to inline them. */
const TEXT_SOURCE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net", "files.catbox.moe"]);

function parseHttpsUrl(value: unknown): URL | null {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
        return url;
    } catch {
        return null;
    }
}

/** Trimmed Cloudflare settings (account ID lowercased), or null if any is missing or malformed. */
function cfConfig(token: unknown, accountId: unknown, project: unknown): { token: string; accountId: string; project: string; } | null {
    const t = typeof token === "string" ? token.trim() : "";
    const a = typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
    const p = typeof project === "string" ? project.trim() : "";
    return CF_TOKEN_RE.test(t) && CF_ACCOUNT_RE.test(a) && CF_PROJECT_RE.test(p) ? { token: t, accountId: a, project: p } : null;
}

const NETWORK_FOLDER = "Network folders aren't supported. Use a local folder (a mapped drive letter works).";

/**
 * UNC / device paths (`\\host\share`, `//host/share`, `\\?\C:\...`) are refused before any filesystem
 * call: merely touching one makes Windows open an SMB/WebDAV connection that can leak the NTLM hash.
 */
function isUncLike(value: string): boolean {
    return /^[\\/]{2}/.test(value);
}

function isLocalAbsolutePath(value: unknown): value is string {
    return typeof value === "string" && value.length < 4096 && !value.includes("\0") && !isUncLike(value) && isAbsolute(value);
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The resolved path of an export file (`abc-xyz-1700000000.html`) directly inside the configured save
 * folder, or a message saying why it can't be used. Callers act on the returned path only.
 */
function resolveExportPath(value: unknown, verb: "open" | "delete"): { path: string; } | { error: string; } {
    if (typeof value !== "string" || !value || value.length >= 4096 || value.includes("\0")) return { error: "Invalid file path" };
    if (isUncLike(value)) return { error: NETWORK_FOLDER };
    if (!isAbsolute(value)) return { error: "Invalid file path" };
    const p = resolve(value);
    if (!EXPORT_FILENAME_RE.test(basename(p))) return { error: "Not an ExportChat export file" };
    const save = resolveSaveDir();
    if ("dir" in save && samePath(dirname(p), save.dir)) return { path: p };
    if ("error" in save && save.error === NETWORK_FOLDER) return { error: NETWORK_FOLDER };
    return { error: `This export was saved to a different folder. ${verb === "open" ? "Open" : "Delete"} it from there.` };
}

/** True if the start of the file looks like an export this plugin wrote (a Finish Editing copy included). */
function looksLikeExport(filePath: string): boolean {
    const fd = openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(EXPORT_SNIFF_BYTES);
        const n = readSync(fd, buf, 0, buf.length, 0);
        return looksLikeExportHead(buf.toString("utf-8", 0, n));
    } finally {
        closeSync(fd);
    }
}

/**
 * Files picked with pickHtmlFile that the renderer hasn't confirmed yet (one-time token to the resolved
 * path). Only the most recent few are kept.
 */
const pendingPicks = new Map<string, string>();
const MAX_PENDING_PICKS = 8;

/**
 * Files the user picked with pickHtmlFile this session and the renderer then confirmed as exports
 * (confirmPick), stored as the exact resolved path native returned. They are the only files outside
 * the save folder deleteLocalFile accepts, matched exactly (no case folding, so no other file whose
 * name folds to the same key), and deleteLocalFile acts on that stored path. Memory only: a Discord
 * restart forgets them, and only native's own file picker can add to it.
 */
const deletablePicks = new Set<string>();

/**
 * The resolved path of a file deleteLocalFile may act on: an export directly inside the save folder
 * (resolveExportPath), or a confirmed pick, exactly as native returned it.
 */
function resolveDeletePath(value: unknown): { path: string; } | { error: string; } {
    if (isLocalAbsolutePath(value)) {
        const p = resolve(value);
        if (deletablePicks.has(p)) return { path: p };
    }
    return resolveExportPath(value, "delete");
}

/** The configured save folder, or why it can't be used. */
function resolveSaveDir(): { dir: string; } | { error: string; } {
    const raw = RendererSettings.store.plugins?.ExportChat?.saveLocation;
    const dir = typeof raw === "string" ? raw.trim() : "";
    if (!dir) return { error: "No save location is set in ExportChat settings" };
    if (isUncLike(dir)) return { error: NETWORK_FOLDER };
    if (!isLocalAbsolutePath(dir)) return { error: "The save location in ExportChat settings must be a full folder path" };
    try {
        if (statSync(dir).isDirectory()) return { dir: resolve(dir) };
    } catch { /* falls through */ }
    return { error: "The save location in ExportChat settings isn't an existing folder" };
}

async function cfApi(token: string, path: string, method: "GET" | "DELETE"): Promise<any> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    return res.json();
}

/** Full deployment UUID for a short preview hash (the `abcd1234` in `https://abcd1234.project.pages.dev`). */
async function lookupDeploymentId(token: string, accountId: string, project: string, shortHash: string): Promise<string> {
    try {
        const data = await cfApi(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=10`, "GET");
        const previewUrl = `https://${shortHash}.${project}.pages.dev`;
        const dep = Array.isArray(data?.result)
            ? data.result.find((d: any) => typeof d?.id === "string" && (d.short_id === shortHash || d.id.startsWith(shortHash) || d.url === previewUrl))
            : undefined;
        return typeof dep?.id === "string" && /^[0-9a-f-]{36}$/.test(dep.id) ? dep.id : "";
    } catch {
        return "";
    }
}

/**
 * How to run npx without a shell. On Windows `npx` is `npx.cmd`, which Node refuses to spawn without
 * a shell, so run npm's own npx-cli.js with the node.exe next to it on PATH instead.
 */
function findNpx(): { file: string; args: string[]; } | null {
    if (process.platform !== "win32") return { file: "npx", args: [] };
    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
        const dir = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!dir || !isAbsolute(dir)) continue;
        const node = join(dir, "node.exe");
        const cli = join(dir, "node_modules", "npm", "bin", "npx-cli.js");
        if (existsSync(node) && existsSync(cli)) return { file: node, args: [cli] };
    }
    return null;
}

const NO_NODE = "Sharing needs Node.js (npx) on your PATH. Install Node.js from nodejs.org, then restart Discord.";

export function loadDcefTemplate(_: IpcMainInvokeEvent): string {
    return dcefTemplate;
}

/**
 * Writes an export into the save folder from the plugin settings. The renderer only picks the file
 * name (which must look like an export name), never the folder.
 */
export function saveExport(_: IpcMainInvokeEvent, fileName: string, content: string, behavior: "increment" | "overwrite"): { success: boolean; path?: string; error?: string; } {
    if (typeof fileName !== "string" || !EXPORT_FILENAME_RE.test(fileName)) return { success: false, error: "Invalid file name" };
    if (typeof content !== "string" || content.length > MAX_EXPORT_CHARS) return { success: false, error: "Invalid export content" };
    const save = resolveSaveDir();
    if ("error" in save) return { success: false, error: save.error };
    const { dir } = save;

    const overwrite = behavior === "overwrite";
    let target = join(dir, fileName);
    if (!overwrite && existsSync(target)) {
        const stem = fileName.slice(0, -".html".length);
        let n = 2;
        while (n < 100_000 && existsSync(join(dir, `${stem}_${n}.html`))) n++;
        target = join(dir, `${stem}_${n}.html`);
    }

    try {
        // "wx" refuses to replace a file that appeared since the check above.
        writeFileSync(target, content, { encoding: "utf-8", flag: overwrite ? "w" : "wx" });
        return { success: true, path: target };
    } catch (e: any) {
        return { success: false, path: target, error: String(e?.message ?? e) };
    }
}

export async function uploadToCatbox(_: IpcMainInvokeEvent, url: string, userhash?: string): Promise<string> {
    const parsed = parseHttpsUrl(url);
    if (!parsed || !isCatboxSourceHost(parsed.hostname)) throw new Error("Only Discord CDN and Twemoji URLs are uploaded to catbox");
    const hash = typeof userhash === "string" ? userhash.trim() : "";
    if (hash && !CATBOX_USERHASH_RE.test(hash)) throw new Error("Invalid catbox userhash");

    const form = new FormData();
    form.append("reqtype", "urlupload");
    if (hash) form.append("userhash", hash);
    form.append("url", parsed.href);

    const res = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
    });
    const text = (await res.text()).trim();
    if (/^https:\/\/files\.catbox\.moe\/[A-Za-z0-9._-]+$/.test(text)) return text;
    throw new Error(text.slice(0, 200) || `Empty catbox response (HTTP ${res.status})`);
}

/** Text of a .txt/.log/.md/.json/.csv attachment (up to 2 MB), or "" when it can't or shouldn't be inlined. */
export async function fetchTextContent(_: IpcMainInvokeEvent, url: string): Promise<string> {
    const parsed = parseHttpsUrl(url);
    if (!parsed || !TEXT_SOURCE_HOSTS.has(parsed.hostname)) return "";
    try {
        const res = await fetch(parsed.href, { redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!res.ok || !res.body) return "";
        if (Number(res.headers.get("content-length") ?? 0) > MAX_TEXT_BYTES) return "";

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_TEXT_BYTES) {
                await reader.cancel().catch(() => { });
                return "";
            }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf-8");
    } catch {
        return "";
    }
}

export function openFileLocation(_: IpcMainInvokeEvent, filePath: string): { success: boolean; error?: string; } {
    const target = resolveExportPath(filePath, "open");
    if ("error" in target) return { success: false, error: target.error };
    try {
        if (!existsSync(target.path)) return { success: false, error: "The file no longer exists" };
        shell.showItemInFolder(target.path);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: String(e?.message ?? e) };
    }
}

/**
 * Deletes an export file. Refuses anything that isn't an export this plugin wrote, in the save folder
 * or picked with pickHtmlFile and confirmed this session.
 */
export function deleteLocalFile(_: IpcMainInvokeEvent, filePath: string): { success: boolean; error?: string; } {
    const target = resolveDeletePath(filePath);
    if ("error" in target) return { success: false, error: target.error };
    const p = target.path;
    try {
        if (!existsSync(p)) {
            deletablePicks.delete(p);
            return { success: true }; // already gone
        }
        if (!lstatSync(p).isFile() || !looksLikeExport(p)) {
            console.warn("[ExportChat] deleteLocalFile: refused, not an ExportChat export:", p);
            return { success: false, error: "That file isn't an ExportChat export." };
        }
        rmSync(p);
        deletablePicks.delete(p);
        return { success: true };
    } catch (e: any) {
        console.error("[ExportChat] deleteLocalFile failed:", p, e?.message);
        return { success: false, error: String(e?.message ?? e) };
    }
}

/**
 * Discord's own file picker for History > Upload: one .html file up to Cloudflare Pages' 25 MB limit,
 * read here so the renderer never passes a path in. Only a file that looks like an export is returned.
 * `token` lets the renderer confirm the file once its stricter check passes (confirmPick); only then
 * may the upload dialog delete it. Null when cancelled.
 */
export async function pickHtmlFile(e: IpcMainInvokeEvent): Promise<{ path: string; name: string; content: string; token: string; } | { error: string; } | null> {
    let raw: string | undefined;
    try {
        const options: OpenDialogOptions = {
            title: "Choose an ExportChat export",
            properties: ["openFile"],
            filters: [{ name: "HTML", extensions: ["html"] }],
        };
        const win = e?.sender ? BrowserWindow.fromWebContents(e.sender) : null;
        const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (res.canceled) return null;
        raw = res.filePaths[0];
    } catch (err: any) {
        return { error: `Couldn't open the file picker: ${String(err?.message ?? err).slice(0, 200)}` };
    }
    if (!raw) return null;
    if (typeof raw !== "string" || isUncLike(raw)) return { error: NETWORK_FOLDER };
    if (!isLocalAbsolutePath(raw)) return { error: "Invalid file path" };
    const p = resolve(raw);
    if (!/\.html$/i.test(p)) return { error: "Choose an .html file." };

    let fd = -1;
    try {
        const link = lstatSync(p, { bigint: true });
        if (!link.isFile()) return { error: "That isn't a plain file." }; // no symlinks or folders
        fd = openSync(p, "r");
        // Same file as the one checked above (not swapped for a link in between). Only the inode is
        // compared: on Windows lstat reports dev 0 while fstat reports the volume serial.
        const opened = fstatSync(fd, { bigint: true });
        if (opened.ino !== link.ino) return { error: "The file changed while it was being opened. Try again." };
        if (opened.size > BigInt(MAX_SHARE_BYTES)) return { error: "That file is over Cloudflare Pages' 25 MB limit." };
        const content = readFileSync(fd, "utf-8");
        // Only exports go back to the renderer (it checks them again, more strictly)
        if (!looksLikeExportHead(content.slice(0, EXPORT_SNIFF_BYTES))) return { error: "That file isn't an ExportChat export." };
        const token = randomBytes(16).toString("hex");
        pendingPicks.set(token, p);
        for (const old of pendingPicks.keys()) {
            if (pendingPicks.size <= MAX_PENDING_PICKS) break;
            pendingPicks.delete(old);
        }
        return { path: p, name: basename(p), content, token };
    } catch (err: any) {
        return { error: `Couldn't read the file: ${String(err?.message ?? err).slice(0, 200)}` };
    } finally {
        if (fd >= 0) closeSync(fd);
    }
}

/**
 * The renderer read the picked file as an ExportChat export (parseExportHtml), so the upload dialog may
 * delete it. One use per token; false for an unknown or used token.
 */
export function confirmPick(_: IpcMainInvokeEvent, token: string): boolean {
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return false;
    const p = pendingPicks.get(token);
    if (!p) return false;
    pendingPicks.delete(token);
    deletablePicks.add(p);
    return true;
}

/** The renderer refused the picked file (not an export it can read): forget the pick's token. */
export function rejectPick(_: IpcMainInvokeEvent, token: string): void {
    if (typeof token === "string") pendingPicks.delete(token);
}

export async function deletePagesDeployment(_: IpcMainInvokeEvent, cfApiToken: string, cfAccountId: string, project: string, deploymentId: string): Promise<{ success: boolean; error?: string; }> {
    const cf = cfConfig(cfApiToken, cfAccountId, project);
    if (!cf) return { success: false, error: "Cloudflare settings are missing or invalid" };
    if (typeof deploymentId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(deploymentId))
        return { success: false, error: "Invalid deployment ID" };

    let id = deploymentId;
    if (id.length < 36) {
        id = await lookupDeploymentId(cf.token, cf.accountId, cf.project, id);
        if (!id) return { success: false, error: "Deployment not found" };
    }

    try {
        const data = await cfApi(cf.token, `/accounts/${encodeURIComponent(cf.accountId)}/pages/projects/${encodeURIComponent(cf.project)}/deployments/${encodeURIComponent(id)}?force=true`, "DELETE");
        if (data?.success) return { success: true };
        return { success: false, error: String(data?.errors?.[0]?.message ?? "Unknown error").slice(0, 300) };
    } catch (e: any) {
        return { success: false, error: String(e?.message ?? e).slice(0, 300) };
    }
}

/**
 * Deploys the export as index.html to a fresh random preview branch (`s-<16 hex>`) of the user's Pages
 * project and returns that deployment's own hash URL. Never deploys to the production branch, so the
 * project's stable aliases never serve a share.
 */
export async function shareToPages(_: IpcMainInvokeEvent, html: string, cfApiToken: string, cfAccountId: string, cfPagesProject: string): Promise<{ success: boolean; url?: string; error?: string; deploymentId?: string; }> {
    const cf = cfConfig(cfApiToken, cfAccountId, cfPagesProject);
    if (!cf) return { success: false, error: "Cloudflare settings are missing or invalid. Set the API token, account ID and Pages project in ExportChat settings." };
    if (typeof html !== "string" || !html) return { success: false, error: "Nothing to share" };
    if (Buffer.byteLength(html, "utf-8") > MAX_SHARE_BYTES) return { success: false, error: "File is over Cloudflare Pages' 25 MB limit" };

    const npx = findNpx();
    if (!npx) return { success: false, error: NO_NODE };

    const { token, accountId, project } = cf;
    const branch = `s-${randomBytes(8).toString("hex")}`;

    let tmpDir = "";
    try {
        tmpDir = mkdtempSync(join(tmpdir(), "vc-exportchat-share-"));
        // Deployed as index.html so the URL is just https://{hash}.{project}.pages.dev/
        writeFileSync(join(tmpDir, "index.html"), html, "utf-8");

        // No shell; the folder is passed as "." via cwd, so every argument is from a fixed character set.
        const args = [...npx.args, "--yes", `wrangler@${WRANGLER_VERSION}`, "pages", "deploy", ".", `--project-name=${project}`, `--branch=${branch}`];
        const env = {
            ...process.env,
            CLOUDFLARE_API_TOKEN: token,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            WRANGLER_SEND_METRICS: "false",
            FORCE_COLOR: "0",
            npm_config_yes: "true",
        };

        const output = await new Promise<string>((res, rej) => {
            execFile(npx.file, args, { cwd: tmpDir, env, encoding: "utf-8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err: any, stdout, stderr) => {
                if (err) rej(err.code === "ENOENT" ? new Error(NO_NODE) : new Error(String(stderr || err.message)));
                else res(`${stdout}\n${stderr}`);
            });
        });

        // The deployment's own URL (https://abcd1234.<project>.pages.dev). The branch alias
        // (https://s-....<project>.pages.dev) doesn't match: it isn't 8 hex characters.
        const match = output.match(new RegExp(`https://([0-9a-f]{8})\\.${project}\\.pages\\.dev`));
        if (!match) return { success: false, error: "Could not find the deployment URL in wrangler's output" };

        const shortHash = match[1];
        const fullId = await lookupDeploymentId(token, accountId, project, shortHash);
        return { success: true, url: `https://${shortHash}.${project}.pages.dev`, deploymentId: fullId || shortHash };
    } catch (e: any) {
        return { success: false, error: String(e?.message ?? e).slice(0, 300) };
    } finally {
        if (tmpDir && dirname(tmpDir) === resolve(tmpdir())) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}
