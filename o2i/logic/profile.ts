/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { inSources, isBareName, sourcesOf } from "./sources";

/** One sound's levels (an `sb_clip_settings` entry). */
export interface ClipSettings {
    /** The sound's absolute path (legacy: a bare file name in the first folder). */
    name: string;
    vol_others: number;
    vol_self: number;
    hear_local: boolean;
}

export interface O2iProfile {
    name: string;
    input_id?: string | null;
    output_id?: string | null;
    gate_enabled?: boolean;
    gate_threshold?: number | null;
    suppress_enabled?: boolean;
    suppress_amount?: number | null;
    agc_enabled?: boolean;
    agc_target?: number | null;
    mic_volume?: number | null;
    duck_enabled?: boolean;
    duck_target?: number | null;
    routed_apps?: { name: string; volume: number; }[];
    master_volume?: number | null;
    /** Legacy single soundboard folder: the engine reads it only while `sb_folders` is empty. Kept equal to sb_folders[0]. */
    sb_folder?: string | null;
    /** Soundboard source folders (the source of truth). Sent as an array, never null: the engine rejects null. */
    sb_folders?: string[];
    /** [sound, accel]; the sound is its absolute path (legacy: a bare file name in the first folder). */
    sb_clip_hotkeys?: [string, string][];
    sb_stop_all_hotkey?: string | null;
    sb_monitor_device?: string | null;
    sb_clip_settings?: ClipSettings[];
    sb_global_others?: number | null;
    sb_global_self?: number | null;
    sb_global_hear_local?: boolean;
    sb_global_override?: boolean;
    voice_preset?: string | null;
    voice_intensity?: number | null;
    /** Hear your processed mic on the monitor device. */
    monitor_mic?: boolean;
    /** 0–2; null = 1. */
    monitor_mic_volume?: number | null;
    /** Text to speech loudness, 0 to 2; null = 1. */
    tts_volume?: number | null;
    /** The gate threshold follows the noise floor. */
    gate_auto?: boolean;
    /** 0–40 dB above the noise floor; null = 6. */
    gate_auto_margin_db?: number | null;
    /** Toggles o2i's mic mute from anywhere (the engine's input hook): `V`, `Ctrl+Shift+M`, `Mouse4`, ...; null = none. */
    mic_mute_hotkey?: string | null;
    /** 0–100: lower makes the mic sound worse (narrower band, lower rate and bit depth); null = 100, untouched. */
    mic_quality?: number | null;
    /** "always": the mic is open (unless muted); "ptt": open only while `ptt_key` is held (the engine's input hook). null = "always". */
    mic_mode?: MicMode | null;
    /** The push-to-talk key, same spec format as `mic_mute_hotkey`; null = none (in "ptt" mode the mic stays closed). */
    ptt_key?: string | null;
}

export type MicMode = "always" | "ptt";

/** The profile is in push-to-talk mode (anything but "ptt" counts as "always"). */
export function isPttMode(p: Pick<O2iProfile, "mic_mode"> | null | undefined): boolean {
    return p?.mic_mode === "ptt";
}

/**
 * What `configure` sends: muted apps at volume 0, `sb_folders` always as an explicit array, and only the
 * hotkeys of sounds inside a current folder (a removed folder keeps its sounds' hotkeys in the stored
 * profile, so re-adding it restores them, but the engine shouldn't hold those keys meanwhile). Legacy
 * bare-name keys are always sent.
 */
export function effectiveProfile(p: O2iProfile, muted: string[]): O2iProfile {
    const out: O2iProfile = {
        ...p,
        sb_folders: Array.isArray(p.sb_folders) ? p.sb_folders : [],
        routed_apps: p.routed_apps?.map(a => ({ ...a, volume: muted.includes(a.name) ? 0 : a.volume })),
        // Explicit values: the engine keeps its current value for a missing field, and rejects some nulls.
        monitor_mic: p.monitor_mic ?? false,
        monitor_mic_volume: p.monitor_mic_volume ?? 1,
        tts_volume: p.tts_volume ?? 1,
        gate_auto: p.gate_auto ?? false,
        gate_auto_margin_db: p.gate_auto_margin_db ?? 6,
        mic_quality: p.mic_quality ?? 100,
        mic_mute_hotkey: p.mic_mute_hotkey?.trim() || null,
        mic_mode: isPttMode(p) ? "ptt" : "always",
        ptt_key: p.ptt_key?.trim() || null,
    };
    if (p.sb_clip_hotkeys) {
        const sources = sourcesOf(p);
        out.sb_clip_hotkeys = p.sb_clip_hotkeys.filter(([key]) => isBareName(key) || inSources(key, sources));
    }
    return out;
}

export function dbToRms(db: number): number {
    return Math.pow(10, db / 20);
}

export function rmsToDb(rms: number): number {
    if (!(rms > 0)) return -60;
    return Math.max(-60, 20 * Math.log10(rms));
}
