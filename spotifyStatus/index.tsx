/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Button } from "@components/Button";
import { ErrorCard } from "@components/ErrorCard";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { SpotifyStore } from "@plugins/spotifyControls/SpotifyStore";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ApplicationAssetUtils, FluxDispatcher, React, RestAPI } from "@webpack/common";

const SpotifyAPI = findByPropsLazy("vcSpotifyMarker");
const SpotifySocket = findByPropsLazy("getActiveSocketAndDevice");

import "./styles.css";

import { BulkImport } from "./BulkImport";
import { IconPicker } from "./IconPicker";
import { ListEditor } from "./ListEditor";
import {
    activityTimestamps, advanceTrack, buildActivityText, buildLargeImageText, clearStep, decideOutput, defaultUpdates, isSameStatus,
    type LiveStatus, parsePool, statusAction, type StatusText, type Track
} from "./output";
import { PreviewCard } from "./PreviewCard";
import { Section } from "./Section";
import { SourceConfig } from "./SourceConfig";
import { type FontStyle } from "./unicodeFonts";

const logger = new Logger("SpotifyStatus", "#1db954");
const Native = VencordNative.pluginHelpers.SpotifyStatus as PluginNative<typeof import("./native")>;

// Same public app id and Last.fm API key as Vencord's own MusicRichPresence plugin (src/plugins/musicRichPresence).
const ASSET_APP_ID = "1108588077900898414";
const LASTFM_PUBLIC_API_KEY = "790c37d90400163a5a5fe00d6ca32ef0";
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

// -------- option lists --------
const SOURCE_OPTIONS = [
    { label: "Spotify (your Discord connection)", value: "spotify", default: true },
    { label: "Windows media controls (any app, Windows only)", value: "smtc" },
    { label: "Last.fm", value: "lastfm" },
];

const FILTER_MODES = [
    { label: "Off", value: "off", default: true },
    { label: "Only show these (whitelist)", value: "whitelist" },
    { label: "Hide these (blacklist)", value: "blacklist" },
];

const FONT_OPTIONS: { label: string; value: FontStyle; default?: boolean; }[] = [
    { label: "Normal", value: "none", default: true },
    { label: "Bold (𝐁𝐨𝐥𝐝)", value: "bold" },
    { label: "Italic (𝐼𝑡𝑎𝑙𝑖𝑐)", value: "italic" },
    { label: "Bold italic (𝑩𝒐𝒍𝒅)", value: "boldItalic" },
    { label: "Script (𝒮𝒸𝓇𝒾𝓅𝓉)", value: "script" },
    { label: "Bold script (𝓑𝓸𝓵𝓭)", value: "boldScript" },
    { label: "Fraktur (𝔉𝔯𝔞𝔨𝔱𝔲𝔯)", value: "fraktur" },
    { label: "Double-struck (𝔻𝕠𝕦𝕓𝕝𝕖)", value: "doubleStruck" },
    { label: "Monospace (𝙼𝚘𝚗𝚘)", value: "monospace" },
    { label: "Small caps (sᴍᴀʟʟ)", value: "smallCaps" },
    { label: "Fullwidth (Ｆｕｌｌ)", value: "fullwidth" },
    { label: "Circled (ⒸⒾⓇ)", value: "circled" },
    { label: "Squared (🅂🅀🅄)", value: "squared" },
];

const ACTIVITY_TYPES = [
    { label: "Listening to", value: "listening", default: true },
    { label: "Playing", value: "playing" },
    { label: "Watching", value: "watching" },
    { label: "Competing in", value: "competing" },
    { label: "Streaming", value: "streaming" },
    { label: "Hang status", value: "hang" },
];

const TIMESTAMP_MODES = [
    { label: "Song progress, with a progress bar", value: "track", default: true },
    { label: "Time into the song, no bar", value: "trackElapsed" },
    { label: "Time since the plugin started", value: "session" },
    { label: "Time since midnight", value: "today" },
    { label: "None", value: "off" },
];

// ---------------- settings ----------------

function d(...args: any[]) {
    if (settings.store.debug) logger.debug(...args);
}

function restart(reason: string) {
    if (!running) return; // settings can change while the plugin is disabled
    logger.info(`Restarting source '${settings.store.source}' (reason: ${reason})`);
    teardownSource();
    setupSource();
    void update();
}

