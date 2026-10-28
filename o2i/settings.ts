/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { followPttMode } from "./discordVoice";
import { engineClient, getNative } from "./engineClient";
import { olog } from "./log";
import { isPttMode, type O2iProfile } from "./logic/profile";
import { type SoundMeta, type SoundMetaMap, withSoundMeta } from "./logic/soundMeta";
import { addSource, planPathsMigration, shouldAddDefaultFolder, sourcesOf, withSources } from "./logic/sources";
import type { DiscordVoiceSnapshot, RealMicInfo } from "./types";
import { SetupSection } from "./ui/SetupSection";

export const settings = definePluginSettings({
    /** Edited in SetupSection's own box (it checks the file exists), so Vencord's box is hidden. */
    enginePath: {
        type: OptionType.STRING,
        description: "Full path to o2i.exe",
        default: "",
        hidden: true,
    },
    keepRunningOutsideCalls: {
        type: OptionType.BOOLEAN,
        description: "Keep o2i's audio running when you're not in a call, for example to use VB-CABLE in other apps",
        default: false,
    },
    setup: {
        type: OptionType.COMPONENT,
        component: SetupSection,
    },
    profile: {
        type: OptionType.CUSTOM,
        default: { name: "default" } as O2iProfile,
    },
    mutedApps: {
        type: OptionType.CUSTOM,
        default: [] as string[],
    },
    /** Soundboard names / emojis by sound path. Display only: never part of the profile sent to the engine. */
    soundMeta: {
        type: OptionType.CUSTOM,
        default: {} as SoundMetaMap,
    },
    imported: {
        type: OptionType.CUSTOM,
        default: false,
    },
    /** Soundboard keys (per-sound settings, hotkeys, soundMeta) moved from file names to paths (logic/sources.ts). */
    migratedPaths: {
        type: OptionType.CUSTOM,
        default: false,
    },
    /** JSON of the profile + soundMeta from before the path migration. Set once, never overwritten. */
    pathsMigrationBackup: {
        type: OptionType.CUSTOM,
        default: null as string | null,
    },
    /** The shipped default sounds folder was offered once (added, or already listed); removing it later keeps it removed. */
    defaultSoundsAdded: {
        type: OptionType.CUSTOM,
        default: false,
    },
    discordSnapshot: {
        type: OptionType.CUSTOM,
        default: null as DiscordVoiceSnapshot | null,
    },
    /** Where the fallback sends Discord when o2i is down (also after a restart with no engine). */
    realMic: {
        type: OptionType.CUSTOM,
        default: null as RealMicInfo | null,
    },
    /** The power button (power.ts): false = turned off, the engine doesn't run (also after a restart). */
    powered: {
        type: OptionType.CUSTOM,
        default: true,
    },
    /** Discord was on o2i when it was turned off: turning it on switches Discord back to CABLE Output. */
    powerRestoreCable: {
        type: OptionType.CUSTOM,
        default: false,
    },
    /** Discord's input when `powerRestoreCable` was set: picking any other device drops that switch back. */
    powerRestoreFrom: {
        type: OptionType.CUSTOM,
        default: null as string | null,
    },
    /**
     * o2i's mic mute as the engine last reported it (or as set while no engine ran). A new engine process
     * starts unmuted, so engineClient sends this again before audio starts. The mute hotkey itself is in
     * the profile (`mic_mute_hotkey`).
     */
    micMuted: {
        type: OptionType.CUSTOM,
        default: false,
    },
    /**
     * Discord's own self-mute from before o2i self-muted it (Discord went to the real mic while o2i's mic
     * was muted); put back once Discord is on o2i again. null: o2i hasn't changed it. See discordVoice.ts.
     */
    savedDiscordMute: {
        type: OptionType.CUSTOM,
        default: null as boolean | null,
    },
    /** Text to speech: the last voice used (an engine voice id) and its speed (0.5 to 2). */
    ttsVoice: {
        type: OptionType.CUSTOM,
        default: null as string | null,
    },
    ttsRate: {
        type: OptionType.CUSTOM,
        default: 1,
    },
});

