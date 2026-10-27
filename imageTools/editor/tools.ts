/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Pt, Rect } from "./geometry";
import { ImgSize, newId, Obj, Style, ToolId } from "./model";

export interface Tool {
    cursor: string;
    /** Create a draft object at the pointer-down point. img is the current image size. */
    create(pt: Pt, s: Style, img: ImgSize): Obj;
    /** Update the draft as the pointer drags to pt. Mutates the draft. */
    update(draft: Obj, pt: Pt): void;
    /** Return false to discard (e.g. zero-size). */
    commit(draft: Obj): boolean;
}

const rectFrom = (a: Pt, b: Pt): Rect => ({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });

export const TOOLS: Partial<Record<ToolId, Tool>> = {
    brush: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "brush", pts: [pt], color: s.color, width: s.width, opacity: 1 }),
        update: (d, pt) => { (d as any).pts.push(pt); },
        commit: d => (d as any).pts.length > 1,
    },
    highlight: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "highlight", pts: [pt], color: s.color, width: s.width * 3, opacity: 0.4 }),
        update: (d, pt) => { (d as any).pts.push(pt); },
        commit: d => (d as any).pts.length > 1,
    },
    line: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "line", a: pt, b: pt, color: s.color, width: s.width }),
        update: (d, pt) => { (d as any).b = pt; },
        commit: d => { const o = d as any; return Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) > 3; },
    },
    arrow: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "arrow", a: pt, b: pt, color: s.color, width: s.width }),
        update: (d, pt) => { (d as any).b = pt; },
        commit: d => { const o = d as any; return Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) > 3; },
    },
    rect: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "rect", rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, color: s.color, width: s.width, fill: s.fill }),
        update: (d, pt) => { const o = d as any; o.rect = rectFrom({ x: o.rect.x, y: o.rect.y }, pt); },
        commit: d => Math.abs((d as any).rect.w) > 3 && Math.abs((d as any).rect.h) > 3,
    },
    ellipse: {
        cursor: "crosshair",
        create: (pt, s) => ({ id: newId(), type: "ellipse", rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, color: s.color, width: s.width, fill: s.fill }),
        update: (d, pt) => { const o = d as any; o.rect = rectFrom({ x: o.rect.x, y: o.rect.y }, pt); },
        commit: d => Math.abs((d as any).rect.w) > 3 && Math.abs((d as any).rect.h) > 3,
    },
    blur: {
        cursor: "crosshair",
        create: (pt, s, img) => ({ id: newId(), type: "blur", rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, intensity: s.blurIntensity, ref: { w: img.w, h: img.h } }),
        update: (d, pt) => { const o = d as any; o.rect = rectFrom({ x: o.rect.x, y: o.rect.y }, pt); },
        commit: d => Math.abs((d as any).rect.w) > 5 && Math.abs((d as any).rect.h) > 5,
    },
    pixelate: {
        cursor: "crosshair",
        create: (pt, s, img) => ({ id: newId(), type: "pixelate", rect: { x: pt.x, y: pt.y, w: 0, h: 0 }, intensity: s.pixelIntensity, ref: { w: img.w, h: img.h } }),
        update: (d, pt) => { const o = d as any; o.rect = rectFrom({ x: o.rect.x, y: o.rect.y }, pt); },
        commit: d => Math.abs((d as any).rect.w) > 5 && Math.abs((d as any).rect.h) > 5,
    },
};
