/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent } from "react";

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
 * `kind="mute"` (the mic mute and push-to-talk keys): any key, also on its own, and Win combos.
 * `kind="soundboard"`: F-keys, or a letter or digit with Ctrl or Alt.
 * Every row also takes the middle or side mouse buttons (Mouse3-5, with any modifiers) pressed anywhere
 * in the window while it records.
 */
export function HotkeyInput({ value, onChange, validate, kind = "soundboard", disabled }: {
    value: string | null;
    onChange(v: string | null): void;
    validate?(accel: string): string | null;
    kind?: HotkeyRow;
    /** Inert: the buttons are disabled (nothing can be recorded or cleared). */
    disabled?: boolean;
}) {
    const [recording, setRecording] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    /** Removes the listeners that swallow the recorded mouse button's release (see `swallowRelease`). */
    const releaseCleanup = useRef<(() => void) | null>(null);
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

    // Latest commit / stop for the window listener below, which is only attached while recording.
    const live = useRef({ commit, stop });
    live.current = { commit, stop };

    useEffect(() => () => releaseCleanup.current?.(), []);

    // While recording, a mouse button pressed anywhere in the window is the hotkey. Left click elsewhere
    // cancels (as clicking away always did); left click on the recorder and right click are left alone.
    useEffect(() => {
        if (!recording) return;
        const onDown = (e: globalThis.MouseEvent) => {
            const spec = mouseButtonToMuteSpec(e);
            if (!spec) {
                if (e.button === 0 && !btnRef.current?.contains(e.target as Node | null)) live.current.stop();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            swallowRelease(e.button);
            live.current.commit(spec);
        };
        window.addEventListener("mousedown", onDown, true);
        return () => window.removeEventListener("mousedown", onDown, true);
    }, [recording]);

    /**
     * The recorded button's mouseup / auxclick is swallowed too (no middle-click autoscroll or paste).
     * Discord's main process still turns the side buttons into back / forward; nothing here can stop that.
     */
    const swallowRelease = (button: number) => {
        releaseCleanup.current?.();
        const kill = (e: globalThis.MouseEvent) => {
            if (e.button !== button) return;
            e.preventDefault();
            e.stopPropagation();
        };
        let timer: number | undefined;
        const done = () => {
            window.clearTimeout(timer);
            window.removeEventListener("mouseup", onUp, true);
            window.removeEventListener("auxclick", kill, true);
            releaseCleanup.current = null;
        };
        const onUp = (e: globalThis.MouseEvent) => {
            kill(e);
            if (e.button === button) timer = window.setTimeout(done, 50); // auxclick follows the mouseup
        };
        window.addEventListener("mouseup", onUp, true);
        window.addEventListener("auxclick", kill, true);
        releaseCleanup.current = done;
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
                setNotice("Use F1-F12, a letter or digit with Ctrl or Alt, or a mouse button");
            }
            return;
        }
        commit(accel);
    };

    const prompt = "Press a key or mouse button… (Esc to cancel, Backspace to clear)";

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
                    disabled={disabled}
                    onKeyDown={onKeyDown}
                    ref={btnRef}
                    onContextMenu={e => {
                        if (recording) e.preventDefault();
                    }}
                    onBlur={stop}
                >
                    {recording ? prompt : value ?? "Click to set hotkey"}
                </button>
                {!recording && value && (
                    <button
                        type="button"
                        className={cl("mini-btn")}
                        disabled={disabled}
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
