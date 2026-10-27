/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Role, UnicodeEmoji } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { CSSProperties } from "react";

type GetRoleIconData = (role: Role, size: number) => { customIconSrc?: string; unicodeEmoji?: UnicodeEmoji; } | undefined;
const getRoleIconData: GetRoleIconData = findByCodeLazy("convertSurrogateToName", "customIconSrc", "unicodeEmoji");

/** Returns the image src for a role's icon (custom icon or unicode emoji), or undefined if it has none. */
export function getRoleIconSrc(role: Role): string | undefined {
    const icon = getRoleIconData(role, 20);
    if (!icon) return;

    const { customIconSrc, unicodeEmoji } = icon;
    return customIconSrc ?? unicodeEmoji?.url;
}

/** Builds the style for a role's color dot: a flat color, or a gradient/holographic style when enabled. */
export function getRoleDotStyle(role: Role, renderRoleStyles: boolean): CSSProperties {
    const fallback = role.colorString ?? "var(--primary-300)";
    if (!renderRoleStyles) return { backgroundColor: fallback };

    const { primaryColor, secondaryColor, tertiaryColor } = role.colorStrings ?? {};
    const primary = primaryColor ?? role.colorString;
    if (!primary) return { backgroundColor: fallback };

    if (tertiaryColor) // holographic, 3-stop gradient
        return { background: `linear-gradient(to right, ${primary}, ${secondaryColor}, ${tertiaryColor})` };
    if (secondaryColor) // gradient, 2-stop
        return { background: `linear-gradient(to right, ${primary}, ${secondaryColor})` };

    return { backgroundColor: primary };
}
