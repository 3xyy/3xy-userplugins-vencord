/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure maths for the blur and pixelate regions (no DOM), so _dev/check-region.ts can run it in Node.
//
// Both tools take an intensity from 1 to 100. Slider right is always stronger. The intensity is turned
// into a size in IMAGE pixels, scaled by the size of the image the region was drawn on (never below the
// size of a 1 MP image, so small snips still get a strong effect). The same setting looks about the
// same on a snip and on a 4K photo, and zooming the view changes nothing. Both curves are exponential:
// small values give fine control, the top of the range wipes the region out.

import { normRect, Rect } from "./geometry";
import { Obj, paintBounds } from "./model";

export const INTENSITY_MIN = 1;
export const INTENSITY_MAX = 100;

/** Blur radius at intensity 1 and 100, per "1000 px" of image size (see imageScale). Each step is x1.045. */
const BLUR_MIN = 1.5;
const BLUR_MAX = 120;
/** Block size at intensity 1 (a 1 px block would be no pixelation at all). */
const PIXEL_MIN = 2;
/** Block size at intensity 100, per "1000 px" of image size, and never below PIXEL_CAP_FLOOR. */
const PIXEL_MAX = 48;
const PIXEL_CAP_FLOOR = 8;
/**
 * Curvature of the block size curve, 2 + (cap - 2) * (e^(a*u) - 1) / (e^a - 1): bigger steps toward the
 * top, but steep enough at the bottom that whole-pixel rounding never sticks on one size for more than
 * 4 steps (a plain 2 * (cap / 2)^u stays on 2 or 3 px for the first ~17 steps).
 */
const PIXEL_CURVE = 1.2;

/** Radii above this blur a scaled-down copy (then scale it back up): same look, far less work for huge radii. */
export const MAX_WORK_SIGMA = 12;
/** Pixelate averages at most about this many samples per block side (big blocks use a sub-grid). */
const MAX_SAMPLES_PER_SIDE = 16;

export type RegionType = "blur" | "pixelate";

function clampIntensity(t: number): number {
    if (!Number.isFinite(t)) return INTENSITY_MIN;
    return Math.max(INTENSITY_MIN, Math.min(INTENSITY_MAX, t));
}

/** 0..1 position of an intensity on the curve. */
function curvePos(t: number): number {
    return (clampIntensity(t) - INTENSITY_MIN) / (INTENSITY_MAX - INTENSITY_MIN);
}

/**
 * Image size in thousands of pixels (geometric mean of the sides), never below 1: 1920x1080 is 1.44,
 * 4000x3000 is 3.46, and anything up to 1 MP (a 400x300 snip, an 800x600 image) is 1.
 */
function imageScale(imageW: number, imageH: number): number {
    return Math.max(1, Math.sqrt(Math.max(0, imageW * imageH)) / 1000);
}

/** Block size at intensity 100. */
function pixelCap(imageW: number, imageH: number): number {
    return Math.max(PIXEL_CAP_FLOOR, imageScale(imageW, imageH) * PIXEL_MAX);
}

/**
 * Blur radius in image pixels for an intensity (1-100) on an image of imageW x imageH.
 * It is the Gaussian standard deviation, the value CSS blur() takes. Strictly increasing in intensity
 * and linear in image size above 1 MP. Intensity 50 is 13.1 px up to 1 MP and 18.9 px on 1920x1080.
 */
export function blurRadiusPx(intensity: number, imageW: number, imageH: number): number {
    return imageScale(imageW, imageH) * BLUR_MIN * Math.pow(BLUR_MAX / BLUR_MIN, curvePos(intensity));
}

/**
 * Pixelate block size in whole image pixels for an intensity (1-100) on an image of imageW x imageH:
 * 2 px at 1, up to 48 px per 1000 px of image size at 100. Never shrinks as the intensity goes up.
 * Intensity 50 is 18 px up to 1 MP and 25 px on 1920x1080.
 */
export function pixelBlockPx(intensity: number, imageW: number, imageH: number): number {
    const span = pixelCap(imageW, imageH) - PIXEL_MIN;
    const raw = PIXEL_MIN + span * Math.expm1(PIXEL_CURVE * curvePos(intensity)) / Math.expm1(PIXEL_CURVE);
    return Math.max(PIXEL_MIN, Math.round(raw));
}

