/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: pnpm exec tsx src/userplugins/exportChat/_dev/check-native.ts
// Offline checks for native.ts's Upload file picker and the delete allow-list. native.ts is bundled with
// esbuild into a temp folder, with stand-ins for electron (the file dialog), Vencord's main-process
// settings and child_process (so wrangler / npx can never run); fetch throws. Only temp files are touched.
// An optional argument bundles another native.ts instead (used to show the checks failing before a fix).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { build, type Plugin } from "esbuild";

let passed = 0;
function ok(cond: unknown, msg: string) {
    assert.ok(cond, msg);
    passed++;
    console.log("  ok -", msg);
}

const pluginDir = join(__dirname, "..");
const nativeEntry = process.argv[2] ? resolve(process.argv[2]) : join(pluginDir, "native.ts");

const STUBS: Record<string, string> = {
    "electron": `
export const shell = { showItemInFolder() {} };
export const dialog = {
    showOpenDialog: async (...args) => {
        const g = globalThis;
        (g.__dialogCalls ??= []).push(args);
        if (g.__dialogThrow) throw new Error(g.__dialogThrow);
        return g.__dialogResult ?? { canceled: true, filePaths: [] };
    },
};
export const BrowserWindow = { fromWebContents: wc => (wc ? { __win: true } : null) };`,
    "@main/settings": `
export const RendererSettings = { get store() { return { plugins: { ExportChat: { saveLocation: globalThis.__saveLocation ?? "" } } }; } };`,
    "child_process": `
export function execFile() { throw new Error("child_process is disabled in this check"); }`,
};

const stubs: Plugin = {
    name: "exportchat-check-stubs",
    setup(b) {
        b.onResolve({ filter: /^(electron|@main\/settings|child_process)$/ }, a => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: STUBS[a.path], loader: "js" }));
        b.onResolve({ filter: /^file:\/\// }, () => ({ path: "template", namespace: "stub-template" }));
        b.onLoad({ filter: /.*/, namespace: "stub-template" }, () => ({ contents: 'export default "<!doctype html>";', loader: "js" }));
        b.onResolve({ filter: /^\.\/validation$/ }, () => ({ path: join(pluginDir, "validation.ts") }));
    },
};

const g = globalThis as any;
const bs = String.fromCharCode(92);
const PATCH = "<script>(function(){var op=history.pushState,or=history.replaceState;history.pushState=function(s,t,u){try{op.call(this,s,t,u)}catch(e){try{op.call(this,s,t)}catch(e2){}}};})();</script>";
const finishCopy = `<!doctype html>\n<html><head><title>DCE-Frontend</title>${PATCH}<script>window.__DCEF_DATA={"guild":{},"messages":[]};</script><script type="module"></script></head><body></body></html>`;

