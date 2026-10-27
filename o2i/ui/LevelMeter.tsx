/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { clampDb, dbToFrac, METER_FLOOR_DB, rmsToFrac, thresholdDb, xToDb } from "../logic/meter";

const cl = classNameFactory("vc-o2i-");

const SMOOTHING = 0.2;

/** Keys the threshold marker handles → dB step (Home / End jump to the ends). */
const KEY_STEPS: Partial<Record<string, number>> = {
    ArrowLeft: -1,
    ArrowDown: -1,
    ArrowRight: 1,
    ArrowUp: 1,
    PageDown: -10,
    PageUp: 10,
    Home: METER_FLOOR_DB,
    End: -METER_FLOOR_DB,
};

/**
 * The meter level (0…1 along the −60…0 dBFS bar), smoothed in meter space like the o2i window and
 * kept in a ref so smoothing never causes a render. It advances once per render of the *calling*
 * component (LiveMeter: once per poll), so the meter's own re-renders while dragging don't speed it up.
 */
export function useSmoothedLevel(rms: number): number {
    const level = useRef(0);
    level.current += (rmsToFrac(rms) - level.current) * SMOOTHING;
    return level.current;
}

interface Drag {
    pointerId: number;
    /** Track's left edge, minus where on the line it was grabbed (so grabbing the line never nudges it). */
    left: number;
    width: number;
    db: number;
}

/**
 * Discord-style input level bar (−60…0 dBFS). With the gate on, its threshold is the white line:
 * pressing anywhere on the bar moves the line there, dragging moves it live (state local to this
 * component, so only the meter re-renders), and releasing commits once via `onThresholdCommit`.
 * The line is also a keyboard slider (arrows ±1 dB, PageUp/PageDown ±10, Home/End), one commit per key.
 * With the gate off (`thresholdRms` null) the meter is display only.
 */
export function LevelMeter({ level, thresholdRms, auto, learning, onThresholdCommit }: {
    /** Auto gate on: the line is the engine's live threshold (or, while `learning`, the manual one, dimmed). */
    auto?: boolean;
    learning?: boolean;
    /** Smoothed level, 0…1 along the bar (useSmoothedLevel). */
    level: number;
    /** The stored gate threshold (linear RMS), or null when the gate is off. */
    thresholdRms: number | null;
    /** New threshold in whole dBFS: once per drag (on release) or key press. */
    onThresholdCommit(db: number): void;
}) {
    const drag = useRef<Drag | null>(null);
    const marker = useRef<HTMLDivElement>(null);
    const [dragDb, setDragDb] = useState<number | null>(null);
    const gated = thresholdRms != null;

    // The gate flipped mid-drag (or the meter (re)mounted): drop any drag without committing.
    useEffect(() => {
        drag.current = null;
        setDragDb(null);
    }, [gated]);

    const storedDb = gated ? thresholdDb(thresholdRms) : METER_FLOOR_DB;
    const db = dragDb ?? storedDb;
    const threshold = !gated ? 0 : dragDb != null ? dbToFrac(dragDb) : rmsToFrac(thresholdRms);
    const open = !gated || level >= threshold;
    const levelDb = Math.round(METER_FLOOR_DB + level * -METER_FLOOR_DB);

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (!gated || e.button !== 0 || drag.current) return;
        const track = e.currentTarget;
        const rect = track.getBoundingClientRect();
        const grabbed = marker.current?.contains(e.target as Node) ? e.clientX - (rect.left + threshold * rect.width) : 0;
        const left = rect.left + grabbed;
        const { width } = rect;
        const d = xToDb(e.clientX, left, width);
        try {
            track.setPointerCapture(e.pointerId);
        } catch {
            return; // pointer already gone
        }
        drag.current = { pointerId: e.pointerId, left, width, db: d };
        setDragDb(d);
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || e.pointerId !== cur.pointerId) return;
        const d = xToDb(e.clientX, cur.left, cur.width);
        if (d === cur.db) return;
        cur.db = d;
        setDragDb(d);
    };

    const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || e.pointerId !== cur.pointerId) return;
        drag.current = null;
        setDragDb(null);
        onThresholdCommit(xToDb(e.clientX, cur.left, cur.width));
    };

    // pointercancel, or capture lost without a pointerup (it is also lost right after one: drag is null by then).
    const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || e.pointerId !== cur.pointerId) return;
        drag.current = null;
        setDragDb(null);
    };

    // No text selection while dragging; focus the line so the arrow keys can fine-tune right after.
    const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
        if (!gated || e.button !== 0) return;
        e.preventDefault();
        marker.current?.focus({ preventScroll: true });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step = KEY_STEPS[e.key];
        if (step == null || !gated || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (!drag.current) onThresholdCommit(clampDb(storedDb + step));
    };

    return (
        <div className={cl("field")}>
            <div className={cl("field-row")}>
                <span className={cl("label")}>Input level</span>
                {gated && (
                    <span className={cl("value")}>
                        {auto ? (learning ? "Auto · learning…" : `Auto ${db} dB`) : `Threshold ${db} dB`}
                    </span>
                )}
            </div>
            <div
                className={cl("meter", { "meter-gated": gated })}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onLostPointerCapture={onPointerCancel}
                onMouseDown={onMouseDown}
            >
                <div
                    className={cl("meter-bar")}
                    role="meter"
                    aria-label="Input level"
                    aria-valuemin={METER_FLOOR_DB}
                    aria-valuemax={0}
                    aria-valuenow={levelDb}
                >
                    <div
                        className={cl("meter-fill", gated ? (open ? "meter-open" : "meter-closed") : "meter-ungated")}
                        style={{ transform: `scaleX(${level})` }}
                    />
                    <span className={cl("meter-label")}>{levelDb} dBFS</span>
                </div>
                {gated && (
                    <div
                        ref={marker}
                        className={cl("meter-threshold", { "meter-threshold-dim": !!auto && !!learning })}
                        style={{ left: `${threshold * 100}%` }}
                        role="slider"
                        tabIndex={0}
                        aria-label="Noise gate threshold"
                        aria-orientation="horizontal"
                        aria-valuemin={METER_FLOOR_DB}
                        aria-valuemax={0}
                        aria-valuenow={db}
                        aria-valuetext={`${db} dB`}
                        onKeyDown={onKeyDown}
                    >
                        {dragDb != null && (
                            // Shifted by its own position so it never pokes out past either end of the bar.
                            <span className={cl("meter-bubble")} style={{ transform: `translateX(${-threshold * 100}%)` }}>
                                {dragDb} dB
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
