/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The power button. Off stops the engine (no polling, hotkeys, soundboard or fallback controller) and moves
// Discord to the real mic if it may have been listening to o2i; on starts the engine again and, if Discord
// was on CABLE Output at power off, leaves it on the real mic until o2i's audio has been healthy for a
// moment, then the fallback controller's recovery switches it back (never a silent gap). Kept in the
// `powered` setting, so o2i stays off across restarts; a plugin start while off moves Discord off a stale
// CABLE input once its devices are listed. Whenever Discord goes to the real mic here while o2i's mic is
// muted, Discord is self-muted first (discordVoice.ts `muteForRealMic`), and its own mute comes back once
// it is on o2i again. The decisions are in logic/power.ts. Nothing here throws.

import { showToast } from "@webpack/common";

import {
    armPowerRestore, discordDevicesListed, discordInputId, discordMayBeOnO2i, fallbackToRealMic, forgetSavedDiscordMute, isFallenBack, isPowerRestorePending,
    muteForRealMic, realMicAvailable, realMicName, resetFallback
} from "./discordVoice";
import { engineClient, isPluginRunning } from "./engineClient";
import { olog } from "./log";
import { type PowerEvent, type PowerFacts, type PowerPlan, type PowerState, powerTransition, restoreDropped } from "./logic/power";
import { settings } from "./settings";

/** `muted`: ", muted" when Discord was self-muted because o2i's mic is muted. */
const offToast = (muted: string | null) => `o2i is off. You're on your real mic${muted ?? ""}`;
const PICK_MIC_TOAST = "o2i is off. Pick your real mic in Discord's Voice settings";
const PICK_MIC_TOAST_MS = 6000;

/** Plugin start: Discord's input is first judged after this, then every second until its devices are listed. */
const START_CHECK_FIRST_MS = 3000;
const START_CHECK_RETRY_MS = 1000;
/** ~22 s in all; after that the check runs with whatever Discord lists. */
const START_CHECK_MAX_TRIES = 20;

let startCheckTimer: ReturnType<typeof setTimeout> | null = null;

/** o2i is turned on (the default). */
export function isPowered(): boolean {
    return settings.store.powered !== false;
}

/** For components: o2i is turned on; re-renders when it is turned on or off. */
export function usePowered(): boolean {
    return settings.use(["powered"]).powered !== false;
}

function toast(text: string, variant: "success" | "critical", duration?: number) {
    try {
        showToast({ text, variant, duration });
    } catch (e) {
        olog.error("toast failed", e);
    }
}

function powerState(): PowerState {
    return { powered: isPowered(), restoreCable: !!settings.store.powerRestoreCable, restoreFrom: settings.store.powerRestoreFrom ?? null };
}

function powerFacts(): PowerFacts {
    return {
        onO2i: discordMayBeOnO2i,
        micKnown: realMicAvailable,
        // An ordinary fallback episode; a waiting power-on switch is `restoreCable` (checked against its input).
        fallenBack: isFallenBack() && !isPowerRestorePending(),
        inputId: discordInputId,
    };
}

/**
 * The plan for `event`. When it drops a waiting switch back to CABLE (another mic was picked by hand), a
 * Discord self-mute that is o2i's doing becomes his, as in the fallback controller's drop.
 */
function planFor(event: PowerEvent): PowerPlan {
    const state = powerState();
    const facts = powerFacts();
    if (restoreDropped(state, facts)) forgetSavedDiscordMute("another mic was picked by hand");
    return powerTransition(event, state, facts);
}

/** Persists the switch back to CABLE together with the Discord input it belongs to (cleared together). */
function saveRestore(on: boolean, from: string | null) {
    if (!!settings.store.powerRestoreCable !== on) settings.store.powerRestoreCable = on;
    const next = on ? from : null;
    if ((settings.store.powerRestoreFrom ?? null) !== next) settings.store.powerRestoreFrom = next;
}

interface VoiceResult {
    /** What happened, for the log line. */
    log: string;
    /** Discord's input afterwards: what a switch back to CABLE belongs to. */
    input: string | null;
}

/** Carries out the plan's voice change and toast. */
function applyVoice(p: PowerPlan): VoiceResult {
    if (p.voice === "cable-when-healthy") {
        const from = discordInputId();
        armPowerRestore(from);
        return { log: "Discord stays on the real mic until o2i's audio runs, then goes back to CABLE Output", input: from };
    }
    if (p.voice === "real-mic") {
        // Self-muted before the switch (also when it fails: Discord's Default entry may be the real mic).
        const muted = muteForRealMic("o2i is off, switching to the real mic");
        const id = fallbackToRealMic(realMicName());
        if (id != null) {
            if (p.toast === "off-real-mic") toast(offToast(muted), "success");
            return { log: "Discord was on o2i: switched it to the real mic (back to CABLE Output after power on)", input: id };
        }
        toast(PICK_MIC_TOAST, "critical", PICK_MIC_TOAST_MS);
        return { log: "Discord was on o2i but couldn't be switched to the real mic; asked to pick one", input: discordInputId() };
    }
    const input = discordInputId();
    if (p.toast === "pick-mic") {
        muteForRealMic("o2i is off and Discord's input may be the real mic");
        toast(PICK_MIC_TOAST, "critical", PICK_MIC_TOAST_MS);
        return { log: "Discord may be on o2i but no real mic is known; asked to pick one", input };
    }
    if (p.powered) return { log: "Discord's voice settings left as they are", input };
    return {
        log: p.restoreCable
            ? "Discord isn't on o2i (back to CABLE Output after power on, unless another mic is picked)"
            : "Discord isn't on o2i; its voice settings left as they are",
        input,
    };
}