/**
 * The region's source rect padded by `radius` on every side, rounded out to whole pixels and clamped
 * to the image, so a blur never reads (transparent) pixels from outside the image. Where the clamp cuts
 * the padding short (a region at the image edge), the renderer repeats the edge pixels instead.
 */
export function sampleRect(rect: Rect, radius: number, imageW: number, imageH: number): Rect {
    const r = normRect(rect);
    const pad = Math.max(0, radius);
    const x0 = Math.min(imageW, Math.max(0, Math.floor(r.x - pad)));
    const y0 = Math.min(imageH, Math.max(0, Math.floor(r.y - pad)));
    const x1 = Math.max(0, Math.min(imageW, Math.ceil(r.x + r.w + pad)));
    const y1 = Math.max(0, Math.min(imageH, Math.ceil(r.y + r.h + pad)));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** The region itself, snapped outward to whole pixels and clamped to the image (empty when fully outside). */
export function pixelRect(rect: Rect, imageW: number, imageH: number): Rect {
    return sampleRect(rect, 0, imageW, imageH);
}

/** Scale (at most 1) of the copy a blur of `sigma` px is computed on. */
export function blurWorkScale(sigma: number): number {
    return sigma > MAX_WORK_SIGMA ? MAX_WORK_SIGMA / sigma : 1;
}

/**
 * Old regions stored their strength as plain pixels (blur radius 2-40 px, block size 4-40 px) on
 * whatever image they were drawn on. This finds the 1-100 intensity that gives the closest radius or
 * block size on an image of imageW x imageH (the inverse of the curves above), clamped to 1-100.
 * Examples on 1920x1080: blur 12 px becomes 40 (12.1 px), pixel 12 px becomes 25 (12 px).
 */
export function legacyIntensity(type: RegionType, px: number, imageW: number, imageH: number): number {
    if (!(px > 0)) return INTENSITY_MIN;
    let pos: number;
    if (type === "blur") {
        pos = Math.log(px / (imageScale(imageW, imageH) * BLUR_MIN)) / Math.log(BLUR_MAX / BLUR_MIN);
    } else {
        const x = 1 + (px - PIXEL_MIN) * Math.expm1(PIXEL_CURVE) / (pixelCap(imageW, imageH) - PIXEL_MIN);
        pos = x > 0 ? Math.log(x) / PIXEL_CURVE : 0;
    }
    return Math.round(clampIntensity(INTENSITY_MIN + pos * (INTENSITY_MAX - INTENSITY_MIN)));
}

export interface BlockGrid { cols: number; rows: number; /** One RGBA pixel per block, row-major. */ rgba: Uint8ClampedArray; }

/**
 * Average colour of each `block` x `block` cell of an RGBA pixel array (w x h, cells start at 0,0;
 * the last column/row may be partial). Alpha-weighted, so transparent pixels don't darken a block.
 * Blocks bigger than 16 px average a regular sub-grid of their pixels, which keeps huge blocks cheap.
 */
export function blockAverages(data: Uint8ClampedArray, w: number, h: number, block: number): BlockGrid {
    const b = Math.max(1, Math.floor(block));
    const cols = Math.ceil(w / b), rows = Math.ceil(h / b);
    const n = cols * rows;
    const sum = new Float64Array(n * 4); // premultiplied r, g, b, plus alpha
    const count = new Uint32Array(n);
    const step = Math.max(1, Math.floor(b / MAX_SAMPLES_PER_SIDE));
    const start = step >> 1;

    const add = (x: number, y: number, cell: number) => {
        const i = (y * w + x) * 4;
        const a = data[i + 3];
        const s = cell * 4;
        sum[s] += data[i] * a;
        sum[s + 1] += data[i + 1] * a;
        sum[s + 2] += data[i + 2] * a;
        sum[s + 3] += a;
        count[cell]++;
    };

    for (let y = start; y < h; y += step) {
        const rowCell = Math.floor(y / b) * cols;
        for (let x = start; x < w; x += step) add(x, y, rowCell + Math.floor(x / b));
    }
    // a thin partial edge block can fall between samples: give it its first pixel
    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            const cell = cy * cols + cx;
            if (!count[cell]) add(cx * b, cy * b, cell);
        }
    }

    const rgba = new Uint8ClampedArray(n * 4);
    for (let cell = 0; cell < n; cell++) {
        const s = cell * 4, a = sum[s + 3];
        if (a > 0) {
            rgba[s] = Math.round(sum[s] / a);
            rgba[s + 1] = Math.round(sum[s + 1] / a);
            rgba[s + 2] = Math.round(sum[s + 2] / a);
        }
        rgba[s + 3] = Math.round(a / count[cell]);
    }
    return { cols, rows, rgba };
}

