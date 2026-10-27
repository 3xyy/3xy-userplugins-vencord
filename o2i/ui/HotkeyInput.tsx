/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useRef, useState } from "@webpack/common";
import type { KeyboardEvent, MouseEvent } from "react";

import { hotkeyProblem, type HotkeyRow, keyEventToAccel, keyEventToMuteSpec, mouseButtonToMuteSpec } from "../logic/accel";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

/** Primitive message for `accel` (so polls only re-render when it changes); matched case-insensitively. */
function useHotkeyError(accel: string | null): string | null {
    const key = accel?.toLowerCase();
    return useEngineValue(s => key ? s.state?.hotkey_errors?.find(e => e.accel.toLowerCase() === key)?.message ?? null : null);
}

const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta"];

/**
 * Click to record: the next key press becomes the hotkey (Escape cancels, Backspace clears).
 * `validate` returns a message to reject an accel (e.g. already bound elsewhere).
 * `kind="mute"` (the mic mute key): any key, also on its own, Win combos, and the middle or side mouse
 * buttons (pressed over the recorder while it records). Soundboard rows keep their rules.
 */
export function HotkeyInput({ value, onChange, validate, kind = "soundboard" }: {
    value: string | null;
    onChange(v: string | null): void;
    validate?(accel: string): string | null;
    kind?: HotkeyRow;
}) {
    const [recording, setRecording] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    /**
     * The mouse button just recorded: its mouseup / auxclick is swallowed too (no middle-click autoscroll).
     * Discord's main process still turns the side buttons into back / forward; nothing here can stop that.
     */
    const swallowButton = useRef<number | null>(null);
    const engineError = useHotkeyError(value);
    const mute = kind === "mute";

    const stop = () => {
        setRecording(false);
        setNotice(null);
    };

    /** Validates and saves a recorded accel; false (with a notice) when it was rejected. */
    const commit = (accel: string) => {
        const problem = hotkeyProblem(accel, kind) ?? validate?.(accel) ?? null;
        if (problem) {
            setNotice(problem);
            return false;
        }
        stop();
        if (accel !== value) onChange(accel);
        return true;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
        if (!recording) return;
        // Keep Discord's shortcuts and the popout's own Escape-to-close from seeing the key.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        if (e.key === "Escape") return stop();
        if (e.key === "Backspace") {
            stop();
            onChange(null);
            return;
        }
        if (mute) {
            const spec = keyEventToMuteSpec(e);
            if (spec) commit(spec);
            else if (!MODIFIER_KEYS.includes(e.key)) setNotice("That key can't be used. Try another key or a mouse button.");
            return;
        }
        if (e.metaKey) {
            setNotice("Win key combos aren't supported");
            return;
        }
        const accel = keyEventToAccel(e);
        if (!accel) {
            if (!MODIFIER_KEYS.includes(e.key)) {
                setNotice("Use F1-F12, or a letter or digit with Ctrl or Alt (Shift optional)");
            }
            return;
        }
        commit(accel);
    };

    // Mute row only, and only while recording: a normal click (or any click while not recording) is left alone.
    const onMouseDown = (e: MouseEvent<HTMLButtonElement>) => {
        if (!mute || !recording) return;
        const spec = mouseButtonToMuteSpec(e);
        if (!spec) return; // left click keeps recording, right click does nothing
        e.preventDefault();
        e.stopPropagation();
        swallowButton.current = e.button;
        commit(spec);
    };

    const swallowUp = (e: MouseEvent<HTMLButtonElement>) => {
        if (swallowButton.current === null || e.button !== swallowButton.current) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "auxclick") swallowButton.current = null;
    };

    const prompt = mute ? "Press a key or mouse button… (Esc to cancel, Backspace to clear)" : "Press a key… (Esc to cancel, Backspace to clear)";

    return (
        <div className={cl("hotkey")}>
            <div className={cl("hotkey-row")}>
                <button
                    type="button"
                    className={cl("hotkey-btn", { "hotkey-btn-recording": recording })}
                    onClick={() => {
                        setNotice(null);
                        setRecording(true);
                    }}
                    onKeyDown={onKeyDown}
                    onMouseDown={onMouseDown}
                    onMouseUp={swallowUp}
                    onAuxClick={swallowUp}
                    onContextMenu={e => {
                        if (mute && recording) e.preventDefault();
                    }}
                    onBlur={stop}
                >
                    {recording ? prompt : value ?? "Click to set hotkey"}
                </button>
                {!recording && value && (
                    <button
                        type="button"
                        className={cl("mini-btn")}
                        aria-label="Clear hotkey"
                        title="Clear"
                        onClick={() => onChange(null)}
                    >
                        ✕
                    </button>
                )}
            </div>
            {notice && <div className={cl("hotkey-msg")}>{notice}</div>}
            {!notice && engineError && <div className={cl("hotkey-msg")}>{engineError}</div>}
        </div>
    );
}
