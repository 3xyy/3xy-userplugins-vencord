/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renderer side of the engine: starts/stops it through native.ts, polls its cached state
// (50 ms while the panel is open, 1000 ms otherwise), decides when audio should run and runs the
// Discord-voice fallback controller on every tick (also, at 1000 ms, while the engine can't start).
// Joining or leaving a voice channel triggers a tick right away. Does nothing while the plugin is off or
// o2i is turned off with the power button (power.ts: stop() then, and start() refuses).
// The mic mute: one long-poll (waitMicMuteEvent) is always outstanding while the engine runs, so every
// mute change (panel or hotkey) is saved and plays Discord's mute / unmute sound right away; after every
// (re)spawn the saved mute is sent again before set_audio (a new engine process starts unmuted).
// Nothing in here may throw into Discord: every native call is wrapped and logged.

import { PluginNative } from "@utils/types";
import { React, SelectedChannelStore, showToast } from "@webpack/common";

import { playDiscordSound } from "./discordSounds";
import { followO2iMute, runFallbackController } from "./discordVoice";
import { olog } from "./log";
import { audioWantedMs } from "./logic/fallback";
import { micMuteUpdate, muteOnAttach } from "./logic/micMute";
import { wantAudio } from "./logic/policy";
import { effectiveProfile, type O2iProfile } from "./logic/profile";
import { throttleWait } from "./logic/seek";
import { effectiveMicMuted, engineCannotMute, noteEngineCanMute, subscribeMuteSupport } from "./micMuteState";
import { settings } from "./settings";
import type { EngineSnapshot, MicMuteEvent, StartResult } from "./types";

type O2iNative = PluginNative<typeof import("./native")>;

export function getNative(): O2iNative {
    return VencordNative.pluginHelpers.Output2Input as O2iNative;
}

const POLL_FAST_MS = 50;
const POLL_SLOW_MS = 1000;
const CONFIGURE_DEBOUNCE_MS = 150;
/** While "unset", check the configured exe every this many slow ticks (~5 s). */
const UNSET_EXE_CHECK_TICKS = 5;
/** Each waitMicMuteEvent call ends after this at the latest (then the next one starts). */
const MUTE_WAIT_MS = 25000;
/** After a failed waitMicMuteEvent call, the next one waits this long (no busy loop). */
const MUTE_RETRY_MS = 2000;

const EMPTY: EngineSnapshot = {
    status: "stopped",
    generation: 0,
    engineVersion: null,
    lastError: null,
    state: null,
    devices: null,
    apps: null,
    clips: null,
    seq: { devices: 0, apps: 0, clips: 0 },
    notices: [],
    micMuteSeq: 0,
};

let snapshot: EngineSnapshot = EMPTY;
/**
 * The plugin is running: set at the beginning of the plugin's start(), cleared at the beginning of its stop().
 * The account-panel patch stays applied until a restart, so the UI checks this; start() refuses without it.
 */
let pluginRunning = false;
/** The poll loop runs (engine started successfully). */
let active = false;
/** Bumped by every start()/stop() so a slow start can tell it was superseded. */
let startSeq = 0;
/**
 * Open panels (the account-panel popout and/or the expanded modal). Counted, not a flag: expanding
 * opens the modal before the popout closes, so audio and fast polling never drop out in between.
 */
let openPanels = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let configureTimer: ReturnType<typeof setTimeout> | null = null;
/** Engine generation we last configured; a different one means the engine (re)spawned. */
let lastGeneration = 0;
/** Last set_audio value the engine accepted; null forces a resend. */
let lastWant: boolean | null = null;
let unsetToastShown = false;
let loggedStatus: string | null = null;
let loggedAudio: string | null = null;
/** Fallback timing: when audio last became wanted and when the engine last (re)spawned (ms timestamps). */
let wantedAt = 0;
let spawnedAt = 0;
let prevWant = false;
/** Runs the fallback controller while the engine can't start (no poll loop then). */
let unsetTimer: ReturnType<typeof setInterval> | null = null;
/** Voice channel seen by the SelectedChannelStore listener (undefined: not watching). */
let watchedVoiceChannel: string | null | undefined;
/**
 * Errors that can repeat every poll are written to plugin.log once per streak (the streak ends when the
 * call works again), so they never crowd out other lines or fill the log.
 */
