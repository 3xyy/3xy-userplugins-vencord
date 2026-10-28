/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Text to speech helpers for the Soundboard tab's TTS section. Pure: no React, no engine.

/** The engine caps `speak` text at this many characters (code points). */
export const TTS_MAX_CHARS = 1000;

/** The Piper runtime is downloaded with the first natural voice (about this many MB). */
export const PIPER_RUNTIME_MB = 22;

/** One entry of the engine's `tts_voices` event. */
export interface TtsVoice {
    /** Opaque: pass it back to `speak` / `install_tts_voice`, never parse it. */
    id: string;
    name: string;
    source: "windows" | "piper";
    installed: boolean;
    size_mb?: number;
}

/** Characters the way the engine counts them (an emoji is one). */
export function charCount(text: string): number {
    return [...text].length;
}

/** The first TTS_MAX_CHARS characters, never splitting one. */
export function capText(text: string): string {
    const chars = [...text];
    return chars.length > TTS_MAX_CHARS ? chars.slice(0, TTS_MAX_CHARS).join("") : text;
}

/** "Windows voices" and "Natural voices" (Piper), each in the engine's order. */
export function groupVoices(voices: readonly TtsVoice[]): { windows: TtsVoice[]; natural: TtsVoice[]; } {
    return {
        windows: voices.filter(v => v.source === "windows"),
        natural: voices.filter(v => v.source === "piper"),
    };
}

/**
 * The voice to use: the remembered one while it is listed and installed, else the first installed
 * voice (Windows voices first), else null.
 */
export function pickVoice(voices: readonly TtsVoice[], remembered: string | null | undefined): string | null {
    const installed = voices.filter(v => v.installed);
    if (remembered) {
        const kept = installed.find(v => v.id === remembered);
        if (kept) return kept.id;
    }
    return (installed.find(v => v.source === "windows") ?? installed[0])?.id ?? null;
}

/** Some Piper voice is installed, so the runtime is on disk. */
export function runtimeInstalled(voices: readonly TtsVoice[]): boolean {
    return voices.some(v => v.source === "piper" && v.installed);
}

/** "Install (NN MB)", plus the runtime's size while no natural voice is installed yet. */
export function installLabel(voice: TtsVoice, runtimeReady: boolean): string {
    const mb = typeof voice.size_mb === "number" && Number.isFinite(voice.size_mb) ? Math.round(voice.size_mb) : null;
    if (runtimeReady) return mb === null ? "Install" : `Install (${mb} MB)`;
    return mb === null ? `Install (+ ${PIPER_RUNTIME_MB} MB)` : `Install (${mb} MB + ${PIPER_RUNTIME_MB} MB)`;
}

/** The first engine error that arrived after `afterSeq` (errors are numbered by native.ts); no message matching. */
export function firstErrorAfter(errors: readonly { seq: number; message: string; }[] | undefined, afterSeq: number): string | null {
    return errors?.find(e => e.seq > afterSeq)?.message ?? null;
}

/** Why Speak can't go: a hint ("" for none to show), or null when it can. */
export function speakBlocked(s: { running: boolean; audioOn: boolean; voice: string | null; text: string; }): string | null {
    if (!s.running || !s.audioOn) return "Turn on o2i to speak";
    if (!s.voice) return "No voice installed";
    if (!s.text.trim()) return "";
    return null;
}

/** A playing item that is speech (the engine names it "TTS: …" and gives it no path); speech can't be seeked. */
export function isSpeech(item: { name: string; path: string | null; }): boolean {
    return item.path === null && item.name.startsWith("TTS: ");
}
