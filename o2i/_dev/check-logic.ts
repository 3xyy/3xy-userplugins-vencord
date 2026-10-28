/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsStore } from "@shared/SettingsStore";

import { hotkeyConflict, hotkeyProblem, keyEventToAccel, keyEventToMuteSpec, mouseButtonToMuteSpec, muteHotkeyConflict, muteKeyFiresWhileTyping, muteKeyIsSideButton } from "../logic/accel";
import { nextDelay } from "../logic/backoff";
import { enginePathProblem, folderKindProblem, folderPathProblem } from "../logic/exePath";
import {
    audioWantedMs, defaultInputId, episodeCheck, fallbackDecision, fallbackMuteDecision, inputChangeTransition, isOwnInputSwitch, mayBeOnO2i, muteRestoreDue, namedDevicesListed, o2iMuteTransition, onCableExactly, pickFallbackMic, pickRealMic, pttModeTransition,
savedAfterHandChange
} from "../logic/fallback";
import { LineSplitter } from "../logic/lines";
import { LogFile } from "../logic/logfile";
import { exportZipName, formatLogLine, LOG_MSG_MAX, logFileName, rotationRenames, shouldRotate, truncateLogMsg } from "../logic/logrotate";
import { findCableOutput, matchDeviceByName } from "../logic/match";
import { clampDb, dbToFrac, fracToDb, gateLine, METER_FLOOR_DB, rmsToFrac, thresholdDb, xToDb } from "../logic/meter";
import { effectiveMute, micMuteUpdate, muteOnAttach } from "../logic/micMute";
import { migratePluginSettings } from "../logic/migrate";
import { fallbackAction, wantAudio } from "../logic/policy";
import { type PowerFacts, powerTransition, restoreCheck, restoreDropped } from "../logic/power";
import { dbToRms, effectiveProfile, isPttMode, type O2iProfile, rmsToDb } from "../logic/profile";
import { RateLimiter } from "../logic/ratelimit";
import { makeRedactor, redactJson } from "../logic/redact";
import { posFromX, seekPending, stepSeek, throttleWait } from "../logic/seek";
import { getSoundMeta, lastEmoji, matchesSound, nextEmoji, soundLabel, type SoundMetaMap, soundName, stripExt, withSoundMeta } from "../logic/soundMeta";
import {
    addSource, baseName, clipsStale, DEFAULT_CLIP, duplicateSourceTags, findClip, inSources, isAbsolutePath, isBareName, keyIndex, migrateToPaths, pathJoinWin, pathKey, planPathsMigration, removeSource,
    shouldAddDefaultFolder, sourceLabels, sourcesOf, splitFolder, withClipHotkey, withClipSettings, withSources
} from "../logic/sources";
import { buildSummary, pickSettings } from "../logic/summary";
import { capText, charCount, firstErrorAfter, groupVoices, installLabel, isSpeech, pickVoice, runtimeInstalled, speakBlocked, TTS_MAX_CHARS, type TtsVoice } from "../logic/tts";
import { LatestWaiters } from "../logic/waiters";

// LineSplitter
const ls = new LineSplitter();
assert.deepEqual(ls.push('{"a":1}\n{"b"'), ['{"a":1}']);
assert.deepEqual(ls.push(":2}\r\n"), ['{"b":2}']);

// backoff
assert.equal(nextDelay(0), 1000);
assert.equal(nextDelay(3), 10000);
assert.equal(nextDelay(99), 30000);

// wantAudio
assert.equal(wantAudio({ inCall: false, popoutOpen: false, keepRunning: false }), false);
assert.equal(wantAudio({ inCall: true, popoutOpen: false, keepRunning: false }), true);
assert.equal(wantAudio({ inCall: false, popoutOpen: true, keepRunning: false }), true);
assert.equal(wantAudio({ inCall: false, popoutOpen: false, keepRunning: true }), true);

// fallbackAction
assert.equal(fallbackAction({ inCall: true, engine: "crashed", audio: null, msSinceAudioWanted: 0, fallenBack: false }), "fallback");
assert.equal(fallbackAction({ inCall: true, engine: "running", audio: "off", msSinceAudioWanted: 1000, fallenBack: false }), "none");
assert.equal(fallbackAction({ inCall: true, engine: "running", audio: "off", msSinceAudioWanted: 3500, fallenBack: false }), "fallback");
assert.equal(fallbackAction({ inCall: true, engine: "running", audio: "running", msSinceAudioWanted: 9000, fallenBack: true }), "recover");
assert.equal(fallbackAction({ inCall: false, engine: "crashed", audio: null, msSinceAudioWanted: 0, fallenBack: false }), "none");

// fallbackDecision (controller wrapper around fallbackAction)
const fb = {
    inCall: true, engine: "running", audio: "off", msSinceAudioWanted: 0, msHealthy: 0, fallenBack: false, discordMayBeOnO2i: () => true
} as Parameters<typeof fallbackDecision>[0];
assert.equal(fallbackDecision({ ...fb, engine: "starting", audio: null, msSinceAudioWanted: 500 }), "none"); // just (re)spawned
assert.equal(fallbackDecision({ ...fb, engine: "starting", audio: null, msSinceAudioWanted: 3500 }), "fallback"); // stuck starting
assert.equal(fallbackDecision({ ...fb, engine: "running", audio: null, msSinceAudioWanted: 2999 }), "none"); // audio still starting
assert.equal(fallbackDecision({ ...fb, engine: "crashed", audio: null }), "fallback");
assert.equal(fallbackDecision({ ...fb, engine: "unset", audio: null }), "fallback");
assert.equal(fallbackDecision({ ...fb, engine: "crashed", audio: null, discordMayBeOnO2i: () => false }), "none"); // Discord isn't on o2i
assert.equal(fallbackDecision({ ...fb, engine: "crashed", audio: null, fallenBack: true }), "none"); // one episode
assert.equal(fallbackDecision({ ...fb, inCall: false, engine: "crashed", audio: null }), "none");
assert.equal(fallbackDecision({ ...fb, audio: "running", fallenBack: true, msHealthy: 500 }), "none"); // not stable yet
assert.equal(fallbackDecision({ ...fb, audio: "running", fallenBack: true, msHealthy: 2000, discordMayBeOnO2i: () => false }), "recover");
let cableAsked = false;
fallbackDecision({ ...fb, audio: "running", discordMayBeOnO2i: () => (cableAsked = true) });
assert.equal(cableAsked, false); // the store is only read when a fallback is due
// o2i turned off with the power button: never a fallback (or its "o2i stopped" toast), never a recovery onto CABLE
assert.equal(fallbackDecision({ ...fb, engine: "stopped", audio: null, powered: false }), "none");
assert.equal(fallbackDecision({ ...fb, engine: "crashed", audio: null, powered: false }), "none");
assert.equal(fallbackDecision({ ...fb, audio: "running", fallenBack: true, msHealthy: 5000, powered: false }), "none");
assert.equal(fallbackDecision({ ...fb, engine: "crashed", audio: null, powered: true }), "fallback"); // on: unchanged
// power on with a CABLE restore waiting = a fallen-back episode with Discord on the real mic: the recovery moves it to
// CABLE once audio has been healthy for 2 s (also outside a call), never sooner, and no fallback while it waits
assert.equal(fallbackDecision({ ...fb, inCall: false, audio: "running", fallenBack: true, msHealthy: 1999 }), "none");
assert.equal(fallbackDecision({ ...fb, inCall: false, audio: "running", fallenBack: true, msHealthy: 2000 }), "recover");
assert.equal(fallbackDecision({ ...fb, inCall: true, engine: "starting", audio: null, msSinceAudioWanted: 9000, fallenBack: true }), "none"); // never healthy: stays on the real mic
assert.equal(fallbackDecision({ ...fb, inCall: true, engine: "crashed", audio: null, fallenBack: true }), "none");
// armed with seenOff (Discord was checked off o2i): put on o2i by hand while o2i is down ends the wait, so the fallback can act
assert.deepEqual(episodeCheck({ fallenBack: true, healthy: false, seenOff: true, onO2i: () => true }), { seenOff: true, reset: true });

// powerTransition: what turning o2i off / on (or a plugin start) does
// Discord's input: "m" = the real mic it was left on at power off (restoreFrom), "u" = another named mic picked by hand
const facts = (onO2i: boolean, micKnown: boolean, fallenBack = false, input: string | null = "m"): PowerFacts =>
    ({ onO2i: () => onO2i, micKnown: () => micKnown, fallenBack, inputId: () => input });
