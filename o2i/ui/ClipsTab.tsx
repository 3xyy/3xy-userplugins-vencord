/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { LazyComponent } from "@utils/lazyReact";
import { React, useCallback, useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { KeyboardEvent, PointerEvent } from "react";

import { engineClient } from "../engineClient";
import { hotkeyConflict } from "../logic/accel";
import type { ClipSettings, O2iProfile } from "../logic/profile";
import { posFromX, seekPending, stepSeek } from "../logic/seek";
import { matchesSound, nextEmoji, soundLabel, type SoundMeta, soundName } from "../logic/soundMeta";
import { clipsStale, DEFAULT_CLIP, duplicateSourceTags, findClip, keyIndex, pathKey, sourceLabels, sourcesOf, withClipHotkey, withClipSettings } from "../logic/sources";
import { settings, updateProfile, updateSoundMeta } from "../settings";
import type { EngineSnapshot, PlayingJson } from "../types";
import { Field, pct, Section, SwitchRow, TextField, ValueSlider } from "./controls";
import { FoldersSection } from "./FoldersSection";
import { HotkeyInput } from "./HotkeyInput";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

// A sound is identified by its absolute path (the engine's clips[].path): per-sound settings, hotkeys,
// names / emojis and the open editor are all keyed by it, so the same file name in two folders is two sounds.
// Stored keys are matched by pathKey like the engine does (a folder re-added in another spelling keeps its
// sounds' settings): lookups go through keyIndex maps, and edits rewrite the key to the current path.

/** The last `clips` event: only replaced when the engine sends a new one, not per poll. */
const selectClips = (s: EngineSnapshot) => s.clips;
const selectGeneration = (s: EngineSnapshot) => s.generation;
const selectPlaying = (s: EngineSnapshot) => s.state?.playing;

/** The profile fields this tab edits (sliders are uncontrolled, so outside changes remount them). */
function clipsSignature(p: O2iProfile): string {
    return JSON.stringify([
        p.sb_clip_settings, p.sb_clip_hotkeys, p.sb_stop_all_hotkey,
        p.sb_global_others, p.sb_global_self, p.sb_global_hear_local, p.sb_global_override,
    ]);
}

/**
 * Signature of the profile edit() last wrote; consumed by the first render that sees it (see MicTab).
 * A single module slot: it assumes one mounted ClipsTab (the popout and the modal are never both
 * mounted for longer than a tick).
 */
let ownSignature: string | null = null;

function edit(fn: (p: O2iProfile) => O2iProfile) {
    updateProfile(p => {
        const next = fn(p);
        ownSignature = clipsSignature(next);
        return next;
    });
}

function useExternalRevision(p: O2iProfile): number {
    const sig = clipsSignature(p);
    const [sync, setSync] = useState({ sig, rev: 0 });
    if (sig === sync.sig) return sync.rev;
    const own = sig === ownSignature;
    if (own) ownSignature = null;
    const next = { sig, rev: own ? sync.rev : sync.rev + 1 };
    setSync(next);
    return next.rev;
}

/** Updates the per-sound settings entry for the sound at `path`, creating it with defaults on first edit. */
function patchClip(path: string, patch: Partial<Omit<ClipSettings, "name">>) {
    edit(p => withClip(p, path, patch));
}

const withClip = (p: O2iProfile, path: string, patch: Partial<Omit<ClipSettings, "name">>): O2iProfile =>
    ({ ...p, sb_clip_settings: withClipSettings(p.sb_clip_settings, path, patch) });

/** Drag previews: the engine hears the slider's value live; nothing is saved until release (see ValueSlider). */
const previewClip = (path: string, patch: Partial<Omit<ClipSettings, "name">>) =>
    engineClient.previewProfile(p => withClip(p, path, patch));
const previewGlobal = (patch: GlobalPatch) => engineClient.previewProfile(p => withGlobal(p, patch));
/** `committed`: the release is about to save (its configure follows); otherwise the stored profile is re-sent. */
const previewEnd = (committed: boolean) => engineClient.previewProfile(null, !committed);

function setClipHotkey(path: string, accel: string | null) {
    edit(p => ({ ...p, sb_clip_hotkeys: withClipHotkey(p.sb_clip_hotkeys, path, accel) }));
}

type GlobalPatch = Partial<Pick<O2iProfile, "sb_global_others" | "sb_global_self" | "sb_global_hear_local" | "sb_global_override">>;

/** The four global fields are always written together, explicitly. */
function patchGlobal(patch: GlobalPatch) {
    edit(p => withGlobal(p, patch));
}

const withGlobal = (p: O2iProfile, patch: GlobalPatch): O2iProfile => ({
    ...p,
    sb_global_others: p.sb_global_others ?? 1,
    sb_global_self: p.sb_global_self ?? 1,
    sb_global_hear_local: p.sb_global_hear_local ?? false,
    sb_global_override: p.sb_global_override ?? false,
    ...patch,
});

/**
 * Message if `accel` is already taken by another sound or the stop-all key. `ownPath` is the sound being
 * edited, or null for the stop-all key. Reads the live profile, not a render-time copy.
 */
function accelConflict(accel: string, ownPath: string | null): string | null {
    const p = settings.store.profile;
    return hotkeyConflict(p, settings.store.soundMeta, accel, ownPath, sourcesOf(p));
}

const MAX_RELIST = 4;

function fmtTime(s: number): string {
    const t = Math.max(0, Math.floor(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const SEEK_KEY_STEP_S = 5;
const SEEK_REPEAT_MS = 150;

interface SeekDrag {
    pointerId: number;
    /** Track's left edge and width when the press began. */
    left: number;
    width: number;
    pos: number;
}

/** A seek the user just made: shown until the engine's position catches up (no snap-back). */
interface SeekTarget {
    pos: number;
    at: number;
}

/**
 * One playing sound. When its length is known the bar is a seek slider: pressing / dragging previews a
 * position (local state, nothing sent) and releasing sends one `seek_clip`; arrow keys seek 5 s per press.
 * `label`: the sound's display name with its emoji (`item.name` is the file name, `item.path` its identity).
 */
function NowPlayingRow({ item, label, onVolume }: { item: PlayingJson; label: string; onVolume?(): void; }) {
    const len = item.len_s != null && item.len_s > 0 ? item.len_s : null;
    const drag = useRef<SeekDrag | null>(null);
    const target = useRef<SeekTarget | null>(null);
    const lastKeySeekAt = useRef(-Infinity);
    const [dragPos, setDragPos] = useState<number | null>(null);

    // Keep showing the target until the polled position gets there (or ~1 s passes).
    let shown = item.pos_s;
    if (target.current) {
        if (seekPending(target.current.pos, item.pos_s, Date.now() - target.current.at)) shown = target.current.pos;
        else target.current = null;
    }
    if (dragPos != null) shown = dragPos;
    const frac = len != null ? Math.min(Math.max(shown, 0) / len, 1) : 0;

    const seekTo = (pos: number) => {
        target.current = { pos, at: Date.now() };
        engineClient.send({ cmd: "seek_clip", id: item.id, pos_s: pos });
    };

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (len == null || e.button !== 0 || drag.current) return;
        const track = e.currentTarget;
        const rect = track.getBoundingClientRect();
        const pos = posFromX(e.clientX - rect.left, rect.width, len);
        try {
            track.setPointerCapture(e.pointerId);
        } catch {
            return; // pointer already gone
        }
        drag.current = { pointerId: e.pointerId, left: rect.left, width: rect.width, pos };
        setDragPos(pos);
        track.focus({ preventScroll: true });
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || len == null || e.pointerId !== cur.pointerId) return;
        const pos = posFromX(e.clientX - cur.left, cur.width, len);
        if (pos === cur.pos) return;
        cur.pos = pos;
        setDragPos(pos);
    };
    const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || len == null || e.pointerId !== cur.pointerId) return;
        drag.current = null;
        setDragPos(null);
        seekTo(posFromX(e.clientX - cur.left, cur.width, len));
    };
    // pointercancel, or capture lost without a pointerup (it is also lost right after one: drag is null by then).
    const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
        const cur = drag.current;
        if (!cur || e.pointerId !== cur.pointerId) return;
        drag.current = null;
        setDragPos(null);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (len == null || drag.current || e.altKey || e.ctrlKey || e.metaKey) return;
        let pos: number;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") pos = stepSeek(shown, -SEEK_KEY_STEP_S, len);
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") pos = stepSeek(shown, SEEK_KEY_STEP_S, len);
        else if (e.key === "Home") pos = 0;
        else if (e.key === "End") pos = stepSeek(len, 0, len);
        else return;
        e.preventDefault();
        e.stopPropagation();
        // Holding a key repeats ~30x/s: at most one seek per SEEK_REPEAT_MS.
        const now = performance.now();
        if (e.repeat && now - lastKeySeekAt.current < SEEK_REPEAT_MS) return;
        lastKeySeekAt.current = now;
        seekTo(pos);
    };

    return (
        <div className={cl("np-row")}>
            <div className={cl("app-head")}>
                <span className={cl("app-name")} title={item.path ?? item.name}>{label}</span>
                <span className={cl("value")}>
                    {len != null ? `${fmtTime(shown)} / ${fmtTime(len)}` : fmtTime(shown)}
                </span>
                {onVolume && (
                    <button type="button" className={cl("mini-btn")} aria-label={`Volume of ${label}`} title="Volume" onClick={onVolume}>
                        Volume
                    </button>
                )}
                <button
                    type="button"
                    className={cl("mini-btn")}
                    onClick={() => engineClient.send({ cmd: item.paused ? "resume_clip" : "pause_clip", id: item.id })}
                >
                    {item.paused ? "Resume" : "Pause"}
                </button>
                <button
                    type="button"
                    className={cl("mini-btn")}
                    aria-label={`Stop ${label}`}
                    onClick={() => engineClient.send({ cmd: "stop_clip", id: item.id })}
                >
                    Stop
                </button>
            </div>
            {len != null ? (
                <div
                    key="seek"
                    className={cl("np-seek")}
                    role="slider"
                    tabIndex={0}
                    aria-label={`Position of ${label}`}
                    aria-orientation="horizontal"
                    aria-valuemin={0}
                    aria-valuemax={Math.floor(len)}
                    aria-valuenow={Math.floor(shown)}
                    aria-valuetext={`${fmtTime(shown)} of ${fmtTime(len)}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    onLostPointerCapture={onPointerCancel}
                    onKeyDown={onKeyDown}
                >
                    <div className={cl("np-bar")}>
                        <div className={cl("np-fill")} style={{ width: `${frac * 100}%` }} />
                    </div>
                </div>
            ) : (
                <div key="plain" className={cl("np-bar")}>
                    <div className={cl("np-fill", "np-fill-indeterminate")} />
                </div>
            )}
        </div>
    );
}

/** The only part of the tab that re-renders on every poll. `onVolume` opens a sound's settings editor. */
function NowPlaying({ meta, onVolume }: { meta: Map<string, SoundMeta>; onVolume(path: string): void; }) {
    const playing = useEngineValue(selectPlaying);
    if (!playing?.length) return null;
    return (
        <Section
            title="Now playing"
            action={
                <button type="button" className={cl("mini-btn")} onClick={() => engineClient.send({ cmd: "stop_all" })}>
                    Stop all sounds
                </button>
            }
        >
            {playing.map(item => {
                const path = item.path ?? item.name;
                const itemPath = item.path;
                return (
                    <NowPlayingRow
                        key={item.id}
                        item={item}
                        label={soundLabel(path, meta.get(pathKey(path)))}
                        onVolume={itemPath ? () => onVolume(itemPath) : undefined}
                    />
                );
            })}
        </Section>
    );
}

interface ClipTileProps {
    /** The sound's identity (absolute path). */
    path: string;
    /** Display name (custom, or the file name without extension) and emoji: primitives, so memo holds. */
    name: string;
    emoji: string | null;
    duration: number | null;
    hotkey: string | null;
    /** Its folder's chip label, shown only when another folder has a file with the same name. */
    where: string | null;
    selected: boolean;
    onPlay(path: string): void;
    onToggle(path: string): void;
}

// React isn't available when Vencord's bundle evaluates, so memo() must run lazily on first render.
const ClipTile = LazyComponent<ClipTileProps>(() => React.memo(ClipTileImpl));

function ClipTileImpl({ path, name, emoji, duration, hotkey, where, selected, onPlay, onToggle }: ClipTileProps) {
    const meta = [duration != null ? fmtTime(duration) : null, hotkey, where].filter(Boolean).join(" · ");
    const label = emoji ? `${emoji} ${name}` : name;
    return (
        <div className={cl("clip-tile", { "clip-tile-selected": selected })}>
            <button type="button" className={cl("clip-play")} title={`Play ${label} (${path})`} onClick={() => onPlay(path)}>
                <span className={cl("clip-name")}>
                    {emoji && <span className={cl("clip-emoji")}>{emoji}</span>}
                    {name}
                </span>
                {meta && <span className={cl("clip-meta")}>{meta}</span>}
            </button>
            <button
                type="button"
                className={cl("clip-gear")}
                aria-label={`Edit ${label}`}
                aria-expanded={selected}
                title="Edit"
                onClick={() => onToggle(path)}
            >
                ⚙
            </button>
        </div>
    );
}

/** Scrolls the popout's own content area (never Discord's scrollers) just enough to bring `el` into view. */
function revealInContent(el: HTMLElement) {
    const scroller = el.closest<HTMLElement>(`.${cl("content")}`);
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top) scroller.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) scroller.scrollTop += Math.min(r.bottom - box.bottom, r.top - box.top);
}

/**
 * In place of the editor when "Volume" targets a playing sound that isn't listed any more (its folder
 * was removed): a short note instead of nothing happening.
 */
function UnlistedSoundNote({ path, meta, reveal, onClose }: { path: string; meta: SoundMeta | undefined; reveal: number; onClose(): void; }) {
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (root.current) revealInContent(root.current);
    }, [reveal]);
    return (
        <div className={cl("clip-editor")} ref={root}>
            <div className={cl("clip-editor-head")}>
                <span className={cl("clip-editor-title")} title={path}>{soundLabel(path, meta)}</span>
                <button type="button" className={cl("mini-btn")} aria-label="Close" title="Close" onClick={onClose}>
                    ✕
                </button>
            </div>
            <div className={cl("note")}>This sound isn't in your soundboard folders, so its settings can't be changed here.</div>
        </div>
    );
}

const NAME_MAX = 64;

/**
 * The sound's display name and emoji (the soundMeta setting: display only, never sent to the engine).
 * The name is a draft while typing and is saved, trimmed, on blur, Enter, the clear button or when the
 * editor closes. The emoji box keeps one emoji: the newest one typed, pasted or picked with Win + .
 */
function SoundIdentity({ path, meta }: { path: string; meta: SoundMeta | undefined; }) {
    const [draft, setDraft] = useState(() => meta?.name ?? "");
    const latest = useRef(draft);
    const commit = useCallback(() => updateSoundMeta(path, { name: latest.current }), [path]);
    useEffect(() => commit, [commit]); // closing the editor / panel mid-edit keeps what was typed

    const onName = (v: string) => {
        latest.current = v;
        setDraft(v);
    };
    const onNameBlur = () => {
        onName(latest.current.trim());
        commit();
    };
    // Enter finishes the edit (the blur saves it).
    const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") e.currentTarget.blur();
    };
    // A new emoji replaces the old one wherever the caret was; non-emoji input is a no-op (the box reverts).
    const onEmoji = (v: string) => updateSoundMeta(path, { emoji: nextEmoji(v, meta?.emoji) });

    return (
        <div className={cl("sound-id")}>
            <Field label="Emoji">
                <TextField
                    className={cl("emoji-field")}
                    value={meta?.emoji ?? ""}
                    onChange={onEmoji}
                    onClear={() => updateSoundMeta(path, { emoji: undefined })}
                    placeholder="Win + ."
                    label="Emoji"
                    title="Type or paste an emoji, or press Win + . to pick one"
                />
            </Field>
            <Field label="Name">
                <TextField
                    className={cl("name-field")}
                    value={draft}
                    onChange={onName}
                    onBlur={onNameBlur}
                    onKeyDown={onNameKey}
                    onClear={() => {
                        onName("");
                        commit();
                    }}
                    placeholder={soundName(path, undefined)}
                    label="Name"
                    maxLength={NAME_MAX}
                />
            </Field>
        </div>
    );
}

/**
 * Settings for one sound, full width below the grid. Keyed by path; its levels column is keyed by the
 * external revision (those sliders are uncontrolled), so the name draft survives outside changes.
 */
function ClipEditor({ path, meta, entry, hotkey, overridden, revision, reveal, onClose }: {
    path: string;
    meta: SoundMeta | undefined;
    entry: ClipSettings | undefined;
    hotkey: string | null;
    /** "Override all sounds" is on: the engine ignores this sound's levels (its hotkey still applies). */
    overridden: boolean;
    revision: number;
    /** Changes each time "Volume" targets this already open editor, to scroll it into view again. */
    reveal: number;
    onClose(): void;
}) {
    const s = { ...DEFAULT_CLIP, ...entry };
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (root.current) revealInContent(root.current);
    }, [reveal]);
    return (
        <div className={cl("clip-editor")} ref={root}>
            <div className={cl("clip-editor-head")}>
                <span className={cl("clip-editor-title")} title={path}>{soundLabel(path, meta)}</span>
                <button type="button" className={cl("mini-btn")} aria-label="Close sound settings" title="Close" onClick={onClose}>
                    ✕
                </button>
            </div>
            {/* One column in the popout; side by side in the expanded panel. */}
            <div className={cl("clip-editor-cols")}>
                <div className={cl("clip-editor-col")}>
                    <SoundIdentity path={path} meta={meta} />
                    <Field label="Hotkey">
                        <HotkeyInput value={hotkey} onChange={v => setClipHotkey(path, v)} validate={a => accelConflict(a, path)} />
                    </Field>
                </div>
                <div className={cl("clip-editor-col")} key={revision}>
                    {overridden && <div className={cl("note")}>Levels are set by "Override all sounds" below</div>}
                    <ValueSlider
                        label="Others hear"
                        min={0}
                        max={200}
                        value={s.vol_others * 100}
                        format={pct}
                        disabled={overridden}
                        onPreview={v => previewClip(path, { vol_others: Math.round(v) / 100 })}
                        onPreviewEnd={previewEnd}
                        onCommit={v => patchClip(path, { vol_others: Math.round(v) / 100 })}
                    />
                    <ValueSlider
                        label="You hear"
                        min={0}
                        max={200}
                        value={s.vol_self * 100}
                        format={pct}
                        disabled={overridden}
                        onPreview={v => previewClip(path, { vol_self: Math.round(v) / 100 })}
                        onPreviewEnd={previewEnd}
                        onCommit={v => patchClip(path, { vol_self: Math.round(v) / 100 })}
                    />
                    <SwitchRow
                        label="Hear locally"
                        hint="Also play this sound on your own speakers"
                        value={s.hear_local}
                        disabled={overridden}
                        onChange={v => patchClip(path, { hear_local: v })}
                    />
                </div>
            </div>
        </div>
    );
}

function GlobalSection({ p }: { p: O2iProfile; }) {
    const on = !!p.sb_global_override;
    return (
        <Section title="All sounds">
            <SwitchRow
                label="Override all sounds"
                hint="Use these levels instead of each sound's own"
                value={on}
                onChange={v => patchGlobal({ sb_global_override: v })}
            />
            <ValueSlider
                label="Others hear"
                min={0}
                max={200}
                value={(p.sb_global_others ?? 1) * 100}
                format={pct}
                disabled={!on}
                onPreview={v => previewGlobal({ sb_global_others: Math.round(v) / 100 })}
                onPreviewEnd={previewEnd}
                onCommit={v => patchGlobal({ sb_global_others: Math.round(v) / 100 })}
            />
            <ValueSlider
                label="You hear"
                min={0}
                max={200}
                value={(p.sb_global_self ?? 1) * 100}
                format={pct}
                disabled={!on}
                onPreview={v => previewGlobal({ sb_global_self: Math.round(v) / 100 })}
                onPreviewEnd={previewEnd}
                onCommit={v => patchGlobal({ sb_global_self: Math.round(v) / 100 })}
            />
            <SwitchRow
                label="Hear locally"
                value={!!p.sb_global_hear_local}
                disabled={!on}
                onChange={v => patchGlobal({ sb_global_hear_local: v })}
            />
        </Section>
    );
}

/** "All" + one chip per folder (only rendered with more than one). `active`: the chosen folder's pathKey, or null for All. */
function SourceChips({ sources, labels, active, onPick }: {
    sources: string[];
    labels: string[];
    active: string | null;
    onPick(key: string | null): void;
}) {
    return (
        <div className={cl("chips")} role="group" aria-label="Show sounds from">
            <button
                type="button"
                className={cl("chip", { "chip-selected": active === null })}
                aria-pressed={active === null}
                onClick={() => onPick(null)}
            >
                All
            </button>
            {sources.map((f, i) => {
                const key = pathKey(f);
                return (
                    <button
                        key={key}
                        type="button"
                        className={cl("chip", { "chip-selected": active === key })}
                        aria-pressed={active === key}
                        title={f}
                        onClick={() => onPick(key)}
                    >
                        {labels[i]}
                    </button>
                );
            })}
        </div>
    );
}

export function ClipsTab() {
    const { profile, soundMeta } = settings.use(["profile", "soundMeta"]);
    const p = profile ?? { name: "default" };
    // Newline-joined (a folder path can't contain one): a primitive for the effects and memos below.
    const sourcesSig = sourcesOf(p).join("\n");
    const sources = useMemo(() => sourcesSig ? sourcesSig.split("\n") : [], [sourcesSig]);
    const labels = useMemo(() => sourceLabels(sources), [sources]);
    const revision = useExternalRevision(p);
    const clipsEvent = useEngineValue(selectClips);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [reveal, setReveal] = useState(0);
    /** The source chip (a folder's pathKey), null = All. UI state only. */
    const [sourceFilter, setSourceFilter] = useState<string | null>(null);

    const generation = useEngineValue(selectGeneration);
    const firstRun = useRef(true);
    const relists = useRef(0);

    // list_clips can stall the engine ~1 s: once per mount / folders change / engine respawn, never polled.
    // A folders change waits out the 150 ms configure debounce so the engine already has the new folders.
    useEffect(() => {
        if (!sourcesSig) return;
        const delay = firstRun.current ? 0 : 200;
        firstRun.current = false;
        relists.current = 0;
        const t = setTimeout(() => engineClient.send({ cmd: "list_clips" }), delay);
        return () => clearTimeout(t);
    }, [sourcesSig, generation]);

    // A reply from before the folders changed (or sent before configure landed): treat as loading and ask again.
    const stale = useMemo(() => !!clipsEvent && clipsStale(clipsEvent, sources), [clipsEvent, sources]);
    useEffect(() => {
        if (!stale || !sourcesSig || relists.current >= MAX_RELIST) return;
        const t = setTimeout(() => {
            relists.current++;
            engineClient.send({ cmd: "list_clips" });
        }, 300);
        return () => clearTimeout(t);
    }, [stale, clipsEvent, sourcesSig]);

    const clips = stale ? undefined : clipsEvent?.clips;
    // The chip filters only while it names a current folder and there is more than one.
    const activeSource = sources.length > 1 && sourceFilter !== null && sources.some(f => pathKey(f) === sourceFilter) ? sourceFilter : null;
    // Its folder is gone (or it's the only one left): back to All, so re-adding the folder doesn't revive the old chip.
    if (sourceFilter !== null && activeSource === null) setSourceFilter(null);

    // Lookups by pathKey (first entry per sound wins, like the engine); rebuilt only when the setting changes.
    // Settings values are a fresh Proxy per read, so the memos key on string signatures of their data.
    const metaSig = JSON.stringify(soundMeta ?? {});
    const hotkeysSig = JSON.stringify(p.sb_clip_hotkeys ?? []);
    const levelsSig = JSON.stringify(p.sb_clip_settings ?? []);
    const metaIndex = useMemo(() => keyIndex(Object.entries(JSON.parse(metaSig) as Record<string, SoundMeta>)), [metaSig]);
    const hotkeys = useMemo(() => keyIndex(JSON.parse(hotkeysSig) as [string, string][]), [hotkeysSig]);
    const levels = useMemo(() => keyIndex((JSON.parse(levelsSig) as ClipSettings[]).map(s => [s.name, s] as const)), [levelsSig]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = clips ?? [];
        if (!q && activeSource === null) return list;
        return list.filter(c => (activeSource === null || pathKey(c.source) === activeSource) && matchesSound(q, c.file, metaIndex.get(pathKey(c.path))));
    }, [clips, query, metaIndex, activeSource]);
    const tags = useMemo(() => duplicateSourceTags(clips ?? [], sources), [clips, sources]);

    const onPlay = useCallback((path: string) => engineClient.send({ cmd: "play_clip", path }), []);
    const onToggle = useCallback((path: string) => setSelected(cur => cur !== null && pathKey(cur) === pathKey(path) ? null : path), []);
    const onVolume = useCallback((path: string) => {
        setSelected(path);
        setReveal(n => n + 1);
    }, []);
    const onCloseEditor = useCallback(() => setSelected(null), []);

    // No folders: just the Folders section (open), with Add folder. Same root and first child as below, so
    // adding the first folder keeps the section's open state.
    if (!sources.length) {
        return (
            <div className={cl("tab", "tab-sounds")}>
                <FoldersSection compact />
            </div>
        );
    }

    // Shown while the sound exists, even if the search or a chip hides its tile. Matched by pathKey: a
    // playing sound's path (from "Volume") may differ from its clips[].path in case or slashes.
    const selectedKey = selected != null ? pathKey(selected) : null;
    const editing = findClip(clips, selected)?.path ?? null;
    // "Volume" on a sound that isn't listed (its folder was removed): say so instead of doing nothing.
    const unlisted = selected != null && clips && !editing ? selected : null;
    const emptyText = !clips?.length
        ? sources.length > 1 ? "No sounds in these folders yet" : "No sounds in this folder yet"
        : activeSource !== null && !query.trim() ? "No sounds in this folder yet" : "No matching sounds";

    return (
        <div className={cl("tab", "tab-sounds")}>
            {/* At the top: collapsed once there is a folder, so the sounds stay where they were. */}
            <FoldersSection compact />
            <Section
                title={`Sounds${clips ? ` (${filtered.length})` : ""}`}
                action={
                    <button
                        type="button"
                        className={cl("mini-btn")}
                        aria-label="Refresh sound list"
                        title="Refresh"
                        onClick={() => engineClient.send({ cmd: "list_clips" })}
                    >
                        ↻
                    </button>
                }
            >
                <TextField value={query} onChange={setQuery} onClear={() => setQuery("")} placeholder="Search sounds" />
                {sources.length > 1 && <SourceChips sources={sources} labels={labels} active={activeSource} onPick={setSourceFilter} />}
                <div className={cl("clip-grid")}>
                    {!clips
                        ? <div className={cl("empty-text", "clip-span")}>Loading…</div>
                        : filtered.length === 0
                            ? <div className={cl("empty-text", "clip-span")}>{emptyText}</div>
                            : filtered.map(c => {
                                const k = pathKey(c.path);
                                const m = metaIndex.get(k);
                                return (
                                    <ClipTile
                                        key={c.path}
                                        path={c.path}
                                        name={soundName(c.file, m)}
                                        emoji={m?.emoji ?? null}
                                        duration={c.duration_s}
                                        hotkey={hotkeys.get(k) ?? null}
                                        where={tags.get(c.path) ?? null}
                                        selected={k === selectedKey}
                                        onPlay={onPlay}
                                        onToggle={onToggle}
                                    />
                                );
                            })}
                </div>
                {/* Below the grid, not inside its 240 px scroll area: room for the controls, and tiles never move. */}
                {editing && (
                    <ClipEditor
                        key={editing}
                        path={editing}
                        meta={metaIndex.get(pathKey(editing))}
                        entry={levels.get(pathKey(editing))}
                        hotkey={hotkeys.get(pathKey(editing)) ?? null}
                        overridden={!!p.sb_global_override}
                        revision={revision}
                        reveal={reveal}
                        onClose={onCloseEditor}
                    />
                )}
                {unlisted && (
                    <UnlistedSoundNote
                        key={unlisted}
                        path={unlisted}
                        meta={metaIndex.get(pathKey(unlisted))}
                        reveal={reveal}
                        onClose={onCloseEditor}
                    />
                )}
            </Section>

            {/* Below the grid so tiles never move when playback starts or stops. */}
            <NowPlaying meta={metaIndex} onVolume={onVolume} />

            {/* A keyed fragment (not a wrapper div) so these stay sibling sections and get their dividers. */}
            <React.Fragment key={revision}>
                <GlobalSection p={p} />
                <Section title="Stop-all hotkey">
                    <HotkeyInput
                        value={p.sb_stop_all_hotkey ?? null}
                        onChange={v => edit(q => ({ ...q, sb_stop_all_hotkey: v }))}
                        validate={a => accelConflict(a, null)}
                    />
                </Section>
            </React.Fragment>
        </div>
    );
}
