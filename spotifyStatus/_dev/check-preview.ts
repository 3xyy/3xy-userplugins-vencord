/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run: pnpm exec tsx src/userplugins/spotifyStatus/_dev/check-preview.ts

import assert from "node:assert/strict";

import { DISCORD_TEXT_LIMIT } from "../format";
import { activityTimestamps, advanceTrack, buildStatusText, clearStep, decideOutput, defaultUpdates, isSameStatus, statusAction } from "../output";
import { buildPreview, type ImageLookups, previewImage, type PreviewSettings, SAMPLE_TRACK, type Track } from "../preview";
import { applyFont } from "../unicodeFonts";

const base: PreviewSettings = {
    updateCustomStatus: true,
    updateActivity: true,
    template: "{icon} {song} - {artist}",
    pausedTemplate: "",
    stripParens: false,
    fontStyle: "none",
    iconPool: "♪ ♫",
    emoji: "🎵",
    emojiRandomize: false,
    emojiPool: "🎶 🎧",
    activityType: "listening",
    activityName: "Music",
    activityDetails: "{song}",
    activityState: "by {artist}",
    timestampMode: "track",
    clearOnPause: false,
    artistFilterMode: "off",
    artistList: [],
    songFilterMode: "off",
    songList: [],
};
const s = (over: Partial<PreviewSettings>): PreviewSettings => ({ ...base, ...over });

const track: Track = {
    id: "abc123",
    name: "Karma Police (Remastered)",
    artists: ["Radiohead"],
    artistIds: ["r1"],
    album: "OK Computer",
    uri: "spotify:track:abc123",
    position: 83_000,
    duration: 201_000,
    isPlaying: true,
    imageUrl: "",
};
const NOW = 1_700_000_000_000;
const live = { now: NOW, sessionStart: NOW };

// ---- brief cases ----

// 1. no track: the sample track is used, and the text is built from it
{
    const p = buildPreview(base, null, false, live);
    assert.equal(p.usingSample, true);
    assert.equal(p.filteredOut, false);
    assert.equal(p.customStatus?.text, `♪ ${SAMPLE_TRACK.name} - ${SAMPLE_TRACK.artists.join(", ")}`);
    assert.equal(p.activity?.details, SAMPLE_TRACK.name);
    assert.equal(p.activity?.state, `by ${SAMPLE_TRACK.artists.join(", ")}`);
    // a real track is not a sample
    const q = buildPreview(base, track, false, live);
    assert.equal(q.usingSample, false);
    assert.equal(q.customStatus?.text, "♪ Karma Police (Remastered) - Radiohead");
}

// 2. a 300-character title is capped at 128 UTF-16 units, like the real output
{
    const long: Track = { ...track, name: "x".repeat(300) };
    for (const fontStyle of ["none", "bold", "fullwidth", "smallCaps"]) {
        const p = buildPreview(s({ fontStyle }), long, false, live);
        assert.ok(p.customStatus, `custom status for font ${fontStyle}`);
        assert.ok(p.customStatus.text.length <= 128, `custom status <= 128 units (${fontStyle}): ${p.customStatus.text.length}`);
        assert.ok(p.customStatus.text.endsWith("…"), `cut text ends with an ellipsis (${fontStyle})`);
        assert.ok((p.activity?.details.length ?? 0) <= DISCORD_TEXT_LIMIT, `activity details <= 128 units (${fontStyle})`);
    }
    // the sample track is capped the same way
    assert.ok(buildPreview(s({ template: "{song}".repeat(40) }), null, false, live).customStatus!.text.length <= 128);
}

// 3. the font style changes the custom status only, never the activity
{
    const plain = buildPreview(base, track, false, live);
    const bold = buildPreview(s({ fontStyle: "bold" }), track, false, live);
    assert.equal(bold.customStatus?.text, applyFont(plain.customStatus!.text, "bold"));
    assert.notEqual(bold.customStatus?.text, plain.customStatus?.text);
    assert.equal(bold.activity?.name, "Music");
    assert.equal(bold.activity?.details, "Karma Police (Remastered)");
    assert.equal(bold.activity?.state, "by Radiohead");
    assert.deepEqual(bold.activity, plain.activity);
}

// 4. custom status off: no custom status (the activity still shows)
{
    const p = buildPreview(s({ updateCustomStatus: false }), track, false, live);
    assert.equal(p.customStatus, null);
    assert.ok(p.activity);
    // and the other way round
    const q = buildPreview(s({ updateActivity: false }), track, false, live);
    assert.equal(q.activity, null);
    assert.ok(q.customStatus);
}