export const settings = definePluginSettings({
    // Live preview: sticks to the top of this settings page while you scroll.
    _preview: { type: OptionType.COMPONENT, component: () => <PreviewCard /> },

    // ═══ SOURCE & OUTPUT ═══
    _section_source: { type: OptionType.COMPONENT, component: () => <Section title="Source and output" subtitle="Where the song comes from, and where it shows up" /> },
    source: {
        type: OptionType.SELECT,
        description: "Where to get the song you're playing",
        options: SOURCE_OPTIONS,
        onChange: () => restart("source changed"),
    },
    updateCustomStatus: {
        type: OptionType.BOOLEAN,
        description: "Show the song in your custom status (the text under your name)",
        default: true,
        onChange: v => { if (!v) void clearCustomStatusIfOurs(); else void update(); },
    },
    updateActivity: {
        type: OptionType.BOOLEAN,
        description: "Show the song as a rich presence activity on your profile",
        default: false,
        onChange: v => { if (!v) setActivity(null); else void update(); },
    },
    _sourceConfig: {
        type: OptionType.COMPONENT,
        component: () => <SourceConfig settings={settings} restart={restart} />,
    },
    pollSeconds: { type: OptionType.NUMBER, default: 5, hidden: true, description: "" },
    lastfmUsername: { type: OptionType.STRING, default: "", hidden: true, description: "" },
    lastfmApiKey: { type: OptionType.STRING, default: "", hidden: true, description: "" },

    // ═══ FORMAT ═══
    _section_format: { type: OptionType.COMPONENT, component: () => <Section title="Format" subtitle="How the song turns into status text" /> },
    template: {
        type: OptionType.STRING,
        description: "Status text while playing. You can use {song} {artist} {album} {position} {duration} {icon}",
        default: "{icon} {song} - {artist}",
    },
    pausedTemplate: {
        type: OptionType.STRING,
        description: "Status text while paused. Only used when \"Clear the status when you pause\" is off. Leave it empty to clear the status on pause",
        default: "",
    },
    stripParens: {
        type: OptionType.BOOLEAN,
        description: "Remove parts in brackets from song names, so \"Song (Remastered)\" becomes \"Song\"",
        default: false,
    },
    fontStyle: {
        type: OptionType.SELECT,
        description: "Letter style for the custom status. Rich presence always uses plain letters",
        options: FONT_OPTIONS,
    },

    // ═══ ICONS & EMOJIS ═══
    _section_icons: { type: OptionType.COMPONENT, component: () => <Section title="Icons and emoji" subtitle="The {icon} placeholder and the status emoji" /> },
    _iconPicker: { type: OptionType.COMPONENT, component: () => <IconPicker /> },
    iconPool: {
        type: OptionType.STRING,
        description: "Icons for {icon}, separated by spaces or commas, for example ♪ ♫ 🎵. See below for when a new one is picked",
        default: "♪",
    },
    iconRandomizeEvery: {
        type: OptionType.SELECT,
        description: "When to pick a new {icon}",
        options: [
            { label: "Every new song", value: "track", default: true },
            { label: "Every update", value: "update" },
            { label: "Never (always the first one)", value: "never" },
        ],
    },
    emoji: {
        type: OptionType.STRING,
        description: "Emoji shown before the status text. Not used when random emoji is on",
        default: "🎵",
    },
    emojiRandomize: {
        type: OptionType.BOOLEAN,
        description: "Pick a random emoji from the list below for each new song",
        default: false,
    },
    emojiPool: {
        type: OptionType.STRING,
        description: "Emoji to pick from, separated by spaces or commas",
        default: "🎵 🎶 🎧 🎼 ♪ ♫",
    },

    // ═══ RICH PRESENCE (ACTIVITY) ═══
    _section_activity: { type: OptionType.COMPONENT, component: () => <Section title="Rich presence" subtitle="Each line is a template with the same placeholders as the status. Leave a line empty to hide it." /> },
    activityType: {
        type: OptionType.SELECT,
        description: "What the activity says you're doing",
        options: ACTIVITY_TYPES,
    },
    activityName: {
        type: OptionType.STRING,
        description: "Top line of the activity. Avoid \"Spotify\" here, or Discord mixes it up with its own Spotify activity",
        default: "Music",
    },
    activityDetails: {
        type: OptionType.STRING,
        description: "Second line",
        default: "{song}",
    },
    activityState: {
        type: OptionType.STRING,
        description: "Third line",
        default: "by {artist}",
    },
    activityStatusDisplay: {
        type: OptionType.SELECT,
        description: "Which line shows next to your name in the member list",
        options: [
            { label: "Top line", value: "name", default: true },
            { label: "Second line", value: "details" },
            { label: "Third line", value: "state" },
        ],
    },
    largeImageSource: {
        type: OptionType.SELECT,
        description: "The activity's big picture",
        options: [
            { label: "Album cover (Spotify and Last.fm)", value: "art", default: true },
            { label: "Artist picture (Spotify only, needs the SpotifyControls plugin)", value: "artist" },
            { label: "Image link", value: "custom" },
            { label: "None", value: "none" },
        ],
        onChange: () => void update(),
    },
    largeImageCustomUrl: {
        type: OptionType.STRING,
        description: "Link to the picture (http or https), used when the big picture is set to \"Image link\"",
        default: "",
    },
    largeImageText: {
        type: OptionType.STRING,
        description: "Text shown when someone hovers the picture. Same placeholders. Leave it empty for the album name",
        default: "{album}",
    },
    timestampMode: {
        type: OptionType.SELECT,
        description: "The time shown on the activity",
        options: TIMESTAMP_MODES,
        onChange: () => void update(),
    },

    // ═══ FILTERS ═══
    _section_filters: { type: OptionType.COMPONENT, component: () => <Section title="Filters" subtitle="Hide some artists or songs, or show only those" /> },
    artistFilterMode: {
        type: OptionType.SELECT,
        description: "Artist list",
        options: FILTER_MODES,
    },
    songFilterMode: {
        type: OptionType.SELECT,
        description: "Song list",
        options: FILTER_MODES,
    },
    lists: {
        type: OptionType.COMPONENT,
        component: () => <FiltersUI />,
    },
    artistList: { type: OptionType.CUSTOM, default: [] as string[] },
    songList: { type: OptionType.CUSTOM, default: [] as string[] },

    // ═══ TIMING ═══
    _section_timing: { type: OptionType.COMPONENT, component: () => <Section title="Timing" /> },
    tickTime: {
        type: OptionType.BOOLEAN,
        description: "Update every second. Only needed if you use {position} or {duration}",
        default: false,
    },
    customStatusThrottleSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds to wait between custom status changes. Discord limits how often it can change, so keep this at 8 or more if you use {position} or {duration}",
        default: 10,
    },
    clearOnPause: {
        type: OptionType.BOOLEAN,
        description: "Clear the status when you pause",
        default: true,
    },
    restoreOnStop: {
        type: OptionType.BOOLEAN,
        description: "When you turn the plugin off, put back the custom status you had before. Off just clears the song. Skipped if you changed your status since",
        default: false,
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log details to the console (filter it by SpotifyStatus)",
        default: false,
    },
});