let pollFailures = 0;
let sendFailing = false;
let pathCheckFailing = false;
let rememberMicFailing = false;
let subscriberFailing = false;
let previewFailing = false;
/**
 * A set_mic_muted value still to be delivered (null: none). `true` holds set_audio back until it is
 * delivered: after a respawn the mute goes first.
 */
let pendingMute: boolean | null = null;
/** Bumped to end the mute long-poll loop (stop, or a failed start); a late answer to an old call is ignored. */
let muteWatchToken = 0;
let muteWatching = false;
/** The last mic_muted event this renderer has handled (native numbers them). */
let muteSeq = 0;
let muteWaitFailures = 0;
let muteWaitMissingLogged = false;
/** The "this engine can't mute" warning was given (reset when an engine that can mute runs). */
let muteUnsupportedWarned = false;

const listeners = new Set<() => void>();

function notify() {
    for (const fn of listeners) {
        try {
            fn();
        } catch (e) {
            if (!subscriberFailing) olog.error("a UI subscriber failed (further failures are not logged)", e);
            subscriberFailing = true;
        }
    }
}

function setSnapshot(next: EngineSnapshot) {
    snapshot = next;
    notify();
}

async function sendNow(cmd: object): Promise<boolean> {
    if (!IS_DISCORD_DESKTOP) return false;
    try {
        const ok = await getNative().sendCommand(JSON.stringify(cmd));
        sendFailing = false;
        return ok;
    } catch (e) {
        if (!sendFailing) olog.error(`sendCommand ${(cmd as { cmd?: unknown; }).cmd} failed`, e);
        sendFailing = true;
        return false;
    }
}

/** The slider preview in progress, applied on top of the stored profile by every configure; null when none. */
let previewPatch: ((p: O2iProfile) => O2iProfile) | null = null;

function configureCommand() {
    let { profile } = settings.store;
    if (previewPatch && profile) {
        try {
            profile = previewPatch(JSON.parse(JSON.stringify(profile)));
            previewFailing = false;
        } catch (e) {
            if (!previewFailing) olog.error("slider preview failed (further failures are not logged until one works)", e);
            previewFailing = true;
        }
    }
    return { cmd: "configure", profile: effectiveProfile(profile, settings.store.mutedApps ?? []) };
}

function voiceChannelId(): string | null {
    try {
        return SelectedChannelStore?.getVoiceChannelId() ?? null;
    } catch {
        return null;
    }
}

function inCall(): boolean {
    return !!voiceChannelId();
}

function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

// ---- mic mute ----

/**
 * A mute change reached the plugin (a mic_muted event, or set while no engine could take it): saves it,
 * makes Discord's self-mute follow (`followO2iMute`, in or out of a fallback episode) and plays Discord's
 * mute / unmute sound. Nothing when the value is already saved (the re-apply after a respawn). Never throws.
 */
function onMicMuted(muted: boolean, source: string): void {
    try {
        const u = micMuteUpdate(!!settings.store.micMuted, muted);
        if (u.persist === null) return;
        settings.store.micMuted = u.persist;
        olog.info(`mic ${muted ? "muted" : "unmuted"} (${source})`);
        if (u.sound) playDiscordSound(u.sound); // exactly once per change: Discord's own self-mute changes are silent
        followO2iMute(effectiveMicMuted());
    } catch (e) {
        olog.error("handling a mic mute change failed", e);
    }
}

/** The running engine reports no `state.mic_muted`: an o2i.exe from before the mic mute. */
function muteUnsupported(snap: EngineSnapshot): boolean {
    return snap.status === "running" && snap.state != null && typeof snap.state.mic_muted !== "boolean";
}

