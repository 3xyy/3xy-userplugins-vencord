/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: pnpm exec tsx src/userplugins/exportChat/_dev/check-upload.ts
// Offline: builds exports from a tiny made-up chat with the plugin's own template code, never
// touches the network, Cloudflare or wrangler.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { buildUploadHtml, exportMessageCount, exportNames, guessMediaMode, hardenExportData, isEncryptedExport, parseExportHtml } from "../exportUpload";
import { injectIntoTemplate, padId, PBKDF2_ITERATIONS } from "../template";
import { EXPORT_PATCH_MARK, EXPORT_SNIFF_BYTES, looksLikeExportHead } from "../validation";

let passed = 0;
function ok(cond: unknown, msg: string) {
    assert.ok(cond, msg);
    passed++;
    console.log("  ok -", msg);
}

// The same text native.ts bundles (the build's file:// loader trims the end).
const template = readFileSync(join(__dirname, "..", "dcef-template.html"), "utf-8").trimEnd();

const SECRET = "PLAINTEXT-MARKER-7f3a";
const SECOND = "second-line-text-91c2";
const TITLE = "Test & <Server> \"q\" 'a' $& $'";
const GUILD = padId("100000000000000001");
const CHANNEL = padId("200000000000000002");
const ID1 = "1100000000000000001";
const ID2 = "1100000000000000002";

const asset = (url: string) => ({ _id: url || "0", originalPath: url, localPath: url, remotePath: url, path: url, extension: "", type: "unknown", width: 0, height: 0, sizeBytes: 0, filenameWithHash: "", filenameWithoutHash: "", colorDominant: null, colorPalette: null });
const author = { _id: padId("300000000000000003"), name: "someone", nickname: "Someone", color: "", isBot: false, avatar: asset(""), roles: [] };
function msg(id: string, text: string) {
    const ts = "2026-10-01T00:00:00.000Z";
    return {
        _id: padId(id), type: "Default", timestamp: ts, timestampEdited: null, callEndedTimestamp: null, isPinned: false,
        content: [{ timestamp: ts, content: text }], author, attachments: null, embeds: null, stickers: [], reactions: [],
        mentions: [], roles: [], channels: [], reference: null, guildId: GUILD, channelId: CHANNEL, channelName: "general",
    };
}
function makeData(extra: any[] = []) {
    return {
        guild: { _id: GUILD, name: "Guild Name", icon: asset(""), msg_count: 2 + extra.length },
        channels: [{ _id: CHANNEL, name: "general", type: "GuildTextChat", guildId: GUILD, categoryId: GUILD, category: "General", topic: null, msg_count: 2 + extra.length }],
        // Text that would break a naive parser: a closing script tag, a comment opener, `$&`
        // replacement patterns, a fake highlight assignment and a U+2028 line separator.
        messages: [
            msg(ID1, `hello ${SECRET} </script><!-- $& $' ;window.__DCEF_HIGHLIGHTED_IDS=["1"]; }]`),
            msg(ID2, `${SECOND} \u2028 "quoted" \\ backslash`),
            ...extra,
        ],
        invites: {},
    };
}

