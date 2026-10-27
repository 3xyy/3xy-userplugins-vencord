/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useRef, useState } from "@webpack/common";

import { clampPan, HandleKey, handlePoints, normRect, Pt, Rect, rectContains, resizeRect, resizeRectLocked, View, zoomAt } from "./geometry";
import { Doc, hitHandle, hitObject, Obj, objectBounds, Style, ToolId } from "./model";
import { drawDoc, drawObject } from "./render";
import { TOOLS } from "./tools";

/** View controls the editor's keyboard handler and the size bar call into. */
export interface StageApi {
    /** Fit the image to the stage, and fit again on window resize. */
    fit(): void;
    /** Zoom around the middle of the stage. */
    zoomBy(factor: number): void;
    /** Space pressed or released. Returns true when the key belongs to panning (so the caller swallows it). */
    setSpace(down: boolean): boolean;
    /** The part of the image on screen right now, in image coordinates (null before the first layout). */
    visibleRect(): Rect | null;
}

interface Props {
    doc: Doc;
    tool: ToolId;
    style: Style;
    onCommit(obj: Obj): void; // a new object was drawn
    onMutate(): void; // selected object moved/resized in place
    onSelect(id: string | null): void;
    onTextRequest(pt: Pt): void; // text tool clicked at pt
    onErase(id: string): void; // eraser tool clicked an object
    pushHistory(): void;
    cropRect: Rect | null;
    setCropRect(r: Rect | null): void;
    apiRef?: { current: StageApi | null; };
    onZoomChange?(scale: number): void;
}

const HANDLE_TOL = 8;
const HIT_TOL = 6;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 16;
/** Screen px of the image that always stays on the stage while panning or zooming. */
const PAN_MARGIN = 64;
/** Zoom per keyboard step (Ctrl+= / Ctrl+-). */
export const ZOOM_KEY_STEP = 1.2;

/** Zoom factor for one Ctrl+wheel event: a mouse notch is one ~1.16x step, trackpad/pinch deltas zoom smoothly. */
function wheelFactor(e: WheelEvent, pageH: number): number {
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * pageH : e.deltaY;
    const step = Math.abs(dy) >= 40 ? Math.sign(dy) * 0.15 : Math.max(-0.15, Math.min(0.15, dy * 0.01));
    return Math.exp(-step);
}

