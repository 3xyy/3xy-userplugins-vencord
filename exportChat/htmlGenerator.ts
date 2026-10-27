/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildMemberStore, GuildStore, IconUtils, RestAPI, UserStore } from "@webpack/common";

import { buildUploadHtml, ParsedExport, UploadOptions } from "./exportUpload";
import { Native } from "./index";
import { processAllMedia } from "./mediaHandler";
import { injectIntoTemplate, padId } from "./template";
import { ExportProgress, MediaMode } from "./types";
import { httpUrl, safeAssetUrl } from "./validation";

let templateCache: string | null = null;

/** The viewer template, bundled into native.ts; fetched once over IPC on the first export. */
async function getTemplate(): Promise<string> {
    if (!templateCache) {
        const t = await Native.loadDcefTemplate();
        if (typeof t !== "string" || t.length < 1000) throw new Error("ExportChat viewer template is missing from this build. Rebuild Vencord and restart Discord.");
        templateCache = t;
    }
    return templateCache;
}

/**
 * History > Upload: the page to upload for an export read back with parseExportHtml, built from the
 * bundled viewer template by the same injectIntoTemplate a normal export uses (same escaping, same
 * encryption, same admin script).
 */
export async function rebuildForUpload(parsed: ParsedExport, opts: UploadOptions): Promise<string> {
    return buildUploadHtml(await getTemplate(), parsed, opts);
}

function getAvatarUrl(author: any): string {
    const user = UserStore.getUser(author.id);
    if (user && IconUtils?.getUserAvatarURL) return IconUtils.getUserAvatarURL(user);
    if (author.avatar) return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=80`;
    const idx = author.discriminator === "0" ? (BigInt(author.id) >> 22n) % 6n : Number(author.discriminator) % 5;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function getUserRoles(uid: string, gid?: string): any[] {
    if (!gid) return [];
    const member = GuildMemberStore.getMember(gid, uid);
    if (!member?.roles?.length) return [];
    const guild = GuildStore.getGuild(gid);
    if (!guild) return [];
    return member.roles.map((rid, i) => {
        const r = (guild as any).roles?.[rid];
        if (!r || r.name === "@everyone") return null;
        return { _id: padId(rid), name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null, position: r.position || i };
    }).filter(Boolean);
}

function getUserColor(uid: string, gid?: string): string {
    if (!gid) return "";
    return GuildMemberStore.getMember(gid, uid)?.colorString || "";
}

function makeAsset(url: string, type: "image" | "video" | "audio" | "unknown" = "unknown", w = 0, h = 0, size = 0, filename = ""): any {
    // path must be "" or a full URL (http(s) or data:); the viewer's checkUrl() turns anything else into /input/...
    const safeUrl = safeAssetUrl(url);
    return { _id: safeUrl || "0", originalPath: safeUrl, localPath: safeUrl, remotePath: safeUrl, path: safeUrl, extension: filename.split(".").pop() || "", type, width: w, height: h, sizeBytes: size, filenameWithHash: filename, filenameWithoutHash: filename, colorDominant: null, colorPalette: null };
}

function unicodeToTwemojiUrl(emoji: string): string {
    const codepoints = [...emoji].map(c => c.codePointAt(0)!.toString(16)).join("-");
    return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codepoints}.png`;
}

function getChannelName(channelId: string): string {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return "Unknown";
    if (ch.type === 1) {
        // DM: the other person's name
        const recipients = (ch as any).recipients || [];
        if (recipients.length > 0) {
            const user = UserStore.getUser(recipients[0]);
            return user?.globalName || user?.username || "DM";
        }
        return "Direct Message";
    }
    if (ch.type === 3) {
        // Group DM: its name, or the members' names
        if (ch.name) return ch.name;
        const recipients = (ch as any).recipients || [];
        const names = recipients.slice(0, 4).map((uid: string) => {
            const u = UserStore.getUser(uid);
            return u?.globalName || u?.username || "?";
        });
        return names.length > 0 ? names.join(", ") : "Group Chat";
    }
    return ch.name || "Channel";
}

