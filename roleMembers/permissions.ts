/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Permissions } from "@vencord/discord-types";
import { ComponentType } from "react";

import {
    BanHammerIcon, ClockIcon, GearIcon, HashIcon, KickHammerIcon, LinkIcon,
    MentionIcon, PaperclipIcon, PencilIcon, ScrollIcon, ShieldIcon, TagIcon, TrashIcon
} from "./icons";

export const enum PermSortOrder {
    Importance,
    DiscordDefault,
    Alphabetical
}

// Highest importance first → least important last. Unlisted/new permissions fall to the bottom.
export const PERMISSION_IMPORTANCE_ORDER: Permissions[] = [
    // Server-controlling
    "ADMINISTRATOR", "MANAGE_GUILD", "MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_WEBHOOKS",
    // Member & voice moderation
    "BAN_MEMBERS", "KICK_MEMBERS", "MODERATE_MEMBERS", "MUTE_MEMBERS", "DEAFEN_MEMBERS",
    "MANAGE_NICKNAMES", "MANAGE_MESSAGES", "MENTION_EVERYONE", "VIEW_AUDIT_LOG",
    // Content/structure management
    "MANAGE_GUILD_EXPRESSIONS", "MANAGE_EVENTS", "MANAGE_THREADS", "MOVE_MEMBERS", "PRIORITY_SPEAKER",
    "CREATE_GUILD_EXPRESSIONS", "CREATE_EVENTS",
    // Core membership
    "VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "CREATE_INSTANT_INVITE", "CHANGE_NICKNAME", "BYPASS_SLOWMODE",
    // Messaging extras
    "PIN_MESSAGES", "ATTACH_FILES", "EMBED_LINKS", "ADD_REACTIONS", "USE_EXTERNAL_EMOJIS", "USE_EXTERNAL_STICKERS",
    "USE_APPLICATION_COMMANDS", "USE_EXTERNAL_APPS", "SEND_MESSAGES_IN_THREADS", "CREATE_PUBLIC_THREADS", "CREATE_PRIVATE_THREADS", "SEND_POLLS",
    // Voice/activity
    "CONNECT", "SPEAK", "STREAM", "USE_VAD", "REQUEST_TO_SPEAK", "USE_EMBEDDED_ACTIVITIES",
    "USE_SOUNDBOARD", "USE_EXTERNAL_SOUNDS", "SET_VOICE_CHANNEL_STATUS",
    // Low priority / niche visibility
    "VIEW_GUILD_ANALYTICS", "VIEW_CREATOR_MONETIZATION_ANALYTICS", "SEND_TTS_MESSAGES", "SEND_VOICE_MESSAGES"
];

// Custom leading icons for the most important / distinctive permissions only.
export const permissionIcons: Partial<Record<Permissions, ComponentType>> = {
    ADMINISTRATOR: ShieldIcon,
    MANAGE_GUILD: GearIcon,
    MANAGE_ROLES: TagIcon,
    MANAGE_CHANNELS: HashIcon,
    MANAGE_WEBHOOKS: LinkIcon,
    BAN_MEMBERS: BanHammerIcon,
    KICK_MEMBERS: KickHammerIcon,
    MODERATE_MEMBERS: ClockIcon,
    MANAGE_NICKNAMES: PencilIcon,
    MANAGE_MESSAGES: TrashIcon,
    VIEW_AUDIT_LOG: ScrollIcon,
    MENTION_EVERYONE: MentionIcon,
    ATTACH_FILES: PaperclipIcon
};

const importanceIndex = new Map<Permissions, number>(
    PERMISSION_IMPORTANCE_ORDER.map((key, index) => [key, index] as const)
);

interface PermissionSpec {
    title: string;
    description: string | ((...args: any[]) => string);
}

export function sortPermissionEntries(
    entries: [string, bigint][],
    order: PermSortOrder,
    specMap: Record<string, PermissionSpec>
): [string, bigint][] {
    const copy = [...entries];

    switch (order) {
        case PermSortOrder.Alphabetical:
            return copy.sort((a, b) =>
                (specMap[String(a[1])]?.title ?? a[0]).localeCompare(specMap[String(b[1])]?.title ?? b[0]));
        case PermSortOrder.DiscordDefault:
            return copy;
        case PermSortOrder.Importance:
        default:
            return copy.sort((a, b) =>
                (importanceIndex.get(a[0] as Permissions) ?? Number.MAX_SAFE_INTEGER) -
                (importanceIndex.get(b[0] as Permissions) ?? Number.MAX_SAFE_INTEGER));
    }
}
