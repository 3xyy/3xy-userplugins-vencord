/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Discord's own mute / unmute sounds for o2i's mic mute. They are played through Discord's sound player
// (its SoundUtils module), the way Discord plays them for its own mute button: same volume (0.4), the
// soundpack picked in Discord's settings, nothing while streamer mode turns sounds off, and nothing when
// that sound (or every sound) is off in Discord's Notifications settings. Nothing here throws.

import { filters, find, findStoreLazy } from "@webpack";

import { olog } from "./log";

export type DiscordSound = "mute" | "unmute";

/** Discord's playSound(name, volume = 1, onEnd?, soundpack?, options?). */
type PlaySound = (name: string, volume?: number) => unknown;

interface SoundSettings {
    isSoundDisabled?(name: string): boolean;
}

/** Discord's Notifications settings (which sounds are turned off); resolved on first use. */
const NotificationSettingsStore: SoundSettings = findStoreLazy("NotificationSettingsStore");

/**
 * Code only Discord's playSound has: it returns early while streamer mode disables sounds, takes the sound
 * from the current soundpack, and plays it with or without an end listener.
 */
const PLAY_SOUND_CODE = ["disableSounds", ".getSoundpack()", "playWithListener()"];
/** The volume Discord plays its own mute / unmute sounds at (its voice sound hook). */
const SOUND_VOLUME = 0.4;
/** A failed lookup is tried again at most this often (the module could load later). */
const RETRY_MS = 30000;

let playSound: PlaySound | null = null;
let lastMissAt: number | null = null;
let missLogged = false;
let playFailing = false;

/** Discord's playSound, looked up on first use (a plain module search: logs nothing itself on a miss). */
function findPlaySound(): PlaySound | null {
    if (playSound) return playSound;
    const now = Date.now();
    if (lastMissAt !== null && now - lastMissAt < RETRY_MS) return null;
    let fn: unknown = null;
    try {
        fn = find(filters.byCode(...PLAY_SOUND_CODE), { isIndirect: true });
    } catch {
        fn = null;
    }
    if (typeof fn === "function") {
        playSound = fn as PlaySound;
        if (missLogged) olog.info("found Discord's sound player; mute sounds work again");
        return playSound;
    }
    lastMissAt = now;
    if (!missLogged) {
        missLogged = true;
        olog.warn("couldn't find Discord's sound player, so muting and unmuting o2i's mic plays no sound");
    }
    return null;
}

/** The sound (or every sound) is turned off in Discord's Notifications settings; false when that can't be read. */
function soundDisabled(name: DiscordSound): boolean {
    try {
        return NotificationSettingsStore.isSoundDisabled?.(name) === true;
    } catch {
        return false; // store not found: the sound plays
    }
}

/** Plays Discord's own `mute` or `unmute` sound, as Discord's mute button does. Never throws. */
export function playDiscordSound(name: DiscordSound): void {
    try {
        if (soundDisabled(name)) return;
        const play = findPlaySound();
        if (!play) return;
        play(name, SOUND_VOLUME);
        playFailing = false;
    } catch (e) {
        if (!playFailing) olog.error(`couldn't play Discord's ${name} sound (logged once until it works again)`, e);
        playFailing = true;
    }
}

/** For the startup self-check: looks the sound player up now, so the first mute doesn't wait for the search. */
export function discordSoundsStatus(): "found" | "missing" {
    try {
        return findPlaySound() ? "found" : "missing";
    } catch {
        return "missing";
    }
}
