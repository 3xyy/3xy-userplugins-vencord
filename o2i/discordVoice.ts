/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Discord's own voice settings: the one-click fix (input = CABLE Output, Discord's processing off),
// the engine-down fallback to the real mic and its recovery, and the restore on disable.
// These are the only places o2i changes Discord's voice settings: `applyO2iVoice` (via
// `fixDiscordVoice` for the Fix button, and recovery, which also does power on's switch back to CABLE
// Output: `armPowerRestore`), `fallbackToRealMic` (fallback during a call, power off) and
// `restoreDiscordVoice` (plugin stop). Discord's self-mute is only changed by the fallback's mute rule
// (`fallbackMuteDecision`): whenever Discord goes to the real mic while o2i's mic is muted it is
// self-muted first (`muteForRealMic`: fallback, power off, power on's wait, plugin stop, and his own move
// off CABLE Output: `checkInputChange`), o2i's mute changing moves it along (`followO2iMute`), and
// Discord's own mute comes back once Discord has been surely on CABLE for a second (`muteRestoreDue`).
// A self-mute he changes himself is his: it is never
// touched again (`watchDiscordMute`). Those changes are silent: the plugin plays its own mute sound once
// per change of o2i's mute. Exported functions never throw (except `readDiscordVoice`).
// The fallback and restore only ever move Discord to a *named* real mic, never to CABLE Output or
// Discord's "Default" entry (which may be CABLE Output); without one they tell the user to pick it.

import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, MediaEngineStore, showToast } from "@webpack/common";

import { discordSoundsStatus } from "./discordSounds";
import { olog } from "./log";
import {
    defaultInputId, episodeCheck, fallbackDecision, fallbackMuteDecision, inputChangeTransition, isOwnInputSwitch, mayBeOnO2i, muteRestoreDue, namedDevicesListed,
    o2iMuteTransition, onCableExactly, pickFallbackMic, pickRealMic, pttModeTransition, savedAfterHandChange
} from "./logic/fallback";
import { type Dev, findCableOutput } from "./logic/match";
import type { AudioStatus, EngineStatus } from "./logic/policy";
import { restoreCheck } from "./logic/power";
import { isPttMode } from "./logic/profile";
import { effectiveMicMuted, subscribeMuteSupport } from "./micMuteState";
import { settings } from "./settings";
import type { DiscordVoiceSnapshot } from "./types";

export type { DiscordVoiceSnapshot } from "./types";

/** `location` passed to Discord's setters / Flux actions (Discord uses it for analytics only). */
const LOCATION = "o2i";
const SELF_CHECK_DELAY_MS = 3000;
const FALLBACK_TOAST_MS = 6000;
const PICK_MIC_TOAST = "o2i stopped. Pick your real mic in Discord's Voice settings";

type ActionName = "setInputDevice" | "setNoiseCancellation" | "setNoiseSuppression" | "setEchoCancellation" | "setAutomaticGainControl" | "setSelfMute";

/** What each setter dispatches; used directly when Discord's voice-actions module can't be found. */
const FLUX_ACTION: Record<ActionName, string> = {
    setInputDevice: "AUDIO_SET_INPUT_DEVICE",
    setNoiseCancellation: "AUDIO_SET_NOISE_CANCELLATION",
    setNoiseSuppression: "AUDIO_SET_NOISE_SUPPRESSION",
    setEchoCancellation: "AUDIO_SET_ECHO_CANCELLATION",
    setAutomaticGainControl: "AUDIO_SET_AUTOMATIC_GAIN_CONTROL",
    setSelfMute: "AUDIO_SET_SELF_MUTE",
};

/** Discord's default media context (its self-mute is per context; the voice call uses this one). */
const MEDIA_CONTEXT = "default";

const VoiceActions: Partial<Record<ActionName, (...args: unknown[]) => unknown>> =
    findByPropsLazy("setNoiseSuppression", "setEchoCancellation", "setInputDevice");

type Flags = Pick<DiscordVoiceSnapshot, "noiseSuppression" | "noiseCancellation" | "echoCancellation" | "agc">;

const O2I_FLAGS: Flags = { noiseSuppression: false, noiseCancellation: false, echoCancellation: false, agc: false };

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// ---- reading Discord's settings ----

/** Discord's current voice settings. Throws if MediaEngineStore is unavailable (callers here catch). */
export function readDiscordVoice(): DiscordVoiceSnapshot {
    return {
        inputDeviceId: String(MediaEngineStore.getInputDeviceId()),
        noiseSuppression: !!MediaEngineStore.getNoiseSuppression(),
        noiseCancellation: !!MediaEngineStore.getNoiseCancellation(),
        echoCancellation: !!MediaEngineStore.getEchoCancellation(),
        agc: !!MediaEngineStore.getAutomaticGainControl(),
    };
}