// Icon URL for a DM or group DM, shown when DMs appear as their own servers in the viewer's sidebar
function getChannelIconUrl(channel: any): string {
    if (channel?.type === 1) {
        const recipientId = (channel as any).recipients?.[0];
        if (!recipientId) return "";
        const user = UserStore.getUser(recipientId);
        if (user?.avatar) return `https://cdn.discordapp.com/avatars/${recipientId}/${user.avatar}.webp?size=128`;
        const discr = (user as any)?.discriminator || "0";
        const idx = discr === "0" ? (BigInt(recipientId) >> 22n) % 6n : Number(discr) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    }
    if (channel?.type === 3 && channel.icon) {
        return `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.webp?size=128`;
    }
    return "";
}

function convertType(type: number): string {
    const map: Record<number, string> = {
        0: "Default", 1: "RecipientAdd", 2: "RecipientRemove", 3: "Call",
        4: "ChannelNameChange", 5: "ChannelIconChange", 6: "ChannelPinnedMessage",
        7: "GuildMemberJoin", 8: "Default", 9: "Default", 10: "Default", 11: "Default",
        18: "ChannelPinnedMessage", 19: "Reply", 20: "Default", 21: "ThreadCreated",
        22: "Default", 23: "Default", 24: "24",
    };
    return map[type] || "Default";
}

// Pre-built role cache: userId -> Role[]
let roleCache = new Map<string, any[]>();

function buildRoleCache(messages: any[], guildId?: string) {
    roleCache = new Map();
    if (!guildId || guildId === "0") { console.log("[ExportChat] buildRoleCache: no guildId, skipping"); return; }
    const guild = GuildStore.getGuild(guildId);
    if (!guild) { console.log("[ExportChat] buildRoleCache: guild not found for", guildId); return; }
    const guildRoles = (guild as any).roles || {};
    console.log(`[ExportChat] buildRoleCache: guild has ${Object.keys(guildRoles).length} roles defined`);

    let usersWithRoles = 0;
    let usersFromStore = 0;
    let usersFromMember = 0;

    for (const msg of messages) {
        const uid = msg.author?.id;
        if (!uid || roleCache.has(uid)) continue;

        // Try GuildMemberStore first
        const storeMember = GuildMemberStore.getMember(guildId, uid);
        let memberRoleIds = storeMember?.roles;
        let source = "store";

        // Fallback to msg.member.roles
        if (!memberRoleIds?.length && msg.member?.roles?.length) {
            memberRoleIds = msg.member.roles;
            source = "msg.member";
        }

        if (memberRoleIds?.length) {
            const roles = memberRoleIds.map((rid: string) => {
                const r = guildRoles[rid];
                if (!r || r.name === "@everyone") return null;
                return { _id: padId(rid), name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null, position: r.position || 0 };
            }).filter(Boolean);
            if (roles.length > 0) {
                roleCache.set(uid, roles);
                usersWithRoles++;
                if (source === "store") usersFromStore++;
                else usersFromMember++;
            }
        }
    }
    console.log(`[ExportChat] buildRoleCache: ${usersWithRoles} users have roles (${usersFromStore} from store, ${usersFromMember} from msg.member)`);
}

function convertAuthor(a: any, guildId?: string, memberData?: any): any {
    // Get roles from pre-built cache
    const roles = roleCache.get(a.id) || [];

    // Server nickname: check msg.member.nick, then GuildMemberStore, then global_name
    const storeMember = guildId ? GuildMemberStore.getMember(guildId, a.id) : null;
    const nick = memberData?.nick || storeMember?.nick || a.global_name || a.username;
    const color = getUserColor(a.id, guildId);

    return {
        _id: padId(a.id),
        name: a.username,
        nickname: nick,
        color,
        isBot: !!a.bot,
        avatar: makeAsset(getAvatarUrl(a), "image", 80, 80, 0, "avatar.webp"),
        roles,
    };
}

