/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Doc } from "./model";
import { drawDoc } from "./render";

export type SaveFormat = "png" | "webp" | "match";
/** Format of the first, full-size attempt. JPEG only comes from "Match source" with a JPEG source. */
export type PreferredFormat = "png" | "webp" | "jpeg";

export interface EncodeResult { blob: Blob; format: "png" | "webp" | "jpeg"; quality: number; scale: number; bytes: number; }

/** Flatten the doc (base + objects) into a native-res canvas. */
export function flatten(doc: Doc): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = doc.base.width; c.height = doc.base.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    drawDoc(ctx, { ...doc, selectedId: null });
    return c;
}

function toBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
    return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed for " + type)), type, q));
}

/** Mime type + quality of the first attempt (PNG is lossless, so it has no quality). */
function firstAttempt(preferred: PreferredFormat): { type: string; quality: number | undefined; } {
    if (preferred === "png") return { type: "image/png", quality: undefined };
    return { type: `image/${preferred}`, quality: 0.92 };
}

const QUALITY_WALK = [0.92, 0.85, 0.8, 0.7, 0.6, 0.5];

/**
 * Encode the flattened doc, compressing to fit maxBytes (0/Infinity = no limit).
 * Strategy: preferred format → WebP quality walk → progressive downscale.
 */
export async function encodeToFit(doc: Doc, preferred: PreferredFormat, maxBytes: number): Promise<EncodeResult> {
    const flat = flatten(doc);
    const limit = maxBytes && maxBytes > 0 ? maxBytes : Infinity;

    // 1. preferred format, full size
    const { type, quality } = firstAttempt(preferred);
    const first = await toBlob(flat, type, quality);
    let smallest: EncodeResult = { blob: first, format: preferred, quality: quality ?? 1, scale: 1, bytes: first.size };
    if (first.size <= limit) return smallest;

    /** Returns the attempt if it fits; otherwise remembers it when it's the smallest so far. */
    const tryResult = (r: EncodeResult) => {
        if (r.bytes <= limit) return r;
        if (r.bytes < smallest.bytes) smallest = r;
        return null;
    };

    // 2. WebP quality walk at full size
    for (const q of QUALITY_WALK) {
        const b = await toBlob(flat, "image/webp", q);
        const fit = tryResult({ blob: b, format: "webp", quality: q, scale: 1, bytes: b.size });
        if (fit) return fit;
    }

    // 3. progressive downscale at q0.7
    let scale = 1;
    for (let i = 0; i < 6; i++) {
        scale *= 0.8;
        const sc = document.createElement("canvas");
        sc.width = Math.max(1, Math.round(flat.width * scale));
        sc.height = Math.max(1, Math.round(flat.height * scale));
        const sctx = sc.getContext("2d")!; sctx.imageSmoothingQuality = "high";
        sctx.drawImage(flat, 0, 0, sc.width, sc.height);
        const b = await toBlob(sc, "image/webp", 0.7);
        const fit = tryResult({ blob: b, format: "webp", quality: 0.7, scale, bytes: b.size });
        if (fit) return fit;
    }

    // give up: return the smallest attempt
    return smallest;
}

/** File extension for an encoded format. */
export const extFor = (format: PreferredFormat) => (format === "jpeg" ? "jpg" : format);

/** A file name without its last extension: "photo.final.png" gives "photo.final". */
export function stripExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, "");
}

/** Longest base name (in characters, not counting the extension) a saved file gets. */
const MAX_BASE_CHARS = 100;
/** An image extension the user typed into the name box. The save format decides the real one. */
const IMAGE_EXT = /\.(?:png|apng|jpe?g|jfif|webp|gif|bmp|avif|heic|tiff?)$/i;
/** Device names Windows won't use as a file name, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const trimDotsAndSpaces = (s: string) => s.replace(/^[\s.]+|[\s.]+$/g, "");

/**
 * Turn whatever was typed in the name box into a safe file name ending in `.${ext}`. Path separators are
 * dropped, characters Windows can't have in a name (and control characters) become "_", leading and
 * trailing dots and spaces go, and the base is capped at 100 characters. An empty result becomes "image".
 */
export function sanitizeFileName(name: string, ext: string): string {
    let base = name
        .replace(/[\\/]/g, "")
        .replace(/[<>:"|?*\p{Cc}]/gu, "_");
    base = trimDotsAndSpaces(trimDotsAndSpaces(base).replace(IMAGE_EXT, ""));
    // cap by code points so an emoji is never cut in half
    base = trimDotsAndSpaces(Array.from(base).slice(0, MAX_BASE_CHARS).join(""));
    if (!base) base = "image";
    if (RESERVED.test(base)) base += "_";
    return `${base}.${ext}`;
}

/** Cheap size probe for the live readout: just the preferred format at full size. */
export async function estimateSize(doc: Doc, preferred: PreferredFormat): Promise<number> {
    const flat = flatten(doc);
    const { type, quality } = firstAttempt(preferred);
    const b = await toBlob(flat, type, quality);
    return b.size;
}
