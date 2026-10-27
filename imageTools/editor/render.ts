/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { withAlpha } from "./color";
import { normRect, orientMatrix, Rect } from "./geometry";
import { Doc, ImgSize, Obj, RegionObj } from "./model";
import { blockAverages, blurRadiusPx, blurWorkScale, pixelBlockPx, pixelRect, regionSources, sampleRect, sourcesKey } from "./region";

export function drawDoc(ctx: CanvasRenderingContext2D, doc: Doc) {
    beginRegionPass(doc.base);
    ctx.drawImage(doc.base, 0, 0);
    doc.objects.forEach((o, i) => drawObject(ctx, o, doc.base, doc.objects, i));
}

/**
 * Draw one object. A blur/pixelate region also needs the object list and its own index in it (it reads
 * everything below it); a region not in the list yet (being drawn) goes on top of all of them.
 */
export function drawObject(ctx: CanvasRenderingContext2D, o: Obj, base: HTMLCanvasElement, objects: readonly Obj[] = [], index = objects.length) {
    ctx.save();
    switch (o.type) {
        case "brush":
        case "highlight": {
            ctx.strokeStyle = withAlpha(o.color, o.opacity);
            ctx.lineWidth = o.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            o.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.stroke();
            break;
        }
        case "line":
        case "arrow": {
            ctx.strokeStyle = withAlpha(o.color, 1);
            ctx.fillStyle = withAlpha(o.color, 1);
            ctx.lineWidth = o.width;
            ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(o.a.x, o.a.y); ctx.lineTo(o.b.x, o.b.y); ctx.stroke();
            if (o.type === "arrow") {
                const ang = Math.atan2(o.b.y - o.a.y, o.b.x - o.a.x);
                const head = Math.max(10, o.width * 3);
                ctx.beginPath();
                ctx.moveTo(o.b.x, o.b.y);
                ctx.lineTo(o.b.x - head * Math.cos(ang - Math.PI / 6), o.b.y - head * Math.sin(ang - Math.PI / 6));
                ctx.lineTo(o.b.x - head * Math.cos(ang + Math.PI / 6), o.b.y - head * Math.sin(ang + Math.PI / 6));
                ctx.closePath(); ctx.fill();
            }
            break;
        }
        case "rect": {
            const r = normRect(o.rect);
            ctx.lineWidth = o.width;
            if (o.fill) { ctx.fillStyle = withAlpha(o.color, 1); ctx.fillRect(r.x, r.y, r.w, r.h); }
            else { ctx.strokeStyle = withAlpha(o.color, 1); ctx.strokeRect(r.x, r.y, r.w, r.h); }
            break;
        }
        case "ellipse": {
            const r = normRect(o.rect);
            ctx.lineWidth = o.width;
            ctx.beginPath();
            ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
            if (o.fill) { ctx.fillStyle = withAlpha(o.color, 1); ctx.fill(); }
            else { ctx.strokeStyle = withAlpha(o.color, 1); ctx.stroke(); }
            break;
        }
        case "text": {
            ctx.fillStyle = withAlpha(o.color, 1);
            ctx.font = `${o.size}px sans-serif`;
            ctx.textBaseline = "top";
            o.text.split("\n").forEach((line, i) => ctx.fillText(line, o.pos.x, o.pos.y + i * o.size * 1.2));
            break;
        }
        case "blur":
        case "pixelate": {
            drawRegion(ctx, o, base, objects, index);
            break;
        }
        case "image": {
            // turned and mirrored inside its rect (whole-canvas rotate/flip), see orientMatrix
            ctx.transform(...orientMatrix(o, o.rect, o.img.width, o.img.height));
            ctx.drawImage(o.img, 0, 0);
            break;
        }
    }
    ctx.restore();
}