/** Throws if MediaEngineStore is unavailable. Disabled devices are left out. */
function readInputDevices(): Dev[] {
    return Object.values(MediaEngineStore.getInputDevices() ?? {})
        .filter(d => d && !d.disabled)
        .map(d => ({ id: String(d.id), name: String(d.name ?? "") }));
}

let devicesErrorLogged = false;

/** Discord's input devices (ids are Discord's own, not the engine's WASAPI ids); [] if unavailable. */
export function discordInputDevices(): Dev[] {
    try {
        const devs = readInputDevices();
        devicesErrorLogged = false;
        return devs;
    } catch (e) {
        if (!devicesErrorLogged) {
            devicesErrorLogged = true;
            olog.error("couldn't read Discord's input devices", e);
        }
        return [];
    }
}

function deviceName(devs: Dev[], id: string): string {
    return devs.find(d => d.id === id)?.name ?? id;
}

/** Discord may be listening to o2i: input is CABLE Output or Discord's Default entry. */
export function discordMayBeOnO2i(): boolean {
    try {
        return mayBeOnO2i(String(MediaEngineStore.getInputDeviceId()), discordInputDevices());
    } catch {
        return false;
    }
}

/** Discord's current input device id (its own id, not the engine's); null when it can't be read. */
export function discordInputId(): string | null {
    try {
        return String(MediaEngineStore.getInputDeviceId());
    } catch {
        return null;
    }
}

/** Discord has enumerated its input devices (shortly after Discord starts it may list only "Default"). */
export function discordDevicesListed(): boolean {
    return namedDevicesListed(discordInputDevices());
}

/**
 * Name of o2i's microphone (profile.input_id) as the engine last reported it. Persisted in the hidden
 * `realMic` setting, so it is known after a Discord restart even when no engine runs. "" when unknown.
 */
export function realMicName(): string {
    const id = settings.store.profile?.input_id;
    const known = settings.store.realMic;
    return id && known?.inputId === id ? known.name : "";
}

/** `fallbackToRealMic(realMicName())` would find a device to switch Discord to. */
export function realMicAvailable(): boolean {
    try {
        return pickFallbackMic(discordInputDevices(), realMicName(), settings.store.discordSnapshot?.inputDeviceId) != null;
    } catch {
        return false;
    }
}

let fixCheckErrorLogged = false;

/** Whether Discord needs the one-click fix: input isn't CABLE Output, or any of Discord's processing is on. */
export function needsO2iFix(): { needed: boolean; cableMissing: boolean; } {
    try {
        const cable = findCableOutput(readInputDevices());
        const v = readDiscordVoice();
        const needed = v.inputDeviceId !== cable || v.noiseSuppression || v.noiseCancellation || v.echoCancellation || v.agc;
        fixCheckErrorLogged = false;
        return { needed, cableMissing: cable == null };
    } catch (e) {
        if (!fixCheckErrorLogged) {
            fixCheckErrorLogged = true;
            olog.error("couldn't read Discord's voice settings", e);
        }
        return { needed: false, cableMissing: false };
    }
}

// ---- changing Discord's settings ----

function voiceModule(): typeof VoiceActions | null {
    try {
        // Throws when the lazy find found nothing (property access on null).
        return typeof VoiceActions.setInputDevice === "function" ? VoiceActions : null;
    } catch {
        return null;
    }
}

let loggedPath: "module" | "flux" | null = null;
/**
 * Setters whose module call threw last time. Recovery retries every tick while it fails, so a failure is
 * logged once per streak (cleared when that setter works again).
 */
const failingSetters = new Set<ActionName>();
/** The input device o2i last asked Discord for (`at`: performance.now()): the input-change listener never takes that switch for his. */
let requestedInput: { id: string; at: number; } | null = null;

function dispatchFlux(type: string, payload: Record<string, unknown>) {
    const res = FluxDispatcher.dispatch({ type, ...payload, location: LOCATION } as Parameters<typeof FluxDispatcher.dispatch>[0]);
    void Promise.resolve(res).catch(e => olog.error(`${type} dispatch failed`, e));
}

