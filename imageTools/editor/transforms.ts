/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { flipOrient, normRect, Rect, rotateOrient } from "./geometry";
import { cloneObjects, Obj } from "./model";

type PointMap = (x: number, y: number) => { x: number; y: number; };

// The object half of each transform is pure (no canvas), so _dev/check-transforms.ts can run it in Node.
// Each returns new objects; the input is never mutated (history snapshots share nothing with the result).

function mapPoints(objs: Obj[], fn: PointMap): Obj[] {
    const out = cloneObjects(objs);
    for (const o of out) {
        switch (o.type) {
            case "brush": case "highlight": o.pts = o.pts.map(p => fn(p.x, p.y)); break;
            case "line": case "arrow": o.a = fn(o.a.x, o.a.y); o.b = fn(o.b.x, o.b.y); break;
            case "text": o.pos = fn(o.pos.x, o.pos.y); break;
            default: { const r = normRect(o.rect); const p1 = fn(r.x, r.y); const p2 = fn(r.x + r.w, r.y + r.h); o.rect = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) }; }
        }
    }
    return out;
}

/** Where a point of a W x H canvas goes when the canvas turns a quarter clockwise (dir 1) or counter-clockwise (dir -1). */
export function rotatePointMap(W: number, H: number, dir: 1 | -1): PointMap {
    return dir === 1 ? (x, y) => ({ x: H - y, y: x }) : (x, y) => ({ x: y, y: W - x });
}

/** Where a point of a W x H canvas goes when the canvas is mirrored left-right (h) or top-bottom (v). */
export function flipPointMap(W: number, H: number, axis: "h" | "v"): PointMap {
    return axis === "h" ? (x, y) => ({ x: W - x, y }) : (x, y) => ({ x, y: H - y });
}

export function cropObjects(objs: Obj[], crop: Rect): Obj[] {
    const c = normRect(crop);
    // blur/pixelate regions keep their size basis (ref), so a crop keeps their radius / block size
    // (the pixelate grid and a blur at the new edge can still shift a little, see RegionObj.ref)
    return mapPoints(objs, (x, y) => ({ x: x - c.x, y: y - c.y }));
}

export function rotateObjects(objs: Obj[], W: number, H: number, dir: 1 | -1): Obj[] {
    const out = mapPoints(objs, rotatePointMap(W, H, dir));
    for (const o of out) {
        // a region's strength is measured against its image size: a quarter turn swaps the sides
        if (o.type === "blur" || o.type === "pixelate") o.ref = { w: o.ref.h, h: o.ref.w };
        // an inserted image turns with the picture
        else if (o.type === "image") Object.assign(o, rotateOrient(o, dir));
    }
    return out;
}

export function flipObjects(objs: Obj[], W: number, H: number, axis: "h" | "v"): Obj[] {
    const out = mapPoints(objs, flipPointMap(W, H, axis));
    for (const o of out) if (o.type === "image") Object.assign(o, flipOrient(o, axis)); // mirrored with the picture
    return out;
}

/** sx, sy: new size / old size. */
export function resizeObjects(objs: Obj[], sx: number, sy: number): Obj[] {
    const s = (sx + sy) / 2; // scale scalar attrs (stroke width, font size) so annotations resize with the image
    const out = mapPoints(objs, (x, y) => ({ x: x * sx, y: y * sy }));
    for (const o of out) {
        if (o.type === "text") o.size *= s;
        // keep the intensity; scaling the size it's measured against scales the radius / block size with the image
        else if (o.type === "blur" || o.type === "pixelate") o.ref = { w: o.ref.w * sx, h: o.ref.h * sy };
        else if ("width" in o) o.width *= s;
    }
    return out;
}

export function bakeCrop(base: HTMLCanvasElement, objs: Obj[], crop: Rect) {
    const c = normRect(crop);
    const nb = document.createElement("canvas");
    nb.width = Math.round(c.w); nb.height = Math.round(c.h);
    nb.getContext("2d")!.drawImage(base, -c.x, -c.y);
    return { base: nb, objects: cropObjects(objs, crop) };
}

/** dir = +1 clockwise, -1 counter-clockwise. */
export function bakeRotate90(base: HTMLCanvasElement, objs: Obj[], dir: 1 | -1) {
    const W = base.width, H = base.height;
    const nb = document.createElement("canvas");
    nb.width = H; nb.height = W;
    const ctx = nb.getContext("2d")!;
    if (dir === 1) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    else { ctx.translate(0, W); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(base, 0, 0);
    return { base: nb, objects: rotateObjects(objs, W, H, dir) };
}

export function bakeFlip(base: HTMLCanvasElement, objs: Obj[], axis: "h" | "v") {
    const W = base.width, H = base.height;
    const nb = document.createElement("canvas");
    nb.width = W; nb.height = H;
    const ctx = nb.getContext("2d")!;
    if (axis === "h") { ctx.translate(W, 0); ctx.scale(-1, 1); } else { ctx.translate(0, H); ctx.scale(1, -1); }
    ctx.drawImage(base, 0, 0);
    return { base: nb, objects: flipObjects(objs, W, H, axis) };
}

export function bakeResize(base: HTMLCanvasElement, objs: Obj[], targetW: number, targetH: number) {
    const nb = document.createElement("canvas");
    nb.width = Math.round(targetW); nb.height = Math.round(targetH);
    const ctx = nb.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base, 0, 0, targetW, targetH);
    return { base: nb, objects: resizeObjects(objs, targetW / base.width, targetH / base.height) };
}