// 5. a blacklisted artist is filtered out (case-insensitive), and nothing is shown
{
    const p = buildPreview(s({ artistFilterMode: "blacklist", artistList: ["radiohead"] }), track, false, live);
    assert.equal(p.filteredOut, true);
    assert.equal(p.customStatus, null);
    assert.equal(p.activity, null);
    assert.equal(buildPreview(s({ artistFilterMode: "blacklist", artistList: ["Muse"] }), track, false, live).filteredOut, false);
    assert.equal(buildPreview(s({ artistFilterMode: "whitelist", artistList: ["Muse"] }), track, false, live).filteredOut, true);
    assert.equal(buildPreview(s({ songFilterMode: "blacklist", songList: ["spotify:track:abc123"] }), track, false, live).filteredOut, true);
    assert.equal(buildPreview(s({ songFilterMode: "blacklist", songList: ["karma police (remastered)"] }), track, false, live).filteredOut, true);
    // the sample track goes through the filters too
    const sampleArtist = SAMPLE_TRACK.artists[0];
    assert.equal(buildPreview(s({ artistFilterMode: "blacklist", artistList: [sampleArtist] }), null, false, live).filteredOut, true);
}

// 6. paused with an empty paused template: the status is cleared
{
    const p = buildPreview(s({ pausedTemplate: "" }), track, true, live);
    assert.equal(p.customStatus, null);
    assert.equal(p.activity, null);
    assert.equal(p.filteredOut, false);
    // "clear on pause" clears it even with a paused template
    assert.equal(buildPreview(s({ pausedTemplate: "Paused: {song}", clearOnPause: true }), track, true, live).customStatus, null);
    // with a paused template and "clear on pause" off, the paused template is used
    const q = buildPreview(s({ pausedTemplate: "Paused: {song}" }), track, true, live);
    assert.equal(q.customStatus?.text, "Paused: Karma Police (Remastered)");
    // a playing track ignores the paused template
    assert.equal(buildPreview(s({ pausedTemplate: "Paused: {song}" }), track, false, live).customStatus?.text, "♪ Karma Police (Remastered) - Radiohead");
}

// ---- more of the shared output path ----

// an empty playing template clears both, like the real output does
{
    const p = buildPreview(s({ template: "" }), track, false, live);
    assert.equal(p.customStatus, null);
    assert.equal(p.activity, null);
}

// strip parens applies to the status and the activity
{
    const p = buildPreview(s({ stripParens: true }), track, false, live);
    assert.equal(p.customStatus?.text, "♪ Karma Police - Radiohead");
    assert.equal(p.activity?.details, "Karma Police");
}

// a blank activity name falls back to "Music"; blank lines are empty strings
{
    const p = buildPreview(s({ activityName: "", activityDetails: "", activityState: "{album}" }), { ...track, album: "" }, false, live);
    assert.equal(p.activity?.name, "Music");
    assert.equal(p.activity?.details, "");
    assert.equal(p.activity?.state, "");
}

// activity verbs
{
    const label = (activityType: string) => buildPreview(s({ activityType }), track, false, live).activity?.typeLabel;
    assert.equal(label("listening"), "Listening to");
    assert.equal(label("playing"), "Playing");
    assert.equal(label("watching"), "Watching");
    assert.equal(label("competing"), "Competing in");
    assert.equal(label("streaming"), "Streaming");
    assert.equal(label("hang"), "Hang status");
    assert.equal(label("bogus"), "Listening to");
}

// timestamps, per mode
{
    const ts = (timestampMode: string, t: Track = track, l = live) => buildPreview(s({ timestampMode }), t, false, l).activity?.timestamp;
    assert.equal(ts("track"), "1:23 / 3:21");
    assert.equal(ts("track", { ...track, duration: 0 }), null); // nothing to show a bar for
    assert.equal(ts("trackElapsed"), "01:23 elapsed");
    assert.equal(ts("session", track, { now: NOW, sessionStart: NOW - 65_000 }), "01:05 elapsed");
    assert.equal(ts("session", track, { now: NOW, sessionStart: NOW - 3_725_000 }), "1:02:05 elapsed");
    assert.equal(ts("off"), null);
    const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
    const sinceMidnight = NOW - midnight.getTime();
    const today = ts("today")!;
    assert.match(today, /^\d+:\d\d(:\d\d)? elapsed$/);
    assert.equal(activityTimestamps("today", track, NOW, NOW)?.start, NOW - Math.floor(sinceMidnight / 1000) * 1000);
    // the same timestamps the real activity gets
    assert.deepEqual(activityTimestamps("track", track, NOW, NOW), { start: NOW - 83_000, end: NOW - 83_000 + 201_000 });
    assert.deepEqual(activityTimestamps("trackElapsed", track, NOW, NOW), { start: NOW - 83_000 });
    assert.equal(activityTimestamps("off", track, NOW, NOW), undefined);
}