const ON = { powered: true, restoreCable: false, restoreFrom: null };
const ON_PENDING = { powered: true, restoreCable: true, restoreFrom: "m" }; // turned on, Discord not back on CABLE yet (audio not healthy yet)
const OFF = { powered: false, restoreCable: false, restoreFrom: null };
const OFF_CABLE = { powered: false, restoreCable: true, restoreFrom: "m" }; // turned off while Discord was on CABLE Output (moved to "m")
// off, Discord on CABLE: engine stops, Discord to the real mic, CABLE remembered, a short success toast (not "o2i stopped")
assert.deepEqual(powerTransition("off", ON, facts(true, true)), { powered: false, restoreCable: true, engine: "stop", voice: "real-mic", toast: "off-real-mic" });
// off, Discord on CABLE, no real mic known: nothing to switch to, the pick-your-mic toast (once: nothing ticks while off)
assert.deepEqual(powerTransition("off", ON, facts(true, false)), { powered: false, restoreCable: true, engine: "stop", voice: "none", toast: "pick-mic" });
// off, Discord not on o2i: only the engine stops; no voice change, no toast, nothing to restore
assert.deepEqual(powerTransition("off", ON, facts(false, true)), { powered: false, restoreCable: false, engine: "stop", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("off", ON, facts(false, false)), { powered: false, restoreCable: false, engine: "stop", voice: "none", toast: "none" });
// off during a fallback episode: Discord is already on the real mic, but the recovery would have put it back on CABLE
assert.deepEqual(powerTransition("off", ON, facts(false, true, true)), { powered: false, restoreCable: true, engine: "stop", voice: "none", toast: "none" });
// off while a power-on restore still waits: Discord is on the real mic; the restore stays for the next power on
assert.deepEqual(powerTransition("off", ON_PENDING, facts(false, true)), { powered: false, restoreCable: true, engine: "stop", voice: "none", toast: "none" });
let micAsked = false;
powerTransition("off", ON, { onO2i: () => false, micKnown: () => (micAsked = true), fallenBack: false, inputId: () => "m" });
assert.equal(micAsked, false); // the mic is only looked up when a switch is due
// on, Discord was on CABLE: the engine starts; Discord stays on the real mic until o2i's audio is healthy (flag kept until then)
assert.deepEqual(powerTransition("on", OFF_CABLE, facts(false, true)), { powered: true, restoreCable: true, engine: "start", voice: "cable-when-healthy", toast: "none" });
// on, Discord already put back on CABLE by hand: nothing to wait for (the normal fallback covers it), flag cleared
assert.deepEqual(powerTransition("on", OFF_CABLE, facts(true, true)), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("on", OFF, facts(true, true)), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" });
let onAskedPower = false;
const spy: PowerFacts = {
    onO2i: () => (onAskedPower = true), micKnown: () => (onAskedPower = true), fallenBack: true, inputId: () => { onAskedPower = true; return "m"; }
};
powerTransition("on", OFF, spy);
assert.equal(onAskedPower, false); // without a restore, turning on never reads Discord's voice settings
let onMicAsked = false;
powerTransition("on", OFF_CABLE, { onO2i: () => false, micKnown: () => (onMicAsked = true), fallenBack: false, inputId: () => "m" });
assert.equal(onMicAsked, false);
// plugin start with o2i off and Discord on CABLE (a stale input would leave him silent): like power off, no engine
assert.deepEqual(powerTransition("start", OFF, facts(true, true)), { powered: false, restoreCable: true, engine: "none", voice: "real-mic", toast: "off-real-mic" });
assert.deepEqual(powerTransition("start", OFF, facts(true, false)), { powered: false, restoreCable: true, engine: "none", voice: "none", toast: "pick-mic" });
assert.deepEqual(powerTransition("start", OFF_CABLE, facts(true, true)), { powered: false, restoreCable: true, engine: "none", voice: "real-mic", toast: "off-real-mic" });
// plugin start with o2i off, Discord on the real mic: nothing; a CABLE flag from the power off is kept for power on
assert.deepEqual(powerTransition("start", OFF, facts(false, true)), { powered: false, restoreCable: false, engine: "none", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("start", OFF_CABLE, facts(false, false)), { powered: false, restoreCable: true, engine: "none", voice: "none", toast: "none" });
// plugin start with o2i on: the normal start; a restore still waiting from before a restart waits again
assert.deepEqual(powerTransition("start", ON, spy), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" });
assert.equal(onAskedPower, false);
assert.deepEqual(powerTransition("start", ON_PENDING, facts(false, true)), { powered: true, restoreCable: true, engine: "start", voice: "cable-when-healthy", toast: "none" });
assert.deepEqual(powerTransition("start", ON_PENDING, facts(true, true)), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" });
// double off / double on: idempotent, nothing read, nothing done
assert.deepEqual(powerTransition("off", OFF_CABLE, spy), { powered: false, restoreCable: true, engine: "none", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("off", OFF, spy), { powered: false, restoreCable: false, engine: "none", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("on", ON, spy), { powered: true, restoreCable: false, engine: "none", voice: "none", toast: "none" });
assert.deepEqual(powerTransition("on", ON_PENDING, spy), { powered: true, restoreCable: true, engine: "none", voice: "none", toast: "none" });
assert.equal(onAskedPower, false);
// round trip: off on CABLE → on waits for healthy audio → off before the switch keeps the restore; after the switch (flag cleared) off remembers it again
const off1 = powerTransition("off", ON, facts(true, true));
const on1 = powerTransition("on", { ...off1, restoreFrom: "m" }, facts(false, true));
assert.equal(on1.voice, "cable-when-healthy");
assert.equal(powerTransition("off", { ...on1, restoreFrom: "m" }, facts(false, true)).restoreCable, true);
assert.deepEqual(powerTransition("off", { ...on1, restoreCable: false, restoreFrom: null }, facts(true, true)), off1);

// restoreCheck: a waiting switch back to CABLE is only for the input Discord was left on; any other choice wins
assert.equal(restoreCheck("m", "m", false), "wait");
assert.equal(restoreCheck("m", "u", false), "dropped"); // another named real mic picked by hand
assert.equal(restoreCheck("m", "c", true), "done"); // put on o2i (CABLE / Default): nothing left to do
assert.equal(restoreCheck("m", "m", true), "done");
assert.equal(restoreCheck(null, "u", false), "wait"); // no remembered input (older flag): adopt the current one
assert.equal(restoreCheck("m", null, false), "wait"); // Discord's input unreadable: never act on it
// ...and powerTransition applies it at every point where Discord's input is judged
assert.deepEqual(powerTransition("on", OFF_CABLE, facts(false, true, false, "u")), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" }); // mic changed while off
assert.deepEqual(powerTransition("on", { ...OFF_CABLE, restoreFrom: null }, facts(false, true, false, "u")).voice, "cable-when-healthy");
assert.deepEqual(powerTransition("start", ON_PENDING, facts(false, true, false, "u")), { powered: true, restoreCable: false, engine: "start", voice: "none", toast: "none" }); // changed before a restart
assert.deepEqual(powerTransition("start", OFF_CABLE, facts(false, true, false, "u")), { powered: false, restoreCable: false, engine: "none", voice: "none", toast: "none" }); // changed while off, restarted
assert.deepEqual(powerTransition("start", OFF_CABLE, facts(false, true, false, "m")).restoreCable, true);
assert.deepEqual(powerTransition("off", ON_PENDING, facts(false, true, false, "u")), { powered: false, restoreCable: false, engine: "stop", voice: "none", toast: "none" }); // changed while waiting
assert.deepEqual(powerTransition("off", ON_PENDING, facts(false, true, true, "u")).restoreCable, true); // an ordinary fallback episode still restores

// namedDevicesListed: Discord has enumerated its inputs (before that it may list only its Default placeholder)
assert.equal(namedDevicesListed([]), false);
assert.equal(namedDevicesListed([{ id: "default", name: "Default" }]), false);
assert.equal(namedDevicesListed([{ id: "x", name: "Default" }]), false);
assert.equal(namedDevicesListed([{ id: "default", name: "Default" }, { id: "c", name: "CABLE Output (VB-Audio Virtual Cable)" }]), true);
assert.equal(namedDevicesListed([{ id: "m", name: "Mic" }]), true);

// mayBeOnO2i / defaultInputId / pickRealMic (Discord's "Default" may be CABLE Output in disguise)
const ddevs = [
    { id: "default", name: "Default" },
    { id: "c", name: "CABLE Output (VB-Audio Virtual Cable)" },
    { id: "m", name: "Microphone (Realtek(R) Audio)" },
];
assert.equal(defaultInputId(ddevs), "default");
assert.equal(defaultInputId([{ id: "x", name: "Default" }]), "x");
assert.equal(defaultInputId([{ id: "m", name: "Mic" }]), null);
assert.equal(mayBeOnO2i("c", ddevs), true); // CABLE Output itself
assert.equal(mayBeOnO2i("default", ddevs), true); // Default may be CABLE Output
assert.equal(mayBeOnO2i("default", []), true); // even when the list is unknown
assert.equal(mayBeOnO2i("m", ddevs), false); // a named real mic
assert.equal(pickRealMic(ddevs, "Microphone (Realtek(R) Audio)"), "m");
assert.equal(pickRealMic(ddevs, ""), null); // never Default
assert.equal(pickRealMic(ddevs, "Default"), null);
assert.equal(pickRealMic(ddevs, "CABLE Output"), null); // never the cable
assert.equal(pickRealMic(ddevs, "USB Mic"), null);

// pickFallbackMic: o2i's mic by name, else Discord's original (snapshot) input if it is a named, present real mic
const ddevs2 = [...ddevs, { id: "u", name: "USB Mic" }];
assert.equal(pickFallbackMic(ddevs, "", "m"), "m"); // name unknown: the snapshot's real mic
assert.equal(pickFallbackMic(ddevs, "", "c"), null); // never CABLE Output
assert.equal(pickFallbackMic(ddevs, "", "default"), null); // never Default
assert.equal(pickFallbackMic(ddevs, "", "gone"), null); // unplugged
assert.equal(pickFallbackMic(ddevs, "", null), null); // no snapshot
assert.equal(pickFallbackMic(ddevs, "Microphone (Realtek(R) Audio)", "c"), "m");
assert.equal(pickFallbackMic(ddevs2, "Microphone (Realtek(R) Audio)", "u"), "m"); // the name wins
assert.equal(pickFallbackMic(ddevs2, "Headset", "u"), "u"); // unmatched name: the snapshot's real mic

// episodeCheck: putting Discord back on o2i (by hand) during a fallback episode reopens the episode
let onAsked = false;
assert.deepEqual(episodeCheck({ fallenBack: false, healthy: false, seenOff: false, onO2i: () => (onAsked = true) }), { seenOff: false, reset: false });
assert.equal(onAsked, false); // no episode: the store isn't read
assert.deepEqual(episodeCheck({ fallenBack: true, healthy: true, seenOff: true, onO2i: () => true }), { seenOff: true, reset: false }); // recovery's job
assert.deepEqual(episodeCheck({ fallenBack: true, healthy: false, seenOff: false, onO2i: () => true }), { seenOff: false, reset: false }); // switch failed / store lag: no toast loop
assert.deepEqual(episodeCheck({ fallenBack: true, healthy: false, seenOff: false, onO2i: () => false }), { seenOff: true, reset: false }); // moved off o2i
assert.deepEqual(episodeCheck({ fallenBack: true, healthy: false, seenOff: true, onO2i: () => true }), { seenOff: true, reset: true }); // back on o2i by hand

// audioWantedMs
assert.equal(audioWantedMs(10000, false, 0, 0), 0);
assert.equal(audioWantedMs(10000, true, 4000, 7000), 3000); // respawn after audio became wanted
assert.equal(audioWantedMs(10000, true, 8000, 2000), 2000); // audio wanted after the spawn
assert.equal(audioWantedMs(1000, true, 5000, 0), 0); // clock skew never goes negative

// match
const devs = [{ id: "1", name: "Default" }, { id: "2", name: "Microphone (Realtek(R) Audio)" }];
assert.equal(matchDeviceByName(devs, "Microphone (Realtek(R) Audio)"), "2");
assert.equal(matchDeviceByName(devs, "microphone (realtek"), "2");
assert.equal(matchDeviceByName(devs, "USB Mic"), null);
assert.equal(findCableOutput([{ id: "9", name: "CABLE Output (VB-Audio Virtual Cable)" }]), "9");

// accel
const k = { ctrlKey: false, shiftKey: false, altKey: false };
assert.equal(keyEventToAccel({ ...k, key: "a", code: "KeyA", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+A");
assert.equal(keyEventToAccel({ ...k, key: "F8", code: "F8" }), "F8");
assert.equal(keyEventToAccel({ ...k, key: "7", code: "Digit7", altKey: true }), "Alt+7");
assert.equal(keyEventToAccel({ ...k, key: "Shift", code: "ShiftLeft", shiftKey: true }), null);
assert.equal(keyEventToAccel({ ...k, key: " ", code: "Space" }), null);

// hotkeyProblem: letters/digits need Ctrl or Alt (Shift alone would fire while typing); F-keys are free
assert.notEqual(hotkeyProblem("A"), null);
assert.notEqual(hotkeyProblem("7"), null);
assert.notEqual(hotkeyProblem("Shift+A"), null);
assert.notEqual(hotkeyProblem("Shift+7"), null);
assert.equal(hotkeyProblem("Ctrl+A"), null);
assert.equal(hotkeyProblem("Alt+7"), null);
assert.equal(hotkeyProblem("Ctrl+Shift+A"), null);
assert.equal(hotkeyProblem("Shift+Alt+A"), null);
assert.equal(hotkeyProblem("F8"), null);
assert.equal(hotkeyProblem("Shift+F5"), null);

// enginePathProblem (native.ts: what the main process agrees to execute / stat)
const win = String.raw;
assert.equal(enginePathProblem(win`C:\Tools\o2i\target\release\o2i.exe`, true), null);
assert.equal(enginePathProblem("C:/Tools/O2I.EXE", true), null); // case-insensitive name, forward slashes
assert.notEqual(enginePathProblem("", true), null);
assert.notEqual(enginePathProblem(42, true), null);
assert.notEqual(enginePathProblem("o2i.exe", true), null); // relative
assert.notEqual(enginePathProblem(win`target\release\o2i.exe`, true), null); // relative
assert.notEqual(enginePathProblem("C:o2i.exe", true), null); // drive-relative
assert.notEqual(enginePathProblem(win`\\server\share\o2i.exe`, true), null); // UNC
assert.notEqual(enginePathProblem("//server/share/o2i.exe", true), null); // UNC
assert.notEqual(enginePathProblem(win`/\server\share\o2i.exe`, true), null); // UNC, mixed slashes
assert.notEqual(enginePathProblem(win`\\?\C:\o2i.exe`, true), null); // device namespace
assert.notEqual(enginePathProblem(win`\\.\C:\o2i.exe`, true), null); // device namespace
assert.notEqual(enginePathProblem(win`C:\Windows\System32\cmd.exe`, true), null); // not o2i.exe
assert.notEqual(enginePathProblem(win`C:\x\o2i.exe:stream`, true), null); // alternate data stream
assert.equal(enginePathProblem(win`C:\Windows\System32\cmd.exe`, false), null); // pathExists: any absolute local path
assert.notEqual(enginePathProblem(win`\\server\share\x.txt`, false), null);
assert.notEqual(enginePathProblem("notes.txt", false), null);

// folderPathProblem + folderKindProblem (native.ts openFolder: a full local path that stat says is a directory)
assert.equal(folderPathProblem(win`C:\Users\me\Sounds`), null);
assert.equal(folderPathProblem("C:/Users/me/Sounds"), null);
assert.notEqual(folderPathProblem(""), null);
assert.notEqual(folderPathProblem(null), null);
assert.notEqual(folderPathProblem("Sounds"), null); // relative
assert.notEqual(folderPathProblem("C:Sounds"), null); // drive-relative
assert.notEqual(folderPathProblem(win`\\server\share\Sounds`), null); // UNC
assert.notEqual(folderPathProblem("//server/share/Sounds"), null); // UNC
assert.notEqual(folderPathProblem(win`\\?\C:\Sounds`), null); // device namespace
assert.notEqual(folderPathProblem(win`\\.\C:\Sounds`), null); // device namespace
{
    const dir = mkdtempSync(join(tmpdir(), "o2i-folder-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    assert.equal(folderKindProblem(statSync(dir)), null); // an existing directory is ok
    assert.notEqual(folderKindProblem(statSync(file)), null); // a file is never opened (it would run)
    assert.notEqual(folderKindProblem(null), null); // missing
    rmSync(dir, { recursive: true, force: true });
}

// profile
const input = { name: "d", routed_apps: [{ name: "Spotify.exe", volume: 0.8 }, { name: "chrome.exe", volume: 1 }] };
const eff = effectiveProfile(input, ["chrome.exe"]);
assert.equal(eff.routed_apps![1].volume, 0);
assert.equal(eff.routed_apps![0].volume, 0.8);
assert.equal(input.routed_apps[1].volume, 1);
assert.deepEqual(effectiveProfile({ name: "d" }, []).sb_folders, []); // always an array: the engine rejects null
assert.deepEqual(effectiveProfile({ name: "d", sb_folders: ["C:\\a"] }, []).sb_folders, ["C:\\a"]);
// a removed folder's sounds keep their hotkeys in the stored profile, but the engine doesn't register them
const pushed = {
    name: "d",
    sb_folders: ["c:/A/"],
    sb_clip_hotkeys: [[win`C:\a\x.mp3`, "F1"], [win`D:\gone\y.mp3`, "F2"], ["legacy.mp3", "F3"]] as [string, string][],
};
assert.deepEqual(effectiveProfile(pushed, []).sb_clip_hotkeys, [[win`C:\a\x.mp3`, "F1"], ["legacy.mp3", "F3"]]);
assert.equal(pushed.sb_clip_hotkeys.length, 3); // stored profile untouched: re-adding the folder restores them
assert.deepEqual(effectiveProfile({ name: "d", sb_clip_hotkeys: [["a.mp3", "F1"]] }, []).sb_clip_hotkeys, [["a.mp3", "F1"]]); // legacy names always sent
assert.equal("sb_clip_hotkeys" in effectiveProfile({ name: "d" }, []), false);
assert.ok(Math.abs(dbToRms(-20) - 0.1) < 1e-9);
// monitor / auto-gate fields are always sent explicitly (old stored profiles lack them)
const mon = effectiveProfile({ name: "d" }, []);
assert.equal(mon.monitor_mic, false);
assert.equal(mon.monitor_mic_volume, 1);
assert.equal(mon.gate_auto, false);
assert.equal(mon.gate_auto_margin_db, 6);
const mon2 = effectiveProfile({ name: "d", monitor_mic: true, monitor_mic_volume: null, gate_auto: true, gate_auto_margin_db: 12 }, []);
assert.deepEqual([mon2.monitor_mic, mon2.monitor_mic_volume, mon2.gate_auto, mon2.gate_auto_margin_db], [true, 1, true, 12]);
assert.equal(effectiveProfile({ name: "d", monitor_mic_volume: 0 }, []).monitor_mic_volume, 0); // 0 is a real value
// tts_volume is always sent explicitly (default 1, 0 is real)
assert.equal(effectiveProfile({ name: "d" }, []).tts_volume, 1);
assert.equal(effectiveProfile({ name: "d", tts_volume: null }, []).tts_volume, 1);
assert.equal(effectiveProfile({ name: "d", tts_volume: 1.6 }, []).tts_volume, 1.6);
assert.equal(effectiveProfile({ name: "d", tts_volume: 0 }, []).tts_volume, 0);
// mic quality: always sent, missing / null = 100 (untouched); 0 is a real value
assert.equal(mon.mic_quality, 100);
assert.equal(effectiveProfile({ name: "d", mic_quality: null }, []).mic_quality, 100);
assert.equal(effectiveProfile({ name: "d", mic_quality: 0 }, []).mic_quality, 0);
assert.equal(effectiveProfile({ name: "d", mic_quality: 37 }, []).mic_quality, 37);
// the gate line: auto follows the live value, falls back (dimmed "learning") to the manual one on null / 0 / NaN
assert.deepEqual(gateLine(false, 0.1, 0.02), { rms: 0.02, learning: false });
assert.deepEqual(gateLine(true, 0.1, 0.02), { rms: 0.1, learning: false });
for (const bad of [null, undefined, 0, NaN, -1, Infinity]) assert.deepEqual(gateLine(true, bad, 0.02), { rms: 0.02, learning: true });
assert.equal(rmsToDb(0), -60);

// meter: the gate threshold is dragged along the −60…0 dBFS level meter (whole dB, stored as RMS)
assert.equal(METER_FLOOR_DB, -60);
assert.equal(fracToDb(0), -60);
assert.equal(fracToDb(0.5), -30);
assert.equal(fracToDb(1), 0);
assert.equal(fracToDb(-0.2), -60); // left of the track
assert.equal(fracToDb(1.7), 0); // right of the track
assert.ok(Object.is(fracToDb(0.995), 0)); // rounds to 0, never -0 ("-0 dB")
assert.equal(xToDb(150, 100, 200), -45); // 25 % along a track at x=100, 200 px wide
assert.equal(xToDb(100 + 200 * 26 / 60, 100, 200), -34);
assert.equal(xToDb(100 + 200 * 26.4 / 60, 100, 200), -34); // rounds to the nearest dB
assert.equal(xToDb(100 + 200 * 26.6 / 60, 100, 200), -33);
assert.equal(xToDb(20, 100, 200), -60); // pointer dragged past the left end
assert.equal(xToDb(900, 100, 200), 0); // ... and past the right end
assert.equal(xToDb(120, 100, 0), -60); // zero-width (unlaid-out) track
assert.equal(dbToFrac(-60), 0);
assert.equal(dbToFrac(-15), 0.75);
assert.equal(dbToFrac(0), 1);
assert.equal(dbToFrac(-90), 0);
assert.equal(dbToFrac(6), 1);
assert.equal(rmsToFrac(0), 0);
assert.equal(rmsToFrac(1), 1);
assert.ok(Math.abs(rmsToFrac(0.1) - 2 / 3) < 1e-9); // -20 dBFS
assert.equal(clampDb(-61), -60);
assert.equal(clampDb(3), 0);
assert.equal(clampDb(-37.6), -38);
assert.equal(clampDb(Number.NaN), -60);
assert.equal(thresholdDb(0.02), -34); // the engine default (-33.98 dBFS)
assert.equal(thresholdDb(0), -60);
assert.equal(thresholdDb(2), 0);
for (let db = -60; db <= 0; db++) assert.equal(thresholdDb(dbToRms(db)), db); // every whole dB survives storage as RMS
assert.equal(clampDb(thresholdDb(dbToRms(0)) + 1), 0); // a key step past the end stays at the end
assert.equal(clampDb(thresholdDb(dbToRms(-60)) - 1), -60);

// soundMeta (soundboard display names / emojis)
assert.equal(stripExt("airhorn.mp3"), "airhorn");
assert.equal(stripExt("a.b.wav"), "a.b");
assert.equal(stripExt(".wav"), ".wav");
assert.equal(stripExt("noext"), "noext");
assert.equal(soundName("airhorn.mp3", undefined), "airhorn");
assert.equal(soundName("airhorn.mp3", { name: "  Horn  " }), "Horn");
assert.equal(soundName("airhorn.mp3", { name: "   " }), "airhorn"); // blank name falls back to the file
assert.equal(soundLabel("airhorn.mp3", { emoji: "📯" }), "📯 airhorn");
assert.equal(soundLabel("airhorn.mp3", { name: "Horn", emoji: "📯" }), "📯 Horn");
assert.equal(getSoundMeta({}, "constructor"), undefined); // never an Object.prototype member
assert.deepEqual(getSoundMeta({ "a.mp3": { name: "A" } }, "a.mp3"), { name: "A" });
assert.equal(matchesSound("", "a.mp3", undefined), true);
assert.equal(matchesSound("horn", "airhorn.mp3", undefined), true);
assert.equal(matchesSound("party", "airhorn.mp3", { name: "Party time" }), true);
assert.equal(matchesSound("📯", "x.mp3", { emoji: "📯" }), true);
assert.equal(matchesSound("zzz", "x.mp3", { name: "Horn", emoji: "📯" }), false);
// sounds are keyed by absolute path: names, labels and search use the file name only
assert.equal(soundName(win`C:\sounds\airhorn.mp3`, undefined), "airhorn");
assert.equal(soundName("C:/sounds/a.b.wav", undefined), "a.b");
assert.equal(soundLabel(win`D:\fx\airhorn.mp3`, { emoji: "📯" }), "📯 airhorn");
assert.equal(matchesSound("sounds", win`C:\sounds\a.mp3`, undefined), false); // the folder isn't searched
assert.equal(matchesSound("horn", win`C:\sounds\airhorn.mp3`, undefined), true);
assert.equal(lastEmoji("😀"), "😀");
assert.equal(lastEmoji("😀😎"), "😎"); // a newly picked emoji replaces the old one
assert.equal(lastEmoji("👍🏽"), "👍🏽"); // skin tone stays one emoji
assert.equal(lastEmoji("👨‍👩‍👧"), "👨‍👩‍👧"); // ZWJ family stays one emoji
assert.equal(lastEmoji("🇺🇸"), "🇺🇸");
assert.equal(lastEmoji("1️⃣"), "1️⃣");
assert.equal(lastEmoji("😀a"), "😀");
assert.equal(lastEmoji("abc"), null);
assert.equal(lastEmoji(""), null);
// nextEmoji: what the emoji box stores after an edit (`current` = the emoji it showed)
assert.equal(nextEmoji("😎😀", "😀"), "😎"); // caret before the current emoji
assert.equal(nextEmoji("😀😎", "😀"), "😎"); // caret after it
assert.equal(nextEmoji("😎", undefined), "😎"); // first emoji
assert.equal(nextEmoji("", "😀"), undefined); // emptied: clear
assert.equal(nextEmoji("   ", "😀"), undefined);
assert.equal(nextEmoji("😀a", "😀"), "😀"); // letters are ignored
assert.equal(nextEmoji("a😀", "😀"), "😀");
assert.equal(nextEmoji("abc", undefined), undefined);
assert.equal(nextEmoji("😀😀", "😀"), "😀"); // the same emoji picked again
assert.equal(nextEmoji("👍🏽😀", "😀"), "👍🏽"); // skin tone, before
assert.equal(nextEmoji("😀👍🏽", "😀"), "👍🏽"); // skin tone, after
assert.equal(nextEmoji("🏳️‍🌈👍🏽", "👍🏽"), "🏳️‍🌈"); // ZWJ flag before a multi-codepoint current
assert.equal(nextEmoji("👍🏽🏳️‍🌈", "👍🏽"), "🏳️‍🌈"); // ...and after it
assert.equal(nextEmoji("😀🏳️‍🌈", "🏳️‍🌈"), "😀"); // ZWJ current, caret before
assert.equal(nextEmoji("👍🏽👍", "👍"), "👍🏽"); // a skin-tone variant of the current one counts as new
assert.equal(nextEmoji("👍🏽", "👍"), "👍🏽"); // modifier typed right after it
const metaMap = { "a.mp3": { name: "A" } };
assert.equal(withSoundMeta(metaMap, "a.mp3", { name: " A " }), metaMap); // unchanged after trimming: same object
assert.deepEqual(withSoundMeta(metaMap, "a.mp3", { emoji: "🔥" }), { "a.mp3": { name: "A", emoji: "🔥" } });
assert.deepEqual(withSoundMeta(metaMap, "a.mp3", { name: "" }), {}); // nothing left: entry removed
assert.deepEqual(withSoundMeta(metaMap, "b.mp3", { name: "  B " }), { "a.mp3": { name: "A" }, "b.mp3": { name: "B" } });
assert.equal(withSoundMeta(metaMap, "b.mp3", { name: "  " }), metaMap);
assert.deepEqual(metaMap, { "a.mp3": { name: "A" } }); // never mutated

// logrotate (plugin.log: rotate before a write would pass the cap; plugin.log, plugin.1.log, plugin.2.log)
const MB5 = 5 * 1024 * 1024;
assert.equal(shouldRotate(0, MB5), false);
assert.equal(shouldRotate(0, MB5, MB5 * 2), false); // an empty file always takes the line
assert.equal(shouldRotate(MB5 - 1, MB5), false);
assert.equal(shouldRotate(MB5, MB5), true); // at the cap
assert.equal(shouldRotate(MB5 + 7, MB5), true);
assert.equal(shouldRotate(MB5 - 10, MB5, 10), false); // fits exactly
assert.equal(shouldRotate(MB5 - 10, MB5, 11), true); // would pass the cap
assert.equal(logFileName("plugin", 0), "plugin.log");
assert.equal(logFileName("plugin", 2), "plugin.2.log");
// oldest first, so nothing is overwritten before it has moved on (the oldest file is removed beforehand)
assert.deepEqual(rotationRenames("plugin", 3), [["plugin.1.log", "plugin.2.log"], ["plugin.log", "plugin.1.log"]]);
assert.deepEqual(rotationRenames("engine", 4), [["engine.2.log", "engine.3.log"], ["engine.1.log", "engine.2.log"], ["engine.log", "engine.1.log"]]);
assert.deepEqual(rotationRenames("plugin", 1), []);
assert.equal(LOG_MSG_MAX, 2000);
assert.equal(truncateLogMsg("short"), "short");
assert.equal(truncateLogMsg("x".repeat(2000)), "x".repeat(2000));
assert.equal(truncateLogMsg("x".repeat(2500)).length, 2000);
assert.ok(truncateLogMsg("x".repeat(2500)).endsWith("…"));
assert.equal(formatLogLine(new Date(Date.UTC(2026, 9, 22, 8, 5, 3, 7)), "warn", "a\r\nb\nc"), "[2026-10-22T08:05:03.007Z] WARN a | b | c"); // one line per entry
assert.equal(formatLogLine(new Date(0), "info", "x".repeat(3000)).length, "[1970-01-01T00:00:00.000Z] INFO ".length + 2000);
assert.equal(exportZipName(new Date(2026, 0, 2, 3, 4, 5)), "o2i-logs-20260102-030405.zip"); // local time
assert.equal(exportZipName(new Date(2026, 11, 31, 23, 59, 58)), "o2i-logs-20261231-235958.zip");

// LogFile (native.ts's plugin.log writer): rotates, keeps 3 files under the cap, never throws, drops on overflow
const logDir = mkdtempSync(join(tmpdir(), "o2i-check-"));
try {
    const lf = new LogFile({ dir: () => logDir, base: "plugin", capBytes: 200, keep: 3, maxQueue: 1000, flushDelayMs: 0, retryMs: 60000 });
    for (let i = 0; i < 60; i++) lf.append(`line ${String(i).padStart(2, "0")} ${"-".repeat(20)}`); // 29 bytes + \n each
    lf.flush();
    assert.deepEqual(readdirSync(logDir).sort(), ["plugin.1.log", "plugin.2.log", "plugin.log"]);
    for (const f of readdirSync(logDir)) assert.ok(statSync(join(logDir, f)).size <= 200, `${f} over the cap`);
    const current = readFileSync(join(logDir, "plugin.log"), "utf8");
    assert.ok(current.endsWith(`line 59 ${"-".repeat(20)}\n`)); // the newest line is in plugin.log
    const kept = ["plugin.2.log", "plugin.1.log", "plugin.log"].map(f => readFileSync(join(logDir, f), "utf8")).join("");
    const nums = kept.trim().split("\n").map(l => Number(l.slice(5, 7)));
    assert.deepEqual(nums, nums.map((_, i) => nums[0] + i)); // contiguous, oldest → newest across the files
    assert.equal(lf.disabled, false);

    // overflow: lines beyond maxQueue are dropped and counted in one line
    const dropDir = join(logDir, "drop");
    const small = new LogFile({ dir: () => dropDir, base: "plugin", capBytes: 1 << 20, keep: 3, maxQueue: 3, flushDelayMs: 0, retryMs: 60000 });
    for (let i = 0; i < 5; i++) small.append(`d${i}`);
    small.flush();
    const dropped = readFileSync(join(dropDir, "plugin.log"), "utf8").trim().split("\n");
    assert.deepEqual(dropped.slice(0, 3), ["d0", "d1", "d2"]);
    assert.equal(dropped.length, 4);
    assert.match(dropped[3], /WARN 2 log lines dropped/);

    // failure (the log "folder" is a file): no throw, logging switches itself off for retryMs
    const blocker = join(logDir, "blocker");
    writeFileSync(blocker, "x");
    let clock = 1000;
    const broken = new LogFile({ dir: () => join(blocker, "logs"), base: "plugin", capBytes: 200, keep: 3, maxQueue: 10, flushDelayMs: 0, retryMs: 5000, now: () => clock });
    broken.append("a");
    broken.flush();
    assert.equal(broken.disabled, true);
    broken.append("b"); // ignored while off
    broken.flush();
    clock += 5001;
    assert.equal(broken.disabled, false); // tries again later
    const throwingDir = new LogFile({ dir: () => { throw new Error("no appData"); }, base: "plugin", capBytes: 200, keep: 3, maxQueue: 10, flushDelayMs: 0, retryMs: 5000 });
    throwingDir.append("a");
    throwingDir.flush(); // never throws
    assert.equal(throwingDir.disabled, true);
    assert.equal(existsSync(join(blocker, "logs")), false);
} finally {
    rmSync(logDir, { recursive: true, force: true });
}

// RateLimiter (renderer → plugin.log: 20 lines/s, extras dropped and reported once)
const rl = new RateLimiter(20, 1000);
for (let i = 0; i < 20; i++) assert.deepEqual(rl.take(i), { ok: true, report: 0 });
assert.deepEqual(rl.take(500), { ok: false, report: 0 });
assert.deepEqual(rl.take(999), { ok: false, report: 0 });
assert.equal(rl.msLeft(999), 1);
assert.equal(rl.drain(999), 0); // window still open
assert.deepEqual(rl.take(1000), { ok: true, report: 2 }); // new window: report the 2 dropped lines first
assert.deepEqual(rl.take(1001), { ok: true, report: 0 }); // reported once
const rl2 = new RateLimiter(2, 1000);
rl2.take(0);
rl2.take(1);
assert.equal(rl2.take(2).ok, false);
assert.equal(rl2.pending, 1);
assert.equal(rl2.drain(1000), 1); // a timer reports drops when no further line comes
assert.equal(rl2.pending, 0);
assert.equal(rl2.drain(1000), 0);
assert.deepEqual(rl2.take(1500), { ok: true, report: 0 }); // already reported by drain
// a clock that steps backwards starts a new window instead of stalling logging
const rl3 = new RateLimiter(2, 1000);
rl3.take(5000);
rl3.take(5001);
assert.equal(rl3.take(5002).ok, false);
assert.ok(rl3.msLeft(1000) <= 1000); // never more than one window away
assert.equal(rl3.drain(1000), 1); // the window it was in is over
assert.equal(rl3.take(4000).ok, true); // clock now behind the window again... still new window
assert.deepEqual(rl3.take(4001), { ok: true, report: 0 });
assert.equal(rl3.take(4002).ok, false);
assert.deepEqual(rl3.take(100), { ok: true, report: 1 }); // stepped back: new window, drops reported

// summary: only o2i's own settings (by key), deep copies, nothing else
const store = {
    enabled: true,
    enginePath: "C:\\o2i\\o2i.exe",
    profile: { name: "default", routed_apps: [{ name: "Spotify.exe", volume: 1 }] },
    token: "secret-token",
    otherPluginSetting: { x: 1 },
    fn: () => 1,
};
const picked = pickSettings(store, ["enabled", "enginePath", "profile", "missing", "fn", "__proto__", "constructor"]);
assert.deepEqual(Object.keys(picked).sort(), ["enabled", "enginePath", "profile"]);
assert.equal("token" in picked, false);
assert.equal("otherPluginSetting" in picked, false);
(picked.profile as typeof store.profile).routed_apps[0].volume = 0;
assert.equal(store.profile.routed_apps[0].volume, 1); // a copy, not the live store
assert.deepEqual(pickSettings(null, ["enabled"]), {});
const summary = buildSummary({
    generatedAt: "2026-10-22T08:00:00.000Z",
    engineVersion: "0.9.0",
    vencord: { version: "1.15.12", gitHash: "b0e636df" },
    discord: { version: "1.0.9200", releaseChannel: "stable", build: 123456 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    engine: { status: "running", generation: 2, lastError: null, audio: "running", audioError: null },
    devices: { ev: "devices", inputs: [{ id: "m", name: "Mic" }], outputs: [], cable: null },
    discordVoice: null,
    settings: store,
    settingKeys: ["enabled", "enginePath", "profile"],
});
const summaryText = JSON.stringify(summary);
assert.equal(summaryText.includes("secret-token"), false);
assert.equal(summaryText.includes("otherPluginSetting"), false);
assert.equal((summary.o2i as { engineVersion: string; }).engineVersion, "0.9.0");
assert.deepEqual(Object.keys(summary.settings as object).sort(), ["enabled", "enginePath", "profile"]);
assert.equal((summary.settings as typeof store).profile.name, "default");
assert.equal(summary.userAgent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

// sources: several soundboard folders (sb_folders, else the legacy sb_folder), like the engine's sources()
assert.deepEqual(sourcesOf(undefined), []);
assert.deepEqual(sourcesOf({}), []);
assert.deepEqual(sourcesOf({ sb_folder: win`C:\old` }), [win`C:\old`]); // legacy single folder
assert.deepEqual(sourcesOf({ sb_folder: "   " }), []);
assert.deepEqual(sourcesOf({ sb_folder: null, sb_folders: [] }), []);
assert.deepEqual(sourcesOf({ sb_folder: win`C:\old`, sb_folders: [] }), [win`C:\old`]); // empty list: sb_folder
assert.deepEqual(sourcesOf({ sb_folder: win`C:\old`, sb_folders: ["", "  "] }), [win`C:\old`]); // blank entries ignored
assert.deepEqual(sourcesOf({ sb_folder: win`C:\old`, sb_folders: [win`D:\a`, win`E:\b`] }), [win`D:\a`, win`E:\b`]); // the list wins
assert.deepEqual(sourcesOf({ sb_folders: [win`D:\a`, "d:/A/", win`E:\b`] }), [win`D:\a`, win`E:\b`]); // same folder once

// pathJoinWin: what the engine reports as clips[].path (Rust's PathBuf::join on Windows)
assert.equal(pathJoinWin(win`C:\s`, "a.mp3"), win`C:\s\a.mp3`);
assert.equal(pathJoinWin("C:\\s\\", "a.mp3"), win`C:\s\a.mp3`);
assert.equal(pathJoinWin("C:/s", "a.mp3"), "C:/s\\a.mp3");
assert.equal(pathJoinWin("C:/s/", "a.mp3"), "C:/s/a.mp3");
assert.equal(pathJoinWin("C:\\", "a.mp3"), win`C:\a.mp3`);
assert.equal(pathJoinWin(win`\\nas\share\fx`, "a.mp3"), win`\\nas\share\fx\a.mp3`);
assert.equal(isBareName("a.mp3"), true);
assert.equal(isBareName("my sound (1).mp3"), true);
assert.equal(isBareName(win`C:\s\a.mp3`), false);
assert.equal(isBareName("C:/s/a.mp3"), false);
assert.equal(isBareName(win`\\nas\share\a.mp3`), false);
assert.equal(isBareName("C:a.mp3"), false); // drive-relative: not a bare name (the engine refuses it too)
assert.equal(isBareName(""), false);
assert.equal(isBareName(".."), false);
assert.equal(baseName(win`C:\s\a.mp3`), "a.mp3");
assert.equal(baseName("C:/s/a.mp3"), "a.mp3");
assert.equal(baseName("a.mp3"), "a.mp3");

// folder dedupe: case, slash style, trailing slashes and \\?\ spellings are the same folder
assert.equal(pathKey("C:\\Sounds\\"), pathKey("c:/sounds"));
assert.equal(pathKey(win`\\?\C:\Sounds`), pathKey(win`C:\sounds`));
assert.equal(pathKey(win`\\?\UNC\nas\fx`), pathKey(win`\\nas\fx`));
assert.notEqual(pathKey(win`C:\sounds`), pathKey(win`C:\sounds2`));
assert.deepEqual(addSource([win`C:\a`], win`D:\b`), [win`C:\a`, win`D:\b`]);
assert.equal(addSource([win`C:\Sounds`], "c:/sounds/"), null); // duplicate
assert.equal(addSource([win`C:\a`], "  "), null);
assert.deepEqual(removeSource([win`C:\a`, win`D:\b`], win`C:\a`), [win`D:\b`]);
assert.deepEqual(removeSource([win`C:\a`, win`D:\b`], "c:/A/"), [win`D:\b`]);
// every sources write sets both fields; removing the last folder can't bring the legacy sb_folder back
assert.deepEqual(withSources({ name: "d", sb_folder: win`C:\a`, sb_folders: [win`C:\a`] }, []), { name: "d", sb_folder: null, sb_folders: [] });
assert.deepEqual(withSources({ name: "d" }, [win`D:\b`, win`E:\c`]), { name: "d", sb_folder: win`D:\b`, sb_folders: [win`D:\b`, win`E:\c`] });

// chip labels: the folder's name; equal names get parent segments until they differ
assert.deepEqual(sourceLabels([win`C:\Sounds\memes`, win`D:\fx`]), ["memes", "fx"]);
assert.deepEqual(sourceLabels([win`C:\a\sounds`, win`D:\b\Sounds`, win`C:\music`]), [win`a\sounds`, win`b\Sounds`, "music"]);
assert.deepEqual(sourceLabels([win`C:\x\sounds`, win`D:\x\sounds`]), [win`C:\x\sounds`, win`D:\x\sounds`]);
assert.deepEqual(sourceLabels(["C:\\", win`D:\fx`]), ["C:", "fx"]);
assert.deepEqual(sourceLabels([win`\\nas\share`]), ["share"]);
assert.deepEqual(sourceLabels([]), []);
// folder rows: the parent (shrinks first) and the folder's own name
assert.deepEqual(splitFolder(win`C:\Users\me\Sounds`), ["C:\\Users\\me\\", "Sounds"]);
assert.deepEqual(splitFolder("C:/fx/memes/"), ["C:/fx/", "memes"]);
assert.deepEqual(splitFolder("C:\\"), ["", "C:\\"]);
assert.deepEqual(splitFolder(win`\\nas\share`), ["\\\\nas\\", "share"]);
assert.deepEqual(splitFolder("sounds"), ["", "sounds"]);

// migrateToPaths: legacy bare-name keys → <first folder>\<file>; keys already by path stay
const legacy: O2iProfile = {
    name: "default",
    sb_folder: win`C:\sounds`,
    sb_clip_settings: [
        { name: "airhorn.mp3", vol_others: 0.5, vol_self: 1, hear_local: false },
        { name: win`D:\fx\boom.wav`, vol_others: 1, vol_self: 0.2, hear_local: true },
        // no longer in the folder: still <first folder>\<file>, as the engine resolves legacy names
        { name: "gone.mp3", vol_others: 0.1, vol_self: 0.1, hear_local: false },
    ],
    sb_clip_hotkeys: [["airhorn.mp3", "Ctrl+1"], [win`D:\fx\boom.wav`, "Ctrl+2"]],
    sb_stop_all_hotkey: "F12",
};
const legacyMeta: SoundMetaMap = { "airhorn.mp3": { name: "Horn", emoji: "📯" }, [win`D:\fx\boom.wav`]: { name: "Boom" } };
const legacyCopy = JSON.parse(JSON.stringify({ legacy, legacyMeta }));
const mig = migrateToPaths(legacy, legacyMeta, win`C:\sounds`);
assert.deepEqual(mig.profile.sb_clip_settings!.map(c => c.name), [win`C:\sounds\airhorn.mp3`, win`D:\fx\boom.wav`, win`C:\sounds\gone.mp3`]);
assert.deepEqual(mig.profile.sb_clip_settings![0], { name: win`C:\sounds\airhorn.mp3`, vol_others: 0.5, vol_self: 1, hear_local: false });
assert.deepEqual(mig.profile.sb_clip_hotkeys, [[win`C:\sounds\airhorn.mp3`, "Ctrl+1"], [win`D:\fx\boom.wav`, "Ctrl+2"]]);
assert.deepEqual(mig.soundMeta, { [win`C:\sounds\airhorn.mp3`]: { name: "Horn", emoji: "📯" }, [win`D:\fx\boom.wav`]: { name: "Boom" } });
assert.deepEqual(mig.profile.sb_folders, [win`C:\sounds`]); // sb_folder → sb_folders[0]
assert.equal(mig.profile.sb_folder, win`C:\sounds`); // kept as is (engine back-compat)
assert.equal(mig.profile.sb_stop_all_hotkey, "F12");
assert.equal(mig.moved, 4); // 2 settings + 1 hotkey + 1 name/emoji
assert.deepEqual({ legacy, legacyMeta }, legacyCopy); // inputs never mutated
const mig2 = migrateToPaths(mig.profile, mig.soundMeta, win`C:\sounds`);
assert.deepEqual(mig2.profile, mig.profile); // idempotent
assert.deepEqual(mig2.soundMeta, mig.soundMeta);
assert.equal(mig2.moved, 0);
// sb_folders already set: left as is; legacy keys go into its first folder (never the legacy sb_folder)
const listed = migrateToPaths({ name: "d", sb_folder: win`C:\old`, sb_folders: [win`E:\new`, win`F:\more`], sb_clip_hotkeys: [["a.mp3", "F5"]] }, {}, win`E:\new`);
assert.deepEqual(listed.profile.sb_folders, [win`E:\new`, win`F:\more`]);
assert.deepEqual(listed.profile.sb_clip_hotkeys, [[win`E:\new\a.mp3`, "F5"]]);
// a key already by path wins over a legacy one for the same sound (e.g. a re-import after editing)
const clash = migrateToPaths({
    name: "d",
    sb_folders: [win`C:\s`],
    sb_clip_settings: [
        { name: "a.mp3", vol_others: 0.1, vol_self: 1, hear_local: false },
        { name: win`C:\S\A.mp3`, vol_others: 0.9, vol_self: 1, hear_local: false },
    ],
    sb_clip_hotkeys: [["a.mp3", "F1"], [win`C:\s\a.mp3`, "F2"]],
}, { "a.mp3": { name: "old" }, [win`C:\s\a.mp3`]: { name: "new" } }, win`C:\s`);
assert.deepEqual(clash.profile.sb_clip_settings!.map(c => c.vol_others), [0.9]);
assert.deepEqual(clash.profile.sb_clip_hotkeys, [[win`C:\s\a.mp3`, "F2"]]);
assert.deepEqual(clash.soundMeta, { [win`C:\s\a.mp3`]: { name: "new" } });
assert.equal(clash.dropped, 3);
// a profile without soundboard entries gains only sb_folders
assert.deepEqual(migrateToPaths({ name: "d", sb_folder: win`C:\s` }, {}, win`C:\s`).profile, { name: "d", sb_folder: win`C:\s`, sb_folders: [win`C:\s`] });

// planPathsMigration: once, only with a first folder, after backing up the profile + names as they were
const at = new Date(Date.UTC(2026, 9, 22, 12, 0, 0));
const st = { profile: legacy, soundMeta: legacyMeta, migratedPaths: false, pathsMigrationBackup: null };
const plan = planPathsMigration(st, at);
assert.ok(plan);
assert.equal(plan.migratedPaths, true);
assert.deepEqual(plan.profile, mig.profile);
assert.deepEqual(plan.soundMeta, mig.soundMeta);
assert.equal(plan.moved, 4);
assert.deepEqual(JSON.parse(plan.pathsMigrationBackup), { savedAt: at.toISOString(), profile: legacyCopy.legacy, soundMeta: legacyCopy.legacyMeta });
assert.equal(planPathsMigration(plan, at), null); // done: never again
assert.equal(planPathsMigration({ ...st, migratedPaths: true }, at), null);
// no folder yet: nothing migrated or backed up; it runs once a folder is added
assert.equal(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: null } }, at), null);
assert.equal(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: "  ", sb_folders: [] } }, at), null);
const added = planPathsMigration({ ...st, profile: withSources({ ...legacy, sb_folder: null }, [win`D:\picked`]) }, at);
assert.ok(added);
assert.equal(added.profile.sb_clip_hotkeys![0][0], win`D:\picked\airhorn.mp3`);
assert.ok(Object.hasOwn(added.soundMeta, win`D:\picked\airhorn.mp3`));
// a backup from an earlier migration is never overwritten (re-import of the o2i app's settings)
const again = planPathsMigration({ ...st, pathsMigrationBackup: "earlier" }, at);
assert.equal(again?.pathsMigrationBackup, "earlier");
// a relative / drive-relative first folder never migrates (the engine would take the keys for bare names and refuse them)
assert.equal(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: "sounds" } }, at), null);
assert.equal(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: "C:sounds" } }, at), null);
assert.equal(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: "\\sounds" } }, at), null);
assert.ok(planPathsMigration({ ...st, profile: { ...legacy, sb_folder: win`\\nas\fx` } }, at));
assert.equal(isAbsolutePath("C:\\"), true);
assert.equal(isAbsolutePath("C:/x"), true);
assert.equal(isAbsolutePath(win`\\nas\share`), true);
assert.equal(isAbsolutePath("//nas/share"), true);
assert.equal(isAbsolutePath(win`\\?\C:\x`), true);
assert.equal(isAbsolutePath("C:x"), false);
assert.equal(isAbsolutePath("x"), false);
assert.equal(isAbsolutePath("\\x"), false);
assert.equal(isAbsolutePath(""), false);

