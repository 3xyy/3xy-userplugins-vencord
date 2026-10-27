/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { Slider, useEffect, useRef, useState } from "@webpack/common";
import type { KeyboardEvent, ReactNode } from "react";

import { throttleWait } from "../logic/seek";

const cl = classNameFactory("vc-o2i-");

export const pct = (v: number) => `${Math.round(v)}%`;

/** A group of controls under a small uppercase header, with an optional action at the header's right. */
export function Section({ title, action, className, children }: {
    title: string;
    action?: ReactNode;
    /** Extra (already prefixed) class, e.g. for the expanded layout. */
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div className={className ? `${cl("section")} ${className}` : cl("section")}>
            <div className={cl("section-head")}>
                <div className={cl("section-title")} role="heading" aria-level={3}>{title}</div>
                {action}
            </div>
            {children}
        </div>
    );
}

/** Label (and an optional one-line hint) on the left, switch on the right; the whole row toggles. */
export function SwitchRow({ label, hint, value, disabled, onChange }: {
    label: string;
    hint?: string;
    value: boolean;
    disabled?: boolean;
    onChange(v: boolean): void;
}) {
    return (
        <label className={cl("row", { "row-disabled": disabled })}>
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>{label}</span>
                {hint && <span className={cl("row-hint")}>{hint}</span>}
            </span>
            <Switch checked={value} onChange={onChange} disabled={disabled} />
        </label>
    );
}

/** A small label with an optional value on the right, above a full-width control. */
export function Field({ label, value, disabled, children }: {
    label: string;
    value?: ReactNode;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <div className={cl("field", { "field-disabled": disabled })}>
            <div className={cl("field-row")}>
                <span className={cl("label")}>{label}</span>
                {value != null && <span className={cl("value")}>{value}</span>}
            </div>
            {children}
        </div>
    );
}

/** Longest interval between `onPreview` calls while dragging. */
const LIVE_MS = 100;

/**
 * Discord's Slider is uncontrolled (`initialValue` is read on mount). `asValueChanges` fires while
 * dragging and updates the shown number; `onValueChange` fires once on release (or click / key) and is
 * the only place that writes settings (`onCommit`), so a drag is one settings write and one configure.
 * With `onPreview` the value is also offered while dragging (throttled, only when the rounded value
 * changed) so the caller can preview it without saving; `onPreviewEnd(committed)` follows the release
 * (true, just before `onCommit`) or an unmount mid-drag (false: abandoned, restore the stored value).
 */
export function ValueSlider({ label, min, max, value, format, disabled, onPreview, onPreviewEnd, onCommit }: {
    label: string;
    min: number;
    max: number;
    value: number;
    format(v: number): string;
    disabled?: boolean;
    onPreview?(v: number): void;
    onPreviewEnd?(committed: boolean): void;
    onCommit(v: number): void;
}) {
    const [shown, setLive] = useState(value);
    const lastAt = useRef(0);
    const lastSent = useRef<number | null>(null);
    const pending = useRef<number | null>(null);
    const previewing = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const endRef = useRef(onPreviewEnd);
    endRef.current = onPreviewEnd;
    const clearTimer = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    };
    // Abandoned preview (unmount, or the window loses focus mid-drag): drop it without committing.
    useEffect(() => {
        const abandon = () => {
            clearTimer();
            lastSent.current = null;
            pending.current = null;
            if (previewing.current) {
                previewing.current = false;
                endRef.current?.(false);
            }
        };
        window.addEventListener("blur", abandon);
        return () => {
            window.removeEventListener("blur", abandon);
            abandon();
        };
    }, []);
    const send = (v: number) => {
        const r = Math.round(v);
        if (r === lastSent.current) return;
        lastSent.current = r;
        lastAt.current = performance.now();
        previewing.current = true;
        onPreview?.(v);
    };
    // Leading call, then a trailing one so the last value of a burst is never skipped.
    const preview = (v: number) => {
        pending.current = v;
        if (timer.current) return;
        const wait = throttleWait(lastAt.current, performance.now(), LIVE_MS);
        if (wait <= 0) send(v);
        else {
            timer.current = setTimeout(() => {
                timer.current = null;
                if (pending.current != null) send(pending.current);
            }, wait);
        }
    };
    return (
        <Field label={label} value={format(shown)} disabled={disabled}>
            <Slider
                className={cl("slider")}
                mini
                minValue={min}
                maxValue={max}
                initialValue={value}
                disabled={disabled}
                onValueRender={format}
                aria-label={label}
                asValueChanges={v => {
                    setLive(v);
                    if (onPreview) preview(v);
                }}
                onValueChange={v => {
                    clearTimer();
                    pending.current = null;
                    lastSent.current = null;
                    if (previewing.current) {
                        previewing.current = false;
                        onPreviewEnd?.(true);
                    }
                    setLive(v);
                    onCommit(v);
                }}
            />
        </Field>
    );
}

/**
 * A text box that looks like Discord's own. A plain input on purpose: Discord's TextInput spreads its
 * leftover props onto the <input> after its own class, so giving it a className replaced Discord's
 * styling and left a white, unstyled browser input. `onClear` adds a ✕ inside the box while it has text.
 */
export function TextField({ value, onChange, placeholder, label, title, autoFocus, maxLength, className, onClear, onBlur, onKeyDown }: {
    value: string;
    onChange(v: string): void;
    placeholder?: string;
    /** Accessible name (defaults to the placeholder). */
    label?: string;
    title?: string;
    autoFocus?: boolean;
    maxLength?: number;
    /** Extra (already prefixed) class on the wrapper, e.g. to size it. */
    className?: string;
    onClear?(): void;
    onBlur?(): void;
    onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const clearable = !!onClear && value !== "";
    return (
        <div className={className ? `${cl("input-wrap")} ${className}` : cl("input-wrap")}>
            <input
                ref={input}
                className={cl("input", { "input-clearable": clearable })}
                type="text"
                value={value}
                placeholder={placeholder}
                aria-label={label ?? placeholder}
                title={title}
                autoFocus={autoFocus}
                maxLength={maxLength}
                spellCheck={false}
                autoComplete="off"
                onChange={e => onChange(e.currentTarget.value)}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
            />
            {clearable && (
                <button
                    type="button"
                    className={cl("input-clear")}
                    aria-label={`Clear ${label ?? placeholder ?? "text"}`}
                    title="Clear"
                    // keep focus in the box (no blur-commit in between, and typing can continue)
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                        onClear();
                        input.current?.focus();
                    }}
                >
                    ✕
                </button>
            )}
        </div>
    );
}