// {icon}: the live pick while it's still in the pool, else the first one; empty pool gives ""
{
    assert.equal(buildPreview(base, track, false, { ...live, icon: "♫" }).customStatus?.text, "♫ Karma Police (Remastered) - Radiohead");
    assert.equal(buildPreview(base, track, false, { ...live, icon: "🎸" }).customStatus?.text, "♪ Karma Police (Remastered) - Radiohead");
    assert.equal(buildPreview(s({ iconPool: "" }), track, false, live).customStatus?.text, " Karma Police (Remastered) - Radiohead");
}

// emoji: the fixed one, or a pool pick when randomising; an empty status with no emoji shows nothing
{
    assert.equal(buildPreview(base, track, false, live).customStatus?.emoji, "🎵");
    assert.equal(buildPreview(s({ emojiRandomize: true }), track, false, live).customStatus?.emoji, "🎶");
    assert.equal(buildPreview(s({ emojiRandomize: true }), track, false, { ...live, emoji: "🎧" }).customStatus?.emoji, "🎧");
    assert.equal(buildPreview(s({ emojiRandomize: true, emojiPool: "" }), track, false, live).customStatus?.emoji, "🎵");
    assert.equal(buildPreview(s({ emoji: "" }), track, false, live).customStatus?.emoji, null);
    assert.equal(buildPreview(s({ template: "{album}", emoji: "" }), { ...track, album: "" }, false, live).customStatus, null);
    assert.deepEqual(buildPreview(s({ template: "{album}" }), { ...track, album: "" }, false, live).customStatus, { emoji: "🎵", text: "" });
}

// the preview text is exactly what the real output builds
{
    const d = decideOutput(s({ fontStyle: "script" }), track, false, "♪");
    assert.ok(d.show);
    assert.equal(d.text, buildStatusText(s({ fontStyle: "script" }), track, false, "♪"));
    assert.equal(buildPreview(s({ fontStyle: "script" }), track, false, live).customStatus?.text, d.text);
    assert.deepEqual(decideOutput(s({ artistFilterMode: "whitelist" }), track, false, "♪"), { show: false, reason: "filtered" });
    assert.deepEqual(decideOutput(base, track, true, "♪"), { show: false, reason: "paused" });
    assert.deepEqual(decideOutput(s({ template: "" }), track, false, "♪"), { show: false, reason: "noTemplate" });
}

// ---- Task 12 (Ruling N13) ----

// hiddenReason: why nothing shows, straight from the real decision
{
    const why = (over: Partial<PreviewSettings>, t: Track | null = track, paused = false) => buildPreview(s(over), t, paused, live).hiddenReason;
    assert.equal(why({}), null);
    assert.equal(why({ artistFilterMode: "blacklist", artistList: ["Radiohead"] }), "filtered");
    assert.equal(why({ pausedTemplate: "" }, track, true), "paused");
    assert.equal(why({ pausedTemplate: "x", clearOnPause: true }, track, true), "paused");
    assert.equal(why({ template: "" }), "noTemplate");
    assert.equal(why({ updateCustomStatus: false, updateActivity: false }), "outputsOff");
    assert.equal(why({ template: "{album}", emoji: "", updateActivity: false }, { ...track, album: "" }), "empty");
    // one output still showing means nothing is hidden
    assert.equal(why({ template: "{album}", emoji: "" }, { ...track, album: "" }), null);
    assert.equal(why({ updateCustomStatus: false }), null);
}

// statusAction: an empty status is never sent (the pre-existing bug: a template that filled to "" with no
// emoji was sent as custom_status null and wiped the user's own status). It goes to the ownership-checked
// clear instead, which does nothing while no status of the plugin's is showing.
{
    assert.equal(statusAction("", "", null), "clear"); // not "set": nothing is sent for it
    assert.equal(statusAction("", "", "♪ Song - Artist"), "clear");
    assert.equal(statusAction("", "", ""), "clear"); // ours was emoji-only (text "")
    assert.equal(statusAction("♪ Song", "🎵", null), "set");
    assert.equal(statusAction("♪ Song", "🎵", "♪ Song"), "keep"); // already showing
    assert.equal(statusAction("♪ Other", "🎵", "♪ Song"), "set");
    assert.equal(statusAction("", "🎵", null), "set"); // an emoji-only status is still a status
    assert.equal(statusAction("", "🎵", ""), "keep");
    // the preview agrees: the same empty result shows no custom status
    assert.equal(buildPreview(s({ template: "{album}", emoji: "" }), { ...track, album: "" }, false, live).customStatus, null);
}

