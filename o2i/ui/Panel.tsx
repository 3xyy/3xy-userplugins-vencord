/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { classNameFactory } from "@utils/css";
import { showToast, TabBar, useCallback, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { useLogExport } from "../diagnostics";
import { fixDiscordVoice, isFallenBack, isPowerRestorePending, needsO2iFix } from "../discordVoice";
import { isPluginRunning, setMicMuted, useMicMuted, useMicMuteSupported, usePluginRunning } from "../engineClient";
import { olog } from "../log";
import { isPowered, setPowered, usePowered } from "../power";
import type { EngineSnapshot } from "../types";
import { AppsTab } from "./AppsTab";
import { ClipsTab } from "./ClipsTab";
import { MicTab } from "./MicTab";
import { logUiCrash } from "./uiErrors";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

/** How often the open panel re-reads Discord's voice settings (not per poll: that runs at 20 Hz). */
const FIX_CHECK_MS = 500;

type Tab = "mic" | "apps" | "clips";
/** Remembered across popout opens (module state, this Discord session only). */
let lastTab: Tab = "mic";

type FixState = ReturnType<typeof needsO2iFix>;
type Tone = "positive" | "danger" | "muted";

const selectStatus = (s: EngineSnapshot) => s.status;
const selectLastError = (s: EngineSnapshot) => s.lastError;
const selectAudio = (s: EngineSnapshot) => s.state?.audio ?? null;
const selectAudioError = (s: EngineSnapshot) => s.state?.error ?? null;
/** The engine can't deliver audio right now (a Fix would only last until the fallback acts again). */
const selectDown = (s: EngineSnapshot) => s.status !== "running" || s.state?.audio === "error";

function toast(text: string) {
    try {
        showToast({ text, variant: "critical" });
    } catch (e) {
        olog.error("toast failed", e);
    }
}

/** needsO2iFix() (never throws), re-checked every 500 ms while mounted; re-renders only when the result changes. */
function useVoiceFix(): [FixState, () => void] {
    const [fix, setFix] = useState<FixState>(needsO2iFix);
    const refresh = useCallback(() => {
        const next = needsO2iFix();
        setFix(prev => prev.needed === next.needed && prev.cableMissing === next.cableMissing ? prev : next);
    }, []);
    useEffect(() => {
        const id = setInterval(refresh, FIX_CHECK_MS);
        return () => clearInterval(id);
    }, [refresh]);
    return [fix, refresh];
}

function openSettings(close: () => void) {
    close();
    try {
        const plugin = plugins.Output2Input;
        if (plugin) openPluginModal(plugin);
    } catch (e) {
        olog.error("couldn't open the o2i settings", e);
    }
}

const TONE_DOT: Record<Tone, string> = { positive: "dot-on", danger: "dot-danger", muted: "" };

function statusLine(status: EngineSnapshot["status"], audio: string | null): [string, Tone] {
    switch (status) {
        case "unset": return ["Not set up", "danger"];
        case "starting": return ["Starting…", "muted"];
        case "crashed": return ["Restarting…", "danger"];
        case "stopped": return ["Stopped", "muted"];
        case "running":
            if (audio === "error") return ["Audio error", "danger"];
            return audio === "running" ? ["Running", "positive"] : ["Audio off", "muted"];
    }
}

/** Two arrows pointing out to opposite corners (Material "open_in_full", Apache-2.0). */
function ExpandIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10L21 11Z" />
        </svg>
    );
}

/** An arrow down onto a tray (Material "file_download", Apache-2.0). */
function ExportIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z" />
        </svg>
    );
}

/** Zips o2i's logs + a system summary into Downloads (toasts the result). */
function ExportLogsButton() {
    const [busy, start] = useLogExport();
    return (
        <button
            type="button"
            className={cl("icon-btn", { "icon-btn-busy": busy })}
            aria-label="Export logs"
            title={busy ? "Exporting logs…" : "Export logs"}
            disabled={busy}
            onClick={start}
        >
            <ExportIcon />
        </button>
    );
}

/** Two arrows pointing in from opposite corners (Material "close_fullscreen", Apache-2.0). */
function ShrinkIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41ZM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22Z" />
        </svg>
    );
}

