/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Discord's main process only (node fs; used by native.ts). The plugin.log writer: lines are queued and
// written in one batch (a short timer, or flush()), the file rotates before it would pass the cap
// (keeping `keep` files), and nothing here ever throws. On any I/O failure (no permission, disk full,
// a locked file) logging switches itself off for `retryMs`, dropping what was queued.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";

import { formatLogLine, logFileName, rotationRenames, shouldRotate } from "./logrotate";

export interface LogFileOptions {
    /** The log folder; read on every write (may throw: logging then switches off). */
    dir(): string;
    /** File base name: `plugin` → plugin.log, plugin.1.log, … */
    base: string;
    capBytes: number;
    /** Files kept, the current one included. */
    keep: number;
    /** Lines queued before new ones are dropped (and counted). */
    maxQueue: number;
    /** Batch window: lines are written this long after the first queued one. 0: only flush() writes. */
    flushDelayMs: number;
    /** After a failed write, how long logging stays off. */
    retryMs: number;
    now?(): number;
}

function isMissing(e: unknown): boolean {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

function sizeOf(file: string): number {
    try {
        return statSync(file).size;
    } catch (e) {
        if (isMissing(e)) return 0;
        throw e;
    }
}

export class LogFile {
    private queue: string[] = [];
    private dropped = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private offUntil = 0;

    constructor(private readonly o: LogFileOptions) { }

    private now(): number {
        return this.o.now ? this.o.now() : Date.now();
    }

    /** Logging is switched off after a failed write (until `retryMs` has passed). */
    get disabled(): boolean {
        return this.now() < this.offUntil;
    }

    /** Queues one formatted line (no newline). Never throws. */
    append(line: string): void {
        try {
            if (this.disabled) return;
            if (this.queue.length >= this.o.maxQueue) {
                this.dropped++;
                return;
            }
            this.queue.push(line);
            if (this.o.flushDelayMs > 0 && !this.timer) {
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.flush();
                }, this.o.flushDelayMs);
            }
        } catch { /* logging must never break the caller */ }
    }

    /** Writes everything queued now (synchronously). Never throws. */
    flush(): void {
        try {
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            if (!this.queue.length && !this.dropped) return;
            const lines = this.queue;
            this.queue = [];
            if (this.dropped) {
                lines.push(formatLogLine(new Date(this.now()), "warn", `${this.dropped} log lines dropped (queue full)`));
                this.dropped = 0;
            }
            if (this.disabled) return;
            try {
                this.write(lines);
            } catch {
                this.offUntil = this.now() + this.o.retryMs;
            }
        } catch { /* never throws */ }
    }

    private write(lines: string[]) {
        const dir = this.o.dir();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, logFileName(this.o.base, 0));
        let size = sizeOf(file);
        let chunk = "";
        let chunkBytes = 0;
        for (const line of lines) {
            const text = line + "\n";
            const bytes = Buffer.byteLength(text);
            if (shouldRotate(size + chunkBytes, this.o.capBytes, bytes)) {
                if (chunk) appendFileSync(file, chunk);
                this.rotate(dir);
                size = 0;
                chunk = "";
                chunkBytes = 0;
            }
            chunk += text;
            chunkBytes += bytes;
        }
        if (chunk) appendFileSync(file, chunk);
    }

    /** Oldest file removed, `.1` → `.2`, current → `.1`; the next append creates a fresh current file. */
    private rotate(dir: string) {
        const { base, keep } = this.o;
        rmSync(join(dir, logFileName(base, keep - 1)), { force: true });
        for (const [from, to] of rotationRenames(base, keep)) {
            try {
                renameSync(join(dir, from), join(dir, to));
            } catch (e) {
                if (!isMissing(e)) throw e;
            }
        }
    }
}
