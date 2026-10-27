/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { O2iProfile } from "./profile";
import { getSoundMeta, soundLabel, type SoundMetaMap } from "./soundMeta";
import { inSources, pathKey } from "./sources";

/** Which recorder: a soundboard key (registered as a global hotkey) or the mic mute key (watched by the engine's input hook). */
export type HotkeyRow = "soundboard" | "mute";

export function keyEventToAccel(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; }): string | null {
    let key: string | null = null;
    let m: RegExpMatchArray | null;
    if ((m = e.code.match(/^F([1-9]|1[0-2])$/))) key = "F" + m[1];
    else if ((m = e.code.match(/^Key([A-Z])$/))) key = m[1];
    else if ((m = e.code.match(/^Digit([0-9])$/))) key = m[1];
    if (!key) return null;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    return [...mods, key].join("+");
}

/**
 * KeyboardEvent.code to the engine's name for a mute key, for keys whose name isn't a letter, digit,
 * F-key or Num0-Num9. Escape and Backspace are left out: they cancel and clear the recorder.
 */
const MUTE_CODE_NAMES: Record<string, string> = {
    Space: "Space", Tab: "Tab", Enter: "Enter", CapsLock: "CapsLock",
    Insert: "Insert", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Backquote: "Backquote", Minus: "Minus", Equal: "Equal", BracketLeft: "BracketLeft", BracketRight: "BracketRight",
    Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", Comma: "Comma", Period: "Period", Slash: "Slash",
    ScrollLock: "ScrollLock", Pause: "Pause", NumLock: "NumLock", PrintScreen: "PrintScreen",
    NumpadAdd: "NumAdd", NumpadSubtract: "NumSubtract", NumpadMultiply: "NumMultiply", NumpadDivide: "NumDivide",
    NumpadDecimal: "NumDecimal", NumpadEnter: "NumEnter",
    MediaPlayPause: "MediaPlayPause", MediaTrackNext: "MediaTrackNext", MediaTrackPrevious: "MediaTrackPrevious", MediaStop: "MediaStop",
    AudioVolumeMute: "AudioVolumeMute", AudioVolumeUp: "AudioVolumeUp", AudioVolumeDown: "AudioVolumeDown",
};

/** Upper-cased main key names the mute row accepts (what its recorder can produce). */
const MUTE_KEYS = new Set<string>([
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `NUM${i}`),
    ...Object.values(MUTE_CODE_NAMES).map(n => n.toUpperCase()),
]);

/** Main keys (upper-cased) that also come up while typing. */
const TYPING_KEYS = new Set(["SPACE", "ENTER", "TAB", "BACKQUOTE", "MINUS", "EQUAL", "BRACKETLEFT", "BRACKETRIGHT", "BACKSLASH",
    "SEMICOLON", "QUOTE", "COMMA", "PERIOD", "SLASH", "NUMADD", "NUMSUBTRACT", "NUMMULTIPLY", "NUMDIVIDE", "NUMDECIMAL", "NUMENTER"]);

const MODIFIERS: Record<string, string> = { CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift", WIN: "Win" };
const MOUSE_RE = /^MOUSE[345]$/;

function modsOf(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; }): string[] {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    if (e.metaKey) mods.push("Win");
    return mods;
}

/** The mute row's recorder: any key the engine's input hook knows, with any modifiers (Win too); null for others. */
export function keyEventToMuteSpec(e: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; }): string | null {
    let key: string | null = null;
    let m: RegExpMatchArray | null;
    if ((m = e.code.match(/^Key([A-Z])$/))) key = m[1];
    else if ((m = e.code.match(/^Digit([0-9])$/))) key = m[1];
    else if ((m = e.code.match(/^F([1-9]|1[0-9]|2[0-4])$/))) key = "F" + m[1];
    else if ((m = e.code.match(/^Numpad([0-9])$/))) key = "Num" + m[1];
    else key = MUTE_CODE_NAMES[e.code] ?? null;
    return key ? [...modsOf(e), key].join("+") : null;
}

/** The mute row's recorder: the middle button is Mouse3, the side buttons Mouse4 and Mouse5; left and right click are null. */
export function mouseButtonToMuteSpec(e: { button: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; }): string | null {
    const key = e.button === 1 ? "Mouse3" : e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : null;
    return key ? [...modsOf(e), key].join("+") : null;
}

interface ParsedSpec {
    /** Canonical names (Ctrl, Alt, Shift, Win). */
    mods: string[];
    /** Upper-cased. */
    key: string;
}

/** `Mod+Mod+Key`, any case, spaces around `+` allowed; null when malformed (an empty part, an unknown or repeated modifier). */
function parseSpec(spec: string): ParsedSpec | null {
    const parts = spec.split("+").map(t => t.trim());
    if (parts.some(t => !t)) return null;
    const key = parts[parts.length - 1].toUpperCase();
    if (MODIFIERS[key]) return null;
    const mods: string[] = [];
    for (const t of parts.slice(0, -1)) {
        const mod = MODIFIERS[t.toUpperCase()];
        if (!mod || mods.includes(mod)) return null;
        mods.push(mod);
    }
    return { mods, key };
}