// ---------------- runtime ----------------

/** Text of the custom status this plugin last set and that's still showing (null = nothing of ours to clear). */
let lastSetCustomText: string | null = null;
let lastSetEmoji = "";
let lastCustomStatusAt = 0;
let pendingCustomText: { text: string; emoji: string; } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let restoreCustomStatus: any = null;
let hasRestoreSnapshot = false;
/** True once this plugin has written the custom status (set or cleared it); only then may stop() touch it. */
let ownsStatus = false;
/** True between a finished start() and stop(). */
let running = false;
/** Bumped by start() and stop(), so a start() still awaiting its snapshot after a stop() does nothing. */
let runId = 0;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let spotifyListenerActive = false;
const assetCache = new Map<string, string>();
let sessionStart = Date.now();
let lastTrackKey = "";
let currentIcon = "";
let currentEmoji = "";
let warnedShowCurrentGame = false;
const artistImageCache = new Map<string, string>();
let currentArtistId = "";
/** Last SMTC read, so the 1 s ticker can extrapolate {position} instead of spawning PowerShell every second. */
let smtcLast: { track: Track; at: number; } | null = null;
let warnedSmtcUnsupported = false;
/** True while SMTC reads keep failing; the failure is logged once per streak, not on every poll. */
let smtcFailing = false;
let warnedNoSpotifyControls = false;
/** The last track update() read and when, for the settings preview. Null while nothing plays or the plugin is off. */
let lastSeen: { track: Track; at: number; } | null = null;

/**
 * What the settings preview reads on each render: the current track (its position moved on while it
 * plays), the current {icon} and emoji picks, the session start and the image caches. Cheap, and never
 * fetches anything.
 */
export function getLiveState() {
    const now = Date.now();
    const track = running && lastSeen ? advanceTrack(lastSeen.track, lastSeen.at, now) : null;
    return {
        running,
        track,
        icon: currentIcon,
        emoji: currentEmoji,
        sessionStart,
        now,
        /** Discord's asset id for an image URL the activity already uses ("mp:external/..."), else null. */
        assetId: (url: string) => assetCache.get(url) ?? null,
        /** An artist's cached picture: undefined when not looked up yet, "" when there is none. */
        artistImage: (artistId: string) => artistImageCache.get(artistId),
        spotifyControls: isPluginEnabled("SpotifyControls"),
    };
}

