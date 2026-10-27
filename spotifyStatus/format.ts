/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function msToClock(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface FormatValues {
    song: string;
    artist: string;
    album: string;
    position: number;
    duration: number;
}

export function format(tpl: string, v: FormatValues): string {
    const pos = v.position > 0 ? msToClock(v.position) : "";
    const dur = v.duration > 0 ? msToClock(v.duration) : "";
    return tpl
        .replaceAll("{song}", v.song)
        .replaceAll("{artist}", v.artist)
        .replaceAll("{album}", v.album)
        .replaceAll("{position}", pos)
        .replaceAll("{duration}", dur);
}

/** Discord's limit for custom-status text and for each activity text field (name/details/state/large_text). */
export const DISCORD_TEXT_LIMIT = 128;

let segmenter: Intl.Segmenter | null = null;

/**
 * Cut `s` to at most `max` UTF-16 code units, the stricter way to count it (math-alphanumeric "font"
 * glyphs take 2 units each). Cuts only between graphemes, so it never splits a surrogate pair or an
 * emoji sequence, and ends a cut string with "…".
 */
export function capLength(s: string, max = DISCORD_TEXT_LIMIT): string {
    if (s.length <= max) return s;
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const budget = max - 1; // room for the ellipsis
    let out = "";
    for (const { segment } of segmenter.segment(s)) {
        if (out.length + segment.length > budget) break;
        out += segment;
    }
    return out.trimEnd() + "…";
}

export function stripParens(s: string): string {
    // Remove (...) and [...] including any leading whitespace before them, then collapse spaces.
    return s
        .replace(/\s*\([^)]*\)/g, "")
        .replace(/\s*\[[^\]]*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}
