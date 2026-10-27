/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { useEffect, useLayoutEffect, useReducer, useRef, UserStore, useState } from "@webpack/common";
import type { ReactNode, RefObject } from "react";

import { msToClock } from "./format";
import { getLiveState, settings } from "./index";
import { activityTimestamps, buildLargeImageText, type Track } from "./output";
import {
    buildPreview, type HiddenReason, type ImageLookups, type Preview as PreviewData, previewIcon, type PreviewImage,
    previewImage, type PreviewLive, progressOf, SAMPLE_TRACK
} from "./preview";

type Live = PreviewLive & { now: number; sessionStart: number; };

const cl = classNameFactory("vc-sps-");
const logger = new Logger("SpotifyStatus:Preview", "#1db954");

let stickyWarned = false;

/**
 * position: sticky binds to the nearest ancestor that clips (overflow other than visible or clip), so
 * it only works when that ancestor is the settings scroller. Returns that scroller, or null when sticky
 * can't work there. That case is logged once per Discord session, so a Discord update that breaks it
 * shows up in the console.
 */
function stickyScroller(el: HTMLElement): HTMLElement | null {
    const clips = (v: string) => v !== "visible" && v !== "clip";
    const scrollable = (overflowY: string) => overflowY === "auto" || overflowY === "scroll";
    const overflows = (p: HTMLElement) => p.scrollHeight > p.clientHeight + 1;
    const describe = (p: HTMLElement) => `<${p.tagName.toLowerCase()} class="${p.className}">`;
    let nearest: HTMLElement | null = null;
    let nearestScrollable = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(p);
        if (!clips(overflowX) && !clips(overflowY)) continue;
        if (!nearest) {
            if (scrollable(overflowY) && overflows(p)) return p; // the settings scroller itself: sticky works
            nearest = p;
            nearestScrollable = scrollable(overflowY);
        } else if (scrollable(overflowY) && overflows(p)) {
            if (!stickyWarned) logger.info(`The preview can't stay at the top: ${describe(nearest)} clips inside the scroller ${describe(p)}, so the card scrolls with the page`);
            stickyWarned = true;
            return null;
        }
    }
    // nothing scrolls right now (a short page): sticky still binds to the nearest scroller once it does
    return nearestScrollable ? nearest : null;
}

/**
 * Keeps a focused setting from hiding under the sticky card: scroll-padding-top on the card's own
 * scroller (inline, only that element) makes focus and scrollIntoView leave room for the card.
 * The card's own buttons get the same room back as a negative scroll margin (--vc-sps-room, styles.css),
 * so tabbing into the stuck card doesn't scroll the page. Follows the card's height and puts the old
 * value back on unmount.
 */
function useScrollRoom(card: RefObject<HTMLDivElement | null>) {
    useLayoutEffect(() => {
        const el = card.current;
        const scroller = el && stickyScroller(el);
        if (!el || !scroller) return;
        const before = scroller.style.scrollPaddingTop;
        const apply = () => {
            const room = `${el.offsetHeight + 8}px`;
            scroller.style.scrollPaddingTop = room;
            el.style.setProperty("--vc-sps-room", room);
        };
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(el);
        return () => {
            observer.disconnect();
            scroller.style.scrollPaddingTop = before;
        };
    }, []);
}

