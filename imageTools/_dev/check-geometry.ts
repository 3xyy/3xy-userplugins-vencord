/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { applyMatrix, clampPan, distToSegment, flipOrient, handlePoints, insertRect, insertRectInView, nearEllipse, normRect, Orient, orientMatrix, rectContains, resizeRect, resizeRectLocked, rotateOrient, zoomAt } from "../editor/geometry";

function assert(cond: boolean, msg: string) { if (!cond) throw new Error("FAIL: " + msg); }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// normRect flips negatives
const n = normRect({ x: 10, y: 10, w: -4, h: -6 });
assert(n.x === 6 && n.y === 4 && n.w === 4 && n.h === 6, "normRect");

// rectContains
assert(rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }), "contains inside");
assert(!rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 5 }), "contains outside");

// distToSegment
assert(Math.abs(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) - 5) < 1e-9, "dist perpendicular");
assert(distToSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }) === 0, "dist degenerate");

// nearEllipse: point on the right vertex of a circle r=5 centered (5,5)
assert(nearEllipse({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 5 }, 1), "nearEllipse on outline");
assert(!nearEllipse({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }, 1), "nearEllipse center is far from outline");

// handlePoints + resizeRect round-trip: drag SE corner out
const hp = handlePoints({ x: 0, y: 0, w: 10, h: 10 });
assert(hp.se.x === 10 && hp.se.y === 10, "handle se");
const rr = normRect(resizeRect({ x: 0, y: 0, w: 10, h: 10 }, "se", { x: 20, y: 30 }));
assert(rr.w === 20 && rr.h === 30, "resize se");

// zoomAt: the image point under the cursor stays under the cursor
{
    const v = { scale: 0.5, ox: 40, oy: 25 };
    const c = { x: 300, y: 180 };
    const before = { x: (c.x - v.ox) / v.scale, y: (c.y - v.oy) / v.scale };
    const z = zoomAt(v, c, 2);
    assert(near(z.scale, 1), "zoomAt doubles the scale");
    const after = { x: (c.x - z.ox) / z.scale, y: (c.y - z.oy) / z.scale };
    assert(near(before.x, after.x) && near(before.y, after.y), "zoomAt keeps the point under the cursor");
    // and the same when zooming out
    const o = zoomAt(v, c, 0.5);
    const afterOut = { x: (c.x - o.ox) / o.scale, y: (c.y - o.oy) / o.scale };
    assert(near(before.x, afterOut.x) && near(before.y, afterOut.y), "zoomAt out keeps the point under the cursor");
}

// zoomAt: scale is clamped to [0.1, 16] by default
assert(zoomAt({ scale: 10, ox: 0, oy: 0 }, { x: 5, y: 5 }, 4).scale === 16, "zoomAt clamps at 16");
assert(zoomAt({ scale: 16, ox: 0, oy: 0 }, { x: 5, y: 5 }, 2).scale === 16, "zoomAt stays at 16");
assert(zoomAt({ scale: 0.2, ox: 0, oy: 0 }, { x: 5, y: 5 }, 0.1).scale === 0.1, "zoomAt clamps at 0.1");
assert(zoomAt({ scale: 2, ox: 0, oy: 0 }, { x: 5, y: 5 }, 100, 0.5, 4).scale === 4, "zoomAt custom max");
assert(zoomAt({ scale: 2, ox: 0, oy: 0 }, { x: 5, y: 5 }, 0.01, 0.5, 4).scale === 0.5, "zoomAt custom min");

// zoomAt with factor 1 changes nothing (deep-equal, no float drift)
{
    const v = { scale: 0.37, ox: 12.3, oy: -7.9 };
    const z = zoomAt(v, { x: 0.1, y: 0.7 }, 1);
    assert(JSON.stringify(z) === JSON.stringify(v), "zoomAt factor 1 deep-equals the input");
    assert(z !== v, "zoomAt returns a new object");
}

