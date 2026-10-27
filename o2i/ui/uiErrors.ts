/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ErrorInfo } from "react";

import { olog } from "../log";

type OnError = (data: { error: Error; errorInfo: ErrorInfo; }) => void;

const handlers = new Map<string, OnError>();

/** Component names from React's component stack ("at MicTab (https://…)" → "MicTab"), innermost first. */
function components(stack: string | null | undefined, max: number): string {
    return (stack ?? "")
        .split("\n")
        .map(l => l.trim().replace(/^(at|in)\s+/, "").replace(/\s*\(.*\)$/, ""))
        .filter(Boolean)
        .slice(0, max)
        .join(" < ");
}

/**
 * An ErrorBoundary `onError` that writes the crash to plugin.log (the error's message and the innermost
 * components). The same function for the same `where`, so it never changes a boundary's props.
 */
export function logUiCrash(where: string): OnError {
    let handler = handlers.get(where);
    if (!handler) {
        handler = ({ error, errorInfo }) => {
            try {
                const inside = components(errorInfo?.componentStack, 5);
                olog.error(`UI crash in ${where}${inside ? ` (${inside})` : ""}`, error);
            } catch { /* never throws */ }
        };
        handlers.set(where, handler);
    }
    return handler;
}
