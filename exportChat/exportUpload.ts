/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// History > Upload: reads the data back out of an export this plugin wrote (a normal export, an admin
// export, or the clean copy admin mode's Finish Editing downloads), so it can be uploaded again with a
// new password or admin tools through the same template code a normal export uses. Pure.

import { injectIntoTemplate } from "./template";
import { EXPORT_PATCH_MARK, httpUrl, safeAssetUrl, safeCssColor } from "./validation";

export interface ParsedExport {
    /** The viewer data (`window.__DCEF_DATA`): guild, channels, messages, invites. */
    data: unknown;
    title: string;
    /** Message ids (24-digit padded) the export highlights. */
    highlightedIds: string[];
}

export interface UploadOptions {
    /** Encrypts the upload like a password-protected export. Empty or missing means no password. */
    password?: string;
    /** Adds the admin tools (edit, add, import, Finish Editing) like an Admin Mode export. */
    adminMode: boolean;
}

const DOCTYPE_RE = /^\s*<!doctype html>/i;
/** Start of the viewer's app script (`<script type="module" crossorigin>`). */
const APP_SCRIPT_OPEN = '<script type="module"';
/** How far the app script tag's `>` may be from its start. */
const APP_SCRIPT_TAG_MAX = 256;
/** The data script both a normal export and a Finish Editing copy put right before the viewer's app script. */
const DATA_OPEN = "<script>window.__DCEF_DATA=";
const HIGHLIGHT_ASSIGN = "window.__DCEF_HIGHLIGHTED_IDS=";
const TITLE_PREFIX = "Export: ";

function isRecord(v: unknown): v is Record<string, any> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Index of the viewer's app script tag, or -1: the first `<script type="module"`, which must close
 * within a few hundred characters. A regex search for the tag is quadratic on a file full of
 * unclosed tags; this is one indexOf.
 */
function findAppScript(html: string): number {
    const at = html.indexOf(APP_SCRIPT_OPEN);
    if (at < 0) return -1;
    const tagEnd = html.indexOf(">", at + APP_SCRIPT_OPEN.length);
    return tagEnd >= 0 && tagEnd - at <= APP_SCRIPT_TAG_MAX ? at : -1;
}

/**
 * Keys that change an object's prototype or constructor. The viewer reads the upload's data as a JS
 * object literal, where a "__proto__" key sets the prototype (so `{"__proto__": [...]}` iterates like
 * an array). The generator never writes them.
 */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];
/**
 * Fields the generator always writes as real arrays (htmlGenerator.ts convertMessage, the export data,
 * reactions, embeds), and what it writes when there are none. The viewer iterates them with Svelte's
 * each(), which runs Array.from on anything that isn't an array, so an array-like object would work.
 */
const ARRAY_FIELDS = new Map<string, "list" | "null">([
    ["messages", "list"], ["channels", "list"], ["guilds", "list"], ["roles", "list"],
    ["images", "list"], ["fields", "list"], ["users", "list"], ["threads", "list"],
    ["stickers", "null"], ["reactions", "null"], ["emotes", "null"], ["mentions", "null"],
    ["attachments", "null"], ["embeds", "null"],
]);
/** Fields the generator writes as plain objects (or null / missing). */
const OBJECT_FIELDS = new Set(["guild", "invites", "author", "reference", "message", "thumbnail", "video", "footer", "icon", "avatar", "emoji", "image"]);
/** Asset fields the viewer uses as src / href (through its checkUrl). */
const ASSET_PATH_KEYS = new Set(["path", "localPath", "remotePath", "originalPath"]);
/** Fields the viewer puts into an href or src as they are (embed links, invite icons). */
const LINK_KEYS = new Set(["url", "guildIcon"]);
/** Fields the viewer puts into a style attribute. */
const COLOR_KEYS = new Set(["color"]);
const SIZE_KEYS = new Set(["width", "height"]);

