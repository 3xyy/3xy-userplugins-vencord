/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI } from "@webpack/common";

import { ExportOptions, ExportProgress } from "./types";

const BATCH_SIZE = 100;
const RATE_LIMIT_DELAY = 600; // Faster than before, Discord allows ~5req/5s

function dateToSnowflake(date: Date): string {
    return String((BigInt(date.getTime()) - 1420070400000n) << 22n);
}

function hasMedia(msg: any, types: string[]): boolean {
    if (types.includes("image") && msg.attachments?.some((a: any) => a.content_type?.startsWith("image/"))) return true;
    if (types.includes("video") && msg.attachments?.some((a: any) => a.content_type?.startsWith("video/"))) return true;
    if (types.includes("file") && msg.attachments?.some((a: any) => !a.content_type?.startsWith("image/") && !a.content_type?.startsWith("video/"))) return true;
    if (types.includes("link") && msg.embeds?.length > 0) return true;
    return false;
}

function shouldInclude(msg: any, options: ExportOptions): boolean {
    if (options.hiddenMessageIds?.has(msg.id)) return false;

    // Range bounds filter: only include messages between start and end IDs (inclusive)
    // Discord IDs are snowflakes, so they sort by time
    if (options.rangeStartId && options.rangeEndId) {
        const msgIdBig = BigInt(msg.id);
        const startBig = BigInt(options.rangeStartId);
        const endBig = BigInt(options.rangeEndId);
        const lo = startBig < endBig ? startBig : endBig;
        const hi = startBig < endBig ? endBig : startBig;
        if (msgIdBig < lo || msgIdBig > hi) return false;
    }

    if (options.dateFrom) {
        const ts = new Date(msg.timestamp);
        const from = new Date(options.dateFrom);
        from.setHours(0, 0, 0, 0);
        if (ts < from) return false;
    }
    if (options.dateTo) {
        const ts = new Date(msg.timestamp);
        const to = new Date(options.dateTo);
        to.setHours(23, 59, 59, 999);
        if (ts > to) return false;
    }
    if (options.includeUserIds?.length) {
        if (!options.includeUserIds.includes(msg.author?.id)) return false;
    }
    if (options.excludeUserIds?.length) {
        if (options.excludeUserIds.includes(msg.author?.id)) return false;
    }
    if (options.mediaTypes?.length) {
        if (!hasMedia(msg, options.mediaTypes)) return false;
    }
    return true;
}

