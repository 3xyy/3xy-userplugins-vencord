/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { ColorPicker, Slider, useRef } from "@webpack/common";
import { ReactNode } from "react";

import { Rect } from "./geometry";
import { Obj, Style, ToolId } from "./model";
import { INTENSITY_MAX, INTENSITY_MIN } from "./region";

interface Props {
    tool: ToolId; style: Style; setStyle(s: Style): void;
    selected: Obj | null; onChangeSelected(): void; pushHistory(): void;
    cropRect?: Rect | null;
    onApplyCrop?(): void;
    onCancelCrop?(): void;
}

const COLOR_TOOLS = new Set(["brush", "highlight", "line", "arrow", "rect", "ellipse", "text"]);
const WIDTH_TOOLS = new Set(["brush", "highlight", "line", "arrow", "rect", "ellipse"]);
const FILL_TOOLS = new Set(["rect", "ellipse"]);

export function OptionsStrip({ tool, style, setStyle, selected, onChangeSelected, pushHistory, cropRect, onApplyCrop, onCancelCrop }: Props) {
    // crop mode: show Apply/Cancel instead of normal controls
    if (tool === "crop") {
        return (
            <div className="vc-it-options">
                <span className="vc-it-hint">Drag the box or its handles to choose what to keep.</span>
                <Button variant="primary" size="small" disabled={!cropRect} onClick={onApplyCrop}>Apply crop</Button>
                <Button variant="secondary" size="small" onClick={onCancelCrop}>Cancel</Button>
            </div>
        );
    }

    // editing a selected object? (keyed by id: another object gets fresh sliders and a fresh undo step)
    if (selected) return <SelectedControls key={selected.id} o={selected} onChange={onChangeSelected} pushHistory={pushHistory} />;

    const controls: ReactNode[] = [];
    if (COLOR_TOOLS.has(tool))
        controls.push(<ColorPicker key="c" color={style.color} onChange={(c: number | null) => setStyle({ ...style, color: c ?? style.color })} showEyeDropper={false} />);
    if (WIDTH_TOOLS.has(tool))
        controls.push(<SliderNum key="w" label="Width" value={style.width} min={1} max={60} onChange={v => setStyle({ ...style, width: v })} />);
    if (tool === "text")
        controls.push(<SliderNum key="f" label="Size" value={style.fontSize} min={10} max={120} onChange={v => setStyle({ ...style, fontSize: v })} />);
    if (FILL_TOOLS.has(tool))
        controls.push(<FillCheck key="fill" checked={style.fill} onChange={v => setStyle({ ...style, fill: v })} />);
    if (tool === "blur")
        controls.push(<SliderNum key="bi" label="Blur strength" value={style.blurIntensity} min={INTENSITY_MIN} max={INTENSITY_MAX} onChange={v => setStyle({ ...style, blurIntensity: v })} />);
    if (tool === "pixelate")
        controls.push(<SliderNum key="pi" label="Pixel size" value={style.pixelIntensity} min={INTENSITY_MIN} max={INTENSITY_MAX} onChange={v => setStyle({ ...style, pixelIntensity: v })} />);

    return <div className="vc-it-options">{controls}</div>;
}

function SelectedControls({ o, onChange, pushHistory }: { o: Obj; onChange(): void; pushHistory(): void; }) {
    const pushed = useRef(false);
    const commit = () => { if (!pushed.current) { pushHistory(); pushed.current = true; } };
    const hasColor = "color" in o;
    const hasWidth = "width" in o;
    const isShape = o.type === "rect" || o.type === "ellipse";
    return (
        <div className="vc-it-options" onPointerDownCapture={() => { pushed.current = false; }}>
            {hasColor && <ColorPicker color={(o as any).color} onChange={(c: number | null) => { commit(); (o as any).color = c ?? (o as any).color; onChange(); }} showEyeDropper={false} />}
            {hasWidth && <SliderNum label="Width" value={(o as any).width} min={1} max={60} onChange={v => { commit(); (o as any).width = v; onChange(); }} />}
            {o.type === "text" && <SliderNum label="Size" value={o.size} min={10} max={120} onChange={v => { commit(); o.size = v; onChange(); }} />}
            {isShape && <FillCheck checked={(o as any).fill} onChange={v => { commit(); (o as any).fill = v; onChange(); }} />}
            {(o.type === "blur" || o.type === "pixelate") && <SliderNum label={o.type === "blur" ? "Blur strength" : "Pixel size"} value={o.intensity} min={INTENSITY_MIN} max={INTENSITY_MAX} onChange={v => { commit(); o.intensity = v; onChange(); }} />}
        </div>
    );
}

/** "Fill" with a checkbox drawn in Discord's style (styles.css), not the browser's white box. */
function FillCheck({ checked, onChange }: { checked: boolean; onChange(v: boolean): void; }) {
    return (
        <label className="vc-it-fill">
            <input type="checkbox" className="vc-it-check" checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
            Fill
        </label>
    );
}

function Labeled({ label, children, onPointerUpCapture }: { label: string; children: ReactNode; onPointerUpCapture?(): void; }) {
    return <div className="vc-it-labeled" onPointerUpCapture={onPointerUpCapture}><span>{label}</span>{children}</div>;
}

/** A slider plus a compact numeric input bound to the same value. Clamps to [min, max] and rounds. */
function SliderNum({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(v: number): void; }) {
    const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
    // Discord's Slider is uncontrolled (it reads initialValue once). It calls asValueChanges on every drag
    // move, onValueChange once on release, and for a click on the track onValueChange then asValueChanges.
    // While the thumb is held we apply every value live but keep the same Slider (a remount would drop its
    // drag listeners). When the value changes from elsewhere (the number box) we remount it via `key` so
    // its thumb follows. A plain click fires no onValueChange on release, so pointer-up also ends the hold.
    const dragging = useRef(false);
    const sliderKey = useRef(value);
    if (!dragging.current) sliderKey.current = value;
    return (
        <Labeled label={label} onPointerUpCapture={() => { dragging.current = false; }}>
            <Slider
                key={sliderKey.current}
                initialValue={sliderKey.current}
                minValue={min}
                maxValue={max}
                asValueChanges={(v: number) => { dragging.current = true; onChange(clamp(v)); }}
                onValueChange={(v: number) => { dragging.current = false; onChange(clamp(v)); }}
            />
            {/* A plain themed input. Discord's text box component swaps its own class for any class passed
                to it, which renders a white unstyled box. */}
            <input
                type="number"
                className="vc-it-num"
                aria-label={label}
                min={min}
                max={max}
                value={String(value)}
                onChange={e => { dragging.current = false; const n = parseInt(e.currentTarget.value, 10); if (!Number.isNaN(n)) onChange(clamp(n)); }}
            />
        </Labeled>
    );
}