/**
 * Makes export data read from a file as safe as what the generator writes, in place, and returns it.
 * The file may be hand-made, and the generator's own checks only ran when it was first exported.
 * The shape comes first, at every depth:
 * - `__proto__`, `constructor` and `prototype` keys are deleted;
 * - a field the generator writes as an array must be a real array, else it becomes what the
 *   generator writes for none (`[]` or `null`), so array-likes and inherited arrays never iterate;
 * - a field the generator writes as an object must be a plain object, else `null`.
 * Then the values:
 * - every sticker is a plain image (`format: "Png"`, `source` an object): the viewer hands Lottie
 *   stickers to lottie-web, whose expressions run eval as soon as the page loads;
 * - `url` (embed and embed-author links) and invite icons go through `httpUrl`;
 * - asset paths and ids (attachments, avatars, icons, thumbnails, images, videos, sticker and emoji
 *   images) go through `safeAssetUrl` (http(s), or a data: URI that isn't an HTML or SVG page), as in makeAsset;
 * - colours and sizes that end up in style attributes must be plain values.
 * On an export the generator wrote, every value already passes, so nothing changes. Iterative, so
 * deeply nested input can't overflow the stack.
 */
export function hardenExportData<T>(data: T): T {
    const stack: { node: unknown; sticker: boolean; }[] = [{ node: data, sticker: false }];
    while (stack.length) {
        const { node, sticker } = stack.pop()!;
        if (Array.isArray(node)) {
            for (const v of node) if (v !== null && typeof v === "object") stack.push({ node: v, sticker });
            continue;
        }
        if (!isRecord(node)) continue;
        for (const key of FORBIDDEN_KEYS) if (Object.prototype.hasOwnProperty.call(node, key)) delete node[key];
        if (sticker) {
            if (node.format !== "Png") node.format = "Png";
            if (node.source != null && !isRecord(node.source)) node.source = null;
        }
        // An asset: the generator sets its _id to the same safe URL as its path, or "0"
        if ("path" in node && node._id != null) node._id = safeAssetUrl(node._id) || "0";
        for (const key of Object.keys(node)) {
            const v = node[key];
            const listKind = ARRAY_FIELDS.get(key);
            if (listKind && v != null && !Array.isArray(v)) {
                node[key] = listKind === "list" ? [] : null;
            } else if (OBJECT_FIELDS.has(key) && v != null && !isRecord(v)) {
                node[key] = null;
            } else if (ASSET_PATH_KEYS.has(key)) {
                if (v != null) node[key] = safeAssetUrl(v);
            } else if (LINK_KEYS.has(key)) {
                if (v != null) node[key] = httpUrl(v);
            } else if (COLOR_KEYS.has(key)) {
                if (v != null) node[key] = safeCssColor(v);
            } else if (SIZE_KEYS.has(key)) {
                if (v != null && !(typeof v === "number" && Number.isFinite(v))) node[key] = 0;
            } else if (v !== null && typeof v === "object") {
                // A message's sticker list (also inside quoted messages): its items are stickers
                stack.push({ node: v, sticker: key === "stickers" });
            }
        }
    }
    return data;
}

/**
 * End (exclusive) of the JSON object or array that starts at `s[start]`, or -1. Only brackets outside
 * strings count, so message text like `}]` or `;window.x=` inside the data can't end it early.
 */
function jsonValueEnd(s: string, start: number): number {
    const first = s.charCodeAt(start);
    if (first !== 123 /* { */ && first !== 91 /* [ */) return -1;
    let depth = 0;
    let inString = false;
    for (let i = start; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (inString) {
            if (c === 92 /* \ */) i++;
            else if (c === 34 /* " */) inString = false;
        } else if (c === 34) {
            inString = true;
        } else if (c === 123 || c === 91) {
            depth++;
        } else if (c === 125 /* } */ || c === 93 /* ] */) {
            if (--depth === 0) return i + 1;
        }
    }
    return -1;
}

/** The JSON value at `s[start]`, followed by `;`. `next` is the index after the `;`. */
function readJsonStatement(s: string, start: number): { value: unknown; next: number; } | null {
    const end = jsonValueEnd(s, start);
    if (end < 0 || s[end] !== ";") return null;
    try {
        return { value: JSON.parse(s.slice(start, end)), next: end + 1 };
    } catch {
        return null;
    }
}

