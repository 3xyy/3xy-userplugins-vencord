/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast } from "@webpack/common";

import { engineClient, getNative } from "./engineClient";
import { olog } from "./log";
import type { O2iProfile } from "./logic/profile";
import { migratePathsIfNeeded, settings } from "./settings";

function isProfile(v: unknown): v is O2iProfile {
    return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { name?: unknown; }).name === "string";
}

/**
 * Imports the standalone o2i app's last profile (via `o2i.exe --dump-config`) into the plugin settings.
 * Runs once (until `imported` is set) unless forced. Returns whether a profile was imported.
 */
export async function importLegacy(force = false): Promise<boolean> {
    if (!IS_DISCORD_DESKTOP) return false;
    if (settings.store.imported && !force) return false;
    const path = (settings.store.enginePath ?? "").trim();
    if (!path) return false;

    try {
        const res = await getNative().dumpLegacyConfig(path);
        if (!res.ok) {
            olog.warn(`import from the o2i app failed: ${res.error}`);
            return false;
        }
        if (!isProfile(res.profile)) {
            olog.info("import: the o2i app has no saved profile");
            return false;
        }
        settings.store.profile = res.profile;
        settings.store.imported = true;
        olog.info(`imported o2i app settings (profile "${res.profile.name}")`);
        // The o2i app keys sounds by file name: move them to paths again (the first backup is kept).
        settings.store.migratedPaths = false;
        migratePathsIfNeeded();
        try {
            showToast({ text: "Imported your settings from the o2i app", variant: "success" });
        } catch (e) {
            olog.error("toast failed", e);
        }
        engineClient.configureSoon();
        return true;
    } catch (e) {
        olog.error("import failed", e);
        return false;
    }
}
