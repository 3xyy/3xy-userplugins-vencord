/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export class LineSplitter {
    private buf = "";

    push(chunk: string): string[] {
        this.buf += chunk;
        const parts = this.buf.split("\n");
        this.buf = parts.pop() ?? "";
        return parts.map(l => l.endsWith("\r") ? l.slice(0, -1) : l);
    }
}
