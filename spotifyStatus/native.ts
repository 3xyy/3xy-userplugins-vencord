/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { execFile } from "child_process";
import smtcScript from "file://smtc.ps1"; // inlined at build time (file:// loader in scripts/build/common.mjs)
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SmtcTrack {
    ok: boolean;
    title: string;
    artist: string;
    album: string;
    isPlaying: boolean;
    position: number;
    duration: number;
    appId: string;
    error?: string;
    reason?: string;
}

const failed = (fields: Partial<SmtcTrack>): SmtcTrack => ({
    ok: false, title: "", artist: "", album: "", isPlaying: false, position: 0, duration: 0, appId: "", ...fields
});

// The script is bundled, so the plugin works from any folder name and any dist location. PowerShell's
// -File needs a real file: keep one copy at a fixed path in Vencord's data folder (next to settings/ and
// themes/), rewritten only when its content differs from the bundled script. No per-session temp files.
const SCRIPT_DIR = join(DATA_DIR, "SpotifyStatus");
const SCRIPT_PATH = join(SCRIPT_DIR, "smtc.ps1");
// UTF-8 BOM so Windows PowerShell 5.1 never reads the file in the ANSI code page.
const SCRIPT_CONTENT = String.fromCharCode(0xFEFF) + smtcScript;

function ensureScript(): string {
    let current: string | null = null;
    try { current = readFileSync(SCRIPT_PATH, "utf8"); } catch { /* missing: write it */ }
    if (current !== SCRIPT_CONTENT) {
        mkdirSync(SCRIPT_DIR, { recursive: true });
        writeFileSync(SCRIPT_PATH, SCRIPT_CONTENT, "utf8");
    }
    return SCRIPT_PATH;
}

/** Case-insensitive replace-all without building a RegExp from a path. */
function replaceAllCI(s: string, find: string, repl: string): string {
    if (!find) return s;
    const hay = s.toLowerCase(), needle = find.toLowerCase();
    let out = "", from = 0, at: number;
    while ((at = hay.indexOf(needle, from)) !== -1) {
        out += s.slice(from, at) + repl;
        from = at + needle.length;
    }
    return out + s.slice(from);
}

/** Keep the Windows username out of error text (it ends up in the console and Discord's log file). */
function redact(s: string): string {
    return replaceAllCI(replaceAllCI(s, SCRIPT_PATH, "smtc.ps1"), homedir(), "~");
}

function runSmtc(): Promise<SmtcTrack> {
    return new Promise(resolve => {
        let path: string;
        try {
            path = ensureScript();
        } catch (e: any) {
            resolve(failed({ error: redact(`couldn't write smtc.ps1 to Vencord's data folder: ${e?.message ?? e}`) }));
            return;
        }
        execFile(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", path],
            { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    // err.message already ends with stderr ("Command failed: <cmd>\n<stderr>")
                    resolve(failed({ error: redact(`exec failed${err.killed ? " (timed out)" : ""}: ${err.message}`).slice(0, 400) }));
                    return;
                }
                const text = (stdout || "").trim();
                if (!text) {
                    resolve(failed({ error: redact(`empty stdout; stderr=${stderr?.slice(0, 200) ?? ""}`) }));
                    return;
                }
                try {
                    const obj = JSON.parse(text);
                    resolve({
                        ok: Boolean(obj?.ok),
                        title: String(obj?.title ?? ""),
                        artist: String(obj?.artist ?? ""),
                        album: String(obj?.album ?? ""),
                        isPlaying: Boolean(obj?.isPlaying),
                        position: Number(obj?.position) || 0,
                        duration: Number(obj?.duration) || 0,
                        appId: String(obj?.appId ?? ""),
                        error: obj?.error ? redact(String(obj.error)) : undefined,
                        reason: obj?.reason ? String(obj.reason) : undefined,
                    });
                } catch (e: any) {
                    resolve(failed({ error: redact(`parse failed: ${e?.message}; raw=${text.slice(0, 200)}`) }));
                }
            }
        );
    });
}

// At most one PowerShell at a time: concurrent callers (poll + settings change + ...) share the run.
let inFlight: Promise<SmtcTrack> | null = null;

export function fetchSmtc(_: any): Promise<SmtcTrack | null> {
    if (process.platform !== "win32") {
        return Promise.resolve(failed({ reason: "unsupported", error: "Windows media controls only work on Windows" }));
    }
    if (!inFlight) {
        inFlight = runSmtc().finally(() => { inFlight = null; });
    }
    return inFlight;
}