function setters() {
    const mod = voiceModule();
    const path = mod ? "module" : "flux";
    if (loggedPath !== path) {
        loggedPath = path;
        olog.info(path === "module"
            ? "voice actions: using Discord's voice-actions module"
            : "voice actions: voice-actions module not found, dispatching Flux actions directly");
    }
    const act = (name: ActionName, args: unknown[], payload: Record<string, unknown>) => {
        const fn = mod?.[name];
        if (typeof fn === "function") {
            try {
                fn(...args);
                failingSetters.delete(name);
                return;
            } catch (e) {
                if (!failingSetters.has(name)) olog.error(`${name} failed, dispatching ${FLUX_ACTION[name]} instead (logged once until it works again)`, e);
                failingSetters.add(name);
            }
        }
        dispatchFlux(FLUX_ACTION[name], payload);
    };
    return {
        inputDevice: (id: string) => {
            // Before the call: Discord's store can report the new input while the setter is still running.
            requestedInput = { id, at: performance.now() };
            act("setInputDevice", [id], { id });
        },
        noiseCancellation: (on: boolean) => act("setNoiseCancellation", [on, LOCATION], { enabled: on }),
        noiseSuppression: (on: boolean) => act("setNoiseSuppression", [on, LOCATION], { enabled: on }),
        echoCancellation: (on: boolean) => act("setEchoCancellation", [on, LOCATION], { enabled: on }),
        agc: (on: boolean) => act("setAutomaticGainControl", [on, LOCATION], { enabled: on }),
        // setSelfMute(context, mute, playSoundEffect): false makes Discord skip its mute / unmute sound.
        selfMute: (on: boolean) => act("setSelfMute", [MEDIA_CONTEXT, on, false], { context: MEDIA_CONTEXT, mute: on, playSoundEffect: false }),
    };
}

type Setters = ReturnType<typeof setters>;

/** Noise cancellation (Krisp) first: Discord's setNoiseCancellation also sets noise suppression to `!enabled`. */
function applyFlags(s: Setters, f: Flags) {
    s.noiseCancellation(f.noiseCancellation);
    s.noiseSuppression(f.noiseSuppression);
    s.echoCancellation(f.echoCancellation);
    s.agc(f.agc);
}

function describe(v: Flags): string {
    return `ns=${v.noiseSuppression} krisp=${v.noiseCancellation} ec=${v.echoCancellation} agc=${v.agc}`;
}

let cableMissingLogged = false;
/** applyO2iVoice threw last time (recovery retries it every tick): log once per failure streak. */
let applyFailing = false;

/**
 * The one-click fix: snapshots Discord's settings (first time only), turns Discord's processing off and
 * sets the input to CABLE Output. Returns false, changing nothing, when CABLE Output isn't in Discord's list.
 */
export function applyO2iVoice(): boolean {
    try {
        const devs = discordInputDevices();
        const cable = findCableOutput(devs);
        if (!cable) {
            if (!cableMissingLogged) {
                cableMissingLogged = true;
                olog.warn("CABLE Output isn't in Discord's input devices; Discord's voice settings left as they are");
            }
            return false;
        }
        cableMissingLogged = false;

        if (!settings.store.discordSnapshot) {
            const snap = readDiscordVoice();
            settings.store.discordSnapshot = snap;
            olog.info(`saved Discord's voice settings (input "${deviceName(devs, snap.inputDeviceId)}", ${describe(snap)})`);
        }

        const s = setters();
        applyFlags(s, O2I_FLAGS);
        s.inputDevice(cable);
        applyFailing = false;
        olog.info("Discord voice: input = CABLE Output, Discord's processing off");
        return true;
    } catch (e) {
        if (!applyFailing) olog.error("applyO2iVoice failed (logged once until it works again)", e);
        applyFailing = true;
        return false;
    }
}

function toast(text: string, variant: "success" | "critical", duration?: number) {
    try {
        showToast({ text, variant, duration });
    } catch (e) {
        olog.error("toast failed", e);
    }
}

/**
 * Switches Discord's input to the real mic and, if a snapshot exists, re-applies Discord's original
 * processing. The real mic is o2i's input device matched by name (never CABLE Output or Discord's Default
 * entry) or, without a match, Discord's original input from the snapshot if that is a named real mic.
 * Returns the device id it switched to, or null (warning logged, nothing changed) when neither gives a device.
 */
export function fallbackToRealMic(realMicName: string): string | null {
    try {
        const devs = discordInputDevices();
        const snap = settings.store.discordSnapshot;
        const id = pickFallbackMic(devs, realMicName, snap?.inputDeviceId);
        if (!id) {
            olog.warn(realMicName
                ? `no Discord input device matches o2i's microphone "${realMicName}"; Discord's input left as it is`
                : "o2i's microphone is unknown (no engine has reported it); Discord's input left as it is");
            return null;
        }
        const s = setters();
        s.inputDevice(id);
        if (snap) applyFlags(s, snap);
        olog.info(`Discord voice: input = "${deviceName(devs, id)}"${snap ? `, processing restored (${describe(snap)})` : ""}`);
        return id;
    } catch (e) {
        olog.error("fallbackToRealMic failed", e);
        return null;
    }
}