function cancelStartCheck() {
    if (startCheckTimer) clearTimeout(startCheckTimer);
    startCheckTimer = null;
}

/**
 * Turns o2i off or on (the power buttons). Off: the fallback controller and unset watcher stop with the
 * engine (so nothing toasts "o2i stopped"), then Discord moves to the real mic if it may be on o2i; that
 * voice change is attempted even if anything before it failed. On: the normal engine start; a switch back to
 * CABLE Output waits for healthy audio (see logic/power.ts). Does nothing when o2i already is in that state.
 */
export function setPowered(on: boolean): void {
    const event: PowerEvent = on ? "on" : "off";
    let p: PowerPlan;
    try {
        if (!IS_DISCORD_DESKTOP || !isPluginRunning()) {
            // Vencord shows the settings page for a disabled plugin too: only save it; its next start acts on it.
            if (isPowered() === on) return;
            settings.store.powered = on;
            olog.info(`power ${event} (plugin not running: saved for its next start)`);
            return;
        }
        p = planFor(event);
    } catch (e) {
        olog.error(`power ${event} failed`, e);
        return;
    }
    if (p.engine === "none") return; // already in that state

    let steps = "";
    try {
        cancelStartCheck(); // this transition handles Discord's voice
        settings.store.powered = p.powered; // first: engineClient.start() refuses while it is false
        if (p.engine === "stop") {
            engineClient.stop(); // polling (the fallback controller) and the unset watcher stop before the engine
            resetFallback(); // turning off is intentional: no episode, no recovery onto CABLE
        }
    } catch (e) {
        olog.error(`power ${event}: saving the state or stopping the engine failed`, e);
        steps = " (with errors)";
    }

    // Its own try: after a power off Discord must never be left on CABLE Output, whatever failed above.
    let voice: VoiceResult;
    try {
        voice = applyVoice(p);
    } catch (e) {
        olog.error(`power ${event}: changing Discord's voice settings failed`, e);
        voice = { log: "changing Discord's voice settings failed", input: null };
    }
    // After the voice change: the switch back to CABLE belongs to the input Discord is on now.
    try {
        saveRestore(p.restoreCable, voice.input ?? discordInputId());
    } catch (e) {
        olog.error(`power ${event}: saving the switch back to CABLE failed`, e);
        steps = " (with errors)";
    }

    if (p.engine === "start") engineClient.start().catch(e => olog.error("power on: engine start failed", e));
    olog.info(`power ${event}${steps}: ${p.engine === "stop" ? "engine stopped, hotkeys off" : "starting the engine"}; ${voice.log}`);
}

/**
 * Plugin start (index.tsx). While off: no engine; once Discord has listed its input devices, a Discord still
 * on o2i (switched back by hand, or a switch that failed) is moved to the real mic, as at power off, so a
 * stale CABLE input can't leave him silent. While on with a switch back to CABLE still waiting (Discord quit
 * before o2i's audio ran): it waits for healthy audio again, unless Discord has been put on another mic
 * meanwhile (then the switch is dropped). While off, the same change drops the switch due at power on.
 */
export function startPower(): void {
    const powered = isPowered();
    if (!powered) olog.info("o2i is turned off (power button): engine not started");
    else if (!settings.store.powerRestoreCable) return;
    cancelStartCheck();
    let tries = 1;
    const check = () => {
        startCheckTimer = null;
        try {
            // Turned on / off meanwhile (that transition handled Discord) or the plugin stopped.
            if (isPowered() !== powered || !isPluginRunning()) return;
            if (!discordDevicesListed() && tries++ < START_CHECK_MAX_TRIES) {
                startCheckTimer = setTimeout(check, START_CHECK_RETRY_MS);
                return;
            }
            const p = planFor("start");
            const voice = applyVoice(p);
            saveRestore(p.restoreCable, voice.input);
            olog.info(`power: ${powered ? "on" : "off"} at start; ${voice.log}`);
        } catch (e) {
            olog.error("power: the start check failed", e);
        }
    };
    startCheckTimer = setTimeout(check, START_CHECK_FIRST_MS);
}

/**
 * Plugin stop: drops a pending start check and, while on, a switch back to CABLE that still waits (the
 * restore on disable decides Discord's voice now). While off nothing changes: power on still restores CABLE.
 */
export function cancelPowerCheck(): void {
    cancelStartCheck();
    try {
        if (isPowered()) saveRestore(false, null);
    } catch (e) {
        olog.error("power: clearing the waiting CABLE switch failed", e);
    }
}