// Build the full channels list for a guild (used for channel mention resolution + DCEF sidebar)
function buildGuildChannels(guildId: string): any[] {
    const channels: any[] = [];
    if (!guildId || guildId === "0") return channels;

    // Get ALL channels for this guild from ChannelStore
    const allStoreChannels = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId) || {}) as any[];

    // Collect category names first
    const categoryNames = new Map<string, string>();
    for (const wrapper of allStoreChannels) {
        const ch = wrapper?.channel || wrapper;
        if (ch?.type === 4 && ch?.id) categoryNames.set(ch.id, ch.name || "");
    }

    for (const wrapper of allStoreChannels) {
        const ch = wrapper?.channel || wrapper;
        if (!ch?.id || ch.type === 4) continue; // Skip categories

        const dcefType = ch.type === 11 || ch.type === 12 ? "GuildPublicThread"
            : ch.type === 2 || ch.type === 13 ? "GuildVoiceChat"
                : ch.type === 15 ? "GuildForum"
                    : ch.type === 5 ? "GuildNews" : "GuildTextChat";

        const parentId = ch.parent_id;
        const catName = parentId ? (categoryNames.get(parentId) || ChannelStore.getChannel(parentId)?.name || "Other") : "General";

        channels.push({
            _id: padId(ch.id),
            name: ch.name || "",
            type: dcefType,
            guildId: padId(guildId),
            // For threads: categoryId points to parent channel
            // For channels: categoryId points to category OR use a stable non-zero fallback
            categoryId: parentId ? padId(parentId) : padId(guildId), // use guildId as fallback, NOT "0"
            category: catName,
            topic: ch.topic || null,
            msg_count: 0,
        });
    }

    // If no channels found from store, log warning
    if (channels.length === 0) {
        console.warn("[ExportChat] buildGuildChannels: no channels found from ChannelStore for guild", guildId);
    }

    return channels;
}

function buildGuildRoles(guildId: string): any[] {
    if (!guildId || guildId === "0") return [];
    const guild = GuildStore.getGuild(guildId);
    if (!guild || !(guild as any).roles) return [];
    return Object.entries((guild as any).roles).map(([rid, r]: [string, any]) => ({
        _id: padId(rid), name: r.name,
        color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null,
        position: r.position || 0,
    }));
}