/**
 * Puts back Discord's settings from before the first fix (device + processing) and forgets the snapshot.
 * The engine stops with the plugin, so a saved input that may be o2i (CABLE Output, or Default) is
 * replaced by the named real mic; without one it is restored as it was and the user is told to pick a mic.
 * Without a snapshot (Discord was put on o2i by hand), Discord is moved to the real mic if it may be on o2i.
 */
export function restoreDiscordVoice(): void {
    try {
        const snap = settings.store.discordSnapshot;
        if (!snap) {
            if (!discordMayBeOnO2i()) return;
            const muted = muteForRealMic("o2i is turned off");
            if (fallbackToRealMic(realMicName()) == null) {
                olog.warn("Discord's input may be o2i's CABLE Output (no saved settings) and no real mic could be picked");
                toast(PICK_MIC_TOAST, "critical", FALLBACK_TOAST_MS);
            } else if (muted) {
                toast(`o2i is off. You're on your real mic${muted}`, "success");
            }
            return;
        }
        const devs = discordInputDevices();
        // An unplugged original device: use Discord's Default entry instead of an id Discord doesn't know.
        let id = devs.length && !devs.some(d => d.id === snap.inputDeviceId)
            ? defaultInputId(devs) ?? snap.inputDeviceId
            : snap.inputDeviceId;
        let pickMic = false;
        if (mayBeOnO2i(id, devs)) {
            const real = pickRealMic(devs, realMicName());
            if (real) id = real;
            else pickMic = true;
        }
        // First: without the engine o2i's mute is gone, and the restored input may be the real mic.
        const muted = muteForRealMic("o2i is turned off");
        const s = setters();
        s.inputDevice(id);
        applyFlags(s, snap);
        settings.store.discordSnapshot = null;
        olog.info(`restored Discord's voice settings (input "${deviceName(devs, id)}", ${describe(snap)})`);
        if (pickMic) {
            olog.warn("Discord's restored input may be o2i's CABLE Output and o2i's microphone is unknown");
            toast(PICK_MIC_TOAST, "critical", FALLBACK_TOAST_MS);
        } else if (muted) {
            toast(`o2i is off. You're on your real mic${muted}`, "success");
        }
    } catch (e) {
        olog.error("restoreDiscordVoice failed", e);
    }
}

// ---- fallback controller (run by engineClient on every tick) ----

export interface FallbackTick {
    inCall: boolean;
    engine: EngineStatus;
    audio: AudioStatus | null;
    msSinceAudioWanted: number;
}

let fallenBack = false;
/** This episode's fallback has been seen to move Discord off o2i (see `episodeCheck`). */
let seenOff = false;
let healthySince: number | null = null;
let recoverBlockedLogged = false;
let controllerFailing = false;
/**
 * The current episode is a power-on restore (power.ts `armPowerRestore`): Discord sits on the real mic and
 * goes to CABLE Output once o2i's audio has been healthy, with its own log line and toast.
 */
let powerRestore = false;
/** Discord's input when the power-on restore was armed: any other non-o2i device picked meanwhile drops it. */
let powerRestoreFrom: string | null = null;
/** When Discord was last seen back on o2i with a saved self-mute to put back (see `muteRestoreDue`). */
let muteRestoreSince: number | null = null;

/**
 * Discord's self-mute from before the mute rule self-muted it (setting `savedDiscordMute`, so power off
 * and on, plugin restarts and Discord restarts still put it back); null when the rule hasn't changed it.
 */
function savedMute(): boolean | null {
    const v = settings.store.savedDiscordMute;
    return typeof v === "boolean" ? v : null;
}

function saveMute(v: boolean | null) {
    if (savedMute() !== v) settings.store.savedDiscordMute = v;
}

/**
 * Discord's own self-mute flag (its mute button), from its voice settings. isSelfMute() is only the
 * fallback: it is also true while deafened, without mic permission or with voice turned off. False when
 * neither can be read.
 */
function discordSelfMuted(): boolean {
    try {
        const mute = MediaEngineStore.getSettings()?.mute;
        if (typeof mute === "boolean") return mute;
        return MediaEngineStore.isSelfMute() === true;
    } catch {
        return false;
    }
}

