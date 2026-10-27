/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The plugin's rename (o2i to Output2Input): Vencord keeps each plugin's settings under its name, so the old
// settings object is copied to the new name once. Pure: index.tsx passes Vencord's plain plugin settings
// (no defaults filled in) and a writer that saves.

function isSettingsObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The new key holds real settings: an object with a stored profile (a default `{ enabled: false }` doesn't count). */
function hasStoredProfile(v: unknown): boolean {
    return isSettingsObject(v) && v.profile != null;
}

/**
 * Copies a deep clone of `plugins[from]` (all of it: `enabled`, the profile, soundMeta, mute and power state,
 * backups) to `plugins[to]` when `to` is missing or has no stored profile. The old key is left in place as a
 * backup. Returns true when it copied. `write` stores the copy (default: assigns into `plugins`); a writer
 * that throws makes this throw. Reads only plain values: never pass a proxy that fills in defaults.
 */
export function migratePluginSettings(
    plugins: Record<string, any>,
    from: string,
    to: string,
    write: (key: string, value: Record<string, unknown>) => void = (key, value) => { plugins[key] = value; }
): boolean {
    const old: unknown = Object.hasOwn(plugins, from) ? plugins[from] : undefined;
    if (!isSettingsObject(old)) return false;
    if (Object.hasOwn(plugins, to) && hasStoredProfile(plugins[to])) return false;
    // Settings are saved as JSON, so a JSON round trip is an exact deep copy of what's on disk.
    write(to, JSON.parse(JSON.stringify(old)));
    return true;
}
