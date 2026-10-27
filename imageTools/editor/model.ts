/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { distToSegment, HandleKey, handlePoints, nearEllipse, normRect, Orient, Pt, Rect, rectContains } from "./geometry";

export type ToolId =
    | "select" | "crop" | "brush" | "highlight" | "line" | "arrow"
    | "rect" | "ellipse" | "text" | "blur" | "pixelate" | "insert" | "eraser";

interface ObjBase { id: string; }

export interface StrokeObj extends ObjBase { type: "brush" | "highlight"; pts: Pt[]; color: number; width: number; opacity: number; }
export interface SegmentObj extends ObjBase { type: "line" | "arrow"; a: Pt; b: Pt; color: number; width: number; }
export interface ShapeObj extends ObjBase { type: "rect" | "ellipse"; rect: Rect; color: number; width: number; fill: boolean; }
export interface TextObj extends ObjBase { type: "text"; pos: Pt; text: string; color: number; size: number; }
/** Pixel size of an image. */
export interface ImgSize { w: number; h: number; }
export interface RegionObj extends ObjBase {
    type: "blur" | "pixelate";
    rect: Rect;
    /** 1-100, slider right is stronger. editor/region.ts turns it into image pixels. */
    intensity: number;
    /**
     * Image size the intensity is measured against: the image the region was drawn on. A resize scales
     * it with the image and a rotate swaps it. A crop keeps it, so the region keeps its blur radius or
     * block size. Its pixels can still shift a little after a crop: the pixelate grid follows the image's
     * top-left corner, and a blur next to the new edge repeats the edge pixels instead of reading the
     * cropped-away ones.
     */
    ref: ImgSize;
}
/**
 * An inserted image. img is in memory only (not serialized). rot/flip (Orient) turn and mirror it inside
 * its rect, so a whole-canvas rotate or flip turns the inserted image with the picture.
 */
export interface ImageObj extends ObjBase, Orient { type: "image"; rect: Rect; img: ImageBitmap | HTMLCanvasElement; }

export type Obj = StrokeObj | SegmentObj | ShapeObj | TextObj | RegionObj | ImageObj;

export interface Doc {
    base: HTMLCanvasElement; // current photo pixels, native res, upright + cropped
    objects: Obj[]; // z-order; [0] is bottom
    selectedId: string | null;
}

/** Current tool style (the OptionsStrip mutates this). */
export interface Style {
    color: number;
    width: number;
    fill: boolean;
    fontSize: number;
    blurIntensity: number;
    pixelIntensity: number;
}

let _idc = 0;
export function newId(): string { return "o" + (_idc++); }

/** Shallow-structural clone of the object array for history. `base` and `ImageObj.img` are shared by reference. */
export function cloneObjects(objs: Obj[]): Obj[] {
    return objs.map(o => {
        switch (o.type) {
            case "brush": case "highlight": return { ...o, pts: o.pts.map(p => ({ ...p })) };
            case "line": case "arrow": return { ...o, a: { ...o.a }, b: { ...o.b } };
            case "rect": case "ellipse": return { ...o, rect: { ...o.rect } };
            case "text": return { ...o, pos: { ...o.pos } };
            case "blur": case "pixelate": return { ...o, rect: { ...o.rect }, ref: { ...o.ref } };
            case "image": return { ...o, rect: { ...o.rect } }; // img shared by ref
        }
    });
}

/** Bounding rect of an object in image space (for selection + handles). */
export function objectBounds(o: Obj): Rect {
    switch (o.type) {
        case "brush": case "highlight": {
            const xs = o.pts.map(p => p.x), ys = o.pts.map(p => p.y);
            const x = Math.min(...xs), y = Math.min(...ys);
            return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
        }
        case "line": case "arrow": {
            const x = Math.min(o.a.x, o.b.x), y = Math.min(o.a.y, o.b.y);
            return { x, y, w: Math.abs(o.b.x - o.a.x), h: Math.abs(o.b.y - o.a.y) };
        }
        case "rect": case "ellipse": case "blur": case "pixelate": case "image":
            return normRect(o.rect);
        case "text":
            return { x: o.pos.x, y: o.pos.y, w: Math.max(40, o.text.length * o.size * 0.55), h: o.size * 1.3 };
    }
}

/** A rect grown by d on every side (after normalising). */
function grow(r: Rect, d: number): Rect {
    const n = normRect(r);
    return { x: n.x - d, y: n.y - d, w: n.w + 2 * d, h: n.h + 2 * d };
}

/**
 * Everything an object can paint, in image space, on the generous side: stroke widths, arrow heads,
 * every line of a text (1.5 em per UTF-16 unit, wide enough for emoji and wide glyphs). Used to find the
 * objects a blur/pixelate region reads; too big only costs a needless re-render, too small would drop an
 * object from a region's source.
 */
export function paintBounds(o: Obj): Rect {
    switch (o.type) {
        case "brush": case "highlight":
            return grow(objectBounds(o), o.width / 2 + 2);
        case "line":
            return grow(objectBounds(o), o.width / 2 + 2);
        case "arrow":
            return grow(objectBounds(o), Math.max(o.width / 2, Math.max(10, o.width * 3)) + 2);
        case "rect": case "ellipse":
            return grow(o.rect, o.width / 2 + 2);
        case "text": {
            const lines = o.text.split("\n");
            const longest = Math.max(1, ...lines.map(l => l.length));
            return grow({ x: o.pos.x, y: o.pos.y, w: longest * o.size * 1.5, h: lines.length * o.size * 1.2 }, o.size * 0.5 + 2);
        }
        case "blur": case "pixelate": case "image":
            return grow(o.rect, 1);
    }
}

/** True if pt (image space) hits the object, with tolerance tol px. */
export function hitObject(o: Obj, pt: Pt, tol: number): boolean {
    switch (o.type) {
        case "brush": case "highlight":
            return o.pts.some((p, i) => i && distToSegment(pt, o.pts[i - 1], p) <= tol + o.width / 2);
        case "line": case "arrow":
            return distToSegment(pt, o.a, o.b) <= tol + o.width / 2;
        case "ellipse":
            return o.fill ? rectContains(o.rect, pt) : nearEllipse(o.rect, pt, tol + o.width);
        case "rect":
            if (o.fill) return rectContains(o.rect, pt);
            { const n = normRect(o.rect); const inner = rectContains({ x: n.x + o.width / 2, y: n.y + o.width / 2, w: n.w - 2 * (o.width / 2), h: n.h - 2 * (o.width / 2) }, pt); return rectContains(o.rect, pt) && !inner; }
        case "blur": case "pixelate": case "image": case "text":
            return rectContains(objectBounds(o), pt);
    }
}

/** Which handle (if any) of the selected object's bounds is within tol of pt. */
export function hitHandle(o: Obj, pt: Pt, tol: number): HandleKey | null {
    const pts = handlePoints(objectBounds(o));
    for (const k of Object.keys(pts) as HandleKey[]) {
        if (Math.hypot(pts[k].x - pt.x, pts[k].y - pt.y) <= tol) return k;
    }
    return null;
}
