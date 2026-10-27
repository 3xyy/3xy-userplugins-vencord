/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { TextInput, useState } from "@webpack/common";

const cl = classNameFactory("vc-sps-");

function Row({ label, hint, initial, onCommit, type = "text", placeholder }: {
    label: string; hint?: string;
    initial: string; onCommit(v: string): void;
    type?: "text" | "number";
    placeholder?: string;
}) {
    const [value, setValue] = useState(initial);
    return (
        <div className={cl("field")}>
            <div className={cl("field-label")}>{label}</div>
            {hint && <div className={cl("field-hint")}>{hint}</div>}
            {/* Discord's TextInput, like Vencord's own text settings around it (no className: it would replace Discord's input style) */}
            <TextInput
                type={type}
                value={value}
                placeholder={placeholder}
                aria-label={label}
                onChange={setValue}
                spellCheck={false}
                onBlur={() => value !== initial && onCommit(value)}
            />
        </div>
    );
}

export function SourceConfig({ settings, restart }: { settings: any; restart: (reason: string) => void; }) {
    // Re-render when the source changes.
    const { source } = settings.use(["source"]);

    if (source === "spotify") {
        return (
            <div className={cl("source-info")}>
                Connect Spotify in Discord under <strong>Settings &gt; Connections</strong>. Song changes show up right away.
            </div>
        );
    }

    if (source === "smtc") {
        return (
            <div className={cl("source-config")}>
                <div className={cl("source-info")}>
                    Reads whatever is playing in Windows' media controls: the Spotify app, a browser tab, and most music players.
                </div>
                <Row
                    label="Check every (seconds)"
                    hint="How often to ask Windows what's playing. At least 2."
                    type="number"
                    initial={String(settings.store.pollSeconds ?? 5)}
                    onCommit={v => { settings.store.pollSeconds = Math.max(2, Number(v) | 0 || 5); restart("poll changed"); }}
                />
            </div>
        );
    }

    if (source === "lastfm") {
        return (
            <div className={cl("source-config")}>
                <div className={cl("source-info")}>
                    Checks your Last.fm profile for the song it shows as now playing.
                </div>
                <Row
                    label="Last.fm username"
                    placeholder="Your Last.fm username"
                    initial={String(settings.store.lastfmUsername ?? "")}
                    onCommit={v => { settings.store.lastfmUsername = v; restart("lastfm user changed"); }}
                />
                <Row
                    label="Last.fm API key (optional)"
                    hint="Leave it empty to use a shared key. You can get your own at last.fm/api/account/create."
                    initial={String(settings.store.lastfmApiKey ?? "")}
                    onCommit={v => { settings.store.lastfmApiKey = v; }}
                />
                <Row
                    label="Check every (seconds)"
                    hint="At least 2. Last.fm limits how often you can ask, so 5 to 10 is a good range."
                    type="number"
                    initial={String(settings.store.pollSeconds ?? 5)}
                    onCommit={v => { settings.store.pollSeconds = Math.max(2, Number(v) | 0 || 5); restart("poll changed"); }}
                />
            </div>
        );
    }

    return null;
}