function muteSpecProblem(spec: string): string | null {
    if (!spec.trim()) return "Press a key or mouse button";
    const p = parseSpec(spec);
    if (!p) return `Not a hotkey: ${spec}`;
    if (MOUSE_RE.test(p.key) || MUTE_KEYS.has(p.key)) return null;
    if (/^MOUSE[12]$/.test(p.key)) return "Left and right click can't be hotkeys";
    return `${spec} can't be used as a hotkey`;
}

/**
 * Why `accel` can't be a hotkey on that row, or null.
 * - Soundboard (from keyEventToAccel): a letter or digit needs Ctrl or Alt, since on its own or with only
 *   Shift it would fire while typing. F-keys are allowed with any modifiers. No mouse buttons.
 * - Mute: any key the engine's input hook knows, bare or with Ctrl / Alt / Shift / Win, or Mouse3-5.
 */
export function hotkeyProblem(accel: string, row: HotkeyRow = "soundboard"): string | null {
    if (row === "mute") return muteSpecProblem(accel);
    const parts = accel.split("+");
    const key = parts[parts.length - 1];
    if (/^mouse\d*$/i.test(key.trim())) return "Mouse buttons only work for the mute hotkey";
    if (/^F\d+$/.test(key)) return null;
    const mods = parts.slice(0, -1);
    if (mods.includes("Ctrl") || mods.includes("Alt")) return null;
    return mods.includes("Shift")
        ? "Add Ctrl or Alt (Shift + a letter or digit would fire while typing)"
        : "Add Ctrl or Alt (a bare letter or digit would fire while typing)";
}

/** The mute key `spec` (bare, or with only Shift) is a key that comes up while typing, so it also mutes and unmutes then. */
export function muteKeyFiresWhileTyping(spec: string | null | undefined): boolean {
    const p = spec ? parseSpec(spec) : null;
    if (!p || p.mods.some(m => m !== "Shift")) return false;
    return /^[A-Z0-9]$/.test(p.key) || /^NUM[0-9]$/.test(p.key) || TYPING_KEYS.has(p.key);
}

/** The mute key is a side mouse button (Mouse4 / Mouse5), which Discord also uses for back / forward. */
export function muteKeyIsSideButton(spec: string | null | undefined): boolean {
    const p = spec ? parseSpec(spec) : null;
    return p?.key === "MOUSE4" || p?.key === "MOUSE5";
}

/**
 * The mute key `muteSpec` also fires on the soundboard key `accel`: same main key, and the mute key is
 * bare (the engine fires a bare mute key whatever modifiers are held) or has the same modifiers.
 */
function muteOverlaps(muteSpec: string, accel: string): boolean {
    const m = parseSpec(muteSpec);
    const a = parseSpec(accel);
    if (!m || !a || m.key !== a.key) return false;
    return m.mods.length === 0 || (m.mods.length === a.mods.length && m.mods.every(x => a.mods.includes(x)));
}

/**
 * Message if `accel` is already taken by another sound, the stop-all key or the mute key, or null.
 * Case-insensitive. `ownPath` is the sound being edited, or null when editing the stop-all key. Sounds are
 * named by their custom name or file name, never their folder. With `sources`, a sound outside them (its
 * folder was removed, which keeps its hotkey) is pointed out, since it no longer has a tile.
 */
export function hotkeyConflict(
    p: Pick<O2iProfile, "sb_stop_all_hotkey" | "sb_clip_hotkeys" | "mic_mute_hotkey"> | null | undefined,
    meta: SoundMetaMap | null | undefined,
    accel: string,
    ownPath: string | null,
    sources?: readonly string[]
): string | null {
    const a = accel.toLowerCase();
    if (ownPath !== null && p?.sb_stop_all_hotkey?.toLowerCase() === a) return "Already used by Stop all sounds";
    if (p?.mic_mute_hotkey && muteOverlaps(p.mic_mute_hotkey, accel)) return "Already used by the mute hotkey";
    const own = ownPath === null ? null : pathKey(ownPath); // its own key in any spelling isn't a conflict
    for (const [path, key] of p?.sb_clip_hotkeys ?? []) {
        if (key.toLowerCase() !== a || pathKey(path) === own) continue;
        return `Already bound to ${clipName(path, meta, sources)}`;
    }
    return null;
}

/** Message if the mute key `spec` would also fire on the stop-all key or a sound's key, or null. */
export function muteHotkeyConflict(
    p: Pick<O2iProfile, "sb_stop_all_hotkey" | "sb_clip_hotkeys"> | null | undefined,
    meta: SoundMetaMap | null | undefined,
    spec: string,
    sources?: readonly string[]
): string | null {
    if (p?.sb_stop_all_hotkey && muteOverlaps(spec, p.sb_stop_all_hotkey)) return "Already used by Stop all sounds";
    for (const [path, key] of p?.sb_clip_hotkeys ?? []) {
        if (muteOverlaps(spec, key)) return `Already bound to ${clipName(path, meta, sources)}`;
    }
    return null;
}

function clipName(path: string, meta: SoundMetaMap | null | undefined, sources?: readonly string[]): string {
    const where = sources && !inSources(path, sources) ? " (in a folder you removed)" : "";
    return `${soundLabel(path, getSoundMeta(meta, path))}${where}`;
}
