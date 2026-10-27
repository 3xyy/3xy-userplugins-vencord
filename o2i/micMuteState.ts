/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Whether o2i's mic counts as muted, in one place for the UI and for the rule that self-mutes Discord
// (discordVoice.ts): the saved `micMuted`, unless the last engine that reported its state can't mute
// (an o2i.exe from before the mute). Until an engine has reported, the saved value counts (the safe side).
// engineClient feeds in what each engine reports. Nothing here throws.

import { effectiveMute } from "./logic/micMute";
import { settings } from "./settings";

/** The last engine that reported its state can mute (null: none has reported yet). */
let engineCanMute: boolean | null = null;
const listeners = new Set<() => void>();

/** What the running engine's state says (engineClient, per snapshot with a state). Notifies only on a change. */
export function noteEngineCanMute(can: boolean): void {
    if (engineCanMute === can) return;
    engineCanMute = can;
    for (const fn of listeners) {
        try {
            fn();
        } catch { /* a subscriber's failure never stops the others */ }
    }
}

/** The last engine that reported can't mute. */
export function engineCannotMute(): boolean {
    return engineCanMute === false;
}

/** o2i's mic counts as muted (see the top of this file). */
export function effectiveMicMuted(): boolean {
    return effectiveMute(settings.store.micMuted === true, engineCanMute);
}

export function subscribeMuteSupport(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
