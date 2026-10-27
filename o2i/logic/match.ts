/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Dev { id: string; name: string; }

export function matchDeviceByName(devs: Dev[], name: string): string | null {
    const cands = devs.filter(d => d.name !== "Default");
    const exact = cands.find(d => d.name === name);
    if (exact) return exact.id;
    const n = name.toLowerCase();
    if (!n) return null;
    const loose = cands.find(d => {
        const dn = d.name.toLowerCase();
        return dn.includes(n) || n.includes(dn);
    });
    return loose ? loose.id : null;
}

export function findCableOutput(devs: Dev[]): string | null {
    return devs.find(d => d.name.toLowerCase().includes("cable output"))?.id ?? null;
}
