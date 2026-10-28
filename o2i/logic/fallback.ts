/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type Dev, findCableOutput, matchDeviceByName } from "./match";
import { type AudioStatus, type EngineStatus, fallbackAction } from "./policy";

/** Audio must stay healthy this long before a fallback is undone, so a crash-looping engine doesn't flap Discord's input. */
export const RECOVER_STABLE_MS = 2000;

/**
 * How long audio has been wanted, counted from when it became wanted or the engine (re)spawned,
 * whichever is later (a fresh engine needs its own start-up time). 0 while audio isn't wanted.
 */
export function audioWantedMs(now: number, want: boolean, wantedAt: number, spawnedAt: number): number {
    return want ? Math.max(0, now - Math.max(wantedAt, spawnedAt)) : 0;
}

/** Discord's "Default" input entry (follows the Windows default recording device). */
export function defaultInputId(devs: Dev[]): string | null {
    return (devs.find(d => d.id === "default") ?? devs.find(d => d.name === "Default"))?.id ?? null;
}

/**
 * Discord has enumerated its input devices: the list has a named device besides its Default entry
 * (until then it may hold only Default, and the input can't be judged).
 */
export function namedDevicesListed(devs: Dev[]): boolean {
    const def = defaultInputId(devs);
    return devs.some(d => d.id !== def);
}

/**
 * Discord's input may be fed by o2i: it is CABLE Output, or Discord's Default entry (Windows' default
 * recording device could be CABLE Output, and Discord doesn't tell us which device Default is).
 */
export function mayBeOnO2i(inputId: string, devs: Dev[]): boolean {
    if (inputId === "default") return true;
    const cable = findCableOutput(devs);
    if (cable != null && inputId === cable) return true;
    const def = defaultInputId(devs);
    return def != null && inputId === def;
}

/** Discord's device for o2i's microphone, matched by name; never CABLE Output or Default, null for an empty name. */
export function pickRealMic(devs: Dev[], realMicName: string): string | null {
    if (!realMicName) return null;
    const cable = findCableOutput(devs);
    const def = defaultInputId(devs);
    return matchDeviceByName(devs.filter(d => d.id !== cable && d.id !== def), realMicName);
}

/**
 * Where the fallback sends Discord: o2i's microphone by name (`pickRealMic`) or, when that name is
 * unknown or matches nothing, Discord's original input from the snapshot if it is still in Discord's
 * list and is a named device (not CABLE Output or Default). null when neither works.
 */
export function pickFallbackMic(devs: Dev[], realMicName: string, snapshotInputId: string | null | undefined): string | null {
    const byName = pickRealMic(devs, realMicName);
    if (byName) return byName;
    if (!snapshotInputId || !devs.some(d => d.id === snapshotInputId)) return null;
    return mayBeOnO2i(snapshotInputId, devs) ? null : snapshotInputId;
}

/**
 * The fallback controller's decision for one tick: `fallbackAction` plus three guards.
 * - `"starting"` (spawned, process not confirmed alive yet) gets the same start-up grace as audio
 *   starting, instead of counting as a failed engine.
 * - A fallback only happens while Discord may be listening to o2i (`mayBeOnO2i`); otherwise o2i isn't
 *   in Discord's audio path and nothing goes silent. `discordMayBeOnO2i` is only called when a fallback is due.
 * - A recovery waits until audio has been healthy for `RECOVER_STABLE_MS`.
 * - Nothing at all while o2i is turned off (`powered` false): the power-off handled Discord's voice.
 */
export function fallbackDecision(s: {
    inCall: boolean;
    engine: EngineStatus;
    audio: AudioStatus | null;
    msSinceAudioWanted: number;
    /** How long engine + audio have been healthy without interruption (0 when not healthy). */
    msHealthy: number;
    fallenBack: boolean;
    discordMayBeOnO2i: () => boolean;
    /** The power button's state; absent counts as on. */
    powered?: boolean;
}): "fallback" | "recover" | "none" {
    if (s.powered === false) return "none";
    const engine: EngineStatus = s.engine === "starting" ? "running" : s.engine;
    const action = fallbackAction({
        inCall: s.inCall,
        engine,
        audio: s.audio,
        msSinceAudioWanted: s.msSinceAudioWanted,
        fallenBack: s.fallenBack,
    });
    if (action === "fallback") return s.discordMayBeOnO2i() ? "fallback" : "none";
    if (action === "recover") return s.msHealthy >= RECOVER_STABLE_MS ? "recover" : "none";
    return "none";
}

