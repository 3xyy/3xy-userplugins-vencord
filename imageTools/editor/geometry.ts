/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Pt { x: number; y: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

/** Normalize a rect that may have negative width/height (mid-drag) to positive w/h. */
export function normRect(r: Rect): Rect {
    return {
        x: r.w < 0 ? r.x + r.w : r.x,
        y: r.h < 0 ? r.y + r.h : r.y,
        w: Math.abs(r.w),
        h: Math.abs(r.h),
    };
}

export function rectContains(r: Rect, p: Pt): boolean {
    const n = normRect(r);
    return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
}

/** Distance from point p to segment a-b. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Is p within `tol` px of the ellipse outline inscribed in rect r? */
export function nearEllipse(r: Rect, p: Pt, tol: number): boolean {
    const n = normRect(r);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const rx = n.w / 2, ry = n.h / 2;
    if (rx < 1 || ry < 1) return false;
    const v = ((p.x - cx) ** 2) / (rx * rx) + ((p.y - cy) ** 2) / (ry * ry);
    // band around the outline (v == 1)
    const band = tol / Math.min(rx, ry);
    return Math.abs(Math.sqrt(v) - 1) <= band;
}

/** 8 resize-handle anchor points for a rect, keyed nw,n,ne,e,se,s,sw,w. */
export type HandleKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export function handlePoints(r: Rect): Record<HandleKey, Pt> {
    const n = normRect(r);
    const { x, y, w, h } = n;
    return {
        nw: { x, y }, n: { x: x + w / 2, y }, ne: { x: x + w, y },
        e: { x: x + w, y: y + h / 2 }, se: { x: x + w, y: y + h },
        s: { x: x + w / 2, y: y + h }, sw: { x, y: y + h }, w: { x, y: y + h / 2 },
    };
}

/** Apply a handle drag to a rect: move the grabbed edge/corner to pt. Returns a new rect (may be denormalized). */
export function resizeRect(r: Rect, key: HandleKey, pt: Pt): Rect {
    const n = normRect(r);
    let { x, y, w, h } = n;
    const right = x + w, bottom = y + h;
    if (key.includes("w")) { x = pt.x; w = right - pt.x; }
    if (key.includes("e")) { w = pt.x - x; }
    if (key.includes("n")) { y = pt.y; h = bottom - pt.y; }
    if (key.includes("s")) { h = pt.y - y; }
    return { x, y, w, h };
}

/** Canvas view: image px * scale + offset = screen px (relative to the stage). */
export interface View { scale: number; ox: number; oy: number; }

/**
 * Zoom by `factor` around a screen point, keeping the image point under the cursor fixed.
 * The scale is clamped to [min, max]. A scale already outside that range (a huge image fitted
 * below `min`) is not pulled into it; it just can't move further out.
 */
export function zoomAt(view: View, cursor: Pt, factor: number, min = 0.1, max = 16): View {
    const lo = Math.min(min, view.scale), hi = Math.max(max, view.scale);
    const scale = Math.max(lo, Math.min(hi, view.scale * factor));
    if (scale === view.scale || !(view.scale > 0)) return { scale: view.scale, ox: view.ox, oy: view.oy };
    const k = scale / view.scale;
    return { scale, ox: cursor.x - (cursor.x - view.ox) * k, oy: cursor.y - (cursor.y - view.oy) * k };
}

/**
 * Clamp the view offset so at least `margin` screen px of the image stays inside a viewW x viewH
 * stage on each axis (all of it, when the image is smaller than that on screen).
 */
export function clampPan(view: View, imgW: number, imgH: number, viewW: number, viewH: number, margin = 64): View {
    const axis = (o: number, size: number, viewSize: number) => {
        const m = Math.min(margin, size);
        const lo = m - size, hi = viewSize - m;
        return lo > hi ? (viewSize - size) / 2 : Math.max(lo, Math.min(hi, o));
    };
    return {
        scale: view.scale,
        ox: axis(view.ox, imgW * view.scale, viewW),
        oy: axis(view.oy, imgH * view.scale, viewH),
    };
}

/**
 * Where a freshly inserted image of imgW x imgH goes on a canvasW x canvasH canvas: its natural size
 * if that fits in 50% of the canvas's smaller side, otherwise shrunk to fit that, aspect kept, centred.
 */
export function insertRect(imgW: number, imgH: number, canvasW: number, canvasH: number): Rect {
    const w0 = imgW > 0 ? imgW : 1, h0 = imgH > 0 ? imgH : 1;
    const cap = Math.max(1, Math.min(canvasW, canvasH) * 0.5);
    const k = Math.min(1, cap / w0, cap / h0);
    const w = w0 * k, h = h0 * k;
    return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

/**
 * Like resizeRect, but a corner handle keeps the rect's aspect ratio: the opposite corner stays put and
 * the rect grows to cover the pointer. Edge handles resize freely (so does a rect with no area).
 */
export function resizeRectLocked(r: Rect, key: HandleKey, pt: Pt): Rect {
    const n = normRect(r);
    if (key.length !== 2 || n.w < 1e-6 || n.h < 1e-6) return resizeRect(r, key, pt);
    const ax = key.includes("w") ? n.x + n.w : n.x;
    const ay = key.includes("n") ? n.y + n.h : n.y;
    const sx = key.includes("w") ? -1 : 1, sy = key.includes("n") ? -1 : 1;
    const k = Math.max(Math.abs(pt.x - ax) / n.w, Math.abs(pt.y - ay) / n.h, 0.01);
    const w = n.w * k, h = n.h * k;
    return { x: sx < 0 ? ax - w : ax, y: sy < 0 ? ay - h : ay, w, h };
}

/** insertRect, but sized to and centred on the visible part of the canvas (view, in image coordinates), so it lands on screen when zoomed in. */
export function insertRectInView(imgW: number, imgH: number, canvasW: number, canvasH: number, view: Rect): Rect {
    const v = normRect(view);
    const x0 = Math.max(0, v.x), y0 = Math.max(0, v.y);
    const x1 = Math.min(canvasW, v.x + v.w), y1 = Math.min(canvasH, v.y + v.h);
    // a view that shows none of the canvas (shouldn't happen) falls back to the whole canvas
    const vis = x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: canvasW, h: canvasH };
    const r = insertRect(imgW, imgH, vis.w, vis.h);
    const x = Math.max(0, Math.min(canvasW - r.w, vis.x + r.x));
    const y = Math.max(0, Math.min(canvasH - r.h, vis.y + r.y));
    return { x, y, w: r.w, h: r.h };
}

/** Quarter turns clockwise. */
export type Quarter = 0 | 1 | 2 | 3;
/** How an inserted image sits in its rect: mirrored left-right first (flip), then turned rot quarter turns clockwise. */
export interface Orient { rot: Quarter; flip: boolean; }
/** A 2D affine transform in canvas order: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** n as a quarter turn 0-3 (a missing value counts as 0). */
function quarter(n: number): Quarter {
    return ((((n | 0) % 4) + 4) % 4) as Quarter;
}

const COS: Record<Quarter, number> = { 0: 1, 1: 0, 2: -1, 3: 0 };
const SIN: Record<Quarter, number> = { 0: 0, 1: 1, 2: 0, 3: -1 };

/**
 * Maps the pixels of an iw x ih image into rect r (image coordinates) with orientation o: the oriented
 * image exactly fills r. The renderer applies this with ctx.transform and draws the image at 0,0.
 */
export function orientMatrix(o: Orient, rect: Rect, iw: number, ih: number): Matrix {
    const r = normRect(rect);
    const rot = quarter(o.rot);
    const odd = rot % 2 === 1;
    const dw = odd ? r.h : r.w, dh = odd ? r.w : r.h; // the image's size before the turn
    const cos = COS[rot], sin = SIN[rot], fs = o.flip ? -1 : 1;
    const sx = fs * dw / Math.max(1, iw), sy = dh / Math.max(1, ih);
    // image pixel (px, py) -> local x = fs * (px * dw / iw - dw / 2), y = py * dh / ih - dh / 2 -> turned -> centre of r
    const x0 = -fs * dw / 2, y0 = -dh / 2;
    return [cos * sx, sin * sx, -sin * sy, cos * sy, r.x + r.w / 2 + cos * x0 - sin * y0, r.y + r.h / 2 + sin * x0 + cos * y0];
}

/** The orientation after the whole canvas turns a quarter clockwise (dir 1) or counter-clockwise (dir -1). */
export function rotateOrient(o: Orient, dir: 1 | -1): Orient {
    return { rot: quarter(quarter(o.rot) + dir), flip: !!o.flip };
}

/**
 * The orientation after the whole canvas is mirrored. Mirroring reverses the turn direction, so a mirror
 * left-right gives (-rot, !flip), and a mirror top-bottom (a left-right mirror plus a half turn) gives (2 - rot, !flip).
 */
export function flipOrient(o: Orient, axis: "h" | "v"): Orient {
    const r = quarter(o.rot);
    return { rot: quarter(axis === "h" ? 4 - r : 6 - r), flip: !o.flip };
}
