/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared by the renderer and native.ts. Types only, no runtime imports.

import type { AudioStatus, EngineStatus } from "./logic/policy";

/** Discord's own voice settings, snapshotted before o2i changes them (restored on disable). */
export interface DiscordVoiceSnapshot {
    inputDeviceId: string;
    noiseSuppression: boolean;
    noiseCancellation: boolean;
    echoCancellation: boolean;
    agc: boolean;
}

/** o2i's microphone (profile.input_id) with the name the engine reported, kept for when no engine runs. */
export interface RealMicInfo {
    inputId: string;
    name: string;
}

// ---- Engine protocol events (o2i.exe --headless stdout, one JSON object per line) ----

export interface PlayingJson {
    id: number;
    /** File name. */
    name: string;
    /** The sound's identity (as `ClipJson.path`); null only from a legacy play. */
    path: string | null;
    pos_s: number;
    len_s: number | null;
    paused: boolean;
}

export interface AppStatusJson {
    name: string;
    attached: boolean;
}

export interface HotkeyErrorJson {
    accel: string;
    message: string;
}

export interface DeviceJson {
    id: string;
    name: string;
}

export interface AppJson {
    name: string;
    pid: number;
    playing: boolean;
    icon: string | null;
}

export interface ClipJson {
    file: string;
    duration_s: number | null;
    /** The sound's identity: `<source>\<file>` (pass it to `play_clip`; per-sound settings are keyed by it). */
    path: string;
    /** Its folder, exactly as configured in `sb_folders`. */
    source: string;
}

export interface ReadyEv {
    ev: "ready";
    version: string;
}

export interface StateEv {
    ev: "state";
    audio: AudioStatus;
    error: string | null;
    input_level: number;
    playing: PlayingJson[];
    apps: AppStatusJson[];
    hotkey_errors: HotkeyErrorJson[];
    /** The auto gate's live threshold (linear RMS); null unless `gate_auto` is on and audio runs. */
    gate_threshold_live?: number | null;
    /** o2i's mic is muted (`set_mic_muted` or the mute hotkey), whether or not audio runs. Missing from older engines. */
    mic_muted?: boolean;
}

export interface DevicesEv {
    ev: "devices";
    inputs: DeviceJson[];
    outputs: DeviceJson[];
    cable: DeviceJson | null;
}

export interface AppsEv {
    ev: "apps";
    apps: AppJson[];
}

export interface ClipsEv {
    ev: "clips";
    /** The first source (null: none). */
    folder: string | null;
    /** The sounds of every source, flattened in source order. */
    clips: ClipJson[];
}

export interface HotkeyErrorEv {
    ev: "hotkey_error";
    accel: string;
    message: string;
}

export interface ErrorEv {
    ev: "error";
    message: string;
}

/** Sent once per change of the mic mute, right away. */
export interface MicMutedEv {
    ev: "mic_muted";
    muted: boolean;
    source: "command" | "hotkey";
}

export type EngineEvent = ReadyEv | StateEv | DevicesEv | AppsEv | ClipsEv | HotkeyErrorEv | ErrorEv | MicMutedEv;

/** A `mic_muted` event as native.ts hands it to the renderer's long-poll; `seq` counts them (1, 2, ...). */
export interface MicMuteEvent {
    muted: boolean;
    source: string;
    seq: number;
}

// ---- What native.ts hands the renderer on every poll ----

export interface EngineNotice {
    kind: "error";
    message: string;
}

export interface EngineSnapshot {
    status: EngineStatus;
    /** +1 per spawn of o2i.exe (lets the renderer notice respawns, also after a Ctrl+R re-attach). */
    generation: number;
    /** From the current engine's `ready` event (null until it arrives); kept after the engine exits. */
    engineVersion: string | null;
    lastError: string | null;
    state: StateEv | null;
    devices: DevicesEv | null;
    apps: AppsEv | null;
    clips: ClipsEv | null;
    /** +1 per received devices/apps/clips event: lets the renderer keep those objects stable across polls. */
    seq: { devices: number; apps: number; clips: number; };
    /** `error` events since the previous poll (drained by each poll). */
    notices: EngineNotice[];
    /** The latest `mic_muted` event's number (0: none yet): where the renderer's long-poll starts. */
    micMuteSeq: number;
}

export type StartResult = { ok: true; } | { ok: false; error: string; };
export type DumpResult = { ok: true; profile: unknown; } | { ok: false; error: string; };
/** `path`: the zip written to Downloads. */
export type ExportLogsResult = { ok: true; path: string; } | { ok: false; error: string; };