// the same file name in two sources: two sounds whose settings, hotkeys and names never collide
const pa = win`C:\a\x.mp3`, pb = win`D:\b\x.mp3`;
const twoSettings = withClipSettings(withClipSettings(undefined, pa, { vol_others: 0.3 }), pb, { vol_self: 0.4 });
assert.deepEqual(twoSettings, [
    { name: pa, vol_others: 0.3, vol_self: 1, hear_local: false },
    { name: pb, vol_others: 1, vol_self: 0.4, hear_local: false },
]);
const pa2 = withClipSettings(twoSettings, pa, { hear_local: true });
assert.deepEqual(pa2[0], { name: pa, vol_others: 0.3, vol_self: 1, hear_local: true });
assert.deepEqual(pa2[1], twoSettings[1]); // the other folder's x.mp3 untouched
const twoKeys = withClipHotkey(withClipHotkey(undefined, pa, "Ctrl+1"), pb, "Ctrl+2");
assert.deepEqual(twoKeys, [[pa, "Ctrl+1"], [pb, "Ctrl+2"]]);
assert.deepEqual(withClipHotkey(twoKeys, pa, null), [[pb, "Ctrl+2"]]);
assert.deepEqual(withClipHotkey(twoKeys, pa, "F3"), [[pb, "Ctrl+2"], [pa, "F3"]]);
const twoMeta = withSoundMeta(withSoundMeta({}, pa, { name: "A" }), pb, { name: "B" });
assert.deepEqual(twoMeta, { [pa]: { name: "A" }, [pb]: { name: "B" } });
// the migration moves a legacy name into the first folder only
assert.deepEqual(
    migrateToPaths({ name: "d", sb_folders: [win`C:\a`, win`D:\b`], sb_clip_hotkeys: [["x.mp3", "F1"], [pb, "F2"]] }, {}, win`C:\a`).profile.sb_clip_hotkeys,
    [[pa, "F1"], [pb, "F2"]]
);
// hotkey conflicts name the sound (its custom name or file name), never by folder
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "Ctrl+1"]] }, { [pa]: { name: "Ex" } }, "ctrl+1", pb), "Already bound to Ex");
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "Ctrl+1"]] }, {}, "Ctrl+1", pb), "Already bound to x");
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "Ctrl+1"]] }, {}, "Ctrl+1", pa), null); // its own key
assert.equal(hotkeyConflict({ sb_stop_all_hotkey: "F12" }, {}, "f12", pa), "Already used by Stop all sounds");
assert.equal(hotkeyConflict({ sb_stop_all_hotkey: "F12", sb_clip_hotkeys: [[pa, "F11"]] }, {}, "F12", null), null); // the stop-all key itself
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "F11"]] }, {}, "F11", null), "Already bound to x");
assert.equal(hotkeyConflict(undefined, undefined, "F1", pa), null);
// a removed folder keeps its sounds' hotkeys: the message says why that sound isn't on the board
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "Ctrl+1"]] }, {}, "Ctrl+1", pb, [win`D:\b`]), "Already bound to x (in a folder you removed)");
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[pa, "Ctrl+1"]] }, {}, "Ctrl+1", pb, [win`C:\a`, win`D:\b`]), "Already bound to x");
assert.equal(inSources(pa, [win`C:\a`]), true);
assert.equal(inSources(pa, ["c:/A/"]), true);
assert.equal(inSources(win`C:\ab\x.mp3`, [win`C:\a`]), false); // a sibling folder with a longer name
assert.equal(inSources(win`C:\x.mp3`, ["C:\\"]), true); // a drive root
assert.equal(inSources("x.mp3", [win`C:\a`]), true); // legacy name: the first folder
assert.equal(inSources("x.mp3", []), false);

