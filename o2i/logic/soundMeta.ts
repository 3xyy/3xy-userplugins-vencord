/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Soundboard display names and emojis (the soundMeta setting). Display only: never sent to the engine.
// Keyed by the sound's absolute path (its identity, as the engine's `clips[].path`); older settings used
// bare file names, which logic/sources.ts migrates. Functions taking `file` accept a path or a file name.

import { baseName, pathKey } from "./sources";

export interface SoundMeta {
    name?: string;
    emoji?: string;
}

/** Keyed by sound path (as in the engine's `clips[].path` and `state.playing[].path`), matched by pathKey. */
export type SoundMetaMap = Record<string, SoundMeta>;

/** The map's keys for the same sound as `file` (any case / slash style), in order. */
function keysFor(map: SoundMetaMap, file: string): string[] {
    const k = pathKey(file);
    return Object.keys(map).filter(key => pathKey(key) === k);
}

/**
 * The entry for `file`, matched by pathKey (first match, like the engine). Own keys only, so a file
 * named like an Object.prototype member never matches. A scan: for many lookups build a keyIndex.
 */
export function getSoundMeta(map: SoundMetaMap | null | undefined, file: string): SoundMeta | undefined {
    if (!map) return undefined;
    const key = keysFor(map, file)[0];
    return key === undefined ? undefined : map[key];
}

/** "airhorn.mp3" → "airhorn"; a name that only starts with a dot (".wav") is kept whole. */
export function stripExt(file: string): string {
    const i = file.lastIndexOf(".");
    return i > 0 ? file.slice(0, i) : file;
}

/** The custom name, or the file name (never its folder) without its extension. */
export function soundName(file: string, meta: SoundMeta | undefined): string {
    return meta?.name?.trim() || stripExt(baseName(file));
}

/** Emoji + name as plain text (tooltips, messages). */
export function soundLabel(file: string, meta: SoundMeta | undefined): string {
    const name = soundName(file, meta);
    return meta?.emoji ? `${meta.emoji} ${name}` : name;
}

/** Search: `query` already trimmed and lower-cased (empty matches everything); checks name, emoji and file name (not the folder). */
export function matchesSound(query: string, file: string, meta: SoundMeta | undefined): boolean {
    if (!query) return true;
    return baseName(file).toLowerCase().includes(query)
        || !!meta?.name?.toLowerCase().includes(query)
        || !!meta?.emoji?.includes(query);
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u; // ...or a keycap (digit + U+20E3)
let segmenter: Intl.Segmenter | null = null;

function graphemes(text: string): string[] {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), s => s.segment);
}

function lastEmojiOf(parts: string[]): string | null {
    for (let i = parts.length - 1; i >= 0; i--) {
        if (EMOJI.test(parts[i])) return parts[i];
    }
    return null;
}

/** The last emoji in `text` (the one just typed or picked with Win + .), or null when it has none. */
export function lastEmoji(text: string): string | null {
    return lastEmojiOf(graphemes(text));
}

/**
 * What the emoji box stores after its text became `input` while it showed `current`:
 * - a newly typed / pasted / picked emoji, wherever the caret was (before or after the old one);
 * - `current` when nothing new is an emoji (letters etc. are ignored);
 * - undefined (clear) when the box was emptied.
 * The old emoji is removed as a whole grapheme, so a skin-tone or ZWJ variant of it still counts as new.
 */
export function nextEmoji(input: string, current: string | undefined): string | undefined {
    if (!input.trim()) return undefined;
    const parts = graphemes(input);
    const i = current ? parts.indexOf(current) : -1;
    const fresh = lastEmojiOf(i >= 0 ? parts.filter((_, j) => j !== i) : parts);
    return fresh ?? current;
}

/** Trimmed fields, empty ones dropped; undefined when nothing is left. */
function cleanMeta(meta: SoundMeta): SoundMeta | undefined {
    const out: SoundMeta = {};
    const name = meta.name?.trim();
    if (name) out.name = name;
    if (meta.emoji) out.emoji = meta.emoji;
    return out.name || out.emoji ? out : undefined;
}

/**
 * `map` with `patch` applied to `file`'s entry (an empty entry is removed). The entry is found by
 * pathKey (first match) and stored under `file` (the sound's current `clips[].path`); other spellings
 * of the same sound are dropped, so there is always one. Returns `map` itself when nothing changes, so
 * callers can skip the settings write.
 */
export function withSoundMeta(map: SoundMetaMap, file: string, patch: SoundMeta): SoundMetaMap {
    const keys = keysFor(map, file);
    const cur = keys.length ? map[keys[0]] : undefined;
    const next = cleanMeta({ ...cur, ...patch });
    const sameKeys = keys.length === 0 || (keys.length === 1 && keys[0] === file);
    if (sameKeys && cur?.name === next?.name && cur?.emoji === next?.emoji && (cur == null) === (next == null)) return map;
    const out: SoundMetaMap = { ...map };
    for (const key of keys) delete out[key];
    if (next) out[file] = next;
    return out;
}
