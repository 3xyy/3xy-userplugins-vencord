/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { Button } from "@components/Button";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";
import { useState } from "@webpack/common";

const SpotifyAPI = findByPropsLazy("vcSpotifyMarker");
const SpotifySocket = findByPropsLazy("getActiveSocketAndDevice");
const logger = new Logger("SpotifyStatus:Import");
const cl = classNameFactory("vc-sps-");

type ImportMode = "artist" | "songName" | "songUri";

interface Props {
    /** Artists, or songs (added as names or as Spotify URIs, picked in the box). */
    kind: "artist" | "song";
    list: string[];
    onChanged(): void;
}

/**
 * Matches:
 *   spotify:playlist:<id>
 *   https://open.spotify.com/playlist/<id>[?...]
 *   <id> (22-char base62)
 */
function extractPlaylistId(input: string): string | null {
    const s = input.trim();
    if (!s) return null;
    const m = s.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9]{10,}$/.test(s)) return s;
    return null;
}

async function fetchAllPlaylistTracks(playlistId: string, onProgress?: (n: number) => void): Promise<any[]> {
    // Discord's Spotify API helper (vcSpotifyMarker) only exists once SpotifyControls has patched it.
    if (!isPluginEnabled("SpotifyControls")) {
        throw new Error("Importing a playlist needs the SpotifyControls plugin. Turn it on, restart Discord and try again.");
    }
    const sad = (SpotifySocket as any).getActiveSocketAndDevice?.();
    const socket = sad?.socket;
    if (!socket?.accountId || !socket?.accessToken) {
        throw new Error("Spotify isn't active. Open Spotify, play something and try again.");
    }

    const all: any[] = [];
    let url: string = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=${encodeURIComponent("items(track(name,id,uri,artists(name,id))),next")}&limit=100`;
    let guard = 0;
    while (url && guard++ < 50) { // safety cap: 50 pages = 5000 tracks
        const res: any = await (SpotifyAPI as any).get(socket.accountId, socket.accessToken, { url });
        const body = res?.body ?? res;
        const items = body?.items ?? [];
        all.push(...items);
        onProgress?.(all.length);
        url = body?.next ?? "";
    }
    return all;
}

/**
 * Appends the new entries (case-insensitive). `already` counts distinct entries that were in the list
 * before this import; repeats inside the import itself (the same artist on many songs) aren't counted.
 */
function dedupeAppend(list: string[], values: string[]): { added: number; already: number; } {
    const before = new Set(list.map(v => v.toLowerCase()));
    const seen = new Set<string>();
    let added = 0, already = 0;
    for (const v of values) {
        const k = v.toLowerCase();
        if (!k || seen.has(k)) continue; // empty, or a repeat within this import
        seen.add(k);
        if (before.has(k)) { already++; continue; }
        list.push(v);
        added++;
    }
    return { added, already };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const alreadyThere = (n: number) => n ? ` ${n} ${n === 1 ? "was" : "were"} already in the list.` : "";

let nextImportId = 0;

/** "Import artists" / "Import songs": a closed-by-default box to add many entries from a playlist or a pasted list. */
export function BulkImport({ kind, list, onChanged }: Props) {
    const [open, setOpen] = useState(false);
    const [songMode, setSongMode] = useState<"songName" | "songUri">("songName");
    const [playlistInput, setPlaylistInput] = useState("");
    const [paste, setPaste] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [bodyId] = useState(() => `vc-sps-import-${++nextImportId}`);
    const mode: ImportMode = kind === "artist" ? "artist" : songMode;
    const noun = (n: number) => kind === "artist" ? plural(n, "artist", "artists") : plural(n, "song", "songs");

    const importPlaylist = async () => {
        const id = extractPlaylistId(playlistInput);
        if (!id) { setStatus("That doesn't look like a playlist link or ID."); return; }
        setBusy(true); setStatus("Loading the playlist...");
        try {
            const items = await fetchAllPlaylistTracks(id, n => setStatus(`Loaded ${plural(n, "song", "songs")}...`));
            const values: string[] = [];
            for (const { track } of items) {
                if (!track) continue;
                if (mode === "artist") {
                    for (const a of track.artists ?? []) if (a?.name) values.push(a.name);
                } else if (mode === "songName") {
                    if (track.name) values.push(track.name);
                } else if (mode === "songUri") {
                    if (track.uri) values.push(track.uri);
                    else if (track.id) values.push(`spotify:track:${track.id}`);
                }
            }
            const { added, already } = dedupeAppend(list, values);
            onChanged();
            setStatus(`Added ${noun(added)} from ${plural(items.length, "song", "songs")}.${alreadyThere(already)}`);
        } catch (e: any) {
            logger.error("import failed", e);
            setStatus(`Couldn't import the playlist. ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const importPaste = () => {
        const lines = paste.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!lines.length) { setStatus("Paste something first."); return; }
        const { added, already } = dedupeAppend(list, lines);
        onChanged();
        setPaste("");
        setStatus(`Added ${noun(added)}.${alreadyThere(already)}`);
    };

    return (
        <div className={cl("import")}>
            <button
                type="button"
                className={cl("disclosure")}
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen(o => !o)}
            >
                <svg className={cl("chevron", { "chevron-open": open })} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {kind === "artist" ? "Import artists" : "Import songs"}
            </button>
            <div id={bodyId} className={cl("import-body")} hidden={!open}>
                {open && (
                    <>
                        {kind === "song" && (
                            <div className={cl("field-row")}>
                                <label className={cl("field-label")} htmlFor={`${bodyId}-mode`}>Add songs as</label>
                                <select
                                    id={`${bodyId}-mode`}
                                    className={cl("select")}
                                    value={songMode}
                                    onChange={e => setSongMode(e.currentTarget.value as "songName" | "songUri")}
                                >
                                    <option value="songName">Song names</option>
                                    <option value="songUri">Spotify URIs</option>
                                </select>
                            </div>
                        )}

                        <div className={cl("field")}>
                            <div className={cl("field-label")}>From a Spotify playlist</div>
                            <div className={cl("field-hint")}>Paste its link or ID. Needs Spotify open and the SpotifyControls plugin.</div>
                            <div className={cl("field-row")}>
                                <input
                                    className={cl("input")}
                                    type="text"
                                    value={playlistInput}
                                    placeholder="https://open.spotify.com/playlist/..."
                                    aria-label="Spotify playlist link or ID"
                                    spellCheck={false}
                                    autoComplete="off"
                                    onChange={e => setPlaylistInput(e.currentTarget.value)}
                                    onKeyDown={e => { if (e.key === "Enter" && !busy && playlistInput.trim()) void importPlaylist(); }}
                                />
                                <Button size="small" onClick={importPlaylist} disabled={busy || !playlistInput.trim()}>Import</Button>
                            </div>
                        </div>

                        <div className={cl("field")}>
                            <div className={cl("field-label")}>Or paste a list</div>
                            <div className={cl("field-hint")}>One per line.</div>
                            <textarea
                                className={cl("textarea")}
                                placeholder={mode === "artist" ? "Radiohead\nThe Beatles\nBon Iver" : mode === "songUri" ? "spotify:track:63OQupATfueTdZMWTxW03A" : "Karma Police\nLet It Be"}
                                aria-label={kind === "artist" ? "Artists, one per line" : "Songs, one per line"}
                                value={paste}
                                onChange={e => setPaste(e.currentTarget.value)}
                                spellCheck={false}
                                rows={4}
                            />
                            <div className={cl("field-row")}>
                                <Button size="small" variant="secondary" onClick={importPaste} disabled={!paste.trim()}>Add to the list</Button>
                            </div>
                        </div>

                        {status && <div className={cl("list-note")} role="status">{status}</div>}
                    </>
                )}
            </div>
        </div>
    );
}
