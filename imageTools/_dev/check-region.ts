/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cloneObjects, Obj, paintBounds } from "../editor/model";
import {
    blockAverages, blurRadiusPx, blurWorkScale, INTENSITY_MAX, INTENSITY_MIN, legacyIntensity,
    MAX_WORK_SIGMA, pixelBlockPx, pixelRect, regionSources, sampleRect, sourcesKey
} from "../editor/region";

function assert(cond: boolean, msg: string) { if (!cond) throw new Error("FAIL: " + msg); }
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const inside = (r: { x: number; y: number; w: number; h: number; }, w: number, h: number) =>
    r.x >= 0 && r.y >= 0 && r.w >= 0 && r.h >= 0 && r.x + r.w <= w && r.y + r.h <= h;

assert(INTENSITY_MIN === 1 && INTENSITY_MAX === 100, "intensity range is 1-100");

// blurRadiusPx: strictly increasing over 1..100, so slider right is always stronger
for (const [w, h] of [[800, 600], [1920, 1080], [4000, 3000], [120, 90]]) {
    for (let t = 2; t <= 100; t++) {
        assert(blurRadiusPx(t, w, h) > blurRadiusPx(t - 1, w, h), `blurRadiusPx strictly increasing at ${t} (${w}x${h})`);
    }
    assert(blurRadiusPx(1, w, h) > 0, `blurRadiusPx(1) is positive (${w}x${h})`);
}

// it scales with the image's pixels (a bigger image gets a bigger radius) ...
assert(blurRadiusPx(50, 4000, 3000) > blurRadiusPx(50, 800, 600), "blur radius scales with image size");
// ... linearly above 1 MP: the same picture at twice the resolution gets twice the radius (no view scale involved)
assert(near(blurRadiusPx(50, 4000, 3000), 2 * blurRadiusPx(50, 2000, 1500), 1e-6), "blur radius is linear in image size above 1 MP");
// ... and below 1 MP it stops shrinking, so a small snip still gets a useful blur
assert(blurRadiusPx(50, 400, 300) === blurRadiusPx(50, 1000, 1000), "blur radius has a floor below 1 MP");
// out-of-range intensities clamp instead of running off the curve
assert(blurRadiusPx(0, 1920, 1080) === blurRadiusPx(1, 1920, 1080), "intensity below 1 clamps to 1");
assert(blurRadiusPx(150, 1920, 1080) === blurRadiusPx(100, 1920, 1080), "intensity above 100 clamps to 100");
// the default (50) is at least as strong as the old default (12 px) on a small snip and on a 1080p screenshot
assert(blurRadiusPx(50, 400, 300) >= 12, "default blur on a 400x300 snip is at least the old 12 px");
assert(blurRadiusPx(50, 1920, 1080) >= 12, "default blur on 1080p is at least the old 12 px");
// no NaN for an empty image
assert(Number.isFinite(blurRadiusPx(50, 0, 0)), "blurRadiusPx is finite for a 0x0 image");

