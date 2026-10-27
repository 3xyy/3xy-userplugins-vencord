/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const rotation = new WeakMap<HTMLElement, number>();

export function rotateMedia(el: HTMLElement, deltaDeg: number) {
    const next = ((rotation.get(el) ?? 0) + deltaDeg) % 360;
    rotation.set(el, next);
    el.style.transition = "transform .15s ease";
    el.style.transform = `rotate(${next}deg)`;
    // when sideways, scale so the rotated bounds fit the original box
    const sideways = next % 180 !== 0;
    if (sideways) {
        const w = el.clientWidth, h = el.clientHeight;
        const scale = Math.min(1, h / w, w / h) || 1;
        el.style.transform = `rotate(${next}deg) scale(${scale})`;
    }
}

/** Find the <img>/<video> inside the fullscreen viewer from a context-menu target. */
export function findViewerMedia(target: HTMLElement | null): HTMLElement | null {
    if (!target) return null;
    if (target.tagName === "IMG" || target.tagName === "VIDEO") return target;
    return target.querySelector("img,video");
}
