/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type EngineStatus = "unset" | "starting" | "running" | "crashed" | "stopped";
export type AudioStatus = "off" | "running" | "error";

export function wantAudio(s: { inCall: boolean; popoutOpen: boolean; keepRunning: boolean; }): boolean {
    return s.inCall || s.popoutOpen || s.keepRunning;
}

export function fallbackAction(s: {
    inCall: boolean;
    engine: EngineStatus;
    audio: AudioStatus | null;
    msSinceAudioWanted: number;
    fallenBack: boolean;
}): "fallback" | "recover" | "none" {
    const healthy = s.engine === "running" && s.audio === "running";
    if (s.inCall && !s.fallenBack && !healthy && (s.engine !== "running" || s.msSinceAudioWanted > 3000)) return "fallback";
    if (s.fallenBack && healthy) return "recover";
    return "none";
}