/**
 * Records whether the running engine can mute (micMuteState.ts) and warns once (and, if o2i's mic is meant
 * to be muted, tells him it isn't) when it can't.
 */
function checkMuteSupport(snap: EngineSnapshot): void {
    if (!snap.state || snap.status !== "running") return;
    noteEngineCanMute(!muteUnsupported(snap));
    if (!muteUnsupported(snap)) {
        muteUnsupportedWarned = false;
        return;
    }
    if (muteUnsupportedWarned) return;
    muteUnsupportedWarned = true;
    olog.warn("this o2i engine has no mic mute; update the o2i engine to use mute");
    if (settings.store.micMuted) {
        try {
            showToast({ text: "Update the o2i engine to use mute. Your mic isn't muted", variant: "critical" });
        } catch (e) {
            olog.error("toast failed", e);
        }
    }
}

/**
 * Sends `pendingMute` to the engine; clears it once delivered (unless it changed meanwhile). `snap`: the
 * newest snapshot (a fresh engine has no state yet, so it is never taken for one that can't mute).
 */
async function deliverPendingMute(snap: EngineSnapshot = snapshot): Promise<void> {
    const muted = pendingMute;
    if (muted === null) return;
    if (muteUnsupported(snap)) {
        pendingMute = null; // nothing to deliver it to
        return;
    }
    if (await sendNow({ cmd: "set_mic_muted", muted })) {
        if (pendingMute === muted) pendingMute = null;
        olog.info(`set_mic_muted ${muted} sent`);
    }
}

/** The long-poll loop: exactly one waitMicMuteEvent call outstanding while the engine runs. */
function startMuteWatch(baseline: number): void {
    if (muteWatching || !IS_DISCORD_DESKTOP) return;
    try {
        // Discord loads native.ts once at start: after an update and only a reload it is the old one.
        if (typeof getNative().waitMicMuteEvent !== "function") {
            if (!muteWaitMissingLogged) olog.warn("restart Discord to finish updating o2i: until then mute changes from the hotkey aren't saved and play no sound");
            muteWaitMissingLogged = true;
            return;
        }
    } catch {
        return;
    }
    muteWatching = true;
    muteSeq = baseline;
    const token = ++muteWatchToken;
    const run = async () => {
        while (token === muteWatchToken && active) {
            let ev: MicMuteEvent | null;
            try {
                ev = await getNative().waitMicMuteEvent(MUTE_WAIT_MS, muteSeq);
                if (muteWaitFailures) olog.info(`waiting for mute changes works again (after ${muteWaitFailures} failed calls)`);
                muteWaitFailures = 0;
            } catch (e) {
                if (!muteWaitFailures++) olog.error("waiting for mute changes failed (logged once until it works again)", e);
                await new Promise(r => setTimeout(r, MUTE_RETRY_MS));
                continue;
            }
            if (token !== muteWatchToken || !active) return; // stopped meanwhile: the answer is ignored
            if (ev && ev.seq !== muteSeq) {
                muteSeq = ev.seq;
                onMicMuted(ev.muted === true, ev.source);
            }
        }
    };
    run()
        .catch(e => olog.error("the mute watch stopped", e))
        .finally(() => {
            if (token === muteWatchToken) muteWatching = false;
        });
}

function stopMuteWatch(): void {
    muteWatchToken++;
    muteWatching = false;
}

/**
 * A new engine generation (spawn, or a re-attach after a reload): keeps an engine that was muted while
 * nobody listened muted (and makes Discord's self-mute follow, as for any mute change), queues the saved
 * mute for the fresh engine (only ever a mute) and starts the long-poll from this snapshot's event number.
 */
