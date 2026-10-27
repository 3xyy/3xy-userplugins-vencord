/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cloneObjects, Doc, Obj } from "./model";

export interface Snapshot { base: HTMLCanvasElement; objects: Obj[]; }

const MAX = 50;
/**
 * Each rotate/flip/resize/crop/reset step keeps its own full-size base canvas (~48 MB for a 12 MP photo),
 * so at most this many distinct bases are kept; the oldest steps go first.
 */
export const MAX_BASES = 10;

function distinctBases(snaps: Snapshot[]): number {
    return new Set(snaps.map(s => s.base)).size;
}

export class History {
    private past: Snapshot[] = [];
    private future: Snapshot[] = [];

    /** Call BEFORE mutating doc, to record the pre-change state. */
    push(doc: Doc) {
        this.past.push({ base: doc.base, objects: cloneObjects(doc.objects) });
        if (this.past.length > MAX) this.past.shift();
        while (distinctBases(this.past) > MAX_BASES) this.past.shift();
        this.future = [];
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }

    /** Returns the snapshot to apply, pushing current onto the redo stack. */
    undo(current: Doc): Snapshot | null {
        const snap = this.past.pop();
        if (!snap) return null;
        this.future.push({ base: current.base, objects: cloneObjects(current.objects) });
        return snap;
    }
    redo(current: Doc): Snapshot | null {
        const snap = this.future.pop();
        if (!snap) return null;
        this.past.push({ base: current.base, objects: cloneObjects(current.objects) });
        return snap;
    }
}