function convertMessage(msg: any, guildId?: string, channelName?: string, allRoles?: any[], allChannels?: any[]): any {
    const mentions = (msg.mentions || []).filter((m: any) => m?.id).map((m: any) => ({
        _id: padId(m.id),
        name: m.username || "user",
        discriminator: m.discriminator || "0",
        nickname: m.global_name || m.username || "Unknown User",
        isBot: !!m.bot,
    }));

    const reactions = (msg.reactions || []).map((r: any) => {
        const isCustom = !!r.emoji.id;
        const imageUrl = isCustom
            ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "webp"}?size=48`
            : unicodeToTwemojiUrl(r.emoji.name);
        const users: any[] = [];
        if (r.me) {
            const me = UserStore.getCurrentUser();
            if (me) users.push({ _id: padId(me.id), name: me.username, nickname: (me as any).globalName || me.username, isBot: false, avatar: makeAsset(getAvatarUrl({ id: me.id, username: me.username, avatar: me.avatar, discriminator: "0" }), "image") });
        }
        return {
            emoji: { _id: padId(r.emoji.id || r.emoji.name || "0"), name: r.emoji.name || "?", isAnimated: !!r.emoji.animated, image: makeAsset(imageUrl, "image", 48, 48, 0, "emoji.png"), source: (isCustom ? "custom" : "default") as "custom" | "default", guildId: null },
            count: r.count, users: users.length > 0 ? users : undefined,
        };
    });

    // For attachments: use proxy for images/videos, cdn for everything else
    // media.discordapp.net answers 415 for non-media files, so those use cdn.discordapp.com
    const fixUrl = (url: string, isMedia: boolean) => {
        if (!url) return "";
        if (!isMedia && url.includes("media.discordapp.net")) {
            return url.replace("media.discordapp.net", "cdn.discordapp.com");
        }
        return url;
    };
    const attachments = (msg.attachments || []).map((att: any) => {
        const ct = att.content_type || "";
        const isImg = ct.startsWith("image/");
        const isVid = ct.startsWith("video/");
        const isAud = ct.startsWith("audio/");
        const isMedia = isImg || isVid || isAud;
        const bestUrl = isMedia ? (att.proxy_url || att.url) : fixUrl(att.url || att.proxy_url, false);
        return makeAsset(bestUrl, isImg ? "image" : isVid ? "video" : isAud ? "audio" : "unknown", att.width || 0, att.height || 0, att.size || 0, att.filename || "file");
    });

    const embeds = (msg.embeds || []).map((e: any) => ({
        title: e.title || "", url: httpUrl(e.url), timestamp: e.timestamp || null, description: e.description || "",
        thumbnail: e.thumbnail ? makeAsset(e.thumbnail.proxy_url || e.thumbnail.url, "image", e.thumbnail.width, e.thumbnail.height) : null,
        images: e.image ? [makeAsset(e.image.proxy_url || e.image.url, "image", e.image.width, e.image.height)] : [],
        video: e.video ? makeAsset(e.video.proxy_url || e.video.url, "video", e.video.width, e.video.height) : null,
        fields: (e.fields || []).map((f: any) => ({ name: f.name, value: f.value, isInline: !!f.inline })),
        color: e.color ? `#${e.color.toString(16).padStart(6, "0")}` : undefined,
        author: e.author ? { name: e.author.name || "", url: httpUrl(e.author.url), icon: e.author.icon_url ? makeAsset(e.author.proxy_icon_url || e.author.icon_url, "image") : undefined } : undefined,
        footer: e.footer ? { text: e.footer.text || "", icon: e.footer.icon_url ? makeAsset(e.footer.proxy_icon_url || e.footer.icon_url, "image") : undefined } : undefined,
    }));

    // Handle forwarded messages (message_snapshots)
    if (msg.message_snapshots?.length) {
        const snap = msg.message_snapshots[0].message;
        if (snap) {
            const fwdContent = snap.content || "";
            const fwdAuthor = snap.author ? (snap.author.global_name || snap.author.username) : "Unknown";
            embeds.unshift({
                title: `Forwarded from ${fwdAuthor}`, url: "", timestamp: snap.timestamp || null,
                description: fwdContent,
                thumbnail: null, images: [], video: null, fields: [],
                color: "#5865f2",
                author: snap.author ? { name: fwdAuthor, url: "", icon: snap.author.avatar ? makeAsset(`https://cdn.discordapp.com/avatars/${snap.author.id}/${snap.author.avatar}.webp?size=32`, "image") : undefined } : undefined,
                footer: undefined,
            });
            for (const att of snap.attachments || []) {
                const ct2 = att.content_type || "";
                const isImg2 = ct2.startsWith("image/");
                const isVid2 = ct2.startsWith("video/");
                const bestUrl2 = (isImg2 || isVid2) ? (att.proxy_url || att.url) : (att.url || att.proxy_url);
                attachments.push(makeAsset(bestUrl2, isImg2 ? "image" : isVid2 ? "video" : "unknown", att.width || 0, att.height || 0, att.size || 0, att.filename || "file"));
            }
        }
    }

    const stickers = (msg.sticker_items || []).map((s: any) => ({
        name: s.name, format: "Png" as const, _id: padId(s.id),
        source: makeAsset(`https://media.discordapp.net/stickers/${s.id}.webp?size=160`, "image", 160, 160),
    }));

    // Extract custom emojis from message TEXT for DCEF markdown parser
    // emotes = Emoji[] with { _id, name, image }, not reactions
    const contentEmotes: any[] = [];
    const emojiRegex = /<(a?):(\w+):(\d+)>/g;
    let em;
    while ((em = emojiRegex.exec(msg.content || "")) !== null) {
        const [, animated, name, id] = em;
        contentEmotes.push({
            _id: padId(id), name,
            isAnimated: !!animated,
            image: makeAsset(`https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=48`, "image", 48, 48, 0, `${name}.${animated ? "gif" : "webp"}`),
            source: "custom" as const, guildId: null,
        });
    }

    const reference = msg.message_reference ? {
        messageId: padId(msg.message_reference.message_id || ""),
        channelId: padId(msg.message_reference.channel_id || ""),
        guildId: padId(msg.message_reference.guild_id || guildId || ""),
        message: null as any,
    } : null;

    return {
        _id: padId(msg.id),
        type: convertType(msg.type),
        timestamp: msg.timestamp,
        timestampEdited: msg.edited_timestamp || null,
        callEndedTimestamp: null,
        isPinned: !!msg.pinned,
        content: [{ timestamp: msg.timestamp, content: msg.content || "" }],
        author: convertAuthor(msg.author, guildId, msg.member),
        stickers: stickers.length > 0 ? stickers : null,
        reactions: reactions.length > 0 ? reactions : null,
        emotes: contentEmotes.length > 0 ? contentEmotes : null,
        mentions: mentions.length > 0 ? mentions : null,
        roles: allRoles || [],
        channels: allChannels || [],
        attachments: attachments.length > 0 ? attachments : null,
        embeds: embeds.length > 0 ? embeds : null,
        reference,
        guildId: padId(guildId || "0"),
        channelId: padId(msg.channel_id),
        channelName: channelName || "",
    };
}