export function CanvasStage(props: Props) {
    const { doc, tool, style } = props;
    // always hold the latest style so a draft uses the current slider/color even if the closure is stale
    const styleRef = useRef(style);
    styleRef.current = style;
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const view = useRef<View>({ scale: 1, ox: 0, oy: 0 });
    const drag = useRef<null | { kind: "draw"; draft: Obj; } | { kind: "move"; id: string; last: Pt; committed?: boolean; } | { kind: "resize"; id: string; key: HandleKey; committed?: boolean; } | { kind: "crop-resize"; key: HandleKey; } | { kind: "crop-move"; last: Pt; }>(null);
    // Zoomed or panned by hand: window resizes stop re-fitting until Ctrl+0 (or a new base: crop, rotate, ...).
    const userView = useRef(false);
    const fittedBase = useRef<HTMLCanvasElement | null>(null);
    const pan = useRef<null | { x: number; y: number; ox: number; oy: number; }>(null);
    const hover = useRef(false);
    const spaceHeld = useRef(false);
    const [panCursor, setPanCursor] = useState<"" | "grab" | "grabbing">("");
    const frame = useRef(0);
    // Listeners attached once (wheel, resize, the api) call through this to reach the current render's closures.
    const live = useRef({ render, onResize, onWheel, fitByHand, zoomCenter, setSpace, visibleRect });
    live.current = { render, onResize, onWheel, fitByHand, zoomCenter, setSpace, visibleRect };

    /** Fit the whole image in the stage (never upscaling past 100%). */
    function fit() {
        const wrap = wrapRef.current;
        if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
        const bw = doc.base.width, bh = doc.base.height;
        const scale = Math.min(wrap.clientWidth / bw, wrap.clientHeight / bh, 1);
        view.current = { scale, ox: (wrap.clientWidth - bw * scale) / 2, oy: (wrap.clientHeight - bh * scale) / 2 };
    }

    /** Set the view, keeping at least PAN_MARGIN px of the image on the stage. */
    function setView(v: View) {
        const wrap = wrapRef.current;
        view.current = wrap ? clampPan(v, doc.base.width, doc.base.height, wrap.clientWidth, wrap.clientHeight, PAN_MARGIN) : v;
    }

    /** Coalesce zoom/pan redraws to one per frame (a 4K image with blur regions is not free to draw). */
    function scheduleRender() {
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => { frame.current = 0; live.current.render(); });
    }

    function zoomTo(factor: number, cursor: Pt) {
        const before = view.current;
        if (!(before.scale > 0)) return;
        userView.current = true;
        setView(zoomAt(before, cursor, factor, ZOOM_MIN, ZOOM_MAX));
        // zooming mid-pan: shift the pan's start offset too, so the next move doesn't jump back
        const p = pan.current;
        if (p) { p.ox += view.current.ox - before.ox; p.oy += view.current.oy - before.oy; }
        scheduleRender();
    }

    function zoomCenter(factor: number) {
        const wrap = wrapRef.current;
        if (wrap) zoomTo(factor, { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 });
    }

    function fitByHand() {
        userView.current = false;
        fit();
        scheduleRender();
    }

    function onResize() {
        if (userView.current) setView(view.current);
        else fit();
        render();
    }

    function onWheel(e: WheelEvent) {
        // Only Ctrl+wheel zooms (a trackpad pinch arrives as Ctrl+wheel too); a plain wheel is left alone.
        if (!e.ctrlKey) return;
        e.preventDefault();
        const rect = canvasRef.current!.getBoundingClientRect();
        zoomTo(wheelFactor(e, rect.height), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }

    function setSpace(down: boolean): boolean {
        if (down) {
            // Space only pans while the pointer is over the image, so it still works on focused buttons elsewhere.
            if (!spaceHeld.current && !hover.current) return false;
            if (!spaceHeld.current) { spaceHeld.current = true; if (!pan.current) setPanCursor("grab"); }
            return true;
        }
        const was = spaceHeld.current;
        spaceHeld.current = false;
        if (was && !pan.current) setPanCursor("");
        return was;
    }

    function visibleRect(): Rect | null {
        const wrap = wrapRef.current;
        const { scale, ox, oy } = view.current;
        if (!wrap || !wrap.clientWidth || !wrap.clientHeight || !(scale > 0)) return null;
        return { x: -ox / scale, y: -oy / scale, w: wrap.clientWidth / scale, h: wrap.clientHeight / scale };
    }

    function toImage(e: React.PointerEvent): Pt {
        const rect = canvasRef.current!.getBoundingClientRect();
        const { scale, ox, oy } = view.current;
        const x = Math.max(0, Math.min(doc.base.width, (e.clientX - rect.left - ox) / scale));
        const y = Math.max(0, Math.min(doc.base.height, (e.clientY - rect.top - oy) / scale));
        return { x, y };
    }

    function render() {
        const canvas = canvasRef.current!;
        const wrap = wrapRef.current!;
        const dpr = window.devicePixelRatio || 1;
        // only reallocate the backing store when the size changes (not on every pan/zoom frame)
        const pw = Math.floor(wrap.clientWidth * dpr), ph = Math.floor(wrap.clientHeight * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
            canvas.style.width = wrap.clientWidth + "px";
            canvas.style.height = wrap.clientHeight + "px";
        }
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
        const { scale, ox, oy } = view.current;
        ctx.save();
        ctx.translate(ox, oy); ctx.scale(scale, scale);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, doc.base.width, doc.base.height); ctx.clip();
        drawDoc(ctx, doc);
        const d = drag.current;
        if (d && d.kind === "draw") drawObject(ctx, d.draft, doc.base, doc.objects); // a new region reads everything below it
        ctx.restore();
        ctx.restore();
        // selection overlay in screen space
        if (doc.selectedId) {
            const sel = doc.objects.find(o => o.id === doc.selectedId);
            if (sel) drawSelectionOverlay(ctx, objectBounds(sel), view.current);
        }
        // crop overlay with draggable handles
        if (tool === "crop" && props.cropRect) {
            drawCropOverlay(ctx, normRect(props.cropRect), view.current, wrap.clientWidth, wrap.clientHeight);
        }
        // the size bar's zoom readout (React skips the update when the scale is unchanged)
        props.onZoomChange?.(view.current.scale);
    }

    useEffect(() => {
        // A new base (crop, rotate, resize, reset, or undoing one) has new dimensions: fit it again.
        if (fittedBase.current !== doc.base) { fittedBase.current = doc.base; userView.current = false; }
        if (!userView.current) fit();
        render();
        // re-render whenever doc identity or tool/style change
    }, [doc, doc.objects, doc.selectedId, tool, style, props.cropRect]);

    useEffect(() => {
        const wrap = wrapRef.current!;
        const ro = new ResizeObserver(() => live.current.onResize());
        ro.observe(wrap);
        // native listener: React's onWheel is passive, so it couldn't stop Ctrl+wheel from scrolling/zooming the page
        const wheel = (e: WheelEvent) => live.current.onWheel(e);
        wrap.addEventListener("wheel", wheel, { passive: false });
        const { apiRef } = props;
        if (apiRef) apiRef.current = {
            fit: () => live.current.fitByHand(),
            zoomBy: f => live.current.zoomCenter(f),
            setSpace: down => live.current.setSpace(down),
            visibleRect: () => live.current.visibleRect(),
        };
        return () => {
            ro.disconnect();
            wrap.removeEventListener("wheel", wheel);
            cancelAnimationFrame(frame.current);
            frame.current = 0;
            if (apiRef) apiRef.current = null;
        };
    }, []);

    function onDown(e: React.PointerEvent) {
        canvasRef.current!.setPointerCapture(e.pointerId);
        // middle-drag, or Space + left-drag, pans the view
        if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
            pan.current = { x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy };
            setPanCursor("grabbing");
            return;
        }
        const pt = toImage(e);
        if (tool === "crop") {
            const cr = props.cropRect;
            if (cr) {
                const n = normRect(cr);
                const hk = hitRectHandle(n, pt, HANDLE_TOL / view.current.scale);
                if (hk) { drag.current = { kind: "crop-resize", key: hk }; return; }
                if (rectContains(n, pt)) { drag.current = { kind: "crop-move", last: pt }; return; }
            }
            return;
        }
        if (tool === "select") {
            const sel = doc.objects.find(o => o.id === doc.selectedId);
            if (sel) {
                const hk = hitHandle(sel, pt, HANDLE_TOL / view.current.scale);
                if (hk) { drag.current = { kind: "resize", id: sel.id, key: hk }; return; }
            }
            // topmost hit
            const hit = [...doc.objects].reverse().find(o => hitObject(o, pt, HIT_TOL / view.current.scale));
            props.onSelect(hit ? hit.id : null);
            if (hit) { drag.current = { kind: "move", id: hit.id, last: pt }; }
            return;
        }
        if (tool === "text") { props.onTextRequest(pt); return; }
        if (tool === "eraser") {
            const hit = [...doc.objects].reverse().find(o => hitObject(o, pt, HIT_TOL / view.current.scale));
            if (hit) { props.onErase(hit.id); }
            return;
        }
        const t = TOOLS[tool];
        if (!t) return;
        drag.current = { kind: "draw", draft: t.create(pt, styleRef.current, { w: doc.base.width, h: doc.base.height }) };
        render();
    }

    function onMove(e: React.PointerEvent) {
        const p = pan.current;
        if (p) {
            const ox = p.ox + e.clientX - p.x, oy = p.oy + e.clientY - p.y;
            if (ox === view.current.ox && oy === view.current.oy) return;
            userView.current = true;
            setView({ scale: view.current.scale, ox, oy });
            scheduleRender();
            return;
        }
        const d = drag.current; if (!d) return;
        const pt = toImage(e);
        if (d.kind === "crop-resize") {
            const cur = props.cropRect; if (!cur) return;
            const next = normRect(resizeRect(normRect(cur), d.key, clampPt(pt, doc.base)));
            props.setCropRect(clampRectToImage(next, doc.base));
            return;
        }
        if (d.kind === "crop-move") {
            const cur = props.cropRect; if (!cur) return;
            const n = normRect(cur);
            const moved = { x: n.x + (pt.x - d.last.x), y: n.y + (pt.y - d.last.y), w: n.w, h: n.h };
            d.last = pt;
            props.setCropRect(clampRectToImage(moved, doc.base));
            return;
        }
        if (d.kind === "draw") { TOOLS[tool]!.update(d.draft, pt); render(); return; }
        const obj = doc.objects.find(o => o.id === d.id); if (!obj) return;
        if (d.kind === "move") { if (!d.committed) { props.pushHistory(); d.committed = true; } translateObject(obj, pt.x - d.last.x, pt.y - d.last.y); d.last = pt; props.onMutate(); }
        else if (d.kind === "resize") { if (!d.committed) { props.pushHistory(); d.committed = true; } resizeObject(obj, d.key, pt, e.shiftKey); props.onMutate(); }
        render();
    }

    function onUp() {
        if (pan.current) {
            pan.current = null;
            setPanCursor(spaceHeld.current ? "grab" : "");
            return;
        }
        const d = drag.current; drag.current = null;
        if (d && (d.kind === "crop-resize" || d.kind === "crop-move")) {
            render();
            return;
        }
        if (d && d.kind === "draw") {
            if (TOOLS[tool]!.commit(d.draft)) props.onCommit(d.draft);
            else render();
        }
    }

    return (
        <div className="vc-it-stage" ref={wrapRef}>
            <canvas
                ref={canvasRef}
                style={{ cursor: panCursor || (tool === "select" ? "default" : (TOOLS[tool]?.cursor ?? "crosshair")) }}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                // no middle-click autoscroll; a middle-drag pans instead
                onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
                onPointerEnter={() => { hover.current = true; }}
                onPointerLeave={() => { hover.current = false; }}
            />
        </div>
    );
}