/** Updates the stored profile (fn gets a plain copy) and pushes it to the engine (debounced). */
export function updateProfile(fn: (p: O2iProfile) => O2iProfile): void {
    const current: O2iProfile = JSON.parse(JSON.stringify(settings.store.profile ?? { name: "default" }));
    const wasPtt = isPttMode(current);
    settings.store.profile = fn(current);
    engineClient.configureSoon();
    const ptt = isPttMode(settings.store.profile);
    if (ptt !== wasPtt) followPttMode(ptt);
}

/** Sets or clears one sound's display name / emoji (by its path); writes the setting only when something changed. */
export function updateSoundMeta(path: string, patch: SoundMeta): void {
    const current: SoundMetaMap = JSON.parse(JSON.stringify(settings.store.soundMeta ?? {}));
    const next = withSoundMeta(current, path, patch);
    if (next !== current) settings.store.soundMeta = next;
}

/**
 * The one-time move of soundboard keys from file names to paths (see planPathsMigration). Runs at
 * start, after an import and after a folder is added; does nothing once done or while there is no
 * folder. The old profile + soundMeta are backed up first (pathsMigrationBackup, kept). Never throws.
 */
export function migratePathsIfNeeded(): void {
    try {
        const plan = planPathsMigration({
            profile: JSON.parse(JSON.stringify(settings.store.profile ?? { name: "default" })),
            soundMeta: JSON.parse(JSON.stringify(settings.store.soundMeta ?? {})),
            migratedPaths: !!settings.store.migratedPaths,
            pathsMigrationBackup: settings.store.pathsMigrationBackup ?? null,
        }, new Date());
        if (!plan) return;
        // The backup goes first: whatever happens next, the old keys stay recoverable.
        if (settings.store.pathsMigrationBackup == null) settings.store.pathsMigrationBackup = plan.pathsMigrationBackup;
        settings.store.profile = plan.profile;
        settings.store.soundMeta = plan.soundMeta;
        settings.store.migratedPaths = true;
        engineClient.configureSoon();
        const dropped = plan.dropped ? `, ${plan.dropped} legacy duplicates dropped` : "";
        olog.info(`soundboard: sounds are now keyed by path (${plan.moved} keys moved into ${plan.profile.sb_folders?.[0] ?? "?"}${dropped})`);
    } catch (e) {
        olog.error("soundboard path migration failed", e);
    }
}

/**
 * Adds a soundboard folder to the profile (sb_folders + sb_folder, deduped by pathKey) and runs the path
 * migration, the same for the folder picker and the default sounds folder. False when it is already listed.
 */
export function addSourceFolder(folder: string): boolean {
    // The live profile, not a copy from before a dialog: it may have changed meanwhile.
    const next = addSource(sourcesOf(settings.store.profile), folder);
    if (!next) return false;
    updateProfile(p => withSources(p, next));
    olog.info(`soundboard folder added: ${folder} (${next.length} folders)`);
    migratePathsIfNeeded(); // older file-name keys move into the first folder once there is one
    return true;
}

/**
 * Once ever: writes the shipped sounds (ping, filthy) to the o2i sounds folder in AppData and adds that folder to the
 * soundboard, unless it was offered before or is already listed. Runs at start after the settings
 * migration; the caller's configure then already has the folder. Never throws.
 */
export async function ensureDefaultSoundsFolder(): Promise<void> {
    try {
        if (settings.store.defaultSoundsAdded) return;
        const dir = await getNative().ensureDefaultSounds();
        if (!dir) return; // native.ts logged why; try again next start
        if (shouldAddDefaultFolder(false, sourcesOf(settings.store.profile), dir)) addSourceFolder(dir);
        settings.store.defaultSoundsAdded = true;
    } catch (e) {
        olog.error("couldn't set up the default sounds folder", e);
    }
}
