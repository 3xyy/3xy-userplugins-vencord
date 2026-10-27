/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { openModal } from "@utils/modal";
import { Modal, TextInput, useRef, useState } from "@webpack/common";
import { ComponentType } from "react";

// cast: the props are spread from openModal's render props (typed loosely here)
const M = Modal as ComponentType<any>;

interface PromptOpts {
    title: string;
    label?: string;
    initialValue?: string;
    placeholder?: string;
    /** Text of the confirm button (default "OK"). */
    confirmText?: string;
}

export function promptText(opts: PromptOpts): Promise<string | null> {
    return new Promise<string | null>(resolve => {
        let done = false;
        const finish = (val: string | null) => { if (!done) { done = true; resolve(val); } };
        openModal(modalProps => (
            <PromptModal
                modalProps={modalProps}
                opts={opts}
                onResolve={finish}
            />
        ), {
            // resolves on every close path, including ones that skip the Modal's onClose (finish is idempotent)
            onCloseCallback: () => finish(null)
        });
    });
}

function PromptModal({ modalProps, opts, onResolve }: { modalProps: any; opts: PromptOpts; onResolve(v: string | null): void; }) {
    const [value, setValue] = useState(opts.initialValue ?? "");
    const closed = useRef(false);

    // resolve once; any close path (button, Escape, outside-click) lands here
    const finish = (val: string | null) => {
        if (closed.current) return;
        closed.current = true;
        onResolve(val);
    };
    const close = (val: string | null) => {
        finish(val);
        modalProps.onClose();
    };

    return (
        <M
            {...modalProps}
            size="sm"
            title={opts.title}
            onClose={() => { finish(null); modalProps.onClose(); }}
        >
            <div className="vc-it-prompt">
                {opts.label && <span className="vc-it-prompt-label">{opts.label}</span>}
                {/* Discord's own text box; never give it a className (it would replace Discord's styling) */}
                <TextInput
                    autoFocus
                    value={value}
                    placeholder={opts.placeholder}
                    onChange={(v: string) => setValue(v)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") { e.preventDefault(); close(value); }
                        else if (e.key === "Escape") { e.preventDefault(); close(null); }
                    }}
                />
                <div className="vc-it-prompt-row">
                    <Button variant="secondary" onClick={() => close(null)}>Cancel</Button>
                    <Button variant="primary" onClick={() => close(value)}>{opts.confirmText ?? "OK"}</Button>
                </div>
            </div>
        </M>
    );
}
