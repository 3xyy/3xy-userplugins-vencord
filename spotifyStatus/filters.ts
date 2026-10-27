/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Track } from "@plugins/spotifyControls/SpotifyStore";

export type FilterMode = "off" | "whitelist" | "blacklist";

function matchArtist(entry: string, artists: string[]): boolean {
    const needle = entry.trim().toLowerCase();
    if (!needle) return false;
    return artists.some(a => a === needle);
}

function matchSong(entry: string, name: string, uri: string): boolean {
    const e = entry.trim();
    if (!e) return false;
    if (e.toLowerCase().startsWith("spotify:")) {
        return uri.toLowerCase() === e.toLowerCase();
    }
    return name === e.toLowerCase();
}

function check(mode: FilterMode, list: string[], matches: (entry: string) => boolean): boolean {
    if (mode === "off") return true;
    const any = list.some(matches);
    return mode === "whitelist" ? any : !any;
}

export interface FilterSettings {
    artistFilterMode: FilterMode;
    artistList: string[];
    songFilterMode: FilterMode;
    songList: string[];
}

export function isAllowed(track: Track, s: FilterSettings): boolean {
    const artists = track.artists.map(a => a.name.toLowerCase());
    const songName = track.name.toLowerCase();
    const uri = `spotify:track:${track.id}`;

    const artistOK = check(s.artistFilterMode, s.artistList, e => matchArtist(e, artists));
    const songOK = check(s.songFilterMode, s.songList, e => matchSong(e, songName, uri));
    return artistOK && songOK;
}
