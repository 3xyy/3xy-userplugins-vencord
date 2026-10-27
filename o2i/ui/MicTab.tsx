/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useState } from "@webpack/common";

import { engineClient, setMicMuted, useMicMuted, useMicMuteSupported } from "../engineClient";
import { muteHotkeyConflict, muteKeyFiresWhileTyping, muteKeyIsSideButton } from "../logic/accel";
import { gateLine, thresholdDb } from "../logic/meter";
import { dbToRms, type O2iProfile } from "../logic/profile";
import { sourcesOf } from "../logic/sources";
import { settings, updateProfile } from "../settings";
import { Field, pct, Section, SwitchRow, ValueSlider } from "./controls";
import { HotkeyInput } from "./HotkeyInput";
import { LevelMeter, useSmoothedLevel } from "./LevelMeter";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

/** The engine's built-in values (o2i MicParams / mixer) for fields an older or imported profile may lack. */
const DEFAULTS = {
    voice_preset: "off",
    voice_intensity: 0.6,
    suppress_amount: 1,
    gate_threshold: 0.02,
    mic_volume: 1,
    master_volume: 1,
    monitor_mic_volume: 1,
    mic_quality: 100,
} as const;

const VOICE_PRESETS = [
    { label: "Off", value: "off" },
    { label: "Deeper", value: "manly" },
    { label: "Higher", value: "girly" },
];

/** The profile fields this tab shows. */
function micSignature(p: O2iProfile): string {
    return JSON.stringify([
        p.voice_preset, p.voice_intensity, p.suppress_enabled, p.suppress_amount, p.gate_enabled,
        p.gate_threshold, p.agc_enabled, p.mic_volume, p.master_volume,
        p.monitor_mic, p.monitor_mic_volume, p.gate_auto, p.mic_quality,
    ]);
}

/** Signature of the profile edit() last wrote; consumed by the first MicTab render that sees it. */
let ownSignature: string | null = null;

/**
 * Writes `patch` into the profile. Mic fields the profile still lacks are written with the engine's
 * defaults too: `configure` keeps the engine's current value for a missing field, so explicit values
 * keep the engine and this tab in agreement.
 */
function edit(patch: Partial<O2iProfile>) {
    updateProfile(p => {
        const next: O2iProfile = {
            ...p,
            voice_preset: p.voice_preset ?? DEFAULTS.voice_preset,
            voice_intensity: p.voice_intensity ?? DEFAULTS.voice_intensity,
            suppress_enabled: p.suppress_enabled ?? false,
            suppress_amount: p.suppress_amount ?? DEFAULTS.suppress_amount,
            gate_enabled: p.gate_enabled ?? false,
            gate_threshold: p.gate_threshold ?? DEFAULTS.gate_threshold,
            agc_enabled: p.agc_enabled ?? false,
            mic_volume: p.mic_volume ?? DEFAULTS.mic_volume,
            master_volume: p.master_volume ?? DEFAULTS.master_volume,
            monitor_mic: p.monitor_mic ?? false,
            monitor_mic_volume: p.monitor_mic_volume ?? DEFAULTS.monitor_mic_volume,
            gate_auto: p.gate_auto ?? false,
            gate_auto_margin_db: p.gate_auto_margin_db ?? 6,
            mic_quality: p.mic_quality ?? DEFAULTS.mic_quality,
            ...patch,
        };
        ownSignature = micSignature(next);
        return next;
    });
}

/**
 * The meter's commit: one write per threshold drag (on release) or key press, as RMS, and none when
 * the whole-dB value didn't change (e.g. the line was pressed but not moved). Reads the live profile.
 */
function commitThreshold(db: number) {
    const { profile } = settings.store;
    // Moving the line while auto is on takes manual control: auto off + the chosen threshold, in one write.
    if (profile?.gate_auto) {
        edit({ gate_auto: false, gate_threshold: dbToRms(db) });
        return;
    }
    const current = profile?.gate_threshold ?? DEFAULTS.gate_threshold;
    if (db !== thresholdDb(current)) edit({ gate_threshold: dbToRms(db) });
}

/** Slider drags the engine applies live (hear-yourself volume, quality); saved on release (see ValueSlider). */
const previewMonitor = (v: number) => engineClient.previewProfile(p => ({ ...p, monitor_mic_volume: Math.round(v) / 100 }));
const previewQuality = (v: number) => engineClient.previewProfile(p => ({ ...p, mic_quality: Math.round(v) }));
const previewEnd = (committed: boolean) => engineClient.previewProfile(null, !committed);

