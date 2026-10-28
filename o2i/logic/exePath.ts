/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Used by native.ts only (Discord's main process): which renderer-supplied paths it agrees to stat or run.

import { basename, isAbsolute } from "path";

/**
 * Why `p` is refused, or null when it is acceptable: a full local path (no relative, drive-relative, UNC
 * or `\\?\` / `\\.\` device path) and, with `requireExe`, one whose file name is o2i.exe.
 */
export function enginePathProblem(p: unknown, requireExe: boolean): string | null {
    if (typeof p !== "string" || !p.trim()) return "No engine path set";
    if (/^[\\/]{2}/.test(p)) return `Network and device paths aren't allowed: ${p}`;
    if (!isAbsolute(p)) return `Use the full path to o2i.exe (like C:\\...\\o2i.exe): ${p}`;
    if (requireExe && basename(p).toLowerCase() !== "o2i.exe") return `The engine path must point to o2i.exe: ${p}`;
    return null;
}

/** Why `p` is refused as a folder to open, or null: a full local path (no relative, drive-relative, UNC or device path). */
export function folderPathProblem(p: unknown): string | null {
    if (typeof p !== "string" || !p.trim()) return "No folder set";
    if (/^[\\/]{2}/.test(p)) return "Network and device paths can't be opened";
    if (!isAbsolute(p)) return "That folder path isn't a full path";
    return null;
}

/** Why a stat result isn't an openable folder, or null: only a directory passes (opening a file would run it). */
export function folderKindProblem(stat: { isDirectory(): boolean; } | null): string | null {
    if (!stat) return "That folder doesn't exist";
    return stat.isDirectory() ? null : "That path isn't a folder";
}