/**
 * The fallback's rule for o2i's mic mute. Falling back moves Discord to the real mic, which o2i's mute
 * can't reach, so while o2i's mic is muted Discord's own self-mute takes over:
 * - `"fallback"` with o2i muted: self-mute Discord, remember Discord's mute from before (an earlier saved
 *   value is kept: by then Discord may be self-muted by o2i) and add ", muted" to the toast. With o2i not
 *   muted nothing changes (a saved value stays saved).
 * - Push to talk counts the same as muted (`pttMode`): once o2i is down nothing gates the real mic, so it fails
 *   closed whether or not the key is held. The toast suffix is the same.
 * - `"recover"` (Discord back on o2i): put back the saved mute, if any.
 * A saved value only counts while Discord is still self-muted: once he has unmuted Discord by hand it is
 * stale, so it is dropped, and a recovery never mutes him again.
 * `saveDiscordMute` is what to keep saved afterwards (null: nothing). `setDiscordMute` null: leave it.
 */
export function fallbackMuteDecision(
    o2iMuted: boolean,
    discordSelfMuted: boolean,
    phase: "fallback" | "recover",
    savedDiscordMute: boolean | null,
    pttMode = false
): { setDiscordMute: boolean | null; saveDiscordMute: boolean | null; toastSuffix: string | null; } {
    const saved = discordSelfMuted ? savedDiscordMute : null;
    if (phase === "recover") {
        const set = savedDiscordMute === true && !discordSelfMuted ? null : savedDiscordMute;
        return { setDiscordMute: set, saveDiscordMute: null, toastSuffix: null };
    }
    if (!o2iMuted && !pttMode) return { setDiscordMute: null, saveDiscordMute: saved, toastSuffix: null };
    return { setDiscordMute: true, saveDiscordMute: saved ?? discordSelfMuted, toastSuffix: ", muted" };
}

/**
 * Discord's input is surely o2i: its devices are listed and the input is exactly CABLE Output (what the Fix
 * sets). Unlike `mayBeOnO2i`, Discord's Default entry never counts, nor its start-up placeholder (input
 * "default" before any device is listed): from there Discord may land on the real mic. For lifting a
 * self-mute only; deciding to fall back keeps `mayBeOnO2i` (the safe direction there).
 */
export function onCableExactly(inputId: string | null, devs: Dev[]): boolean {
    if (inputId == null || !namedDevicesListed(devs)) return false;
    const cable = findCableOutput(devs);
    return cable != null && inputId === cable;
}

/**
 * What a change of o2i's effective mute does to Discord's self-mute, in or out of an episode:
 * - muted while Discord isn't surely on CABLE (`onCableExactly`; devices not listed counts as not on it):
 *   Discord may be on the real mic, which o2i's mute can't reach, so it is self-muted ("mute-discord");
 * - unmuted while a self-mute of o2i's is saved: lifted ("lift"). His own Discord mute is never touched.
 * - In push to talk (`pttMode`) the lift only happens once Discord is surely on CABLE: on the real mic nothing
 *   gates the mic, so the self-mute stays (the saved value comes back with the restore).
 * Only on a change, never per tick: a deliberate unmute by hand stays. `onCable` is only called for a mute,
 * and for an unmute in push to talk.
 */
export function o2iMuteTransition(muted: boolean, onCable: () => boolean, saved: boolean | null, pttMode = false): "mute-discord" | "lift" | "none" {
    if (muted) return onCable() ? "none" : "mute-discord";
    if (saved === null) return "none";
    if (pttMode && !onCable()) return "none";
    return "lift";
}

/**
 * The mic mode changed (Always on <-> Push to talk), in or out of an episode; `ptt` is the new mode, `muted`
 * o2i's effective mute (a mute is followed by `o2iMuteTransition` already, so nothing here).
 * - Entering push to talk while Discord isn't surely on CABLE: it may be on the real mic, which nothing gates
 *   any more, so it is self-muted ("mute-discord").
 * - Leaving it: like an unmute, a self-mute of o2i's is lifted.
 * Only on a change of the mode. `onCable` is only called when it matters.
 */