/** Discord has listed its devices and its input is exactly CABLE Output (never Default or its start-up placeholder). */
function discordOnCable(): boolean {
    try {
        return onCableExactly(discordInputId(), discordInputDevices());
    } catch {
        return false;
    }
}

/** How long a self-mute o2i asked for may take to show in Discord's store (a dispatch can be queued). */
const SELF_MUTE_APPLY_MS = 2000;
/** The self-mute o2i last asked Discord for (`at`: performance.now()), until Discord shows it: the change listener never takes it for his. */
let requestedSelfMute: { value: boolean; at: number; } | null = null;
let watchingDiscordMute = false;
/** o2i's effective mute as `followO2iMute` last handled it (null: not yet). */
let lastEffectiveMute: boolean | null = null;
let unsubscribeMuteSupport: (() => void) | null = null;

/** The engine's mute support changed (old o2i.exe and new): if that flips o2i's effective mute, Discord follows. */
function onMuteSupportChange() {
    try {
        const eff = effectiveMicMuted();
        if (eff !== lastEffectiveMute) followO2iMute(eff);
    } catch (e) {
        olog.error("couldn't follow a change of the engine's mute support", e);
    }
}

/** Discord's input as the input-change listener last saw it (undefined: not watching). */
interface SeenInput {
    id: string | null;
    /** Exactly CABLE Output (`onCableExactly`). */
    onCable: boolean;
    /** Discord had listed its devices (before that "on CABLE" can't be known). */
    listed: boolean;
}
let seenInput: SeenInput | undefined;

function readInput(): SeenInput {
    const id = discordInputId();
    const devs = discordInputDevices();
    return { id, onCable: onCableExactly(id, devs), listed: namedDevicesListed(devs) };
}

/**
 * Discord's input changed. Moved off exactly CABLE Output while o2i's mic is muted, and not by o2i (the
 * fallback, power and restore paths apply the mute rule themselves), Discord may now be on the real mic,
 * which o2i's mute can't reach: `inputChangeTransition` runs once, so Discord is self-muted (silently, its own
 * mute saved; o2i's unmute lifts it). Not while o2i is turned off. Only on an input change, never per tick.
 * Discord's store also changes for many other reasons, so nothing else is read while the input stays the same.
 */
function checkInputChange() {
    const prev = seenInput;
    if (prev === undefined) return;
    try {
        if (discordInputId() === prev.id && prev.listed) return;
        const now = readInput();
        seenInput = now;
        if (now.id === prev.id) return; // only Discord's device list arrived: learnt, not a change
        const ownSwitch = isOwnInputSwitch(requestedInput, now.id, performance.now());
        if (ownSwitch) requestedInput = null;
        const t = inputChangeTransition({
            wasOnCable: prev.onCable,
            onCable: now.onCable,
            ownSwitch,
            muted: effectiveMicMuted(),
            saved: savedMute(),
            powered: settings.store.powered !== false,
        });
        if (t === "mute-discord") muteForRealMic("Discord's input was moved off CABLE Output");
    } catch { /* a store listener never throws */ }
}

/** Discord unmuted while o2i's self-mute is saved: he did it himself, so it is his from now on (`savedAfterHandChange`). */
function checkHandUnmute() {
    try {
        const saved = savedMute();
        if (saved === null) return;
        const muted = discordSelfMuted();
        if (requestedSelfMute) {
            // o2i's own change not applied yet: nothing to judge until it is (or it is clearly not coming).
            if (muted !== requestedSelfMute.value && performance.now() - requestedSelfMute.at < SELF_MUTE_APPLY_MS) return;
            requestedSelfMute = null;
        }
        if (savedAfterHandChange(saved, muted) === null) {
            saveMute(null);
            muteRestoreSince = null;
            olog.info("Discord was unmuted by hand; o2i won't change Discord's mute again until it mutes it itself");
        }
    } catch { /* a store listener never throws */ }
}

/** Discord's voice settings changed: his own unmute, and his own move off CABLE Output while o2i is muted. */
function onDiscordVoiceChange() {
    checkHandUnmute();
    checkInputChange();
}

/**
 * Plugin start: notices right away when he unmutes Discord himself or moves its input off CABLE Output
 * (Discord's voice settings change), and when a change of the engine's mute support flips o2i's effective mute.
 */
export function watchDiscordMute(): void {
    if (watchingDiscordMute) return;
    lastEffectiveMute = effectiveMicMuted();
    unsubscribeMuteSupport ??= subscribeMuteSupport(onMuteSupportChange);
    try {
        seenInput = readInput();
        MediaEngineStore.addChangeListener(onDiscordVoiceChange);
        watchingDiscordMute = true;
    } catch (e) {
        seenInput = undefined;
        olog.error("couldn't watch Discord's voice settings; an unmute by hand is noticed on the next tick, an input change while muted isn't", e);
    }
}