function attachMute(snap: EngineSnapshot): void {
    const m = muteOnAttach(!!settings.store.micMuted, snap.state?.mic_muted);
    if (m.adopt) {
        // This engine reported mic_muted, so it can mute. Recorded first, so o2i's mic counts as muted
        // everywhere (the panel too) whatever an older engine said about mute support. Before the mute is
        // saved, so the mute-support listener has nothing to follow yet and Discord follows exactly once below.
        noteEngineCanMute(true);
        settings.store.micMuted = true;
        olog.info("o2i's mic is muted in the engine (changed while Discord reloaded); keeping it muted");
        followO2iMute(true); // silent: no sound plays
    }
    pendingMute = m.send ? true : null;
    startMuteWatch(snap.micMuteSeq ?? 0);
}

/**
 * The panel's mute toggle. While the engine runs it goes through the engine (saved, with the sound, when
 * its mic_muted event comes back). With no engine to take it (not started, or restarting) it is saved
 * right away and sent when the engine is up. Does nothing while the plugin or o2i is off.
 */
export function setMicMuted(muted: boolean): void {
    try {
        if (!IS_DISCORD_DESKTOP || !pluginRunning || settings.store.powered === false) return;
        if (engineCannotMute()) {
            showToast({ text: "Update the o2i engine to use mute", variant: "critical" });
            return;
        }
        if (!active) {
            onMicMuted(muted, "panel; sent when the engine starts");
            return;
        }
        pendingMute = muted;
        const watched = muteWatching;
        void deliverPendingMute().then(() => {
            // Not delivered (the engine is restarting): saved now; the respawn sends the saved value.
            if (pendingMute === muted) onMicMuted(muted, "panel; the engine is restarting");
            // Delivered, but no long-poll runs yet to report the engine's event back.
            else if (!watched) onMicMuted(muted, "panel");
        });
    } catch (e) {
        olog.error("setMicMuted failed", e);
    }
}

export function isMicMuted(): boolean {
    return settings.store.micMuted === true;
}

/**
 * For components: the last engine that reported can mute (none reported yet counts as yes, see
 * micMuteState.ts); re-renders only when it changes.
 */
export function useMicMuteSupported(): boolean {
    return !React.useSyncExternalStore(subscribeMuteSupport, engineCannotMute);
}

/**
 * For components: o2i's mic counts as muted (micMuteState.ts: the saved value, never while the engine can't
 * mute), the same rule as for self-muting Discord; re-renders only when that changes.
 */
export function useMicMuted(): boolean {
    const muted = settings.use(["micMuted"]).micMuted === true;
    const supported = useMicMuteSupported();
    return muted && supported;
}

/** Persists o2i's microphone name (for the fallback, also after restarts); writes only when it changes. */
function rememberMic(snap: EngineSnapshot) {
    const id = settings.store.profile?.input_id;
    if (!id || !snap.devices) return;
    const dev = snap.devices.inputs.find(d => d.id === id);
    if (!dev) return;
    const known = settings.store.realMic;
    if (known?.inputId !== id || known.name !== dev.name) settings.store.realMic = { inputId: id, name: dev.name };
}

function stopUnsetWatch() {
    if (unsetTimer) clearInterval(unsetTimer);
    unsetTimer = null;
}

function unsetTick() {
    runFallbackController({ inCall: inCall(), engine: "unset", audio: null, msSinceAudioWanted: 0 });
}

/**
 * While the engine can't start: runs the fallback controller every second and, every ~5 s, checks the
 * configured exe. Once a missing exe appears (a rebuild or restore finished), the engine is started again.
 * Only a missing → present change restarts it, so other start errors don't retry in a loop.
 */
function startUnsetWatch() {
    stopUnsetWatch();
    const seq = startSeq;
    let ticks = 0;
    let missing: boolean | null = null;
    const checkExe = async () => {
        const path = (settings.store.enginePath ?? "").trim();
        if (!path) {
            missing = null;
            return;
        }
        let exists: boolean;
        try {
            exists = !!(await getNative().pathExists(path));
            pathCheckFailing = false;
        } catch (e) {
            if (!pathCheckFailing) olog.error("pathExists failed", e);
            pathCheckFailing = true;
            return;
        }
        if (seq !== startSeq || !unsetTimer) return; // started, stopped or re-entered meanwhile
        if (exists && missing) {
            olog.info("the engine exe is back; starting the engine");
            void start();
            return;
        }
        missing = !exists;
    };
    void checkExe();
    unsetTimer = setInterval(() => {
        unsetTick();
        if (++ticks % UNSET_EXE_CHECK_TICKS === 0) void checkExe();
    }, POLL_SLOW_MS);
}

