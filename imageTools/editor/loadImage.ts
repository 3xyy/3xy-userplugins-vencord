/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Load a File (or object URL) into a fresh canvas at the image's native resolution. */
export async function fileToCanvas(source: File): Promise<HTMLCanvasElement> {
    const url = URL.createObjectURL(source);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error("Failed to decode image"));
            i.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}