function Chevron({ open }: { open: boolean; }) {
    return (
        <svg className={cl("chevron", { "chevron-open": open })} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function NoteIcon() {
    return (
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z" />
        </svg>
    );
}

/** The message shown instead of the cards, for the reason the real output gives for showing nothing. */
function hiddenNotice(reason: HiddenReason): { title: string; hint: string; } {
    switch (reason) {
        case "filtered":
            return { title: "Hidden by your filters", hint: "Your artist or song filters hide this song, so nothing is shown." };
        case "paused":
            return {
                title: "Status cleared while paused",
                // which of the two causes, so you know what to change
                hint: settings.store.clearOnPause ? "\"Clear the status when you pause\" is on." : "The status text while paused is empty.",
            };
        case "noTemplate":
            return { title: "Nothing to show", hint: "The status text while playing is empty, so nothing is shown." };
        case "outputsOff":
            return { title: "Nothing to show", hint: "Custom status and rich presence are both off." };
        case "empty":
            return { title: "Nothing to show", hint: "The status came out empty, with no text and no emoji." };
    }
}

function Avatar() {
    const user = UserStore.getCurrentUser();
    const src = user?.getAvatarURL(undefined, 64, false);
    return (
        <div className={cl("avatar")}>
            {src ? <img src={src} alt="" width={32} height={32} /> : <div className={cl("avatar-blank")} />}
            <span className={cl("avatar-dot")} />
        </div>
    );
}

function MemberRow({ p }: { p: PreviewData; }) {
    const user = UserStore.getCurrentUser();
    const name = user?.globalName || user?.username || "You";
    const { activityType, activityStatusDisplay } = settings.store;
    const a = p.activity;
    let line: ReactNode = null;
    let title = "";
    if (p.customStatus) {
        const { emoji, text } = p.customStatus;
        title = [emoji, text].filter(Boolean).join(" ");
        line = <>{emoji && <span className={cl("status-emoji")}>{emoji}</span>}{text}</>;
    } else if (a) {
        // With no custom status, Discord shows the activity here, using the line picked in "status display".
        const field = (activityStatusDisplay === "details" ? a.details : activityStatusDisplay === "state" ? a.state : "") || a.name;
        const verb = activityType === "hang" ? "" : `${a.typeLabel} `;
        title = verb + field;
        line = <>{verb}<strong>{field}</strong></>;
    }
    return (
        <div className={cl("member")}>
            <Avatar />
            <div className={cl("member-text")}>
                <div className={cl("member-name")}>{name}</div>
                {line && <div className={cl("member-status")} title={title}>{line}</div>}
            </div>
        </div>
    );
}

/**
 * The activity's big picture. The preview can't load most image hosts (Vencord's CSP), so where Discord
 * shows a picture the preview can't, the tile names it instead. No tile where Discord shows none.
 */
function Art({ pic, hoverText, sample }: { pic: PreviewImage; hoverText?: string; sample: boolean; }) {
    const [failed, setFailed] = useState(false);
    if (pic.kind === "none") return null;
    // the sample song has no real picture to load: just a neutral placeholder where one would go
    if (sample) {
        return (
            <div className={cl("art", "art-placeholder")} title={hoverText}>
                <NoteIcon />
            </div>
        );
    }
    if (pic.kind === "image" && !failed) {
        return (
            <div className={cl("art")} title={hoverText}>
                <img src={pic.src} alt="" onError={() => setFailed(true)} />
            </div>
        );
    }
    const note = `${pic.label} shows here in Discord. The preview can't load it.`;
    return (
        <div className={cl("art", "art-label")} title={hoverText ? `${note}\n${hoverText}` : note}>
            {pic.label}
        </div>
    );
}

function ActivityCard({ p, live, track, look }: { p: PreviewData; live: Live; track: Track; look: ImageLookups; }) {
    const s = settings.store;
    const a = p.activity;
    if (!a) return <div className={cl("activity", "activity-off")}>Rich presence is off</div>;

    const pic = previewImage(s, track, p.usingSample, look);
    const imageText = buildLargeImageText(s, track, previewIcon(s, live));
    const progress = s.timestampMode === "track"
        ? progressOf(activityTimestamps("track", track, live.now, live.sessionStart), live.now)
        : null;

    // Like Discord's listening card: the name goes in the heading, details (else the name) in bold, then state.
    const primary = a.details || a.name;
    return (
        <div className={cl("activity")}>
            <div className={cl("activity-head")} title={a.name}>{s.activityType === "hang" ? `${a.typeLabel}: ${a.name}` : `${a.typeLabel} ${a.name}`}</div>
            <div className={cl("activity-body")}>
                <Art key={pic.kind === "image" ? pic.src : pic.kind} pic={pic} hoverText={imageText} sample={p.usingSample} />
                <div className={cl("activity-text")}>
                    <div className={cl("activity-name")} title={primary}>{primary}</div>
                    {a.state && <div className={cl("activity-line")} title={a.state}>{a.state}</div>}
                    {progress
                        ? (
                            <div className={cl("progress")}>
                                <div className={cl("bar")}>
                                    <div className={cl("bar-fill")} style={{ width: `${progress.total ? (progress.elapsed / progress.total) * 100 : 0}%` }} />
                                </div>
                                <div className={cl("bar-times")}>
                                    <span>{msToClock(progress.elapsed)}</span>
                                    <span>{msToClock(progress.total)}</span>
                                </div>
                            </div>
                        )
                        : a.timestamp && <div className={cl("activity-time")}>{a.timestamp}</div>}
                </div>
            </div>
        </div>
    );
}

/** Sticky card at the top of the plugin's settings: what Discord would show, updated as settings change. */
export function PreviewCard() {
    // Every setting that changes the output, so the card redraws as soon as one changes.
    settings.use([
        "source", "updateCustomStatus", "updateActivity",
        "template", "pausedTemplate", "stripParens", "fontStyle",
        "iconPool", "iconRandomizeEvery", "emoji", "emojiRandomize", "emojiPool",
        "activityType", "activityName", "activityDetails", "activityState", "activityStatusDisplay",
        "largeImageSource", "largeImageCustomUrl", "largeImageText", "timestampMode",
        "artistFilterMode", "songFilterMode", "artistList", "songList", "clearOnPause",
    ]);
    const [open, setOpen] = useState(true);
    /** "live" follows the track; the buttons let you look at the playing or paused text either way. */
    const [mode, setMode] = useState<"live" | "playing" | "paused">("live");
    const [mountedAt] = useState(() => Date.now());
    const [, tick] = useReducer((n: number) => n + 1, 0);
    const root = useRef<HTMLDivElement>(null);

    // Once a second: the track position, elapsed times and track changes. Only string building.
    useEffect(() => {
        if (!open) return;
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [open]);

    useScrollRoom(root);

    const state = getLiveState();
    const { track } = state;
    const paused = mode === "live" ? !!track && !track.isPlaying : mode === "paused";
    const live: Live = state.running
        ? { icon: state.icon, emoji: state.emoji, now: state.now, sessionStart: state.sessionStart }
        : { now: state.now, sessionStart: mountedAt };
    const p = buildPreview(settings.store, track, paused, live);
    const empty = p.hiddenReason ? hiddenNotice(p.hiddenReason) : null;
    const bodyId = "vc-sps-preview-body";

    return (
        <div ref={root} className={cl("preview")}>
            <div className={cl("preview-head")}>
                <span className={cl("preview-label")}>Preview</span>
                <span className={cl("preview-source")}>
                    {p.usingSample
                        ? state.running ? "Sample song, nothing is playing" : "Sample song, the plugin is off"
                        : "Now playing"}
                </span>
                <div className={cl("preview-actions")}>
                    {open && (
                        <div className={cl("seg")} role="group" aria-label="Preview as">
                            <button type="button" className={cl("seg-btn")} aria-pressed={!paused} onClick={() => setMode("playing")}>Playing</button>
                            <button type="button" className={cl("seg-btn")} aria-pressed={paused} onClick={() => setMode("paused")}>Paused</button>
                        </div>
                    )}
                    <button
                        type="button"
                        className={cl("icon-btn")}
                        aria-expanded={open}
                        aria-controls={bodyId}
                        aria-label={open ? "Hide preview" : "Show preview"}
                        title={open ? "Hide preview" : "Show preview"}
                        onClick={() => setOpen(o => !o)}
                    >
                        <Chevron open={open} />
                    </button>
                </div>
            </div>
            <div id={bodyId} className={cl("preview-body")} hidden={!open}>
                {open && (empty
                    ? (
                        <div className={cl("notice")}>
                            <div className={cl("notice-title")}>{empty.title}</div>
                            <div className={cl("notice-hint")}>{empty.hint}</div>
                        </div>
                    )
                    : (
                        <>
                            <MemberRow p={p} />
                            <ActivityCard p={p} live={live} track={track ?? SAMPLE_TRACK} look={state} />
                        </>
                    ))}
            </div>
        </div>
    );
}