// Resolve Discord invite links by fetching invite data from the API
async function resolveInvites(messages: any[], isAborted: () => boolean): Promise<Record<string, any>> {
    const invites: Record<string, any> = {};
    const inviteRegex = /discord\.gg\/([a-zA-Z0-9-]+)/g;
    const codes = new Set<string>();

    for (const m of messages) {
        let match;
        while ((match = inviteRegex.exec(m.content || "")) !== null) {
            codes.add(match[1]);
        }
    }

    // Throttled and capped: one API request per code, so big exports don't run into rate limits
    const toResolve = [...codes].slice(0, 100);
    for (let i = 0; i < toResolve.length; i++) {
        const code = toResolve[i];
        if (i > 0) await new Promise(r => setTimeout(r, 300));
        if (isAborted()) break;
        try {
            const res = await RestAPI.get({ url: `/invites/${encodeURIComponent(code)}`, query: { with_counts: true, with_expiration: true } });
            const inv = res.body;
            if (inv?.guild) {
                const iconUrl = inv.guild.icon ? `https://cdn.discordapp.com/icons/${inv.guild.id}/${inv.guild.icon}.webp?size=64` : "";
                invites[code] = {
                    guildName: inv.guild.name,
                    guildIcon: iconUrl,
                    online: inv.approximate_presence_count ?? "N/A",
                    members: inv.approximate_member_count ?? "N/A",
                };
            }
        } catch { /* skip failed invites */ }
    }
    return invites;
}

function resolveReferences(dcefMessages: any[], rawMessages: any[], guildId: string | undefined, chName: string, allRoles: any[], allChannels: any[]) {
    const msgMap = new Map<string, any>();
    for (const dm of dcefMessages) msgMap.set(dm._id, dm);
    for (const m of rawMessages) {
        if (m.referenced_message) {
            const pid = padId(m.referenced_message.id);
            if (!msgMap.has(pid)) msgMap.set(pid, convertMessage(m.referenced_message, guildId, chName, allRoles, allChannels));
        }
    }
    for (const dm of dcefMessages) {
        if (dm.reference?.messageId) dm.reference.message = msgMap.get(dm.reference.messageId) || null;
    }
}

// Replace all asset URLs in converted DCEF messages (avatars, emojis, embeds, stickers, reactions)
function replaceAssetUrl(asset: any, urlMap: Map<string, string>) {
    if (!asset?.path) return;
    const replacement = urlMap.get(asset.path);
    if (replacement && replacement !== asset.path) {
        asset.path = replacement;
        asset.localPath = replacement;
        asset.remotePath = replacement;
        asset.originalPath = replacement;
    }
}

