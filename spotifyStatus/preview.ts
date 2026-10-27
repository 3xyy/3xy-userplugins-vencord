/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// What the settings preview shows. Pure: the text comes from output.ts, the same code the real
// custom status and activity use.

import { msToClock } from "./format";
import {
    type ActivityTextSettings, activityTimestamps, buildActivityText, decideOutput, type OutputSettings, parsePool, type Track
} from "./output";

export type { Track } from "./output";

/** Shown when nothing is playing (or the plugin is off). Made up; the "(Remastered)" shows off "strip parens". */
export const SAMPLE_TRACK: Track = {
    id: "0sampletrack0000000000",
    name: "Neon Skyline (Remastered)",
    artists: ["The Midnight Owls", "Juno Park"],
    artistIds: [],
    album: "After Hours Drive",
    uri: "spotify:track:0sampletrack0000000000",
    position: 83_000,
    duration: 201_000,
    isPlaying: true,
    imageUrl: "",
};

export interface PreviewSettings extends OutputSettings, ActivityTextSettings {
    updateCustomStatus: boolean;
    updateActivity: boolean;
    iconPool: string;
    emoji: string;
    emojiRandomize: boolean;
    emojiPool: string;
    activityType: string;
    timestampMode: string;
}

/** Live values from the running plugin. All optional, so the preview also works while it's off. */
export interface PreviewLive {
    /** The plugin's current {icon} pick; used while it's still in the pool. */
    icon?: string;
    /** The plugin's current random emoji pick; used while it's still in the pool. */
    emoji?: string;
    now?: number;
    /** When the plugin started (the "elapsed since plugin start" timestamp). */
    sessionStart?: number;
}

export interface PreviewActivity {
    typeLabel: string;
    name: string;
    details: string;
    state: string;
    timestamp: string | null;
}

/**
 * Why nothing is shown, if so. The first three are the real output's own decision; "outputsOff" means
 * custom status and rich presence are both off, "empty" that the status came out with no text and no emoji.
 */
export type HiddenReason = "filtered" | "paused" | "noTemplate" | "outputsOff" | "empty";

export interface Preview {
    customStatus: { emoji: string | null; text: string; } | null;
    activity: PreviewActivity | null;
    usingSample: boolean;
    filteredOut: boolean;
    hiddenReason: HiddenReason | null;
}

const TYPE_LABELS: Record<string, string> = {
    listening: "Listening to",
    playing: "Playing",
    watching: "Watching",
    competing: "Competing in",
    streaming: "Streaming",
    hang: "Hang status",
};

export function activityTypeLabel(type: string): string {
    return TYPE_LABELS[type] ?? TYPE_LABELS.listening;
}

/** "05:12" or "1:02:05", the way Discord writes elapsed time. */
export function elapsedClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Track progress as elapsed / total ms, or null when the activity has no end time. */
export function progressOf(ts: { start: number; end?: number; } | undefined, now: number): { elapsed: number; total: number; } | null {
    if (!ts || ts.end === undefined) return null;
    const total = Math.max(0, ts.end - ts.start);
    return { elapsed: Math.min(total, Math.max(0, now - ts.start)), total };
}

function timestampLabel(ts: { start: number; end?: number; } | undefined, now: number): string | null {
    if (!ts) return null;
    const p = progressOf(ts, now);
    if (p) return `${msToClock(p.elapsed)} / ${msToClock(p.total)}`;
    return `${elapsedClock(now - ts.start)} elapsed`;
}

/** The live pick while it's still in the pool, else the pool's first entry ("" for an empty pool). */
function pick(pool: string[], live: string | undefined): string {
    if (live && pool.includes(live)) return live;
    return pool[0] ?? "";
}

/** The {icon} the preview fills in. */
export function previewIcon(s: Pick<PreviewSettings, "iconPool">, live: PreviewLive = {}): string {
    return pick(parsePool(s.iconPool), live.icon);
}