// spelling drift: the engine matches sound keys by path_key (case / slash-insensitive, first match wins); so does the plugin
const oldSpelling = "c:/users/me/sounds\\a.mp3"; // migrated from a legacy "c:/users/me/sounds"
const newSpelling = win`C:\Users\me\Sounds\a.mp3`; // clips[].path after removing it and re-adding it with the picker
const driftSettings = [{ name: oldSpelling, vol_others: 0.3, vol_self: 0.7, hear_local: true }];
assert.deepEqual(withClipSettings(driftSettings, newSpelling, { vol_self: 0.5 }), [{ name: newSpelling, vol_others: 0.3, vol_self: 0.5, hear_local: true }]); // one entry, key rewritten, levels kept
assert.deepEqual(
    withClipSettings([...driftSettings, { name: newSpelling, vol_others: 1, vol_self: 1, hear_local: false }], newSpelling, { vol_others: 0.9 }),
    [{ name: newSpelling, vol_others: 0.9, vol_self: 0.7, hear_local: true }] // duplicates collapse into the first (the one the engine uses)
);
assert.deepEqual(withClipHotkey([[oldSpelling, "Ctrl+1"]], newSpelling, "Ctrl+2"), [[newSpelling, "Ctrl+2"]]);
assert.deepEqual(withClipHotkey([[oldSpelling, "Ctrl+1"], [newSpelling, "Ctrl+3"]], newSpelling, null), []);
assert.deepEqual(withSoundMeta({ [oldSpelling]: { name: "Horn", emoji: "📯" } }, newSpelling, { name: "Horn 2" }), { [newSpelling]: { name: "Horn 2", emoji: "📯" } });
assert.deepEqual(withSoundMeta({ [oldSpelling]: { name: "Horn" }, [newSpelling]: { name: "Dup" } }, newSpelling, { name: "" }), {}); // cleared: every spelling goes
const sameMeta = { [oldSpelling]: { name: "Horn" } };
assert.deepEqual(withSoundMeta(sameMeta, newSpelling, { name: "Horn" }), { [newSpelling]: { name: "Horn" } }); // same value, key moves to the current spelling
assert.deepEqual(getSoundMeta({ [oldSpelling]: { name: "Horn" } }, newSpelling), { name: "Horn" });
assert.deepEqual(getSoundMeta({ [oldSpelling]: { name: "First" }, [newSpelling]: { name: "Second" } }, newSpelling), { name: "First" });
const idx = keyIndex([[oldSpelling, "first"], [newSpelling, "second"]]);
assert.equal(idx.get(pathKey(newSpelling)), "first"); // first wins, like the engine
assert.equal(idx.size, 1);
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[oldSpelling, "Ctrl+1"]] }, {}, "Ctrl+1", newSpelling), null); // its own key, other spelling
assert.equal(hotkeyConflict({ sb_clip_hotkeys: [[oldSpelling, "Ctrl+1"]] }, { [newSpelling]: { name: "Horn" } }, "Ctrl+1", pb), "Already bound to Horn");
// remove + re-add with another spelling: the sound keeps its settings and the next edit leaves one entry
let re: O2iProfile = withSources({ name: "d", sb_folders: ["c:/users/me/sounds"], sb_clip_settings: driftSettings, sb_clip_hotkeys: [[oldSpelling, "Ctrl+1"]] }, []);
re = withSources(re, [win`C:\Users\me\Sounds`]);
assert.equal(keyIndex(re.sb_clip_settings!.map(s => [s.name, s] as const)).get(pathKey(newSpelling))?.vol_others, 0.3);
assert.equal(keyIndex(re.sb_clip_hotkeys!).get(pathKey(newSpelling)), "Ctrl+1");
assert.deepEqual(effectiveProfile(re, []).sb_clip_hotkeys, [[oldSpelling, "Ctrl+1"]]); // still registered: inside the re-added folder
re = { ...re, sb_clip_settings: withClipSettings(re.sb_clip_settings, newSpelling, { hear_local: false }) };
assert.deepEqual(re.sb_clip_settings, [{ name: newSpelling, vol_others: 0.3, vol_self: 0.7, hear_local: false }]);
assert.deepEqual(DEFAULT_CLIP, { vol_others: 1, vol_self: 1, hear_local: false });

