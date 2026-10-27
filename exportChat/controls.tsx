/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Small themed controls shared by the export, queue and upload dialogs and the export history. Plain
// inputs styled in styles.css, because Discord's TextInput replaces its own class with any className
// it's given and renders a white browser input.

import { Switch } from "@components/Switch";
import { useState } from "@webpack/common";

/** Label and an optional hint on the left, Discord's switch on the right. The whole row toggles. */
export function SwitchRow({ label, hint, value, disabled, onChange }: {
    label: string;
    hint?: string;
    value: boolean;
    disabled?: boolean;
    onChange(v: boolean): void;
}) {
    return (
        <label className={`vc-export-switch-row${disabled ? " vc-export-switch-row-disabled" : ""}`}>
            <span className="vc-export-switch-text">
                <span className="vc-export-switch-label">{label}</span>
                {hint && <span className="vc-export-hint">{hint}</span>}
            </span>
            <Switch checked={value} onChange={onChange} disabled={disabled} />
        </label>
    );
}

/** A checkbox in Discord's colours. It's a styled native checkbox, so keyboard and screen readers work as usual. */
export function Checkbox({ checked, onChange, disabled, label, ariaLabel }: {
    checked: boolean;
    onChange(v: boolean): void;
    disabled?: boolean;
    label?: string;
    /** Accessible name when there's no visible label. */
    ariaLabel?: string;
}) {
    return (
        <label className={`vc-export-check${disabled ? " vc-export-check-disabled" : ""}`}>
            <input
                type="checkbox"
                className="vc-export-check-input"
                checked={checked}
                disabled={disabled}
                aria-label={label ? undefined : ariaLabel}
                onChange={e => onChange(e.currentTarget.checked)}
            />
            {label && <span>{label}</span>}
        </label>
    );
}

/** A password box with a Show / Hide button inside it. */
export function PasswordField({ value, onChange, disabled, placeholder = "No password", autoFocus }: {
    value: string;
    onChange(v: string): void;
    disabled?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
}) {
    const [shown, setShown] = useState(false);
    return (
        <div className="vc-export-pw">
            <input
                className="vc-export-input"
                type={shown ? "text" : "password"}
                value={value}
                onChange={e => onChange(e.currentTarget.value)}
                placeholder={placeholder}
                aria-label="Password"
                autoComplete="new-password"
                autoFocus={autoFocus}
                spellCheck={false}
                maxLength={256}
                disabled={disabled}
            />
            <button
                type="button"
                className="vc-export-pw-toggle"
                onClick={() => setShown(s => !s)}
                aria-pressed={shown}
                aria-label={shown ? "Hide password" : "Show password"}
                disabled={disabled}
            >
                {shown ? "Hide" : "Show"}
            </button>
        </div>
    );
}
