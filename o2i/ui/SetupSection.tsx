/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { classNameFactory } from "@utils/css";
import { Select, Text, TextInput, useEffect, useState } from "@webpack/common";
import type { MouseEvent } from "react";

import { useLogExport } from "../diagnostics";
import { engineClient, getNative, isPluginRunning, useEngine } from "../engineClient";
import { importLegacy } from "../importLegacy";
import { olog } from "../log";
import { setPowered } from "../power";
import { settings, updateProfile } from "../settings";
import type { DeviceJson } from "../types";
import { FoldersSection } from "./FoldersSection";

const cl = classNameFactory("vc-o2i-");

const VALIDATE_DEBOUNCE_MS = 400;
const DEFAULT_VALUE = "";
/** The ready-made o2i.exe: the latest GitHub release of the plugins' repo. */
const ENGINE_DOWNLOAD_URL = "https://github.com/3xyy/3xy-userplugins-vencord/releases/latest";

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

async function checkPath(path: string): Promise<boolean> {
    if (!IS_DISCORD_DESKTOP || !path) return false;
    try {
        return !!(await getNative().pathExists(path));
    } catch (e) {
        olog.error("pathExists failed", e);
        return false;
    }
}

function DeviceSelect({ label, devices, current, onPick, disabled, allowDefault = true }: {
    label: string;
    devices: DeviceJson[] | null;
    current: string;
    onPick(id: string | null): void;
    disabled: boolean;
    /** Offer "System default" (stored as null). */
    allowDefault?: boolean;
}) {
    const options = [
        ...(allowDefault ? [{ label: "System default", value: DEFAULT_VALUE }] : []),
        ...(devices ?? []).map(d => ({ label: d.name, value: d.id }))
    ];
    return (
        <div>
            <Heading tag="h5">{label}</Heading>
            <Select
                placeholder="Select a device"
                options={options}
                maxVisibleItems={6}
                closeOnSelect={true}
                isDisabled={disabled}
                select={(v: string) => onPick(v === DEFAULT_VALUE ? null : v)}
                isSelected={(v: string) => v === current}
                serialize={(v: string) => String(v)}
            />
        </div>
    );
}

/** Opens the release page in the default browser (on the web, the link just opens it). */
function openEngineDownload(e: MouseEvent<HTMLAnchorElement>) {
    if (!IS_DISCORD_DESKTOP) return;
    e.preventDefault();
    VencordNative.native.openExternal(ENGINE_DOWNLOAD_URL).catch(err => olog.error("couldn't open the o2i download page", err));
}

/** The power button's state in one line, with Turn off / Turn on. */
function PowerRow({ on }: { on: boolean; }) {
    return (
        <div className={cl("power-row")}>
            <Text variant="text-md/normal">
                {on
                    ? "o2i is on. The engine runs while Discord is open."
                    : "o2i is off. The engine, its hotkeys and the soundboard are stopped, and Discord uses your real mic."}
            </Text>
            <Button size="small" variant={on ? "secondary" : "primary"} onClick={() => setPowered(!on)}>
                {on ? "Turn off" : "Turn on"}
            </Button>
        </div>
    );
}

/** Zips o2i's engine + plugin logs and a short system summary into Downloads, ready to attach to a bug report. */
function LogsSection() {
    const [busy, start] = useLogExport();
    return (
        <div>
            <Heading tag="h5">Logs</Heading>
            <Text variant="text-sm/normal" className={cl("setup-text")}>
                Something not working? Export the logs and attach the zip to a GitHub issue, or send it to whoever
                is helping you. The zip has o2i's engine and plugin logs plus a short summary: versions, your o2i
                settings, and your soundboard folder and file names. Audio device names and the names of the apps you
                route are left as they are. Your Windows user folder becomes %USERPROFILE%, and your user name becomes
                &lt;user&gt; wherever it shows up as a whole word. Nothing from other plugins is included.
            </Text>
            <Button variant="secondary" disabled={busy} onClick={start}>{busy ? "Exporting…" : "Export logs"}</Button>
        </div>
    );
}

