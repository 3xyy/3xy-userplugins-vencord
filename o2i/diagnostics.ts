/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Export logs": builds the system summary (o2i data only, see logic/summary.ts) and has native.ts zip
// it with the engine and plugin logs into Downloads. Also the version strings for the plugin-start line.

import { OptionType } from "@utils/types";
import { showToast, useState } from "@webpack/common";
import { getBuildNumber } from "@webpack/patcher";

import gitHash from "~git-hash";

import { discordInputDevices, isFallenBack, isPowerRestorePending, needsO2iFix, readDiscordVoice } from "./discordVoice";
import { engineClient, getNative, isPluginRunning } from "./engineClient";
import { olog } from "./log";
import { buildSummary } from "./logic/summary";
import { settings } from "./settings";
import type { ExportLogsResult } from "./types";

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function safe<T>(fn: () => T): T | null {
    try {
        return fn() ?? null;
    } catch {
        return null;
    }
}

function str(v: unknown): string | null {
    return typeof v === "string" && v ? v : null;
}

export function vencordVersion(): { version: string | null; gitHash: string | null; } {
    return { version: safe(() => str(VERSION)), gitHash: safe(() => str(gitHash)) };
}

/** Discord's app version (desktop only), or null. */
export function discordVersion(): string | null {
    return IS_DISCORD_DESKTOP ? safe(() => str(String(DiscordNative.app.getVersion()))) : null;
}

function discordInfo() {
    const env = safe(() => window.GLOBAL_ENV);
    const build = safe(() => getBuildNumber());
    return {
        version: discordVersion(),
        releaseChannel: str(env?.RELEASE_CHANNEL),
        build: typeof build === "number" && build > 0 ? build : null,
        buildHash: str(safe(() => env?.SENTRY_TAGS?.buildId)),
    };
}

/** o2i's own setting keys (its definition, minus the settings-page component, plus `enabled`). */
function settingKeys(): string[] {
    const keys = Object.entries(settings.def)
        .filter(([, def]) => def.type !== OptionType.COMPONENT)
        .map(([key]) => key);
    return ["enabled", ...keys];
}

function discordVoiceInfo() {
    let current: unknown;
    try {
        current = readDiscordVoice();
    } catch (e) {
        current = { error: errText(e) };
    }
    return { current, inputs: discordInputDevices(), fallenBack: isFallenBack(), powerRestorePending: isPowerRestorePending(), needsFix: needsO2iFix() };
}

/** The summary.json content (o2i data only). Never throws. */
export function collectSummary(): Record<string, unknown> {
    try {
        const snap = engineClient.getSnapshot();
        return buildSummary({
            generatedAt: new Date().toISOString(),
            engineVersion: snap.engineVersion ?? null,
            vencord: vencordVersion(),
            discord: discordInfo(),
            userAgent: safe(() => navigator.userAgent),
            engine: {
                pluginRunning: isPluginRunning(),
                powered: safe(() => settings.store.powered !== false),
                status: snap.status,
                generation: snap.generation,
                lastError: snap.lastError,
                audio: snap.state?.audio ?? null,
                audioError: snap.state?.error ?? null,
                hotkeyErrors: snap.state?.hotkey_errors ?? [],
                playing: snap.state?.playing?.length ?? 0,
                clipsFolder: snap.clips?.folder ?? null,
                clipCount: snap.clips?.clips?.length ?? null,
            },
            devices: snap.devices,
            discordVoice: safe(discordVoiceInfo),
            settings: safe(() => settings.plain),
            settingKeys: settingKeys(),
        });
    } catch (e) {
        return { summaryError: errText(e) };
    }
}

function toast(text: string, variant: "success" | "critical") {
    try {
        showToast({ text, variant });
    } catch (e) {
        olog.error("toast failed", e);
    }
}

async function runExport(): Promise<void> {
    if (!IS_DISCORD_DESKTOP) return;
    let summary: string;
    try {
        summary = JSON.stringify(collectSummary());
    } catch (e) {
        summary = JSON.stringify({ summaryError: errText(e) });
    }
    let res: ExportLogsResult;
    try {
        res = await getNative().exportLogs(summary);
    } catch (e) {
        olog.error("export logs failed", e); // native couldn't log this one
        res = { ok: false, error: errText(e) };
    }
    if (res.ok) toast(`o2i logs saved to Downloads: ${res.path.split(/[\\/]/).pop()}`, "success");
    else toast(`Couldn't export the o2i logs: ${res.error}`, "critical");
}

let inFlight: Promise<void> | null = null;

/** Zips the logs + summary into Downloads (one export at a time) and toasts the result. Never rejects. */
export function exportO2iLogs(): Promise<void> {
    inFlight ??= runExport()
        .catch(e => olog.error("export logs failed", e))
        .finally(() => { inFlight = null; });
    return inFlight;
}

/** For the Export logs buttons: [exporting, start]. */
export function useLogExport(): [boolean, () => void] {
    const [busy, setBusy] = useState(false);
    const start = () => {
        if (busy) return;
        setBusy(true);
        void exportO2iLogs().finally(() => setBusy(false));
    };
    return [busy, start];
}
