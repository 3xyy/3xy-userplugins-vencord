/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const EDIT_DOC_SYMBOL = Symbol("vcImageToolsDoc"); // stashes the live Doc on an edited CloudUpload

export const DEFAULTS = {
    color: 0xED4245,
    width: 6,
    fontSize: 28,
    // 1-100, slider right is stronger (editor/region.ts). 50 is a 13 px blur / 18 px blocks on images up to 1 MP
    // (19 px / 25 px on a 1080p screenshot), at least as strong as the old 12 px defaults.
    blurIntensity: 50,
    pixelIntensity: 50,
    highlightOpacity: 0.4,
};

export const SIZE_PRESETS_MB = [8, 10, 25, 50, 100, 0]; // 0 = No limit