export function unwatchDiscordMute(): void {
    unsubscribeMuteSupport?.();
    unsubscribeMuteSupport = null;
    lastEffectiveMute = null;
    seenInput = undefined;
    requestedInput = null;
    if (!watchingDiscordMute) return;
    watchingDiscordMute = false;
    try {
        MediaEngineStore.removeChangeListener(onDiscordVoiceChange);
    } catch { /* already gone */ }
}

/** Forgets o2i's saved self-mute: Discord stays as it is, and its mute is his from now on. */
export function forgetSavedDiscordMute(why: string): void {
    try {
        if (savedMute() === null) return;
        saveMute(null);
        muteRestoreSince = null;
        olog.info(`Discord stays self-muted (${why}); unmute it in Discord when you want`);
    } catch (e) {
        olog.error("couldn't forget Discord's saved mute", e);
    }
}

/**
 * Applies the fallback's mute rule for `phase` (silently) and returns its toast suffix. o2i's mute is the
 * effective one (micMuteState.ts: never muted while the engine can't mute). Never throws.
 */
function applyMuteRule(phase: "fallback" | "recover", why: string): string | null {
    try {
        const d = fallbackMuteDecision(effectiveMicMuted(), discordSelfMuted(), phase, savedMute(), isPttMode(settings.store.profile));
        saveMute(d.saveDiscordMute);
        if (d.setDiscordMute !== null) {
            requestedSelfMute = { value: d.setDiscordMute, at: performance.now() };
            setters().selfMute(d.setDiscordMute);
            olog.info(phase === "fallback"
                ? `Discord self-muted: ${why} while o2i's mic is muted or in push to talk`
                : `Discord's own mute put back (${d.setDiscordMute ? "muted" : "unmuted"}): ${why}`);
        }
        return d.toastSuffix;
    } catch (e) {
        olog.error("couldn't change Discord's self-mute", e);
        return null;
    }
}

/**
 * Call right before Discord goes to (or is left on) the real mic, which o2i's mute can't reach: while
 * o2i's mic is muted Discord is self-muted (silently), its own mute saved for when it is surely back on CABLE.
 * Returns the toast suffix (", muted") or null. Never throws.
 */
export function muteForRealMic(why: string): string | null {
    muteRestoreSince = null;
    return applyMuteRule("fallback", why);
}

/**
 * A power-on restore is done (Discord is on o2i) or dropped: clears it and the persisted
 * `powerRestoreCable` / `powerRestoreFrom`.
 */
function endPowerRestore() {
    if (!powerRestore) return;
    powerRestore = false;
    powerRestoreFrom = null;
    if (settings.store.powerRestoreCable) settings.store.powerRestoreCable = false;
    if (settings.store.powerRestoreFrom != null) settings.store.powerRestoreFrom = null;
}

function fallBack(t: FallbackTick) {
    fallenBack = true; // one episode (and one toast) until a recovery, whether or not the switch works
    seenOff = false;
    recoverBlockedLogged = false;
    const name = realMicName();
    const why = t.engine === "running" || t.engine === "starting" ? `audio ${t.audio ?? "not started"}` : `engine ${t.engine}`;
    olog.warn(`o2i isn't delivering audio during a call (${why}); switching Discord to the real mic (${name ? `"${name}"` : "unknown"})`);
    // Self-muted before the switch, never after it. Also when the switch fails: Discord's Default entry may be the real mic.
    const muted = muteForRealMic("switching to the real mic");
    const ok = fallbackToRealMic(name) != null;
    toast(ok ? `o2i stopped. You're on your real mic${muted ?? ""}` : PICK_MIC_TOAST, "critical", FALLBACK_TOAST_MS);
}

function recover() {
    if (applyO2iVoice()) {
        // Discord's own mute comes back a second after this (runFallbackController), once it is surely on CABLE.
        fallenBack = false;
        seenOff = false;
        if (powerRestore) {
            endPowerRestore();
            olog.info("power on: o2i's audio is running; Discord switched back to CABLE Output");
            toast("o2i is on. Discord is using o2i's mic again", "success");
        } else {
            olog.info("o2i audio is back; Discord switched back to CABLE Output");
            toast("o2i is back", "success");
        }
    } else if (!recoverBlockedLogged) {
        recoverBlockedLogged = true;
        olog.warn("o2i audio is back but Discord couldn't be switched to CABLE Output; staying on the real mic");
    }
}

