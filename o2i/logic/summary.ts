/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The system summary that goes into the exported logs zip (summary.json). Only o2i's own data: its
// settings are copied key by key from a fixed list, so nothing else (other plugins, tokens) can slip in.

export interface SummaryInput {
    generatedAt: string;
    /** From the engine's `ready` event. */
    engineVersion: string | null;
    vencord: { version: string | null; gitHash: string | null; };
    discord: { version: string | null; releaseChannel: string | null; build: number | null; buildHash?: string | null; };
    userAgent: string | null;
    /** The renderer's view of the engine (status, last error, audio, hotkey errors, …). */
    engine: Record<string, unknown>;
    /** The engine's last `devices` event. */
    devices: unknown;
    /** Discord's own voice settings and input devices (device names / ids only). */
    discordVoice: unknown;
    /** o2i's plugin settings (read only through `settingKeys`). */
    settings: object | null | undefined;
    /** The o2i setting keys to include. */
    settingKeys: readonly string[];
}

/** A JSON copy (functions / undefined dropped); null when it can't be serialised. */
function jsonCopy(v: unknown): unknown {
    try {
        const text = JSON.stringify(v);
        return text === undefined ? undefined : JSON.parse(text);
    } catch {
        return null;
    }
}

/** Copies of `store[key]` for each listed key that holds data; nothing else (never Object.prototype members). */
export function pickSettings(store: object | null | undefined, keys: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!store) return out;
    for (const key of keys) {
        if (key in Object.prototype) continue;
        let value: unknown;
        try {
            value = (store as Record<string, unknown>)[key];
        } catch {
            continue;
        }
        if (value === undefined || typeof value === "function") continue;
        const copy = jsonCopy(value);
        if (copy !== undefined) out[key] = copy;
    }
    return out;
}

export function buildSummary(i: SummaryInput): Record<string, unknown> {
    return {
        generatedAt: i.generatedAt,
        o2i: { engineVersion: i.engineVersion, engine: jsonCopy(i.engine) },
        vencord: jsonCopy(i.vencord),
        discord: jsonCopy(i.discord),
        userAgent: i.userAgent,
        devices: jsonCopy(i.devices) ?? null,
        discordVoice: jsonCopy(i.discordVoice) ?? null,
        settings: pickSettings(i.settings, i.settingKeys),
    };
}
