/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useLayoutEffect } from "@webpack/common";
import type { RefObject } from "react";

/**
 * Gives our own Discord Modal container a fixed width (Discord's Modal drops `className`, so this sets
 * inline styles on the `[data-mana-component="modal"]` ancestor of our body element, never globally).
 * Returns false while the container isn't in the DOM yet.
 */
function fitModal(body: HTMLElement, width: string): boolean {
    const root = body.closest<HTMLElement>('[data-mana-component="modal"]');
    if (!root) return false;
    root.style.width = width;
    root.style.maxWidth = width;
    root.style.minWidth = "0";
    return true;
}

/** Sizes the modal that contains `body` to `width` (e.g. the old legacy-modal widths, 600 px / 440 px). */
export function useModalWidth(body: RefObject<HTMLElement | null>, width: string) {
    useLayoutEffect(() => {
        const el = body.current;
        if (!el || fitModal(el, width)) return;
        const id = requestAnimationFrame(() => {
            if (body.current) fitModal(body.current, width);
        });
        return () => cancelAnimationFrame(id);
    }, [width]);
}