async function fetchSpotifyArtistImage(artistId: string): Promise<string | null> {
    if (!artistId) return null;
    if (artistImageCache.has(artistId)) return artistImageCache.get(artistId) || null;
    // Discord's Spotify API helper (vcSpotifyMarker) only exists once SpotifyControls has patched it.
    if (!isPluginEnabled("SpotifyControls")) {
        if (!warnedNoSpotifyControls) logger.warn("\"Artist picture\" needs the SpotifyControls plugin, so the activity has no picture.");
        warnedNoSpotifyControls = true;
        return null;
    }
    try {
        const sad = (SpotifySocket as any).getActiveSocketAndDevice?.();
        const socket = sad?.socket;
        if (!socket?.accountId || !socket?.accessToken) { d("artist image: no active Spotify socket"); return null; }
        const res: any = await (SpotifyAPI as any).get(socket.accountId, socket.accessToken, {
            url: `https://api.spotify.com/v1/artists/${artistId}`,
        });
        const url = res?.body?.images?.[0]?.url || "";
        artistImageCache.set(artistId, url);
        if (artistImageCache.size > 100) {
            const first = artistImageCache.keys().next().value;
            if (first !== undefined) artistImageCache.delete(first);
        }
        return url || null;
    } catch (e) {
        logger.warn("fetchSpotifyArtistImage failed", e);
        return null;
    }
}

function pickRandom<T>(xs: T[], fallback: T): T {
    if (!xs.length) return fallback;
    return xs[Math.floor(Math.random() * xs.length)];
}

function rollIconIfNeeded(trackKey: string) {
    const mode = settings.store.iconRandomizeEvery;
    const pool = parsePool(settings.store.iconPool);
    if (!pool.length) { currentIcon = ""; return; }
    if (mode === "update") currentIcon = pickRandom(pool, pool[0]);
    else if (mode === "track") {
        if (trackKey !== lastTrackKey || !currentIcon) currentIcon = pickRandom(pool, pool[0]);
    } else {
        if (!currentIcon) currentIcon = pool[0];
    }
}

function rollEmojiIfNeeded(trackKey: string) {
    if (!settings.store.emojiRandomize) { currentEmoji = settings.store.emoji; return; }
    const pool = parsePool(settings.store.emojiPool);
    if (!pool.length) { currentEmoji = settings.store.emoji; return; }
    if (trackKey !== lastTrackKey || !currentEmoji) currentEmoji = pickRandom(pool, pool[0]);
}

function activityTypeEnum(): number {
    switch (settings.store.activityType) {
        case "playing": return ActivityType.PLAYING;
        case "watching": return ActivityType.WATCHING;
        case "competing": return ActivityType.COMPETING;
        case "streaming": return ActivityType.STREAMING;
        case "hang": return ActivityType.HANG_STATUS;
        default: return ActivityType.LISTENING;
    }
}

function statusDisplayTypeEnum(): number {
    switch (settings.store.activityStatusDisplay) {
        case "details": return ActivityStatusDisplayType.DETAILS;
        case "state": return ActivityStatusDisplayType.STATE;
        default: return ActivityStatusDisplayType.NAME;
    }
}

function setActivity(activity: any | null) {
    d("setActivity →", activity);
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: "SpotifyStatus" });
}

// ---------------- custom status ownership ----------------
// The plugin only ever clears or restores a status it set itself. What it last wrote is kept in
// DataStore too, so after a Discord reload it can still clean up its own song status.

const SETTINGS_URL = "/users/@me/settings";
const OWNERSHIP_KEY = "SpotifyStatus_statusOwnership";

interface Ownership { expected: StatusText; restore: any; hasRestore: boolean; }

// Every custom-status read/write runs through this queue, one at a time and in order, so a clear can't
// overtake a set that's still on the wire and the bookkeeping always matches the last write.
let statusQueue: Promise<unknown> = Promise.resolve();
function queueStatusOp<T>(op: () => Promise<T>): Promise<T> {
    const run = statusQueue.then(op);
    statusQueue = run.catch(() => { });
    return run;
}

/** What the live status should be if nobody but this plugin changed it since its last write. */
function expectedStatus(): StatusText {
    return lastSetCustomText === null ? { text: "", emoji: "" } : { text: lastSetCustomText, emoji: lastSetEmoji };
}

// isSameStatus, clearStep and LiveStatus live in output.ts (pure, covered by _dev/check-preview.ts).

/** GET the live custom status; { ok: false } on error or after 5 s, so start()/stop() can't hang on it. */
function fetchLiveStatus(): Promise<LiveStatus> {
    const read = (async (): Promise<LiveStatus> => {
        try {
            const res: any = await RestAPI.get({ url: SETTINGS_URL });
            return { ok: true, status: res?.body?.custom_status ?? null };
        } catch (e) {
            logger.warn("Couldn't read the current custom status", e);
            return { ok: false };
        }
    })();
    const timeout = new Promise<LiveStatus>(resolve => setTimeout(() => resolve({ ok: false }), 5000));
    return Promise.race([read, timeout]);
}