// pixelBlockPx: whole pixels, at least 2, never shrinks as the slider goes right
for (const [w, h] of [[64, 64], [800, 600], [1920, 1080], [4000, 3000]]) {
    assert(pixelBlockPx(1, w, h) >= 2, `pixelBlockPx(1) >= 2 (${w}x${h})`);
    for (let t = 2; t <= 100; t++) {
        const b = pixelBlockPx(t, w, h);
        assert(Number.isInteger(b), `pixelBlockPx is an integer at ${t} (${w}x${h})`);
        assert(b >= pixelBlockPx(t - 1, w, h), `pixelBlockPx non-decreasing at ${t} (${w}x${h})`);
    }
}
assert(pixelBlockPx(1, 1, 1) >= 2, "pixelBlockPx(1) >= 2 on a 1x1 image");
assert(pixelBlockPx(100, 1920, 1080) > 4 * pixelBlockPx(1, 1920, 1080), "pixel size covers a real range on 1080p");
assert(pixelBlockPx(50, 4000, 3000) > pixelBlockPx(50, 800, 600), "pixel size scales with image size");
// the default (50) is at least as strong as the old default (12 px blocks)
assert(pixelBlockPx(50, 400, 300) >= 12, "default pixel size on a 400x300 snip is at least the old 12 px");
assert(pixelBlockPx(50, 1920, 1080) >= 12, "default pixel size on 1080p is at least the old 12 px");
// no dead zone: from 2 px at 1 to the top size at 100, never stuck on one size for more than 4 steps
// (whole-pixel blocks: 2..48 is 47 sizes over 100 steps, so some repeats can't be avoided)
for (const [w, h] of [[400, 300], [800, 600], [1920, 1080], [3840, 2160]]) {
    assert(pixelBlockPx(1, w, h) === 2, `pixel size starts at 2 px (${w}x${h})`);
    assert(pixelBlockPx(100, w, h) === Math.round(Math.max(1, Math.sqrt(w * h) / 1000) * 48), `pixel size tops out at the cap (${w}x${h})`);
    let run = 1, longest = 1;
    for (let t = 2; t <= 100; t++) {
        run = pixelBlockPx(t, w, h) === pixelBlockPx(t - 1, w, h) ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    assert(longest <= 4, `no dead zone in pixel size, longest flat run ${longest} (${w}x${h})`);
}

// sampleRect: padded by the radius, clamped to the image, so edges never sample outside
{
    const W = 1000, H = 800;
    // near the top-left corner
    const tl = sampleRect({ x: 5, y: 3, w: 40, h: 30 }, 25, W, H);
    assert(inside(tl, W, H), "sampleRect top-left stays inside the image");
    assert(tl.x === 0 && tl.y === 0, "sampleRect top-left clamps to 0");
    // near the bottom-right corner
    const br = sampleRect({ x: 980, y: 790, w: 20, h: 10 }, 40, W, H);
    assert(inside(br, W, H), "sampleRect bottom-right stays inside the image");
    assert(br.x + br.w === W && br.y + br.h === H, "sampleRect bottom-right clamps to the far edges");
    // a region hanging off the image (dragged past the edge) still clamps
    const off = sampleRect({ x: -50, y: 700, w: 100, h: 300 }, 10, W, H);
    assert(inside(off, W, H), "sampleRect of a region past the edge stays inside the image");
    // a mid-drag rect with negative size is normalized first
    const neg = sampleRect({ x: 60, y: 60, w: -40, h: -40 }, 5, W, H);
    assert(neg.x === 15 && neg.y === 15 && neg.w === 50 && neg.h === 50, "sampleRect normalizes negative sizes");
    // in the middle it pads by the full radius on every side (whole pixels)
    const mid = sampleRect({ x: 400, y: 300, w: 100, h: 50 }, 12, W, H);
    assert(mid.x === 388 && mid.y === 288 && mid.w === 124 && mid.h === 74, "sampleRect pads by the radius in the middle");
    // fractional rects and radii round outward to whole pixels
    const fr = sampleRect({ x: 10.6, y: 20.2, w: 50.7, h: 9.5 }, 2.5, W, H);
    assert(fr.x === 8 && fr.y === 17 && fr.x + fr.w === 64 && fr.y + fr.h === 33, "sampleRect rounds outward");
}

// pixelRect: the region snapped outward to whole pixels (no sharp sliver at the right/bottom edge)
{
    const r = pixelRect({ x: 10.6, y: 20.2, w: 50.7, h: 9.5 }, 1000, 800);
    assert(r.x === 10 && r.y === 20 && r.w === 52 && r.h === 10, "pixelRect snaps outward");
    const c = pixelRect({ x: -5, y: -5, w: 20, h: 2000 }, 1000, 800);
    assert(c.x === 0 && c.y === 0 && c.w === 15 && c.h === 800, "pixelRect clamps to the image");
    const gone = pixelRect({ x: 2000, y: 10, w: 20, h: 20 }, 1000, 800);
    assert(gone.w === 0, "pixelRect of a region fully outside is empty");
}

// blurWorkScale: big radii blur on a smaller copy so 4K images stay fast
assert(blurWorkScale(4) === 1 && blurWorkScale(MAX_WORK_SIGMA) === 1, "small radii blur at full resolution");
for (const s of [13, 40, 115, 480]) {
    const k = blurWorkScale(s);
    assert(k > 0 && k < 1 && near(s * k, MAX_WORK_SIGMA, 1e-9), `big radius ${s} is blurred at ${MAX_WORK_SIGMA} px on a smaller copy`);
}

// legacyIntensity: old pixel values land on the new scale near the same radius / block size
{
    const t = legacyIntensity("blur", 12, 1920, 1080);
    assert(Number.isInteger(t) && t >= 1 && t <= 100, "legacy blur maps into 1-100");
    assert(Math.abs(blurRadiusPx(t, 1920, 1080) - 12) / 12 < 0.05, "legacy blur 12 px keeps about the same radius");
    const p = legacyIntensity("pixelate", 12, 1920, 1080);
    assert(Math.abs(pixelBlockPx(p, 1920, 1080) - 12) <= 1, "legacy pixel 12 px keeps about the same block size");
    assert(legacyIntensity("blur", 2, 1920, 1080) < legacyIntensity("blur", 40, 1920, 1080), "legacy mapping keeps order");
    assert(legacyIntensity("blur", 0.001, 4000, 3000) === 1, "legacy mapping clamps at 1");
    assert(legacyIntensity("blur", 500, 100, 100) === 100, "legacy mapping clamps at 100");
    assert(legacyIntensity("pixelate", 1, 1920, 1080) === 1, "legacy pixel below 2 px clamps at 1");
}

// blockAverages: each block is the average of its pixels (alpha-weighted), partial edge blocks too
{
    // 3x2 image, block 2: block 0 = 2x2 pixels, block 1 = 1x2 pixels at the right edge
    const px = (r: number, g: number, b: number, a: number) => [r, g, b, a];
    const data = new Uint8ClampedArray([
        ...px(0, 0, 0, 255), ...px(200, 100, 0, 255), ...px(10, 20, 30, 255),
        ...px(100, 50, 0, 255), ...px(100, 50, 0, 255), ...px(30, 40, 50, 255),
    ]);
    const res = blockAverages(data, 3, 2, 2);
    assert(res.cols === 2 && res.rows === 1, "blockAverages grid size");
    const o = res.rgba;
    assert(o[0] === 100 && o[1] === 50 && o[2] === 0 && o[3] === 255, "block 0 averages its 4 pixels");
    assert(o[4] === 20 && o[5] === 30 && o[6] === 40 && o[7] === 255, "partial edge block averages its 2 pixels");

    // a fully transparent pixel adds no colour (no dark fringe), only lowers alpha
    const t = new Uint8ClampedArray([...px(255, 0, 0, 255), ...px(0, 0, 0, 0)]);
    const tr = blockAverages(t, 2, 1, 2).rgba;
    assert(tr[0] === 255 && tr[1] === 0 && tr[2] === 0 && Math.abs(tr[3] - 128) <= 1, "alpha-weighted average");

    // big blocks sample a sub-grid but stay exact on a flat colour, and every block gets a value
    const W = 101, H = 67, flat = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < flat.length; i += 4) { flat[i] = 12; flat[i + 1] = 34; flat[i + 2] = 56; flat[i + 3] = 255; }
    const big = blockAverages(flat, W, H, 50);
    assert(big.cols === 3 && big.rows === 2, "big block grid size");
    for (let i = 0; i < big.rgba.length; i += 4) {
        assert(big.rgba[i] === 12 && big.rgba[i + 1] === 34 && big.rgba[i + 2] === 56 && big.rgba[i + 3] === 255, "big blocks keep a flat colour, edge blocks included");
    }
}