/** Joining or leaving a call: re-evaluate set_audio and the fallback now instead of on the next 1 s tick. */
function onSelectedChannelChange() {
    try {
        const id = voiceChannelId();
        if (id === watchedVoiceChannel) return; // e.g. a text-channel switch
        // No channel ids in the log: joined / switched / left is enough to read the fallback around it.
        olog.info(!id ? "left the voice call" : watchedVoiceChannel ? "switched voice channel" : "joined a voice call");
        watchedVoiceChannel = id;
        if (active) schedulePoll(0);
        else if (unsetTimer) unsetTick();
    } catch (e) {
        olog.error("voice channel change handler failed", e);
    }
}

function watchVoiceChannel() {
    if (watchedVoiceChannel !== undefined) return;
    watchedVoiceChannel = voiceChannelId();
    try {
        SelectedChannelStore.addChangeListener(onSelectedChannelChange);
    } catch (e) {
        watchedVoiceChannel = undefined;
        olog.error("couldn't watch voice channel changes; calls are noticed on the next tick", e);
    }
}

function unwatchVoiceChannel() {
    if (watchedVoiceChannel === undefined) return;
    watchedVoiceChannel = undefined;
    try {
        SelectedChannelStore.removeChangeListener(onSelectedChannelChange);
    } catch (e) {
        olog.error("couldn't stop watching voice channel changes", e);
    }
}

function schedulePoll(ms: number) {
    stopPolling();
    pollTimer = setTimeout(poll, ms);
}

async function poll() {
    pollTimer = null;
    if (!active || polling) return;
    polling = true;
    try {
        const snap = await getNative().pollEngine();
        if (pollFailures) olog.info(`polling the engine works again (after ${pollFailures} failed polls)`);
        pollFailures = 0;
        if (active) await onSnapshot(snap);
    } catch (e) {
        if (!pollFailures++) olog.error("poll failed (logged once until polling works again)", e);
    } finally {
        polling = false;
        if (active && !pollTimer) schedulePoll(openPanels > 0 ? POLL_FAST_MS : POLL_SLOW_MS);
    }
}

function logChanges(snap: EngineSnapshot) {
    if (snap.status !== loggedStatus) {
        loggedStatus = snap.status;
        if (snap.status === "crashed") olog.warn(`engine crashed, restarting: ${snap.lastError}`);
        else olog.info(`engine status: ${snap.status}${snap.engineVersion ? ` (o2i ${snap.engineVersion})` : ""}`);
    }
    const audio = snap.state ? `${snap.state.audio}${snap.state.error ? ` (${snap.state.error})` : ""}` : null;
    if (audio && audio !== loggedAudio) {
        loggedAudio = audio;
        olog.info(`audio: ${audio}`);
    }
    for (const n of snap.notices) {
        // A sound that ended between the seek drag and its release: expected, not worth a warning.
        if (n.message.includes("No such playing sound")) olog.info(`engine: ${n.message}`);
        else olog.warn(`engine error: ${n.message}`);
    }
}

/** Last devices/apps/clips object per sequence number: IPC hands back a fresh clone every poll. */
const stable: { [K in "devices" | "apps" | "clips"]: { seq: number; value: EngineSnapshot[K]; } } = {
    devices: { seq: -1, value: null },
    apps: { seq: -1, value: null },
    clips: { seq: -1, value: null },
};