/** Undoes the escaping the plugin applies to the title (`escapeHtml`, and `__escHtml` in Finish Editing). */
function decodeTitle(s: string): string {
    const map: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
    return s.replace(/&(?:amp|lt|gt|quot|#39);/g, e => map[e]);
}

/** True for a password-protected export (its data is encrypted, so it can't be read back or re-wrapped). */
export function isEncryptedExport(html: string): boolean {
    return typeof html === "string"
        && DOCTYPE_RE.test(html.slice(0, 1024))
        && html.includes(EXPORT_PATCH_MARK)
        && html.includes('window.__DCEF_ENCRYPTED="');
}

/**
 * The export data of an ExportChat export: a normal or admin export, or a Finish Editing copy. Null for
 * anything else, including a password-protected export.
 *
 * Both writers put `<script>window.__DCEF_DATA={...};[window.__DCEF_HIGHLIGHTED_IDS=[...];]</script>`
 * directly before the viewer's `<script type="module">`, after the plugin's history/fetch patch
 * script, and escape `<` in the JSON, so the data script holds no `<` and ends at the first
 * `</script>`. Anything that doesn't have exactly that shape is refused.
 */
export function parseExportHtml(html: string): ParsedExport | null {
    if (typeof html !== "string" || !DOCTYPE_RE.test(html.slice(0, 1024)) || isEncryptedExport(html)) return null;

    const app = findAppScript(html);
    if (app < 0) return null;
    const head = html.slice(0, app);
    if (!head.includes(EXPORT_PATCH_MARK)) return null;

    const open = head.lastIndexOf(DATA_OPEN);
    if (open < 0) return null;
    const close = head.indexOf("</script>", open);
    if (close < 0 || head.slice(close + "</script>".length).trim() !== "") return null;
    const body = head.slice(open + DATA_OPEN.length, close);

    const dataStmt = readJsonStatement(body, 0);
    if (!dataStmt) return null;
    const { value: data } = dataStmt;
    let rest = body.slice(dataStmt.next);

    let highlightedIds: string[] = [];
    if (rest.startsWith(HIGHLIGHT_ASSIGN)) {
        const hl = readJsonStatement(rest, HIGHLIGHT_ASSIGN.length);
        if (!hl || !Array.isArray(hl.value)) return null;
        highlightedIds = hl.value.filter((id): id is string => typeof id === "string" && /^\d{1,32}$/.test(id));
        rest = rest.slice(hl.next);
    }
    if (rest.trim() !== "") return null;

    if (!isRecord(data) || !isRecord(data.guild) || !Array.isArray(data.messages)) return null;
    if (data.channels !== undefined && !Array.isArray(data.channels)) return null;

    // A normal export's title is "Export: <title>". The viewer renames its tab to "DCE-Frontend" once it
    // runs, so a Finish Editing copy usually carries that instead; fall back to the guild name, which is
    // what the export title was made from.
    const rawTitle = /<title>([^<]*)<\/title>/.exec(head)?.[1];
    const decoded = rawTitle != null ? decodeTitle(rawTitle) : "";
    const guildName = typeof data.guild.name === "string" ? data.guild.name : "";
    const title = decoded.startsWith(TITLE_PREFIX) ? decoded.slice(TITLE_PREFIX.length) : guildName || "Export";

    return { data: hardenExportData(data), title, highlightedIds };
}

export function exportMessageCount(parsed: ParsedExport): number {
    const messages = isRecord(parsed.data) ? parsed.data.messages : null;
    return Array.isArray(messages) ? messages.length : 0;
}

/** Channel and server names for the history entry. */
export function exportNames(parsed: ParsedExport): { channelNames: string[]; guildName?: string; } {
    const d = isRecord(parsed.data) ? parsed.data : {};
    const channelNames = (Array.isArray(d.channels) ? d.channels : [])
        .map((c: any) => c?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n !== "");
    const names = channelNames.length ? channelNames : [parsed.title];
    const guildName = isRecord(d.guild) && typeof d.guild.name === "string" ? d.guild.name : "";
    return { channelNames: names, guildName: guildName && names.join(", ") !== guildName ? guildName : undefined };
}

/** How the export stored its media, for the history entry. */
export function guessMediaMode(html: string): "base64" | "catbox" | "cdn" {
    if (html.includes('"path":"data:')) return "base64";
    if (html.includes('"path":"https://files.catbox.moe/')) return "catbox";
    return "cdn";
}

/**
 * The page to upload: the parsed export run through `injectIntoTemplate` with the bundled viewer
 * template, exactly like a normal export (same escaping, same encryption, same admin script). Whatever
 * the original file had beyond its data (an old admin script, its own highlight CSS) is not carried over.
 * The data is hardened again here (a no-op after parseExportHtml), so nothing unhardened reaches it.
 */
export function buildUploadHtml(template: string, parsed: ParsedExport, opts: UploadOptions): Promise<string> {
    const highlighted = parsed.highlightedIds.length ? new Set(parsed.highlightedIds) : undefined;
    return injectIntoTemplate(template, hardenExportData(parsed.data), parsed.title, highlighted, opts.password || undefined, opts.adminMode);
}