/** Every field shape the generator writes (htmlGenerator.ts convertMessage, resolveInvites, guild icons). */
function makeRealData(): any {
    const d: any = makeData();
    const img = (url: string, w: number | null = 0, h: number | null = 0) => ({ ...asset(url), type: "image", width: w, height: h });
    const role = { _id: padId("700000000000000007"), name: "Mod", color: "#00ff00", position: 2 };
    d.guild.icon = img("https://cdn.discordapp.com/icons/1/abc.webp?size=128", 128, 128);
    d.guilds = [d.guild, { _id: padId("9"), name: "DM", icon: asset(""), msg_count: 1 }];
    const m = d.messages[0];
    m.author = { ...author, color: "#ff0000", avatar: img("https://cdn.discordapp.com/avatars/3/a_b.webp?size=80", 80, 80), roles: [role, { ...role, color: null }] };
    m.attachments = [
        img("https://media.discordapp.net/attachments/1/2/pic.png", 640, 480),
        { ...asset("data:image/png;base64,iVBORw0KGgo="), type: "image", width: null, height: null },
        { ...asset("https://cdn.discordapp.com/attachments/1/2/notes.txt"), textContent: "plain text javascript: not a link" },
        // Base64-mode code and XML attachments (N18: these keep their links)
        { ...asset("data:text/javascript;base64,Y29uc29sZS5sb2coMSk="), filenameWithHash: "script.js", filenameWithoutHash: "script.js" },
        { ...asset("data:application/xml;base64,PHg+PC94Pg=="), filenameWithHash: "data.xml", filenameWithoutHash: "data.xml" },
    ];
    m.embeds = [
        {
            title: "Link", url: "https://example.com/page", timestamp: null, description: "desc",
            thumbnail: img("https://images-ext-1.discordapp.net/external/x/thumb.png", 80, 80), images: [img("https://media.discordapp.net/external/y.png", 400, 300)],
            video: { ...asset("https://media.discordapp.net/v.mp4"), type: "video", width: 1280, height: 720 },
            fields: [{ name: "f", value: "v", isInline: false }], color: "#5865f2",
            author: { name: "Site", url: "http://example.com/author", icon: img("https://images-ext-2.discordapp.net/a.png") },
            footer: { text: "foot", icon: img("https://images-ext-2.discordapp.net/f.png") },
        },
        { title: "Forwarded from x", url: "", timestamp: null, description: "fwd", thumbnail: null, images: [], video: null, fields: [], color: "#5865f2", author: { name: "x", url: "" } },
    ];
    m.stickers = [{ name: "wave", format: "Png", _id: padId("8"), source: img("https://media.discordapp.net/stickers/8.webp?size=160", 160, 160) }];
    m.reactions = [{ emoji: { _id: padId("9"), name: "👍", isAnimated: false, image: img("https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44d.png", 48, 48), source: "default", guildId: null }, count: 2, users: [{ _id: padId("3"), name: "me", nickname: "Me", isBot: false, avatar: img("https://cdn.discordapp.com/embed/avatars/1.png") }] }];
    m.emotes = [{ _id: padId("10"), name: "pog", isAnimated: true, image: img("https://cdn.discordapp.com/emojis/10.gif?size=48", 48, 48), source: "custom", guildId: null }];
    m.mentions = [{ _id: padId("3"), name: "someone", discriminator: "0", nickname: "Someone", isBot: false }];
    d.messages[1].reference = { messageId: padId(ID1), channelId: CHANNEL, guildId: GUILD, message: JSON.parse(JSON.stringify(m)) };
    d.invites = { abc: { guildName: "Server", guildIcon: "https://cdn.discordapp.com/icons/5/x.webp?size=64", online: 3, members: 10 }, def: { guildName: "No icon", guildIcon: "", online: "N/A", members: "N/A" } };
    return d;
}

/** The fixed parts of an export, so two builds of the same input compare equal. */
const normalise = (html: string) => html.replace(/window\.__DCEF_EXPORT_ID="[0-9a-f]{16}"/, 'window.__DCEF_EXPORT_ID="x"');

/** Runs the admin script's real Finish Editing code on an admin export and returns the clean copy it downloads. */
function finishEditing(adminHtml: string, docTitle: string, edit: (data: any) => void): string {
    const { ctx, downloads } = runAdminScript(adminHtml, docTitle);
    edit(ctx.__DCEF_DATA);
    vm.runInContext("adminFinish()", ctx);
    assert.ok(downloads.html && downloads.name.endsWith(".html"), "Finish Editing produced a download");
    return downloads.html;
}