function stabilize(snap: EngineSnapshot): EngineSnapshot {
    for (const k of ["devices", "apps", "clips"] as const) {
        const cur = stable[k];
        if (cur.seq === snap.seq[k]) (snap as any)[k] = cur.value;
        else stable[k] = { seq: snap.seq[k], value: snap[k] } as any;
    }
    return snap;
}

async function onSnapshot(snap: EngineSnapshot) {
    snap = stabilize(snap);
    let triedMute = false;
    if (snap.generation !== lastGeneration) {
        // Engine (re)spawned, or this renderer just re-attached after a reload: push everything.
        lastGeneration = snap.generation;
        lastWant = null;
        spawnedAt = Date.now(); // the fallback's start-up grace restarts with every (re)spawn
        attachMute(snap);
        // First of all: a new engine process starts unmuted, and audio must never start before the mute.
        if (pendingMute !== null) {
            triedMute = true;
            await deliverPendingMute(snap);
        }
        const ok = await sendNow(configureCommand());
        // The fallback needs the mic's name (Discord's device ids differ from the engine's).
        void sendNow({ cmd: "list_devices" });
        olog.info(`engine generation ${snap.generation} (${snap.status}): configure ${ok ? "sent" : "not delivered"}`);
    }

    if (pendingMute !== null && !triedMute && active) await deliverPendingMute(snap);

    const s = { inCall: inCall(), popoutOpen: openPanels > 0, keepRunning: !!settings.store.keepRunningOutsideCalls };
    const want = wantAudio(s);
    if (want && !prevWant) wantedAt = Date.now();
    prevWant = want;
    // An undelivered mute holds set_audio back (retried every tick): never live from an unmuted fresh engine.
    if (want !== lastWant && pendingMute !== true && await sendNow({ cmd: "set_audio", on: want })) {
        lastWant = want;
        olog.info(`set_audio ${want} (inCall=${s.inCall} popout=${s.popoutOpen} keepRunning=${s.keepRunning})`);
    }

    logChanges(snap);
    if (!active) return; // stopped meanwhile: no tick, and above all no fallback/recover after stop()'s restore
    setSnapshot(snap);
    checkMuteSupport(snap);
    // Before the fallback (which reads the name), but a failure here must never skip the fallback.
    try {
        rememberMic(snap);
        rememberMicFailing = false;
    } catch (e) {
        if (!rememberMicFailing) olog.error("couldn't remember o2i's microphone", e);
        rememberMicFailing = true;
    }
    runFallbackController({
        inCall: s.inCall,
        engine: snap.status,
        audio: snap.state?.audio ?? null,
        msSinceAudioWanted: audioWantedMs(Date.now(), want, wantedAt, spawnedAt),
    });
}

function stopNative() {
    try {
        getNative().stopEngine().catch(e => olog.error("stopEngine failed", e));
    } catch (e) {
        olog.error("stopEngine failed", e);
    }
}

async function start(): Promise<void> {
    // Vencord renders the settings page (SetupSection) for a disabled plugin too: never spawn for it.
    // Nor while o2i is turned off with the power button (power.ts), whoever asks (settings page, unset watcher).
    if (!IS_DISCORD_DESKTOP || !pluginRunning || settings.store.powered === false) return;
    const seq = ++startSeq;
    stopUnsetWatch();
    watchVoiceChannel();
    const path = (settings.store.enginePath ?? "").trim();
    if (snapshot.status !== "running") setSnapshot({ ...EMPTY, status: "starting" });

    let res: StartResult;
    try {
        res = path ? await getNative().startEngine(path) : { ok: false, error: "No engine path set" };
    } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (seq !== startSeq) return; // stop() or another start() happened meanwhile

    if (!res.ok) {
        // "unset" means no engine: stop one left over from an earlier, valid path (no-op otherwise).
        active = false;
        stopPolling();
        stopMuteWatch();
        pendingMute = null;
        stopNative();
        setSnapshot({ ...EMPTY, status: "unset", lastError: res.error });
        olog.warn(`engine not started: ${res.error}`);
        startUnsetWatch(); // Discord on CABLE Output with no engine would be silent in calls
        if (!unsetToastShown) {
            unsetToastShown = true;
            try {
                showToast({ text: "The o2i engine isn't set up. Check the o2i settings", variant: "critical" });
            } catch (e) {
                olog.error("toast failed", e);
            }
        }
        return;
    }

    olog.info("engine started");
    active = true;
    schedulePoll(0);
}