export function runFallbackController(t: FallbackTick): void {
    try {
        const now = Date.now();
        checkHandUnmute(); // also when the change listener couldn't be added
        const healthy = t.engine === "running" && t.audio === "running";
        if (healthy) healthySince ??= now;
        else healthySince = null;

        // Another device picked by hand while the power-on switch back to CABLE waits: his choice wins, now
        // and later (the persisted flag goes too), before any recovery in this tick could move him to CABLE.
        if (fallenBack && powerRestore && restoreCheck(powerRestoreFrom, discordInputId(), discordMayBeOnO2i()) === "dropped") {
            fallenBack = false;
            seenOff = false;
            // His own mic choice: a self-mute from o2i's mute stays (never unmuted on a mic o2i doesn't control).
            forgetSavedDiscordMute("another mic was picked by hand");
            endPowerRestore();
            olog.info("Discord was switched to another mic by hand; dropped the power-on switch back to CABLE Output");
        }

        // Discord switched back onto o2i by hand while o2i is still down: end the episode so we can act again.
        const ep = episodeCheck({ fallenBack, healthy, seenOff, onO2i: discordMayBeOnO2i });
        seenOff = ep.seenOff;
        if (ep.reset) {
            fallenBack = false;
            seenOff = false;
            if (powerRestore) {
                endPowerRestore();
                olog.info("Discord was put on o2i by hand before o2i's audio ran; the power-on switch is done, the fallback can act again");
            } else {
                olog.info("Discord was put back on o2i while o2i is still down; the fallback can act again");
            }
        }

        const action = fallbackDecision({
            inCall: t.inCall,
            engine: t.engine,
            audio: t.audio,
            msSinceAudioWanted: t.msSinceAudioWanted,
            msHealthy: healthySince === null ? 0 : now - healthySince,
            fallenBack,
            discordMayBeOnO2i,
            powered: settings.store.powered !== false,
        });
        if (action === "fallback") fallBack(t);
        else if (action === "recover") recover();

        // Surely back on CABLE (recovery, Fix, by hand) with the engine running: Discord's own mute comes back
        // after a second. Never on Discord's Default entry or its start-up placeholder (it may be the real mic).
        const r = muteRestoreDue({
            fallenBack,
            saved: savedMute(),
            engineRunning: t.engine === "running",
            onCable: discordOnCable,
            since: muteRestoreSince,
            now,
        });
        muteRestoreSince = r.since;
        if (r.restore) {
            muteRestoreSince = null;
            applyMuteRule("recover", "Discord is back on CABLE Output");
        }
        controllerFailing = false;
    } catch (e) {
        // Runs every tick: log the first failure of a streak only.
        if (!controllerFailing) olog.error("fallback controller failed", e);
        controllerFailing = true;
    }
}

/**
 * The panel's Fix button. Applies o2i's voice settings and, when that worked, ends any fallback episode
 * (a waiting power-on restore too), so the next tick falls back again if o2i is still down (instead of
 * leaving the user on a silent CABLE). When it fails nothing was changed, so a running episode (and its
 * pending recovery) is kept.
 */
export function fixDiscordVoice(): boolean {
    const wasFallenBack = fallenBack;
    const ok = applyO2iVoice();
    if (ok) {
        fallenBack = false;
        seenOff = false;
        healthySince = null;
        recoverBlockedLogged = false;
        endPowerRestore();
    }
    olog.info(ok
        ? `Fix pressed: Discord switched to CABLE Output${wasFallenBack ? " (ended the fallback episode)" : ""}`
        : "Fix pressed: couldn't switch Discord to CABLE Output (nothing changed)");
    return ok;
}

/** Discord is currently fallen back to the real mic because o2i isn't delivering audio (or a power-on restore waits). */
export function isFallenBack(): boolean {
    return fallenBack;
}

/**
 * o2i's effective mute changed (engineClient on every mute change, and a change of the engine's mute
 * support); silent, the caller plays the sound. By `o2iMuteTransition`, in or out of an episode:
 * - muted while Discord isn't surely on CABLE: self-muted (its own mute saved), since Discord may be on
 *   the real mic, which o2i's mute can't reach;
 * - unmuted: a Discord self-mute that is o2i's doing is lifted right away. A mute he set himself is never
 *   touched.
 * Only on a change, never per tick, so a deliberate unmute by hand stays. Never throws.
 */