// zoomAt: a fit below the minimum (huge image) doesn't jump to the minimum
{
    const fit = { scale: 0.05, ox: 10, oy: 10 };
    assert(zoomAt(fit, { x: 0, y: 0 }, 0.5).scale === 0.05, "zoom out below min stays put");
    assert(near(zoomAt(fit, { x: 0, y: 0 }, 1.2).scale, 0.06), "zoom in from below min works");
}

// clampPan: at least `margin` px of the image stays on screen
{
    // image 1000x500 at scale 1, view 800x600, margin 64
    const far = clampPan({ scale: 1, ox: 5000, oy: 5000 }, 1000, 500, 800, 600, 64);
    assert(far.ox === 800 - 64 && far.oy === 600 - 64, "clampPan right/bottom edge");
    const neg = clampPan({ scale: 1, ox: -5000, oy: -5000 }, 1000, 500, 800, 600, 64);
    assert(neg.ox === 64 - 1000 && neg.oy === 64 - 500, "clampPan left/top edge");
    const ok = clampPan({ scale: 1, ox: -100, oy: 50 }, 1000, 500, 800, 600, 64);
    assert(ok.ox === -100 && ok.oy === 50 && ok.scale === 1, "clampPan leaves a visible image alone");
    // an image smaller on screen than the margin must stay fully visible
    const tiny = clampPan({ scale: 0.01, ox: -50, oy: 900 }, 1000, 500, 800, 600, 64);
    assert(tiny.ox === 0 && tiny.oy === 600 - 5, "clampPan tiny image stays fully on screen");
}

// insertRect: a huge image is fitted inside the canvas, centred, aspect kept
{
    const r = insertRect(8000, 8000, 1920, 1080);
    assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080, "insertRect 8000x8000 fits inside the canvas");
    assert(near(r.w / r.h, 1), "insertRect keeps a 1:1 aspect");
    assert(near(r.w, 540) && near(r.h, 540), "insertRect fits 50% of the smaller side");
    assert(near(r.x + r.w / 2, 960) && near(r.y + r.h / 2, 540), "insertRect is centred");
    const s = insertRect(100, 50, 1920, 1080);
    assert(s.w === 100 && s.h === 50, "insertRect keeps a small image at natural size");
    assert(s.x === 910 && s.y === 515, "insertRect centres a small image");
    const w = insertRect(4000, 1000, 1920, 1080);
    assert(near(w.w, 540) && near(w.h, 135) && near(w.w / w.h, 4), "insertRect keeps a wide aspect");
    const z = insertRect(0, 0, 100, 100);
    assert(z.w > 0 && z.h > 0, "insertRect survives a zero-size image");
}

// resizeRectLocked: corner drags keep the aspect and the opposite corner
{
    const a = resizeRectLocked({ x: 10, y: 10, w: 200, h: 100 }, "se", { x: 410, y: 150 });
    assert(near(a.x, 10) && near(a.y, 10) && near(a.w, 400) && near(a.h, 200), "locked se keeps aspect, anchors nw");
    const b = resizeRectLocked({ x: 10, y: 10, w: 200, h: 100 }, "nw", { x: 110, y: -90 });
    assert(near(b.x + b.w, 210) && near(b.y + b.h, 110) && near(b.w / b.h, 2), "locked nw anchors se");
    const c = resizeRectLocked({ x: 0, y: 0, w: 200, h: 100 }, "e", { x: 300, y: 50 });
    assert(c.w === 300 && c.h === 100, "edge handles stay free");
}