// advanceTrack: a playing track moves on; clamp only when the duration is known
{
    assert.equal(advanceTrack(track, 1000, 4000).position, 86_000);
    assert.equal(advanceTrack({ ...track, position: 200_000 }, 1000, 9000).position, 201_000); // clamped to the end
    assert.equal(advanceTrack({ ...track, duration: 0, position: 0 }, 1000, 6000).position, 5000); // no duration: keeps counting
    assert.equal(advanceTrack({ ...track, isPlaying: false }, 1000, 9000).position, 83_000); // paused: stays put
    assert.equal(advanceTrack(track, 5000, 1000).position, 83_000); // clock stepped back: no negative move
}

// previewImage: what the big picture tile shows, mirroring which image the real activity would get
{
    const none = { kind: "none" };
    const look = (over: Partial<ImageLookups> = {}): ImageLookups => ({
        assetId: () => null, artistImage: () => undefined, spotifyControls: true, ...over
    });
    const img = (largeImageSource: string, t: Track, sample = false, l = look(), source = "spotify", largeImageCustomUrl = "") =>
        previewImage({ source, largeImageSource, largeImageCustomUrl }, t, sample, l);
    const cover = "https://i.scdn.co/image/ab67616d0000b273abc";
    const withCover: Track = { ...track, imageUrl: cover };

    // a URL the plugin already resolved shows through Discord's media proxy (allowed by the CSP)
    assert.deepEqual(img("art", withCover, false, look({ assetId: u => u === cover ? "mp:external/xyz/https/i.scdn.co/image/ab67616d0000b273abc" : null })),
        { kind: "image", src: "https://media.discordapp.net/external/xyz/https/i.scdn.co/image/ab67616d0000b273abc", label: "Cover art" });
    // not resolved yet: a labelled tile, even for Spotify's own CDN (no direct loads; matches what Discord shows)
    assert.deepEqual(img("art", withCover), { kind: "label", label: "Cover art" });
    // any other host isn't loaded raw (the CSP blocks it): a labelled tile instead
    const lastfm = "https://lastfm.freetls.fastly.net/i/u/300x300/abc.jpg";
    assert.deepEqual(img("art", { ...track, imageUrl: lastfm }, false, look(), "lastfm"), { kind: "label", label: "Cover art" });
    // no cover (Windows media controls) means Discord shows no picture, so no tile
    assert.deepEqual(img("art", track, false, look(), "smtc"), none);
    // the sample: a tile where a real song from this source would have a cover
    assert.deepEqual(img("art", SAMPLE_TRACK, true), { kind: "label", label: "Cover art" });
    assert.deepEqual(img("art", SAMPLE_TRACK, true, look(), "lastfm"), { kind: "label", label: "Cover art" });
    assert.deepEqual(img("art", SAMPLE_TRACK, true, look(), "smtc"), none);

    // artist picture: needs artist ids and SpotifyControls; only a cached picture is used
    assert.deepEqual(img("artist", { ...track, artistIds: [] }), none);
    assert.deepEqual(img("artist", track, false, look({ spotifyControls: false })), none);
    assert.deepEqual(img("artist", track), { kind: "label", label: "Artist picture" }); // not looked up yet
    assert.deepEqual(img("artist", track, false, look({ artistImage: () => "" })), none); // looked up: the artist has no picture
    assert.deepEqual(img("artist", track, false, look({ artistImage: () => "https://i.scdn.co/image/artist1" })), { kind: "label", label: "Artist picture" });
    assert.deepEqual(img("artist", track, false, look({ artistImage: () => "https://i.scdn.co/image/artist1", assetId: () => "mp:external/a/https/i.scdn.co/image/artist1" })),
        { kind: "image", src: "https://media.discordapp.net/external/a/https/i.scdn.co/image/artist1", label: "Artist picture" });
    assert.deepEqual(img("artist", SAMPLE_TRACK, true), { kind: "label", label: "Artist picture" });
    assert.deepEqual(img("artist", SAMPLE_TRACK, true, look(), "lastfm"), none);

    // custom image link
    const custom = "https://example.com/pic.png";
    assert.deepEqual(img("custom", track, false, look(), "spotify", custom), { kind: "label", label: "Custom image" });
    assert.deepEqual(img("custom", track, false, look({ assetId: () => "mp:external/q/https/example.com/pic.png" }), "spotify", custom),
        { kind: "image", src: "https://media.discordapp.net/external/q/https/example.com/pic.png", label: "Custom image" });
    assert.deepEqual(img("custom", track, false, look(), "spotify", ""), none);
    assert.deepEqual(img("custom", track, false, look(), "spotify", "not a link"), none);
    // a non-proxy asset id (shouldn't happen) is not turned into a URL
    assert.deepEqual(img("custom", track, false, look({ assetId: () => "12345" }), "spotify", custom), { kind: "label", label: "Custom image" });

    assert.deepEqual(img("none", withCover), none);
}