function saveOwnership() {
    const write = ownsStatus
        ? DataStore.set(OWNERSHIP_KEY, { expected: expectedStatus(), restore: restoreCustomStatus, hasRestore: hasRestoreSnapshot } satisfies Ownership)
        : DataStore.del(OWNERSHIP_KEY);
    write.catch(e => logger.warn("Couldn't save custom status ownership", e));
}

/** On start: snapshot the status for restoreOnStop, or re-adopt the status this plugin set before a reload. */
function initStatusOwnership() {
    return queueStatusOp(async () => {
        const [live, saved] = await Promise.all([
            fetchLiveStatus(),
            DataStore.get<Ownership>(OWNERSHIP_KEY).catch(() => undefined),
        ]);
        if (saved?.expected && (!live.ok || isSameStatus(live.status, saved.expected))) {
            // Discord was reloaded or closed while the plugin owned the status: carry on from there.
            const { text, emoji } = saved.expected;
            ownsStatus = true;
            lastSetCustomText = text || emoji ? text : null;
            lastSetEmoji = emoji;
            restoreCustomStatus = saved.restore ?? null;
            hasRestoreSnapshot = !!saved.hasRestore;
            d("re-adopted our custom status after a reload", saved);
        } else {
            ownsStatus = false;
            lastSetCustomText = null;
            lastSetEmoji = "";
            restoreCustomStatus = live.ok ? live.status : null;
            hasRestoreSnapshot = live.ok;
            if (saved) saveOwnership(); // stale record: the status was changed since, so drop it
        }
    });
}

function doPatchCustomStatus(text: string, emojiName: string) {
    queuedClear = null; // a clear asked for after this set must run after it, not merge into an earlier one
    return queueStatusOp(async () => {
        if (!running) return; // queued just before stop()
        const payload = text || emojiName
            ? { text: text || null, emoji_id: null, emoji_name: emojiName || null, expires_at: null }
            : null;
        // An empty status would clear whatever is showing: only ever do that to a status the plugin set.
        if (!payload && lastSetCustomText === null) return;
        d("PATCH /users/@me/settings custom_status=", payload);
        try {
            const res: any = await RestAPI.patch({ url: SETTINGS_URL, body: { custom_status: payload } });
            d("PATCH ← status", res?.status);
            lastSetCustomText = text;
            lastSetEmoji = emojiName;
            lastCustomStatusAt = Date.now();
            ownsStatus = true;
            saveOwnership();
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                const retry = Number(e?.body?.retry_after ?? e?.retry_after ?? 5);
                logger.warn(`Discord is rate limiting custom status changes. Waiting about ${retry}s. Raising "Seconds to wait between custom status changes" helps.`);
                lastCustomStatusAt = Date.now() + retry * 1000;
            } else {
                logger.error("Failed to set custom status", e);
            }
        }
    });
}

function flushPending() {
    if (!pendingCustomText) return;
    const p = pendingCustomText;
    pendingCustomText = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    void doPatchCustomStatus(p.text, p.emoji);
}

function scheduleCustomStatus(text: string, emojiName: string) {
    pendingCustomText = { text, emoji: emojiName };
    const throttle = Math.max(2, (settings.store.customStatusThrottleSeconds | 0) || 10) * 1000;
    const elapsed = Date.now() - lastCustomStatusAt;
    if (elapsed >= throttle) flushPending();
    else {
        const wait = throttle - elapsed;
        d(`throttled, sending in ${wait}ms`);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => { flushTimer = null; flushPending(); }, wait);
    }
}

