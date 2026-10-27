/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { useMemo, useState } from "@webpack/common";

import { engineClient } from "../engineClient";
import type { O2iProfile } from "../logic/profile";
import { settings, updateProfile } from "../settings";
import type { AppJson, EngineSnapshot } from "../types";
import { pct, Section, SwitchRow, TextField, ValueSlider } from "./controls";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

const DEFAULT_DUCK_TARGET = 0.3;

/** Primitive (so polls don't re-render): the attached app names, sorted, newline-joined. */
const selectAttachedKey = (s: EngineSnapshot) => {
    const apps = s.state?.apps;
    if (!apps?.length) return "";
    return apps.filter(a => a.attached).map(a => a.name).sort().join("\n");
};
/** The last `apps` event: only replaced when the engine sends a new one, not per poll. */
const selectAppsEvent = (s: EngineSnapshot) => s.apps;

function appsSignature(p: O2iProfile): string {
    return JSON.stringify([p.routed_apps, p.duck_enabled, p.duck_target]);
}

/** Signature of the profile edit() last wrote; consumed by the first render that sees it. */
let ownSignature: string | null = null;

function edit(fn: (p: O2iProfile) => O2iProfile) {
    updateProfile(p => {
        const next = fn(p);
        ownSignature = appsSignature(next);
        return next;
    });
}

/** Remounts the tab's sliders when the routed/duck fields change from outside this tab (see MicTab). */
function useExternalRevision(p: O2iProfile): number {
    const sig = appsSignature(p);
    const [sync, setSync] = useState({ sig, rev: 0 });
    if (sig === sync.sig) return sync.rev;
    const own = sig === ownSignature;
    if (own) ownSignature = null;
    const next = { sig, rev: own ? sync.rev : sync.rev + 1 };
    setSync(next);
    return next.rev;
}

function setMuted(name: string, muted: boolean) {
    const cur = settings.store.mutedApps ?? [];
    const has = cur.includes(name);
    if (muted === has) return;
    settings.store.mutedApps = muted ? [...cur, name] : cur.filter(n => n !== name);
    engineClient.configureSoon();
}

function removeApp(name: string) {
    const cur = settings.store.mutedApps ?? [];
    if (cur.includes(name)) settings.store.mutedApps = cur.filter(n => n !== name);
    edit(p => ({ ...p, routed_apps: (p.routed_apps ?? []).filter(a => a.name !== name) }));
}

function setVolume(name: string, volume: number) {
    edit(p => ({ ...p, routed_apps: (p.routed_apps ?? []).map(a => a.name === name ? { ...a, volume } : a) }));
}

function AppIcon({ icon }: { icon: string | null | undefined; }) {
    return icon
        ? <img className={cl("app-icon")} src={icon} alt="" draggable={false} />
        : <span className={cl("app-icon", "app-icon-generic")} aria-hidden="true" />;
}

function AppRow({ name, volume, muted, attached, icon }: {
    name: string;
    volume: number;
    muted: boolean;
    attached: boolean;
    icon: string | null | undefined;
}) {
    return (
        <div className={cl("app-row", { "app-row-muted": muted })}>
            <div className={cl("app-head")}>
                <AppIcon icon={icon} />
                <span className={cl("app-name")} title={name}>{name}</span>
                <span
                    className={cl("dot", { "dot-on": attached })}
                    title={attached ? "Attached" : "Not running"}
                    aria-label={attached ? "Attached" : "Not running"}
                />
                <button
                    type="button"
                    className={cl("mini-btn", { "mini-btn-on": muted })}
                    aria-pressed={muted}
                    onClick={() => setMuted(name, !muted)}
                >
                    {muted ? "Muted" : "Mute"}
                </button>
                <button
                    type="button"
                    className={cl("mini-btn")}
                    aria-label={`Remove ${name}`}
                    title="Remove"
                    onClick={() => removeApp(name)}
                >
                    ✕
                </button>
            </div>
            <ValueSlider
                label="Volume"
                min={0}
                max={200}
                value={volume * 100}
                format={pct}
                disabled={muted}
                onCommit={v => setVolume(name, Math.round(v) / 100)}
            />
        </div>
    );
}

