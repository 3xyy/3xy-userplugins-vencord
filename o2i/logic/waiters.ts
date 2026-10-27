/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface WaitTimers {
    set(fn: () => void, ms: number): unknown;
    clear(timer: unknown): void;
}

interface Waiter<T> {
    done(value: T | null): void;
}

/**
 * Long-poll support for one kind of event (native.ts: `mic_muted`). Each published event gets the next
 * sequence number and is kept as the latest. A waiter is called exactly once: with the latest event right
 * away when it is newer than the `afterSeq` it passed (so an event between two waits is never lost), else
 * with the next published event, or with null at its timeout or on `cancelAll()`. At most `max` waiters
 * are kept; a new one beyond that ends the oldest with null. Never throws.
 */
export class LatestWaiters<T extends object> {
    private last: (T & { seq: number; }) | null = null;
    private readonly waiters = new Set<Waiter<T & { seq: number; }>>();

    constructor(private readonly timers: WaitTimers, private readonly max = 4) { }

    /** The latest event's number (0: none yet). */
    get seq(): number {
        return this.last?.seq ?? 0;
    }

    get pending(): number {
        return this.waiters.size;
    }

    /** `afterSeq` undefined: wait for the next event even if one was published before. */
    wait(timeoutMs: number, afterSeq: number | undefined, cb: (value: (T & { seq: number; }) | null) => void): void {
        if (afterSeq !== undefined && this.last && this.last.seq > afterSeq) {
            call(cb, this.last);
            return;
        }
        let timer: unknown = null;
        let called = false;
        const w: Waiter<T & { seq: number; }> = {
            done: value => {
                if (called) return;
                called = true;
                this.waiters.delete(w);
                if (timer != null) this.timers.clear(timer);
                call(cb, value);
            },
        };
        while (this.waiters.size >= this.max) {
            const oldest = this.waiters.values().next().value;
            if (!oldest) break;
            oldest.done(null);
        }
        this.waiters.add(w);
        try {
            timer = this.timers.set(() => w.done(null), timeoutMs);
        } catch {
            w.done(null);
        }
    }

    publish(value: T): void {
        const ev = { ...value, seq: this.seq + 1 };
        this.last = ev;
        for (const w of [...this.waiters]) w.done(ev);
    }

    cancelAll(): void {
        for (const w of [...this.waiters]) w.done(null);
    }
}

function call<V>(cb: (v: V) => void, v: V) {
    try {
        cb(v);
    } catch { /* one waiter's failure never stops the others */ }
}