function cancelPendingStatus() {
    pendingCustomText = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

/** A clear already waiting in the status queue: repeated updates reuse it instead of piling up status reads. */
let queuedClear: Promise<void> | null = null;

/**
 * Clears the custom status, but only the plugin's own: if nothing of ours is showing it does nothing,
 * and it reads the live status first, so a status you set by hand mid-session is left alone (the
 * plugin just stops treating it as its own).
 */
function clearCustomStatusIfOurs(): Promise<void> {
    // Drop a throttled set first, or it would put the song back after this clear (e.g. skip, then pause).
    cancelPendingStatus();
    if (queuedClear) return queuedClear;
    const run = queueStatusOp(async () => {
        queuedClear = null; // from here on, a new request queues a fresh check
        if (lastSetCustomText === null) return;
        const step = clearStep(await fetchLiveStatus(), expectedStatus());
        // Couldn't read the live status: keep it recorded as ours so the next update (or disable) retries.
        if (step === "retry") return;
        if (step === "clear") {
            try {
                await RestAPI.patch({ url: SETTINGS_URL, body: { custom_status: null } });
            } catch (e) {
                // The song is still showing: keep it recorded as ours so the next update (or disable) retries.
                logger.error("clear failed", e);
                return;
            }
        } else {
            logger.info("Your custom status was changed outside the plugin, so it's left as it is");
        }
        lastSetCustomText = null;
        lastSetEmoji = "";
        saveOwnership();
    });
    queuedClear = run;
    return run;
}

/** On disable: undo only what this plugin did, and only while the status is still what it last wrote. */
function releaseStatus() {
    return queueStatusOp(async () => {
        try {
            if (!ownsStatus) return; // the plugin never touched the status: leave the user's own alone
            const live = await fetchLiveStatus();
            if (live.ok && !isSameStatus(live.status, expectedStatus())) {
                logger.info("Custom status was changed outside the plugin; leaving it as is");
                return;
            }
            if (settings.store.restoreOnStop && hasRestoreSnapshot) {
                await RestAPI.patch({ url: SETTINGS_URL, body: { custom_status: restoreCustomStatus ?? null } });
            } else if (lastSetCustomText !== null) {
                await RestAPI.patch({ url: SETTINGS_URL, body: { custom_status: null } });
            }
        } catch (e) {
            logger.error("Couldn't clear or restore the custom status", e);
        } finally {
            lastSetCustomText = null;
            lastSetEmoji = "";
            ownsStatus = false;
            restoreCustomStatus = null;
            hasRestoreSnapshot = false;
            saveOwnership(); // removes the record
        }
    });
}

async function resolveAssetId(imageUrl: string): Promise<string | null> {
    if (!imageUrl) return null;
    const cached = assetCache.get(imageUrl);
    if (cached) return cached;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(ASSET_APP_ID, [imageUrl]);
        const id = ids?.[0];
        if (id) {
            assetCache.set(imageUrl, id);
            if (assetCache.size > 50) {
                const first = assetCache.keys().next().value;
                if (first !== undefined) assetCache.delete(first);
            }
            return id;
        }
    } catch (e) { logger.warn("fetchAssetIds failed", imageUrl, e); }
    return null;
}

// ---------------- track sources ----------------

async function getTrack(fromTicker: boolean): Promise<Track | null> {
    const src = settings.store.source;
    if (src === "spotify") return trackFromSpotify();
    if (src === "smtc") return trackFromSmtc(fromTicker);
    if (src === "lastfm") return trackFromLastfm();
    return null;
}

function trackFromSpotify(): Track | null {
    const t = SpotifyStore.track;
    if (!t) return null;
    return {
        id: t.id,
        name: t.name,
        artists: t.artists.map(a => a.name),
        artistIds: t.artists.map(a => a.id).filter(Boolean),
        album: t.album?.name ?? "",
        uri: `spotify:track:${t.id}`,
        position: SpotifyStore.position,
        duration: t.duration,
        isPlaying: SpotifyStore.isPlaying,
        imageUrl: t.album?.image?.url ?? "",
    };
}

async function trackFromSmtc(fromTicker: boolean): Promise<Track | null> {
    // The 1 s ticker only needs a fresh {position}: extrapolate it from the last read instead of
    // starting another PowerShell every second. The regular poll still re-reads SMTC.
    if (fromTicker && smtcLast) {
        const { track, at } = smtcLast;
        if (!track.isPlaying) return track;
        const position = track.position + (Date.now() - at);
        return { ...track, position: track.duration > 0 ? Math.min(position, track.duration) : position };
    }
    const reportFailure = (...args: any[]) => {
        if (!smtcFailing) logger.warn("Reading Windows media controls keeps failing (logged once until it works again):", ...args);
        smtcFailing = true;
    };
    const r = await Native.fetchSmtc().catch(e => { reportFailure("fetchSmtc threw", e); return null; });
    if (!r) { smtcLast = null; return null; }
    if (r.reason === "unsupported") {
        if (!warnedSmtcUnsupported) logger.warn("Windows media controls only work on Windows. Pick another source.");
        warnedSmtcUnsupported = true;
        smtcLast = null;
        return null;
    }
    if (!r.ok && r.reason !== "no-session") { reportFailure(r.error); smtcLast = null; return null; }
    smtcFailing = false; // PowerShell ran fine ("no-session" just means nothing is playing)
    if (!r.ok || !r.title) { smtcLast = null; return null; }
    const track: Track = {
        id: `${r.appId}:${r.title}:${r.artist}`,
        name: r.title,
        artists: r.artist ? [r.artist] : [],
        artistIds: [],
        album: r.album,
        uri: "",
        position: r.position,
        duration: r.duration,
        isPlaying: r.isPlaying,
        imageUrl: "",
    };
    smtcLast = { track, at: Date.now() };
    return track;
}

