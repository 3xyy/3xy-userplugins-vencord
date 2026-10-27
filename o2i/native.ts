/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main process. Owns the `o2i.exe --headless` child: spawns it, restarts it with
// backoff when it dies, caches its latest events for the renderer's polls, and makes sure it never
// outlives Discord. All state is module-level, so it survives renderer reloads (Ctrl+R).
// Also writes %APPDATA%\o2i\logs\plugin.log (its own events as "main: …", plus the renderer's lines via
// pluginLog), zips the logs for "Export logs", and shows the native folder picker.

import { ChildProcessWithoutNullStreams, execFile, spawn } from "child_process";
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions, shell } from "electron";
import filthyMp3 from "file://./sounds/filthy.mp3?base64";
import pingMp3 from "file://./sounds/ping.mp3?base64";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, utimesSync } from "fs";
import { copyFile, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir, release, tmpdir, userInfo, version as osVersion } from "os";
import { join } from "path";

import { nextDelay, STABLE_RESET_MS } from "./logic/backoff";
import { enginePathProblem } from "./logic/exePath";
import { LineSplitter } from "./logic/lines";
import { LogFile } from "./logic/logfile";
import { exportZipName, formatLogLine, type LogLevel } from "./logic/logrotate";
import type { EngineStatus } from "./logic/policy";
import { makeRedactor, redactJson } from "./logic/redact";
import { LatestWaiters } from "./logic/waiters";
import type { AppsEv, ClipsEv, DevicesEv, DumpResult, EngineEvent, EngineNotice, EngineSnapshot, ExportLogsResult, MicMuteEvent, StartResult, StateEv } from "./types";

const KILL_AFTER_MS = 1500;
const STDERR_LINES = 50;
const MAX_NOTICES = 50;
const MAX_LINE_CHARS = 500;
/** Longest wait a renderer may ask of waitMicMuteEvent. */
const MIC_MUTE_WAIT_MAX_MS = 60000;
/** Pending waitMicMuteEvent calls kept at most (one per renderer; a reload leaves one until its timeout). */
const MIC_MUTE_MAX_WAITERS = 4;

// ---- plugin.log ----

const LOG_CAP_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const ZIP_TIMEOUT_MS = 30000;
/** engine.log, engine.1.log, …, plugin.log, plugin.1.log, … */
const LOG_FILE_RE = /^(engine|plugin).*\.log$/i;

/** %APPDATA%\o2i\logs, shared with the engine's engine.log. */
function logsDir(): string {
    return join(app.getPath("appData"), "o2i", "logs");
}

const pluginLogFile = new LogFile({
    dir: logsDir,
    base: "plugin",
    capBytes: LOG_CAP_BYTES,
    keep: LOG_KEEP,
    maxQueue: 1000,
    flushDelayMs: 250,
    retryMs: 60000,
});

let sessionLogged = false;

/**
 * The first plugin.log line of this Discord session, written on first use (startEngine, pluginLog,
 * exportLogs or any other logged event) and never at load: Discord loads this module on every start,
 * also with o2i disabled. Never throws.
 */
function logSessionStart() {
    if (sessionLogged) return;
    sessionLogged = true;
    try {
        const versions = `Discord ${safe(() => app.getVersion()) ?? "?"}, Electron ${process.versions.electron ?? "?"}, Windows ${safe(release) ?? "?"}`;
        pluginLogFile.append(formatLogLine(new Date(), "info", `main: o2i in use this session (${versions})`));
    } catch { /* never throws */ }
}

/** native.ts's own events, as "main: …" lines in plugin.log. Never throws. */
function nlog(level: LogLevel, msg: string) {
    try {
        logSessionStart();
        pluginLogFile.append(formatLogLine(new Date(), level, `main: ${msg}`));
    } catch { /* never throws */ }
}

interface Proc {
    cp: ChildProcessWithoutNullStreams;
    spawnedAt: number;
    done: boolean;
    exited: Promise<void>;
    resolveExited: () => void;
    killTimer: ReturnType<typeof setTimeout> | null;
}