// ---- Blur and pixelate ----
// A region hides everything beneath it. It is rendered once, at image resolution, from the base image
// plus the non-region objects below it (inserted images, strokes, shapes, text: regionSources), into its
// own bitmap. Other blur/pixelate regions are never read, so there is no blur of a blur: a region above
// another one reads what is under the lower region as if it weren't there.
// The editor view and the saved file both draw that same bitmap, so the preview is exactly what gets
// saved, at any zoom. Bitmaps are cached per object and only re-rendered when the region's pixel rect,
// intensity or size basis, the base image, or any object it reads (sourcesKey) changes, so panning,
// zooming and editing objects elsewhere never re-blur anything.

interface RegionBitmap { key: string; bmp: HTMLCanvasElement; used: number; }

const regionCache = new Map<string, RegionBitmap>(); // by object id
let cacheBase: HTMLCanvasElement | null = null;
let pass = 0;
/**
 * Reusable work canvases: [0] and [1] for the blur, [2] for the pixelate block colours, [3] and [4] for
 * a region's source (base plus objects below) for the blur and for the pixelate (read back) respectively.
 */
const scratch: (HTMLCanvasElement | undefined)[] = []; // slots fill in any order, so it can have holes
/** Work canvases bigger than this (pixels) are shrunk again after use, so one big region doesn't keep them alive. */
const SCRATCH_KEEP_PX = 4_000_000;
/** A stable number per inserted bitmap, for the cache key. */
const imgIds = new WeakMap<object, number>();
let nextImgId = 1;
/** Source object hashes for the current draw pass (objects can't change mid-pass; cleared when a pass starts). */
const passHashes = new Map<Obj, string>();

function imgId(img: object): number {
    let id = imgIds.get(img);
    if (id === undefined) imgIds.set(img, id = nextImgId++);
    return id;
}

/** Forget every cached region bitmap and shrink the work canvases (the editor calls this when it closes). */
export function clearRegionCache() {
    regionCache.clear();
    cacheBase = null;
    passHashes.clear(); // its keys are objects, and an inserted image's object holds its bitmap
    for (const c of scratch) if (c) shrink(c);
}

function shrink(c: HTMLCanvasElement) {
    c.width = 1; c.height = 1;
}

function useBase(base: HTMLCanvasElement) {
    if (cacheBase !== base) { regionCache.clear(); cacheBase = base; }
}

/** Start of a whole-document draw: drop bitmaps of regions not drawn in the last two passes (deleted, undone). */
function beginRegionPass(base: HTMLCanvasElement) {
    useBase(base);
    pass++;
    passHashes.clear();
    for (const [id, e] of regionCache) if (e.used < pass - 2) regionCache.delete(id);
}

/** A canvas of exactly w x h with a fresh 2D state (setting the size resets transform, filter and pixels). Reuses `c` when given. */
function sizedCanvas(c: HTMLCanvasElement | undefined, w: number, h: number): HTMLCanvasElement {
    const out = c ?? document.createElement("canvas");
    out.width = w; out.height = h;
    return out;
}

function scratchCanvas(i: number, w: number, h: number): HTMLCanvasElement {
    return scratch[i] = sizedCanvas(scratch[i], w, h);
}

const validRef = (r: ImgSize | undefined): r is ImgSize => !!r && r.w > 0 && r.h > 0;

/** How far past the region a blur of radius sigma reads (a Gaussian reaches about 3 sigma). */
const blurPad = (sigma: number) => Math.ceil(sigma * 3) + 2;

/** The whole pixelate blocks a region touches, on the grid anchored to the image's top-left, clamped to the image. */
function blockArea(r: Rect, block: number, W: number, H: number): Rect {
    const x = Math.floor(r.x / block) * block, y = Math.floor(r.y / block) * block;
    const x1 = Math.min(W, Math.ceil((r.x + r.w) / block) * block), y1 = Math.min(H, Math.ceil((r.y + r.h) / block) * block);
    return { x, y, w: x1 - x, h: y1 - y };
}

/** Pixels a region reads: a canvas plus where its top-left sits in image coordinates. */
interface Source { img: HTMLCanvasElement; ox: number; oy: number; }