function stop(): void {
    previewPatch = null;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    startSeq++;
    active = false;
    stopPolling();
    stopMuteWatch();
    pendingMute = null;
    stopUnsetWatch();
    unwatchVoiceChannel();
    if (configureTimer) clearTimeout(configureTimer);
    configureTimer = null;
    lastGeneration = 0;
    lastWant = null;
    prevWant = false;
    wantedAt = spawnedAt = 0;
    loggedStatus = loggedAudio = null;
    if (IS_DISCORD_DESKTOP) stopNative();
    setSnapshot({ ...EMPTY, status: "stopped" });
    olog.info("engine stopped");
}

function send(cmd: object): void {
    void sendNow(cmd);
}

/** Debounce with a max wait: a pending timer is never restarted; it reads the latest settings when it fires. */
function configureSoon(): void {
    if (configureTimer) return;
    configureTimer = setTimeout(() => {
        configureTimer = null;
        if (active) void sendNow(configureCommand());
    }, CONFIGURE_DEBOUNCE_MS);
}

const PREVIEW_MS = 100;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewLastAt = 0;

function sendPreview() {
    previewTimer = null;
    if (!previewPatch || !active) return;
    previewLastAt = performance.now();
    void sendNow(configureCommand());
}

/**
 * Transient preview while a slider is dragged: sends `configure` with `patch` applied to the stored profile straight to the engine (about
 * every 100 ms, trailing send of the latest), bypassing the debounce; stored settings are untouched.
 * `previewProfile(null)` ends it: with `resend` the stored profile is sent again (the preview was abandoned);
 * without, the caller is about to commit, which sends its own configure.
 */
function previewProfile(patch: ((p: O2iProfile) => O2iProfile) | null, resend = false): void {
    if (patch) {
        previewPatch = patch; // every configure (timer, respawn, this preview) now agrees on it
        if (previewTimer) return;
        const wait = throttleWait(previewLastAt, performance.now(), PREVIEW_MS);
        if (wait <= 0) sendPreview();
        else previewTimer = setTimeout(sendPreview, wait);
        return;
    }
    const was = previewPatch != null;
    previewPatch = null;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    if (was && resend && active) void sendNow(configureCommand());
}

/**
 * Marks a panel (the popout or the expanded modal) open until the returned release runs. While any
 * panel is open audio runs and polling is 50 ms. Calling the release more than once does nothing.
 */
function holdPanelOpen(): () => void {
    let held = true;
    openPanels++;
    if (openPanels === 1 && active) schedulePoll(0); // switch poll rate and re-evaluate set_audio right away
    return () => {
        if (!held) return;
        held = false;
        openPanels--;
        if (openPanels === 0 && active) schedulePoll(0);
    };
}

function getSnapshot(): EngineSnapshot {
    return snapshot;
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export const engineClient = { start, stop, send, configureSoon, previewProfile, holdPanelOpen, getSnapshot, subscribe, setMicMuted };

export function useEngine(): EngineSnapshot {
    return React.useSyncExternalStore(subscribe, getSnapshot);
}

/** Called by the plugin's start() (true, first thing) and stop() (false, first thing). */
export function setPluginRunning(on: boolean): void {
    if (pluginRunning === on) return;
    pluginRunning = on;
    notify();
}

export function isPluginRunning(): boolean {
    return pluginRunning;
}

/** Re-renders when the plugin starts or stops. */
export function usePluginRunning(): boolean {
    return React.useSyncExternalStore(subscribe, isPluginRunning);
}
