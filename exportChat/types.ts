/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const enum MediaMode {
    CDN = "cdn",
    BASE64 = "base64",
    CATBOX = "catbox"
}

export const enum FileExistsBehavior {
    INCREMENT = "increment",
    OVERWRITE = "overwrite"
}

export interface ExportQueueEntry {
    channelId: string;
    channelName: string;
    type: "channel" | "range" | "server";
    guildId?: string;
    rangeStartId?: string;
    rangeEndId?: string;
}

export interface ExportOptions {
    channelId: string;
    dateFrom?: Date;
    dateTo?: Date;
    includeUserIds?: string[];
    excludeUserIds?: string[];
    mediaTypes?: ("image" | "video" | "file" | "link")[];
    messageCount?: number;
    mediaMode: MediaMode;
    catboxUserhash?: string;
    hiddenMessageIds?: Set<string>;
    highlightedMessageIds?: Set<string>;
    rangeStartId?: string;
    rangeEndId?: string;
}

export interface ExportRecord {
    id: string;
    timestamp: number;
    filename: string;
    filePath?: string;
    fileSize: number;
    messageCount: number;
    channelNames: string[];
    guildName?: string;
    exportType: string;
    mediaMode: string;
    passwordProtected: boolean;
    password?: string;
    sharedUrl?: string;
    cfDeploymentId?: string;
    filters: {
        dateFrom?: string;
        dateTo?: string;
        excludeUserIds?: string;
        mediaTypes?: string[];
        highlighted: number;
        hidden: number;
    };
}

export interface ExportProgress {
    phase: "fetching" | "processing" | "generating" | "done" | "error";
    fetchedCount: number;
    totalEstimate?: number;
    currentAction: string;
}