function drawCropOverlay(ctx: CanvasRenderingContext2D, cr: Rect, v: { scale: number; ox: number; oy: number; }, canvasW: number, canvasH: number) {
    const sx = cr.x * v.scale + v.ox, sy = cr.y * v.scale + v.oy;
    const sw = cr.w * v.scale, sh = cr.h * v.scale;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    // top strip
    ctx.fillRect(0, 0, canvasW, sy);
    // bottom strip
    ctx.fillRect(0, sy + sh, canvasW, canvasH - (sy + sh));
    // left strip (between top/bottom)
    ctx.fillRect(0, sy, sx, sh);
    // right strip (between top/bottom)
    ctx.fillRect(sx + sw, sy, canvasW - (sx + sw), sh);
    // bright border around crop rect
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(sx, sy, sw, sh);
    // rule-of-thirds guides
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
        const gx = sx + (sw * i) / 3, gy = sy + (sh * i) / 3;
        ctx.beginPath(); ctx.moveTo(gx, sy); ctx.lineTo(gx, sy + sh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx, gy); ctx.lineTo(sx + sw, gy); ctx.stroke();
    }
    // 8 draggable handles
    ctx.fillStyle = "#ffffff";
    const pts = handlePoints(cr);
    for (const k of Object.keys(pts) as HandleKey[]) {
        const hx = pts[k].x * v.scale + v.ox, hy = pts[k].y * v.scale + v.oy;
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
    }
    ctx.restore();
}