/** The power symbol (Material "power_settings_new", Apache-2.0). */
function PowerIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M13 3h-2v10h2V3Zm4.83 2.17-1.42 1.42A6.92 6.92 0 0 1 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17A8.93 8.93 0 0 0 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83Z" />
        </svg>
    );
}

/** A microphone (Material "mic", Apache-2.0). */
function MicIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3Zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7Z" />
        </svg>
    );
}

/** A crossed-out microphone (Material "mic_off", Apache-2.0). */
function MicOffIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28Zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99ZM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3Z" />
        </svg>
    );
}

/** Mutes or unmutes o2i's mic (apps and sounds keep playing). Red while muted; hidden while the engine can't mute. */
function MuteButton() {
    const muted = useMicMuted();
    const supported = useMicMuteSupported();
    if (!supported) return null;
    const label = muted ? "Unmute mic" : "Mute mic";
    return (
        <button
            type="button"
            className={cl("icon-btn", { "icon-btn-muted": muted })}
            aria-label={label}
            aria-pressed={muted}
            title={label}
            onClick={() => setMicMuted(!muted)}
        >
            {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
    );
}

/** Turns o2i off (engine stopped, Discord on the real mic) or back on. Green while on. */
function PowerButton({ on }: { on: boolean; }) {
    const label = on ? "Turn o2i off" : "Turn o2i on";
    return (
        <button
            type="button"
            className={cl("icon-btn", { "icon-btn-power-on": on })}
            aria-label={label}
            title={label}
            onClick={() => setPowered(!on)}
        >
            <PowerIcon />
        </button>
    );
}

/**
 * One line: name, coloured dot, short status ("Off" while turned off), the error (truncated, full text on
 * hover), Settings when unset, then mute (hidden while off), power, export logs and expand (popout) or
 * shrink (modal). In the modal Discord's own title already says "o2i".
 */
function EngineStatus({ onClose, expanded, powered, onExpand, onShrink }: {
    onClose(): void;
    expanded: boolean;
    powered: boolean;
    onExpand?(): void;
    onShrink?(): void;
}) {
    const status = useEngineValue(selectStatus);
    const lastError = useEngineValue(selectLastError);
    const audio = useEngineValue(selectAudio);
    const audioError = useEngineValue(selectAudioError);
    const [label, tone]: [string, Tone] = powered ? statusLine(status, audio) : ["Off", "muted"];

    // While turned off there is nothing to explain here: the panel body says it.
    let detail: string | null = null;
    let detailTitle: string | null = null;
    if (powered && (status === "unset" || status === "crashed")) {
        detail = lastError;
        detailTitle = status === "crashed" ? `The o2i engine crashed and is restarting.\n${lastError ?? ""}` : lastError;
    } else if (powered && status === "running" && audio === "error") {
        detail = audioError ?? "retrying";
        detailTitle = `${audioError ?? "Audio error"}\no2i tries again every 2 seconds.`;
    }

    return (
        <div className={cl("header")}>
            {!expanded && <span className={cl("title")}>o2i</span>}
            <span className={cl("dot", TONE_DOT[tone])} aria-hidden="true" />
            <span className={cl("status-text")}>{label}</span>
            {detail && <span className={cl("status-detail")} title={detailTitle ?? detail}>{detail}</span>}
            <div className={cl("header-end")}>
                {powered && status === "unset" && (
                    <button
                        type="button"
                        className={cl("mini-btn", "mini-btn-brand")}
                        onClick={() => openSettings(onClose)}
                    >
                        Open settings
                    </button>
                )}
                {powered && <MuteButton />}
                <PowerButton on={powered} />
                <ExportLogsButton />
                {expanded
                    ? (
                        <button type="button" className={cl("icon-btn")} aria-label="Shrink" title="Shrink" onClick={onShrink ?? onClose}>
                            <ShrinkIcon />
                        </button>
                    )
                    : onExpand && (
                        <button type="button" className={cl("icon-btn")} aria-label="Expand" title="Expand" onClick={onExpand}>
                            <ExpandIcon />
                        </button>
                    )}
            </div>
        </div>
    );
}

function Banner({ title, detail, children }: { title: string; detail: string; children?: ReactNode; }) {
    return (
        <div className={cl("banner")} role="status">
            <div className={cl("banner-text")}>
                <div className={cl("banner-title")}>{title}</div>
                <div className={cl("banner-detail")} title={detail}>{detail}</div>
            </div>
            {children}
        </div>
    );
}

function VoiceWarning() {
    const [fix, refresh] = useVoiceFix();
    const down = useEngineValue(selectDown);
    // The button hides with the plugin, so this is a second guard: never move Discord onto o2i once it's off.
    const running = usePluginRunning();
    if (!fix.needed || !running) return null;

    if (fix.cableMissing) {
        return (
            <Banner title="Discord isn't using o2i's mic" detail="CABLE Output (VB-CABLE) isn't in Discord's input devices." />
        );
    }

    const onFix = () => {
        // Never CABLE Output without an engine: not while the plugin or o2i is off.
        if (!isPluginRunning() || !isPowered()) return;
        if (!fixDiscordVoice()) toast("Couldn't switch Discord to CABLE Output");
        refresh();
    };

    const why = isPowerRestorePending()
        ? "Discord stays on your real mic for now. o2i switches it back to CABLE Output once its audio is running."
        : isFallenBack()
            ? "o2i stopped sending audio, so Discord was moved to your real mic."
            : "Discord's input should be CABLE Output, with Discord's noise suppression, echo cancellation and auto gain off.";
    // This used to be the Fix button's own label. It goes first so the 2-line clamp keeps it.
    const detail = down ? `o2i is down, so a fix now would just fall back again. ${why}` : why;

    return (
        <Banner title="Discord isn't using o2i's mic" detail={detail}>
            <Button size="small" variant={down ? "secondary" : "primary"} onClick={onFix}>Fix</Button>
        </Banner>
    );
}

/** While o2i is turned off: what that means, and a big Turn on (the tabs need a running engine). */
function PowerOff() {
    return (
        <div className={cl("off")}>
            <span className={cl("off-icon")}><PowerIcon size={32} /></span>
            <div className={cl("off-title")}>o2i is off</div>
            <div className={cl("off-text")}>
                The engine isn't running, so mic processing, routed apps, hotkeys and the soundboard are off.
                Discord uses your real mic until you turn o2i back on.
            </div>
            <Button className={cl("off-btn")} onClick={() => setPowered(true)}>Turn on</Button>
        </div>
    );
}

/**
 * The o2i panel: in the account-panel popout (`onExpand` set: shows the expand button) or, `expanded`,
 * in the large modal (shows the shrink button: `onShrink`, else `onClose`). While o2i is turned off it
 * shows only the header and the "o2i is off" state.
 */
export function Panel({ onClose, expanded = false, onExpand, onShrink }: {
    onClose(): void;
    expanded?: boolean;
    onExpand?(): void;
    onShrink?(): void;
}) {
    const [tab, setTab] = useState<Tab>(lastTab);
    const powered = usePowered();
    const select = (t: Tab) => {
        lastTab = t;
        setTab(t);
    };

    if (!powered) {
        return (
            <div className={cl("panel", { "panel-expanded": expanded })}>
                <EngineStatus onClose={onClose} expanded={expanded} powered={false} onExpand={onExpand} onShrink={onShrink} />
                <div className={cl("content")}>
                    <PowerOff />
                </div>
            </div>
        );
    }

    return (
        <div className={cl("panel", { "panel-expanded": expanded })}>
            <EngineStatus onClose={onClose} expanded={expanded} powered onExpand={onExpand} onShrink={onShrink} />
            <VoiceWarning />
            <TabBar
                type="top"
                look="brand"
                className={cl("tabbar")}
                selectedItem={tab}
                onItemSelect={select}
            >
                <TabBar.Item id="mic" className={cl("tabbar-item")}>Mic</TabBar.Item>
                <TabBar.Item id="apps" className={cl("tabbar-item")}>Apps</TabBar.Item>
                <TabBar.Item id="clips" className={cl("tabbar-item")}>Soundboard</TabBar.Item>
            </TabBar>
            <div className={cl("content")}>
                <ErrorBoundary key={tab} onError={logUiCrash(`the ${tab} tab`)}>
                    {tab === "mic" ? <MicTab /> : tab === "apps" ? <AppsTab /> : <ClipsTab />}
                </ErrorBoundary>
            </div>
        </div>
    );
}