export async function fetchAllMessages(
    channelId: string,
    options: ExportOptions,
    onProgress: (progress: ExportProgress) => void,
    abortCheck: () => boolean
): Promise<any[]> {
    const allMessages: any[] = [];
    let beforeId: string | undefined;
    let hasMore = true;
    let delay = RATE_LIMIT_DELAY;
    let batchNum = 0;
    let consecutiveErrors = 0;

    if (options.dateTo) {
        const endOfDay = new Date(options.dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        beforeId = dateToSnowflake(new Date(endOfDay.getTime() + 1));
    }

    // For range mode, start fetching from just after the range end (more efficient)
    if (options.rangeStartId && options.rangeEndId) {
        const startBig = BigInt(options.rangeStartId);
        const endBig = BigInt(options.rangeEndId);
        const hi = startBig > endBig ? startBig : endBig;
        beforeId = String(hi + 1n); // Start just after the end bound
    }

    console.log(`[ExportChat] Starting fetch for channel ${channelId}, beforeId=${beforeId || "latest"}, rangeMode=${!!(options.rangeStartId && options.rangeEndId)}`);

    while (hasMore) {
        if (abortCheck()) { console.log("[ExportChat] Aborted"); break; }

        batchNum++;
        onProgress({
            phase: "fetching",
            fetchedCount: allMessages.length,
            currentAction: `Fetching messages: ${allMessages.length} so far (batch ${batchNum})`
        });

        const query: Record<string, any> = { limit: BATCH_SIZE };
        if (beforeId) query.before = beforeId;

        let res: any;
        try {
            res = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query,
                retries: 2
            });
            consecutiveErrors = 0;
        } catch (err: any) {
            console.warn(`[ExportChat] Batch #${batchNum} error:`, err?.status, err?.message);
            if (err?.status === 403) {
                console.log("[ExportChat] 403 - No permission, stopping");
                return allMessages;
            }
            if (err?.status === 429) {
                consecutiveErrors++;
                delay = Math.min(delay * 2, 5000);
                console.log(`[ExportChat] 429 rate limited, waiting ${delay}ms (attempt ${consecutiveErrors})`);
                if (consecutiveErrors > 10) { console.error("[ExportChat] Too many 429s, stopping"); break; }
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            // Other errors: retry once then skip
            consecutiveErrors++;
            if (consecutiveErrors > 3) { console.error("[ExportChat] Too many consecutive errors, stopping"); break; }
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        const messages: any[] = res.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            console.log(`[ExportChat] Batch #${batchNum}: empty response, done`);
            hasMore = false;
            break;
        }

        console.log(`[ExportChat] Batch #${batchNum}: got ${messages.length} messages (IDs ${messages[0]?.id} to ${messages[messages.length - 1]?.id})`);

        let included = 0;
        let excluded = 0;
        for (const msg of messages) {
            if (shouldInclude(msg, options)) {
                allMessages.push(msg);
                included++;
            } else {
                excluded++;
            }
        }
        if (excluded > 0) console.log(`[ExportChat] Batch #${batchNum}: ${included} included, ${excluded} excluded by filters`);

        beforeId = messages[messages.length - 1].id;

        if (messages.length < BATCH_SIZE) {
            console.log(`[ExportChat] Got ${messages.length} < ${BATCH_SIZE}, reached end of channel`);
            hasMore = false;
        }

        if (options.dateFrom) {
            const oldest = new Date(messages[messages.length - 1].timestamp);
            const from = new Date(options.dateFrom);
            from.setHours(0, 0, 0, 0);
            if (oldest < from) {
                console.log("[ExportChat] Reached dateFrom boundary, stopping");
                hasMore = false;
            }
        }

        // Range mode: stop when we've passed the start bound
        if (options.rangeStartId && options.rangeEndId) {
            const oldestId = BigInt(messages[messages.length - 1].id);
            const startBig = BigInt(options.rangeStartId);
            const endBig = BigInt(options.rangeEndId);
            const lo = startBig < endBig ? startBig : endBig;
            if (oldestId < lo) {
                console.log("[ExportChat] Passed range start bound, stopping");
                hasMore = false;
            }
        }

        if (options.messageCount && options.messageCount > 0 && allMessages.length >= options.messageCount) {
            allMessages.splice(options.messageCount);
            hasMore = false;
        }

        if (hasMore) {
            await new Promise(r => setTimeout(r, delay));
            delay = RATE_LIMIT_DELAY;
        }
    }

    console.log(`[ExportChat] Fetch complete: ${allMessages.length} messages from ${batchNum} batches`);
    if (allMessages.length > 0) {
        console.log(`[ExportChat] ID range: ${allMessages[0]?.id} → ${allMessages[allMessages.length - 1]?.id}`);
        console.log(`[ExportChat] Time range: ${allMessages[0]?.timestamp} → ${allMessages[allMessages.length - 1]?.timestamp}`);
        if (options.rangeStartId && options.rangeEndId) {
            const lo = BigInt(options.rangeStartId) < BigInt(options.rangeEndId) ? options.rangeStartId : options.rangeEndId;
            const hi = BigInt(options.rangeStartId) > BigInt(options.rangeEndId) ? options.rangeStartId : options.rangeEndId;
            console.log(`[ExportChat] Range bounds: ${lo} → ${hi}`);
        }
    }
    return allMessages.reverse();
}
