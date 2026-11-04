/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IS_MAC } from "@utils/constants";

// Shortcut hints in tooltips, in the platform's own notation. The key handlers (EditorModal) accept Ctrl
// or ⌘ either way. Wheel zoom (CanvasStage) is Ctrl-only on every platform; a trackpad pinch arrives as
// Ctrl+wheel, so it works too.
export const UNDO_LABEL = IS_MAC ? "Undo (⌘Z)" : "Undo (Ctrl+Z)";
export const REDO_LABEL = IS_MAC ? "Redo (⌘⇧Z)" : "Redo (Ctrl+Y)";
export const ZOOM_HINT = IS_MAC
    ? "Click to fit the image (⌘0). Zoom with a pinch or Ctrl+scroll. Pan with the middle mouse button or Space+drag."
    : "Click to fit the image (Ctrl+0). Zoom with Ctrl+scroll. Pan with the middle mouse button or Space+drag.";
