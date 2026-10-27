/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Soundboard sources (several folders) and sound identity. A sound is its absolute path, in the form the
// engine reports as `clips[].path` (<source as configured>\<file>). Older settings keyed sounds by bare
// file name, which the engine resolves in the first source; migrateToPaths moves those keys to paths.

import type { ClipJson } from "../types";
import type { ClipSettings, O2iProfile } from "./profile";
import type { SoundMeta, SoundMetaMap } from "./soundMeta";

/**
 * Comparison form of a folder or sound path (as the engine's path_key, plus trimming): `/` → `\`, no
 * `\\?\` prefix, no trailing `\`, lower case (Windows paths ignore case).
 */
export function pathKey(s: string | null | undefined): string {
    let k = (s ?? "").trim().replace(/\//g, "\\");
    if (/^\\\\\?\\UNC\\/i.test(k)) k = "\\\\" + k.slice(8);
    else if (k.startsWith("\\\\?\\")) k = k.slice(4);
    return k.replace(/\\+$/, "").toLowerCase();
}

/**
 * The source folders the engine uses, as configured: `sb_folders` (blank entries ignored) when it has
 * any, else the legacy `sb_folder`; the same folder listed twice counts once. Legacy keys resolve in
 * the first one.
 */
export function sourcesOf(p: Pick<O2iProfile, "sb_folders" | "sb_folder"> | null | undefined): string[] {
    const listed = (Array.isArray(p?.sb_folders) ? p.sb_folders : []).filter(f => typeof f === "string" && f.trim() !== "");
    const chosen = listed.length ? listed : p?.sb_folder?.trim() ? [p.sb_folder] : [];
    const seen = new Set<string>();
    return chosen.filter(f => {
        const k = pathKey(f);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** `folder` joined with a bare `file` name exactly as Rust's PathBuf::join does on Windows (the engine's clips[].path). */
export function pathJoinWin(folder: string, file: string): string {
    if (folder === "" || /[\\/]$/.test(folder) || /^[A-Za-z]:$/.test(folder)) return folder + file;
    return `${folder}\\${file}`;
}

/** A legacy sound key: a bare file name (no folder, no drive prefix). */
export function isBareName(key: string): boolean {
    return key !== "" && key !== "." && key !== ".." && !/[\\/]/.test(key) && !/^[A-Za-z]:/.test(key);
}

/** An absolute Windows path: a drive with a root ("C:\…", "C:/…") or UNC / verbatim ("\\server\…", "\\?\…"). */
export function isAbsolutePath(s: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s);
}

/**
 * Entries keyed by pathKey, as the engine matches sound keys (case / slash style ignored); the first
 * entry for a sound wins, as in the engine. Look values up with `index.get(pathKey(path))`.
 */
export function keyIndex<T>(entries: Iterable<readonly [string, T]>): Map<string, T> {
    const out = new Map<string, T>();
    for (const [key, value] of entries) {
        const k = pathKey(key);
        if (!out.has(k)) out.set(k, value);
    }
    return out;
}

/** The last segment of a path ("C:\s\a.mp3" → "a.mp3"); a bare name is returned as is. */
export function baseName(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

/** Whether the sound key `path` is inside one of `sources` (a legacy bare name: in the first one, if any). */
export function inSources(path: string, sources: readonly string[]): boolean {
    if (isBareName(path)) return sources.length > 0;
    const k = pathKey(path);
    return sources.some(f => {
        const s = pathKey(f);
        return s !== "" && k.startsWith(s + "\\");
    });
}

/** `list` plus `folder`, or null when it's blank or already listed (compared by pathKey). */
export function addSource(list: readonly string[], folder: string): string[] | null {
    const k = pathKey(folder);
    if (!k || list.some(f => pathKey(f) === k)) return null;
    return [...list, folder];
}

/** `list` without `folder` (compared by pathKey). */
export function removeSource(list: readonly string[], folder: string): string[] {
    const k = pathKey(folder);
    return list.filter(f => pathKey(f) !== k);
}

/**
 * `p` with these sources, written explicitly: `sb_folders` and `sb_folder` = the first one (null when
 * there is none, so removing the last folder can't bring the legacy field back as a source).
 */
export function withSources(p: O2iProfile, list: readonly string[]): O2iProfile {
    return { ...p, sb_folders: [...list], sb_folder: list[0] ?? null };
}

function segments(folder: string): string[] {
    return folder.split(/[\\/]+/).filter(s => s && s !== "?");
}

/**
 * Chip labels: each folder's name ("C:\Sounds\memes" → "memes"); folders with the same name get parent
 * segments until they differ ("a\sounds", "b\sounds"), else the whole path.
 */
export function sourceLabels(list: readonly string[]): string[] {
    const segs = list.map(segments);
    const tail = (i: number, n: number) => segs[i].slice(-n).join("\\");
    return list.map((folder, i) => {
        for (let n = 1; n <= segs[i].length; n++) {
            const mine = tail(i, n).toLowerCase();
            if (segs.every((_, j) => j === i || tail(j, n).toLowerCase() !== mine)) return tail(i, n);
        }
        return folder;
    });
}

/** [parent with its trailing separator, the folder's own name] for a folder row ("C:\a\fx" → ["C:\a\", "fx"]); a root stays whole. */
export function splitFolder(folder: string): [string, string] {
    const trimmed = folder.replace(/[\\/]+$/, "");
    const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    const name = trimmed.slice(i + 1);
    return i < 0 || !name ? ["", folder] : [trimmed.slice(0, i + 1), name];
}

/** Rewrites legacy keys of `items` to `<first>\<key>`; an item already keyed by that path wins (as in the engine). */
function migrateKeys<T>(items: readonly T[], keyOf: (t: T) => string, rekey: (t: T, key: string) => T, first: string, count: { moved: number; dropped: number; }): T[] {
    const taken = new Set(items.filter(t => !isBareName(keyOf(t))).map(t => pathKey(keyOf(t))));
    const out: T[] = [];
    for (const t of items) {
        const key = keyOf(t);
        if (!isBareName(key)) {
            out.push(t);
            continue;
        }
        const path = pathJoinWin(first, key);
        const k = pathKey(path);
        if (taken.has(k)) {
            count.dropped++;
            continue;
        }
        taken.add(k);
        out.push(rekey(t, path));
        count.moved++;
    }
    return out;
}

export interface PathsMigration {
    profile: O2iProfile;
    soundMeta: SoundMetaMap;
    /** Keys rewritten from a file name to a path. */
    moved: number;
    /** Legacy entries dropped because the same sound already had an entry by path. */
    dropped: number;
}

/**
 * Moves legacy file-name keys (`sb_clip_settings[].name`, `sb_clip_hotkeys[][0]`, soundMeta keys) to
 * `<firstFolder>\<file>`, whether or not the file is still there (the engine resolves legacy names the
 * same way). Keys already by path are kept, and win over a legacy entry for the same sound. An empty
 * `sb_folders` becomes `[firstFolder]`; `sb_folder` is left as is. Idempotent; never mutates its inputs.
 */
export function migrateToPaths(p: O2iProfile, soundMeta: SoundMetaMap, firstFolder: string): PathsMigration {
    const count = { moved: 0, dropped: 0 };
    const profile: O2iProfile = { ...p };
    const listed = (p.sb_folders ?? []).some(f => typeof f === "string" && f.trim() !== "");
    profile.sb_folders = listed ? p.sb_folders : [firstFolder];
    if (p.sb_clip_settings) {
        profile.sb_clip_settings = migrateKeys<ClipSettings>(p.sb_clip_settings, c => c.name, (c, name) => ({ ...c, name }), firstFolder, count);
    }
    if (p.sb_clip_hotkeys) {
        profile.sb_clip_hotkeys = migrateKeys<[string, string]>(p.sb_clip_hotkeys, h => h[0], (h, path) => [path, h[1]], firstFolder, count);
    }
    const entries = migrateKeys<[string, SoundMeta]>(Object.entries(soundMeta ?? {}), e => e[0], (e, path) => [path, e[1]], firstFolder, count);
    return { profile, soundMeta: Object.fromEntries(entries), ...count };
}

export interface MigrationState {
    profile: O2iProfile;
    soundMeta: SoundMetaMap;
    migratedPaths: boolean;
    /** JSON of the profile + soundMeta from before the first migration; set once, never overwritten. */
    pathsMigrationBackup: string | null;
}

/**
 * What the one-time path migration writes, or null when there is nothing to do: already done, or no
 * absolute first folder yet (it runs once there is one; a relative or drive-relative legacy folder would
 * give keys the engine takes for bare names and refuses). The first run also stores the backup.
 */
export function planPathsMigration(s: MigrationState, now: Date): (MigrationState & PathsMigration & { pathsMigrationBackup: string; }) | null {
    if (s.migratedPaths) return null;
    const first = sourcesOf(s.profile)[0];
    if (first === undefined || !isAbsolutePath(first)) return null;
    const pathsMigrationBackup = s.pathsMigrationBackup ?? JSON.stringify({ savedAt: now.toISOString(), profile: s.profile, soundMeta: s.soundMeta });
    return { ...migrateToPaths(s.profile, s.soundMeta, first), migratedPaths: true, pathsMigrationBackup };
}

/** A sound's levels before it has an `sb_clip_settings` entry (the engine's defaults). */
export const DEFAULT_CLIP: Readonly<Omit<ClipSettings, "name">> = { vol_others: 1, vol_self: 1, hear_local: false };

/**
 * `list` with `patch` applied to the sound at `path` (`clips[].path`). Its entry is found by pathKey,
 * like the engine (first match), and re-keyed to `path`; other entries for the same sound (other
 * spellings) are dropped, so there is always one. Created with the defaults on first edit.
 */
export function withClipSettings(list: readonly ClipSettings[] | undefined, path: string, patch: Partial<Omit<ClipSettings, "name">>): ClipSettings[] {
    const cur = list ?? [];
    const k = pathKey(path);
    const i = cur.findIndex(c => pathKey(c.name) === k);
    const entry: ClipSettings = { ...DEFAULT_CLIP, ...cur[i], name: path, ...patch };
    if (i < 0) return [...cur, entry];
    return cur.flatMap((c, j) => j === i ? [entry] : pathKey(c.name) === k ? [] : [c]);
}

/** `pairs` with the sound at `path` bound to `accel` (null: unbound); every spelling of its key is replaced. */
export function withClipHotkey(pairs: readonly [string, string][] | undefined, path: string, accel: string | null): [string, string][] {
    const k = pathKey(path);
    const rest = (pairs ?? []).filter(([p]) => pathKey(p) !== k);
    return accel ? [...rest, [path, accel]] : rest;
}

/**
 * Tile tags for a file name found in more than one folder: path → its folder's chip label. Empty with
 * a single source; sounds with a unique name get no tag.
 */
export function duplicateSourceTags(clips: readonly Pick<ClipJson, "file" | "path" | "source">[], sources: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (sources.length < 2) return out;
    const labels = sourceLabels(sources);
    const labelOf = new Map(sources.map((f, i) => [pathKey(f), labels[i]]));
    const count = new Map<string, number>();
    for (const c of clips) {
        const k = c.file.toLowerCase();
        count.set(k, (count.get(k) ?? 0) + 1);
    }
    for (const c of clips) {
        if ((count.get(c.file.toLowerCase()) ?? 0) > 1) out.set(c.path, labelOf.get(pathKey(c.source)) ?? c.source);
    }
    return out;
}

/**
 * A `clips` reply from before the sources changed: another first folder, or sounds of a folder that is
 * no longer a source. (A newly added folder can't be told from an empty one; the tab relists on changes.)
 */
export function clipsStale(ev: { folder: string | null; clips: readonly Pick<ClipJson, "source">[]; }, sources: readonly string[]): boolean {
    if (pathKey(ev.folder) !== pathKey(sources[0])) return true;
    const keys = new Set(sources.map(pathKey));
    return ev.clips.some(c => !keys.has(pathKey(c.source)));
}

/**
 * The listed sound `path` names, matched by pathKey (a playing sound's path may differ from its
 * `clips[].path` in case or slashes); undefined when it isn't listed (its folder was removed) or the
 * list is still loading.
 */
export function findClip<T extends Pick<ClipJson, "path">>(clips: readonly T[] | undefined, path: string | null | undefined): T | undefined {
    if (!clips || path == null) return undefined;
    const k = pathKey(path);
    return clips.find(c => pathKey(c.path) === k);
}

/**
 * Whether to add the default sounds folder (the one the plugin ships) to the sources: only once (`flag`
 * set: already offered, so removing it later keeps it removed) and not when it is already listed
 * (compared by pathKey; then the caller just sets the flag).
 */
export function shouldAddDefaultFolder(flag: boolean, folders: readonly string[], defaultDir: string): boolean {
    if (flag) return false;
    const k = pathKey(defaultDir);
    return !!k && !folders.some(f => pathKey(f) === k);
}