// clipsStale: a clips reply from before the folders changed (asked again instead of shown)
const cl2 = (source: string, file: string) => ({ file, duration_s: 1, path: pathJoinWin(source, file), source });
const srcs = [win`C:\a`, win`D:\b`];
assert.equal(clipsStale({ folder: win`C:\a`, clips: [cl2(win`C:\a`, "x.mp3"), cl2(win`D:\b`, "x.mp3")] }, srcs), false);
assert.equal(clipsStale({ folder: "c:/A/", clips: [cl2("c:/A/", "x.mp3")] }, srcs), false); // other spelling of the same folder
assert.equal(clipsStale({ folder: win`E:\old`, clips: [] }, srcs), true); // another first folder
assert.equal(clipsStale({ folder: null, clips: [] }, srcs), true);
assert.equal(clipsStale({ folder: win`C:\a`, clips: [cl2(win`F:\removed`, "y.mp3")] }, srcs), true); // a removed folder's sounds
assert.equal(clipsStale({ folder: null, clips: [] }, []), false);

// findClip: the listed sound a path names (NowPlaying "Volume", the open editor), matched by pathKey
const soundList = [cl2(win`C:\Sounds`, "Boom.mp3"), cl2(win`D:\b`, "x.mp3")];
assert.equal(findClip(soundList, win`C:\Sounds\Boom.mp3`), soundList[0]);
assert.equal(findClip(soundList, "c:/sounds/BOOM.mp3"), soundList[0]); // other case / slashes: still that sound
assert.equal(findClip(soundList, win`\\?\C:\Sounds\Boom.mp3`), soundList[0]);
assert.equal(findClip(soundList, win`F:\removed\Boom.mp3`), undefined); // its folder was removed: no editor
assert.equal(findClip(soundList, null), undefined);
assert.equal(findClip(undefined, win`C:\Sounds\Boom.mp3`), undefined); // still loading

// duplicateSourceTags: a file name found in several folders shows its folder's label on the tile
const tags = duplicateSourceTags([cl2(win`C:\a`, "x.mp3"), cl2(win`D:\b`, "X.mp3"), cl2(win`D:\b`, "y.mp3")], srcs);
assert.deepEqual([...tags], [[win`C:\a\x.mp3`, "a"], [win`D:\b\X.mp3`, "b"]]);
assert.equal(duplicateSourceTags([cl2(win`C:\a`, "x.mp3"), cl2(win`C:\a`, "y.mp3")], [win`C:\a`]).size, 0); // one folder: no tags

// seek: pointer x -> seconds (0.1 s resolution, clamped), keyboard steps, snap-back guard
assert.equal(posFromX(50, 100, 60), 30);
assert.equal(posFromX(-10, 100, 60), 0);
assert.equal(posFromX(500, 100, 60), 60);
assert.equal(posFromX(33.3, 100, 10), 3.3);
assert.equal(posFromX(1, 300, 10), 0); // 0.033 s rounds to 0.0
assert.equal(posFromX(10, 0, 60), 0);
assert.equal(posFromX(10, -5, 60), 0);
assert.equal(posFromX(10, 100, 0), 0);
assert.equal(posFromX(Number.NaN, 100, 60), 0);
assert.equal(stepSeek(10, 5, 60), 15);
assert.equal(stepSeek(2, -5, 60), 0);
assert.equal(stepSeek(58, 5, 60), 60);
assert.equal(stepSeek(10.04, 5, 60), 15);
assert.equal(seekPending(30, 10, 200), true); // far from the target, just released
assert.equal(seekPending(30, 29.8, 200), false); // reached
assert.equal(seekPending(30, 10, 1000), false); // timed out
assert.equal(seekPending(30, 10, 999), true);

assert.equal(throttleWait(0, 1000, 100), 0);
assert.equal(throttleWait(1000, 1040, 100), 60);
assert.equal(throttleWait(1000, 1100, 100), 0);
assert.equal(throttleWait(1000, 900, 100), 100); // clock went backwards: never longer than the interval

// makeRedactor: the exported logs never carry the Windows home folder or the user name
const red = makeRedactor(win`C:\Users\Alex`, "Alex");
assert.equal(red(win`C:\Users\Alex\AppData\Roaming\o2i\logs`), win`%USERPROFILE%\AppData\Roaming\o2i\logs`);
assert.equal(red("c:/USERS/ALEX/Music/a.mp3"), "%USERPROFILE%/Music/a.mp3"); // any case, forward slashes
assert.equal(red(win`c:\USERS\alex`), "%USERPROFILE%"); // the folder itself
assert.equal(red(win`\\?\C:\Users\Alex\x.mp3`), win`\\?\%USERPROFILE%\x.mp3`); // long-path prefix
assert.equal(red(win`\??\C:\Users\Alex\x.mp3`), win`\??\%USERPROFILE%\x.mp3`);
assert.equal(red(JSON.stringify({ p: win`C:\Users\Alex\x` })), JSON.stringify({ p: win`%USERPROFILE%\x` })); // summary.json (escaped backslashes)
assert.equal(red(win`a C:\\Users/Alex\\b and C:/Users/Alex.`), win`a %USERPROFILE%\\b and %USERPROFILE%.`); // mixed, several, sentence end
assert.equal(red(win`D:\alex\Sounds\x.mp3`), win`D:\<user>\Sounds\x.mp3`); // the name elsewhere
assert.equal(red("Headphones (Alex's AirPods)"), "Headphones (<user>'s AirPods)"); // device names too
assert.equal(red(win`C:\Users\Alexander\x`), win`C:\Users\Alexander\x`); // another user's folder: not his
assert.equal(red(win`C:\Users\Alex.old\x`), win`C:\Users\<user>.old\x`); // not the home folder, but the name still goes
assert.equal(red("alexa, Alex2, xalex"), "alexa, Alex2, xalex"); // the name only as a whole word
assert.equal(red(""), "");
assert.equal(makeRedactor(null, null)(win`C:\Users\Alex\x`), win`C:\Users\Alex\x`);
assert.equal(makeRedactor("C:\\Users\\Alex\\", null)(win`C:\Users\Alex\x`), win`%USERPROFILE%\x`); // trailing slash in homedir
assert.equal(makeRedactor("C:\\", null)(win`C:\x`), win`C:\x`); // a drive root is never redacted
const shortName = makeRedactor(win`C:\Users\me`, "me");
assert.equal(shortName(win`C:\Users\me\x`), win`%USERPROFILE%\x`);
assert.equal(shortName("message me later"), "message me later"); // names under 3 characters only inside the home folder
const dotted = makeRedactor(win`C:\Users\j.doe`, "j.doe");
assert.equal(dotted(win`C:\Users\jXdoe\x`), win`C:\Users\jXdoe\x`); // regex characters are literal
assert.equal(dotted("j.doe's mic, J.DOE"), "<user>'s mic, <user>");
assert.equal(makeRedactor(win`C:\Users\Zoë`, "Zoë")("Zoë's mic, Zoëy"), "<user>'s mic, Zoëy"); // non-ASCII names

// redactJson: summary.json is redacted value by value (and key by key) before JSON.stringify, never as JSON text
const nate = makeRedactor(win`C:\Users\nate`, "nate");
const natey = JSON.stringify(redactJson({ m: "boom\nate later", t: "x\tnate y", p: win`D:\nate\fx`, q: "boom nate later" }, nate));
const nateBack = JSON.parse(natey); // valid JSON (the text way could produce `\<user>`)
assert.equal(nateBack.m, "boom\nate later"); // a newline then "ate": no name in the value, left as it is
assert.equal(nateBack.t, "x\t<user> y"); // right after a tab (the text way missed it: `\tnate`)
assert.equal(nateBack.p, win`D:\<user>\fx`);
assert.equal(nateBack.q, "boom <user> later");
assert.equal(JSON.parse(JSON.stringify(redactJson({ m: "\u0007nate" }, nate))).m, "\u0007<user>"); // after a \uXXXX escape
const keyed = redactJson({ soundMeta: { [win`C:\Users\nate\a.mp3`]: { name: "nate's horn" } }, n: [1, null, true, "nate"] }, nate) as any;
assert.deepEqual(Object.keys(keyed.soundMeta), [win`%USERPROFILE%\a.mp3`]); // keys can be paths too
assert.equal(keyed.soundMeta[win`%USERPROFILE%\a.mp3`].name, "<user>'s horn");
assert.deepEqual(keyed.n, [1, null, true, "<user>"]); // other values untouched
const proto = redactJson(JSON.parse('{"__proto__": {"x": "nate"}}'), nate) as any;
assert.equal(Object.getPrototypeOf(proto), null); // a "__proto__" key stays a plain key
assert.equal(JSON.parse(JSON.stringify(proto)).__proto__.x, "<user>");

