/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

const cl = classNameFactory("vc-sps-");

/** A heading that splits the settings page into groups. */
export function Section({ title, subtitle }: { title: string; subtitle?: string; }) {
    return (
        <div className={cl("section")}>
            <h2 className={cl("section-title")}>{title}</h2>
            {subtitle && <div className={cl("section-subtitle")}>{subtitle}</div>}
        </div>
    );
}