/** An admin export's clean-template and admin scripts, run in a vm with a stubbed page. */
function runAdminScript(adminHtml: string, docTitle: string): { ctx: any; downloads: { html: string; name: string; }; } {
    const cleanStart = adminHtml.indexOf("<script>window.__DCEF_CLEAN_TEMPLATE=");
    const adminStart = adminHtml.indexOf("<script>\nvar __adminState");
    assert.ok(cleanStart > 0 && adminStart > 0, "admin export carries the clean template and the admin script");
    const scriptBody = (start: number) => adminHtml.slice(adminHtml.indexOf(">", start) + 1, adminHtml.indexOf("</script>", start));

    const downloads = { html: "", name: "" };
    const store = new Map<string, string>();
    const ctx: any = {
        atob: (s: string) => Buffer.from(s, "base64").toString("latin1"),
        confirm: () => true,
        alert: (m: string) => { throw new Error("alert: " + m); },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
        document: {
            title: docTitle,
            getElementById: () => null,
            createElement: () => {
                const a: any = { click() { downloads.name = a.download; } };
                return a;
            },
        },
        Blob: class { constructor(parts: string[]) { downloads.html = parts.join(""); } },
        URL: { createObjectURL: () => "blob:x", revokeObjectURL() { } },
        location: { hash: "", reload() { } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(scriptBody(cleanStart), ctx);
    ctx.__DCEF_EXPORT_ID = "0123456789abcdef";
    ctx.__DCEF_DATA = JSON.parse(JSON.stringify(makeData()));
    vm.runInContext(scriptBody(adminStart), ctx);
    return { ctx, downloads };
}

/** Svelte 5's each(): a real array as is, null as [], anything else through Array.from (array-likes too). */
const each = (v: any): any[] => Array.isArray(v) ? v : v == null ? [] : Array.from(v);

/**
 * The upload's data as the viewer gets it: the data script run as JavaScript (an object literal, where a
 * "__proto__" key sets the prototype), or the decrypted JSON for a password upload.
 */
async function viewerData(html: string, password?: string): Promise<any> {
    if (password) return (await decrypt(html, password)).data;
    const open = html.indexOf("<script>window.__DCEF_DATA=");
    const ctx: any = { window: {} };
    vm.runInNewContext(html.slice(open + "<script>".length, html.indexOf("</script>", open)), ctx);
    return ctx.window.__DCEF_DATA;
}

/** Lottie stickers and payload strings the viewer would reach, walking messages and quoted messages with each(). */
function viewerHits(d: any): string[] {
    const hits: string[] = [];
    const visit = (m: any, depth: number) => {
        if (!m || depth > 3) return;
        for (const s of each(m.stickers)) if (s?.format === "Lottie") hits.push("Lottie sticker");
        for (const e of each(m.embeds)) for (const u of [e?.url, e?.author?.url]) if (/evil/.test(String(u ?? ""))) hits.push("embed link " + u);
        for (const a of each(m.attachments)) if (/evil/.test(String(a?.path ?? ""))) hits.push("attachment " + a.path);
        visit(m.reference?.message, depth + 1);
    };
    for (const m of each(d.messages)) visit(m, 0);
    return hits;
}

async function decrypt(html: string, password: string): Promise<any> {
    const get = (name: string) => new RegExp(`window\\.${name}="([^"]*)"`).exec(html)?.[1] ?? "";
    const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: hex(get("__DCEF_SALT")), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hex(get("__DCEF_IV")) }, key, Buffer.from(get("__DCEF_ENCRYPTED"), "base64"));
    return JSON.parse(new TextDecoder().decode(plain));
}