// ---- mic mute ----

// fallbackMuteDecision: falling back to the real mic while o2i's mic is muted self-mutes Discord; recovery puts back Discord's own mute
assert.deepEqual(fallbackMuteDecision(true, false, "fallback", null), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(true, false, "recover", false), { setDiscordMute: false, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null });
// Discord was already self-muted: it stays muted, and recovery leaves it muted
assert.deepEqual(fallbackMuteDecision(true, true, "fallback", null), { setDiscordMute: true, saveDiscordMute: true, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(true, true, "recover", true), { setDiscordMute: true, saveDiscordMute: null, toastSuffix: null });
// a second fallback before any recovery keeps the first saved state (Discord is self-muted by o2i by then)
assert.deepEqual(fallbackMuteDecision(true, true, "fallback", false), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(false, true, "fallback", false), { setDiscordMute: null, saveDiscordMute: false, toastSuffix: null });
// nothing saved: recovery never touches Discord's self-mute
assert.deepEqual(fallbackMuteDecision(true, true, "recover", null), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(false, false, "recover", null), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null });
// a saved value only counts while Discord is still self-muted: unmuted by hand since, it is stale
assert.deepEqual(fallbackMuteDecision(true, false, "fallback", true), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", false), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(true, false, "recover", true), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null }); // never re-mutes him

// onCableExactly: what a restore of Discord's own mute waits for. Discord's start-up placeholder input ("default", devices
// not listed yet) and its Default entry never count: Discord may land on the real mic from there
const cableDevs = [{ id: "default", name: "Default" }, { id: "c", name: "CABLE Output (VB-Audio Virtual Cable)" }, { id: "m", name: "Microphone (Realtek(R) Audio)" }];
assert.equal(onCableExactly("default", []), false); // placeholder filtered out (disabled): nothing listed
assert.equal(onCableExactly("default", [{ id: "default", name: "No Input Devices" }]), false); // placeholder as listed
assert.equal(onCableExactly("default", cableDevs), false); // Default may be CABLE, but not surely
assert.equal(onCableExactly("m", cableDevs), false);
assert.equal(onCableExactly(null, cableDevs), false);
assert.equal(onCableExactly("c", cableDevs), true); // exactly CABLE Output, devices listed
assert.equal(onCableExactly("c", [{ id: "c", name: "CABLE Output (VB-Audio Virtual Cable)" }]), true);

// muteRestoreDue: Discord's own mute comes back only once Discord has been on CABLE for 1 s with the engine running and no episode
const due = (o: Partial<Parameters<typeof muteRestoreDue>[0]>) =>
    muteRestoreDue({ fallenBack: false, saved: false, engineRunning: true, onCable: () => true, since: null, now: 10000, ...o });
assert.deepEqual(due({}), { since: 10000, restore: false }); // just switched: wait
assert.deepEqual(due({ since: 10000, now: 10999 }), { since: 10000, restore: false });
assert.deepEqual(due({ since: 10000, now: 11000 }), { since: 10000, restore: true });
assert.deepEqual(due({ saved: true, since: 10000, now: 11500 }), { since: 10000, restore: true });
assert.deepEqual(due({ since: 10000, now: 11000, onCable: () => false }), { since: null, restore: false }); // not on CABLE (yet): the wait starts over
assert.deepEqual(due({ since: 10000, now: 11000, engineRunning: false }), { since: null, restore: false }); // no engine: o2i's mute isn't there
let dueAsked = false;
assert.deepEqual(due({ since: 10000, now: 11000, fallenBack: true, onCable: () => (dueAsked = true) }), { since: null, restore: false }); // the episode runs
assert.deepEqual(due({ since: 10000, now: 11000, saved: null, onCable: () => (dueAsked = true) }), { since: null, restore: false }); // nothing to put back
assert.equal(dueAsked, false); // Discord's input is only read when a restore could be due
assert.deepEqual(due({ since: 12000, now: 11000 }), { since: 12000, restore: false }); // clock stepped back: wait

// the power paths, as the sequence of decisions they make (the saved value is persisted between them)
// power off while o2i's mic is muted and Discord (unmuted) is on CABLE: self-muted before the switch to the real mic
const off = fallbackMuteDecision(true, false, "fallback", null);
assert.deepEqual(off, { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
// power on (or a Discord restart with the switch back still waiting): Discord sits on the real mic, still self-muted
const on = fallbackMuteDecision(true, true, "fallback", off.saveDiscordMute);
assert.deepEqual(on, { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
// back on CABLE for 1 s: Discord's own (unmuted) state comes back and nothing stays saved
assert.equal(due({ saved: on.saveDiscordMute, since: 10000, now: 11000 }).restore, true);
assert.deepEqual(fallbackMuteDecision(true, true, "recover", on.saveDiscordMute), { setDiscordMute: false, saveDiscordMute: null, toastSuffix: null });
// he was self-muted in Discord already: it stays muted all the way
const offMuted = fallbackMuteDecision(true, true, "fallback", null);
assert.deepEqual(fallbackMuteDecision(true, true, "recover", fallbackMuteDecision(true, true, "fallback", offMuted.saveDiscordMute).saveDiscordMute).setDiscordMute, true);
// power off with o2i not muted: Discord's mute untouched, nothing saved
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null });

// savedAfterHandChange: Discord found unmuted while o2i's self-mute is saved means he unmuted it himself: forget it,
// so a later hand re-mute is never lifted by a restore
assert.equal(savedAfterHandChange(false, false), null); // he unmuted Discord
assert.equal(savedAfterHandChange(true, false), null);
assert.equal(savedAfterHandChange(false, true), false); // still muted (o2i's mute): kept
assert.equal(savedAfterHandChange(null, false), null);
assert.equal(savedAfterHandChange(null, true), null);
const handRemuted = savedAfterHandChange(savedAfterHandChange(false, false), true); // unmuted by hand, then muted by hand
assert.equal(handRemuted, null);
assert.deepEqual(fallbackMuteDecision(true, true, "recover", handRemuted), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null }); // his mute stays

// o2i's mic unmuted anywhere (also outside an episode) while Discord's mute is o2i's doing: lifted right away
assert.deepEqual(fallbackMuteDecision(false, true, "recover", false), { setDiscordMute: false, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(false, true, "recover", true), { setDiscordMute: true, saveDiscordMute: null, toastSuffix: null }); // he had muted it before: stays

// o2iMuteTransition: on every change of o2i's effective mute, in or out of an episode. Muted while Discord isn't
// surely on CABLE (devices not listed counts as not on CABLE) self-mutes Discord; unmuted lifts a Discord mute that is o2i's doing
assert.equal(o2iMuteTransition(true, () => false, null), "mute-discord");
assert.equal(o2iMuteTransition(true, () => false, false), "mute-discord"); // a saved value is kept by the rule
assert.equal(o2iMuteTransition(true, () => true, null), "none"); // on CABLE: o2i's own mute covers it
assert.equal(o2iMuteTransition(false, () => false, false), "lift");
assert.equal(o2iMuteTransition(false, () => false, true), "lift");
assert.equal(o2iMuteTransition(false, () => true, false), "lift"); // also on CABLE (before the 1 s restore)
assert.equal(o2iMuteTransition(false, () => false, null), "none"); // his own Discord mute: never touched
let liftCableAsked = false;
o2iMuteTransition(false, () => (liftCableAsked = true), false);
assert.equal(liftCableAsked, false); // Discord's input is only read for a mute
// the reviewer's sequence: on the real mic outside an episode (after a re-enable or a restart mid-episode), Discord
// self-muted by o2i (he was unmuted before). Unmute o2i: lifted. Mute o2i again: self-muted again, his prior state saved
let seqSaved: boolean | null = false;
let seqDiscordMuted = true;
assert.equal(o2iMuteTransition(false, () => false, seqSaved), "lift");
const lift = fallbackMuteDecision(false, seqDiscordMuted, "recover", seqSaved);
assert.deepEqual(lift, { setDiscordMute: false, saveDiscordMute: null, toastSuffix: null });
seqSaved = lift.saveDiscordMute;
seqDiscordMuted = lift.setDiscordMute ?? seqDiscordMuted;
assert.equal(o2iMuteTransition(true, () => false, seqSaved), "mute-discord");
const remute = fallbackMuteDecision(true, seqDiscordMuted, "fallback", seqSaved);
assert.deepEqual(remute, { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });

// effectiveMute: what the mute rule and the UI count as o2i's mic being muted; an engine known to have no mute
// (the last one that reported) never counts, unknown (no engine has reported yet) keeps the saved value
assert.equal(effectiveMute(true, null), true);
assert.equal(effectiveMute(true, true), true);
assert.equal(effectiveMute(true, false), false);
assert.equal(effectiveMute(false, true), false);
assert.equal(effectiveMute(false, null), false);

// restoreDropped: power on/off or a plugin start with the switch back to CABLE waiting, after another mic was picked by hand
const dropFacts = (input: string | null, onO2i = false): PowerFacts => ({ onO2i: () => onO2i, micKnown: () => true, fallenBack: false, inputId: () => input });
assert.equal(restoreDropped(OFF_CABLE, dropFacts("u")), true);
assert.equal(restoreDropped(ON_PENDING, dropFacts("u")), true);
assert.equal(restoreDropped(OFF_CABLE, dropFacts("m")), false); // still on the input it was left on
assert.equal(restoreDropped(OFF_CABLE, dropFacts("c", true)), false); // back on o2i: done, not dropped
assert.equal(restoreDropped({ ...OFF_CABLE, restoreFrom: null }, dropFacts("u")), false); // unknown input never drops
let dropAsked = false;
assert.equal(restoreDropped(OFF, { ...dropFacts("u"), inputId: () => { dropAsked = true; return "u"; } }), false); // nothing waiting
assert.equal(dropAsked, false);

// the plugin's recorder: the mute row takes bare keys and mouse buttons 3-5; soundboard rows keep their rules
assert.equal(hotkeyProblem("V", "mute"), null);
assert.equal(hotkeyProblem("Mouse4", "mute"), null);
assert.notEqual(hotkeyProblem("V"), null);
assert.notEqual(hotkeyProblem("V", "soundboard"), null);
// soundboard rows take Mouse3-5, bare or with modifiers; left and right click stay refused
for (const ok of ["Mouse4", "Mouse3", "Ctrl+Mouse5", "Shift+Mouse4", "Win+Mouse4", "mouse5"]) assert.equal(hotkeyProblem(ok, "soundboard"), null, ok);
assert.equal(hotkeyProblem("Mouse4"), null);
assert.equal(hotkeyProblem("Mouse1"), "Left and right click can't be hotkeys");
assert.equal(hotkeyProblem("Ctrl+Mouse2", "soundboard"), "Left and right click can't be hotkeys");
assert.notEqual(hotkeyProblem("Mouse9", "soundboard"), null);
assert.notEqual(hotkeyProblem("Mouse", "soundboard"), null);
assert.equal(hotkeyProblem("Ctrl+A", "soundboard"), null);
assert.equal(hotkeyProblem("F8", "soundboard"), null);
for (const ok of ["Ctrl+Shift+M", "Mouse3", "Mouse5", "Ctrl+Mouse5", "Win+F13", "Space", "Num0", "NumEnter", "CapsLock", "F24", "Shift+Tab", "ArrowUp", "Backquote", "ctrl + shift + m"]) {
    assert.equal(hotkeyProblem(ok, "mute"), null, ok);
}
for (const bad of ["", "  ", "Ctrl+", "+V", "Ctrl", "Ctrl+Shift", "Mouse1", "Mouse2", "Mouse9", "Hyper+V", "V+Ctrl", "Ctrl+Ctrl+V", "Escape", "Backspace", "F25", "NumpadEqual"]) {
    assert.notEqual(hotkeyProblem(bad, "mute"), null, bad);
}

// keyEventToMuteSpec / mouseButtonToMuteSpec: what the mute row records
const km = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
assert.equal(keyEventToMuteSpec({ ...km, code: "KeyV" }), "V");
assert.equal(keyEventToMuteSpec({ ...km, code: "KeyM", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+M");
assert.equal(keyEventToMuteSpec({ ...km, code: "Digit7", altKey: true }), "Alt+7");
assert.equal(keyEventToMuteSpec({ ...km, code: "Space" }), "Space");
assert.equal(keyEventToMuteSpec({ ...km, code: "CapsLock" }), "CapsLock");
assert.equal(keyEventToMuteSpec({ ...km, code: "F20" }), "F20");
assert.equal(keyEventToMuteSpec({ ...km, code: "Numpad0" }), "Num0");
assert.equal(keyEventToMuteSpec({ ...km, code: "NumpadEnter" }), "NumEnter");
assert.equal(keyEventToMuteSpec({ ...km, code: "KeyX", metaKey: true }), "Win+X");
assert.equal(keyEventToMuteSpec({ ...km, code: "ShiftLeft", shiftKey: true }), null); // a modifier on its own
assert.equal(keyEventToMuteSpec({ ...km, code: "MetaLeft", metaKey: true }), null);
assert.equal(keyEventToMuteSpec({ ...km, code: "Escape" }), null); // the recorder's cancel key
assert.equal(keyEventToMuteSpec({ ...km, code: "Backspace" }), null); // ...and its clear key
assert.equal(keyEventToMuteSpec({ ...km, code: "IntlRo" }), null); // the engine doesn't know it
assert.equal(mouseButtonToMuteSpec({ ...km, button: 1 }), "Mouse3");
assert.equal(mouseButtonToMuteSpec({ ...km, button: 3 }), "Mouse4");
assert.equal(mouseButtonToMuteSpec({ ...km, button: 4, ctrlKey: true }), "Ctrl+Mouse5");
assert.equal(mouseButtonToMuteSpec({ ...km, button: 0 }), null); // left click: never a hotkey
assert.equal(mouseButtonToMuteSpec({ ...km, button: 2 }), null); // right click
// everything the recorder can produce passes the mute row's check
for (const code of ["KeyA", "KeyZ", "Digit0", "F1", "F24", "Numpad9", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
    "Space", "Tab", "Enter", "CapsLock", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowDown", "Backquote", "Minus", "Equal",
    "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "ScrollLock", "Pause", "NumLock", "PrintScreen",
    "MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop", "AudioVolumeMute", "AudioVolumeUp", "AudioVolumeDown"]) {
    const spec = keyEventToMuteSpec({ ...km, code, ctrlKey: true, metaKey: true });
    assert.ok(spec, code);
    assert.equal(hotkeyProblem(spec, "mute"), null, spec);
}
for (const button of [1, 3, 4]) assert.equal(hotkeyProblem(mouseButtonToMuteSpec({ ...km, button, shiftKey: true })!, "mute"), null);

// a bare (or Shift-only) typing key also mutes / unmutes while typing: the row says so
assert.equal(muteKeyFiresWhileTyping("V"), true);
assert.equal(muteKeyFiresWhileTyping("Space"), true);
assert.equal(muteKeyFiresWhileTyping("Shift+V"), true);
assert.equal(muteKeyFiresWhileTyping("Ctrl+V"), false);
assert.equal(muteKeyFiresWhileTyping("F13"), false);
assert.equal(muteKeyFiresWhileTyping("Mouse4"), false);
assert.equal(muteKeyFiresWhileTyping("CapsLock"), false);
assert.equal(muteKeyFiresWhileTyping(null), false);
// side buttons are also Discord's back / forward: the row says so
assert.equal(muteKeyIsSideButton("Mouse4"), true);
assert.equal(muteKeyIsSideButton("Ctrl+mouse5"), true);
assert.equal(muteKeyIsSideButton("Mouse3"), false);
assert.equal(muteKeyIsSideButton("V"), false);
assert.equal(muteKeyIsSideButton(null), false);

// mouse sound hotkeys against the mute and push-to-talk keys, both ways (a bare key fires whatever modifiers are held)
{
    const sp = win`C:\s\a.mp3`;
    const sm = { sb_clip_hotkeys: [[sp, "Mouse4"]] as [string, string][] };
    assert.equal(hotkeyConflict({ mic_mute_hotkey: "Mouse4" }, {}, "Mouse4", sp), "Already used by the mute hotkey");
    assert.equal(hotkeyConflict({ mic_mute_hotkey: "Mouse4" }, {}, "Ctrl+Mouse4", sp), "Already used by the mute hotkey");
    assert.equal(hotkeyConflict({ mic_mute_hotkey: "Ctrl+Mouse4" }, {}, "Mouse4", sp), null);
    assert.equal(hotkeyConflict({ ptt_key: "Mouse5" }, {}, "Mouse5", sp), "Already used by the push-to-talk key");
    assert.equal(hotkeyConflict({ ptt_key: "Mouse5" }, {}, "Alt+Mouse5", sp), "Already used by the push-to-talk key");
    assert.equal(hotkeyConflict({ ptt_key: "Mouse5" }, {}, "Mouse4", sp), null);
    assert.equal(muteHotkeyConflict(sm, {}, "Mouse4"), "Already bound to a");
    assert.equal(muteHotkeyConflict(sm, {}, "Mouse4", undefined, "ptt"), "Already bound to a");
    assert.equal(muteHotkeyConflict(sm, {}, "Mouse5"), null);
    assert.equal(muteHotkeyConflict({ sb_clip_hotkeys: [[sp, "Ctrl+Mouse4"]] }, {}, "Mouse4"), "Already bound to a");
    // mute vs push-to-talk, either one bare
    assert.equal(muteHotkeyConflict({ ptt_key: "Ctrl+V" }, {}, "V", undefined, "mute"), "Already used by the push-to-talk key");
    assert.equal(muteHotkeyConflict({ mic_mute_hotkey: "Ctrl+V" }, {}, "V", undefined, "ptt"), "Already used by the mute hotkey");
    assert.equal(muteHotkeyConflict({ mic_mute_hotkey: "V" }, {}, "Ctrl+V", undefined, "ptt"), "Already used by the mute hotkey");
    assert.equal(muteHotkeyConflict({ mic_mute_hotkey: "Ctrl+V" }, {}, "Alt+V", undefined, "ptt"), null);
    assert.equal(muteHotkeyConflict({ mic_mute_hotkey: "Ctrl+V" }, {}, "Ctrl+V", undefined, "ptt"), "Already used by the mute hotkey");
    assert.equal(muteHotkeyConflict({ ptt_key: "V" }, {}, "F9", undefined, "mute"), null);
}

// conflicts between the mute key and the soundboard keys (a bare mute key fires whatever modifiers are held)
const mk = { sb_stop_all_hotkey: "F9", sb_clip_hotkeys: [[win`C:\s\horn.mp3`, "Ctrl+H"]] as [string, string][], mic_mute_hotkey: "V" };
assert.equal(muteHotkeyConflict(mk, {}, "F9"), "Already used by Stop all sounds");
assert.equal(muteHotkeyConflict(mk, {}, "Ctrl+H"), "Already bound to horn");
assert.equal(muteHotkeyConflict(mk, {}, "H"), "Already bound to horn");
assert.equal(muteHotkeyConflict(mk, {}, "ctrl+h"), "Already bound to horn");
assert.equal(muteHotkeyConflict(mk, {}, "Alt+H"), null);
assert.equal(muteHotkeyConflict(mk, {}, "Mouse4"), null);
assert.equal(muteHotkeyConflict(null, {}, "V"), null);
assert.equal(hotkeyConflict(mk, {}, "Ctrl+V", null), "Already used by the mute hotkey"); // bare V also fires on Ctrl+V
assert.equal(hotkeyConflict(mk, {}, "Ctrl+V", win`C:\s\horn.mp3`), "Already used by the mute hotkey");
assert.equal(hotkeyConflict({ ...mk, mic_mute_hotkey: "Ctrl+Shift+V" }, {}, "Ctrl+V", null), null); // combos match exactly
assert.equal(hotkeyConflict({ ...mk, mic_mute_hotkey: "ctrl+shift+v" }, {}, "Ctrl+Shift+V", null), "Already used by the mute hotkey");
assert.equal(hotkeyConflict({ ...mk, mic_mute_hotkey: "Mouse4" }, {}, "Ctrl+V", null), null);

// the mute hotkey is always sent (missing, null or blank: none)
assert.equal(effectiveProfile({ name: "d" }, []).mic_mute_hotkey, null);
assert.equal(effectiveProfile({ name: "d", mic_mute_hotkey: "Mouse4" }, []).mic_mute_hotkey, "Mouse4");
assert.equal(effectiveProfile({ name: "d", mic_mute_hotkey: "  " }, []).mic_mute_hotkey, null);

// push to talk: mic_mode and ptt_key are always sent explicitly (defaults "always" and null)
assert.equal(effectiveProfile({ name: "d" }, []).mic_mode, "always");
assert.equal(effectiveProfile({ name: "d", mic_mode: null }, []).mic_mode, "always");
assert.equal(effectiveProfile({ name: "d", mic_mode: "ptt" }, []).mic_mode, "ptt");
assert.equal(effectiveProfile({ name: "d", mic_mode: "bogus" as never }, []).mic_mode, "always");
assert.equal(effectiveProfile({ name: "d" }, []).ptt_key, null);
assert.equal(effectiveProfile({ name: "d", ptt_key: "Mouse4" }, []).ptt_key, "Mouse4");
assert.equal(effectiveProfile({ name: "d", ptt_key: "  " }, []).ptt_key, null);
assert.equal(effectiveProfile({ name: "d", ptt_key: " V " }, []).ptt_key, "V");
assert.equal(isPttMode({ mic_mode: "ptt" }), true);
assert.equal(isPttMode({ mic_mode: "always" }), false);
assert.equal(isPttMode({}), false);
assert.equal(isPttMode(null), false);

// the fallback self-mutes Discord when o2i's mic was muted OR in PTT mode (key held or not: fail closed)
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null, true), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(false, true, "fallback", null, true), { setDiscordMute: true, saveDiscordMute: true, toastSuffix: ", muted" }); // his own mute is saved
assert.deepEqual(fallbackMuteDecision(false, true, "fallback", false, true), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" }); // an earlier saved value is kept
assert.deepEqual(fallbackMuteDecision(true, false, "fallback", null, true), { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null, false), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null }); // always mode, not muted: nothing
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null }); // pttMode defaults to off
// recovery restores Discord's previous mute whether or not PTT is on
assert.deepEqual(fallbackMuteDecision(false, true, "recover", false, true), { setDiscordMute: false, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(false, true, "recover", true, true), { setDiscordMute: true, saveDiscordMute: null, toastSuffix: null });
assert.deepEqual(fallbackMuteDecision(false, false, "recover", true, true), { setDiscordMute: null, saveDiscordMute: null, toastSuffix: null }); // he unmuted by hand: never re-muted
// the toast: "o2i stopped. You're on your real mic" + suffix
assert.equal(`o2i stopped. You're on your real mic${fallbackMuteDecision(false, false, "fallback", null, true).toastSuffix ?? ""}`, "o2i stopped. You're on your real mic, muted");

// push to talk in a fallback episode: o2i's unmute must not lift the fail-closed self-mute while Discord is off CABLE
assert.equal(o2iMuteTransition(false, () => false, false, true), "none"); // PTT, on the real mic: stays self-muted
assert.equal(o2iMuteTransition(false, () => false, true, true), "none");
assert.equal(o2iMuteTransition(false, () => true, false, true), "lift"); // PTT, surely on CABLE: lifted as before
assert.equal(o2iMuteTransition(false, () => false, null, true), "none"); // his own mute: never touched
assert.equal(o2iMuteTransition(false, () => false, false, false), "lift"); // always mode: unchanged
assert.equal(o2iMuteTransition(true, () => false, null, true), "mute-discord");
// the whole sequence: PTT fallback self-mutes (saved false); o2i muted then unmuted off CABLE keeps Discord muted
const pttFall = fallbackMuteDecision(false, false, "fallback", null, true);
assert.deepEqual(pttFall, { setDiscordMute: true, saveDiscordMute: false, toastSuffix: ", muted" });
assert.equal(o2iMuteTransition(false, () => false, pttFall.saveDiscordMute, true), "none");

// the mic mode changing: entering PTT off CABLE self-mutes Discord; on CABLE or while muted nothing; leaving lifts o2i's self-mute
assert.equal(pttModeTransition(true, false, () => false, null), "mute-discord");
assert.equal(pttModeTransition(true, false, () => true, null), "none");
assert.equal(pttModeTransition(true, true, () => false, null), "none"); // muted: the mute path already handled it
assert.equal(pttModeTransition(false, false, () => false, false), "lift");
assert.equal(pttModeTransition(false, false, () => false, null), "none");
assert.equal(pttModeTransition(false, true, () => false, false), "none");
// entering PTT then applies the rule: Discord self-muted, his own mute saved
assert.deepEqual(fallbackMuteDecision(false, false, "fallback", null, true).setDiscordMute, true);

// PTT key presses never touch Discord's self-mute outside the fallback: mic_open / ptt_key are read by no decision
// in the Discord-voice code path (only the mode, through the transitions above, and only when it changes)
{
    const read = (f: string) => readFileSync(`src/userplugins/o2i/${f}`, "utf8"); // run from the repo root
    for (const f of ["discordVoice.ts", "logic/fallback.ts", "logic/policy.ts"]) {
        const src = read(f);
        assert.equal(/mic_open|micOpen|ptt_key|MicOpen/.test(src), false, `${f} must not react to the PTT key or mic_open`);
    }
    // the only caller of the mute rule for the mode is the mode-change follower, which settings.ts calls on a change only
    assert.match(read("settings.ts"), /if \(ptt !== wasPtt\) followPttMode\(ptt\)/);
}

// micMuteUpdate: a mic_muted event persists and plays a sound only when it changes the plugin's value
assert.deepEqual(micMuteUpdate(false, true), { persist: true, sound: "mute" });
assert.deepEqual(micMuteUpdate(true, false), { persist: false, sound: "unmute" });
assert.deepEqual(micMuteUpdate(true, true), { persist: null, sound: null }); // the re-apply after a respawn: silent
assert.deepEqual(micMuteUpdate(false, false), { persist: null, sound: null });

// muteOnAttach: on every new engine generation (spawn, or a re-attach after Ctrl+R)
assert.deepEqual(muteOnAttach(true, null), { adopt: false, send: true }); // fresh engine (no state yet): mute before audio
assert.deepEqual(muteOnAttach(true, false), { adopt: false, send: true });
assert.deepEqual(muteOnAttach(true, true), { adopt: false, send: false }); // already muted
assert.deepEqual(muteOnAttach(false, true), { adopt: true, send: false }); // muted by the hotkey while Discord reloaded: kept
assert.deepEqual(muteOnAttach(false, false), { adopt: false, send: false }); // never sends an unmute
assert.deepEqual(muteOnAttach(false, undefined), { adopt: false, send: false });

// LatestWaiters (native.ts's waitMicMuteEvent long-poll)
function fakeTimers() {
    let next = 1;
    const live = new Map<number, () => void>();
    return {
        set(fn: () => void, _ms: number) { const id = next++; live.set(id, fn); return id; },
        clear(id: unknown) { live.delete(id as number); },
        fireAll() { for (const [id, fn] of [...live]) { live.delete(id); fn(); } },
        get active() { return live.size; },
    };
}
const ft = fakeTimers();
const mw = new LatestWaiters<{ muted: boolean; source: string; }>(ft, 3);
const got: unknown[] = [];
assert.equal(mw.seq, 0);
mw.wait(25000, mw.seq, v => got.push(v));
assert.equal(mw.pending, 1);
mw.publish({ muted: true, source: "hotkey" });
assert.deepEqual(got.slice(), [{ muted: true, source: "hotkey", seq: 1 }]); // a copy: deepEqual narrows its argument
assert.equal(mw.pending, 0);
assert.equal(ft.active, 0); // its timeout was cleared
// an event between two waits isn't lost: the next wait gets it right away
mw.publish({ muted: false, source: "command" });
mw.wait(25000, 1, v => got.push(v));
assert.deepEqual(got[1], { muted: false, source: "command", seq: 2 });
assert.equal(mw.pending, 0);
// no newer event: resolves null at the timeout
mw.wait(25000, 2, v => got.push(v));
ft.fireAll();
assert.equal(got[2], null);
assert.equal(mw.pending, 0);
// without afterSeq it waits for the next event even when one exists (a fresh renderer never replays an old one)
mw.wait(25000, undefined, v => got.push(v));
assert.equal(got.length, 3);
mw.cancelAll(); // engine stopped: pending waits end with null, timers cleared
assert.equal(got[3], null);
assert.equal(ft.active, 0);
// never more than `max` waiters (a reload storm): the oldest ends with null
const order: string[] = [];
for (const n of ["a", "b", "c", "d"]) mw.wait(25000, 2, v => order.push(`${n}:${v === null ? "null" : (v as { seq: number; }).seq}`));
assert.deepEqual(order, ["a:null"]);
assert.equal(mw.pending, 3);
mw.publish({ muted: true, source: "hotkey" });
assert.deepEqual(order, ["a:null", "b:3", "c:3", "d:3"]);
// a callback that throws never stops the others or the publish
mw.wait(25000, 3, () => { throw new Error("boom"); });
mw.wait(25000, 3, v => order.push(`e:${(v as { seq: number; }).seq}`));
mw.publish({ muted: false, source: "hotkey" });
assert.equal(order[order.length - 1], "e:4");
assert.equal(mw.pending, 0);

// ---- rename to Output2Input ----

// migratePluginSettings: the whole old settings object is deep-copied to the new name once; the old key stays as a backup
const OLD = "o2i", NEW = "Output2Input";
const oldO2i = {
    enabled: true,
    enginePath: win`C:\o2i\o2i.exe`,
    profile: { name: "default", sb_folders: [win`C:\s`], mic_mute_hotkey: "Mouse4" },
    soundMeta: { [win`C:\s\a.mp3`]: { name: "A", emoji: "📯" } },
    micMuted: true,
    savedDiscordMute: false,
    powered: false,
    powerRestoreCable: true,
    powerRestoreFrom: "m",
    pathsMigrationBackup: "{\"profile\":{}}",
    migratedPaths: true,
};
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// old only (the first start after the rename): copied, enabled included, the old key left in place
const oldOnly: Record<string, any> = { [OLD]: plain(oldO2i), Other: { enabled: false } };
assert.equal(migratePluginSettings(oldOnly, OLD, NEW), true);
assert.deepEqual(oldOnly[NEW], oldO2i);
assert.equal(oldOnly[NEW].enabled, true); // so PluginManager starts the renamed plugin
assert.deepEqual(oldOnly[OLD], oldO2i); // the backup
assert.deepEqual(oldOnly.Other, { enabled: false }); // other plugins untouched
assert.notEqual(oldOnly[NEW], oldOnly[OLD]);
oldOnly[NEW].profile.sb_folders.push(win`D:\x`);
oldOnly[NEW].soundMeta[win`C:\s\a.mp3`].name = "changed";
assert.deepEqual(oldOnly[OLD], oldO2i); // a deep copy: changing the new settings never changes the backup
// the second start: the new key has its profile, nothing is copied again
const secondStart = plain(oldOnly);
assert.equal(migratePluginSettings(oldOnly, OLD, NEW), false);
assert.deepEqual(oldOnly, secondStart);
// new only (a fresh install of the renamed plugin, or the old key deleted): unchanged
const newOnly: Record<string, any> = { [NEW]: { enabled: true, profile: { name: "default" }, micMuted: false } };
const newOnlyBefore = plain(newOnly);
assert.equal(migratePluginSettings(newOnly, OLD, NEW), false);
assert.deepEqual(newOnly, newOnlyBefore);
// both, the new one with a stored profile: the new one wins and is untouched
const both: Record<string, any> = { [OLD]: plain(oldO2i), [NEW]: { enabled: false, profile: { name: "new" }, micMuted: false } };
const bothBefore = plain(both);
assert.equal(migratePluginSettings(both, OLD, NEW), false);
assert.deepEqual(both, bothBefore);
// neither (a fresh install): nothing added
const neither: Record<string, any> = { Other: { enabled: true } };
assert.equal(migratePluginSettings(neither, OLD, NEW), false);
assert.deepEqual(neither, { Other: { enabled: true } });
assert.equal(migratePluginSettings({}, OLD, NEW), false);
// the new key exists without a stored profile (only a default { enabled: false } was filled in): copied over it
const defaulted: Record<string, any> = { [OLD]: plain(oldO2i), [NEW]: { enabled: false } };
assert.equal(migratePluginSettings(defaulted, OLD, NEW), true);
assert.deepEqual(defaulted[NEW], oldO2i);
const nullProfile: Record<string, any> = { [OLD]: plain(oldO2i), [NEW]: { enabled: true, profile: null } };
assert.equal(migratePluginSettings(nullProfile, OLD, NEW), true);
assert.deepEqual(nullProfile[NEW], oldO2i);
// an old key that isn't a settings object: nothing to copy (and nothing throws)
for (const bad of [null, undefined, "x", 3, true, []]) {
    const odd: Record<string, any> = { [OLD]: bad };
    assert.equal(migratePluginSettings(odd, OLD, NEW), false);
    assert.equal(NEW in odd, false);
}
const oddNew: Record<string, any> = { [OLD]: plain(oldO2i), [NEW]: "garbage" };
assert.equal(migratePluginSettings(oddNew, OLD, NEW), true); // a non-object new key has no profile either
assert.deepEqual(oddNew[NEW], oldO2i);
// the writer: the copy goes through it (the plugin passes one that assigns through Vencord's Settings proxy, which saves)
const written: [string, unknown][] = [];
const viaWriter: Record<string, any> = { [OLD]: plain(oldO2i) };
assert.equal(migratePluginSettings(viaWriter, OLD, NEW, (key, value) => written.push([key, value])), true);
assert.deepEqual(written, [[NEW, oldO2i]]);
assert.equal(NEW in viaWriter, false); // only the writer writes
// a writer that throws: reported to the caller (index.tsx catches and logs it at module scope)
assert.throws(() => migratePluginSettings({ [OLD]: plain(oldO2i) }, OLD, NEW, () => { throw new Error("no store"); }), /no store/);

// ...and with Vencord's own SettingsStore, set up the way @api/Settings sets it up: reading through the proxy fills in a
// registered plugin's defaults (why existence is checked on the plain object), and the copy, assigned through the proxy,
// reaches the global change listener that saves settings.json (VencordNative.settings.set), with `enabled` carried over
const registered = new Set([NEW]);
const vencordPlain: any = { plugins: { [OLD]: plain(oldO2i) } };
const vencordStore = new SettingsStore<any>(vencordPlain, {
    readOnly: true,
    getDefaultValue({ target, key, path }) {
        if (path === "plugins" && registered.has(key)) return (target[key] = { enabled: false });
        return target[key];
    }
});
const saves: string[] = [];
vencordStore.addGlobalChangeListener((_, path) => saves.push(path));
assert.equal(migratePluginSettings(vencordStore.plain.plugins, OLD, NEW, (key, value) => { vencordStore.store.plugins[key] = value; }), true);
assert.deepEqual(saves, [`plugins.${NEW}`]); // saved once, for the new key
assert.deepEqual(vencordStore.plain.plugins[NEW], oldO2i);
assert.equal(vencordStore.store.plugins[NEW].enabled, true);
assert.deepEqual(vencordStore.plain.plugins[OLD], oldO2i); // the backup stays
assert.equal(migratePluginSettings(vencordStore.plain.plugins, OLD, NEW, (key, value) => { vencordStore.store.plugins[key] = value; }), false);
assert.equal(saves.length, 1); // the next start writes nothing
// a default filled in through the proxy before the migration (some code read the new key first) never blocks the copy
const earlyPlain: any = { plugins: { [OLD]: plain(oldO2i) } };
const earlyStore = new SettingsStore<any>(earlyPlain, {
    readOnly: true,
    getDefaultValue({ target, key, path }) {
        if (path === "plugins" && registered.has(key)) return (target[key] = { enabled: false });
        return target[key];
    }
});
assert.deepEqual(plain(earlyStore.store.plugins[NEW]), { enabled: false }); // the proxy invents the key
assert.equal(migratePluginSettings(earlyStore.plain.plugins, OLD, NEW, (key, value) => { earlyStore.store.plugins[key] = value; }), true);
assert.equal(earlyStore.plain.plugins[NEW].enabled, true);

// ---- Discord's input changed by hand ----

// inputChangeTransition: Discord's input moving off exactly CABLE Output, not by the plugin, while o2i's mic is muted
// runs o2iMuteTransition once (Discord self-muted, its own mute saved); anything else leaves Discord's mute alone
const ic = (o: Partial<Parameters<typeof inputChangeTransition>[0]>) =>
    inputChangeTransition({ wasOnCable: true, onCable: false, ownSwitch: false, muted: true, saved: null, ...o });
assert.equal(ic({}), "mute-discord");
assert.equal(ic({ saved: false }), "mute-discord"); // a saved value is kept by the rule
assert.equal(ic({ saved: true }), "mute-discord");
assert.equal(ic({ muted: false }), "none"); // o2i's mic isn't muted: nothing to carry over
assert.equal(ic({ muted: false, saved: false }), "none"); // never a lift: only o2i's own unmute lifts
assert.equal(ic({ ownSwitch: true }), "none"); // the plugin's fallback / power / restore switch applies the rule itself
assert.equal(ic({ wasOnCable: false }), "none"); // from a real mic (or Default) to another: not away from CABLE
assert.equal(ic({ wasOnCable: null }), "none"); // not known before (just started watching)
assert.equal(ic({ onCable: true }), "none"); // still on (or back onto) CABLE: o2i's own mute covers it
assert.equal(ic({ wasOnCable: false, onCable: true }), "none");
// o2i turned off: its mute isn't in use (the panel shows "off", not "muted") and the power-off already applied the rule
assert.equal(ic({ powered: false }), "none");
assert.equal(ic({ powered: false, saved: false }), "none");
assert.equal(ic({ powered: true }), "mute-discord"); // on (absent counts as on, as above)
// the same answer as o2iMuteTransition for that mute change
assert.equal(ic({}), o2iMuteTransition(true, () => false, null));

// isOwnInputSwitch: the input Discord shows is the one the plugin just asked for (times from performance.now())
assert.equal(isOwnInputSwitch(null, "m", 1000), false);
assert.equal(isOwnInputSwitch({ id: "m", at: 1000 }, "m", 1000), true);
assert.equal(isOwnInputSwitch({ id: "m", at: 1000 }, "m", 2999), true);
assert.equal(isOwnInputSwitch({ id: "m", at: 1000 }, "m", 3000), false); // too long ago: a later change of his
assert.equal(isOwnInputSwitch({ id: "m", at: 1000 }, "u", 1001), false); // another device than the one asked for
assert.equal(isOwnInputSwitch({ id: "m", at: 1000 }, null, 1001), false);
assert.equal(isOwnInputSwitch({ id: "m", at: 5000 }, "m", 1000), true); // clock stepped back: still counts

// shouldAddDefaultFolder: the default sounds folder is added once (flag), unless it is already listed
assert.equal(shouldAddDefaultFolder(true, [], "C:\\o2i\\sounds"), false); // offered once already: never again (even if removed)
assert.equal(shouldAddDefaultFolder(true, ["C:\\o2i\\sounds"], "C:\\o2i\\sounds"), false);
assert.equal(shouldAddDefaultFolder(false, ["C:\\o2i\\sounds"], "C:\\o2i\\sounds"), false); // listed: only the flag gets set
assert.equal(shouldAddDefaultFolder(false, ["c:/O2I/Sounds/"], "C:\\o2i\\sounds"), false); // pathKey match
assert.equal(shouldAddDefaultFolder(false, [], "C:\\o2i\\sounds"), true);
assert.equal(shouldAddDefaultFolder(false, ["D:\\mine"], "C:\\o2i\\sounds"), true);

// TTS: text capping counts code points like the engine (an emoji is one char, never split)
assert.equal(TTS_MAX_CHARS, 1000);
assert.equal(capText("a".repeat(1200)).length, 1000);
assert.equal(capText("hello"), "hello");
assert.equal([...capText("\u{1F600}".repeat(1001))].length, 1000);
assert.equal(capText("\u{1F600}".repeat(1001)).includes("�"), false);
assert.equal(charCount("\u{1F600}ab"), 3);
assert.equal(charCount(""), 0);

// TTS: voices group into Windows and Natural (piper), each keeping the engine's order
const tv = (id: string, source: "windows" | "piper", installed: boolean, size_mb?: number): TtsVoice => ({ id, name: id, source, installed, size_mb });
const mixed = [tv("win:a", "windows", true), tv("piper:x", "piper", false, 60), tv("win:b", "windows", true), tv("piper:y", "piper", true, 63)];
assert.deepEqual(groupVoices(mixed).windows.map(x => x.id), ["win:a", "win:b"]);
assert.deepEqual(groupVoices(mixed).natural.map(x => x.id), ["piper:x", "piper:y"]);
assert.deepEqual(groupVoices([]), { windows: [], natural: [] });

// TTS: a remembered voice that is installed wins; one that vanished (or isn't installed) falls back
assert.equal(pickVoice(mixed, "piper:y"), "piper:y");
assert.equal(pickVoice(mixed, "piper:x"), "win:a"); // not installed: fallback
assert.equal(pickVoice(mixed, "win:gone"), "win:a"); // no longer listed: first installed, Windows preferred
assert.equal(pickVoice(mixed, null), "win:a");
assert.equal(pickVoice([tv("piper:y", "piper", true), tv("win:a", "windows", true)], null), "win:a"); // Windows first even when listed later
assert.equal(pickVoice([tv("piper:x", "piper", false), tv("piper:y", "piper", true)], "win:gone"), "piper:y");
assert.equal(pickVoice([tv("piper:x", "piper", false)], "piper:x"), null); // nothing installed
assert.equal(pickVoice([], "win:a"), null);

// TTS: the install label adds the runtime (22 MB) until one natural voice is installed
assert.equal(runtimeInstalled(mixed), true);
assert.equal(runtimeInstalled([tv("piper:x", "piper", false, 60), tv("win:a", "windows", true)]), false);
assert.equal(installLabel(tv("piper:x", "piper", false, 60), true), "Install (60 MB)");
assert.equal(installLabel(tv("piper:x", "piper", false, 60), false), "Install (60 MB + 22 MB)");
assert.equal(installLabel(tv("piper:x", "piper", false), true), "Install");
assert.equal(installLabel(tv("piper:x", "piper", false), false), "Install (+ 22 MB)");
assert.equal(installLabel(tv("piper:x", "piper", false, 60.4), true), "Install (60 MB)");

// TTS: the first error that arrived after the recorded seq is shown (message text is never matched)
const errs = [{ seq: 4, message: "old" }, { seq: 5, message: "first" }, { seq: 6, message: "second" }];
assert.equal(firstErrorAfter(errs, 4), "first");
assert.equal(firstErrorAfter(errs, 6), null);
assert.equal(firstErrorAfter(errs, 0), "old");
assert.equal(firstErrorAfter(undefined, 0), null); // an older native has no error ring
assert.equal(firstErrorAfter([], 3), null);

// TTS: why Speak is blocked (null: it can go; "": nothing to say, no hint)
const ttsOk = { running: true, audioOn: true, voice: "win:a", text: "hi" };
assert.equal(speakBlocked(ttsOk), null);
assert.equal(speakBlocked({ ...ttsOk, running: false }), "Turn on o2i to speak");
assert.equal(speakBlocked({ ...ttsOk, audioOn: false }), "Turn on o2i to speak");
assert.equal(speakBlocked({ ...ttsOk, voice: null }), "No voice installed");
assert.equal(speakBlocked({ ...ttsOk, text: "  \n " }), "");

// TTS: speech is told apart from a legacy play (path null, but a file name) so it gets no seek bar
assert.equal(isSpeech({ name: "TTS: hello", path: null }), true);
assert.equal(isSpeech({ name: "TTS: hello", path: "C:/s/a.mp3" }), false);
assert.equal(isSpeech({ name: "a.mp3", path: null }), false);

console.log("o2i logic: all checks passed");
