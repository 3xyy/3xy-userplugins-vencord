/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The object half of the whole-canvas transforms (no canvas needed). An inserted image must turn and
// mirror with the picture: every pixel of it has to land where the canvas transform sends it.

import { applyMatrix, orientMatrix } from "../editor/geometry";
import { ImageObj, Obj } from "../editor/model";
import { cropObjects, flipObjects, flipPointMap, resizeObjects, rotateObjects, rotatePointMap } from "../editor/transforms";

function assert(cond: boolean, msg: string) { if (!cond) throw new Error("FAIL: " + msg); }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

class FakeImg { constructor(public width: number, public height: number) { } }
const img = new FakeImg(40, 10) as unknown as ImageBitmap;
const W = 800, H = 500;
const samples: [number, number][] = [[0, 0], [40, 0], [0, 10], [40, 10], [13, 7]];

function imageAt(rot: 0 | 1 | 2 | 3, flip: boolean): ImageObj {
    return { id: "i", type: "image", rect: { x: 100, y: 60, w: rot % 2 ? 50 : 200, h: rot % 2 ? 200 : 50 }, img, rot, flip };
}

/** Each sample pixel of the image, after the transform, sits where the canvas map sends its old position. */
function followsCanvas(before: ImageObj, after: ImageObj, map: (x: number, y: number) => { x: number; y: number; }, what: string) {
    const m0 = orientMatrix(before, before.rect, 40, 10), m1 = orientMatrix(after, after.rect, 40, 10);
    for (const [sx, sy] of samples) {
        const [x0, y0] = applyMatrix(m0, sx, sy);
        const want = map(x0, y0);
        const [x1, y1] = applyMatrix(m1, sx, sy);
        assert(near(x1, want.x) && near(y1, want.y), `${what}: image pixel ${sx},${sy} follows the canvas`);
    }
}

for (const rot of [0, 1, 2, 3] as const) for (const flip of [false, true]) {
    const o = imageAt(rot, flip);
    const tag = `rot ${rot} flip ${flip}`;
    for (const dir of [1, -1] as const) {
        const [r] = rotateObjects([o], W, H, dir) as ImageObj[];
        followsCanvas(o, r, rotatePointMap(W, H, dir), `rotate ${dir} (${tag})`);
    }
    for (const axis of ["h", "v"] as const) {
        const [f] = flipObjects([o], W, H, axis) as ImageObj[];
        followsCanvas(o, f, flipPointMap(W, H, axis), `flip ${axis} (${tag})`);
    }
    // four quarter turns bring the image back exactly
    let objs: Obj[] = [o];
    let w = W, h = H;
    for (let i = 0; i < 4; i++) { objs = rotateObjects(objs, w, h, 1); [w, h] = [h, w]; }
    const back = objs[0] as ImageObj;
    assert(back.rot === o.rot && back.flip === o.flip && near(back.rect.x, o.rect.x) && near(back.rect.y, o.rect.y)
        && near(back.rect.w, o.rect.w) && near(back.rect.h, o.rect.h), `four turns are a no-op (${tag})`);
}

// crop and resize move and scale the image but never turn it; the input is never mutated
{
    const o = imageAt(1, true);
    const [c] = cropObjects([o], { x: 50, y: 20, w: 400, h: 300 }) as ImageObj[];
    assert(c.rot === 1 && c.flip && near(c.rect.x, 50) && near(c.rect.y, 40), "crop shifts the image, keeps its orientation");
    const [s] = resizeObjects([o], 0.5, 0.5) as ImageObj[];
    assert(s.rot === 1 && s.flip && near(s.rect.w, 25) && near(s.rect.h, 100), "resize scales the image, keeps its orientation");
    assert(o.rect.x === 100 && o.rot === 1, "the input objects are not mutated");
}

// regions: a quarter turn swaps the size basis; a resize scales it; a crop keeps it
{
    const r: Obj = { id: "r", type: "blur", rect: { x: 10, y: 10, w: 50, h: 30 }, intensity: 50, ref: { w: 800, h: 500 } };
    const [t] = rotateObjects([r], W, H, 1);
    assert(t.type === "blur" && t.ref.w === 500 && t.ref.h === 800, "rotate swaps a region's size basis");
    const [s] = resizeObjects([r], 2, 2);
    assert(s.type === "blur" && s.ref.w === 1600 && s.ref.h === 1000, "resize scales a region's size basis");
    const [c] = cropObjects([r], { x: 5, y: 5, w: 100, h: 100 });
    assert(c.type === "blur" && c.ref.w === 800 && c.ref.h === 500, "crop keeps a region's size basis");
}

console.log("OK");