/**
 * What a region reads inside `area` (whole image pixels, inside the image): the base image with the
 * region's source objects drawn on top, on a work canvas. With no such objects it's the base itself.
 */
function regionSource(base: HTMLCanvasElement, area: Rect, sources: readonly Obj[], readBack: boolean): Source {
    if (!sources.length) return { img: base, ox: 0, oy: 0 };
    const c = scratchCanvas(readBack ? 4 : 3, area.w, area.h);
    const ctx = c.getContext("2d", readBack ? { willReadFrequently: true } : undefined)!;
    ctx.translate(-area.x, -area.y);
    ctx.drawImage(base, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
    for (const o of sources) drawObject(ctx, o, base); // never a region (regionSources skips them)
    return { img: c, ox: area.x, oy: area.y };
}

function drawRegion(ctx: CanvasRenderingContext2D, o: RegionObj, base: HTMLCanvasElement, objects: readonly Obj[], index: number) {
    useBase(base);
    const W = base.width, H = base.height;
    const r = pixelRect(o.rect, W, H);
    if (r.w < 1 || r.h < 1) return;
    const ref = validRef(o.ref) ? o.ref : { w: W, h: H };
    // what the region reads: the padded blur area, or the whole blocks it touches
    const amount = o.type === "blur" ? blurRadiusPx(o.intensity, ref.w, ref.h) : pixelBlockPx(o.intensity, ref.w, ref.h);
    const area = o.type === "blur" ? sampleRect(r, blurPad(amount), W, H) : blockArea(r, amount, W, H);
    const sources = regionSources(objects, index, area);
    const key = `${o.type}|${r.x},${r.y},${r.w},${r.h}|${o.intensity}|${ref.w},${ref.h}|${sourcesKey(sources, imgId, passHashes)}`;
    let e = regionCache.get(o.id);
    if (!e || e.key !== key) {
        const src = regionSource(base, area, sources, o.type === "pixelate");
        // the same object re-rendered (dragged, resized, new strength) redraws into its own canvas
        const bmp = o.type === "blur" ? renderBlur(src, W, H, r, amount, e?.bmp) : renderPixelate(src, area, r, amount, e?.bmp);
        for (const c of scratch) if (c && c.width * c.height > SCRATCH_KEEP_PX) shrink(c);
        if (e) { e.key = key; e.bmp = bmp; }
        else regionCache.set(o.id, e = { key, bmp, used: pass });
    }
    e.used = pass;
    // Replace the region's pixels instead of drawing over them: on a see-through image the sharp pixels
    // already on the canvas would show through the soft result. On an opaque image the bitmap covers the
    // cleared rect exactly, also on the zoomed editor view (checked in Chromium: no see-through seams).
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(e.bmp, r.x, r.y);
}

/**
 * Gaussian blur of the region r (whole image pixels, inside a W x H image) with radius sigma, drawn
 * into `into` (or a new canvas), reading from src. The blur reads a padded area around r. Inside the
 * image that is the real pixels (sampleRect); past the image edge the edge pixels are repeated, so a
 * region touching the edge stays fully opaque instead of fading to transparent and showing the sharp
 * original underneath. Everything the blur reads is on its own canvas, so nothing depends on how the
 * browser treats pixels outside a canvas.
 */
function renderBlur(src: Source, W: number, H: number, r: Rect, sigma: number, into?: HTMLCanvasElement): HTMLCanvasElement {
    const pad = blurPad(sigma);
    // P: the padded area in image pixels (it may reach past the image)
    const px = r.x - pad, py = r.y - pad, pw = r.w + 2 * pad, ph = r.h + 2 * pad;
    const px1 = px + pw, py1 = py + ph;
    const s = sampleRect(r, pad, W, H); // the part of P inside the image
    const sx1 = s.x + s.w, sy1 = s.y + s.h;
    // Big radii blur a scaled-down copy: the result is smooth anyway, and a 4K image stays fast.
    const k = blurWorkScale(sigma);
    const ww = Math.max(1, Math.ceil(pw * k)), wh = Math.max(1, Math.ceil(ph * k));
    const fx = ww / pw, fy = wh / ph;

    const work = scratchCanvas(0, ww, wh);
    const w = work.getContext("2d")!;
    w.imageSmoothingQuality = "high";
    w.setTransform(fx, 0, 0, fy, -px * fx, -py * fy); // draw in image pixels
    /** Copy source pixels (image coordinates) to the work canvas (image coordinates). */
    const put = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) =>
        w.drawImage(src.img, sx - src.ox, sy - src.oy, sw, sh, dx, dy, dw, dh);
    // Past the image edge: repeat the edge row/column, and the corner pixel in the corners. The real
    // pixels go on last. Axis-aligned drawImage isn't antialiased, so the pieces meet without see-through
    // seams even on the scaled-down copy (checked in Chromium). Even if a seam did appear it could only
    // make the result slightly see-through at the image edge, and the region is cleared before it's drawn.
    const left = s.x > px, right = sx1 < px1, top = s.y > py, bottom = sy1 < py1;
    if (left) put(s.x, s.y, 1, s.h, px, s.y, s.x - px, s.h);
    if (right) put(sx1 - 1, s.y, 1, s.h, sx1, s.y, px1 - sx1, s.h);
    if (top) put(s.x, s.y, s.w, 1, s.x, py, s.w, s.y - py);
    if (bottom) put(s.x, sy1 - 1, s.w, 1, s.x, sy1, s.w, py1 - sy1);
    if (left && top) put(s.x, s.y, 1, 1, px, py, s.x - px, s.y - py);
    if (right && top) put(sx1 - 1, s.y, 1, 1, sx1, py, px1 - sx1, s.y - py);
    if (left && bottom) put(s.x, sy1 - 1, 1, 1, px, sy1, s.x - px, py1 - sy1);
    if (right && bottom) put(sx1 - 1, sy1 - 1, 1, 1, sx1, sy1, px1 - sx1, py1 - sy1);
    put(s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);

    const blurred = scratchCanvas(1, ww, wh);
    const b = blurred.getContext("2d")!;
    b.filter = `blur(${sigma * (fx + fy) / 2}px)`;
    b.drawImage(work, 0, 0);

    // keep only the region, back at full resolution
    const out = sizedCanvas(into, r.w, r.h);
    const o = out.getContext("2d")!;
    o.imageSmoothingQuality = "high";
    o.drawImage(blurred, (r.x - px) * fx, (r.y - py) * fy, r.w * fx, r.h * fy, 0, 0, r.w, r.h);
    return out;
}