/**
 * Discord's Slider reads `initialValue` only on mount, so the tab is remounted (via this revision as
 * its key) when the mic fields change from outside this tab (re-import, another window...). Its own
 * edits don't bump it: a click on a slider's track commits on mousedown, so remounting on our own
 * writes (e.g. keying each slider by its stored value) would cut that drag short. Polls never touch it.
 */
function useExternalRevision(p: O2iProfile): number {
    const sig = micSignature(p);
    const [sync, setSync] = useState({ sig, rev: 0 });
    if (sig === sync.sig) return sync.rev;
    const own = sig === ownSignature;
    if (own) ownSignature = null;
    const next = { sig, rev: own ? sync.rev : sync.rev + 1 };
    setSync(next); // "state from the previous render" pattern: React re-renders right away
    return next.rev;
}

/** Three plain buttons instead of a Select: a Select's menu lives in a portal layer and picking from it can close the popout. */
function PresetPicker({ value, onPick }: { value: string; onPick(v: string): void; }) {
    return (
        <div className={cl("seg")} role="radiogroup" aria-label="Voice preset">
            {VOICE_PRESETS.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    className={cl("seg-btn", { "seg-btn-selected": o.value === value })}
                    onClick={() => {
                        if (o.value !== value) onPick(o.value);
                    }}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/**
 * The only part of the tab that re-renders on every poll (the engine's `state` object is new each poll).
 * Dragging the threshold re-renders only the LevelMeter inside it.
 */
function LiveMeter({ manualRms, gateOn, auto }: { manualRms: number; gateOn: boolean; auto: boolean; }) {
    const state = useEngineValue(s => s.state);
    const live = useEngineValue(s => s.state?.gate_threshold_live ?? null);
    const level = useSmoothedLevel(state?.input_level ?? 0);
    const line = gateLine(auto, live, manualRms);
    return (
        <LevelMeter
            level={level}
            thresholdRms={gateOn ? line.rms : null}
            auto={auto}
            learning={line.learning}
            onThresholdCommit={commitThreshold}
        />
    );
}

/** Where "Hear yourself" plays; only re-renders when the name changes. */
function MonitorTarget({ id }: { id: string | null; }) {
    const name = useEngineValue(s => (id ? s.devices?.outputs.find(d => d.id === id)?.name ?? null : null));
    return <div className={cl("note")}>Plays on {name ?? "your default output"}</div>;
}

/** The mute key would also fire on a soundboard key. Reads the live profile. */
function muteConflict(spec: string): string | null {
    const p = settings.store.profile;
    return muteHotkeyConflict(p, settings.store.soundMeta, spec, sourcesOf(p));
}

const setMuteHotkey = (v: string | null) => updateProfile(p => ({ ...p, mic_mute_hotkey: v }));

/** The note under the mute hotkey: what to know about the chosen key. */
function muteHotkeyNote(hotkey: string | null): string | null {
    if (!hotkey) return null;
    if (muteKeyFiresWhileTyping(hotkey)) return "This key also mutes and unmutes while you type.";
    if (muteKeyIsSideButton(hotkey)) return "Side mouse buttons may also go back or forward in Discord.";
    return "Works in other apps too, except ones running as admin.";
}

/** o2i's mic mute (only the mic: routed apps and soundboard sounds still go through) and its hotkey. */
function MuteSection({ hotkey }: { hotkey: string | null; }) {
    const muted = useMicMuted();
    const supported = useMicMuteSupported();
    const note = supported ? muteHotkeyNote(hotkey) : "Update the o2i engine to use mute.";
    return (
        <Section title="Mute">
            <SwitchRow
                label="Mute mic"
                hint="Only your mic. Apps and soundboard sounds keep playing."
                value={muted}
                disabled={!supported}
                onChange={setMicMuted}
            />
            <Field label="Mute hotkey" disabled={!supported}>
                <HotkeyInput kind="mute" value={hotkey} onChange={setMuteHotkey} validate={muteConflict} />
            </Field>
            {note && <div className={cl("note")}>{note}</div>}
        </Section>
    );
}

export function MicTab() {
    const { profile } = settings.use(["profile"]);
    const p = profile ?? { name: "default" };
    const preset = p.voice_preset ?? DEFAULTS.voice_preset;
    const suppressOn = !!p.suppress_enabled;
    const gateOn = !!p.gate_enabled;
    const gateAuto = !!p.gate_auto;
    const monitorOn = !!p.monitor_mic;
    const revision = useExternalRevision(p);

    return (
        <div className={cl("tab", "tab-mic")} key={revision}>
            <MuteSection hotkey={p.mic_mute_hotkey ?? null} />

            <Section title="Voice">
                <PresetPicker value={preset} onPick={v => edit({ voice_preset: v })} />
                <ValueSlider
                    label="Intensity"
                    min={0}
                    max={100}
                    value={(p.voice_intensity ?? DEFAULTS.voice_intensity) * 100}
                    format={pct}
                    disabled={preset === "off"}
                    onCommit={v => edit({ voice_intensity: Math.round(v) / 100 })}
                />
                <ValueSlider
                    label="Quality"
                    min={0}
                    max={100}
                    value={p.mic_quality ?? DEFAULTS.mic_quality}
                    format={pct}
                    onPreview={previewQuality}
                    onPreviewEnd={previewEnd}
                    onCommit={v => edit({ mic_quality: Math.round(v) })}
                />
                <div className={cl("note")}>Lower it to make your mic sound worse. 100 is your normal mic.</div>
            </Section>

            {/* Expanded panel: the right-hand column, next to Voice + Levels. */}
            <Section title="Cleanup" className={cl("section-tall")}>
                <div className={cl("group")}>
                    <SwitchRow
                        label="Noise cleanup"
                        hint="Removes background noise (RNNoise)"
                        value={suppressOn}
                        onChange={v => edit({ suppress_enabled: v })}
                    />
                    <ValueSlider
                        label="Amount"
                        min={0}
                        max={100}
                        value={(p.suppress_amount ?? DEFAULTS.suppress_amount) * 100}
                        format={pct}
                        disabled={!suppressOn}
                        onCommit={v => edit({ suppress_amount: Math.round(v) / 100 })}
                    />
                </div>
                <div className={cl("group")}>
                    <div className={cl("gate-head")}>
                        <SwitchRow
                            label="Noise gate"
                            hint={gateOn ? (gateAuto ? "Follows your background noise (drag the line to set it yourself)" : "Mutes your mic below the white line (drag it)") : "Mutes your mic below a threshold"}
                            value={gateOn}
                            onChange={v => edit({ gate_enabled: v })}
                        />
                        <button
                            type="button"
                            className={cl("pill", { "pill-on": gateAuto })}
                            aria-pressed={gateAuto}
                            disabled={!gateOn}
                            title="Set the gate threshold automatically from your background noise"
                            onClick={() => edit({ gate_auto: !gateAuto })}
                        >
                            Auto
                        </button>
                    </div>
                    <LiveMeter manualRms={p.gate_threshold ?? DEFAULTS.gate_threshold} gateOn={gateOn} auto={gateAuto} />
                </div>
                <SwitchRow
                    label="Auto gain"
                    hint="Levels your voice to a steady loudness"
                    value={!!p.agc_enabled}
                    onChange={v => edit({ agc_enabled: v })}
                />
            </Section>

            <Section title="Levels">
                <SwitchRow
                    label="Hear yourself"
                    hint="There's a slight delay. Use headphones so your mic doesn't pick it up."
                    value={monitorOn}
                    onChange={v => edit({ monitor_mic: v })}
                />
                <ValueSlider
                    label="Hear-yourself volume"
                    min={0}
                    max={200}
                    value={(p.monitor_mic_volume ?? DEFAULTS.monitor_mic_volume) * 100}
                    format={pct}
                    disabled={!monitorOn}
                    onPreview={previewMonitor}
                    onPreviewEnd={previewEnd}
                    onCommit={v => edit({ monitor_mic_volume: Math.round(v) / 100 })}
                />
                {monitorOn && <MonitorTarget id={p.sb_monitor_device ?? null} />}
                <ValueSlider
                    label="Mic volume"
                    min={0}
                    max={200}
                    value={(p.mic_volume ?? DEFAULTS.mic_volume) * 100}
                    format={pct}
                    onCommit={v => edit({ mic_volume: Math.round(v) / 100 })}
                />
                <ValueSlider
                    label="Master (mic + apps + sounds)"
                    min={0}
                    max={200}
                    value={(p.master_volume ?? DEFAULTS.master_volume) * 100}
                    format={pct}
                    onCommit={v => edit({ master_volume: Math.round(v) / 100 })}
                />
            </Section>
        </div>
    );
}