export function pttModeTransition(ptt: boolean, muted: boolean, onCable: () => boolean, saved: boolean | null): "mute-discord" | "lift" | "none" {
    if (muted) return "none";
    if (ptt) return onCable() ? "none" : "mute-discord";
    return o2iMuteTransition(false, onCable, saved);
}

/**
 * Discord's input changed. Moving off exactly CABLE Output while o2i's mic is muted, other than by the
 * plugin's own switch (the fallback, power and restore paths apply the mute rule themselves), runs
 * `o2iMuteTransition` once for that mute: Discord may now be on the real mic, which o2i's mute can't reach.
 * Never lifts (only o2i's own unmute does). Nothing while o2i is turned off (`powered` false): its mute isn't
 * in use then, and the power-off already applied the rule. `wasOnCable`: exactly on CABLE before the change
 * (null: not known).
 */
export function inputChangeTransition(s: {
    wasOnCable: boolean | null;
    onCable: boolean;
    ownSwitch: boolean;
    muted: boolean;
    saved: boolean | null;
    /** The power button's state; absent counts as on. */
    powered?: boolean;
}): "mute-discord" | "none" {
    if (s.powered === false || s.wasOnCable !== true || s.onCable || s.ownSwitch || !s.muted) return "none";
    return o2iMuteTransition(true, () => s.onCable, s.saved) === "mute-discord" ? "mute-discord" : "none";
}

/** How long after asking Discord for an input device a change to that device still counts as the plugin's own. */
export const INPUT_APPLY_MS = 2000;

/**
 * Discord's input `inputId` is the one the plugin asked for at `requested.at` (within INPUT_APPLY_MS).
 * `requested.at` and `now` come from the same clock (the plugin uses performance.now(), which never jumps).
 */
export function isOwnInputSwitch(requested: { id: string; at: number; } | null, inputId: string | null, now: number): boolean {
    return requested != null && inputId === requested.id && now - requested.at < INPUT_APPLY_MS;
}

/**
 * While a saved value exists, o2i's last change to Discord's self-mute was a mute; Discord found unmuted
 * means he unmuted it himself, so the saved value is forgotten (and a later hand re-mute is his, never lifted).
 */
export function savedAfterHandChange(saved: boolean | null, discordSelfMuted: boolean): boolean | null {
    return discordSelfMuted ? saved : null;
}

/** Discord has to be on CABLE this long, with the engine running, before its own mute comes back (its device switch is async). */
export const MUTE_RESTORE_AFTER_MS = 1000;

/**
 * Whether Discord's saved self-mute (see `fallbackMuteDecision`) is put back now. Only outside a fallback
 * episode, with the engine running (so o2i's own mute is in Discord's path) and Discord surely on CABLE
 * (`onCableExactly`) without a break for `MUTE_RESTORE_AFTER_MS`. `since`: when that started (null: not
 * yet); `onCable` is only called when a restore could be due.
 */
export function muteRestoreDue(s: {
    fallenBack: boolean;
    saved: boolean | null;
    engineRunning: boolean;
    onCable: () => boolean;
    since: number | null;
    now: number;
}): { since: number | null; restore: boolean; } {
    if (s.fallenBack || s.saved === null || !s.engineRunning || !s.onCable()) return { since: null, restore: false };
    const since = s.since ?? s.now;
    return { since, restore: s.now - since >= MUTE_RESTORE_AFTER_MS };
}

/**
 * During a fallback episode with o2i still down: once Discord has been seen off o2i (`seenOff`), Discord
 * going back onto o2i (switched by hand) ends the episode (`reset`) so the controller can fall back again.
 * Requiring the off→on transition means a failed or not-yet-applied switch never loops toasts.
 * `onO2i` is only called during an unhealthy episode.
 */
export function episodeCheck(s: { fallenBack: boolean; healthy: boolean; seenOff: boolean; onO2i: () => boolean; }): { seenOff: boolean; reset: boolean; } {
    if (!s.fallenBack || s.healthy) return { seenOff: s.seenOff, reset: false };
    if (!s.onO2i()) return { seenOff: true, reset: false };
    return { seenOff: s.seenOff, reset: s.seenOff };
}
