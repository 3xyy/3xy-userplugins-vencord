/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MediaMode } from "./types";

// Native module for catbox uploads (bypasses CSP)
let NativeModule: any = null;
export function setNativeModule(n: any) { NativeModule = n; }

async function toBase64(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function uploadToCatbox(url: string, userhash?: string): Promise<string> {
    console.log("[ExportChat] Catbox upload:", url.slice(0, 80), "native available:", !!NativeModule?.uploadToCatbox);
    if (NativeModule?.uploadToCatbox) {
        const result = await NativeModule.uploadToCatbox(url, userhash);
        console.log("[ExportChat] Catbox result:", result);
        return result;
    }
    throw new Error("Native catbox upload not available");
}

export async function processMedia(
    url: string,
    mode: MediaMode,
    userhash?: string
): Promise<string> {
    if (!url) return url;
    try {
        switch (mode) {
            case MediaMode.CDN: return url;
            case MediaMode.BASE64: return await toBase64(url);
            case MediaMode.CATBOX: return await uploadToCatbox(url, userhash);
            default: return url;
        }
    } catch (e) {
        console.warn("[ExportChat] processMedia failed for", url.slice(0, 60), "error:", e);
        return url;
    }
}

export async function processAllMedia(
    urls: string[],
    mode: MediaMode,
    userhash?: string,
    onProgress?: (done: number, total: number) => void,
    isAborted?: () => boolean
): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    if (mode === MediaMode.CDN) {
        for (const url of urls) results.set(url, url);
        return results;
    }

    const unique = [...new Set(urls)];
    let done = 0;
    const concurrency = 3;

    for (let i = 0; i < unique.length; i += concurrency) {
        // Cancelled: no further downloads/uploads (unprocessed URLs keep their original value)
        if (isAborted?.()) break;
        const batch = unique.slice(i, i + concurrency);
        const processed = await Promise.all(
            batch.map(url => processMedia(url, mode, userhash))
        );
        batch.forEach((url, j) => results.set(url, processed[j]));
        done += batch.length;
        onProgress?.(done, unique.length);
    }

    return results;
}