async function main() {
    const work = mkdtempSync(join(tmpdir(), "vc-exportchat-check-"));
    try {
        g.fetch = async (url: unknown) => { throw new Error("network is disabled in this check: " + String(url)); };
        const outfile = join(work, "native.cjs");
        await build({ entryPoints: [nativeEntry], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", plugins: [stubs], logLevel: "warning" });
        const N = createRequire(__filename)(outfile);
        const E = { sender: {} };

        const saveDir = join(work, "exports");
        const dl = join(work, "Downloads");
        mkdirSync(saveDir);
        mkdirSync(dl);
        g.__saveLocation = saveDir;
        const write = (name: string, content: string) => { const p = join(dl, name); writeFileSync(p, content); return p; };
        const pick = (p: string) => { g.__dialogResult = { canceled: false, filePaths: [p] }; return N.pickHtmlFile(E); };
        /** Picks a file and confirms it like the dialog does after parseExportHtml accepts it. */
        const pickConfirmed = async (p: string) => {
            const r = await pick(p);
            assert.ok(r?.token, "pick returned a token");
            assert.ok(N.confirmPick(null, r.token), "confirmPick accepted the token");
            return r;
        };

        console.log("pickHtmlFile:");
        g.__dialogResult = { canceled: true, filePaths: [] };
        ok(await N.pickHtmlFile(E) === null, "cancel returns null");
        const call = g.__dialogCalls.at(-1);
        ok(call.length === 2 && call[0].__win === true && call[1].properties.includes("openFile") && call[1].filters[0].extensions.join() === "html", "opens on the calling window, one .html file");
        g.__dialogResult = { canceled: false, filePaths: [] };
        ok(await N.pickHtmlFile(E) === null, "no path returns null");
        g.__dialogThrow = "boom";
        ok(/file picker/.test((await N.pickHtmlFile(E))?.error), "a picker failure is an error, not a throw");
        delete g.__dialogThrow;

        // Browsers add " (1)" to a repeated download and Finish Editing names can have "_", so picked
        // files don't have to match the save folder's name pattern.
        const a = write("Gui_-ame-1761500000 (1).html", finishCopy);
        const resA = await pick(a);
        ok(resA && resA.path === resolve(a) && resA.name === basename(a) && resA.content === finishCopy && /^[0-9a-f]{32}$/.test(resA.token), "returns path, name, content and a confirm token");
        const unc = [bs + bs + "evil.example" + bs + "share" + bs + "x.html", "//evil.example/share/x.html", bs + bs + "?" + bs + a];
        for (const p of unc) ok(/Network folders/.test((await pick(p)).error), `network / device path refused before touching it: ${p}`);
        ok(/Invalid file path/.test((await pick("relative" + bs + "x.html")).error), "relative path refused");
        ok(/html file/.test((await pick(write("notes.txt", finishCopy))).error), "non-.html file refused");
        mkdirSync(join(dl, "folder.html"));
        ok(/plain file/.test((await pick(join(dl, "folder.html"))).error), "folder refused");
        const big = write("big.html", finishCopy);
        truncateSync(big, 25 * 1024 * 1024 + 1);
        ok(/25 MB/.test((await pick(big)).error), "over 25 MB refused");
        ok(N.deleteLocalFile(null, big).success === false && existsSync(big), "a refused pick isn't deletable");
        const notExport = write("page.html", "<!doctype html><title>Other</title>");
        const resN = await pick(notExport);
        ok(resN && !("content" in resN) && resN.error === "That file isn't an ExportChat export.", "a non-export is refused and its content never sent");
        let linked: string | null = join(dl, "link.html");
        try { symlinkSync(a, linked, "file"); } catch { linked = null; }
        if (linked) ok(/plain file/.test((await pick(linked)).error), "symlink refused");
        else console.log("  skip - symlink (no privilege to create one here)");

        console.log("confirm before delete:");
        const b = write("Gui-ame-1761500001.html", finishCopy);
        const resB = await pick(b);
        ok(N.deleteLocalFile(null, b).success === false && existsSync(b), "a pick the renderer hasn't confirmed isn't deletable (a rejected pick stays that way)");
        ok(N.confirmPick(null, "0".repeat(32)) === false && N.confirmPick(null, "nope") === false && N.confirmPick(null, 42) === false, "unknown or malformed tokens are refused");
        ok(N.confirmPick(null, resB.token) === true && N.confirmPick(null, resB.token) === false, "a token confirms once");
        const rejected = await pick(write("Gui-ame-1761500002.html", finishCopy));
        N.rejectPick(null, rejected.token);
        ok(N.confirmPick(null, rejected.token) === false && N.deleteLocalFile(null, rejected.path).success === false && existsSync(rejected.path), "a pick the renderer rejected loses its token and stays undeletable");
        N.rejectPick(null, 42);
        ok(true, "rejectPick ignores a malformed token");
        ok(N.deleteLocalFile(null, b).success === true && !existsSync(b), "the confirmed pick is deleted");
        const firsts: string[] = [];
        for (let i = 0; i < 9; i++) firsts.push((await pick(a)).token);
        ok(N.confirmPick(null, firsts[0]) === false && N.confirmPick(null, firsts[8]) === true, "only the latest few unconfirmed picks are kept");

        console.log("delete allow-list:");
        const c = write("abc-def-1700000000.html", finishCopy); // an export next to a picked one, never picked
        ok(N.deleteLocalFile(null, c).success === false && existsSync(c), "an unpicked export next to a picked one is refused (exact file only)");
        ok(N.deleteLocalFile(null, notExport).success === false && existsSync(notExport), "a refused non-export is never deletable");
        // A name that only matches the picked one after case folding: KELVIN SIGN lowercases to "k"
        const kelvin = write("x" + String.fromCharCode(0x212a) + ".html", finishCopy);
        const plainK = write("xk.html", finishCopy);
        if (existsSync(kelvin) && existsSync(plainK)) {
            await pickConfirmed(kelvin);
            ok(N.deleteLocalFile(null, plainK).success === false && existsSync(plainK) && existsSync(kelvin), "a different file whose name folds to the picked one is refused, and nothing is deleted");
            ok(N.deleteLocalFile(null, kelvin.toUpperCase()).success === false && existsSync(kelvin), "the picked path in other letter case is refused (exact match only)");
            ok(N.deleteLocalFile(null, kelvin).success === true && !existsSync(kelvin) && existsSync(plainK), "the exact picked path deletes only the picked file");
        } else console.log("  skip - this file system folds the KELVIN SIGN name onto xk.html");
        writeFileSync(a, finishCopy);
        await pickConfirmed(a);
        const swapped = write("swap.html", finishCopy);
        await pickConfirmed(swapped);
        writeFileSync(swapped, "not an export any more");
        ok(N.deleteLocalFile(null, swapped).success === false && existsSync(swapped), "a confirmed pick whose content changed to a non-export is kept (sniff)");
        // Built by hand: path.join would remove the ".." itself
        const viaDots = [dl, "sub", "..", basename(a)].join(sep);
        assert.ok(viaDots.includes(sep + ".." + sep), "fixture path keeps its ..");
        ok(N.deleteLocalFile(null, viaDots).success === true && !existsSync(a), "a confirmed pick is deleted through an equivalent path (resolved to the stored one)");
        writeFileSync(a, finishCopy);
        ok(N.deleteLocalFile(null, a).success === false && existsSync(a), "after a delete the path leaves the allow-list");
        ok(N.deleteLocalFile(null, unc[0]).success === false, "UNC delete still refused");
        ok(/different folder/.test(N.deleteLocalFile(null, c).error), "unpicked files outside the save folder keep the old message");

        console.log("save folder unchanged:");
        const s = N.saveExport(null, "abc-def-1700000001.html", "<!doctype html>\n<title>Export: x</title>", "increment");
        ok(s.success && s.path.startsWith(saveDir + sep), "export saved into the save folder");
        ok(N.deleteLocalFile(null, s.path).success === true && !existsSync(s.path), "save-folder export still deletable");

        console.log(`\n${passed} checks passed`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
