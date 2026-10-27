/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { rmsToDb } from "./profile";

/** The level meter's scale, left to right: −60…0 dBFS (the o2i window's gate scale). */
export const METER_FLOOR_DB = -60;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Any dB value → a whole dBFS on the meter scale (−60…0, never −0; NaN → the floor). */
export function clampDb(db: number): number {
    if (Number.isNaN(db)) return METER_FLOOR_DB;
    return Math.round(Math.min(0, Math.max(METER_FLOOR_DB, db))) || 0;
}

/** dBFS → position along the meter (0…1, clamped). */
export function dbToFrac(db: number): number {
    return clamp01((db - METER_FLOOR_DB) / -METER_FLOOR_DB);
}

/** Linear RMS → position along the meter (0…1). */
export function rmsToFrac(rms: number): number {
    return dbToFrac(rmsToDb(rms));
}

/** Position along the meter (clamped to 0…1) → whole dBFS. */
export function fracToDb(frac: number): number {
    return clampDb(METER_FLOOR_DB + clamp01(frac) * -METER_FLOOR_DB);
}

/** A pointer's x over a track starting at `left`, `width` px wide → whole dBFS (clamped to the track). */
export function xToDb(x: number, left: number, width: number): number {
    return width > 0 ? fracToDb((x - left) / width) : METER_FLOOR_DB;
}

/** A stored gate threshold (linear RMS) as the whole dBFS the meter shows and steps from. */
export function thresholdDb(rms: number): number {
    return clampDb(rmsToDb(rms));
}

/**
 * Where the gate line sits (linear RMS). With auto on it follows the engine's live threshold; while that
 * is unknown (null, 0, NaN: audio off or still learning) it stays at the manual threshold and `learning` is set.
 */
export function gateLine(auto: boolean, live: number | null | undefined, manualRms: number): { rms: number; learning: boolean; } {
    if (!auto) return { rms: manualRms, learning: false };
    if (typeof live === "number" && Number.isFinite(live) && live > 0) return { rms: live, learning: false };
    return { rms: manualRms, learning: true };
}