/** The plugin wants an engine (startEngine called, stopEngine not). */
let desired = false;
/** The exe configured in the plugin settings (we run a copy of it). */
let sourcePath: string | null = null;
/** The current child; null when none is alive. */
let proc: Proc | null = null;
/** Children that were asked to shut down and haven't exited yet. */
const dying = new Set<Proc>();
let spawning: Promise<StartResult> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

let status: EngineStatus = "stopped";
let generation = 0;
let engineVersion: string | null = null;
let lastError: string | null = null;
let state: StateEv | null = null;
let devices: DevicesEv | null = null;
let apps: AppsEv | null = null;
let clips: ClipsEv | null = null;
/** Bumped on every devices/apps/clips event (see EngineSnapshot.seq). */
const seq = { devices: 0, apps: 0, clips: 0 };
let notices: EngineNotice[] = [];
let stderrRing: string[] = [];
/** `mic_muted` events for the renderer's long-poll (waitMicMuteEvent); kept across engine restarts. */
const micMuteEvents = new LatestWaiters<Omit<MicMuteEvent, "seq">>({
    set: (fn, ms) => setTimeout(fn, ms),
    clear: t => clearTimeout(t as ReturnType<typeof setTimeout>),
}, MIC_MUTE_MAX_WAITERS);

const noop = () => { };

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Only a full local path to a file named o2i.exe is ever run (the path comes from the renderer). */
function checkExe(exePath: unknown): string | null {
    const bad = enginePathProblem(exePath, true);
    if (bad) return bad;
    try {
        if (!statSync(exePath as string).isFile()) return `Not a file: ${exePath}`; // a string: enginePathProblem checked
    } catch {
        return `Engine not found: ${exePath}`;
    }
    return null;
}

/**
 * Copies the configured exe to userData\o2i-engine\o2i.exe when size or mtime differ, so the running
 * engine never locks the build output. Falls back to an existing copy when the source is gone or the
 * copy is locked.
 */
function engineCopy(src: string): string {
    const dir = join(app.getPath("userData"), "o2i-engine");
    const dst = join(dir, "o2i.exe");
    try {
        const s = statSync(src);
        let same = false;
        try {
            const d = statSync(dst);
            same = d.size === s.size && Math.trunc(d.mtimeMs) === Math.trunc(s.mtimeMs);
        } catch { /* no copy yet */ }
        if (!same) {
            mkdirSync(dir, { recursive: true });
            const tmp = dst + ".tmp";
            copyFileSync(src, tmp);
            utimesSync(tmp, s.atime, s.mtime);
            renameSync(tmp, dst);
            nlog("info", `copied the engine ${src} to ${dst} (${s.size} bytes, modified ${s.mtime.toISOString()})`);
        }
    } catch (e) {
        if (!existsSync(dst)) throw e;
        console.warn("[o2i] using the existing engine copy:", errMsg(e));
        nlog("warn", `couldn't refresh the engine copy (${errMsg(e)}); using the existing copy`);
    }
    return dst;
}

function pushStderr(line: string) {
    stderrRing.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line);
    if (stderrRing.length > STDERR_LINES) stderrRing.splice(0, stderrRing.length - STDERR_LINES);
}

function onStdoutLine(p: Proc, line: string) {
    if (p !== proc) return;
    const text = line.trim();
    if (!text) return;
    let ev: EngineEvent;
    try {
        ev = JSON.parse(text);
    } catch {
        pushStderr("[stdout] " + text);
        return;
    }
    switch (ev?.ev) {
        case "ready":
            status = "running";
            engineVersion = typeof ev.version === "string" ? ev.version : null;
            nlog("info", `engine ready (o2i ${engineVersion ?? "version unknown"}, pid ${p.cp.pid})`);
            break;
        case "state":
            state = ev;
            break;
        case "devices":
            devices = ev;
            seq.devices++;
            break;
        case "apps":
            apps = ev;
            seq.apps++;
            break;
        case "clips":
            clips = ev;
            seq.clips++;
            break;
        case "error":
            // Logged by the renderer when it drains the notices.
            notices.push({ kind: "error", message: String(ev.message) });
            if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES);
            break;
        case "hotkey_error":
            // One-shot (the current list is state.hotkey_errors): logged here, nothing to cache.
            nlog("warn", `hotkey ${String(ev.accel)} couldn't be registered: ${String(ev.message)}`);
            break;
        case "mic_muted": {
            // Logged by the renderer. The cached state follows right away, so a poll never shows the old value.
            const muted = ev.muted === true;
            if (state) state = { ...state, mic_muted: muted };
            micMuteEvents.publish({ muted, source: typeof ev.source === "string" ? ev.source : "unknown" });
            break;
        }
    }
}