// defaultUpdates (Ruling N14): a template still on the old shipped default (with U+2014) moves to the
// new one once; anything customised, or already new, is left alone (exact match only)
{
    const EM = String.fromCharCode(0x2014); // the em dash, built so this file never contains one
    const OLD = `{icon} {song} ${EM} {artist}`;
    const NEW = "{icon} {song} - {artist}";
    assert.deepEqual(defaultUpdates({ template: OLD }), { template: NEW });
    assert.deepEqual(defaultUpdates({ template: NEW }), {}); // already new: nothing (so it happens once)
    assert.deepEqual(defaultUpdates({ template: `{song} ${EM} {artist}` }), {}); // customised, even with an em dash
    assert.deepEqual(defaultUpdates({ template: OLD + " " }), {}); // exact match only
    assert.deepEqual(defaultUpdates({ template: "" }), {});
    assert.deepEqual(defaultUpdates({}), {}); // never stored
    assert.deepEqual(defaultUpdates({ template: OLD, pausedTemplate: OLD, activityName: OLD }), { template: NEW }); // only the setting whose default it was
    // and the new default is what the plugin ships
    assert.equal(buildPreview(s({ template: NEW }), track, false, live).customStatus?.text, "♪ Karma Police (Remastered) - Radiohead");
}

// Ruling N15 (1): whitespace-only text with no emoji is empty too (Discord trims it, which would blank the status)
{
    assert.equal(statusAction(" ", "", null), "clear");
    assert.equal(statusAction("   ", "", "♪ Song"), "clear");
    assert.equal(statusAction(" ", "🎵", null), "set"); // the emoji still makes it a status
    const p = buildPreview(s({ template: " {album} ", emoji: "", updateActivity: false }), { ...track, album: "" }, false, live);
    assert.equal(p.customStatus, null);
    assert.equal(p.hiddenReason, "empty");
}

// Ruling N15 (2): clearing the plugin's status checks the live one first
{
    const ours = { text: "♪ Song - Artist", emoji: "🎵" };
    assert.equal(clearStep({ ok: false }, ours), "retry"); // couldn't read it: keep the record, try again later
    assert.equal(clearStep({ ok: true, status: { text: "♪ Song - Artist", emoji_name: "🎵" } }, ours), "clear");
    assert.equal(clearStep({ ok: true, status: { text: " ♪ Song - Artist ", emoji_name: "🎵" + String.fromCharCode(0xFE0F) } }, ours), "clear"); // same, modulo spaces and U+FE0F
    assert.equal(clearStep({ ok: true, status: { text: "brb", emoji_name: null } }, ours), "release"); // changed by hand: leave it
    assert.equal(clearStep({ ok: true, status: null }, ours), "release"); // cleared by hand: nothing to clear
    const emojiOnly = { text: "", emoji: "🎵" };
    assert.equal(clearStep({ ok: true, status: { text: null, emoji_name: "🎵" } }, emojiOnly), "clear");
    assert.equal(clearStep({ ok: true, status: { text: null, emoji_name: "🔥" } }, emojiOnly), "release");
    // the same comparison stop() uses
    assert.equal(isSameStatus({ text: "♪ Song - Artist", emoji_name: "🎵" }, ours), true);
    assert.equal(isSameStatus({ text: "other", emoji_name: "🎵" }, ours), false);
}

// the sample track is a sensible stand-in
assert.ok(SAMPLE_TRACK.name && SAMPLE_TRACK.artists.length && SAMPLE_TRACK.duration > SAMPLE_TRACK.position && SAMPLE_TRACK.isPlaying);

console.log("SpotifyStatus preview: all checks passed");
