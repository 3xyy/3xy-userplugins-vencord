/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure checks shared by the renderer (UI hints) and native.ts (the real gate: anything can call a
// plugin's native IPC handlers, so native.ts validates every argument again).

/** Cloudflare Pages project name. */
export const CF_PROJECT_RE = /^[a-z0-9-]{1,58}$/;
/** Cloudflare account ID: 32 hex characters. */
export const CF_ACCOUNT_RE = /^[0-9a-fA-F]{32}$/;
/** Cloudflare API token: URL-safe characters only (it goes into an HTTP header and an env var). */
export const CF_TOKEN_RE = /^[A-Za-z0-9._-]{20,300}$/;
/** Catbox userhash. */
export const CATBOX_USERHASH_RE = /^[A-Za-z0-9]{1,64}$/;
/** File names makeFilename() produces, plus the `_2`, `_3` suffix added when a file already exists. */
export const EXPORT_FILENAME_RE = /^(admin_)?[A-Za-z0-9]{1,3}-[A-Za-z0-9]{1,3}-\d{1,13}(_\d{1,6})?\.html$/;

/** Only http(s) links: embed and embed-author URLs become href attributes in the viewer. */
export function httpUrl(u: unknown): string {
    return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "";
}

/**
 * data: media types that open as a page that can run script (HTML, XHTML, SVG). Code and XML files
 * (text/javascript, application/xml, ...) only show as text or download, so Base64 attachments of
 * those keep their links.
 */
const SCRIPTABLE_DATA_TYPE_RE = /^data:\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml)\s*[;,]/i;

/**
 * An asset path the generator writes (makeAsset): an http(s) URL or a data: URI (Base64 media), else
 * "". The viewer turns anything else into a relative /input/ path, and uses these as src and href.
 * A data: URI that would open as an HTML, XHTML or SVG page is refused too.
 */
export function safeAssetUrl(url: unknown): string {
    if (typeof url !== "string") return "";
    if (/^https?:\/\//i.test(url)) return url;
    return /^data:/i.test(url) && !SCRIPTABLE_DATA_TYPE_RE.test(url) ? url : "";
}

/** A colour the viewer may put into a style attribute: #hex or rgb()/rgba() with numbers only, else "". */
export function safeCssColor(c: unknown): string {
    return typeof c === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]{1,40}\))$/i.test(c) ? c : "";
}

/** Cloudflare Pages limit for a single file. */
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;

/**
 * Bytes read from a file to check that it is an ExportChat export before deleting it. A Finish Editing
 * copy's highlight CSS comes before its patch script, so this is more than the first few KB.
 */
export const EXPORT_SNIFF_BYTES = 1024 * 1024;

/**
 * Part of the history/fetch patch script in every export, written by the plugin (normal, admin and
 * password exports) and by admin mode's Finish Editing button (minified there, same text).
 */
export const EXPORT_PATCH_MARK = "history.pushState=function(s,t,u){try{op.call(this,s,t,u)}catch(e){try{op.call(this,s,t)}catch(e2){}}}";

/**
 * True if the start of a file looks like an export this plugin wrote: a normal, admin or password
 * export (its "Export: " title) or a Finish Editing copy (the patch script; its title is the viewer's).
 */
export function looksLikeExportHead(head: string): boolean {
    return /^\s*<!doctype html>/i.test(head) && (head.includes("<title>Export: ") || head.includes(EXPORT_PATCH_MARK));
}

/** Why sharing to Cloudflare Pages can't run with these settings, or null when it can. */
export function cfConfigError(token: unknown, accountId: unknown, project: unknown): string | null {
    const t = typeof token === "string" ? token.trim() : "";
    const a = typeof accountId === "string" ? accountId.trim() : "";
    const p = typeof project === "string" ? project.trim() : "";
    if (!t || !a || !p) return "Sharing is off: set the Cloudflare API token, account ID and Pages project name in ExportChat settings.";
    if (!CF_PROJECT_RE.test(p)) return "Cloudflare Pages project name must be 1-58 lowercase letters, digits or hyphens.";
    if (!CF_ACCOUNT_RE.test(a)) return "Cloudflare account ID must be 32 hex characters.";
    if (!CF_TOKEN_RE.test(t)) return "Cloudflare API token contains unexpected characters.";
    return null;
}
