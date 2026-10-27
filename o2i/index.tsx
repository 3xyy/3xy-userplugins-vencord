/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { PlainSettings, Settings } from "@api/Settings";
import definePlugin from "@utils/types";

import { discordVersion, vencordVersion } from "./diagnostics";
import { cancelVoiceSelfCheck, resetFallback, restoreDiscordVoice, scheduleVoiceSelfCheck, unwatchDiscordMute, watchDiscordMute } from "./discordVoice";
import { engineClient, setPluginRunning } from "./engineClient";
import { importLegacy } from "./importLegacy";
import { olog } from "./log";
import { migratePluginSettings } from "./logic/migrate";
import { cancelPowerCheck, isPowered, startPower } from "./power";
import { ensureDefaultSoundsFolder, migratePathsIfNeeded, settings } from "./settings";
import { cancelUiSelfCheck, O2iButton, scheduleUiSelfCheck } from "./ui/O2iButton";

/**
 * The plugin was called "o2i" before it became Output2Input. Vencord keeps settings by plugin name, so the
 * old settings (enabled, profile, soundboard names, mute and power state) are copied to the new name once,
 * before Vencord reads them; the old entry stays as a backup. Module scope is fine here: it only touches
 * @api/Settings, which Vencord's own plugins also migrate from at module scope. Existence is checked on the
 * plain settings (Settings fills in defaults for registered plugins); the copy is assigned through Settings
 * so it is saved to settings.json. Never throws.
 */
try {
    if (migratePluginSettings(PlainSettings.plugins, "o2i", "Output2Input", (key, value) => { Settings.plugins[key] = value as typeof Settings.plugins[string]; })) {
        olog.info("settings copied from the old plugin name o2i to Output2Input (the o2i entry is kept as a backup)");
    }
} catch (e) {
    olog.error("couldn't copy the settings from the old plugin name o2i", e);
}

/** Bumped by start()/stop() so a start that is still importing knows it was cancelled. */
let startSeq = 0;

async function boot(seq: number) {
    try {
        await importLegacy();
        if (seq !== startSeq) return;
        // Before the engine starts, so its first configure already has the path keys.
        migratePathsIfNeeded();
        // Once ever: the shipped sounds folder joins the soundboard (also before the first configure).
        await ensureDefaultSoundsFolder();
        if (seq !== startSeq) return;
        // Turned off with the power button: no engine (power on starts it).
        if (isPowered()) await engineClient.start();
    } catch (e) {
        olog.error("start failed", e);
    }
}

/** The first line of every plugin session in plugin.log. */
function logStart() {
    try {
        const v = vencordVersion();
        olog.info(`plugin started (Vencord ${v.version ?? "?"} ${v.gitHash ?? "?"}, Discord ${discordVersion() ?? "?"})`);
    } catch (e) {
        olog.info("plugin started", e);
    }
}

export default definePlugin({
    name: "Output2Input",
    description: "Runs o2i, an audio router for your mic, app audio and a soundboard, and controls it from Discord's account panel",
    authors: [{ name: "3xyy", id: 596844241058267168n }],
    settings,
    // Toggling the plugin must run stop() (engine off, Discord's voice settings restored) right away.
    // The account-panel patch then stays until a restart; the button hides itself while the plugin is off.
    requiresRestart: false,

    patches: [
        {
            // The account panel (bottom left, next to mute / deafen), the same spot as Vencord's GameActivityToggle.
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            predicate: () => IS_DISCORD_DESKTOP,
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.O2iButton(arguments[0]),"
            }
        }
    ],

    O2iButton,

    start() {
        if (!IS_DISCORD_DESKTOP) return;
        logStart();
        setPluginRunning(true);
        scheduleVoiceSelfCheck(); // read-only; starting never changes Discord's voice settings
        scheduleUiSelfCheck(); // read-only: did the account-panel patch and the UI finders work
        watchDiscordMute(); // a Discord self-mute he changes himself is his: o2i never changes it back
        // Turned off with the power button: no engine, and Discord is moved off a stale CABLE input (once).
        // On with a switch back to CABLE still waiting from before a restart: it waits for healthy audio again.
        startPower();
        void boot(++startSeq);
    },

    stop() {
        if (!IS_DISCORD_DESKTOP) return;
        olog.info("plugin stopped");
        setPluginRunning(false); // hides the account-panel button (and so the panel's Fix button)
        startSeq++;
        cancelVoiceSelfCheck();
        cancelUiSelfCheck();
        unwatchDiscordMute();
        cancelPowerCheck(); // also drops a switch back to CABLE still waiting while on (the restore below decides)
        engineClient.stop();
        resetFallback();
        // Discord's settings from before the first fix; without a snapshot, moves Discord off o2i if it may be on it.
        restoreDiscordVoice();
    },
});