/**
 * Pixelate the region r (whole image pixels, inside the image) with square blocks of `block` px, drawn
 * into `into` (or a new canvas), reading the blocks in `area` (blockArea) from src. Each block is the
 * average colour of its pixels (not one sampled pixel, which flickers as the region moves and can pick a
 * stray text pixel). The block grid is anchored to the image's top-left corner, so moving or resizing a
 * region doesn't shift the blocks; edge blocks average their whole cell.
 */
function renderPixelate(src: Source, area: Rect, r: Rect, block: number, into?: HTMLCanvasElement): HTMLCanvasElement {
    const { data } = src.img.getContext("2d")!.getImageData(area.x - src.ox, area.y - src.oy, area.w, area.h);
    const grid = blockAverages(data, area.w, area.h, block);

    const cells = scratchCanvas(2, grid.cols, grid.rows);
    const cctx = cells.getContext("2d")!;
    const img = cctx.createImageData(grid.cols, grid.rows);
    img.data.set(grid.rgba);
    cctx.putImageData(img, 0, 0);

    const out = sizedCanvas(into, r.w, r.h);
    const o = out.getContext("2d")!;
    o.imageSmoothingEnabled = false; // hard block edges
    o.drawImage(cells, area.x - r.x, area.y - r.y, grid.cols * block, grid.rows * block);
    return out;
}
