/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renderer logging: every line goes to the console (Logger "o2i") and, at most 20 lines per second, to
// %APPDATA%\o2i\logs\plugin.log through native.ts (extra lines are dropped and counted in one line).
// Log events, never per poll; no secrets or message content (device / app / file names are fine).
// Nothing here throws.

import type { PluginNative } from "@utils/types";

import { logger } from "./logger";
import { type LogLevel, truncateLogMsg } from "./logic/logrotate";
import { RateLimiter } from "./logic/ratelimit";

type O2iNative = PluginNative<typeof import("./native")>;

const LINES_PER_SECOND = 20;
const limiter = new RateLimiter(LINES_PER_SECOND, 1000);
/** Monotonic milliseconds for the limiter: a wall-clock step (NTP, manual change) can't stall logging. */
const clock = () => performance.now();
let dropTimer: ReturnType<typeof setTimeout> | null = null;

const noop = () => { };

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function toFile(level: LogLevel, msg: string) {
    if (!IS_DISCORD_DESKTOP) return;
    try {
        (VencordNative.pluginHelpers.Output2Input as O2iNative).pluginLog(level, truncateLogMsg(msg)).catch(noop);
    } catch { /* no native side (e.g. mid-reload) */ }
}

function droppedLine(n: number): string {
    return `${n} log lines dropped (more than ${LINES_PER_SECOND} per second)`;
}

function armDropTimer(now: number) {
    dropTimer ??= setTimeout(reportDropped, limiter.msLeft(now) + 10);
}

/** Reports drops when the burst is over and no further line comes to carry the count. */
function reportDropped() {
    dropTimer = null;
    try {
        const now = clock();
        const n = limiter.drain(now);
        if (n) toFile("warn", droppedLine(n));
        // Drops from a newer window that started before this timer fired: report them at its end.
        if (limiter.pending) armDropTimer(now);
    } catch { /* never throws */ }
}

function write(level: LogLevel, msg: string, err?: unknown) {
    try {
        if (err === undefined) logger[level](msg);
        else logger[level](msg, err);
    } catch { /* console unavailable */ }
    try {
        const line = err === undefined ? msg : `${msg}: ${errText(err)}`;
        const now = clock();
        const { ok, report } = limiter.take(now);
        if (report) toFile("warn", droppedLine(report));
        if (ok) toFile(level, line);
        else armDropTimer(now);
    } catch { /* never throws */ }
}

/** o2i's log: console + plugin.log. `err` (optional) adds its message to the file line and its stack to the console. */
export const olog = {
    info(msg: string, err?: unknown): void {
        write("info", msg, err);
    },
    warn(msg: string, err?: unknown): void {
        write("warn", msg, err);
    },
    error(msg: string, err?: unknown): void {
        write("error", msg, err);
    },
};
