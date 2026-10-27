/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * At most `limit` lines per fixed window of `windowMs`; lines past that are dropped and counted. The count
 * is reported once: with the first line of a later window (`take(...).report`), or by `drain` from a timer
 * when no further line comes. A clock that steps backwards (`now` before the window) ends the window, so
 * logging never stalls.
 */
export class RateLimiter {
    private windowStart = Number.NEGATIVE_INFINITY;
    private count = 0;
    private dropped = 0;

    constructor(readonly limit: number, readonly windowMs: number) { }

    /** The current window is over at `now` (or `now` is before it: the clock went back). */
    private ended(now: number): boolean {
        return now < this.windowStart || now - this.windowStart >= this.windowMs;
    }

    /** May a line be written at `now`? `report`: lines dropped earlier, to be reported before this one. */
    take(now: number): { ok: boolean; report: number; } {
        let report = 0;
        if (this.ended(now)) {
            report = this.dropped;
            this.dropped = 0;
            this.windowStart = now;
            this.count = 0;
        }
        if (this.count < this.limit) {
            this.count++;
            return { ok: true, report };
        }
        this.dropped++;
        return { ok: false, report };
    }

    /** Dropped lines not reported yet. */
    get pending(): number {
        return this.dropped;
    }

    /** Milliseconds until the current window ends (0 when it has; never more than one window). */
    msLeft(now: number): number {
        return this.ended(now) ? 0 : Math.min(this.windowMs, this.windowStart + this.windowMs - now);
    }

    /** Lines dropped in a window that has ended, once (0 while the window is still open). */
    drain(now: number): number {
        if (!this.dropped || !this.ended(now)) return 0;
        const n = this.dropped;
        this.dropped = 0;
        return n;
    }
}
