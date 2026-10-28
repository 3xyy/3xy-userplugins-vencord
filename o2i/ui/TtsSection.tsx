/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Text to speech, at the top of the Soundboard tab (collapsible): a text box, a voice list (Windows
// voices and natural voices, which are downloaded on request), a speed slider and Speak. The engine
// does the speaking (Windows voices or Piper); speech shows in Now playing like any sound.

import { Button } from "@components/Button";
import { classNameFactory } from "@utils/css";
import { useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent } from "react";

import { engineClient } from "../engineClient";
import { capText, charCount, firstErrorAfter, groupVoices, installLabel, pickVoice, runtimeInstalled, speakBlocked, TTS_MAX_CHARS, type TtsVoice } from "../logic/tts";
import { settings, updateProfile } from "../settings";
import type { EngineSnapshot } from "../types";
import { pct, Section, ValueSlider } from "./controls";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

/** How long a list_tts_voices request may go unanswered before the engine counts as too old for speech. */
const VOICES_TIMEOUT_MS = 3000;
/** An Install press waits this long for the engine's state to show the install before it stops holding the buttons. */
const INSTALL_HOLD_MS = 4000;

const selectRunning = (s: EngineSnapshot) => s.status === "running";
const selectAudioOn = (s: EngineSnapshot) => s.state?.audio === "running";
const selectGeneration = (s: EngineSnapshot) => s.generation;
const selectVoices = (s: EngineSnapshot) => s.ttsVoices;
/** native.ts from before text to speech never sets the voice counter. */
const selectNativeKnowsTts = (s: EngineSnapshot) => s.seq.ttsVoices !== undefined;
const selectInstallId = (s: EngineSnapshot) => s.state?.tts_install?.id ?? null;
/** Whole percent, so a progress tick that changes nothing visible doesn't re-render. */
const selectInstallPct = (s: EngineSnapshot) => Math.round(Math.min(1, Math.max(0, s.state?.tts_install?.progress ?? 0)) * 100);

/** Kept across tab switches in this session (a plain boolean: no React at module scope). */
let sectionOpen = false;

/** Drag previews: the engine speaks at the slider's value live; saved on release (see ValueSlider). */
const previewVolume = (v: number) => engineClient.previewProfile(p => ({ ...p, tts_volume: Math.round(v) / 100 }));
const previewVolumeEnd = (committed: boolean) => engineClient.previewProfile(null, !committed);

const rateText = (v: number) => `${(Math.round(v / 5) * 5 / 100).toFixed(2)}x`;

export function TtsSection() {
    const [open, setOpen] = useState(sectionOpen);
    const toggle = () => {
        sectionOpen = !open;
        setOpen(!open);
    };
    return (
        <Section
            title="Text to speech"
            action={
                <button
                    type="button"
                    className={cl("mini-btn")}
                    aria-expanded={open}
                    aria-label={open ? "Hide text to speech" : "Show text to speech"}
                    onClick={toggle}
                >
                    {open ? "Hide" : "Show"}
                </button>
            }
        >
            {open && <TtsBody />}
        </Section>
    );
}

function TtsBody() {
    const { ttsVoice, ttsRate, profile } = settings.use(["ttsVoice", "ttsRate", "profile"]);
    const running = useEngineValue(selectRunning);
    const audioOn = useEngineValue(selectAudioOn);
    const generation = useEngineValue(selectGeneration);
    const voicesEv = useEngineValue(selectVoices);
    const nativeKnowsTts = useEngineValue(selectNativeKnowsTts);
    const installId = useEngineValue(selectInstallId);
    const installPct = useEngineValue(selectInstallPct);

    const [text, setText] = useState("");
    /** The error counter when Speak / Install was pressed; null: nothing to show. */
    const [errBase, setErrBase] = useState<number | null>(null);
    const error = useEngineValue(s => errBase === null ? null : firstErrorAfter(s.recentErrors, errBase));
    /** The engine never answered list_tts_voices: it predates text to speech. */
    const [oldEngine, setOldEngine] = useState(false);
    /** An Install just pressed that the engine's state doesn't show yet. */
    const [requested, setRequested] = useState<string | null>(null);

    const voices: TtsVoice[] = voicesEv?.voices ?? [];
    const rate = typeof ttsRate === "number" && ttsRate >= 0.5 && ttsRate <= 2 ? ttsRate : 1;
    const voice = pickVoice(voices, ttsVoice);
    const volume = typeof profile?.tts_volume === "number" ? Math.min(2, Math.max(0, profile.tts_volume)) : 1;
    const installing = installId ?? requested;

    // Ask for the voices when the section opens and whenever an engine (re)starts; no reply in time: an engine from before speech.
    useEffect(() => {
        if (!running || !nativeKnowsTts) return;
        const before = engineClient.getSnapshot().seq.ttsVoices ?? 0;
        engineClient.send({ cmd: "list_tts_voices" });
        const t = setTimeout(() => {
            if ((engineClient.getSnapshot().seq.ttsVoices ?? 0) === before) setOldEngine(true);
        }, VOICES_TIMEOUT_MS);
        return () => clearTimeout(t);
    }, [running, nativeKnowsTts, generation]);

    // Any reply proves the engine knows speech.
    useEffect(() => {
        if (voicesEv) setOldEngine(false);
    }, [voicesEv]);

    // An install finished (or failed): list again, as the engine's list may have changed.
    const prevInstall = useRef<string | null>(null);
    useEffect(() => {
        if (prevInstall.current && !installId) {
            setRequested(null);
            engineClient.send({ cmd: "list_tts_voices" });
        }
        if (installId) setRequested(null);
        prevInstall.current = installId;
    }, [installId]);

    // An Install the state never showed (it failed at once): stop holding the other buttons.
    useEffect(() => {
        if (!requested) return;
        const t = setTimeout(() => setRequested(null), INSTALL_HOLD_MS);
        return () => clearTimeout(t);
    }, [requested]);

    if (!nativeKnowsTts) return <div className={cl("note")}>Restart Discord to finish updating o2i</div>;
    if (oldEngine) return <div className={cl("note")}>Update the o2i engine to use text to speech</div>;

    const errorSeq = () => engineClient.getSnapshot().errorSeq ?? 0;
    const blocked = speakBlocked({ running, audioOn, voice, text });
    const speak = () => {
        if (blocked !== null || !voice) return;
        setErrBase(errorSeq());
        if (voice !== ttsVoice) settings.store.ttsVoice = voice;
        engineClient.send({ cmd: "speak", text: text.trim(), voice, rate });
    };
    const install = (v: TtsVoice) => {
        if (installing || !running) return;
        setErrBase(errorSeq());
        setRequested(v.id);
        engineClient.send({ cmd: "install_tts_voice", id: v.id });
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        speak();
    };

    const groups = groupVoices(voices);
    const runtimeReady = runtimeInstalled(voices);
    const length = charCount(text);
    const pick = (id: string) => { settings.store.ttsVoice = id; };

    return (
        <>
            <div className={cl("tts-box")}>
                <textarea
                    className={cl("textarea")}
                    value={text}
                    rows={3}
                    placeholder="Type something to say"
                    aria-label="Text to speak"
                    spellCheck={false}
                    onChange={e => {
                        setText(capText(e.currentTarget.value));
                        setErrBase(null);
                    }}
                    onKeyDown={onKeyDown}
                />
                <span className={cl("tts-count", { "tts-count-full": length >= TTS_MAX_CHARS })}>{length}/{TTS_MAX_CHARS}</span>
            </div>

            {voices.length === 0
                ? <div className={cl("note")}>{running ? "Loading voices…" : "No voices yet"}</div>
                : (
                    <div className={cl("tts-voices")} role="radiogroup" aria-label="Voice">
                        <VoiceGroup
                            title="Windows voices"
                            voices={groups.windows}
                            selected={voice}
                            installing={installing}
                            installPct={installPct}
                            runtimeReady={runtimeReady}
                            canInstall={running}
                            onPick={pick}
                            onInstall={install}
                        />
                        <VoiceGroup
                            title="Natural voices"
                            voices={groups.natural}
                            selected={voice}
                            installing={installing}
                            installPct={installPct}
                            runtimeReady={runtimeReady}
                            canInstall={running}
                            onPick={pick}
                            onInstall={install}
                        />
                    </div>
                )}

            <ValueSlider
                label="Speed"
                min={50}
                max={200}
                value={Math.round(rate * 100)}
                format={rateText}
                onCommit={v => { settings.store.ttsRate = Math.round(v / 5) * 5 / 100; }}
            />
            <ValueSlider
                label="Volume"
                min={0}
                max={200}
                value={Math.round(volume * 100)}
                format={pct}
                onPreview={previewVolume}
                onPreviewEnd={previewVolumeEnd}
                onCommit={v => updateProfile(p => ({ ...p, tts_volume: Math.round(v) / 100 }))}
            />

            <div className={cl("tts-actions")}>
                <Button size="small" variant="primary" disabled={blocked !== null} onClick={speak}>Speak</Button>
                {blocked && <span className={cl("note")}>{blocked}</span>}
            </div>
            {error && <div className={cl("tts-error")} role="alert">{error}</div>}
        </>
    );
}

function VoiceGroup({ title, voices, selected, installing, installPct, runtimeReady, canInstall, onPick, onInstall }: {
    title: string;
    voices: TtsVoice[];
    selected: string | null;
    installing: string | null;
    installPct: number;
    runtimeReady: boolean;
    canInstall: boolean;
    onPick(id: string): void;
    onInstall(v: TtsVoice): void;
}) {
    if (!voices.length) return null;
    return (
        <div className={cl("tts-group")}>
            <div className={cl("tts-group-title")}>{title}</div>
            {voices.map(v => (
                <div key={v.id} className={cl("tts-voice", { "tts-voice-selected": v.installed && v.id === selected })}>
                    {v.installed
                        ? (
                            <button
                                type="button"
                                role="radio"
                                aria-checked={v.id === selected}
                                className={cl("tts-voice-pick")}
                                onClick={() => onPick(v.id)}
                            >
                                {v.name}
                            </button>
                        )
                        : <span className={cl("tts-voice-name")}>{v.name}</span>}
                    {!v.installed && (installing === v.id
                        ? (
                            <span className={cl("tts-progress")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={installPct} aria-label={`Installing ${v.name}`}>
                                <span className={cl("np-bar", "tts-bar")}>
                                    <span className={cl("np-fill", "tts-fill")} style={{ width: `${installPct}%` }} />
                                </span>
                                <span className={cl("value")}>{installPct}%</span>
                            </span>
                        )
                        : (
                            <button
                                type="button"
                                className={cl("mini-btn")}
                                disabled={!!installing || !canInstall}
                                aria-label={`Install ${v.name}`}
                                onClick={() => onInstall(v)}
                            >
                                {installLabel(v, runtimeReady)}
                            </button>
                        ))}
                </div>
            ))}
        </div>
    );
}