/** Inline picker (no Select / portal: those can close the popout). Mounted only while open. */
function AppPicker({ routed, onDone }: { routed: Set<string>; onDone(): void; }) {
    const eventApps = useEngineValue(selectAppsEvent);
    const [query, setQuery] = useState("");

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        const seen = new Set<string>();
        const out: AppJson[] = [];
        for (const a of eventApps?.apps ?? []) {
            if (routed.has(a.name) || seen.has(a.name)) continue;
            if (q && !a.name.toLowerCase().includes(q)) continue;
            seen.add(a.name);
            out.push(a);
        }
        out.sort((a, b) => Number(b.playing) - Number(a.playing) || a.name.localeCompare(b.name));
        return out;
    }, [eventApps, routed, query]);

    const add = (name: string) => {
        edit(p => {
            const cur = p.routed_apps ?? [];
            return cur.some(a => a.name === name) ? p : { ...p, routed_apps: [...cur, { name, volume: 1 }] };
        });
        onDone();
    };

    return (
        <div className={cl("picker")}>
            <div className={cl("picker-bar")}>
                <TextField
                    className={cl("picker-search")}
                    value={query}
                    onChange={setQuery}
                    onClear={() => setQuery("")}
                    placeholder="Search running apps"
                    autoFocus
                />
                <button
                    type="button"
                    className={cl("mini-btn")}
                    aria-label="Refresh app list"
                    title="Refresh"
                    onClick={() => engineClient.send({ cmd: "list_apps" })}
                >
                    ↻
                </button>
            </div>
            <div className={cl("picker-list")}>
                {list.length === 0
                    ? <div className={cl("picker-empty")}>{eventApps ? "No matching apps" : "Loading…"}</div>
                    : list.map(a => (
                        <button key={a.name} type="button" className={cl("picker-item")} onClick={() => add(a.name)}>
                            <AppIcon icon={a.icon} />
                            <span className={cl("app-name")} title={a.name}>{a.name}</span>
                            {a.playing && <span className={cl("dot", "dot-on")} title="Playing" aria-label="Playing" />}
                        </button>
                    ))}
            </div>
        </div>
    );
}

export function AppsTab() {
    const { profile, mutedApps } = settings.use(["profile", "mutedApps"]);
    const p = profile ?? { name: "default" };
    const revision = useExternalRevision(p);
    const attachedKey = useEngineValue(selectAttachedKey);
    const eventApps = useEngineValue(selectAppsEvent);
    const [pickerOpen, setPickerOpen] = useState(false);

    const attached = useMemo(() => new Set(attachedKey ? attachedKey.split("\n") : []), [attachedKey]);
    const icons = useMemo(() => {
        const m = new Map<string, string>();
        for (const a of eventApps?.apps ?? []) if (a.icon && !m.has(a.name)) m.set(a.name, a.icon);
        return m;
    }, [eventApps]);
    const routedApps = p.routed_apps;
    const routedNames = useMemo(() => new Set((routedApps ?? []).map(a => a.name)), [routedApps]);
    const muted = mutedApps ?? [];
    const duckOn = !!p.duck_enabled;

    const togglePicker = () => {
        if (!pickerOpen) engineClient.send({ cmd: "list_apps" });
        setPickerOpen(!pickerOpen);
    };

    return (
        <div className={cl("tab")} key={revision}>
            <Section
                title="Routed apps"
                action={
                    <button type="button" className={cl("mini-btn")} aria-expanded={pickerOpen} onClick={togglePicker}>
                        {pickerOpen ? "Cancel" : "Add app"}
                    </button>
                }
            >
                {pickerOpen && <AppPicker routed={routedNames} onDone={() => setPickerOpen(false)} />}
                {routedApps?.length
                    ? (
                        <div className={cl("list")}>
                            {routedApps.map(a => (
                                <AppRow
                                    key={a.name}
                                    name={a.name}
                                    volume={a.volume}
                                    muted={muted.includes(a.name)}
                                    attached={attached.has(a.name)}
                                    icon={icons.get(a.name)}
                                />
                            ))}
                        </div>
                    )
                    : !pickerOpen && <div className={cl("empty-text")}>No apps yet. Add one to mix its sound into your mic.</div>}
            </Section>

            <Section title="Ducking">
                <SwitchRow
                    label="Lower apps while you talk"
                    value={duckOn}
                    onChange={v => edit(q => ({ ...q, duck_enabled: v, duck_target: q.duck_target ?? DEFAULT_DUCK_TARGET }))}
                />
                <ValueSlider
                    label="Ducked volume"
                    min={0}
                    max={100}
                    value={(p.duck_target ?? DEFAULT_DUCK_TARGET) * 100}
                    format={pct}
                    disabled={!duckOn}
                    onCommit={v => edit(q => ({ ...q, duck_enabled: q.duck_enabled ?? false, duck_target: Math.round(v) / 100 }))}
                />
            </Section>
        </div>
    );
}