export function followO2iMute(muted: boolean): void {
    try {
        lastEffectiveMute = muted;
        checkHandUnmute();
        const t = o2iMuteTransition(muted, discordOnCable, savedMute(), isPttMode(settings.store.profile));
        if (t === "mute-discord") {
            muteForRealMic("o2i's mic was muted while Discord isn't on CABLE Output");
        } else if (t === "lift") {
            muteRestoreSince = null;
            applyMuteRule("recover", "o2i's mic was unmuted");
        }
    } catch (e) {
        olog.error("couldn't apply o2i's mute to Discord", e);
    }
}

/**
 * The mic mode changed (settings.ts `updateProfile`); silent. Entering push to talk while Discord isn't surely
 * on CABLE self-mutes it (its own mute saved); leaving it lifts o2i's self-mute (`pttModeTransition`).
 * Does nothing while the plugin isn't watching (stopped) or o2i is off. Never throws.
 */
export function followPttMode(ptt: boolean): void {
    try {
        if (!watchingDiscordMute || settings.store.powered === false) return;
        const t = pttModeTransition(ptt, effectiveMicMuted(), discordOnCable, savedMute());
        if (t === "mute-discord") {
            muteForRealMic("push to talk was turned on while Discord isn't on CABLE Output");
        } else if (t === "lift") {
            muteRestoreSince = null;
            applyMuteRule("recover", "push to talk was turned off");
        }
    } catch (e) {
        olog.error("couldn't apply the mic mode to Discord", e);
    }
}

/** Discord is on the real mic after power on, waiting for o2i's audio to be healthy before going to CABLE Output. */
export function isPowerRestorePending(): boolean {
    return fallenBack && powerRestore;
}

/**
 * Power on (or a plugin start while on) with Discord to go back to CABLE Output: Discord is on the real mic
 * now, so this starts a fallen-back episode and the controller's recovery switches it to CABLE once o2i's
 * audio has been healthy for RECOVER_STABLE_MS. Never sooner (never silent), never at all if the engine
 * doesn't get healthy; no fallback while it waits (Discord isn't on o2i). `seenOff`: Discord was checked to be
 * off o2i, so putting it on o2i by hand while o2i is down ends the wait and the normal fallback applies again.
 * `from`: Discord's input now; picking any other non-o2i device while it waits drops the restore (each tick).
 */
export function armPowerRestore(from: string | null): void {
    // Discord waits on the real mic: self-muted while o2i's mic is muted (power on, or a restart while it waits).
    muteForRealMic("Discord waits on the real mic until o2i's audio runs");
    fallenBack = true;
    seenOff = true;
    healthySince = null;
    recoverBlockedLogged = false;
    powerRestore = true;
    powerRestoreFrom = from;
}

/**
 * Plugin stop / power off: forget the current episode. A waiting power-on restore is forgotten here but its
 * persisted `powerRestoreCable` / `powerRestoreFrom` stay (power.ts decides: kept on power off, cleared on plugin stop while on).
 */
export function resetFallback(): void {
    // A saved self-mute stays saved (persisted): it comes back once Discord is on o2i again (power on).
    muteRestoreSince = null;
    fallenBack = false;
    seenOff = false;
    healthySince = null;
    recoverBlockedLogged = false;
    powerRestore = false;
    powerRestoreFrom = null;
}

// ---- startup self-check ----

let selfCheckTimer: ReturnType<typeof setTimeout> | null = null;

function voiceSelfCheck() {
    try {
        const actions = voiceModule() ? "module" : "flux fallback";
        let store: string;
        try {
            const v = readDiscordVoice();
            const devs = readInputDevices();
            const cable = findCableOutput(devs);
            store = `ok (${devs.length} inputs, Default entry ${defaultInputId(devs) ? "yes" : "no"}, `
                + `CABLE Output ${cable ? "found" : "missing"}, input ${v.inputDeviceId === cable ? "is" : "is not"} CABLE Output, ${describe(v)})`;
        } catch (e) {
            store = `failed (${errMsg(e)})`;
        }
        olog.info(`voice self-check: actions=${actions}, MediaEngineStore=${store}, sounds=${discordSoundsStatus()}`);
    } catch (e) {
        olog.error("voice self-check failed", e);
    }
}

/** Read-only; runs once shortly after plugin start so Discord's modules and stores have loaded. */
export function scheduleVoiceSelfCheck(): void {
    cancelVoiceSelfCheck();
    selfCheckTimer = setTimeout(() => {
        selfCheckTimer = null;
        voiceSelfCheck();
    }, SELF_CHECK_DELAY_MS);
}

export function cancelVoiceSelfCheck(): void {
    if (selfCheckTimer) clearTimeout(selfCheckTimer);
    selfCheckTimer = null;
}
