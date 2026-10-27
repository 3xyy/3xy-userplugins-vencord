/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** RGB int + alpha (0..1) → "rgba(r,g,b,a)". */
export function withAlpha(n: number, a: number): string {
    const r = (n >> 16) & 0xFF, g = (n >> 8) & 0xFF, b = n & 0xFF;
    return `rgba(${r},${g},${b},${a})`;
}
