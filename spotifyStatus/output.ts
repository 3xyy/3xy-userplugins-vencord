/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The text the plugin sends to Discord, built from a track and the settings. Pure, so the real
// output (index.tsx) and the settings preview (preview.ts) use the same code and can't drift apart.

import type { Track as SpotifyTrack } from "@plugins/spotifyControls/SpotifyStore";

import { type FilterMode, isAllowed } from "./filters";
import { capLength, format, stripParens } from "./format";
import { applyFont, type FontStyle } from "./unicodeFonts";

/** A track from any source (Spotify, Windows SMTC or Last.fm). Times are in ms. */
export interface Track {
    id: string;
    name: string;
    artists: string[];
    artistIds: string[];
    album: string;
    uri: string;
    position: number;
    duration: number;
    isPlaying: boolean;
    imageUrl: string;
}

/** Splits an icon or emoji pool on commas and whitespace, dropping empties. */
export function parsePool(raw: string): string[] {
    if (!raw) return [];
    return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/** Fills a template with the track's values and the {icon} pick. No font, no length cap. */
function fill(tpl: string, track: Track, icon: string, strip: boolean): string {
    const song = strip ? stripParens(track.name) : track.name;
    const artist = track.artists.join(", ");
    return format(tpl, { song, artist, album: track.album, position: track.position, duration: track.duration })
        .replaceAll("{icon}", icon);
}

export interface StatusTextSettings {
    template: string;
    pausedTemplate: string;
    stripParens: boolean;
    fontStyle: string;
}

/** The custom status text: font applied, then capped. Null when the template for this state is empty. */
export function buildStatusText(s: StatusTextSettings, track: Track, paused: boolean, icon: string): string | null {
    const tpl = paused ? s.pausedTemplate : s.template;
    if (!tpl) return null;
    // Cap after the font: font glyphs are 2 UTF-16 units each, and Discord rejects text over 128.
    return capLength(applyFont(fill(tpl, track, icon, s.stripParens), s.fontStyle as FontStyle));
}

/** One rich presence line (name, details, state or image text). No font (rich presence stays plain), capped; undefined when blank. */
export function buildActivityLine(tpl: string, track: Track, icon: string, strip: boolean): string | undefined {
    if (!tpl) return undefined;
    return capLength(fill(tpl, track, icon, strip)) || undefined;
}

export interface ActivityTextSettings {
    activityName: string;
    activityDetails: string;
    activityState: string;
    stripParens: boolean;
}

export function buildActivityText(s: ActivityTextSettings, track: Track, icon: string) {
    return {
        name: buildActivityLine(s.activityName, track, icon, s.stripParens) || "Music",
        details: buildActivityLine(s.activityDetails, track, icon, s.stripParens),
        state: buildActivityLine(s.activityState, track, icon, s.stripParens),
    };
}

/** Hover text of the activity's big image: the image text template, else the album name. */
export function buildLargeImageText(s: { largeImageText: string; stripParens: boolean; }, track: Track, icon: string): string | undefined {
    return buildActivityLine(s.largeImageText, track, icon, s.stripParens) || capLength(track.album) || undefined;
}

/** The activity's timestamps for a timestamp mode, or undefined for none. */
export function activityTimestamps(mode: string, track: Track, now: number, sessionStart: number): { start: number; end?: number; } | undefined {
    switch (mode) {
        case "track":
            if (track.duration > 0) return { start: now - track.position, end: now - track.position + track.duration };
            return undefined;
        case "trackElapsed":
            if (track.position >= 0) return { start: now - track.position };
            return undefined;
        case "session":
            return { start: sessionStart };
        case "today": {
            const n = new Date(now);
            return { start: now - ((n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) * 1000) };
        }
        default: return undefined;
    }
}

export interface TrackFilterSettings {
    artistFilterMode: string;
    artistList: string[];
    songFilterMode: string;
    songList: string[];
}

/** Whether the artist and song filters let this track through. */
export function trackAllowed(track: Track, s: TrackFilterSettings): boolean {
    const asSpotify: SpotifyTrack = {
        id: track.id, name: track.name, duration: track.duration, isLocal: false,
        album: { id: "", name: track.album, image: { height: 0, width: 0, url: "" } },
        artists: track.artists.map(a => ({ id: "", href: "", name: a, type: "", uri: "" })),
    };
    return isAllowed(asSpotify, {
        artistFilterMode: s.artistFilterMode as FilterMode,
        artistList: s.artistList,
        songFilterMode: s.songFilterMode as FilterMode,
        songList: s.songList,
    });
}

export interface OutputSettings extends StatusTextSettings, TrackFilterSettings {
    clearOnPause: boolean;
}

export type OutputDecision =
    | { show: true; text: string; }
    /** filtered: the filters hide the track. paused: cleared while paused. noTemplate: the playing template is empty. */
    | { show: false; reason: "filtered" | "paused" | "noTemplate"; };

/** Whether anything is shown for this track, and the custom status text if so. Status and activity both follow it. */
export function decideOutput(s: OutputSettings, track: Track, paused: boolean, icon: string): OutputDecision {
    if (!trackAllowed(track, s)) return { show: false, reason: "filtered" };
    if (paused && (s.clearOnPause || !s.pausedTemplate)) return { show: false, reason: "paused" };
    const text = buildStatusText(s, track, paused, icon);
    if (text === null) return { show: false, reason: "noTemplate" };
    return { show: true, text };
}

/**
 * What to do with the custom status for this text and emoji, given the text of the status the plugin
 * last set (null when none of ours is showing).
 * - "set": send this status.
 * - "clear": the status came out empty (no text, or only spaces, which Discord trims away, and no
 *   emoji). Never sent as a status: it goes through the "only clear what we set" path, so a template
 *   that fills to nothing can't wipe your own status.
 * - "keep": this text is already showing.
 */
export function statusAction(text: string, emoji: string, lastSetText: string | null): "set" | "clear" | "keep" {
    if (!text.trim() && !emoji) return "clear";
    return text !== lastSetText ? "set" : "keep";
}

/** A custom status as the plugin writes it. */
export interface StatusText { text: string; emoji: string; }

/** Whether the live custom status (Discord's settings object, or null) is the one described by `expected`. */
export function isSameStatus(live: any, expected: StatusText): boolean {
    // ignore emoji variation selectors (U+FE0F) and surrounding whitespace
    const norm = (s: unknown) => String(s ?? "").replaceAll(String.fromCharCode(0xFE0F), "").trim();
    if (norm(live?.text) !== norm(expected.text)) return false;
    // The text is the real signal; the emoji only decides it for an emoji-only (or empty) status.
    return norm(expected.text) !== "" || norm(live?.emoji_name) === norm(expected.emoji);
}

export type LiveStatus = { ok: true; status: any; } | { ok: false; };

/**
 * Clearing the status the plugin set, given a fresh read of the live one:
 * - "retry": the read failed. Don't clear, keep the record, try again next time.
 * - "release": the live status isn't ours any more (you changed or cleared it by hand). Leave it and
 *   just stop treating it as ours.
 * - "clear": it's still ours, so clear it.
 */
export function clearStep(live: LiveStatus, ours: StatusText): "retry" | "release" | "clear" {
    if (!live.ok) return "retry";
    return isSameStatus(live.status, ours) ? "clear" : "release";
}

/** The track as it is `now`, read at `at`: a playing track moves on, stopping at its end when the length is known. */
export function advanceTrack(track: Track, at: number, now: number): Track {
    if (!track.isPlaying) return track;
    const position = track.position + Math.max(0, now - at);
    return { ...track, position: track.duration > 0 ? Math.min(position, track.duration) : position };
}

/**
 * Defaults that changed after release, by setting key: [old shipped default, new default]. The old
 * template used an em dash (U+2014), built from its code so this file contains none.
 */
const CHANGED_DEFAULTS: Record<string, readonly [string, string]> = {
    template: [`{icon} {song} ${String.fromCharCode(0x2014)} {artist}`, "{icon} {song} - {artist}"],
};

/**
 * The settings to rewrite at start: each one whose stored value is exactly its old shipped default
 * moves to the new default. A customised value (anything else) is never touched, and once moved the
 * old value is gone, so this happens only once.
 */
export function defaultUpdates(stored: Record<string, unknown>): Record<string, string> {
    const updates: Record<string, string> = {};
    for (const [key, [oldDefault, newDefault]] of Object.entries(CHANGED_DEFAULTS)) {
        if (stored[key] === oldDefault) updates[key] = newDefault;
    }
    return updates;
}