function clearRestart() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
}

function scheduleRestart(delay: number) {
    clearRestart();
    nlog("info", `restarting the engine in ${delay / 1000} s (failure ${failures})`);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!desired || proc) return;
        const r = spawnChild();
        if (!r.ok) {
            status = "crashed";
            lastError = r.error;
            scheduleRestart(nextDelay(failures++));
        }
    }, delay);
}

function onGone(p: Proc, code: number | null, signal: NodeJS.Signals | null, err: Error | null) {
    if (p.done) return;
    p.done = true;
    if (p.killTimer) clearTimeout(p.killTimer);
    dying.delete(p);
    p.resolveExited();
    const why = err ? `couldn't start (${err.message})` : `exited (${signal ?? `code ${code}`})`;
    const ran = `after ${((Date.now() - p.spawnedAt) / 1000).toFixed(1)} s`;
    if (p !== proc || !desired) {
        // Deliberately stopped or replaced.
        nlog("info", `engine (pid ${p.cp.pid ?? "none"}) ${why} ${ran}, as asked`);
        if (p !== proc) return;
        proc = null;
        state = null;
        status = "stopped";
        return;
    }
    proc = null;
    state = null;
    if (Date.now() - p.spawnedAt >= STABLE_RESET_MS) failures = 0;
    const delay = nextDelay(failures);
    failures++;
    const tail = stderrRing.slice(-3).join(" | ");
    status = "crashed";
    lastError = `o2i engine ${why}${tail ? `: ${tail}` : ""}`;
    nlog("error", `engine (pid ${p.cp.pid ?? "none"}) ${why} ${ran} unexpectedly${tail ? `; last stderr: ${tail}` : ""}`);
    scheduleRestart(delay);
}

