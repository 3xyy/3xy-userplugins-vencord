/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    enableUploadEditor: {
        type: OptionType.BOOLEAN,
        description: "Show a brush button on attached images that opens the editor",
        default: true,
        restartNeeded: true,
    },
    enableViewerRotate: {
        type: OptionType.BOOLEAN,
        description: "Add Rotate left and Rotate right to the image right-click menu. It only turns the view, not the file",
        default: true,
        restartNeeded: true,
    },
    defaultSaveFormat: {
        type: OptionType.SELECT,
        description: "File type for edited images. \"Same as the original\" keeps JPEG and WebP as they are and saves anything else as PNG",
        options: [
            { label: "PNG (best quality)", value: "png", default: true },
            { label: "WebP (smaller files)", value: "webp" },
            { label: "Same as the original", value: "match" },
        ],
    },
    defaultSizeLimitMB: {
        type: OptionType.NUMBER,
        description: "Starting size limit in MB, 0 for no limit. Bigger edits get compressed to fit",
        default: 10,
    },
    defaultBrushColor: {
        type: OptionType.NUMBER,
        description: "Starting color for drawing tools (RGB number)",
        default: 0xED4245, // discord red
        hidden: true,
    },
    defaultBrushWidth: {
        type: OptionType.NUMBER,
        description: "Starting line width",
        default: 6,
        hidden: true,
    },
    rememberLastTool: {
        type: OptionType.BOOLEAN,
        description: "Open the editor with the tool you used last",
        default: true,
    },
});
