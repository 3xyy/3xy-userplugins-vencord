/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { engineClient } from "../engineClient";
import type { EngineSnapshot } from "../types";

/**
 * One value from the engine snapshot. The component re-renders only when that value changes (Object.is).
 * Every poll arrives as a fresh structured clone, so `s.state` is a new object each poll (fine for the
 * few components that want it); `devices`/`apps`/`clips` are kept stable by engineClient until the
 * engine sends a new event. Prefer a selector returning a primitive; never return a freshly built object.
 */
export function useEngineValue<T>(select: (s: EngineSnapshot) => T): T {
    return React.useSyncExternalStore(engineClient.subscribe, () => select(engineClient.getSnapshot()));
}
