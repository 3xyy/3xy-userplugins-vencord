/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure helpers for o2i's log files (%APPDATA%\o2i\logs). The same scheme as the engine's engine.log:
// `<base>.log` is current, `<base>.1.log` / `<base>.2.log` are older, rotated at 5 MB.

export type LogLevel = "info" | "warn" | "error";

/** Longest message written to plugin.log (longer ones end in "…"). */
export const LOG_MSG_MAX = 2000;

/**
 * Rotate before writing `incomingBytes` to a file of `sizeBytes`: the file is at the cap, or the write
 * would take it past the cap. An empty file always takes the write (so one oversized line can't loop).
 */
export function shouldRotate(sizeBytes: number, capBytes: number, incomingBytes = 0): boolean {
    return sizeBytes > 0 && (sizeBytes >= capBytes || sizeBytes + incomingBytes > capBytes);
}

/** `plugin.log` (index 0), `plugin.1.log`, `plugin.2.log`, … */
export function logFileName(base: string, index: number): string {
    return index === 0 ? `${base}.log` : `${base}.${index}.log`;
}

/**
 * The renames of one rotation keeping `keep` files, oldest first (`.1` → `.2`, then current → `.1`), so
 * nothing is overwritten before it has moved on. The oldest file (`logFileName(base, keep - 1)`) is
 * removed before these run.
 */
export function rotationRenames(base: string, keep: number): [from: string, to: string][] {
    const out: [string, string][] = [];
    for (let i = keep - 1; i >= 1; i--) out.push([logFileName(base, i - 1), logFileName(base, i)]);
    return out;
}

export function truncateLogMsg(msg: string, max = LOG_MSG_MAX): string {
    return msg.length <= max ? msg : msg.slice(0, max - 1) + "…";
}

/** `[<ISO time>] <LEVEL> <msg>` on one line (CR/LF become " | "), the message capped at LOG_MSG_MAX. */
export function formatLogLine(at: Date, level: LogLevel, msg: string): string {
    return `[${at.toISOString()}] ${level.toUpperCase()} ${truncateLogMsg(msg.replace(/\r?\n|\r/g, " | "))}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `o2i-logs-<YYYYMMDD-HHMMSS>.zip` in local time. */
export function exportZipName(at: Date): string {
    const day = `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}`;
    const time = `${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
    return `o2i-logs-${day}-${time}.zip`;
}
