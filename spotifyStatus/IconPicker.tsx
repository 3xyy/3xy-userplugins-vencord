/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { showToast, useState } from "@webpack/common";

const logger = new Logger("SpotifyStatus:IconPicker");
const cl = classNameFactory("vc-sps-");

// Music-related characters, roughly grouped.
const ICONS: string[] = [
    // Music notes and symbols
    "♪", "♫", "♬", "♩", "♭", "♮", "♯", "𝄞", "𝄢", "𝄡", "𝅘𝅥𝅮", "𝅘𝅥𝅯",
    // Playback
    "▶", "⏵", "⏸", "⏹", "⏺", "⏮", "⏭", "⏪", "⏩", "⏯", "🔀", "🔁", "🔂",
    // Audio and volume
    "🔇", "🔈", "🔉", "🔊", "📢", "📣", "📯", "🔔", "🔕",
    // Instruments
    "🎵", "🎶", "🎼", "🎧", "🎤", "🎙", "🎚", "🎛", "🎷", "🎸", "🎹", "🎺", "🎻", "🪗", "🪕", "🪘", "🥁",
    // Vibe
    "💿", "📀", "💽", "📻", "🎚️", "🎛️", "🪩", "🎉", "✨", "💫", "⭐", "🌟", "🔥", "💖", "💘", "💕",
    // Separators and flourishes for templates
    "«", "»", "❝", "❞", "·", "•", "|", "▸", "▹", "►", "▷", "◄", "◅",
];

async function copy(icon: string) {
    try {
        await navigator.clipboard.writeText(icon);
        showToast({ text: `Copied ${icon}`, variant: "success" });
    } catch (e) {
        logger.error("clipboard write failed", e);
        showToast({ text: "Couldn't copy that icon", variant: "critical" });
    }
}

export function IconPicker() {
    const [recent, setRecent] = useState<string[]>([]);

    const onClick = (icon: string) => {
        void copy(icon);
        setRecent(prev => [icon, ...prev.filter(x => x !== icon)].slice(0, 12));
    };

    return (
        <div className={cl("icons")}>
            <div className={cl("field-label")}>Music icons</div>
            <div className={cl("field-hint")}>Click one to copy it, then paste it into a template or the icon list below.</div>
            {recent.length > 0 && <div className={cl("icons-recent")}>Recently copied: {recent.join("  ")}</div>}
            <div className={cl("icons-grid")}>
                {ICONS.map(icon => (
                    <button
                        key={icon}
                        type="button"
                        className={cl("icon-cell")}
                        title={`Copy ${icon}`}
                        aria-label={`Copy ${icon}`}
                        onClick={() => onClick(icon)}
                    >
                        {icon}
                    </button>
                ))}
            </div>
        </div>
    );
}