// insertRectInView: centred on the visible part of the canvas, sized to it, always inside the canvas
{
    const full = insertRectInView(8000, 8000, 1920, 1080, { x: 0, y: 0, w: 1920, h: 1080 });
    const plain = insertRect(8000, 8000, 1920, 1080);
    assert(near(full.x, plain.x) && near(full.y, plain.y) && near(full.w, plain.w) && near(full.h, plain.h), "whole canvas visible: same as insertRect");
    // zoomed into the top-left quarter
    const q = insertRectInView(8000, 8000, 1920, 1080, { x: 0, y: 0, w: 480, h: 270 });
    assert(near(q.x + q.w / 2, 240) && near(q.y + q.h / 2, 135), "zoomed: centred on the visible area");
    assert(q.x >= 0 && q.y >= 0 && q.x + q.w <= 480 && q.y + q.h <= 270, "zoomed: fits inside the visible area");
    assert(near(q.w, 135) && near(q.h, 135), "zoomed: sized to half the visible area's smaller side");
    // panned so part of the view is off the image: only the visible part of the image counts
    const off = insertRectInView(100, 50, 1920, 1080, { x: -500, y: -500, w: 1000, h: 1000 });
    assert(near(off.x + off.w / 2, 250) && near(off.y + off.h / 2, 250), "view past the edge: centred on the visible part of the image");
    // a view that misses the image entirely falls back to the whole canvas
    const miss = insertRectInView(100, 50, 1920, 1080, { x: 5000, y: 5000, w: 100, h: 100 });
    assert(miss.x === 910 && miss.y === 515, "view off the image: centre of the canvas");
}

// orientMatrix: every orientation maps the image's corners onto the rect's corners
{
    const r = { x: 10, y: 20, w: 300, h: 120 }, iw = 50, ih = 20;
    const cornersOf = (pts: number[][]) => pts.map(([x, y]) => (Math.round(x * 1e6) / 1e6) + "," + (Math.round(y * 1e6) / 1e6)).sort().join(" ");
    const want = cornersOf([[10, 20], [310, 20], [10, 140], [310, 140]]);
    for (const rot of [0, 1, 2, 3] as const) for (const flip of [false, true]) {
        const m = orientMatrix({ rot, flip }, r, iw, ih);
        const got = cornersOf([[0, 0], [iw, 0], [0, ih], [iw, ih]].map(([x, y]) => applyMatrix(m, x, y)));
        assert(got === want, "orientMatrix fills the rect for rot " + rot + " flip " + flip);
    }
    // no rotation, no flip: top-left of the image is the top-left of the rect
    const [x0, y0] = applyMatrix(orientMatrix({ rot: 0, flip: false }, r, iw, ih), 0, 0);
    assert(near(x0, 10) && near(y0, 20), "orientMatrix identity keeps the top-left");
    // a quarter turn clockwise puts the image's top-left at the rect's top-right
    const [x1, y1] = applyMatrix(orientMatrix({ rot: 1, flip: false }, r, iw, ih), 0, 0);
    assert(near(x1, 310) && near(y1, 20), "orientMatrix rot 1 puts the top-left at the top-right");
    // a horizontal flip puts the image's top-right at the rect's top-left
    const [x2, y2] = applyMatrix(orientMatrix({ rot: 0, flip: true }, r, iw, ih), iw, 0);
    assert(near(x2, 10) && near(y2, 20), "orientMatrix flip mirrors left and right");
}

// rotateOrient / flipOrient: four quarter turns and two flips are no-ops
{
    const all: Orient[] = [];
    for (const rot of [0, 1, 2, 3] as const) for (const flip of [false, true]) all.push({ rot, flip });
    for (const o of all) {
        let t = o;
        for (let i = 0; i < 4; i++) t = rotateOrient(t, 1);
        assert(t.rot === o.rot && t.flip === o.flip, "four clockwise turns are a no-op");
        assert(rotateOrient(rotateOrient(o, 1), -1).rot === o.rot, "clockwise then counter-clockwise is a no-op");
        for (const axis of ["h", "v"] as const) {
            const f = flipOrient(flipOrient(o, axis), axis);
            assert(f.rot === o.rot && f.flip === o.flip, "two " + axis + " flips are a no-op");
        }
    }
}

console.log("OK");
