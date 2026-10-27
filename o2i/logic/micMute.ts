/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The plugin's side of o2i's mic mute. The engine holds the flag (a fresh engine process starts unmuted);
// the plugin keeps the last value in the hidden `micMuted` setting and sends it again after every spawn.

/**
 * o2i's mic counts as muted (for the UI and for self-muting Discord): the saved mute, unless the last
 * engine that reported its state can't mute (an o2i.exe from before the mute: nothing is muted then).
 * `engineCanMute` null: no engine has reported yet, so the saved value counts (the safe side).
 */
export function effectiveMute(micMuted: boolean, engineCanMute: boolean | null): boolean {
    return micMuted && engineCanMute !== false;
}

/**
 * What a mic_muted event (or a mute set while no engine runs) changes: the persisted value and a sound,
 * only when it differs from what is persisted. The re-apply after a respawn reports the value the plugin
 * already has, so it stays silent.
 */
export function micMuteUpdate(persisted: boolean, muted: boolean): { persist: boolean | null; sound: "mute" | "unmute" | null; } {
    if (persisted === muted) return { persist: null, sound: null };
    return { persist: muted, sound: muted ? "mute" : "unmute" };
}

/**
 * On a new engine generation (a spawn, or this renderer re-attaching after a reload). `engineMuted` is
 * the engine's `state.mic_muted` (null / undefined: no state yet, as right after a spawn).
 * - `send`: send `set_mic_muted true` before audio starts. Only ever a mute: an engine that was muted
 *   while nobody listened (the hotkey during a reload) is never unmuted by surprise.
 * - `adopt`: the engine is muted but the plugin thinks it isn't (that same reload): persist the mute.
 */
export function muteOnAttach(persisted: boolean, engineMuted: boolean | null | undefined): { adopt: boolean; send: boolean; } {
    if (engineMuted === true) return { adopt: !persisted, send: false };
    return { adopt: false, send: persisted };
}
