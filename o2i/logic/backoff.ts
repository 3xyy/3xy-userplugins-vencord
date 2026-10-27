/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
export const STABLE_RESET_MS = 60000;

export function nextDelay(failures: number): number {
    const i = Math.min(Math.max(0, Math.floor(failures)), BACKOFF_MS.length - 1);
    return BACKOFF_MS[i];
}