async function processAllAssetsInDcefMessages(dcefMessages: any[], guildIcons: any[], mediaMode: MediaMode, catboxUserhash: string, onProgress: (p: ExportProgress) => void, isAborted: () => boolean) {
    if (mediaMode === MediaMode.CDN) return;

    // Collect ALL asset URLs from converted DCEF messages
    // One pass over the converted messages covers attachments too (each one once, the URL the viewer uses).
    // Already re-hosted catbox files are skipped.
    const urls = new Set<string>();
    const collectAsset = (a: any) => {
        const path = a?.path;
        if (typeof path !== "string" || !(path.startsWith("http://") || path.startsWith("https://"))) return;
        if (path.startsWith("https://files.catbox.moe/")) return;
        urls.add(path);
    };

    for (const m of dcefMessages) {
        collectAsset(m.author?.avatar);
        for (const a of m.attachments || []) collectAsset(a);
        for (const s of m.stickers || []) collectAsset(s.source);
        for (const e of m.embeds || []) {
            collectAsset(e.thumbnail); collectAsset(e.video);
            for (const img of e.images || []) collectAsset(img);
            collectAsset(e.author?.icon); collectAsset(e.footer?.icon);
        }
        for (const r of m.reactions || []) collectAsset(r.emoji?.image);
        for (const e of m.emotes || []) collectAsset(e.image);
    }
    // Guild icons (one per real guild + one per DM-as-guild)
    for (const icon of guildIcons) collectAsset(icon);

    const urlArray = [...urls];
    console.log(`[ExportChat] Processing ${urlArray.length} total asset URLs (avatars, emojis, embeds, etc.)`);
    if (urlArray.length === 0) return;

    onProgress({ phase: "processing", fetchedCount: 0, currentAction: `Processing ${urlArray.length} images and files...` });
    const mm = await processAllMedia(urlArray, mediaMode, catboxUserhash, (d, t) =>
        onProgress({ phase: "processing", fetchedCount: 0, currentAction: `Processing images and files: ${d} of ${t}` }), isAborted);
    if (isAborted()) return;

    // Replace URLs in all assets
    for (const m of dcefMessages) {
        replaceAssetUrl(m.author?.avatar, mm);
        for (const a of m.attachments || []) replaceAssetUrl(a, mm);
        for (const s of m.stickers || []) replaceAssetUrl(s.source, mm);
        for (const e of m.embeds || []) {
            replaceAssetUrl(e.thumbnail, mm); replaceAssetUrl(e.video, mm);
            for (const img of e.images || []) replaceAssetUrl(img, mm);
            replaceAssetUrl(e.author?.icon, mm); replaceAssetUrl(e.footer?.icon, mm);
        }
        for (const r of m.reactions || []) replaceAssetUrl(r.emoji?.image, mm);
        for (const e of m.emotes || []) replaceAssetUrl(e.image, mm);
    }
    for (const icon of guildIcons) replaceAssetUrl(icon, mm);

    // For txt files: fetch content via native.ts and embed directly in the asset
    // So DCEF can show preview without needing to fetch from catbox (which blocks CORS/iframes)
    for (const m of dcefMessages) {
        if (isAborted()) return;
        for (const a of m.attachments || []) {
            const fn = (a.filenameWithoutHash || a.filenameWithHash || "").toLowerCase();
            if (fn.endsWith(".txt") || fn.endsWith(".log") || fn.endsWith(".md") || fn.endsWith(".json") || fn.endsWith(".csv")) {
                if (a.path?.startsWith("http")) {
                    try {
                        console.log(`[ExportChat] Fetching text content for ${fn} from ${a.path.slice(0, 60)}`);
                        const text = await Native.fetchTextContent(a.path);
                        console.log(`[ExportChat] Got text content: ${text ? text.length + " chars" : "empty"}`);
                        if (text) a.textContent = text;
                    } catch (e) { console.warn("[ExportChat] Text fetch failed:", e); }
                }
            }
        }
    }
}