function spawnChild(): StartResult {
    if (!sourcePath) return { ok: false, error: "No engine path set" };
    let exe: string;
    try {
        exe = engineCopy(sourcePath);
    } catch (e) {
        nlog("error", `couldn't copy the engine ${sourcePath}: ${errMsg(e)}`);
        return { ok: false, error: `Couldn't copy the engine: ${errMsg(e)}` };
    }
    let cp: ChildProcessWithoutNullStreams;
    try {
        cp = spawn(exe, ["--headless"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
        nlog("error", `couldn't start the engine ${exe}: ${errMsg(e)}`);
        return { ok: false, error: `Couldn't start the engine: ${errMsg(e)}` };
    }

    let resolveExited = noop;
    const exited = new Promise<void>(r => { resolveExited = r; });
    const p: Proc = { cp, spawnedAt: Date.now(), done: false, exited, resolveExited, killTimer: null };
    proc = p;
    generation++;
    const gen = generation;
    status = "starting";
    engineVersion = null;
    state = null;
    stderrRing = [];

    const out = new LineSplitter();
    const err = new LineSplitter();
    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");
    cp.stdout.on("data", (chunk: string) => {
        for (const line of out.push(chunk)) onStdoutLine(p, line);
    });
    cp.stderr.on("data", (chunk: string) => {
        if (p !== proc) return;
        for (const line of err.push(chunk)) if (line.trim()) pushStderr(line);
    });
    // A write to a dead child's stdin must never become an uncaught exception in Discord's main process.
    cp.stdin.on("error", noop);
    cp.stdout.on("error", noop);
    cp.stderr.on("error", noop);

    cp.on("spawn", () => {
        nlog("info", `engine spawned (pid ${cp.pid}, generation ${gen}) from ${exe}`);
        if (p === proc && status === "starting") status = "running";
    });
    cp.on("error", e => {
        // Only a failed spawn means the process is gone; other errors (e.g. a failed kill) don't.
        if (cp.pid === undefined) onGone(p, null, null, e);
        else {
            console.warn("[o2i] engine process error:", errMsg(e));
            nlog("warn", `engine (pid ${cp.pid}) process error: ${errMsg(e)}`);
        }
    });
    cp.on("exit", (code, signal) => onGone(p, code, signal, null));
    return { ok: true };
}

/** Asks a child to shut down; kills it if it is still alive after KILL_AFTER_MS. */
function stopProc(p: Proc) {
    if (p === proc) proc = null;
    if (p.done) return;
    nlog("info", `stopping the engine (pid ${p.cp.pid ?? "none"})`);
    dying.add(p);
    try {
        p.cp.stdin.write('{"cmd":"shutdown"}\n');
        p.cp.stdin.end();
    } catch { /* already closed */ }
    p.killTimer = setTimeout(() => {
        nlog("warn", `engine (pid ${p.cp.pid ?? "none"}) still running ${KILL_AFTER_MS} ms after shutdown; killing it`);
        try { p.cp.kill(); } catch { /* already gone */ }
    }, KILL_AFTER_MS);
}

async function waitForDying() {
    if (!dying.size) return;
    await Promise.race([
        Promise.all([...dying].map(p => p.exited)),
        new Promise(r => setTimeout(r, KILL_AFTER_MS + 1500)),
    ]);
}

export async function startEngine(_: IpcMainInvokeEvent, exePath: string): Promise<StartResult> {
    logSessionStart();
    // Already running (or backing off after a crash) from this exe: re-attach (e.g. after Ctrl+R). Before
    // the exe check, so a source exe that is missing right now (mid-rebuild) never kills a healthy engine;
    // sourcePath only ever holds a path that passed checkExe, and restarts run the userData copy.
    if (exePath === sourcePath && (proc || restartTimer)) {
        nlog("info", `re-attached to the ${proc ? "running" : "restarting"} engine (e.g. after a reload)`);
        desired = true;
        return { ok: true };
    }
    const bad = checkExe(exePath);
    if (bad) return { ok: false, error: bad };
    desired = true;

    if (exePath !== sourcePath) {
        nlog("info", `engine exe: ${exePath}${proc ? " (replacing the running engine)" : ""}`);
        sourcePath = exePath;
        failures = 0;
        clearRestart();
        if (proc) stopProc(proc); // a different exe was chosen: replace the running engine
    }
    if (spawning) return spawning;

    const run = (async (): Promise<StartResult> => {
        try {
            await waitForDying();
            if (!desired) return { ok: false, error: "Engine was stopped" };
            if (proc) return { ok: true };
            lastError = null;
            const r = spawnChild();
            if (!r.ok) {
                status = "stopped";
                lastError = r.error;
            }
            return r;
        } finally {
            spawning = null;
        }
    })();
    spawning = run;
    return run;
}

export function stopEngine(_: IpcMainInvokeEvent): void {
    if (restartTimer) nlog("info", "engine off: cancelled the pending restart");
    micMuteEvents.cancelAll(); // the renderer's long-poll ends now instead of at its timeout
    desired = false;
    clearRestart();
    failures = 0;
    if (proc) stopProc(proc);
    status = "stopped";
    state = null;
    lastError = null;
}

export function sendCommand(_: IpcMainInvokeEvent, json: string): boolean {
    const p = proc;
    if (!p || typeof json !== "string" || !p.cp.stdin.writable) return false;
    try {
        p.cp.stdin.write(json.replace(/[\r\n]+/g, " ") + "\n");
        return true;
    } catch {
        return false;
    }
}

export function pollEngine(_: IpcMainInvokeEvent): EngineSnapshot {
    const drained = notices;
    notices = [];
    return { status, generation, engineVersion, lastError, state, devices, apps, clips, seq: { ...seq }, notices: drained, micMuteSeq: micMuteEvents.seq };
}

/**
 * The renderer's long-poll for the mic mute: resolves with the next `mic_muted` event, or null after
 * `timeoutMs` (capped at 60 s) or when the engine is stopped. With `afterSeq` (the last event the caller
 * saw), a newer event that came in between two calls is returned right away. Never rejects.
 */
export function waitMicMuteEvent(_: IpcMainInvokeEvent, timeoutMs: number, afterSeq?: number): Promise<MicMuteEvent | null> {
    return new Promise(resolve => {
        try {
            const ms = Math.min(MIC_MUTE_WAIT_MAX_MS, Math.max(0, Number(timeoutMs) || 0));
            micMuteEvents.wait(ms, typeof afterSeq === "number" && Number.isFinite(afterSeq) ? afterSeq : undefined, resolve);
        } catch {
            resolve(null);
        }
    });
}

export function dumpLegacyConfig(_: IpcMainInvokeEvent, exePath: string): Promise<DumpResult> {
    const bad = checkExe(exePath);
    if (bad) return Promise.resolve({ ok: false, error: bad });
    return new Promise(resolve => {
        try {
            execFile(exePath, ["--dump-config"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
                if (err) {
                    resolve({ ok: false, error: `--dump-config failed: ${err.message}` });
                    return;
                }
                const text = String(stdout).trim();
                try {
                    resolve({ ok: true, profile: JSON.parse(text) });
                } catch {
                    resolve({ ok: false, error: `--dump-config printed no JSON: ${text.slice(0, 200)}` });
                }
            });
        } catch (e) {
            resolve({ ok: false, error: `--dump-config failed: ${errMsg(e)}` });
        }
    });
}

/** A full local path (no UNC / device path) to an existing file. */
export function pathExists(_: IpcMainInvokeEvent, p: string): boolean {
    try {
        return typeof p === "string" && enginePathProblem(p, false) === null && statSync(p).isFile();
    } catch {
        return false;
    }
}

// ---- folder picker ----

/** Electron's folder picker on the calling Discord window; the chosen folder, or null (cancelled / failed). */
export async function pickFolder(e: IpcMainInvokeEvent, title?: string): Promise<string | null> {
    try {
        const options: OpenDialogOptions = {
            title: typeof title === "string" && title.trim() ? title.slice(0, 200) : "Choose a folder",
            properties: ["openDirectory"],
        };
        const win = BrowserWindow.fromWebContents(e.sender);
        const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        return res.canceled ? null : res.filePaths[0] ?? null;
    } catch (err) {
        nlog("error", `folder picker failed: ${errMsg(err)}`);
        return null;
    }
}

// ---- default sounds ----

const DEFAULT_SOUNDS: readonly [file: string, base64: string][] = [
    ["ping.mp3", pingMp3],
    ["filthy.mp3", filthyMp3],
];

/**
 * Writes the sounds that ship with the plugin to %APPDATA%/o2i/sounds (the folder is created if needed;
 * a file that's already there is never overwritten, he may have replaced it) and returns that folder,
 * or null when it couldn't be made. Never throws.
 */
export async function ensureDefaultSounds(_?: IpcMainInvokeEvent): Promise<string | null> {
    try {
        const dir = join(app.getPath("appData"), "o2i", "sounds");
        mkdirSync(dir, { recursive: true });
        for (const [file, b64] of DEFAULT_SOUNDS) {
            try {
                // "wx": fails if the file exists, so an existing file is never touched.
                await writeFile(join(dir, file), Buffer.from(b64, "base64"), { flag: "wx" });
                nlog("info", `wrote the default sound ${file} to ${dir}`);
            } catch (e) {
                if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") nlog("warn", `couldn't write the default sound ${file}: ${errMsg(e)}`);
            }
        }
        return dir;
    } catch (e) {
        nlog("error", `couldn't set up the default sounds folder: ${errMsg(e)}`);
        return null;
    }
}

// ---- logging + export ----

/** The renderer's log lines (already rate-limited there). Never throws. */
export function pluginLog(_: IpcMainInvokeEvent, level: LogLevel, msg: string): void {
    try {
        logSessionStart();
        const lvl: LogLevel = level === "warn" || level === "error" ? level : "info";
        pluginLogFile.append(formatLogLine(new Date(), lvl, typeof msg === "string" ? msg : String(msg)));
    } catch { /* never throws */ }
}

function safe<T>(fn: () => T): T | null {
    try {
        return fn();
    } catch {
        return null;
    }
}

/** What only the main process knows: OS / Electron versions and the engine process's state. */
function mainInfo() {
    return {
        os: { platform: process.platform, release: safe(release), version: safe(osVersion), arch: process.arch },
        discordApp: safe(() => app.getVersion()),
        electron: process.versions.electron ?? null,
        chrome: process.versions.chrome ?? null,
        engine: {
            status,
            generation,
            version: engineVersion,
            desired,
            failures,
            running: !!proc,
            lastError,
            stderrTail: stderrRing.slice(-20),
        },
        logsDir: safe(logsDir),
    };
}

type Redact = (text: string) => string;

/** summary.json: the renderer's summary (o2i data only) plus mainInfo() and what was copied; home folder and user name redacted. */
function summaryText(summaryJson: unknown, files: string[], failed: string[], redact: Redact): string {
    let renderer: unknown;
    try {
        renderer = typeof summaryJson === "string" ? JSON.parse(summaryJson) : null;
    } catch {
        renderer = { unparsed: String(summaryJson).slice(0, 20000) };
    }
    const base = renderer && typeof renderer === "object" && !Array.isArray(renderer) ? renderer : { renderer };
    // Value by value before stringifying: redacting the JSON text could miss or break escaped strings.
    return JSON.stringify(redactJson({ ...base, main: mainInfo(), export: { files, failed } }, redact), null, 2);
}

/**
 * Writes one log (up to 5 MB) to `dst` with the home folder and user name redacted; async, so it never
 * blocks Discord's main process. The writers may hold it open: when a plain read is refused, the file is
 * copied to `rawCopy` first (outside the zipped folder, so an unredacted copy can never end up in the zip).
 */
async function copyLog(src: string, dst: string, rawCopy: string, redact: Redact) {
    let text: string;
    try {
        text = await readFile(src, "utf8");
    } catch {
        await copyFile(src, rawCopy);
        text = await readFile(rawCopy, "utf8");
    }
    await writeFile(dst, redact(text), "utf8");
}

/** `<dir>\o2i-logs-<YYYYMMDD-HHMMSS>.zip`, with -2, -3, … if that name is taken. */
function freeZipPath(dir: string, at: Date): string {
    const name = exportZipName(at);
    let p = join(dir, name);
    for (let n = 2; existsSync(p) && n < 100; n++) p = join(dir, name.replace(/\.zip$/, `-${n}.zip`));
    return p;
}

function powershellExe(): string {
    const full = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return existsSync(full) ? full : "powershell.exe";
}

/** In the export's work folder: the files to zip, and the zip Compress-Archive writes. */
const ZIP_FILES_DIR = "files";
const ZIP_OUT = "o2i-logs.zip";

/**
 * Fixed text. The work folder reaches PowerShell only as $env:O2I_ZIP_WORK (never in the command), and
 * the destination is a relative name in it: Compress-Archive resolves -DestinationPath's folder as a
 * wildcard path, so a full path with [ ] in it (e.g. a moved Downloads folder) would break it.
 */
const ZIP_COMMAND = "$ErrorActionPreference = 'Stop'; "
    + "Set-Location -LiteralPath $env:O2I_ZIP_WORK; "
    + `$files = @(Get-ChildItem -LiteralPath '${ZIP_FILES_DIR}' -File | ForEach-Object { $_.FullName }); `
    + `Compress-Archive -LiteralPath $files -DestinationPath '${ZIP_OUT}' -CompressionLevel Optimal`;

/** Zips `<work>\files\*` into `<work>\o2i-logs.zip` with PowerShell's Compress-Archive; resolves with the zip's path. */
function zipFolder(work: string): Promise<string> {
    const out = join(work, ZIP_OUT);
    return new Promise((resolve, reject) => {
        try {
            execFile(
                powershellExe(),
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ZIP_COMMAND],
                { windowsHide: true, timeout: ZIP_TIMEOUT_MS, env: { ...process.env, O2I_ZIP_WORK: work } },
                (err, _stdout, stderr) => {
                    if (err) {
                        // PowerShell's error text without its "At line:…" position block.
                        const text = String(stderr ?? "").split(/\r?\nAt line:/)[0].replace(/\s+/g, " ").trim();
                        reject(new Error(err.killed ? `Compress-Archive took longer than ${ZIP_TIMEOUT_MS / 1000} s` : text.slice(0, 300) || err.message));
                    } else if (!existsSync(out)) {
                        reject(new Error("Compress-Archive made no zip"));
                    } else {
                        resolve(out);
                    }
                }
            );
        } catch (e) {
            reject(e);
        }
    });
}

/** Moves the finished zip to its final place (a copy when that is on another drive). */
async function moveFile(src: string, dst: string) {
    try {
        await rename(src, dst);
    } catch {
        await copyFile(src, dst);
    }
}

let exporting = false;

/**
 * "Export logs": copies engine*.log + plugin*.log (the writers may hold them open) with summary.json into
 * a fresh temp folder, zips them there, moves the zip to Downloads\o2i-logs-<YYYYMMDD-HHMMSS>.zip, shows
 * it in Explorer and removes the temp folder. Every file in the zip has the Windows home folder replaced
 * with %USERPROFILE% and the user name with <user> (logic/redact.ts).
 */
export async function exportLogs(_: IpcMainInvokeEvent, summaryJson: string): Promise<ExportLogsResult> {
    if (exporting) return { ok: false, error: "An export is already running" };
    exporting = true;
    const startedAt = new Date();
    let tmp: string | null = null;
    try {
        nlog("info", "exporting logs");
        pluginLogFile.flush(); // before listing: the zip gets every line up to now (and a plugin.log at all)
        const dir = logsDir();
        let names: string[] = [];
        const failed: string[] = [];
        try {
            names = readdirSync(dir).filter(n => LOG_FILE_RE.test(n)).sort();
        } catch (e) {
            failed.push(`${dir}: ${errMsg(e)}`);
        }

        const redact = makeRedactor(safe(homedir), safe(() => userInfo().username));
        tmp = mkdtempSync(join(tmpdir(), "o2i-logs-"));
        const filesDir = join(tmp, ZIP_FILES_DIR);
        mkdirSync(filesDir);
        const files: string[] = [];
        for (const name of names) {
            try {
                const src = join(dir, name);
                if (!statSync(src).isFile()) continue;
                await copyLog(src, join(filesDir, name), join(tmp, `${name}.raw`), redact);
                files.push(name);
            } catch (e) {
                failed.push(`${name}: ${errMsg(e)}`);
            }
        }
        await writeFile(join(filesDir, "summary.json"), summaryText(summaryJson, files, failed, redact), "utf8");

        const zip = await zipFolder(tmp);
        const downloads = app.getPath("downloads");
        mkdirSync(downloads, { recursive: true });
        const dest = freeZipPath(downloads, startedAt);
        await moveFile(zip, dest);
        nlog("info", `exported logs to ${dest}${failed.length ? ` (couldn't copy: ${failed.join("; ")})` : ""}`);
        try {
            shell.showItemInFolder(dest);
        } catch (e) {
            nlog("warn", `couldn't show the zip in Explorer: ${errMsg(e)}`);
        }
        return { ok: true, path: dest };
    } catch (e) {
        nlog("error", `export logs failed: ${errMsg(e)}`);
        return { ok: false, error: errMsg(e) };
    } finally {
        exporting = false;
        if (tmp) {
            try {
                // Retries: PowerShell or a virus scanner may still hold a file for a moment.
                await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
            } catch { /* leave it to the OS's temp cleanup */ }
        }
    }
}

// ---- Discord quitting ----

/** Discord is quitting: no graceful shutdown, just make sure no o2i.exe is left behind. */
function killNow() {
    desired = false;
    clearRestart();
    micMuteEvents.cancelAll();
    for (const p of [proc, ...dying]) {
        if (p && !p.done) {
            // before-quit and exit both land here: log the first kill only
            if (!p.cp.killed) nlog("info", `Discord is quitting: killing the engine (pid ${p.cp.pid ?? "none"})`);
            try { p.cp.kill(); } catch { /* already gone */ }
        }
    }
    proc = null;
    pluginLogFile.flush(); // synchronous: the process is about to end
}

app.on("before-quit", killNow);
process.on("exit", killNow);