async function main() {
    const data = makeData();
    const normal = await injectIntoTemplate(template, data, TITLE, new Set([ID1]));
    const withPassword = await injectIntoTemplate(template, data, TITLE, new Set([ID1]), "hunter2");
    const admin = await injectIntoTemplate(template, data, TITLE, undefined, undefined, true);

    console.log("not an export:");
    ok(parseExportHtml("<html>hi</html>") === null, 'parseExportHtml("<html>hi</html>") is null');
    ok(parseExportHtml("") === null, "empty string is null");
    ok(parseExportHtml(undefined as any) === null && parseExportHtml(42 as any) === null, "non-string input is null");
    ok(parseExportHtml(template) === null, "the bare viewer template (no data) is null");
    ok(parseExportHtml('<!doctype html><html><head><script>window.__DCEF_DATA={"guild":{},"messages":[]};</script><script type="module"></script></head></html>') === null,
        "a page that only sets window.__DCEF_DATA, without the plugin's patch script, is null");
    ok(parseExportHtml(normal.slice(0, normal.indexOf(SECOND))) === null, "a truncated export is null");
    ok(parseExportHtml(normal.replace("<script>window.__DCEF_DATA=", "<script>window.__DCEF_DATA=1;window.__x=")) === null, "a data script that isn't one object is null");
    ok(parseExportHtml(normal.replace('"messages":[', '"messagez":[')) === null, "data without a messages list is null");
    ok(parseExportHtml(normal.replace(/(<script>window\.__DCEF_DATA=[^<]*<\/script>)/, "$1<script>alert(1)</script>")) === null, "anything between the data and the viewer script is refused");
    ok(!looksLikeExportHead("<html>hi</html>") && !looksLikeExportHead("<!doctype html><title>Something</title>"), "the delete sniff rejects other pages");

    console.log("normal export:");
    const parsed = parseExportHtml(normal);
    ok(parsed !== null, "a generated export parses");
    ok(parsed!.title === TITLE, "title round-trips (HTML escaping undone)");
    ok(exportMessageCount(parsed!) === 2, "message count round-trips");
    assert.deepEqual(parsed!.data, data);
    ok(true, "embedded data round-trips exactly (script-closing text, $ patterns, U+2028)");
    assert.deepEqual(parsed!.highlightedIds, [padId(ID1)]);
    ok(true, "highlighted ids round-trip");
    ok(guessMediaMode(normal) === "cdn", "media mode of a CDN export");
    const withAvatar = (url: string) => { const d = makeData(); d.messages[0].author = { ...author, avatar: asset(url) }; return d; };
    ok(guessMediaMode(await injectIntoTemplate(template, withAvatar("data:image/png;base64,AAAA"), TITLE)) === "base64", "media mode of a Base64 export");
    ok(guessMediaMode(await injectIntoTemplate(template, withAvatar("https://files.catbox.moe/abc.png"), TITLE)) === "catbox", "media mode of a catbox export");
    assert.deepEqual(exportNames(parsed!), { channelNames: ["general"], guildName: "Guild Name" });
    ok(true, "history names come from the export's channels and guild");
    // Older plugin versions wrote the data with plain JSON.stringify, so `<` (mentions, emoji) is raw
    const oldData = makeData();
    oldData.messages[0].content[0].content = "hi <@300000000000000003> <3 <:e:1>";
    const escapedLt = String.fromCharCode(92) + "u003c";
    const oldStyle = (await injectIntoTemplate(template, oldData, TITLE)).replace(/<script>window\.__DCEF_DATA=[^<]*<\/script>/, m => m.split(escapedLt).join("<"));
    ok(oldStyle.includes("hi <@300000000000000003> <3"), "fixture: raw < in the data, like older versions wrote");
    assert.deepEqual(parseExportHtml(oldStyle)?.data, oldData);
    ok(true, "an export from an older version still parses");
    ok(looksLikeExportHead(normal.slice(0, EXPORT_SNIFF_BYTES)), "the delete sniff accepts a normal export");

    console.log("password-protected export:");
    ok(parseExportHtml(withPassword) === null, "a password-protected export is null (it can't be re-wrapped without its password)");
    ok(isEncryptedExport(withPassword) && !isEncryptedExport(normal) && !isEncryptedExport("<html>hi</html>"), "isEncryptedExport tells it apart for the message");

    console.log("admin export (admin_...html):");
    const parsedAdmin = parseExportHtml(admin);
    ok(parsedAdmin !== null && parsedAdmin.title === TITLE && exportMessageCount(parsedAdmin) === 2, "parses with title and count");

    console.log("Finish Editing copy (the file you upload):");
    const finished = finishEditing(admin, "DCE-Frontend", d => {
        d.messages[0]._deleted = true;
        d.messages[1]._highlighted = true;
        d.messages[1].content[0].content += " edited";
    });
    ok(!finished.includes("window.__DCEF_ADMIN_MODE=true") && !finished.includes("window.__DCEF_EXPORT_ID="), "fixture is a real clean copy (no admin script, no export id)");
    const parsedFinished = parseExportHtml(finished);
    ok(parsedFinished !== null, "the Finish Editing copy parses");
    ok(exportMessageCount(parsedFinished!) === 2, "its message count round-trips");
    ok(parsedFinished!.title === "Guild Name", "its title falls back to the guild name (the viewer renames the tab to DCE-Frontend)");
    const fm = (parsedFinished!.data as any).messages;
    ok(fm[0]._deleted === true && fm[1]._highlighted === true && fm[1].content[0].content.endsWith(" edited"), "the edits are kept");
    assert.deepEqual(parsedFinished!.highlightedIds, [padId(ID2)]);
    ok(true, "its highlighted ids come from the edited data");
    ok(looksLikeExportHead(finished.slice(0, EXPORT_SNIFF_BYTES)), "the delete sniff accepts a Finish Editing copy");
    const titled = parseExportHtml(finishEditing(admin, "Export: Kept Title", () => { }));
    ok(titled?.title === "Kept Title", "a Finish Editing copy that kept the export title uses it");
    // Many highlighted messages push the patch script far down the file
    const many = Array.from({ length: 1500 }, (_, i) => msg(String(1200000000000000000n + BigInt(i)), "m"));
    const finishedMany = finishEditing(admin, "DCE-Frontend", d => {
        d.messages.push(...JSON.parse(JSON.stringify(many)));
        for (const m of d.messages) m._highlighted = true;
    });
    ok(finishedMany.indexOf("history.pushState") > 16 * 1024, "fixture: the patch script starts past 16 KB");
    ok(looksLikeExportHead(finishedMany.slice(0, EXPORT_SNIFF_BYTES)), "the delete sniff still accepts it");
    ok(exportMessageCount(parseExportHtml(finishedMany)!) === 1502, "and it parses");

    console.log("rebuildForUpload (buildUploadHtml with the bundled template):");
    const rebuiltPw = await buildUploadHtml(template, parsedFinished!, { password: "pw", adminMode: false });
    ok(!rebuiltPw.includes(SECRET) && !rebuiltPw.includes(SECOND), "with a password the output doesn't contain the plaintext message text");
    ok(!/<script>window\.__DCEF_DATA=/.test(rebuiltPw), "and has no plaintext data script");
    ok(rebuiltPw.includes('<script type="text/plain" id="vc-dcef-app">') && rebuiltPw.includes("id=\"pw-overlay\""), "and is wrapped like a normal password export (inert app + unlock overlay)");
    ok(parseExportHtml(rebuiltPw) === null && isEncryptedExport(rebuiltPw), "the encrypted upload can't be parsed back");
    const opened = await decrypt(rebuiltPw, "pw");
    assert.deepEqual(opened.data, parsedFinished!.data);
    assert.deepEqual(opened.highlightedIds, [padId(ID2)]);
    ok(true, "the right password decrypts it to the same data and highlights (same PBKDF2 + AES-GCM as a normal export)");
    await assert.rejects(decrypt(rebuiltPw, "wrong"));
    ok(true, "a wrong password doesn't");

    const rebuiltPlain = await buildUploadHtml(template, parsed!, { adminMode: false });
    ok(normalise(rebuiltPlain) === normalise(await injectIntoTemplate(template, parsed!.data, parsed!.title, new Set(parsed!.highlightedIds))),
        "without options the upload is byte-for-byte what a normal export of the same data is");
    assert.deepEqual(parseExportHtml(rebuiltPlain), parsed);
    ok(true, "and parses back to the same export");
    ok(normalise(await buildUploadHtml(template, parsed!, { password: "", adminMode: false })) === normalise(rebuiltPlain), "an empty password means no password");

    const fromAdminOff = await buildUploadHtml(template, parsedAdmin!, { adminMode: false });
    ok(!fromAdminOff.includes("window.__DCEF_ADMIN_MODE=true") && !fromAdminOff.includes("admin-toolbar") && !fromAdminOff.includes("__DCEF_CLEAN_TEMPLATE"), "admin tools off: an admin export uploads without its admin tools");
    const adminOn = await buildUploadHtml(template, parsedFinished!, { adminMode: true });
    ok(adminOn.includes("<script>window.__DCEF_ADMIN_MODE=true;</script>") && adminOn.includes('id="admin-toolbar"') && adminOn.includes("window.__DCEF_CLEAN_TEMPLATE="), "admin tools on: the admin script is added back");
    ok(normalise(adminOn).replace(/-\d{10}\.html/g, "-T.html") === normalise(await injectIntoTemplate(template, parsedFinished!.data, parsedFinished!.title, new Set(parsedFinished!.highlightedIds), undefined, true)).replace(/-\d{10}\.html/g, "-T.html"),
        "and it is the same admin export a normal export with Admin Mode makes");
    const adminPw = await buildUploadHtml(template, parsedFinished!, { password: "pw", adminMode: true });
    ok(adminPw.includes("window.__DCEF_ADMIN_MODE=true") && !adminPw.includes(SECRET), "password and admin tools together");

    console.log("crafted export (hardening):");
    // A file with the plugin's markers but hand-written data: a Lottie sticker (the viewer would hand it to
    // lottie.loadAnimation, whose expressions run eval) and script / CSS URLs in every href, src and style.
    const evil: any = makeData();
    const ref: any = msg(ID1, "quoted");
    ref.stickers = [{ name: "s2", format: "Lottie", _id: padId("6"), source: asset("https://attacker.example/anim2.json") }];
    ref.embeds = [{ title: "r", url: "javascript:evil9()", author: { name: "r", url: "javascript:evil10()" } }];
    evil.messages[0].stickers = [{ name: "s", format: "Lottie", _id: padId("5"), source: asset("https://attacker.example/anim.json") }];
    evil.messages[0].embeds = [{
        title: "t", url: "javascript:evil1(document.domain)", description: "", fields: [],
        author: { name: "a", url: "javascript:evil2()", icon: asset("javascript:evil3()") },
        thumbnail: asset("vbscript:evil4"), images: [asset("javascript:evil5()")], video: asset("javascript:evil6()"),
        footer: { text: "f", icon: asset(" javascript:evil7()") },
        color: "red;background:url(https://attacker.example/css-embed)",
    }];
    evil.messages[0].attachments = [{ ...asset("javascript:evil8()"), width: "1px;background:url(https://attacker.example/css-width)" }];
    evil.messages[0].author = { ...author, color: "red;background:url(https://attacker.example/css-author)", avatar: asset("javascript:evil11()"), roles: [{ _id: padId("7"), name: "r", color: "red;background:url(https://attacker.example/css-role)", position: 1 }] };
    evil.messages[1].reference = { messageId: padId(ID1), channelId: CHANNEL, guildId: GUILD, message: ref };
    evil.invites = { abc: { guildName: "x", guildIcon: "javascript:evil12()", online: 1, members: 2 } };
    const evilHtml = await injectIntoTemplate(template, evil, "hi");
    ok(evilHtml.includes('"format":"Lottie"') && evilHtml.includes("javascript:evil1(document.domain)") && /evil\d/.test(evilHtml), "fixture: the crafted file carries Lottie stickers and javascript: links");
    const parsedEvil = parseExportHtml(evilHtml);
    ok(parsedEvil !== null, "it has the plugin's markers, so it parses");
    const evilOut = await buildUploadHtml(template, parsedEvil!, { adminMode: false });
    ok(!evilOut.includes('"format":"Lottie"'), "the upload has no Lottie sticker");
    ok(!/evil\d/.test(evilOut), "the upload has none of the javascript: / vbscript: URLs");
    ok(!evilOut.includes("attacker.example/css-"), "the upload has none of the CSS url() injections (colours, sizes)");
    const pe: any = parsedEvil!.data;
    ok(pe.messages[0].stickers[0].format === "Png" && pe.messages[1].reference.message.stickers[0].format === "Png", "every sticker is a plain image, a quoted message's too");
    ok(pe.messages[0].embeds[0].url === "" && pe.messages[0].embeds[0].author.url === "" && pe.messages[1].reference.message.embeds[0].url === "", "embed and embed-author links are emptied");
    ok(pe.messages[0].attachments[0].path === "" && pe.messages[0].embeds[0].footer.icon.path === "" && pe.messages[0].author.avatar.path === "", "non-http asset paths are emptied");
    ok(pe.messages[0].attachments[0].width === 0 && pe.messages[0].author.color === "" && pe.messages[0].author.roles[0].color === "", "sizes and colours are plain values");
    ok(pe.invites.abc.guildIcon === "", "invite icon emptied");
    const evilPw = await buildUploadHtml(template, parsedEvil!, { password: "pw", adminMode: true });
    const evilOpened = await decrypt(evilPw, "pw");
    ok(!JSON.stringify(evilOpened.data).includes("Lottie") && !/evil\d/.test(JSON.stringify(evilOpened.data)), "the encrypted upload holds the hardened data too");

    console.log("hardening is a no-op on real exports:");
    const real = makeRealData();
    const realCopy = JSON.parse(JSON.stringify(real));
    assert.deepEqual(hardenExportData(realCopy), real);
    ok(true, "hardenExportData leaves every generator-written field as it is");
    const realHtml = await injectIntoTemplate(template, real, TITLE, new Set([ID1]));
    const realParsed = parseExportHtml(realHtml)!;
    assert.deepEqual(realParsed.data, real);
    ok(normalise(await buildUploadHtml(template, realParsed, { adminMode: false })) === normalise(realHtml), "a real export (embeds, stickers, reactions, Base64 media incl. .js and .xml files, invites, quotes) uploads byte-for-byte as generated");

    console.log("structural hardening (array-likes, __proto__ keys):");
    // The viewer iterates lists with Array.from (so {"0": x, "length": 1} works), and reads the upload's
    // data as an object literal (so a "__proto__" key sets the prototype, inheriting array iteration).
    const lottie = (tag: string) => ({ name: tag, format: "Lottie", _id: padId("5"), source: asset(`https://attacker.example/${tag}.json`) });
    const items: Record<string, (tag: string) => any> = {
        stickers: lottie,
        embeds: tag => ({ title: "t", url: `javascript:${tag}()`, fields: [], author: { name: "a", url: `javascript:${tag}a()` } }),
        attachments: tag => asset(`javascript:${tag}()`),
    };
    // A list of pairs, not an object literal: in a literal the "__proto__" key would set the prototype
    const shapes: [string, (item: any) => string][] = [
        ["array-like", item => JSON.stringify({ 0: item, length: 1 })],
        ["__proto__", item => `{"__proto__":[${JSON.stringify(item)}]}`],
    ];
    const PLACEHOLDER = '"@@FIELD@@"';
    for (const [field, item] of Object.entries(items)) {
        for (const [shapeName, shape] of shapes) {
            for (const where of ["message", "quoted message"]) {
                const tag = `evil_${field}_${shapeName === "array-like" ? "al" : "pr"}_${where === "message" ? "m" : "q"}`;
                const d: any = makeData();
                const target: any = where === "message" ? d.messages[0] : (d.messages[1].reference = { messageId: padId(ID1), channelId: CHANNEL, guildId: GUILD, message: msg(ID1, "quoted") }).message;
                target[field] = "@@FIELD@@";
                const crafted = JSON.parse(JSON.stringify(d).replace(PLACEHOLDER, () => shape(item(tag))));
                const html = await injectIntoTemplate(template, crafted, "hi");
                assert.ok(html.includes(tag), "fixture carries the payload");
                const p = parseExportHtml(html);
                ok(p !== null, `${field} as ${shapeName} in a ${where}: parses`);
                const plain = await buildUploadHtml(template, p!, { adminMode: false });
                const withPw = await buildUploadHtml(template, p!, { password: "pw", adminMode: true });
                const hits = [...viewerHits(await viewerData(plain)), ...viewerHits(await viewerData(withPw, "pw"))];
                ok(hits.length === 0 && !plain.includes(tag) && !plain.includes('"__proto__"'), `${field} as ${shapeName} in a ${where}: nothing reaches the viewer (plain and password uploads)${hits.length ? ": " + hits.join(", ") : ""}`);
            }
        }
    }
    const keysData = JSON.parse(JSON.stringify(makeData()).replace('"messages":[{', () => '"constructor":{"prototype":{"polluted":1}},"messages":[{"__proto__":{"stickers":[' + JSON.stringify(lottie("evil_proto_msg")) + ']},"prototype":{"x":1},'));
    const keysOut = await buildUploadHtml(template, parseExportHtml(await injectIntoTemplate(template, keysData, "hi"))!, { adminMode: false });
    const keysScript = keysOut.slice(keysOut.indexOf("<script>window.__DCEF_DATA="), keysOut.indexOf("</script>", keysOut.indexOf("<script>window.__DCEF_DATA=")));
    ok(!/"(__proto__|constructor|prototype)"/.test(keysScript) && !keysScript.includes("evil_proto_msg"), "__proto__, constructor and prototype keys are dropped at every depth");
    ok(({} as any).polluted === undefined, "Object.prototype is untouched");
    const typed: any = makeData();
    typed.messages[0].author = "javascript:evil_author()";
    typed.messages[0].embeds = [{ title: "t", url: "", fields: { 0: { name: "f", value: "v" }, length: 1 }, images: "x", author: ["x"], thumbnail: "javascript:evil_thumb()" }];
    typed.messages[0].reference = "x";
    const typedParsed: any = parseExportHtml(await injectIntoTemplate(template, typed, "hi"))!.data;
    const te = typedParsed.messages[0].embeds[0];
    ok(typedParsed.messages[0].author === null && typedParsed.messages[0].reference === null && te.author === null && te.thumbnail === null, "fields the generator writes as objects must be plain objects, else null");
    ok(Array.isArray(te.fields) && te.fields.length === 0 && Array.isArray(te.images) && te.images.length === 0, "fields the generator writes as lists must be real arrays, else empty");
    const withThreads: any = makeData();
    withThreads.channels[0].threads = { 0: { _id: padId("11"), name: "t" }, length: 1 };
    withThreads.channels.push({ ...withThreads.channels[0], _id: padId("12"), threads: [{ _id: padId("13"), name: "real" }] });
    const threadsOut: any = parseExportHtml(await injectIntoTemplate(template, withThreads, "hi"))!.data;
    ok(Array.isArray(threadsOut.channels[0].threads) && threadsOut.channels[0].threads.length === 0 && threadsOut.channels[1].threads.length === 1, "a channel's threads list must be a real array, else empty (a real one is kept)");
    const paths: any = makeData();
    const kept = ["https://cdn.discordapp.com/a.png", "HTTPS://cdn.discordapp.com/b.png", "data:image/png;base64,AAAA", "data:application/zip;base64,UEsDBA==", "data:text/javascript;base64,eA==", "data:application/javascript,x", "data:text/xml,<x/>", "data:application/xml;base64,eA=="];
    const dropped = ["data:text/html,<script>evil_d1()</script>", "DATA:text/HTML;base64,PHNjcmlwdD4=", "data:image/svg+xml,<svg onload=evil_d2()>", "data:application/xhtml+xml,x", "httpjavascript:evil_h1()", "http:javascript:evil_h2()", " https://x.example/lead-space.png"];
    paths.messages[0].attachments = [...kept, ...dropped].map(asset);
    const pathsOut: any = parseExportHtml(await injectIntoTemplate(template, paths, "hi"))!.data;
    assert.deepEqual(pathsOut.messages[0].attachments.map((a: any) => a.path), [...kept, ...dropped.map(() => "")]);
    ok(true, "asset paths: http(s):// and data: files kept (code and XML too); data:text/html / svg / xhtml, httpjavascript:, http:javascript: and leading spaces dropped");

    console.log("admin import (normalizeDcefMsg) applies the same structure rules:");
    const { ctx: adminCtx } = runAdminScript(admin, "DCE-Frontend");
    const normaliseImport = (json: string) => vm.runInContext(`normalizeDcefMsg(JSON.parse(${JSON.stringify(json)}))`, adminCtx);
    const baseImport = msg(ID1, "imported");
    const importCases: Record<string, string> = {
        "stickers array-like": JSON.stringify({ ...baseImport, stickers: { 0: lottie("evil_i1"), length: 1 } }),
        "stickers __proto__": JSON.stringify(baseImport).slice(0, -1) + `,"stickers":{"__proto__":[${JSON.stringify(lottie("evil_i2"))}]}}`,
        "quoted message stickers array-like": JSON.stringify({ ...baseImport, reference: { messageId: padId(ID2), channelId: CHANNEL, guildId: GUILD, message: { ...msg(ID2, "q"), stickers: { 0: lottie("evil_i3"), length: 1 } } } }),
        "embeds array-like": JSON.stringify({ ...baseImport, embeds: { 0: items.embeds("evil_i4"), length: 1 } }),
        "attachments array-like": JSON.stringify({ ...baseImport, attachments: { 0: items.attachments("evil_i5"), length: 1 } }),
        "message __proto__": `{"__proto__":{"stickers":[${JSON.stringify(lottie("evil_i6"))}]},` + JSON.stringify(baseImport).slice(1),
    };
    for (const [name, json] of Object.entries(importCases)) {
        const m = normaliseImport(json);
        // What Finish Editing writes for this message, read back as the viewer reads the clean copy (a literal)
        adminCtx.__probe = m;
        const written = vm.runInContext("__safeJson(window.__probe)", adminCtx);
        const reread: any = { window: {} };
        vm.runInNewContext(`window.m=${written};`, reread);
        const hits = viewerHits({ messages: [reread.window.m] });
        ok(hits.length === 0 && !/evil_i\d/.test(written) && !written.includes('"__proto__"'), `import, ${name}: nothing reaches the viewer, live or after Finish Editing${hits.length ? ": " + hits.join(", ") : ""}`);
    }
    const plainImport = normaliseImport(JSON.stringify({ ...baseImport, stickers: [{ name: "w", format: "Png", _id: padId("8"), source: asset("https://media.discordapp.net/stickers/8.webp") }] }));
    ok(plainImport.stickers.length === 1 && plainImport.stickers[0].format === "Png" && plainImport.stickers[0].source.path.startsWith("https://"), "a normal imported message keeps its stickers");

    console.log("hostile input stays fast:");
    const hostile = `<!doctype html><html><head><script>${EXPORT_PATCH_MARK}</script>` + '<script type="module"'.repeat(40_000);
    let t0 = performance.now();
    const hostileResult = parseExportHtml(hostile);
    let ms = performance.now() - t0;
    ok(hostileResult === null && ms < 500, `40,000 unterminated app-script tags: null in ${ms.toFixed(0)} ms (limit 500)`);
    const hostile2 = `<!doctype html><html><head><script>${EXPORT_PATCH_MARK}</script>` + "<title>".repeat(200_000) + '<script>window.__DCEF_DATA={"guild":{},"messages":[]};</script><script type="module">';
    t0 = performance.now();
    const hostile2Result = parseExportHtml(hostile2);
    ms = performance.now() - t0;
    ok(hostile2Result !== null && ms < 500, `200,000 unclosed <title> tags: parsed in ${ms.toFixed(0)} ms (limit 500)`);
    const deep = normal.replace('"invites":{}', () => `"invites":{},"deep":${"[".repeat(100_000)}${"]".repeat(100_000)}`);
    let deepResult: unknown = "threw";
    try { deepResult = parseExportHtml(deep); } catch { /* recorded as "threw" */ }
    ok(deepResult !== "threw", "100,000 nested arrays in the data don't throw (null or parsed)");

    console.log(`\n${passed} checks passed`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
