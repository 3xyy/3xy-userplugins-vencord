/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The power button: what turning o2i off or on (or a plugin start) does to the engine and to Discord's
// voice settings. Off is intentional, so it never says "o2i stopped"; whenever the engine isn't running
// Discord must not be left listening to CABLE Output (silent); and turning on never moves Discord to
// CABLE before o2i's audio is healthy (the fallback controller's recovery does that switch).

/** "off" / "on": the power button; "start": the plugin started (o2i on or off). */
export type PowerEvent = "off" | "on" | "start";

export interface PowerState {
    /** The `powered` setting before the event. */
    powered: boolean;
    /**
     * The `powerRestoreCable` setting before the event. While off: Discord was on o2i when o2i was turned
     * off. While on: that switch back to CABLE Output still waits for o2i's audio to be healthy.
     */
    restoreCable: boolean;
    /** The `powerRestoreFrom` setting: Discord's input when that switch was decided (null: not remembered). */
    restoreFrom: string | null;
}

/** Discord's side, read only when the decision needs it (functions, like `fallbackDecision`'s `discordMayBeOnO2i`). */
export interface PowerFacts {
    /** Discord's input may be o2i: CABLE Output, or its Default entry (`mayBeOnO2i`). */
    onO2i: () => boolean;
    /** A named real mic Discord can be switched to exists (`pickFallbackMic` finds one). */
    micKnown: () => boolean;
    /**
     * An ordinary fallback episode (not a waiting power-on switch) has moved Discord from CABLE Output to the
     * real mic: its recovery would move it back.
     */
    fallenBack: boolean;
    /** Discord's current input device id (null when it can't be read). */
    inputId: () => string | null;
}

export interface PowerPlan {
    powered: boolean;
    restoreCable: boolean;
    engine: "start" | "stop" | "none";
    /**
     * "real-mic": `fallbackToRealMic` now (snapshot's processing re-applied). "cable-when-healthy": Discord
     * stays on the real mic; the fallback controller's recovery moves it to CABLE Output once o2i's audio has
     * been healthy for a moment (never sooner, so never silent; never at all if the engine doesn't get healthy).
     */
    voice: "real-mic" | "cable-when-healthy" | "none";
    /** "off-real-mic": "o2i is off. You're on your real mic"; "pick-mic": no real mic known, ask him to pick one. */
    toast: "off-real-mic" | "pick-mic" | "none";
}

/**
 * A waiting switch back to CABLE (`powerRestoreCable`) belongs to the input Discord was left on (`from`):
 * "done" once Discord is on o2i anyway, "dropped" when another device was picked (a deliberate choice wins,
 * also days later), else "wait". An unknown `from` (an older flag) or unreadable input never drops it.
 */
export function restoreCheck(from: string | null, input: string | null, onO2i: boolean): "wait" | "done" | "dropped" {
    if (onO2i) return "done";
    if (from == null || input == null || input === from) return "wait";
    return "dropped";
}

/**
 * A waiting switch back to CABLE is dropped now (another mic was picked by hand). Discord's input is only
 * read when a switch waits.
 */
export function restoreDropped(s: PowerState, f: PowerFacts): boolean {
    return s.restoreCable && restoreCheck(s.restoreFrom, f.inputId(), f.onO2i()) === "dropped";
}

/** The switch back to CABLE is still due: set, and Discord is still on the input it was left on. */
function stillDue(s: PowerState, f: PowerFacts): boolean {
    return s.restoreCable && restoreCheck(s.restoreFrom, f.inputId(), f.onO2i()) === "wait";
}

/** Off (or starting off) while Discord may be on o2i: move it to the real mic, or ask for one when none is known. */
function offVoice(f: PowerFacts): Pick<PowerPlan, "voice" | "toast"> & { onO2i: boolean; } {
    if (!f.onO2i()) return { onO2i: false, voice: "none", toast: "none" };
    return f.micKnown() ? { onO2i: true, voice: "real-mic", toast: "off-real-mic" } : { onO2i: true, voice: "none", toast: "pick-mic" };
}

/**
 * On (or starting on) with a CABLE restore due: wait for healthy audio, unless Discord is already back on
 * o2i (switched by hand: nothing to wait for, the normal fallback covers it) or was moved to another device
 * (his choice: the restore is dropped).
 */
function onPlan(s: PowerState, f: PowerFacts, engine: PowerPlan["engine"]): PowerPlan {
    const wait = stillDue(s, f);
    return { powered: true, restoreCable: wait, engine, voice: wait ? "cable-when-healthy" : "none", toast: "none" };
}

export function powerTransition(event: PowerEvent, s: PowerState, f: PowerFacts): PowerPlan {
    const nothing: PowerPlan = { powered: s.powered, restoreCable: s.restoreCable, engine: "none", voice: "none", toast: "none" };
    switch (event) {
        case "off": {
            if (!s.powered) return nothing; // already off
            const v = offVoice(f);
            // CABLE comes back on power on if Discord was on it, would have gone back to it after a fallback,
            // or was still waiting to go back to it after the last power on (and stayed on that input).
            return { powered: false, restoreCable: v.onO2i || f.fallenBack || stillDue(s, f), engine: "stop", voice: v.voice, toast: v.toast };
        }
        case "on":
            if (s.powered) return nothing; // already on
            return onPlan(s, f, "start");
        case "start": {
            if (s.powered) return onPlan(s, f, "start");
            // No engine runs: a CABLE input left from before (switched back by hand, or a failed switch) would be silent.
            const v = offVoice(f);
            return { powered: false, restoreCable: v.onO2i || stillDue(s, f), engine: "none", voice: v.voice, toast: v.toast };
        }
    }
}