// Regions read the base plus the objects below them (never other regions)
{
    class FakeImg { constructor(public width: number, public height: number) { } }
    const imgA = new FakeImg(10, 10) as unknown as ImageBitmap, imgB = new FakeImg(10, 10) as unknown as ImageBitmap;
    const ids = new Map<object, number>();
    const imgId = (img: object) => { if (!ids.has(img)) ids.set(img, ids.size + 1); return ids.get(img)!; };
    const objs: Obj[] = [
        { id: "s1", type: "brush", pts: [{ x: 100, y: 100 }, { x: 140, y: 120 }], color: 0xff0000, width: 6, opacity: 1 },
        { id: "far", type: "line", a: { x: 900, y: 900 }, b: { x: 950, y: 950 }, color: 0, width: 4 },
        { id: "img", type: "image", rect: { x: 90, y: 90, w: 60, h: 40 }, img: imgA, rot: 0, flip: false },
        { id: "r1", type: "blur", rect: { x: 80, y: 80, w: 100, h: 60 }, intensity: 50, ref: { w: 1000, h: 1000 } },
        { id: "t1", type: "text", pos: { x: 120, y: 95 }, text: "hi", color: 0, size: 20 },
        { id: "r2", type: "pixelate", rect: { x: 85, y: 85, w: 100, h: 60 }, intensity: 50, ref: { w: 1000, h: 1000 } },
        { id: "top", type: "arrow", a: { x: 100, y: 100 }, b: { x: 150, y: 130 }, color: 0, width: 4 },
    ];
    const area = { x: 60, y: 60, w: 160, h: 120 };
    const idList = (o: Obj[]) => o.map(x => x.id).join(",");
    assert(idList(regionSources(objs, 3, area)) === "s1,img", "r1 reads the objects below it that overlap its area, bottom to top");
    assert(idList(regionSources(objs, 5, area)) === "s1,img,t1", "r2 skips the region below it but reads the text between them");
    assert(!regionSources(objs, 5, area).some(o => o.id === "top"), "objects above a region are not read");
    assert(idList(regionSources(objs, objs.length, area)) === "s1,img,t1,top", "a new region on top (a draft) reads everything below it");

    // paintBounds is generous: stroke width, arrow heads, multi-line text
    const lb = paintBounds({ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, color: 0, width: 20 });
    assert(lb.y <= -10 && lb.y + lb.h >= 10, "paintBounds covers the line width");
    const tb = paintBounds({ id: "t", type: "text", pos: { x: 0, y: 0 }, text: "ab\ncd\nef", color: 0, size: 10 });
    assert(tb.y + tb.h >= 30, "paintBounds covers every line of a multi-line text");
    // "😀😀" is 4 UTF-16 units: at 1.5 em each that is 120 px wide at size 20
    const eb = paintBounds({ id: "e", type: "text", pos: { x: 0, y: 0 }, text: "😀😀", color: 0, size: 20 });
    assert(eb.x <= 0 && eb.x + eb.w >= 4 * 20 * 1.5, "paintBounds gives text 1.5 em per UTF-16 unit");

    // sourcesKey: same for an identical copy, different for any change that affects pixels
    const src = regionSources(objs, 5, area);
    const k0 = sourcesKey(src, imgId);
    assert(sourcesKey(cloneObjects(src), imgId) === k0, "a copy of the same objects gives the same key");
    const changed = (fn: (o: Obj[]) => void) => { const c = cloneObjects(src); fn(c); return sourcesKey(c, imgId) !== k0; };
    assert(changed(c => { (c[0] as any).pts[1].x += 0.5; }), "moving a stroke point changes the key");
    assert(changed(c => { (c[0] as any).color = 0x00ff00; }), "recolouring a stroke changes the key");
    assert(changed(c => { (c[2] as any).text = "ho"; }), "editing text changes the key");
    assert(changed(c => { (c[1] as any).rect.w += 1; }), "resizing an inserted image changes the key");
    assert(changed(c => { (c[1] as any).rot = 1; }), "rotating an inserted image changes the key");
    assert(changed(c => { (c[1] as any).img = imgB; }), "a different bitmap changes the key");
    assert(changed(c => { c.pop(); }), "removing an object changes the key");
    assert(sourcesKey([], imgId) !== k0, "no sources gives a different key");
    // with a per-pass memo the key is the same, and each object is hashed once
    const memo = new Map<Obj, string>();
    assert(sourcesKey(src, imgId, memo) === k0 && memo.size === src.length, "a memo gives the same key and holds one hash per object");
    assert(sourcesKey(src.slice(1), imgId, memo) === sourcesKey(src.slice(1), imgId), "a memo reused for a subset gives the same key");
}

console.log("OK");