async function trackFromLastfm(): Promise<Track | null> {
    const username = settings.store.lastfmUsername?.trim();
    if (!username) return null;
    const apiKey = settings.store.lastfmApiKey?.trim() || LASTFM_PUBLIC_API_KEY;
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&api_key=${encodeURIComponent(apiKey)}&user=${encodeURIComponent(username)}&limit=1&format=json`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        const t = json?.recenttracks?.track?.[0];
        if (!t || !t["@attr"]?.nowplaying) return null;
        const images = t.image as Array<{ size: string; "#text": string; }> | undefined;
        const rawImage = images?.find(i => i.size === "extralarge")?.["#text"]
            || images?.find(i => i.size === "large")?.["#text"]
            || "";
        const image = rawImage && !rawImage.includes("2a96cbd8b46e442fc41c2b86b821562f") ? rawImage : "";
        return {
            id: `${t.artist?.["#text"]}:${t.name}`,
            name: String(t.name ?? ""),
            artists: t.artist?.["#text"] ? [String(t.artist["#text"])] : [],
            artistIds: [],
            album: String(t.album?.["#text"] ?? ""),
            uri: String(t.url ?? ""),
            position: 0,
            duration: 0,
            isPlaying: true,
            imageUrl: image,
        };
    } catch (e) { logger.error("Last.fm fetch failed", e); return null; }
}

// ---------------- build + dispatch ----------------

// The text itself (status, activity lines, timestamps, filters) is built in output.ts, shared with the settings preview.

async function pushActivity(track: Track) {
    const s = settings.store;
    if (!s.updateActivity) { d("activity disabled"); return; }

    try {
        if (!ShowCurrentGame.getSetting() && !warnedShowCurrentGame) {
            logger.warn("Discord's \"Share your activity\" setting is off, so only you can see the rich presence. The plugin's settings have a button to turn it on.");
            warnedShowCurrentGame = true;
        }
    } catch { /* ignore */ }

    const lines = buildActivityText(s, track, currentIcon);
    const activity: any = {
        application_id: ASSET_APP_ID,
        name: lines.name,
        type: activityTypeEnum(),
        details: lines.details,
        state: lines.state,
        status_display_type: statusDisplayTypeEnum(),
        flags: ActivityFlags.INSTANCE,
    };

    const ts = activityTimestamps(s.timestampMode, track, Date.now(), sessionStart);
    if (ts) activity.timestamps = ts;

    let largeUrl: string | null = null;
    if (s.largeImageSource === "art" && track.imageUrl) {
        largeUrl = track.imageUrl;
    } else if (s.largeImageSource === "artist" && track.artistIds.length) {
        currentArtistId = track.artistIds[0];
        largeUrl = await fetchSpotifyArtistImage(currentArtistId);
    } else if (s.largeImageSource === "custom" && s.largeImageCustomUrl) {
        largeUrl = s.largeImageCustomUrl;
    }
    if (largeUrl) {
        const id = await resolveAssetId(largeUrl);
        if (id) {
            activity.assets = { large_image: id, large_text: buildLargeImageText(s, track, currentIcon) };
        }
    }

    // Drop empty fields: Discord hides activities that have empty strings.
    for (const k of Object.keys(activity)) {
        if (k === "type") continue;
        const v = (activity as any)[k];
        if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) delete (activity as any)[k];
    }

    if (!running) return; // disabled while the image lookups were in flight
    setActivity(activity);
}

async function update(fromTicker?: boolean) {
    if (!running) return;
    try {
        const track = await getTrack(fromTicker === true);
        if (!running) return; // disabled while the track was being read
        lastSeen = track ? { track, at: Date.now() } : null;
        if (!track) {
            void clearCustomStatusIfOurs();
            setActivity(null);
            stopTicker();
            return;
        }

        const trackKey = track.id || `${track.name}::${track.artists.join(",")}`;
        rollIconIfNeeded(trackKey);
        rollEmojiIfNeeded(trackKey);
        lastTrackKey = trackKey;

        const s = settings.store;
        const paused = !track.isPlaying;
        // Filtered out, cleared while paused, or an empty template: show nothing (the same rule the preview uses).
        const decision = decideOutput(s, track, paused, currentIcon);
        if (!decision.show) {
            void clearCustomStatusIfOurs();
            setActivity(null);
            if (decision.reason !== "noTemplate") stopTicker();
            return;
        }
        const { text } = decision;

        if (s.updateCustomStatus) {
            const action = statusAction(text, currentEmoji, lastSetCustomText);
            if (action === "set") scheduleCustomStatus(text, currentEmoji);
            // Nothing to show: never sent as an empty status, which would wipe a status you set yourself.
            else if (action === "clear") void clearCustomStatusIfOurs();
        }
        void pushActivity(track);

        if (s.tickTime && !paused && track.duration > 0) startTicker();
        else stopTicker();
    } catch (e) { logger.error("update() threw", e); }
}

const onSpotifyChange = () => void update();

function startTicker() { if (!tickInterval) tickInterval = setInterval(() => void update(true), 1000); }
function stopTicker() { if (tickInterval) { clearInterval(tickInterval); tickInterval = null; } }
function startPolling() {
    stopPolling();
    const sec = Math.max(2, (settings.store.pollSeconds | 0) || 5);
    logger.info(`Polling ${settings.store.source} every ${sec}s`);
    pollInterval = setInterval(() => void update(), sec * 1000);
}
function stopPolling() { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } }

function setupSource() {
    const src = settings.store.source;
    logger.info("setupSource", src);
    if (src === "spotify") {
        try { SpotifyStore.addChangeListener(onSpotifyChange); spotifyListenerActive = true; }
        catch (e) { logger.error("Couldn't listen to Spotify. Is Spotify connected in Discord?", e); }
    } else startPolling();
}
function teardownSource() {
    if (spotifyListenerActive) { try { SpotifyStore.removeChangeListener(onSpotifyChange); } catch { /* ignore */ } spotifyListenerActive = false; }
    stopPolling(); stopTicker();
    lastSeen = null; // the preview falls back to the sample until the next read
    smtcLast = null;
    smtcFailing = false;
}

function FiltersUI() {
    const [, force] = React.useState(0);
    const bump = () => force(x => x + 1);
    settings.use(["artistList", "songList"]);
    return (
        <div className="vc-sps-filters">
            <ListEditor
                title="Artists"
                description="Artist names. Capital letters don't matter."
                placeholder="Radiohead"
                list={settings.store.artistList}
            />
            <BulkImport kind="artist" list={settings.store.artistList} onChanged={bump} />
            <ListEditor
                title="Songs"
                description="Song names, or Spotify URIs like spotify:track:63OQupATfueTdZMWTxW03A"
                placeholder="Karma Police"
                list={settings.store.songList}
            />
            <BulkImport kind="song" list={settings.store.songList} onChanged={bump} />
        </div>
    );
}

function ActivitySharingNotice() {
    const enabled = ShowCurrentGame.useSetting();
    const { updateActivity } = settings.use(["updateActivity"]);
    // Only matters for rich presence; the custom status shows either way.
    if (enabled || !updateActivity) return null;
    return (
        <ErrorCard className={Margins.bottom16} style={{ padding: "1em" }}>
            <Heading tag="h5">Others can't see your rich presence</Heading>
            <Paragraph>
                Discord's <strong>Share your activity</strong> setting (in Activity Privacy) is off, so only you
                can see the activity. Your custom status isn't affected.
            </Paragraph>
            <Button className={Margins.top8} onClick={() => ShowCurrentGame.updateSetting(true)}>
                Turn on activity sharing
            </Button>
        </ErrorCard>
    );
}

export default definePlugin({
    name: "SpotifyStatus",
    description: "Shows the song you're playing in your custom status and as a rich presence activity. Works with Spotify, Windows media controls or Last.fm.",
    authors: [{ name: "3xyy", id: 596844241058267168n }],
    dependencies: ["UserSettingsAPI"],
    settings,
    settingsAboutComponent: ActivitySharingNotice,

    async start() {
        const id = ++runId;
        logger.info(`Starting, source: ${settings.store.source}`);
        // A setting still on an old shipped default (exact match) moves to the new default; customised ones stay.
        const updates = defaultUpdates(settings.store as unknown as Record<string, unknown>);
        if (Object.keys(updates).length) {
            Object.assign(settings.store, updates);
            logger.info("Moved settings from an old default to the new one:", Object.keys(updates).join(", "));
        }
        sessionStart = Date.now();
        currentIcon = "";
        currentEmoji = settings.store.emoji;
        // Snapshot (or re-adopt) the status before the first write, so the snapshot is never our own song.
        await initStatusOwnership();
        if (id !== runId) return; // disabled again while the snapshot was loading
        running = true;
        setupSource();
        void update();
    },

    stop() {
        logger.info("Stopping");
        running = false;
        runId++;
        teardownSource();
        cancelPendingStatus();
        setActivity(null);
        void releaseStatus();
        assetCache.clear();
    },
});