export function SetupSection() {
    const { enginePath, profile, powered } = settings.use(["enginePath", "profile", "powered"]);
    const on = powered !== false;
    const engine = useEngine();
    const { devices } = engine;
    const running = engine.status === "running";

    const [pathOk, setPathOk] = useState<boolean | null>(null);
    const debouncedPath = useDebounced((enginePath ?? "").trim(), VALIDATE_DEBOUNCE_MS);

    useEffect(() => {
        let cancelled = false;
        if (!debouncedPath) {
            setPathOk(null);
            return;
        }
        void checkPath(debouncedPath).then(ok => {
            if (cancelled) return;
            setPathOk(ok);
            // Vencord shows this page for a disabled plugin too: only a running plugin imports / starts the engine.
            if (!ok || !isPluginRunning()) return;
            void (async () => {
                try {
                    if (!settings.store.imported) await importLegacy();
                    if (cancelled) return;
                    if (engineClient.getSnapshot().status !== "running") await engineClient.start();
                } catch (e) {
                    olog.error("setup start failed", e);
                }
            })();
        });
        return () => { cancelled = true; };
    }, [debouncedPath]);

    // Ask for devices on mount and whenever the engine (re)spawns while mounted; never poll.
    useEffect(() => {
        if (running) engineClient.send({ cmd: "list_devices" });
    }, [running, engine.generation]);

    const cableId = devices?.cable?.id ?? null;
    const currentIn = profile?.input_id ?? DEFAULT_VALUE;
    const currentOut = profile?.output_id ?? cableId ?? DEFAULT_VALUE;
    const currentMon = profile?.sb_monitor_device ?? DEFAULT_VALUE;
    const noDevices = !devices;

    return (
        <div className={cl("setup")}>
            <PowerRow on={on} />

            <div>
                <Heading tag="h5">Engine path (o2i.exe)</Heading>
                {/* Discord's own text box. No className: that would replace Discord's styling. */}
                <TextInput
                    value={enginePath ?? ""}
                    placeholder="C:\path\to\o2i.exe"
                    onChange={(v: string) => { settings.store.enginePath = v; }}
                    error={pathOk === false ? "File not found" : undefined}
                />
                <Text variant="text-sm/normal" className={cl("setup-hint")}>
                    {pathOk === true ? "\u2713 Found. " : ""}
                    <Link href={ENGINE_DOWNLOAD_URL} onClick={openEngineDownload}>Download o2i.exe</Link> from the latest
                    release, or build it yourself with `cargo build --release` (needs Rust and LLVM).
                </Text>
            </div>

            <div className={cl("setup-devices")}>
                {noDevices && (
                    <Text variant="text-sm/normal">
                        {on ? "The engine isn't running yet, so there are no devices to list." : "o2i is off. Turn it on above to see your devices."}
                    </Text>
                )}
                {/* No "System default": the engine needs a named mic, and so does the fallback to it. */}
                <DeviceSelect
                    label="Microphone"
                    devices={devices?.inputs ?? null}
                    current={currentIn}
                    disabled={noDevices}
                    allowDefault={false}
                    onPick={id => updateProfile(p => ({ ...p, input_id: id }))}
                />
                <DeviceSelect
                    label="o2i output"
                    devices={devices?.outputs ?? null}
                    current={currentOut}
                    disabled={noDevices}
                    onPick={id => updateProfile(p => ({ ...p, output_id: id }))}
                />
                {devices && !devices.cable && (
                    <Text variant="text-sm/normal">VB-CABLE isn't installed.</Text>
                )}
                <DeviceSelect
                    label="Headphones (hear sounds locally)"
                    devices={devices?.outputs ?? null}
                    current={currentMon}
                    disabled={noDevices}
                    onPick={id => updateProfile(p => ({ ...p, sb_monitor_device: id }))}
                />
            </div>

            <FoldersSection />

            <div>
                <Button variant="secondary" onClick={() => { void importLegacy(true); }}>Re-import from the o2i app</Button>
            </div>

            <LogsSection />
        </div>
    );
}