export function buildPreview(settings: PreviewSettings, track: Track | null, paused: boolean, live: PreviewLive = {}): Preview {
    const usingSample = track === null;
    const t = track ?? SAMPLE_TRACK;
    const now = live.now ?? Date.now();
    const icon = previewIcon(settings, live);

    const decision = decideOutput(settings, t, paused, icon);
    if (!decision.show) {
        return { customStatus: null, activity: null, usingSample, filteredOut: decision.reason === "filtered", hiddenReason: decision.reason };
    }

    const emoji = settings.emojiRandomize ? pick(parsePool(settings.emojiPool), live.emoji) || settings.emoji : settings.emoji;
    // Same rule as the real status: no text and no emoji means no custom status at all.
    const customStatus = settings.updateCustomStatus && (decision.text.trim() || emoji)
        ? { emoji: emoji || null, text: decision.text }
        : null;

    let activity: PreviewActivity | null = null;
    if (settings.updateActivity) {
        const a = buildActivityText(settings, t, icon);
        activity = {
            typeLabel: activityTypeLabel(settings.activityType),
            name: a.name,
            details: a.details ?? "",
            state: a.state ?? "",
            timestamp: timestampLabel(activityTimestamps(settings.timestampMode, t, now, live.sessionStart ?? now), now),
        };
    }

    const hiddenReason = customStatus || activity
        ? null
        : !settings.updateCustomStatus && !settings.updateActivity ? "outputsOff" : "empty";
    return { customStatus, activity, usingSample, filteredOut: false, hiddenReason };
}

export type PreviewImage =
    | { kind: "none"; }
    | { kind: "image"; src: string; label: string; }
    /** Discord shows a picture here that the preview can't load: a labelled tile instead. */
    | { kind: "label"; label: string; };

export interface ImageLookups {
    /** Discord's asset id for an image URL, once the plugin resolved it ("mp:external/..."), else null. */
    assetId(url: string): string | null;
    /** An artist's cached picture URL: undefined when not looked up yet, "" when the artist has none. */
    artistImage(artistId: string): string | undefined;
    /** Whether SpotifyControls is on (the artist picture lookup needs it). */
    spotifyControls: boolean;
}

const NO_IMAGE: PreviewImage = { kind: "none" };

/**
 * The activity's big picture in the preview. Picks the same image the real activity would get, but
 * Vencord's CSP blocks images from most hosts, so it loads one only through Discord's media proxy, once
 * the plugin has resolved the URL (the same picture Discord shows). Until then a labelled tile. No tile
 * when Discord would show no picture.
 */
export function previewImage(
    s: { source: string; largeImageSource: string; largeImageCustomUrl: string; },
    track: Track,
    usingSample: boolean,
    look: ImageLookups
): PreviewImage {
    let url: string | null;
    let label: string;
    switch (s.largeImageSource) {
        case "art":
            label = "Cover art";
            // a real song from Spotify or Last.fm usually has a cover; Windows media controls give none
            if (usingSample) return s.source === "smtc" ? NO_IMAGE : { kind: "label", label };
            url = track.imageUrl || null;
            break;
        case "artist": {
            label = "Artist picture";
            const spotifyArtists = usingSample ? s.source === "spotify" : track.artistIds.length > 0;
            if (!spotifyArtists || !look.spotifyControls) return NO_IMAGE;
            if (usingSample) return { kind: "label", label };
            const cached = look.artistImage(track.artistIds[0]);
            if (cached === undefined) return { kind: "label", label };
            url = cached || null;
            break;
        }
        case "custom":
            label = "Custom image";
            url = /^https?:\/\/\S+$/i.test(s.largeImageCustomUrl.trim()) ? s.largeImageCustomUrl : null;
            break;
        default:
            return NO_IMAGE;
    }
    if (!url) return NO_IMAGE;
    const id = look.assetId(url);
    if (id?.startsWith("mp:")) return { kind: "image", src: `https://media.discordapp.net/${id.slice(3)}`, label };
    return { kind: "label", label };
}
