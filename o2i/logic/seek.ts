/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Seek positions are whole tenths of a second. */
const round1 = (s: number) => Math.round(s * 10) / 10;

/** Clamps `pos` to [0, len_s] at 0.1 s resolution (NaN → 0). */
function clampPos(pos: number, len_s: number): number {
    if (Number.isNaN(pos) || !(len_s > 0)) return 0;
    return Math.min(round1(Math.max(0, pos)), round1(len_s));
}

/** A pointer at `x` over a track `width` px wide (x relative to the track's left edge) → seconds into the sound. */
export function posFromX(x: number, width: number, len_s: number): number {
    if (!(width > 0) || !(len_s > 0)) return 0;
    return clampPos((x / width) * len_s, len_s);
}

/** Keyboard seek: `pos` moved by `delta` seconds, clamped to [0, len_s]. */
export function stepSeek(pos: number, delta: number, len_s: number): number {
    return clampPos(pos + delta, len_s);
}

/** How close (s) the polled position must get to a seek target before the target stops being shown. */
export const SEEK_SETTLE_S = 0.5;
/** Longest (ms) a seek target is shown after release if the polled position never reaches it. */
export const SEEK_SETTLE_MS = 1000;

/** True while a just-seeked target should still be shown instead of the polled position. */
export function seekPending(target: number, polled: number, sinceMs: number): boolean {
    return sinceMs < SEEK_SETTLE_MS && Math.abs(polled - target) > SEEK_SETTLE_S;
}

/** ms to wait before the next throttled send (0 = send now), in [0, intervalMs] even if the clock stepped back. */
export function throttleWait(lastAt: number, now: number, intervalMs: number): number {
    return Math.min(intervalMs, Math.max(0, lastAt + intervalMs - now));
}