// ===== Server-wide export =====
export async function generateServerHtml(
    channelMessages: Record<string, any[]>, guildId: string, mediaMode: MediaMode, catboxUserhash: string,
    onProgress: (p: ExportProgress) => void, highlightedIds?: Set<string>,
    password?: string, adminMode?: boolean,
    /** Checked between media batches, text fetches and invite lookups; returns "" once it is true. */
    isAborted: () => boolean = () => false
): Promise<string> {
    const guild = GuildStore.getGuild(guildId);

    // Media (Base64 / catbox) is processed once, on the converted messages (processAllAssetsInDcefMessages)
    onProgress({ phase: "generating", fetchedCount: 0, currentAction: "Converting messages..." });

    // Pre-build role cache from all messages
    const allRawMsgsFlat = Object.values(channelMessages).flat();
    buildRoleCache(allRawMsgsFlat, guildId);

    const allRoles = buildGuildRoles(guildId);
    const allChannels = buildGuildChannels(guildId);

    const allDcefMessages: any[] = [];

    // Build a padded-ID lookup for msg_count updates
    const msgCountByPaddedId = new Map<string, number>();
    for (const [chId, msgs] of Object.entries(channelMessages)) {
        msgCountByPaddedId.set(padId(chId), msgs.length);
    }

    // Update msg_count on allChannels
    for (const ch of allChannels) {
        ch.msg_count = msgCountByPaddedId.get(ch._id) || 0;
    }

    for (const [chId, msgs] of Object.entries(channelMessages)) {
        const ch = ChannelStore.getChannel(chId);
        const chName = getChannelName(chId);

        // Ensure this channel is in allChannels (might not be if it's a thread not in the guild store)
        const paddedChId = padId(chId);
        if (!allChannels.find(c => c._id === paddedChId)) {
            allChannels.push({
                _id: paddedChId,
                name: chName,
                type: ch?.type === 11 || ch?.type === 12 ? "GuildPublicThread" : ch?.type === 2 || ch?.type === 13 ? "GuildVoiceChat" : "GuildTextChat",
                guildId: padId(guildId),
                categoryId: (ch as any)?.parent_id ? padId((ch as any).parent_id) : padId(guildId),
                category: (ch as any)?.parent_id ? (ChannelStore.getChannel((ch as any).parent_id)?.name || "General") : "General",
                topic: (ch as any)?.topic || null,
                msg_count: msgs.length,
            });
        }

        const converted = msgs.map(m => convertMessage(m, guildId, chName, allRoles, allChannels));
        resolveReferences(converted, msgs, guildId, chName, allRoles, allChannels);
        allDcefMessages.push(...converted);
    }

    // DMs and group DMs are split from server channels; each one becomes its own server in the viewer
    const dmGuilds: any[] = [];
    const dmChannels: any[] = [];
    const serverChannels: any[] = [];

    for (const ch of allChannels) {
        if (ch.msg_count <= 0) continue;
        const rawChId = ch._id.replace(/^0+/, "");
        const rawCh = ChannelStore.getChannel(rawChId);
        if (rawCh && (rawCh.type === 1 || rawCh.type === 3)) {
            const fakeGuildId = ch._id;
            const dmName = getChannelName(rawChId);
            const iconUrl = getChannelIconUrl(rawCh);
            ch.guildId = fakeGuildId;
            ch.categoryId = fakeGuildId;
            ch.type = "GuildTextChat";
            ch.category = "Direct Messages";
            ch.name = dmName;
            dmChannels.push(ch);
            dmGuilds.push({
                _id: fakeGuildId,
                name: dmName,
                icon: iconUrl ? makeAsset(iconUrl, "image", 128, 128, 0, "icon.webp") : makeAsset("", "unknown"),
                msg_count: ch.msg_count,
            });
            for (const m of allDcefMessages) {
                if (m.channelId === ch._id) m.guildId = fakeGuildId;
            }
        } else {
            serverChannels.push(ch);
        }
    }

    const guilds: any[] = [];
    if (serverChannels.length > 0) {
        guilds.push({
            _id: padId(guildId),
            name: guild?.name || "Server",
            icon: guild?.icon ? makeAsset(`https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.webp?size=128`, "image", 128, 128) : makeAsset("", "unknown"),
            msg_count: serverChannels.reduce((s, c) => s + c.msg_count, 0),
        });
    }
    guilds.push(...dmGuilds);

    // Upload all assets (avatars, emojis, embeds, all guild icons)
    await processAllAssetsInDcefMessages(allDcefMessages, guilds.map(g => g.icon), mediaMode, catboxUserhash, onProgress, isAborted);
    if (isAborted()) return "";

    const allExportedChannels = [...serverChannels, ...dmChannels];
    const allRawMsgs = Object.values(channelMessages).flat();
    const invites = await resolveInvites(allRawMsgs, isAborted);
    if (isAborted()) return "";

    // Use guilds array for multi-guild support, fall back to single guild for compat
    const dataObj = guilds.length === 1
        ? { guild: guilds[0], channels: allExportedChannels, messages: allDcefMessages, invites }
        : { guild: guilds[0], guilds, channels: allExportedChannels, messages: allDcefMessages, invites };

    onProgress({ phase: "generating", fetchedCount: 0, currentAction: "Building the page..." });
    const template = await getTemplate();

    const exportTitle = guild?.name || (dmGuilds.length === 1 ? dmGuilds[0].name : "Direct Messages");
    return await injectIntoTemplate(template, dataObj, exportTitle, highlightedIds, password, adminMode);
}