// ---- What a region reads ----
// A region hides everything beneath it: it reads the base image plus every non-region object below it in
// z-order (inserted images, strokes, shapes, text) and blurs or pixelates that. Other blur/pixelate regions
// are never read: a region above another one reads what is under the lower region as if it weren't there,
// so there is never a blur of a blur, and two overlapping regions don't depend on each other.

const isRegion = (o: Obj) => o.type === "blur" || o.type === "pixelate";

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The objects a region at `index` in objs reads (objs.length for a region not in the list yet, like one
 * being drawn): every non-region object below it whose painted area overlaps `area`, bottom to top.
 */
export function regionSources(objs: readonly Obj[], index: number, area: Rect): Obj[] {
    const out: Obj[] = [];
    const end = Math.min(index, objs.length);
    for (let i = 0; i < end; i++) {
        const o = objs[i];
        if (!isRegion(o) && overlaps(paintBounds(o), area)) out.push(o);
    }
    return out;
}

// Two 32-bit hashes (FNV-1a and a murmur-style mix) over the exact bits of every number, for a 64-bit key.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Hasher {
    a = 0x811c9dc5;
    b = 0x9747b28c;
    word(w: number) {
        this.a = Math.imul(this.a ^ w, 0x01000193) >>> 0;
        const m = Math.imul(this.b ^ w, 0x5bd1e995);
        this.b = (m ^ (m >>> 15)) >>> 0;
    }
    num(n: number) { f64[0] = n; this.word(u32[0]); this.word(u32[1]); }
    str(s: string) { this.word(s.length); for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i)); }
}

function hashValue(h: Hasher, v: unknown, imgId: (img: object) => number) {
    if (typeof v === "number") { h.word(1); h.num(v); }
    else if (typeof v === "string") { h.word(2); h.str(v); }
    else if (typeof v === "boolean") h.word(v ? 3 : 4);
    else if (v == null) h.word(5);
    else if (Array.isArray(v)) { h.word(6); h.word(v.length); for (const x of v) hashValue(h, x, imgId); }
    else if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        h.word(7);
        for (const k of Object.keys(v)) {
            const x = (v as Record<string, unknown>)[k];
            h.str(k);
            // a stroke's points ({x, y}, often hundreds): straight to the numbers, it's the hot path
            if (k === "pts" && Array.isArray(x)) { h.word(9); h.word(x.length); for (const p of x) { h.num(p.x); h.num(p.y); } }
            else hashValue(h, x, imgId);
        }
    } else if (typeof v === "object") { h.word(8); h.word(imgId(v)); } // a bitmap or canvas: by identity
}

/** Hash of one object: every field, exactly (a bitmap counts by identity through imgId). */
function objectHash(o: Obj, imgId: (img: object) => number): string {
    const h = new Hasher();
    hashValue(h, o, imgId);
    return h.a.toString(36) + "." + h.b.toString(36);
}

/**
 * A key for how a region's source objects look: every field of every object, exactly, in order. It
 * changes when any of them moves, resizes, turns or is restyled, and stays the same for an identical copy
 * (undo, re-edit). memo can hold object hashes for one draw pass (objects don't change within a pass),
 * so several regions over the same objects hash each object once.
 */
export function sourcesKey(objs: readonly Obj[], imgId: (img: object) => number, memo?: Map<Obj, string>): string {
    let key = String(objs.length);
    for (const o of objs) {
        let oh = memo?.get(o);
        if (oh === undefined) { oh = objectHash(o, imgId); memo?.set(o, oh); }
        key += ":" + oh;
    }
    return key;
}