/** Which crop-frame handle (if any) is within tol of pt. */
function hitRectHandle(r: Rect, pt: Pt, tol: number): HandleKey | null {
    const pts = handlePoints(r);
    for (const k of Object.keys(pts) as HandleKey[]) {
        if (Math.hypot(pts[k].x - pt.x, pts[k].y - pt.y) <= tol) return k;
    }
    return null;
}

/** Clamp a point inside the image bounds. */
function clampPt(p: Pt, base: HTMLCanvasElement): Pt {
    return { x: Math.max(0, Math.min(base.width, p.x)), y: Math.max(0, Math.min(base.height, p.y)) };
}

/** Clamp a normalized rect so it stays within the image bounds (preserving size when moving). */
function clampRectToImage(r: Rect, base: HTMLCanvasElement): Rect {
    let { x, y, w, h } = r;
    w = Math.min(w, base.width);
    h = Math.min(h, base.height);
    x = Math.max(0, Math.min(x, base.width - w));
    y = Math.max(0, Math.min(y, base.height - h));
    return { x, y, w, h };
}

function drawSelectionOverlay(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number; }, v: { scale: number; ox: number; oy: number; }) {
    const x = b.x * v.scale + v.ox, y = b.y * v.scale + v.oy, w = b.w * v.scale, h = b.h * v.scale;
    ctx.save();
    ctx.strokeStyle = "#5865f2"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]); ctx.fillStyle = "#5865f2";
    const hs = [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
    for (const [hx, hy] of hs) ctx.fillRect(hx - 4, hy - 4, 8, 8);
    ctx.restore();
}

function translateObject(o: Obj, dx: number, dy: number) {
    switch (o.type) {
        case "brush": case "highlight": o.pts.forEach(p => { p.x += dx; p.y += dy; }); break;
        case "line": case "arrow": o.a.x += dx; o.a.y += dy; o.b.x += dx; o.b.y += dy; break;
        case "text": o.pos.x += dx; o.pos.y += dy; break;
        default: (o as any).rect.x += dx; (o as any).rect.y += dy;
    }
}

/** free: Shift held. An inserted image keeps its aspect ratio on corner handles unless free. */
function resizeObject(o: Obj, key: HandleKey, pt: Pt, free = false) {
    if (o.type === "image" && !free) {
        o.rect = resizeRectLocked(o.rect, key, pt);
    } else if (o.type === "rect" || o.type === "ellipse" || o.type === "blur" || o.type === "pixelate" || o.type === "image") {
        (o as any).rect = resizeRect((o as any).rect, key, pt);
    } else if (o.type === "line" || o.type === "arrow") {
        // map nearest endpoint to pt
        const da = Math.hypot(o.a.x - pt.x, o.a.y - pt.y), db = Math.hypot(o.b.x - pt.x, o.b.y - pt.y);
        if (da < db) o.a = pt; else o.b = pt;
    } else if (o.type === "text") {
        const b0 = objectBounds(o);
        const newRect = resizeRect(b0, key, pt);
        const newH = Math.abs(newRect.h);
        if (newH > 0) {
            o.size = Math.max(6, o.size * newH / b0.h);
            // anchor pos to top-left of the new rect
            const nr = normRect({ x: newRect.x, y: newRect.y, w: Math.abs(newRect.w), h: newH });
            o.pos = { x: nr.x, y: nr.y };
        }
    }
    // strokes: move-only (resize ignored)
}
