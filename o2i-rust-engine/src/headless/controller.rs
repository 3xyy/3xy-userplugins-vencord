//! Headless engine controller: applies profiles, runs audio, plays clips, maps hotkeys.
//!
//! Single-threaded: the run loop owns the `Controller` and calls it for every
//! command plus `tick()` between commands. Device enumeration, audio-session and
//! icon queries run on their own MTA threads (see `control`, `apps`); engine
//! audio runs on the engine's threads.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::audio::devices::DeviceInfo;
use crate::audio::format::SAMPLE_RATE;
use crate::audio::mixer::store_f32;
use crate::audio::processes;
use crate::config::{Profile, RoutedApp};
use crate::control::{apply_profile_dsp, attach_routed_apps, enumerate_devices, is_ptt_mode};
use crate::elog;
use crate::engine::{CoreStatus, CoreStream, Engine};
use crate::headless::apps;
use crate::headless::protocol::{
    AppStatusJson, AudioStatus, ClipJson, DeviceJson, Event, HotkeyErrorJson, MuteSource,
    PlayingJson, StateEv, TtsInstallJson,
};
use crate::hotkey_thread::{
    bindings_from_profile, plan_bindings, BindingPlan, HotkeyAction, HotkeyEvent, HotkeyThread,
    SoundKey,
};
use crate::instance::InstanceLock;
use crate::llhooks::{parse_mute_spec, MouseSoundHook, MuteBinding, MuteHook};
use crate::soundboard::decode::{probe_duration, ClipDecoder};
use crate::soundboard::folder::list_audio_files;
use crate::soundboard::ClipGains;
use crate::tts::piper::{self, Piper};
use crate::tts::{self, Done, Tts};

/// How often `tick()` re-checks routed apps while audio runs.
const ROUTED_RETRY: Duration = Duration::from_secs(3);
/// How long a start waits for the mic + output streams to report started.
const CORE_START_WAIT: Duration = Duration::from_millis(500);
const CORE_START_POLL: Duration = Duration::from_millis(10);
/// While audio is wanted but in error, `tick()` retries starting it this often.
const AUDIO_RETRY: Duration = Duration::from_secs(2);
/// At most this many mute hotkey presses are applied per `tick()` (far more
/// than a hand can press in one 50 ms tick).
/// Ticks (50 ms each) a held PTT key must read physically up before the
/// flag is cleared.
const PTT_UP_POLLS: u8 = 2;
const MAX_MUTE_PRESSES_PER_TICK: u32 = 16;
/// Most presses of one mouse sound hotkey played per tick.
const MAX_SOUND_PRESSES_PER_TICK: u32 = 8;

/// Shown when another o2i holds the machine-wide audio lock.
const LOCK_BUSY: &str =
    "o2i is already running audio elsewhere (the o2i window or another o2i engine). Close that one first";

/// Whether `tick()` should try starting audio again: wanted, not running,
/// in error, and `AUDIO_RETRY` passed since the last attempt (or failure).
pub fn audio_retry_due(
    wanted: bool,
    running: bool,
    has_error: bool,
    since_last_attempt: Duration,
) -> bool {
    wanted && !running && has_error && since_last_attempt >= AUDIO_RETRY
}

/// The `state.error` text for a failed core stream: `starting` → it failed
/// while audio was being started, else it stopped while running. `None`
/// unless `status` is a failure.
pub fn core_failure_message(status: &CoreStatus, starting: bool) -> Option<String> {
    let CoreStatus::Failed { stream, reason } = status else {
        return None;
    };
    let what = match stream {
        CoreStream::Mic => "Microphone",
        CoreStream::Output => "VB-CABLE output",
    };
    let how = if starting { "failed" } else { "stopped" };
    Some(format!("{what} {how}: {reason}"))
}

const NO_FOLDER: &str = "No clip folder set";
const OUTSIDE_SOURCES: &str = "Sound is not in a soundboard folder";
const NO_SUCH_PLAYING: &str = "No such playing sound";

fn clip_not_found(name: &str) -> String {
    format!("Clip not found: {name}")
}

/// Comparison form of a path string: `/` → `\`, verbatim `\\?\` prefix and
/// trailing separators dropped, lower case (Windows paths ignore case).
fn path_key(s: &str) -> String {
    let s = s.replace('/', "\\");
    let s = if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    };
    s.trim_end_matches('\\').to_lowercase()
}

/// The soundboard source folders: `sb_folders` (blank entries ignored) if any,
/// else `sb_folder`; the same folder listed twice counts once. Legacy
/// file-name keys resolve in the first one.
pub fn sources(p: &Profile) -> Vec<PathBuf> {
    let listed: Vec<&str> = p
        .sb_folders
        .iter()
        .map(String::as_str)
        .filter(|f| !f.trim().is_empty())
        .collect();
    let chosen = if listed.is_empty() {
        p.sb_folder
            .as_deref()
            .filter(|f| !f.trim().is_empty())
            .into_iter()
            .collect()
    } else {
        listed
    };
    let mut seen = HashSet::new();
    chosen
        .into_iter()
        .filter(|f| seen.insert(path_key(f)))
        .map(PathBuf::from)
        .collect()
}

/// A soundboard source: the folder as configured, and its canonical form
/// (`None` = it couldn't be canonicalized, so it's unavailable and skipped for
/// path containment).
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub dir: PathBuf,
    pub canon: Option<PathBuf>,
}

/// Whether two path components are equal ignoring case (Windows paths are
/// case-insensitive). Never lower-cases a whole path: Rust only recognizes the
/// `\?\UNC\` prefix in upper case.
fn component_eq(a: Component, b: Component) -> bool {
    a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
}

/// `target`'s components below `src` (empty when they're equal), comparing
/// whole components case-insensitively; `None` unless `target` is `src` or
/// inside it. Pure: both should already be canonical.
fn rel_below(src: &Path, target: &Path) -> Option<PathBuf> {
    let mut rest = target.components();
    for s in src.components() {
        if !component_eq(s, rest.next()?) {
            return None;
        }
    }
    Some(rest.as_path().to_path_buf())
}

/// The most specific available source containing (or equal to) the
/// canonical `target`, and `target`'s on-disk path below it. Pure.
fn locate_canon<'a>(srcs: &'a [Source], target: &Path) -> Option<(&'a Source, PathBuf)> {
    let mut best: Option<(&Source, usize, PathBuf)> = None;
    for src in srcs {
        let Some(canon) = &src.canon else {
            continue;
        };
        let Some(rel) = rel_below(canon, target) else {
            continue;
        };
        let depth = canon.components().count();
        if best.as_ref().is_none_or(|(_, d, _)| depth > *d) {
            best = Some((src, depth, rel));
        }
    }
    best.map(|(src, _, rel)| (src, rel))
}

/// A sound's identity (its source as configured, joined with its on-disk
/// path below it), if that's a file strictly inside the source.
fn identity(src: &Source, rel: PathBuf) -> Option<PathBuf> {
    if rel.as_os_str().is_empty() {
        return None;
    }
    let id = src.dir.join(rel);
    id.is_file().then_some(id)
}

/// Resolve a sound to its identity path against `srcs` (canonicalized once,
/// see `Controller::refresh_sources`): `path` (absolute; canonicalized, must
/// be inside an available source; `..`, other drives, UNC/verbatim
/// spellings and links out are refused) wins over `file` (a bare file name in
/// the first source). The result has the form `list_clips` reports
/// (`<source as configured>\<on-disk path>`), whatever spelling was asked
/// for; a legacy `file` whose canonical form can't be determined plays from
/// the plain `<first source>\<file>` as before. Errors: `"No clip folder
/// set"` (no source, or neither `file` nor `path`, which `parse_command`
/// already rejects), `"Clip not found: <name>"`, `"Sound is not in a
/// soundboard folder"`.
pub fn resolve_sound_in(
    srcs: &[Source],
    file: Option<&str>,
    path: Option<&str>,
) -> Result<PathBuf, String> {
    let Some(first) = srcs.first() else {
        return Err(NO_FOLDER.into());
    };
    if let Some(path) = path {
        let req = Path::new(path);
        if !req.is_absolute() {
            return Err(OUTSIDE_SOURCES.into());
        }
        return match std::fs::canonicalize(req) {
            // Inside a source: a file there, or not a sound (a folder).
            Ok(canon) => match locate_canon(srcs, &canon) {
                Some((src, rel)) => identity(src, rel).ok_or_else(|| clip_not_found(path)),
                None => Err(OUTSIDE_SOURCES.into()),
            },
            // Missing: "not found" only when the folder it would be in is
            // inside a source.
            Err(_) => {
                let missing_in_source = std::fs::symlink_metadata(req).is_err()
                    && req
                        .parent()
                        .and_then(|d| std::fs::canonicalize(d).ok())
                        .is_some_and(|d| locate_canon(srcs, &d).is_some());
                Err(if missing_in_source {
                    clip_not_found(path)
                } else {
                    OUTSIDE_SOURCES.into()
                })
            }
        };
    }
    let Some(file) = file else {
        return Err(NO_FOLDER.into());
    };
    let candidate = clip_path(&first.dir, file).ok_or_else(|| clip_not_found(file))?;
    // Same containment + identity form as a path (a link out of the folder is
    // refused) when both canonical forms are known; else the plain join (the
    // bare-name guard already blocks traversal).
    let (Some(src_canon), Ok(canon)) = (&first.canon, std::fs::canonicalize(&candidate)) else {
        return Ok(candidate);
    };
    match rel_below(src_canon, &canon) {
        Some(rel) => identity(first, rel).ok_or_else(|| OUTSIDE_SOURCES.into()),
        None => Err(OUTSIDE_SOURCES.into()),
    }
}

/// `resolve_sound_in` against `p`'s sources canonicalized right now
/// (uncached; the controller uses its cached sources).
#[cfg(test)]
pub fn resolve_sound(
    p: &Profile,
    file: Option<&str>,
    path: Option<&str>,
) -> Result<PathBuf, String> {
    let srcs: Vec<Source> = sources(p)
        .into_iter()
        .map(|dir| Source {
            canon: std::fs::canonicalize(&dir).ok(),
            dir,
        })
        .collect();
    resolve_sound_in(&srcs, file, path)
}

/// `(vol_others, vol_self, hear_local)` for playing the sound at `path` (its
/// identity) under profile `p`: the global settings when they override, else
/// its settings entry (by path in any case / slash style, or, legacy, by file
/// name when it sits directly in the first source), else unity gain without
/// local monitoring.
pub fn resolve_clip_gains(p: &Profile, path: &Path) -> (f32, f32, bool) {
    if p.sb_global_override {
        return (
            p.sb_global_others.unwrap_or(1.0),
            p.sb_global_self.unwrap_or(1.0),
            p.sb_global_hear_local,
        );
    }
    let key = path_key(&path.to_string_lossy());
    let by_path = || p.sb_clip_settings.iter().find(|s| path_key(&s.name) == key);
    let by_name = || {
        let first = sources(p).into_iter().next()?;
        let parent = path.parent()?;
        if path_key(&parent.to_string_lossy()) != path_key(&first.to_string_lossy()) {
            return None;
        }
        let name = path.file_name()?.to_string_lossy().to_lowercase();
        p.sb_clip_settings
            .iter()
            .find(|s| s.name.to_lowercase() == name)
    };
    by_path()
        .or_else(by_name)
        .map(|s| (s.vol_others, s.vol_self, s.hear_local))
        .unwrap_or((1.0, 1.0, false))
}

/// Text-to-speech volume: `tts_volume` clamped to 0..2; unset or not finite
/// = 1.0.
pub fn tts_volume(p: &Profile) -> f32 {
    match p.tts_volume {
        Some(v) if v.is_finite() => v.clamp(0.0, 2.0),
        _ => 1.0,
    }
}

/// `(vol_others, vol_self, hear_local)` for text-to-speech: the global
/// soundboard gains (unity when unset), whether or not they override, times
/// `tts_volume`. Speech only; clips never see the volume. The mixer does not
/// clamp per clip, so a gain up to 2 is applied as is (the final output stage
/// clips above full scale).
pub fn tts_gains(p: &Profile) -> (f32, f32, bool) {
    let v = tts_volume(p);
    (
        p.sb_global_others.unwrap_or(1.0) * v,
        p.sb_global_self.unwrap_or(1.0) * v,
        p.sb_global_hear_local,
    )
}

/// The 48 kHz frame to seek to for `pos_s` seconds: negative (or non-finite)
/// → 0, and clamped into `[0, len)` when the clip's length is known.
pub fn seek_target_frames(pos_s: f64, len_frames: Option<u64>) -> u64 {
    let pos = if pos_s.is_finite() {
        pos_s.max(0.0)
    } else {
        0.0
    };
    // `as` saturates, so absurdly large positions can't overflow.
    let frames = (pos * SAMPLE_RATE as f64).round() as u64;
    match len_frames {
        Some(len) => frames.min(len.saturating_sub(1)),
        None => frames,
    }
}

/// `(name, path)` shown for a playing clip's engine label. Headless labels
/// are the sound's identity path → `(file name, Some(path))`; any other label
/// is just a name.
fn label_name_path(label: &str) -> (String, Option<String>) {
    let p = Path::new(label);
    if !p.is_absolute() {
        return (label.to_string(), None);
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| label.to_string());
    (name, Some(label.to_string()))
}

/// `state.gate_threshold_live`: the auto gate's threshold (linear RMS) while
/// `gate_auto` is on and audio runs; `None` otherwise, and while the floor
/// isn't known yet (0) or the value is bogus (a 0 would read as -inf dBFS).
pub fn live_gate_threshold(gate_auto: bool, running: bool, value: f32) -> Option<f32> {
    (gate_auto && running && value.is_finite() && value > 0.0).then_some(value)
}

/// Whether moving from `old` to `new` needs the engine restarted: the mic,
/// output or monitor device changed (they're only read at `Engine::start`).
pub fn needs_audio_restart(old: &Profile, new: &Profile) -> bool {
    old.input_id != new.input_id
        || old.output_id != new.output_id
        || old.sb_monitor_device != new.sb_monitor_device
}

/// Diff attached app channels (name -> channel id) against the routed apps the
/// profile wants: names to attach (in profile order, de-duplicated) and channel
/// ids to remove (sorted).
pub fn plan_routed(
    attached: &HashMap<String, u64>,
    desired: &[RoutedApp],
) -> (Vec<String>, Vec<u64>) {
    let mut to_attach: Vec<String> = Vec::new();
    for app in desired {
        if !attached.contains_key(&app.name) && !to_attach.contains(&app.name) {
            to_attach.push(app.name.clone());
        }
    }
    let mut to_remove: Vec<u64> = attached
        .iter()
        .filter(|(name, _)| !desired.iter().any(|d| &d.name == *name))
        .map(|(_, id)| *id)
        .collect();
    to_remove.sort_unstable();
    (to_attach, to_remove)
}

/// Whether the set of routed app names differs between `old` and `new`
/// (volumes and order don't count). `configure` only tries to attach apps
/// (a process snapshot) when it does; `tick` retries the rest.
pub fn routed_names_changed(old: &[RoutedApp], new: &[RoutedApp]) -> bool {
    let missing_in =
        |a: &[RoutedApp], b: &[RoutedApp]| a.iter().any(|x| !b.iter().any(|y| y.name == x.name));
    missing_in(old, new) || missing_in(new, old)
}

/// Channel ids of attached apps whose process is gone or replaced: the pid
/// they capture is no longer the tree root `pick_tree_root` finds for their
/// name (exited, restarted under a new pid, or no longer the root). Input is
/// `(name, channel id, captured pid)`; output keeps input order.
pub fn stale_app_channels(
    attached: &[(String, u64, u32)],
    procs: &[processes::ProcInfo],
) -> Vec<u64> {
    attached
        .iter()
        .filter(|(name, _, pid)| processes::pick_tree_root(procs, name) != Some(*pid))
        .map(|(_, id, _)| *id)
        .collect()
}

/// `folder/file` when `file` is a bare file name (no directories, no `..`)
/// naming an existing file in `folder`.
fn clip_path(folder: &Path, file: &str) -> Option<PathBuf> {
    let name = Path::new(file);
    if name.file_name() != Some(name.as_os_str()) {
        return None;
    }
    let path = folder.join(name);
    path.is_file().then_some(path)
}

/// One-line summary of what `configure` set up, for the engine log: devices,
/// counts and on/off flags. Never volumes/thresholds (slider drags send
/// configure many times a second; the summary only changes when something
/// that matters does) and never sound paths.
pub fn configure_summary(p: &Profile) -> String {
    let on = |b: bool| if b { "on" } else { "off" };
    let routed = if p.routed_apps.is_empty() {
        "none".to_string()
    } else {
        p.routed_apps
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(",")
    };
    let gate = match (p.gate_enabled, p.gate_auto) {
        (false, _) => "off",
        (true, false) => "on",
        (true, true) => "auto",
    };
    format!(
        "input={} output={} monitor={} sources={} routed={routed} hotkeys={} gate={gate} \
         suppress={} agc={} duck={} voice={} monitor_mic={} global_override={} mute_hotkey={}",
        p.input_id.as_deref().unwrap_or("none"),
        p.output_id.as_deref().unwrap_or("auto"),
        p.sb_monitor_device.as_deref().unwrap_or("default"),
        sources(p).len(),
        p.sb_clip_hotkeys.len() + usize::from(p.sb_stop_all_hotkey.is_some()),
        on(p.suppress_enabled),
        on(p.agc_enabled),
        on(p.duck_enabled),
        p.voice_preset.as_deref().unwrap_or("off"),
        on(p.monitor_mic),
        on(p.sb_global_override),
        p.mic_mute_hotkey
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("none"),
    )
}

/// The `mic_open` rule: not muted, and in PTT mode the chain's gate is open
/// (it publishes that only while audio runs).
fn mic_open_of(muted: bool, ptt_mode: bool, running: bool, ptt_open: bool) -> bool {
    !muted && (!ptt_mode || (running && ptt_open))
}

/// `list_*` calls slower than this are logged.
const SLOW_LIST: Duration = Duration::from_millis(500);

/// Log detail for a `list_*` call that took longer than `SLOW_LIST`.
pub fn slow_list_detail(what: &str, took: Duration, counts: &str) -> Option<String> {
    (took > SLOW_LIST).then(|| format!("{what} took {} ms ({counts})", took.as_millis()))
}

/// Log a `list_*` call that was slow (see `slow_list_detail`).
fn log_if_slow(what: &str, started: Instant, counts: impl FnOnce() -> String) {
    let took = started.elapsed();
    if took > SLOW_LIST {
        if let Some(detail) = slow_list_detail(what, took, &counts()) {
            elog::event("slow_list", &detail);
        }
    }
}

fn device_json(d: DeviceInfo) -> DeviceJson {
    DeviceJson {
        id: d.id,
        name: d.name,
    }
}

pub struct Controller {
    engine: Engine,
    /// Held exactly while the engine runs (one audio owner per machine).
    lock: Option<InstanceLock>,
    hotkeys: HotkeyThread,
    /// The mic mute hotkey (low-level hooks; its thread runs only while
    /// `profile.mic_mute_hotkey` is a valid spec).
    mute_hook: MuteHook,
    /// Soundboard hotkeys on mouse buttons (the mouse hook; its thread runs
    /// only while some such binding is registered).
    sound_mouse: MouseSoundHook,
    /// How the profile's soundboard bindings were last split between
    /// `global-hotkey` and the mouse hook.
    plan: BindingPlan,
    /// Mouse sound bindings that were refused or couldn't be hooked.
    mouse_errors: Vec<(String, String)>,
    /// The push-to-talk key (same hooks, hold semantics): publishes "held"
    /// straight into the engine's `MicParams`. Its thread runs only while
    /// `profile.ptt_key` is a valid spec that isn't the mute hotkey.
    ptt_hook: MuteHook,
    /// Why the PTT key was refused before it reached the hook (it equals the
    /// mute hotkey): `(ptt_key spec, message)`.
    ptt_conflict: Option<(String, String)>,
    /// Consecutive ticks the PTT key read physically up while flagged held.
    ptt_up_polls: u8,
    /// The last `mic_open` value reported, to send the event on change only.
    last_mic_open: bool,
    profile: Profile,
    /// The profile's soundboard sources with their canonical forms, computed
    /// when the sources change (and on `list_clips`), never per play, so an
    /// unreachable network folder can't stall the loop on every play.
    sources: Vec<Source>,
    /// False until the first `configure` (so its hotkeys are always applied).
    configured: bool,
    /// Routed app name -> engine app-channel id, for apps currently attached.
    attached: HashMap<String, u64>,
    /// Playing instance id -> (sound identity path, its live gains). The
    /// soundboard holds the other reference to each `ClipGains`; an entry
    /// whose count drops to 1 has finished and is pruned.
    live: HashMap<u64, (PathBuf, Arc<ClipGains>)>,
    /// Playing text-to-speech instances and their live gains (the global
    /// soundboard gains), pruned like `live`. Not seekable.
    tts_live: HashMap<u64, Arc<ClipGains>>,
    /// Finished speech waiting for the playing one to leave Now Playing
    /// (speech never overlaps). Controller-side only; not in `state.playing`
    /// until it starts.
    tts_wait: VecDeque<tts::Prepared>,
    /// Voice families and the synthesis thread.
    tts: Tts,
    /// The Piper family: installer and synthesizer (also inside `tts`).
    piper: Arc<Piper>,
    /// The last `set_audio` asked for audio on.
    audio_wanted: bool,
    /// Why audio isn't running although wanted (a start failed, or a core
    /// stream died); cleared by a successful start or `set_audio(false)`.
    audio_error: Option<String>,
    /// When audio last tried to start (or a running stream failed); paces
    /// the auto-retry.
    last_audio_attempt: Instant,
    last_routed_check: Instant,
    /// The last `configure_summary` written to the engine log.
    logged_summary: String,
}

impl Controller {
    pub fn new(hotkeys: HotkeyThread) -> Controller {
        let engine = Engine::new();
        let ptt_hook = MuteHook::with_held(engine.params().ptt_held_handle());
        let piper = Piper::system(piper::default_dir());
        Controller {
            engine,
            lock: None,
            hotkeys,
            mute_hook: MuteHook::new(),
            sound_mouse: MouseSoundHook::new(),
            plan: BindingPlan::default(),
            mouse_errors: Vec::new(),
            ptt_hook,
            ptt_conflict: None,
            ptt_up_polls: 0,
            last_mic_open: true,
            profile: Profile::default(),
            sources: Vec::new(),
            configured: false,
            attached: HashMap::new(),
            live: HashMap::new(),
            tts_live: HashMap::new(),
            tts_wait: VecDeque::new(),
            tts: Tts::system(piper.clone()),
            piper,
            audio_wanted: false,
            audio_error: None,
            last_audio_attempt: Instant::now(),
            last_routed_check: Instant::now(),
            logged_summary: String::new(),
        }
    }

    /// Adopt `p`: DSP, master, ducking, per-app volumes, hotkeys and the mute
    /// hotkey (each only when it changed), the monitor device, and the gains
    /// of sounds already playing (per-sound settings / global override apply
    /// live). Audio restarts only when a device changed and audio is on (or a
    /// start failed; the new devices may fix it). Routed-app
    /// additions/removals apply immediately while running. Returns a
    /// `HotkeyError` when a newly set mute hotkey can't be used.
    pub fn configure(&mut self, p: Profile) -> Vec<Event> {
        let mut out = Vec::new();
        let old = std::mem::replace(&mut self.profile, p);
        self.update_live_gains();

        // Entering PTT mode starts closed, even with the key physically held
        // (done before the chain can see the new mode).
        if is_ptt_mode(&self.profile) && (!self.configured || !is_ptt_mode(&old)) {
            self.reset_ptt();
        }
        apply_profile_dsp(&self.engine.params(), &self.profile);
        if let Some(m) = self.profile.master_volume {
            store_f32(&self.engine.master(), m);
        }
        let duck = self.engine.duck_params();
        duck.set_enabled(self.profile.duck_enabled);
        if let Some(t) = self.profile.duck_target {
            duck.set_target(t);
        }
        self.engine
            .set_monitor_device(self.profile.sb_monitor_device.clone());

        if !self.configured || sources(&self.profile) != sources(&old) {
            self.refresh_sources();
        }
        out.extend(self.apply_sound_bindings());
        if !self.configured || self.profile.mic_mute_hotkey != old.mic_mute_hotkey {
            let spec = self.profile.mic_mute_hotkey.as_deref();
            if let Some((accel, message)) = self.mute_hook.set(spec) {
                elog::event("hotkey_error", &format!("{accel}: {message}"));
                out.push(Event::HotkeyError { accel, message });
            }
        }
        if !self.configured
            || self.profile.ptt_key != old.ptt_key
            || self.profile.mic_mute_hotkey != old.mic_mute_hotkey
        {
            if let Some((accel, message)) = self.set_ptt_key() {
                elog::event("hotkey_error", &format!("{accel}: {message}"));
                out.push(Event::HotkeyError { accel, message });
            }
        }
        self.configured = true;
        let summary = configure_summary(&self.profile);
        if summary != self.logged_summary {
            elog::event("configure", &summary);
            self.logged_summary = summary;
        }

        if self.audio_wanted && needs_audio_restart(&old, &self.profile) {
            elog::event("audio_restart", "device changed");
            // Keep the lock (if held) across the restart; a failed start releases it.
            self.engine.stop();
            self.attached.clear();
            self.start_audio();
        } else if self.engine.is_running() {
            // Quiet: configure can arrive many times a second (slider drags).
            // Only a change of the routed apps tries to attach (a process
            // snapshot); a routed app that isn't running is retried by
            // `tick` every `ROUTED_RETRY`.
            let try_attach = routed_names_changed(&old.routed_apps, &self.profile.routed_apps);
            self.sync_routed(try_attach, false);
        }
        out
    }

    /// Turn audio on (no-op if running) or off. Failures land in `state()`.
    pub fn set_audio(&mut self, on: bool) -> Vec<Event> {
        self.audio_wanted = on;
        if on {
            if !self.engine.is_running() {
                self.start_audio();
            }
        } else {
            self.stop_audio("requested off");
            self.audio_error = None;
        }
        Vec::new()
    }

    /// Play a sound by `path` (inside a source) or, legacy, by `file` name
    /// in the first source (see `resolve_sound`), with its resolved gains.
    /// Errors, in order: no folder, not found / outside the sources, can't
    /// decode, audio off.
    pub fn play_clip(&mut self, file: Option<&str>, path: Option<&str>) -> Vec<Event> {
        let shown = path.or(file).unwrap_or_default();
        let error = |message: String| {
            elog::event("clip_error", &format!("play {shown}: {message}"));
            vec![Event::Error { message }]
        };
        let sound = match resolve_sound_in(&self.sources, file, path) {
            Ok(s) => s,
            Err(message) => return error(message),
        };
        // Open it once here (controller thread, not the mixing thread) so a
        // corrupt/empty/unsupported file is reported instead of silently
        // ending on the stream worker. The worker re-opens it to play.
        if let Err(e) = ClipDecoder::open(&sound) {
            return error(format!("Can't play {shown}: {e:#}"));
        }
        if !self.engine.is_running() {
            return error("Audio is off".into());
        }
        let (vol_others, vol_self, hear_local) = resolve_clip_gains(&self.profile, &sound);
        let gains = Arc::new(ClipGains::new(vol_others, vol_self, hear_local));
        // The engine label is the identity path: `state()` shows the file
        // name as `name` and the label as `path`.
        let label = sound.to_string_lossy().into_owned();
        let id = self.engine.play_clip(label, sound.clone(), gains.clone());
        self.prune_live();
        self.live.insert(id, (sound, gains));
        Vec::new()
    }

    /// Every text-to-speech voice. No Windows voices gives an empty list.
    pub fn list_tts_voices(&self) -> Event {
        Event::TtsVoices {
            voices: self.tts.voices(),
        }
    }

    /// Queue `text` to be spoken with `voice`. Errors, in order: empty text,
    /// audio off, unknown voice, queue full. Returns at once: the voice is
    /// synthesized on the TTS thread and the result is played by `tick`
    /// (a synthesis failure then becomes an `error` event).
    pub fn speak(&mut self, text: &str, voice: &str, rate: Option<f64>) -> Vec<Event> {
        let running = self.engine.is_running();
        self.speak_with(text, voice, rate, running)
    }

    fn speak_with(
        &mut self,
        text: &str,
        voice: &str,
        rate: Option<f64>,
        audio_on: bool,
    ) -> Vec<Event> {
        let error = |message: String| {
            elog::event("tts_error", &message);
            vec![Event::Error { message }]
        };
        if tts::normalize_text(text).is_none() {
            return error("Nothing to say".into());
        }
        if !audio_on {
            return error("Audio is off".into());
        }
        match self.tts.voice_installed(voice) {
            Some(true) => {}
            Some(false) => return error(format!("Voice not installed: {voice}")),
            None => return error(format!("Unknown voice: {voice}")),
        }
        if self.tts.in_flight() + self.tts_wait.len() >= tts::MAX_PENDING {
            return error("Too many speech requests queued".into());
        }
        match self
            .tts
            .submit(voice, text, f64::from(tts::clamp_rate(rate)))
        {
            Ok(()) => Vec::new(),
            Err(message) => error(message),
        }
    }

    /// Start installing the Piper voice `id` on the installer thread. Errors
    /// (an unknown id, or an install already running) come back at once; a
    /// failure while installing arrives later as an `error` event, and a
    /// finished install as a fresh `tts_voices` event.
    pub fn install_tts_voice(&mut self, id: &str) -> Vec<Event> {
        match self.piper.install(id) {
            Ok(()) => Vec::new(),
            Err(message) => {
                elog::event("tts_error", &message);
                vec![Event::Error { message }]
            }
        }
    }

    /// Queue finished speech (or report why it failed), then start the next
    /// waiting item if no speech is playing.
    fn poll_tts(&mut self, out: &mut Vec<Event>) {
        for result in self.piper.take_results() {
            match result {
                Ok(_) => out.push(self.list_tts_voices()),
                Err(message) => {
                    elog::event("tts_error", &message);
                    out.push(Event::Error { message });
                }
            }
        }
        let running = self.engine.is_running();
        for done in self.tts.poll() {
            match done {
                Done::Ready(p) => {
                    if running {
                        self.tts_wait.push_back(p);
                    } else {
                        out.push(Event::Error {
                            message: "Audio is off".into(),
                        });
                    }
                }
                Done::Failed(message) => {
                    elog::event("tts_error", &message);
                    out.push(Event::Error { message });
                }
            }
        }
        self.advance_tts(running);
    }

    /// Start the next waiting speech when none is playing (the soundboard
    /// dropped the previous one: finished or stopped). Speech plays in order,
    /// one at a time. Audio off drops everything waiting.
    fn advance_tts(&mut self, running: bool) {
        self.prune_live();
        if !running {
            self.tts_wait.clear();
            return;
        }
        if !self.tts_live.is_empty() {
            return;
        }
        let Some(p) = self.tts_wait.pop_front() else {
            return;
        };
        let (others, me, hear_local) = tts_gains(&self.profile);
        let gains = Arc::new(ClipGains::new(others, me, hear_local));
        let id = self.engine.play_buffer(p.name, p.stream, gains.clone());
        self.tts_live.insert(id, gains);
    }

    /// Play the sound a hotkey names (a path or a legacy file name).
    pub fn play_key(&mut self, key: &SoundKey) -> Vec<Event> {
        let (file, path) = key.args();
        self.play_clip(file, path)
    }

    /// Jump playing instance `id` to `pos_s` seconds, clamped into the clip
    /// (see `seek_target_frames`). An unknown id (or audio off) is an error
    /// event. The seek runs on the clip's decoder worker; `state()` shows the
    /// new position within a block or two.
    pub fn seek_clip(&mut self, id: u64, pos_s: f64) -> Vec<Event> {
        if self.tts_live.contains_key(&id) {
            return vec![Event::Error {
                message: "Speech can't be seeked".into(),
            }];
        }
        let Some(len_frames) = self.playing_len(id) else {
            elog::event("clip_error", &format!("seek id={id}: {NO_SUCH_PLAYING}"));
            return vec![Event::Error {
                message: NO_SUCH_PLAYING.into(),
            }];
        };
        self.engine
            .seek_clip(id, seek_target_frames(pos_s, len_frames));
        Vec::new()
    }

    pub fn pause_clip(&mut self, id: u64) {
        self.engine.pause_clip(id);
    }

    pub fn resume_clip(&mut self, id: u64) {
        self.engine.resume_clip(id);
    }

    pub fn stop_clip(&mut self, id: u64) {
        self.engine.stop_clip(id);
    }

    pub fn stop_all(&mut self) {
        self.tts_wait.clear();
        self.engine.stop_all_clips();
    }

    /// Whether the mic is muted.
    pub fn mic_muted(&self) -> bool {
        self.engine.params().mic_muted()
    }

    /// Mute or unmute the mic (the chain ramps its output over ~10 ms; the
    /// soundboard and routed apps keep playing). Returns one `mic_muted`
    /// event when the flag changed, nothing when it already had that value.
    /// The flag lives in the engine's `MicParams`, so it holds across audio
    /// restarts and `configure`.
    pub fn set_mic_muted(&mut self, muted: bool, source: MuteSource) -> Vec<Event> {
        if self.mic_muted() == muted {
            return Vec::new();
        }
        self.engine.params().set_mic_muted(muted);
        let by = match source {
            MuteSource::Command => "command",
            MuteSource::Hotkey => "hotkey",
        };
        let state = if muted { "on" } else { "off" };
        elog::event("mic_mute", &format!("{state} ({by})"));
        vec![Event::MicMuted { muted, source }]
    }

    /// Whether the mic is audible: not muted, and (always mode, or the PTT
    /// gate is open: key held or in the release tail).
    pub fn mic_open(&self) -> bool {
        let params = self.engine.params();
        mic_open_of(
            params.mic_muted(),
            params.ptt_mode(),
            self.engine.is_running(),
            params.ptt_open(),
        )
    }

    /// Split the profile's soundboard bindings between `global-hotkey`
    /// (keyboard) and the mouse hook, applying whichever part changed. Mouse
    /// bindings that overlap the mute or PTT key, repeat an earlier one or
    /// exceed the limit are refused with a `HotkeyError` (reported when the
    /// mouse part changes, and listed in the state until then).
    fn apply_sound_bindings(&mut self) -> Vec<Event> {
        let spec = |s: &Option<String>| {
            s.as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .and_then(|k| parse_mute_spec(k).ok())
        };
        let mut reserved: Vec<(&str, MuteBinding)> = Vec::new();
        if let Some(b) = spec(&self.profile.mic_mute_hotkey) {
            reserved.push(("mute hotkey", b));
        }
        if let Some(b) = spec(&self.profile.ptt_key) {
            reserved.push(("push-to-talk key", b));
        }
        let plan = plan_bindings(bindings_from_profile(&self.profile), &reserved);
        let first = !self.configured;
        if first || plan.keyboard != self.plan.keyboard {
            self.hotkeys.set(plan.keyboard.clone());
        }
        let mut out = Vec::new();
        if first || plan.mouse != self.plan.mouse || plan.errors != self.plan.errors {
            let mut errors = plan.errors.clone();
            let hooks: Vec<MuteBinding> = plan.mouse.iter().map(|m| m.binding).collect();
            if let Err(message) = self.sound_mouse.set(&hooks) {
                errors.extend(
                    plan.mouse
                        .iter()
                        .map(|m| (m.accel.clone(), message.clone())),
                );
            }
            for (accel, message) in &errors {
                elog::event("hotkey_error", &format!("{accel}: {message}"));
                out.push(Event::HotkeyError {
                    accel: accel.clone(),
                    message: message.clone(),
                });
            }
            self.mouse_errors = errors;
        }
        self.plan = plan;
        out
    }

    /// Do what a hotkey press asks.
    fn run_hotkey_action(&mut self, action: HotkeyAction, out: &mut Vec<Event>) {
        match action {
            HotkeyAction::Clip(key) => out.extend(self.play_key(&key)),
            HotkeyAction::StopAll => self.stop_all(),
        }
    }

    /// Forget a held PTT key and close the gate: the mic stays closed until a
    /// fresh key-down, even if the key is physically held right now.
    fn reset_ptt(&self) {
        self.ptt_hook.clear_held();
        self.engine.params().set_ptt_open(false);
    }

    /// Register (or remove) the PTT key hook for the current profile.
    /// Returns `(accel, message)` when the key can't be used; the mic then
    /// stays closed in PTT mode (no fallback to open).
    fn set_ptt_key(&mut self) -> Option<(String, String)> {
        self.ptt_conflict = None;
        let key = self
            .profile
            .ptt_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let Some(key) = key else {
            self.ptt_hook.set(None);
            return None;
        };
        let mute = self
            .profile
            .mic_mute_hotkey
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let same_as_mute = mute.is_some_and(|m| {
            m.eq_ignore_ascii_case(key)
                || matches!((parse_mute_spec(m), parse_mute_spec(key)), (Ok(a), Ok(b)) if a == b)
        });
        if same_as_mute {
            self.ptt_hook.set(None);
            let err = (
                key.to_string(),
                format!("push-to-talk key {key:?} is the same as the mute hotkey"),
            );
            self.ptt_conflict = Some(err.clone());
            return Some(err);
        }
        self.ptt_hook.set(Some(key)).map(|(accel, message)| {
            let message = message.replacen("invalid mute hotkey", "invalid push-to-talk key", 1);
            (accel, message)
        })
    }

    /// The PTT key problem to list in `hotkey_errors`, if any.
    fn ptt_error(&self) -> Option<&(String, String)> {
        self.ptt_conflict.as_ref().or(self.ptt_hook.error())
    }

    /// Safety net for a key-up the hook never saw: while the PTT flag says
    /// held but `probe` reads the key physically up on `PTT_UP_POLLS`
    /// consecutive ticks, clear the flag so the normal release tail runs and
    /// the mic closes. Two reads, because inside the hook a fresh press is
    /// not yet visible to the async key state.
    fn poll_ptt_physical(&mut self, probe: impl FnOnce(crate::llhooks::Trigger) -> bool) {
        if self.ptt_hook.held_but_physically_up(probe) {
            self.ptt_up_polls += 1;
            if self.ptt_up_polls >= PTT_UP_POLLS {
                self.ptt_hook.clear_held();
                self.ptt_up_polls = 0;
                elog::event("ptt", "key-up missed, released");
            }
        } else {
            self.ptt_up_polls = 0;
        }
    }

    /// One `mic_open` event when `mic_open()` changed since the last report.
    fn sync_mic_open(&mut self, out: &mut Vec<Event>) {
        let open = self.mic_open();
        if open != self.last_mic_open {
            self.last_mic_open = open;
            elog::event("mic_open", if open { "open" } else { "closed" });
            out.push(Event::MicOpen { open });
        }
    }

    pub fn list_devices(&self) -> Event {
        let started = Instant::now();
        let d = enumerate_devices();
        log_if_slow("list_devices", started, || {
            format!("{} inputs, {} outputs", d.inputs.len(), d.outputs.len())
        });
        Event::Devices {
            inputs: d.inputs.into_iter().map(device_json).collect(),
            outputs: d.outputs.into_iter().map(device_json).collect(),
            cable: d.cable.map(device_json),
        }
    }

    pub fn list_apps(&self) -> Event {
        let started = Instant::now();
        let apps = apps::list_apps();
        log_if_slow("list_apps", started, || format!("{} apps", apps.len()));
        Event::Apps { apps }
    }

    /// Audio files of every source, flattened in source order (each sorted by
    /// name), with container durations, identity paths and their source as
    /// configured; `folder` is the first source. Missing folders list nothing.
    /// Non-UTF-8 names are skipped: they couldn't be named in `play_clip`.
    /// Also refreshes the cached canonical sources (it reads every folder
    /// anyway), so a folder that became reachable plays again by path.
    pub fn list_clips(&mut self) -> Event {
        let started = Instant::now();
        self.refresh_sources();
        let srcs: Vec<PathBuf> = self.sources.iter().map(|s| s.dir.clone()).collect();
        let mut clips = Vec::new();
        for src in &srcs {
            let Some(source) = src.to_str() else {
                continue;
            };
            for path in list_audio_files(src) {
                let (Some(file), Some(path_s)) =
                    (path.file_name().and_then(|n| n.to_str()), path.to_str())
                else {
                    continue;
                };
                clips.push(ClipJson {
                    file: file.to_string(),
                    duration_s: probe_duration(&path).map(|d| d as f32),
                    path: path_s.to_string(),
                    source: source.to_string(),
                });
            }
        }
        log_if_slow("list_clips", started, || {
            format!("{} sources, {} clips", srcs.len(), clips.len())
        });
        Event::Clips {
            folder: srcs.first().and_then(|s| s.to_str()).map(str::to_string),
            clips,
        }
    }

    /// Drain hotkey events (presses play/stop clips; registration failures
    /// become `HotkeyError`), toggle the mic mute once per mute hotkey press
    /// (one `mic_muted` event each), stop audio (with an error) if the mic or output
    /// stream died, retry a failed start every `AUDIO_RETRY` while audio is
    /// wanted, and every `ROUTED_RETRY` while audio runs, detach routed apps
    /// whose process exited or whose capture died and attach ones that
    /// appeared.
    pub fn tick(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        self.prune_live();
        self.poll_tts(&mut out);
        while let Some(ev) = self.hotkeys.try_recv() {
            match ev {
                HotkeyEvent::Pressed(action) => self.run_hotkey_action(action, &mut out),
                HotkeyEvent::Error { accel, message } => {
                    elog::event("hotkey_error", &format!("{accel}: {message}"));
                    out.push(Event::HotkeyError { accel, message })
                }
            }
        }
        let mouse_presses = self.sound_mouse.take_presses();
        for (slot, presses) in mouse_presses.into_iter().enumerate() {
            let Some(action) = self.plan.mouse.get(slot).map(|m| m.action.clone()) else {
                continue;
            };
            // Each press plays once, like a keyboard press (bounded per tick).
            for _ in 0..presses.min(MAX_SOUND_PRESSES_PER_TICK) {
                self.run_hotkey_action(action.clone(), &mut out);
            }
        }
        for _ in 0..self.mute_hook.take_presses(MAX_MUTE_PRESSES_PER_TICK) {
            let muted = !self.mic_muted();
            out.extend(self.set_mic_muted(muted, MuteSource::Hotkey));
        }
        self.poll_ptt_physical(crate::llhooks::physically_down);
        self.sync_mic_open(&mut out);
        if self.engine.is_running() {
            let status = self.engine.core_stream_status();
            self.apply_core_status(status);
        }
        if audio_retry_due(
            self.audio_wanted,
            self.engine.is_running(),
            self.audio_error.is_some(),
            self.last_audio_attempt.elapsed(),
        ) {
            self.start_audio();
        }
        if self.engine.is_running() && self.last_routed_check.elapsed() >= ROUTED_RETRY {
            self.last_routed_check = Instant::now();
            if !self.profile.routed_apps.is_empty() || !self.attached.is_empty() {
                self.drop_dead_apps();
                self.drop_exited_apps();
                self.sync_routed(true, false);
            }
        }
        out
    }

    /// React to the running engine's core stream health: a dead mic or
    /// output stream stops audio and becomes `state.error`.
    fn apply_core_status(&mut self, status: CoreStatus) {
        if let Some(message) = core_failure_message(&status, false) {
            // stderr as before; the log gets the event (no duplicate line).
            eprintln!("[headless] {message}");
            elog::event("core_stream_failed", &message);
            self.stop_audio("core stream failed");
            self.audio_error = Some(message);
            self.last_audio_attempt = Instant::now();
        }
    }

    pub fn state(&self) -> Event {
        let running = self.engine.is_running();
        let audio = if running {
            AudioStatus::Running
        } else if self.audio_error.is_some() {
            AudioStatus::Error
        } else {
            AudioStatus::Off
        };
        let input_level = if running {
            let v = self.engine.params().input_level();
            if v.is_finite() {
                v
            } else {
                0.0
            }
        } else {
            0.0
        };
        let playing = if running {
            let snapshot = self.engine.sb_playing();
            let guard = snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let rate = SAMPLE_RATE as f32;
            guard
                .iter()
                .map(|s| {
                    let (name, path) = label_name_path(&s.name);
                    PlayingJson {
                        id: s.id,
                        name,
                        pos_s: s.pos_frames as f32 / rate,
                        len_s: s.len_frames.map(|n| n as f32 / rate),
                        paused: s.paused,
                        path,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        let apps = self
            .profile
            .routed_apps
            .iter()
            .map(|a| AppStatusJson {
                name: a.name.clone(),
                attached: running
                    && self
                        .attached
                        .get(&a.name)
                        .is_some_and(|id| self.channel_alive(*id)),
            })
            .collect();
        Event::State(StateEv {
            audio,
            error: if running {
                None
            } else {
                self.audio_error.clone()
            },
            input_level,
            playing,
            apps,
            hotkey_errors: self
                .hotkeys
                .failing()
                .into_iter()
                .chain(self.mouse_errors.iter().cloned())
                .chain(self.mute_hook.error().cloned())
                .chain(self.ptt_error().cloned())
                .map(|(accel, message)| HotkeyErrorJson { accel, message })
                .collect(),
            tts_install: self
                .piper
                .progress()
                .map(|(id, progress)| TtsInstallJson { id, progress }),
            gate_threshold_live: live_gate_threshold(
                self.engine.params().gate_auto(),
                running,
                self.engine.params().gate_threshold_live(),
            ),
            mic_muted: self.mic_muted(),
            mic_open: self.mic_open(),
        })
    }

    /// Stop audio, release the instance lock and clear all hotkeys (the mute
    /// hotkey's hook is removed and its thread joined).
    pub fn shutdown(&mut self) {
        self.audio_wanted = false;
        self.stop_audio("shutdown");
        self.hotkeys.set(Vec::new());
        let _ = self.sound_mouse.set(&[]);
        self.plan = BindingPlan::default();
        self.mouse_errors.clear();
        self.mute_hook.set(None);
        self.ptt_hook.set(None);
    }

    // ---- internals ----

    /// Recompute `sources` (canonicalizing each folder) from the profile. A
    /// folder that can't be canonicalized is kept as unavailable (skipped for
    /// path containment) and logged once, not again while it stays so.
    fn refresh_sources(&mut self) {
        let mut fresh = Vec::new();
        for dir in sources(&self.profile) {
            let canon = match std::fs::canonicalize(&dir) {
                Ok(c) => Some(c),
                Err(e) => {
                    let known = self
                        .sources
                        .iter()
                        .any(|s| s.dir == dir && s.canon.is_none());
                    if !known {
                        elog!(
                            "[headless] soundboard folder unavailable (skipped): {}: {e}",
                            dir.display()
                        );
                    }
                    None
                }
            };
            fresh.push(Source { dir, canon });
        }
        self.sources = fresh;
    }

    /// Instance `id`'s length in 48 kHz frames (`Some(None)` if unknown), or
    /// `None` when it isn't in the soundboard's now-playing snapshot.
    fn playing_len(&self, id: u64) -> Option<Option<u64>> {
        if !self.engine.is_running() {
            return None;
        }
        let snapshot = self.engine.sb_playing();
        let guard = snapshot.lock().unwrap_or_else(|p| p.into_inner());
        guard.iter().find(|s| s.id == id).map(|s| s.len_frames)
    }

    /// Forget the live gains of instances that ended: the soundboard dropped
    /// its reference (finished, stopped, evicted, or audio stopped), so ours
    /// is the last. Exact, unlike the snapshot, which lags a fresh play.
    fn prune_live(&mut self) {
        self.live.retain(|_, (_, g)| Arc::strong_count(g) > 1);
        self.tts_live.retain(|_, g| Arc::strong_count(g) > 1);
    }

    /// Re-resolve every playing instance's gains under the current profile;
    /// the mixing thread picks them up on its next block.
    fn update_live_gains(&mut self) {
        self.prune_live();
        for (path, gains) in self.live.values() {
            let (others, me, hear_local) = resolve_clip_gains(&self.profile, path);
            gains.set(others, me, hear_local);
        }
        let (others, me, hear_local) = tts_gains(&self.profile);
        for gains in self.tts_live.values() {
            gains.set(others, me, hear_local);
        }
    }

    /// Start audio, recording any failure in `audio_error`.
    /// Logs `audio_start`, or `audio_error` when the failure is new (the
    /// 2 s retries of the same failure only go to stderr, as before).
    fn start_audio(&mut self) {
        self.last_audio_attempt = Instant::now();
        // A new chain starts closed in PTT mode, key held or not.
        self.reset_ptt();
        match self.try_start_audio() {
            Ok(()) => {
                let p = &self.profile;
                let mut detail = format!(
                    "input={} output={} monitor={}",
                    p.input_id.as_deref().unwrap_or("none"),
                    p.output_id.as_deref().unwrap_or("auto"),
                    p.sb_monitor_device.as_deref().unwrap_or("default"),
                );
                if self.audio_error.is_some() {
                    detail.push_str(" (recovered)");
                }
                elog::event("audio_start", &detail);
                self.audio_error = None;
            }
            Err(message) => {
                eprintln!("[headless] audio start failed: {message}");
                if self.audio_error.as_ref() != Some(&message) {
                    elog::event("audio_error", &format!("start failed: {message}"));
                }
                self.stop_audio("start failed");
                self.audio_error = Some(message);
            }
        }
    }

    /// Config checks come before the instance lock so a bad profile never
    /// touches the machine-wide mutex.
    fn try_start_audio(&mut self) -> Result<(), String> {
        let input = self
            .profile
            .input_id
            .clone()
            .ok_or_else(|| "No microphone selected".to_string())?;
        let output = match self.profile.output_id.clone() {
            Some(id) => id,
            None => enumerate_devices()
                .cable
                .map(|c| c.id)
                .ok_or_else(|| "VB-CABLE not found".to_string())?,
        };
        if self.lock.is_none() {
            let lock = InstanceLock::acquire().ok_or_else(|| LOCK_BUSY.to_string())?;
            self.lock = Some(lock);
        }
        self.engine
            .set_monitor_device(self.profile.sb_monitor_device.clone());
        self.engine.params().set_input_level(0.0);
        self.engine
            .start(input, output)
            .map_err(|e| format!("Audio start failed: {e:#}"))?;
        // The streams open their devices on their own threads: wait briefly
        // for them so a bad device is an error now, not a silent "running".
        // Neither started nor failed in time → treat as running; `tick()`
        // catches a later failure.
        if let Some(message) = core_failure_message(&self.wait_core_started(), true) {
            return Err(message);
        }
        self.attached.clear();
        self.sync_routed(true, true);
        self.last_routed_check = Instant::now();
        Ok(())
    }

    /// Poll the core streams until both started, one failed, or
    /// `CORE_START_WAIT` passed; returns the last status seen.
    fn wait_core_started(&self) -> CoreStatus {
        let deadline = Instant::now() + CORE_START_WAIT;
        loop {
            let status = self.engine.core_stream_status();
            if status != CoreStatus::Starting || Instant::now() >= deadline {
                return status;
            }
            std::thread::sleep(CORE_START_POLL);
        }
    }

    /// Stop the engine (joins its threads) and release the lock. Idempotent;
    /// logs `audio_stop <reason>` only when audio was actually running.
    fn stop_audio(&mut self, reason: &str) {
        if self.engine.is_running() {
            elog::event("audio_stop", reason);
        }
        self.engine.stop();
        self.engine.params().set_input_level(0.0);
        self.engine.params().set_ptt_open(false);
        self.attached.clear();
        self.live.clear();
        self.tts_live.clear();
        self.tts_wait.clear();
        self.lock = None;
    }

    /// Whether the engine's app channel `id` exists and is still capturing.
    fn channel_alive(&self, id: u64) -> bool {
        self.engine
            .app_channels()
            .iter()
            .any(|c| c.id == id && c.is_alive())
    }

    /// Detach apps whose capture thread died, so the next sync re-attaches them.
    fn drop_dead_apps(&mut self) {
        let dead: Vec<u64> = self
            .attached
            .values()
            .copied()
            .filter(|id| !self.channel_alive(*id))
            .collect();
        for id in dead {
            self.remove_attached(id, "capture stopped");
        }
    }

    /// Detach apps the profile no longer routes, attach (when `try_attach`)
    /// routed apps whose process exists, then apply every attached app's
    /// profile volume (the plugin encodes mute as volume 0). Only attaching
    /// takes a process snapshot.
    fn sync_routed(&mut self, try_attach: bool, log_skipped: bool) {
        let (to_attach, to_remove) = plan_routed(&self.attached, &self.profile.routed_apps);
        for id in to_remove {
            self.remove_attached(id, "no longer routed");
        }
        if try_attach && !to_attach.is_empty() {
            let apps: Vec<RoutedApp> = to_attach
                .iter()
                .filter_map(|n| {
                    self.profile
                        .routed_apps
                        .iter()
                        .find(|a| &a.name == n)
                        .cloned()
                })
                .collect();
            let (ok, skipped) = attach_routed_apps(&mut self.engine, &apps);
            for (name, id) in &ok {
                let pid = self
                    .engine
                    .app_channels()
                    .iter()
                    .find(|c| c.id == *id)
                    .map(|c| c.pid);
                match pid {
                    Some(pid) => elog::event("app_attach", &format!("{name} pid={pid}")),
                    None => elog::event("app_attach", name),
                }
            }
            self.attached.extend(ok);
            if log_skipped {
                for s in skipped {
                    elog!("[headless] routed app {s}");
                }
            }
        }
        for (name, id) in &self.attached {
            let volume = self
                .profile
                .routed_apps
                .iter()
                .find(|a| &a.name == name)
                .map(|a| a.volume);
            let channel = self.engine.app_channels().iter().find(|c| c.id == *id);
            if let (Some(v), Some(ch)) = (volume, channel) {
                store_f32(&ch.volume, v);
            }
        }
    }

    /// Detach attached apps whose captured process exited or was replaced
    /// (restarted under a new pid), so they re-attach to the current process.
    fn drop_exited_apps(&mut self) {
        let Ok(procs) = processes::list_processes() else {
            return;
        };
        if procs.is_empty() {
            return;
        }
        let attached: Vec<(String, u64, u32)> = self
            .attached
            .iter()
            .filter_map(|(name, id)| {
                let ch = self.engine.app_channels().iter().find(|c| c.id == *id)?;
                Some((name.clone(), *id, ch.pid))
            })
            .collect();
        for id in stale_app_channels(&attached, &procs) {
            self.remove_attached(id, "process exited or restarted");
        }
    }

    /// Detach app channel `id`, logging `app_detach <name> (<why>)`.
    fn remove_attached(&mut self, id: u64, why: &str) {
        if let Some(name) = self
            .attached
            .iter()
            .find(|(_, v)| **v == id)
            .map(|(n, _)| n.as_str())
        {
            elog::event("app_detach", &format!("{name} ({why})"));
        }
        self.engine.remove_app(id);
        self.attached.retain(|_, v| *v != id);
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        // Stop audio before the lock is released (and before the hotkey thread joins).
        self.stop_audio("engine exit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Profile, RoutedApp, SbClipSetting};
    use crate::headless::protocol::{AudioStatus, Event, MuteSource, StateEv};
    use crate::hotkey_thread::HotkeyThread;
    use crate::soundboard::decode::test_util::write_test_wav;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("o2i-ctl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn clip(name: &str, others: f32, me: f32, local: bool) -> SbClipSetting {
        SbClipSetting {
            name: name.into(),
            vol_others: others,
            vol_self: me,
            hear_local: local,
        }
    }

    fn single_error(evs: &[Event]) -> String {
        assert_eq!(evs.len(), 1, "expected exactly one event, got {evs:?}");
        match &evs[0] {
            Event::Error { message } => message.clone(),
            other => panic!("expected Event::Error, got {other:?}"),
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A temp source folder holding `files` (tiny valid WAVs).
    fn source_with(tag: &str, files: &[&str]) -> PathBuf {
        let d = temp_dir(tag);
        for f in files {
            write_test_wav(&d.join(f), 48_000, 2, 480);
        }
        d
    }

    // ---- sources ----

    #[test]
    fn sources_prefers_sb_folders_then_sb_folder() {
        let only_legacy = Profile {
            sb_folder: Some(r"C:\old".into()),
            ..Default::default()
        };
        assert_eq!(sources(&only_legacy), vec![PathBuf::from(r"C:\old")]);

        let both = Profile {
            sb_folder: Some(r"C:\old".into()),
            sb_folders: vec![r"C:\a".into(), r"D:\b".into()],
            ..Default::default()
        };
        assert_eq!(
            sources(&both),
            vec![PathBuf::from(r"C:\a"), PathBuf::from(r"D:\b")]
        );

        // Empty entries are ignored; all-empty falls back to sb_folder.
        let blank = Profile {
            sb_folder: Some(r"C:\old".into()),
            sb_folders: vec!["".into(), "  ".into()],
            ..Default::default()
        };
        assert_eq!(sources(&blank), vec![PathBuf::from(r"C:\old")]);

        // The same folder listed twice (any case / slash style) counts once.
        let dup = Profile {
            sb_folders: vec![r"C:\a".into(), "c:/A/".into(), r"D:\b".into()],
            ..Default::default()
        };
        assert_eq!(
            sources(&dup),
            vec![PathBuf::from(r"C:\a"), PathBuf::from(r"D:\b")]
        );

        assert!(sources(&Profile::default()).is_empty());
        let empty_legacy = Profile {
            sb_folder: Some(String::new()),
            ..Default::default()
        };
        assert!(sources(&empty_legacy).is_empty());
    }

    // ---- resolve_sound ----

    #[test]
    fn resolve_sound_path_inside_source_ok() {
        let a = source_with("rs-in-a", &["x.wav"]);
        let b = source_with("rs-in-b", &["y.wav"]);
        let p = Profile {
            sb_folders: vec![s(&a), s(&b)],
            ..Default::default()
        };
        // Any source, not just the first.
        assert_eq!(
            resolve_sound(&p, None, Some(&s(&b.join("y.wav")))),
            Ok(b.join("y.wav"))
        );
        assert_eq!(
            resolve_sound(&p, None, Some(&s(&a.join("x.wav")))),
            Ok(a.join("x.wav"))
        );
        // Other spellings of the same file resolve to the source's own form.
        let odd = s(&b.join("Y.WAV")).to_uppercase().replace('\\', "/");
        assert_eq!(resolve_sound(&p, None, Some(&odd)), Ok(b.join("y.wav")));
        let dotted = s(&a.join("..").join(a.file_name().unwrap()).join("x.wav"));
        assert_eq!(resolve_sound(&p, None, Some(&dotted)), Ok(a.join("x.wav")));
        // A path wins over a file name.
        assert_eq!(
            resolve_sound(&p, Some("x.wav"), Some(&s(&b.join("y.wav")))),
            Ok(b.join("y.wav"))
        );
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn resolve_sound_path_outside_rejected() {
        let root = temp_dir("rs-out");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        write_test_wav(&src.join("in.wav"), 48_000, 2, 480);
        write_test_wav(&root.join("out.wav"), 48_000, 2, 480);
        let sib = root.join("src2");
        std::fs::create_dir_all(&sib).unwrap();
        write_test_wav(&sib.join("in.wav"), 48_000, 2, 480);
        let p = Profile {
            sb_folders: vec![s(&src)],
            ..Default::default()
        };
        const OUTSIDE: &str = "Sound is not in a soundboard folder";
        for bad in [
            s(&root.join("out.wav")),                 // parent of the source
            s(&src.join("..").join("out.wav")),       // `..` escape
            s(&sib.join("in.wav")),                   // sibling sharing a name prefix
            r"Z:\definitely\not\here\a.wav".into(),   // another drive
            r"\\localhost\C$\Windows\win.ini".into(), // UNC
            r"\\?\Z:\nope\a.wav".into(),              // verbatim prefix
            "in.wav".into(),                          // not absolute
            s(&src.join("in.wav")).replace(r"\src\", r"\src\..\src2\"), // escape mid-path
        ] {
            assert_eq!(
                resolve_sound(&p, None, Some(&bad)),
                Err(OUTSIDE.to_string()),
                "{bad}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_sound_legacy_file_uses_first_source() {
        let a = source_with("rs-legacy-a", &["both.wav", "only-a.wav"]);
        let b = source_with("rs-legacy-b", &["both.wav", "only-b.wav"]);
        let p = Profile {
            sb_folders: vec![s(&a), s(&b)],
            ..Default::default()
        };
        assert_eq!(
            resolve_sound(&p, Some("both.wav"), None),
            Ok(a.join("both.wav"))
        );
        assert_eq!(
            resolve_sound(&p, Some("only-a.wav"), None),
            Ok(a.join("only-a.wav"))
        );
        // Only the first source: a file in the second isn't found by name.
        assert_eq!(
            resolve_sound(&p, Some("only-b.wav"), None),
            Err("Clip not found: only-b.wav".to_string())
        );
        // Falls back to sb_folder when sb_folders is empty.
        let legacy = Profile {
            sb_folder: Some(s(&b)),
            ..Default::default()
        };
        assert_eq!(
            resolve_sound(&legacy, Some("only-b.wav"), None),
            Ok(b.join("only-b.wav"))
        );
        // Names only: no directories / traversal.
        for bad in [
            "../only-a.wav",
            r"..\only-a.wav",
            r"sub\x.wav",
            "C:only-a.wav",
            "",
        ] {
            assert_eq!(
                resolve_sound(&p, Some(bad), None),
                Err(format!("Clip not found: {bad}")),
                "{bad}"
            );
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn resolve_sound_missing_file_errors() {
        let a = source_with("rs-missing", &["x.wav"]);
        std::fs::create_dir_all(a.join("sub")).unwrap();
        let p = Profile {
            sb_folders: vec![s(&a)],
            ..Default::default()
        };
        let gone = s(&a.join("gone.wav"));
        assert_eq!(
            resolve_sound(&p, None, Some(&gone)),
            Err(format!("Clip not found: {gone}"))
        );
        assert_eq!(
            resolve_sound(&p, Some("gone.wav"), None),
            Err("Clip not found: gone.wav".to_string())
        );
        // A directory inside the source isn't a sound.
        let dir = s(&a.join("sub"));
        assert_eq!(
            resolve_sound(&p, None, Some(&dir)),
            Err(format!("Clip not found: {dir}"))
        );
        // No sources at all.
        const NO_FOLDER: &str = "No clip folder set";
        let none = Profile::default();
        assert_eq!(
            resolve_sound(&none, Some("x.wav"), None),
            Err(NO_FOLDER.to_string())
        );
        assert_eq!(
            resolve_sound(&none, None, Some(&s(&a.join("x.wav")))),
            Err(NO_FOLDER.to_string())
        );
        assert_eq!(resolve_sound(&p, None, None), Err(NO_FOLDER.to_string()));
        let _ = std::fs::remove_dir_all(&a);
    }

    // ---- containment math (pure, on canonical strings) ----

    fn rel(src: &str, target: &str) -> Option<PathBuf> {
        rel_below(Path::new(src), Path::new(target))
    }

    #[test]
    fn rel_below_compares_whole_components_case_insensitively() {
        let unc = r"\\?\UNC\srv\share\snd";
        assert_eq!(
            rel(unc, r"\\?\UNC\srv\share\snd\x.wav"),
            Some(PathBuf::from("x.wav"))
        );
        assert_eq!(
            rel(unc, r"\\?\UNC\srv\share\snd\sub\y.wav"),
            Some(PathBuf::from(r"sub\y.wav"))
        );
        // Case-insensitive, and the target's own spelling is kept below.
        assert_eq!(
            rel(unc, r"\\?\UNC\SRV\Share\SND\X.Wav"),
            Some(PathBuf::from("X.Wav"))
        );
        assert_eq!(rel(unc, unc), Some(PathBuf::new()));
        for outside in [
            r"\\?\UNC\srv\share\snd2\x.wav", // sibling sharing the name prefix
            r"\\?\UNC\srv\share\x.wav",      // parent
            r"\\?\UNC\srv\other\snd\x.wav",  // other share
            r"\\?\UNC\srv2\share\snd\x.wav", // other server
            r"\\?\C:\snd\x.wav",             // a local drive
        ] {
            assert_eq!(rel(unc, outside), None, "{outside}");
        }
        let local = r"\\?\C:\Users\me\snd";
        assert_eq!(
            rel(local, r"\\?\c:\users\ME\snd\a.wav"),
            Some(PathBuf::from("a.wav"))
        );
        assert_eq!(
            rel(local, r"\\?\C:\Users\me\snd\d\e\f.wav"),
            Some(PathBuf::from(r"d\e\f.wav"))
        );
        assert_eq!(rel(local, r"\\?\D:\Users\me\snd\a.wav"), None);
        assert_eq!(rel(local, r"\\?\C:\Users\me\snd-old\a.wav"), None);
        assert_eq!(rel(local, r"\\?\UNC\C\Users\me\snd\a.wav"), None);
        // A drive root as the source.
        assert_eq!(
            rel(r"\\?\C:\", r"\\?\C:\a.wav"),
            Some(PathBuf::from("a.wav"))
        );
    }

    fn src(dir: &str, canon: Option<&str>) -> Source {
        Source {
            dir: PathBuf::from(dir),
            canon: canon.map(PathBuf::from),
        }
    }

    #[test]
    fn locate_canon_picks_most_specific_available_source() {
        let srcs = [
            src(r"Z:\snd", Some(r"\\?\UNC\nas\share\snd")), // mapped drive
            src(r"Z:\snd\loud", Some(r"\\?\UNC\nas\share\snd\loud")),
            src(r"Y:\gone", None), // unavailable: skipped
            src(r"C:\Local", Some(r"\\?\C:\Local")),
        ];
        let at = |t: &str| locate_canon(&srcs, Path::new(t)).map(|(s, r)| (s.dir.clone(), r));
        assert_eq!(
            at(r"\\?\UNC\nas\share\snd\a.wav"),
            Some((PathBuf::from(r"Z:\snd"), PathBuf::from("a.wav")))
        );
        assert_eq!(
            at(r"\\?\UNC\NAS\share\snd\LOUD\b.wav"),
            Some((PathBuf::from(r"Z:\snd\loud"), PathBuf::from("b.wav")))
        );
        assert_eq!(
            at(r"\\?\c:\local\x\c.wav"),
            Some((PathBuf::from(r"C:\Local"), PathBuf::from(r"x\c.wav")))
        );
        assert_eq!(at(r"\\?\UNC\nas\share\other\a.wav"), None);
        assert_eq!(at(r"\\?\Y:\gone\a.wav"), None);
    }

    #[test]
    fn resolve_sound_legacy_file_falls_back_when_source_uncanonicalizable() {
        let a = source_with("rs-fallback", &["x.wav"]);
        // The first source's canonical form is unknown (e.g. unavailable at
        // configure time): a bare name still plays from it, as before E1.
        let srcs = [Source {
            dir: a.clone(),
            canon: None,
        }];
        assert_eq!(
            resolve_sound_in(&srcs, Some("x.wav"), None),
            Ok(a.join("x.wav"))
        );
        assert_eq!(
            resolve_sound_in(&srcs, Some("../x.wav"), None),
            Err("Clip not found: ../x.wav".to_string())
        );
        assert_eq!(
            resolve_sound_in(&srcs, Some("nope.wav"), None),
            Err("Clip not found: nope.wav".to_string())
        );
        let _ = std::fs::remove_dir_all(&a);
    }

    #[test]
    fn controller_caches_canonical_sources_until_sources_change() {
        let root = temp_dir("cache");
        let later = root.join("later");
        let other = source_with("cache-other", &["o.wav"]);
        let mut c = Controller::new(HotkeyThread::spawn());
        let prof = Profile {
            sb_folders: vec![s(&later)],
            ..Default::default()
        };
        // Missing at configure time: cached as unavailable.
        c.configure(prof.clone());
        assert_eq!(c.sources.len(), 1);
        assert!(c.sources[0].canon.is_none());

        // Appears afterwards: plays by path don't re-canonicalize sources.
        std::fs::create_dir_all(&later).unwrap();
        write_test_wav(&later.join("a.wav"), 48_000, 2, 480);
        let a = s(&later.join("a.wav"));
        assert_eq!(
            single_error(&c.play_clip(None, Some(&a))),
            "Sound is not in a soundboard folder"
        );
        // A legacy name falls back to the plain folder join.
        assert_eq!(
            single_error(&c.play_clip(Some("a.wav"), None)),
            "Audio is off"
        );
        // Re-sending the same sources (slider drags) keeps the cache.
        c.configure(Profile {
            master_volume: Some(0.5),
            ..prof.clone()
        });
        assert!(c.sources[0].canon.is_none());

        // Listing clips refreshes it.
        c.list_clips();
        assert!(c.sources[0].canon.is_some());
        assert_eq!(single_error(&c.play_clip(None, Some(&a))), "Audio is off");

        // Changing the sources recomputes it.
        c.configure(Profile {
            sb_folders: vec![s(&later), s(&other)],
            ..Default::default()
        });
        assert_eq!(c.sources.len(), 2);
        assert!(c.sources.iter().all(|x| x.canon.is_some()));
        assert_eq!(
            single_error(&c.play_clip(None, Some(&s(&other.join("o.wav"))))),
            "Audio is off"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// A real UNC source through the local admin share (skipped when this
    /// machine doesn't expose `\\localhost\C$`).
    #[test]
    fn resolve_sound_unc_source() {
        let dir = r"\\localhost\C$\Windows";
        let ini = r"\\localhost\C$\Windows\win.ini";
        if std::fs::canonicalize(ini).is_err() {
            eprintln!("skipped: {ini} not reachable");
            return;
        }
        let p = Profile {
            sb_folders: vec![dir.into()],
            ..Default::default()
        };
        assert_eq!(resolve_sound(&p, None, Some(ini)), Ok(PathBuf::from(ini)));
        assert_eq!(
            resolve_sound(&p, None, Some(r"\\LOCALHOST\c$\windows\WIN.INI")),
            Ok(PathBuf::from(ini))
        );
        // Legacy file name and hotkeys in a UNC first source (worked before E1).
        assert_eq!(
            resolve_sound(&p, Some("win.ini"), None),
            Ok(PathBuf::from(ini))
        );
        // Deeper paths keep every component.
        let hosts = r"\\localhost\C$\Windows\System32\drivers\etc\hosts";
        let got = resolve_sound(&p, None, Some(hosts)).expect("nested UNC path");
        assert_eq!(path_key(&s(&got)), path_key(hosts));
        // A sibling sharing the name prefix stays outside.
        let sibling = r"\\localhost\C$\Windows.o2i-test-nope\a.wav";
        assert_eq!(
            resolve_sound(&p, None, Some(sibling)),
            Err("Sound is not in a soundboard folder".to_string())
        );
    }

    // ---- resolve_clip_gains ----

    #[test]
    fn clip_gains_by_path_and_legacy_name() {
        let p = Profile {
            sb_folders: vec![r"C:\first".into(), r"D:\second".into()],
            sb_clip_settings: vec![
                clip("a.mp3", 0.1, 0.2, true),
                clip(r"D:\second\b.mp3", 0.3, 0.4, false),
                clip(r"C:\first\c.mp3", 0.5, 0.6, true),
                clip("c.mp3", 9.0, 9.0, false),
                clip("b.mp3", 7.0, 7.0, true),
            ],
            ..Default::default()
        };
        // Path keys, matched regardless of case / slash style.
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"D:\second\b.mp3")),
            (0.3, 0.4, false)
        );
        assert_eq!(
            resolve_clip_gains(&p, Path::new("d:/Second/B.mp3")),
            (0.3, 0.4, false)
        );
        // A path key beats a legacy name for the same sound.
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"C:\first\c.mp3")),
            (0.5, 0.6, true)
        );
        // Legacy name: only for sounds in the first source.
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"C:\first\a.mp3")),
            (0.1, 0.2, true)
        );
        assert_eq!(
            resolve_clip_gains(&p, Path::new("c:/FIRST/A.MP3")),
            (0.1, 0.2, true)
        );
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"D:\second\a.mp3")),
            (1.0, 1.0, false)
        );
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"C:\first\sub\a.mp3")),
            (1.0, 1.0, false)
        );
        // Nothing matches: unity, no local monitoring.
        assert_eq!(
            resolve_clip_gains(&p, Path::new(r"C:\first\z.mp3")),
            (1.0, 1.0, false)
        );

        // Global override wins over everything.
        let g = Profile {
            sb_global_override: true,
            sb_global_others: Some(0.4),
            sb_global_self: None,
            sb_global_hear_local: true,
            ..p.clone()
        };
        assert_eq!(
            resolve_clip_gains(&g, Path::new(r"D:\second\b.mp3")),
            (0.4, 1.0, true)
        );
        let g2 = Profile {
            sb_global_others: None,
            ..g
        };
        assert_eq!(
            resolve_clip_gains(&g2, Path::new(r"C:\first\a.mp3")),
            (1.0, 1.0, true)
        );

        // Legacy sb_folder is the first source when sb_folders is empty.
        let legacy = Profile {
            sb_folder: Some("C:/first/".into()),
            sb_clip_settings: vec![clip("a.mp3", 0.5, 1.5, true)],
            ..Default::default()
        };
        assert_eq!(
            resolve_clip_gains(&legacy, Path::new(r"C:\first\a.mp3")),
            (0.5, 1.5, true)
        );
    }

    // ---- needs_audio_restart ----

    #[test]
    fn restart_when_input_changes() {
        let old = Profile {
            input_id: Some("mic1".into()),
            ..Default::default()
        };
        let new = Profile {
            input_id: Some("mic2".into()),
            ..old.clone()
        };
        assert!(needs_audio_restart(&old, &new));
    }

    #[test]
    fn restart_when_monitor_device_changes() {
        let old = Profile::default();
        let new = Profile {
            sb_monitor_device: Some("hp".into()),
            ..Default::default()
        };
        assert!(needs_audio_restart(&old, &new));
    }

    #[test]
    fn no_restart_for_dsp_or_routed_changes() {
        let old = Profile {
            input_id: Some("m".into()),
            output_id: Some("o".into()),
            ..Default::default()
        };
        let new = Profile {
            gate_threshold: Some(0.3),
            routed_apps: vec![RoutedApp {
                name: "Spotify.exe".into(),
                volume: 0.5,
            }],
            ..old.clone()
        };
        assert!(!needs_audio_restart(&old, &new));
    }

    // ---- plan_routed ----

    fn ra(name: &str) -> RoutedApp {
        RoutedApp {
            name: name.into(),
            volume: 1.0,
        }
    }

    #[test]
    fn plan_routed_attaches_new_and_removes_stale() {
        let attached: HashMap<String, u64> = [("A".to_string(), 1), ("B".to_string(), 2)].into();
        let (attach, remove) = plan_routed(&attached, &[ra("B"), ra("C")]);
        assert_eq!(attach, vec!["C".to_string()]);
        assert_eq!(remove, vec![1]);
    }

    #[test]
    fn plan_routed_empty_desired_removes_all() {
        let attached: HashMap<String, u64> = [("A".to_string(), 1), ("B".to_string(), 2)].into();
        let (attach, mut remove) = plan_routed(&attached, &[]);
        remove.sort();
        assert!(attach.is_empty());
        assert_eq!(remove, vec![1, 2]);
    }

    #[test]
    fn plan_routed_matching_yields_nothing() {
        let attached: HashMap<String, u64> = [("A".to_string(), 1)].into();
        let (attach, remove) = plan_routed(&attached, &[ra("A")]);
        assert!(attach.is_empty());
        assert!(remove.is_empty());
    }

    // ---- routed_names_changed (configure only snapshots processes then) ----

    #[test]
    fn routed_names_changed_ignores_volumes_and_order() {
        let mut quiet = ra("A");
        quiet.volume = 0.2;
        // A volume drag (or a reorder) isn't a change of the routed apps.
        assert!(!routed_names_changed(
            &[ra("A"), ra("B")],
            &[quiet, ra("B")]
        ));
        assert!(!routed_names_changed(
            &[ra("A"), ra("B")],
            &[ra("B"), ra("A")]
        ));
        assert!(!routed_names_changed(&[], &[]));
        // Added, removed or swapped names are.
        assert!(routed_names_changed(&[ra("A")], &[ra("A"), ra("B")]));
        assert!(routed_names_changed(&[ra("A"), ra("B")], &[ra("A")]));
        assert!(routed_names_changed(&[ra("A")], &[ra("B")]));
        assert!(routed_names_changed(&[], &[ra("A")]));
    }

    // ---- stale_app_channels ----

    fn proc_info(pid: u32, parent_pid: u32, name: &str) -> processes::ProcInfo {
        processes::ProcInfo {
            pid,
            parent_pid,
            name: name.into(),
        }
    }

    #[test]
    fn stale_app_channels_flags_gone_or_replaced_processes() {
        let procs = vec![
            proc_info(10, 1, "Spotify.exe"),
            proc_info(11, 10, "Spotify.exe"),
            proc_info(20, 1, "Discord.exe"),
        ];
        let attached = vec![
            ("Spotify.exe".to_string(), 1, 10), // still the tree root
            ("Discord.exe".to_string(), 2, 99), // restarted: new pid 20
            ("Chrome.exe".to_string(), 3, 30),  // exited
            ("Spotify.exe".to_string(), 4, 11), // a child, not the root
        ];
        assert_eq!(stale_app_channels(&attached, &procs), vec![2, 3, 4]);
    }

    #[test]
    fn stale_app_channels_none_when_all_current() {
        let procs = vec![proc_info(10, 1, "Spotify.exe")];
        let attached = vec![("Spotify.exe".to_string(), 1, 10)];
        assert!(stale_app_channels(&attached, &procs).is_empty());
    }

    // ---- core stream health -> audio state ----

    fn mic_failed(reason: &str) -> CoreStatus {
        CoreStatus::Failed {
            stream: CoreStream::Mic,
            reason: reason.into(),
        }
    }

    fn output_failed(reason: &str) -> CoreStatus {
        CoreStatus::Failed {
            stream: CoreStream::Output,
            reason: reason.into(),
        }
    }

    #[test]
    fn core_failure_message_at_start() {
        assert_eq!(
            core_failure_message(&mic_failed("GetDevice(capture): not found"), true).as_deref(),
            Some("Microphone failed: GetDevice(capture): not found")
        );
        assert_eq!(
            core_failure_message(&output_failed("exclusive mode"), true).as_deref(),
            Some("VB-CABLE output failed: exclusive mode")
        );
    }

    #[test]
    fn core_failure_message_while_running() {
        assert_eq!(
            core_failure_message(&mic_failed("device invalidated"), false).as_deref(),
            Some("Microphone stopped: device invalidated")
        );
        assert_eq!(
            core_failure_message(&output_failed("device invalidated"), false).as_deref(),
            Some("VB-CABLE output stopped: device invalidated")
        );
    }

    #[test]
    fn core_failure_message_none_unless_failed() {
        for s in [CoreStatus::Off, CoreStatus::Starting, CoreStatus::Running] {
            assert_eq!(core_failure_message(&s, true), None, "{s:?}");
            assert_eq!(core_failure_message(&s, false), None, "{s:?}");
        }
    }

    fn state_of(c: &Controller) -> StateEv {
        match c.state() {
            Event::State(s) => s,
            other => panic!("expected state, got {other:?}"),
        }
    }

    #[test]
    fn controller_core_failure_while_running_reports_error() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.audio_wanted = true;
        c.engine.params().set_input_level(0.7);
        c.apply_core_status(mic_failed("device invalidated"));
        let s = state_of(&c);
        assert_eq!(s.audio, AudioStatus::Error);
        assert_eq!(
            s.error.as_deref(),
            Some("Microphone stopped: device invalidated")
        );
        assert_eq!(s.input_level, 0.0);
        assert_eq!(c.engine.params().input_level(), 0.0);

        c.apply_core_status(output_failed("gone"));
        assert_eq!(
            state_of(&c).error.as_deref(),
            Some("VB-CABLE output stopped: gone")
        );
    }

    #[test]
    fn state_includes_gate_threshold_live_only_when_auto() {
        // Present exactly while gate_auto is on and audio runs (and finite).
        assert_eq!(live_gate_threshold(true, true, 0.03), Some(0.03));
        // Not known yet (0) or bogus: null, never 0 (which reads as -inf dBFS).
        assert_eq!(live_gate_threshold(true, true, 0.0), None);
        assert_eq!(live_gate_threshold(true, true, -1.0), None);
        assert_eq!(live_gate_threshold(false, true, 0.03), None);
        assert_eq!(live_gate_threshold(true, false, 0.03), None);
        assert_eq!(live_gate_threshold(false, false, 0.03), None);
        assert_eq!(live_gate_threshold(true, true, f32::NAN), None);

        // Through the controller: audio off -> null even with gate_auto on.
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            gate_auto: true,
            ..Default::default()
        });
        assert!(c.engine.params().gate_auto());
        c.engine.params().set_gate_threshold_live(0.03);
        assert_eq!(state_of(&c).gate_threshold_live, None);
        c.configure(Profile::default());
        assert!(!c.engine.params().gate_auto());
        assert_eq!(state_of(&c).gate_threshold_live, None);
    }

    // ---- mic mute ----

    #[test]
    fn configure_keeps_mute() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert!(!state_of(&c).mic_muted, "a fresh engine starts unmuted");
        c.set_mic_muted(true, MuteSource::Command);
        assert!(state_of(&c).mic_muted);

        // Mute is not a profile field: no configure changes it, even one
        // that changes the mic DSP and volume or carries a stray
        // `mic_muted` key.
        c.configure(Profile {
            gate_enabled: true,
            mic_volume: Some(0.5),
            ..Default::default()
        });
        assert!(state_of(&c).mic_muted);
        match crate::headless::protocol::parse_command(
            r#"{"cmd":"configure","profile":{"mic_muted":false}}"#,
        )
        .unwrap()
        {
            crate::headless::protocol::Command::Configure { profile } => {
                c.configure(profile);
            }
            other => panic!("wrong variant {other:?}"),
        }
        assert!(state_of(&c).mic_muted);
        assert!(c.engine.params().mic_muted(), "the chain still mutes");
    }

    #[test]
    fn mute_event_emitted_once_per_change() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        let mute_events = |evs: &[Event]| -> Vec<(bool, MuteSource)> {
            evs.iter()
                .map(|e| match e {
                    Event::MicMuted { muted, source } => (*muted, *source),
                    other => panic!("expected mic_muted, got {other:?}"),
                })
                .collect()
        };
        // Already unmuted: nothing changes, nothing is emitted.
        assert!(c.set_mic_muted(false, MuteSource::Command).is_empty());
        assert_eq!(
            mute_events(&c.set_mic_muted(true, MuteSource::Command)),
            vec![(true, MuteSource::Command)]
        );
        assert!(c.set_mic_muted(true, MuteSource::Command).is_empty());
        assert!(c.set_mic_muted(true, MuteSource::Hotkey).is_empty());
        assert_eq!(
            mute_events(&c.set_mic_muted(false, MuteSource::Hotkey)),
            vec![(false, MuteSource::Hotkey)]
        );
        assert!(c.set_mic_muted(false, MuteSource::Hotkey).is_empty());
        assert!(!state_of(&c).mic_muted);
    }

    // ---- soundboard hotkeys on mouse buttons (hooks never installed in tests) ----

    const MOUSE_CLIP: &str = r"C:\o2i-test-nowhere\a.mp3";

    fn sound_profile(hotkeys: &[(&str, &str)], mute: Option<&str>, ptt: Option<&str>) -> Profile {
        Profile {
            sb_clip_hotkeys: hotkeys
                .iter()
                .map(|(k, a)| (k.to_string(), a.to_string()))
                .collect(),
            mic_mute_hotkey: mute.map(str::to_string),
            ptt_key: ptt.map(str::to_string),
            ..Default::default()
        }
    }

    /// Errors in `evs` (a press of an unplayable clip reports one: audio is
    /// off in tests, which also proves the press reached `play_clip`).
    fn error_count(evs: &[Event]) -> usize {
        evs.iter()
            .filter(|e| matches!(e, Event::Error { .. }))
            .count()
    }

    fn mouse_trigger(b: crate::llhooks::MouseButton) -> crate::llhooks::Trigger {
        crate::llhooks::Trigger::Mouse(b)
    }

    fn x1() -> crate::llhooks::Trigger {
        mouse_trigger(crate::llhooks::MouseButton::X1)
    }

    #[test]
    fn sound_hotkey_mouse4_plays_clip() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(sound_profile(&[(MOUSE_CLIP, "Mouse4")], None, None));
        assert!(evs.is_empty(), "{evs:?}");
        assert!(c.sound_mouse.running(), "the mouse hook serves it");
        assert!(state_of(&c).hotkey_errors.is_empty());

        // Another button does nothing; a button-up does nothing.
        c.sound_mouse
            .simulate_event(mouse_trigger(crate::llhooks::MouseButton::X2), true, 0);
        c.sound_mouse.simulate_event(x1(), false, 0);
        assert_eq!(error_count(&c.tick()), 0);

        // Each press plays once (here: tries to, and audio is off).
        c.sound_mouse.simulate_event(x1(), true, 0);
        assert_eq!(error_count(&c.tick()), 1);
        c.sound_mouse.simulate_event(x1(), true, 0);
        c.sound_mouse.simulate_event(x1(), true, 0);
        assert_eq!(error_count(&c.tick()), 2);
        assert_eq!(error_count(&c.tick()), 0, "presses are taken once");

        // Clearing the hotkey removes the hook.
        c.configure(Profile::default());
        assert!(!c.sound_mouse.running());
        c.shutdown();
    }

    #[test]
    fn sound_hotkey_mouse_with_modifier() {
        use crate::llhooks::{MouseButton, MOD_ALT, MOD_CTRL, MOD_SHIFT};
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(sound_profile(
            &[(MOUSE_CLIP, "Ctrl+Mouse4"), ("b.mp3", "Mouse3")],
            None,
            None,
        ));
        assert!(c.sound_mouse.running());
        let fired = |c: &mut Controller, t, mods| {
            c.sound_mouse.simulate_event(t, true, mods);
            error_count(&c.tick())
        };
        // A combo needs exactly its modifiers.
        assert_eq!(fired(&mut c, x1(), 0), 0);
        assert_eq!(fired(&mut c, x1(), MOD_CTRL | MOD_SHIFT), 0);
        assert_eq!(fired(&mut c, x1(), MOD_ALT), 0);
        assert_eq!(fired(&mut c, x1(), MOD_CTRL), 1);
        // A bare binding fires whatever is held.
        let mid = mouse_trigger(MouseButton::Middle);
        assert_eq!(fired(&mut c, mid, 0), 1);
        assert_eq!(fired(&mut c, mid, MOD_CTRL | MOD_ALT), 1);
        c.shutdown();
    }

    #[test]
    fn sound_hotkey_mouse_conflicts_with_mute_is_error() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Mouse4")],
            Some("Mouse4"),
            None,
        ));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "Mouse4", "the sound hotkey is reported");
                assert!(message.contains("mute"), "{message}");
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert!(
            !c.sound_mouse.running(),
            "the sound hotkey is not registered"
        );
        assert_eq!(c.mute_hook.running(), Some("mouse"), "mute keeps working");
        assert_eq!(state_of(&c).hotkey_errors.len(), 1);

        // A bare key overlaps any combo on the same button, either way round.
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Ctrl+Mouse4")],
            Some("Mouse4"),
            None,
        ));
        assert!(
            matches!(evs.as_slice(), [Event::HotkeyError { accel, .. }] if accel == "Ctrl+Mouse4")
        );
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Mouse4")],
            Some("Ctrl+Mouse4"),
            None,
        ));
        assert!(matches!(evs.as_slice(), [Event::HotkeyError { accel, .. }] if accel == "Mouse4"));
        assert!(!c.sound_mouse.running());

        // The PTT key counts too.
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Mouse5")],
            None,
            Some("mouse5"),
        ));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "Mouse5");
                assert!(message.contains("push-to-talk"), "{message}");
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert_eq!(c.ptt_hook.running(), Some("mouse"), "PTT keeps working");

        // Different modifiers do not overlap; changing the mute key frees it.
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Shift+Mouse4")],
            Some("Ctrl+Mouse4"),
            None,
        ));
        assert!(evs.is_empty(), "{evs:?}");
        assert!(c.sound_mouse.running());
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Mouse4")],
            Some("Mouse4"),
            None,
        ));
        assert_eq!(evs.len(), 1);
        assert!(!c.sound_mouse.running());
        let evs = c.configure(sound_profile(
            &[(MOUSE_CLIP, "Mouse4")],
            Some("Mouse5"),
            None,
        ));
        assert!(evs.is_empty(), "{evs:?}");
        assert!(c.sound_mouse.running());
        assert!(state_of(&c).hotkey_errors.is_empty());
        c.shutdown();
    }

    #[test]
    fn keyboard_sound_hotkeys_unchanged() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let p = sound_profile(
            &[(MOUSE_CLIP, "F23"), ("b.mp3", "Ctrl+Alt+Shift+F22")],
            None,
            None,
        );
        let evs = c.configure(p.clone());
        assert!(evs.is_empty(), "{evs:?}");
        assert!(
            !c.sound_mouse.running(),
            "no mouse hook for keyboard hotkeys"
        );
        assert_eq!(c.plan.keyboard, bindings_from_profile(&p));
        assert!(c.plan.mouse.is_empty());

        // An unknown name still goes down the keyboard path and its error.
        let evs = c.configure(sound_profile(&[(MOUSE_CLIP, "Mouse9")], None, None));
        assert!(
            evs.is_empty(),
            "the hotkey thread reports it later: {evs:?}"
        );
        assert!(!c.sound_mouse.running());
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut errs = state_of(&c).hotkey_errors;
        while errs.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
            errs = state_of(&c).hotkey_errors;
        }
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert_eq!(errs[0].accel, "Mouse9");
        assert!(errs[0].message.contains("invalid accelerator"));
        c.shutdown();
    }

    #[test]
    fn mouse_sound_hotkeys_duplicates_and_limit() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(sound_profile(
            &[
                ("a.mp3", "Mouse4"),
                ("b.mp3", "Mouse4"),
                ("c.mp3", "mouse5"),
            ],
            None,
            None,
        ));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "Mouse4");
                assert!(message.contains("already bound"), "{message}");
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert_eq!(c.plan.mouse.len(), 2, "the first one stays registered");
        assert_eq!(c.plan.mouse[0].action, HotkeyAction::Clip("a.mp3".into()));

        // 16 fit; more are refused. 3 buttons x 8 modifier sets = 24 distinct.
        let mut specs = Vec::new();
        for m in [
            "",
            "Ctrl+",
            "Alt+",
            "Shift+",
            "Ctrl+Alt+",
            "Ctrl+Shift+",
            "Alt+Shift+",
            "Win+",
        ] {
            for b in ["Mouse3", "Mouse4", "Mouse5"] {
                specs.push(format!("{m}{b}"));
            }
        }
        let hotkeys: Vec<(&str, &str)> = specs.iter().map(|s| ("a.mp3", s.as_str())).collect();
        let evs = c.configure(sound_profile(&hotkeys, None, None));
        assert_eq!(c.plan.mouse.len(), 16);
        assert_eq!(evs.len(), 24 - 16);
        assert!(
            matches!(&evs[0], Event::HotkeyError { message, .. } if message == "Too many mouse hotkeys")
        );
        c.shutdown();
    }

    // ---- mute hotkey (tests never install real hooks: see `MuteHook::new`) ----

    /// The `mic_muted` events in `evs`, in order (other events are skipped).
    fn mic_muted_events(evs: &[Event]) -> Vec<(bool, MuteSource)> {
        evs.iter()
            .filter_map(|e| match e {
                Event::MicMuted { muted, source } => Some((*muted, *source)),
                _ => None,
            })
            .collect()
    }

    fn with_mute_hotkey(spec: Option<&str>) -> Profile {
        Profile {
            mic_mute_hotkey: spec.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn mute_hotkey_press_toggles_mute_from_tick() {
        use MuteSource::Hotkey;
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(with_mute_hotkey(Some("Mouse4")));
        assert!(evs.is_empty(), "{evs:?}");
        assert_eq!(c.mute_hook.running(), Some("mouse"));
        assert!(mic_muted_events(&c.tick()).is_empty(), "no press");

        c.mute_hook.simulate_press();
        assert_eq!(mic_muted_events(&c.tick()), vec![(true, Hotkey)]);
        assert!(state_of(&c).mic_muted);
        assert!(c.engine.params().mic_muted(), "the chain mutes");
        assert!(mic_muted_events(&c.tick()).is_empty(), "one toggle");

        c.mute_hook.simulate_press();
        assert_eq!(mic_muted_events(&c.tick()), vec![(false, Hotkey)]);
        assert!(!state_of(&c).mic_muted);

        // Two presses before one tick: two toggles, two events.
        c.mute_hook.simulate_press();
        c.mute_hook.simulate_press();
        assert_eq!(
            mic_muted_events(&c.tick()),
            vec![(true, Hotkey), (false, Hotkey)]
        );

        // The hotkey and set_mic_muted share the one flag.
        c.set_mic_muted(true, MuteSource::Command);
        c.mute_hook.simulate_press();
        assert_eq!(mic_muted_events(&c.tick()), vec![(false, Hotkey)]);
    }

    #[test]
    fn mute_hotkey_presses_beyond_the_tick_cap_apply_next_tick() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(with_mute_hotkey(Some("Mouse4")));
        // 21 presses piled up (a stalled loop): an odd count ends muted.
        let n = MAX_MUTE_PRESSES_PER_TICK + 5;
        for _ in 0..n {
            c.mute_hook.simulate_press();
        }
        let first = mic_muted_events(&c.tick());
        assert_eq!(first.len(), MAX_MUTE_PRESSES_PER_TICK as usize);
        let second = mic_muted_events(&c.tick());
        assert_eq!(second.len(), 5, "the rest comes next tick");
        assert!(state_of(&c).mic_muted, "{n} presses from unmuted end muted");
        assert!(mic_muted_events(&c.tick()).is_empty());
    }

    #[test]
    fn mute_hotkey_hook_follows_configure_and_shutdown() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert_eq!(c.mute_hook.running(), None, "no spec, no hook thread");

        c.configure(with_mute_hotkey(Some("V")));
        assert_eq!(c.mute_hook.running(), Some("keyboard"));
        // Other settings changing leaves it alone.
        c.configure(Profile {
            gate_enabled: true,
            ..with_mute_hotkey(Some("V"))
        });
        assert_eq!(c.mute_hook.running(), Some("keyboard"));
        // A mouse button needs the mouse hook instead.
        c.configure(with_mute_hotkey(Some("Ctrl+Mouse5")));
        assert_eq!(c.mute_hook.running(), Some("mouse"));
        // Blank or null clears it.
        c.configure(with_mute_hotkey(Some("  ")));
        assert_eq!(c.mute_hook.running(), None);
        c.configure(with_mute_hotkey(Some("Mouse4")));
        c.configure(with_mute_hotkey(None));
        assert_eq!(c.mute_hook.running(), None);

        // A press the controller hadn't taken when the hotkey was cleared is dropped.
        c.configure(with_mute_hotkey(Some("Mouse4")));
        c.mute_hook.simulate_press();
        c.configure(with_mute_hotkey(None));
        assert!(mic_muted_events(&c.tick()).is_empty());
        assert!(!state_of(&c).mic_muted);

        c.configure(with_mute_hotkey(Some("Mouse4")));
        c.shutdown();
        assert_eq!(c.mute_hook.running(), None, "shutdown removes the hook");
        assert!(state_of(&c).hotkey_errors.is_empty());
    }

    // ---- push-to-talk (hooks never installed in tests, see `MuteHook::new`) ----

    fn ptt_profile(mode: Option<&str>, key: Option<&str>, mute: Option<&str>) -> Profile {
        Profile {
            mic_mode: mode.map(str::to_string),
            ptt_key: key.map(str::to_string),
            mic_mute_hotkey: mute.map(str::to_string),
            ..Default::default()
        }
    }

    /// The `mic_open` events in `evs`, in order.
    fn mic_open_events(evs: &[Event]) -> Vec<bool> {
        evs.iter()
            .filter_map(|e| match e {
                Event::MicOpen { open } => Some(*open),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn mic_open_event_on_change() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert!(state_of(&c).mic_open, "always mode, unmuted");
        assert!(mic_open_events(&c.tick()).is_empty(), "no change, no event");

        // Mute closes it (the mic_muted event is separate).
        c.set_mic_muted(true, MuteSource::Command);
        assert!(!state_of(&c).mic_open);
        assert_eq!(mic_open_events(&c.tick()), vec![false]);
        assert!(mic_open_events(&c.tick()).is_empty(), "once per change");
        c.set_mic_muted(false, MuteSource::Command);
        assert_eq!(mic_open_events(&c.tick()), vec![true]);

        // Switching into PTT closes it; the chain opening it (key held or
        // tail, published through the params) opens it.
        c.configure(ptt_profile(Some("ptt"), Some("Mouse5"), None));
        assert_eq!(mic_open_events(&c.tick()), vec![false]);
        assert!(!state_of(&c).mic_open);
        c.engine.params().set_ptt_open(true);
        // Audio is not running in tests: a stale flag must not count.
        assert!(!state_of(&c).mic_open, "PTT is closed while audio is off");
        assert!(mic_open_events(&c.tick()).is_empty());
    }

    #[test]
    fn mic_open_follows_ptt_gate_while_running() {
        // `ptt_open` is what the chain publishes; the controller trusts it only
        // while the engine runs. Drive the pure rule directly.
        assert!(mic_open_of(false, false, false, false), "always, unmuted");
        assert!(!mic_open_of(true, false, false, false), "always, muted");
        assert!(!mic_open_of(false, true, false, true), "PTT, audio off");
        assert!(mic_open_of(false, true, true, true), "PTT, gate open");
        assert!(!mic_open_of(false, true, true, false), "PTT, gate closed");
        assert!(!mic_open_of(true, true, true, true), "mute overrides PTT");
    }

    #[test]
    fn ptt_mode_starts_closed() {
        let mut c = Controller::new(HotkeyThread::spawn());
        // Fresh engine configured straight into PTT: the key reads released
        // even if the hook had it held before.
        c.ptt_hook.simulate_held(true);
        c.engine.params().set_ptt_open(true);
        c.configure(ptt_profile(Some("ptt"), Some("Mouse5"), None));
        assert!(!c.engine.params().ptt_held(), "start closed");
        assert!(!c.engine.params().ptt_open());
        assert!(!state_of(&c).mic_open);

        // A held key stays held while in PTT mode ...
        c.ptt_hook.simulate_held(true);
        assert!(c.engine.params().ptt_held());
        // ... unconfiguring other things does not clear it ...
        c.configure(Profile {
            gate_enabled: true,
            ..ptt_profile(Some("ptt"), Some("Mouse5"), None)
        });
        assert!(c.engine.params().ptt_held());
        // ... but an audio restart does (fail closed until a fresh press).
        c.engine.params().set_ptt_open(true);
        c.start_audio(); // no microphone selected: fails, which is fine here
        assert!(!c.engine.params().ptt_held(), "closed after restart");
        assert!(!c.engine.params().ptt_open());

        // Always -> PTT switch clears it as well.
        c.configure(Profile::default());
        assert!(!c.engine.params().ptt_mode());
        c.ptt_hook.simulate_held(true);
        c.configure(ptt_profile(Some("ptt"), Some("Mouse5"), None));
        assert!(c.engine.params().ptt_mode());
        assert!(!c.engine.params().ptt_held(), "closed after a mode switch");
    }

    #[test]
    fn ptt_lost_keyup_released_by_physical_poll() {
        use crate::llhooks::{MouseButton, Trigger};
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(ptt_profile(Some("ptt"), Some("Mouse5"), None));
        let params = c.engine.params();
        // Key-down seen, key-up lost: flag held, gate open.
        c.ptt_hook.simulate_held(true);
        // The probe sees the bound button and reports it still down: kept.
        let mut seen = None;
        c.poll_ptt_physical(|t| {
            seen = Some(t);
            true
        });
        assert_eq!(seen, Some(Trigger::Mouse(MouseButton::X2)));
        assert!(params.ptt_held());
        // Physically up: one read is not enough, two clear it.
        c.poll_ptt_physical(|_| false);
        assert!(params.ptt_held(), "one up read could be a fresh press");
        c.poll_ptt_physical(|_| true);
        c.poll_ptt_physical(|_| false);
        assert!(params.ptt_held(), "a down read resets the count");
        c.poll_ptt_physical(|_| false);
        assert!(!params.ptt_held(), "released");
        // The chain then runs the normal tail and closes.
        let mut chain = crate::dsp::MicChain::new(params.clone());
        params.set_ptt_held(true);
        let mut out = Vec::new();
        let tone = vec![0.5f32; 480];
        chain.process(&tone, &mut out);
        assert!(params.ptt_open());
        params.set_ptt_held(false);
        for _ in 0..30 {
            chain.process(&tone, &mut out);
        }
        assert!(!params.ptt_open(), "closed after the tail");
        // Not held: the probe is not even asked.
        c.poll_ptt_physical(|_| panic!("probe asked while released"));
    }

    #[test]
    fn ptt_key_same_as_mute_key_is_error() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(ptt_profile(Some("ptt"), Some("mouse4"), Some("Mouse4")));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "mouse4", "the PTT key is the one reported");
                assert!(message.contains("mute"), "{message}");
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert_eq!(
            c.ptt_hook.running(),
            None,
            "the PTT binding is not registered"
        );
        assert_eq!(c.mute_hook.running(), Some("mouse"), "mute keeps working");
        let errs = state_of(&c).hotkey_errors;
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert_eq!(errs[0].accel, "mouse4");
        assert!(!state_of(&c).mic_open, "PTT with no key stays closed");

        // The same key in a different spelling is the same key.
        let evs = c.configure(ptt_profile(
            Some("ptt"),
            Some("Shift+Ctrl+M"),
            Some("ctrl+shift+m"),
        ));
        assert!(
            matches!(evs.as_slice(), [Event::HotkeyError { accel, .. }] if accel == "Shift+Ctrl+M"),
            "{evs:?}"
        );
        assert_eq!(c.ptt_hook.running(), None);

        // Changing either one clears the conflict and registers the PTT key.
        let evs = c.configure(ptt_profile(Some("ptt"), Some("Mouse4"), Some("Mouse5")));
        assert!(evs.is_empty(), "{evs:?}");
        assert_eq!(c.ptt_hook.running(), Some("mouse"));
        assert!(state_of(&c).hotkey_errors.is_empty());
    }

    #[test]
    fn ptt_key_parse_error_listed_and_mic_stays_closed() {
        let mut c = Controller::new(HotkeyThread::spawn());
        let evs = c.configure(ptt_profile(Some("ptt"), Some("Ctrl+"), None));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "Ctrl+");
                assert!(message.contains("push-to-talk"), "{message}");
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert_eq!(c.ptt_hook.running(), None);
        assert!(!state_of(&c).mic_open, "no fallback to open");
        assert_eq!(state_of(&c).hotkey_errors[0].accel, "Ctrl+");
        // A null key in PTT mode: no error, still closed.
        let evs = c.configure(ptt_profile(Some("ptt"), None, None));
        assert!(evs.is_empty());
        assert!(!state_of(&c).mic_open);
        assert!(state_of(&c).hotkey_errors.is_empty());
        // A valid key registers a hook.
        c.configure(ptt_profile(Some("ptt"), Some("F8"), None));
        assert_eq!(c.ptt_hook.running(), Some("keyboard"));
        c.shutdown();
        assert_eq!(c.ptt_hook.running(), None, "shutdown removes the hook");
    }

    #[test]
    fn mute_hotkey_parse_error_listed_in_hotkey_errors() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        let evs = c.configure(with_mute_hotkey(Some("Ctrl+")));
        match evs.as_slice() {
            [Event::HotkeyError { accel, message }] => {
                assert_eq!(accel, "Ctrl+");
                assert!(
                    message.starts_with("invalid mute hotkey \"Ctrl+\""),
                    "{message}"
                );
            }
            other => panic!("expected one hotkey_error, got {other:?}"),
        }
        assert_eq!(c.mute_hook.running(), None, "no hook for a bad spec");
        let errs = state_of(&c).hotkey_errors;
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert_eq!(errs[0].accel, "Ctrl+");

        // One-shot: the same profile again sends nothing; the state keeps listing it.
        assert!(c.configure(with_mute_hotkey(Some("Ctrl+"))).is_empty());
        assert_eq!(state_of(&c).hotkey_errors.len(), 1);

        let evs = c.configure(with_mute_hotkey(Some("Mouse9")));
        assert!(
            matches!(evs.as_slice(), [Event::HotkeyError { accel, .. }] if accel == "Mouse9"),
            "{evs:?}"
        );
        assert_eq!(state_of(&c).hotkey_errors[0].accel, "Mouse9");

        // A valid spec clears the error and binds.
        assert!(c.configure(with_mute_hotkey(Some("Mouse4"))).is_empty());
        assert!(state_of(&c).hotkey_errors.is_empty());
        assert_eq!(c.mute_hook.running(), Some("mouse"));
        // So does clearing it.
        c.configure(with_mute_hotkey(Some("nope")));
        assert_eq!(state_of(&c).hotkey_errors.len(), 1);
        c.configure(with_mute_hotkey(None));
        assert!(state_of(&c).hotkey_errors.is_empty());
    }

    #[test]
    fn controller_healthy_core_status_changes_nothing() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        for s in [CoreStatus::Off, CoreStatus::Starting, CoreStatus::Running] {
            c.apply_core_status(s);
            let st = state_of(&c);
            assert_eq!(st.audio, AudioStatus::Off);
            assert!(st.error.is_none());
        }
    }

    #[test]
    fn controller_stop_resets_input_level() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.engine.params().set_input_level(0.5);
        c.set_audio(false);
        assert_eq!(c.engine.params().input_level(), 0.0);
    }

    // ---- audio auto-retry ----

    #[test]
    fn audio_retry_due_only_when_wanted_errored_and_interval_passed() {
        let two = Duration::from_secs(2);
        let early = Duration::from_millis(1999);
        assert!(audio_retry_due(true, false, true, two));
        assert!(audio_retry_due(true, false, true, Duration::from_secs(9)));
        assert!(!audio_retry_due(true, false, true, early));
        assert!(!audio_retry_due(false, false, true, two), "not wanted");
        assert!(!audio_retry_due(true, true, true, two), "already running");
        assert!(!audio_retry_due(true, false, false, two), "no error");
    }

    fn backdate_attempt(c: &mut Controller) {
        c.last_audio_attempt = Instant::now().checked_sub(Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn controller_retries_failed_audio_while_wanted() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.set_audio(true);
        assert_eq!(
            state_of(&c).error.as_deref(),
            Some("No microphone selected")
        );

        // Not due yet: no new attempt.
        backdate_attempt(&mut c);
        c.last_audio_attempt += Duration::from_millis(1500);
        c.tick();
        assert!(c.last_audio_attempt.elapsed() >= Duration::from_millis(1000));

        // Due: tick retries (still failing, still the same error).
        backdate_attempt(&mut c);
        c.tick();
        assert!(
            c.last_audio_attempt.elapsed() < Duration::from_secs(1),
            "no retry"
        );
        let s = state_of(&c);
        assert_eq!(s.audio, AudioStatus::Error);
        assert_eq!(s.error.as_deref(), Some("No microphone selected"));
    }

    #[test]
    fn controller_does_not_retry_after_set_audio_off() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.set_audio(true);
        c.set_audio(false);
        backdate_attempt(&mut c);
        c.tick();
        assert!(
            c.last_audio_attempt.elapsed() >= Duration::from_secs(2),
            "retried"
        );
        assert_eq!(state_of(&c).audio, AudioStatus::Off);
    }

    #[test]
    fn controller_runtime_failure_retries_after_interval() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.audio_wanted = true;
        backdate_attempt(&mut c);
        c.apply_core_status(mic_failed("unplugged"));
        // The failure itself starts the 2 s retry clock.
        assert!(c.last_audio_attempt.elapsed() < Duration::from_secs(1));
        assert!(!audio_retry_due(
            c.audio_wanted,
            false,
            c.audio_error.is_some(),
            c.last_audio_attempt.elapsed()
        ));
    }

    #[test]
    fn controller_reports_lock_conflict_exactly() {
        let _serial = crate::instance::TEST_LOCK_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let held = InstanceLock::acquire().expect("test holds the audio lock");
        let mut c = Controller::new(HotkeyThread::spawn());
        // Never-real devices: nothing opens even if the lock were free.
        c.configure(Profile {
            input_id: Some("bogus-device".into()),
            output_id: Some("bogus-device".into()),
            ..Default::default()
        });
        c.set_audio(true);
        assert_eq!(
            state_of(&c).error.as_deref(),
            Some("o2i is already running audio elsewhere (the o2i window or another o2i engine). Close that one first")
        );
        c.set_audio(false);
        drop(held);
    }

    // ---- hotkey errors in state ----

    #[test]
    fn controller_state_lists_failing_hotkeys() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert!(state_of(&c).hotkey_errors.is_empty());

        c.configure(Profile {
            sb_stop_all_hotkey: Some("NotAKey!!!".into()),
            ..Default::default()
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut errs = state_of(&c).hotkey_errors;
        while errs.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
            errs = state_of(&c).hotkey_errors;
        }
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert_eq!(errs[0].accel, "NotAKey!!!");
        assert_eq!(errs[0].message, "invalid accelerator: \"NotAKey!!!\"");
        // The one-shot event is still emitted (back-compat).
        let evs = c.tick();
        assert!(
            evs.iter()
                .any(|e| matches!(e, Event::HotkeyError { accel, .. } if accel == "NotAKey!!!")),
            "{evs:?}"
        );
    }

    // ---- Controller ----

    #[test]
    fn controller_play_without_folder_errors() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert_eq!(
            single_error(&c.play_clip(Some("x.mp3"), None)),
            "No clip folder set"
        );
        assert_eq!(
            single_error(&c.play_clip(None, Some(r"C:\x.mp3"))),
            "No clip folder set"
        );
    }

    #[test]
    fn controller_play_by_path_checks_order() {
        let a = source_with("play-path-a", &["x.wav"]);
        let b = source_with("play-path-b", &["y.wav"]);
        std::fs::write(b.join("junk.wav"), b"definitely not audio data").unwrap();
        let outside = source_with("play-path-out", &["z.wav"]);
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folders: vec![s(&a), s(&b)],
            ..Default::default()
        });
        assert_eq!(
            single_error(&c.play_clip(None, Some(&s(&outside.join("z.wav"))))),
            "Sound is not in a soundboard folder"
        );
        let gone = s(&b.join("gone.wav"));
        assert_eq!(
            single_error(&c.play_clip(None, Some(&gone))),
            format!("Clip not found: {gone}")
        );
        let junk = s(&b.join("junk.wav"));
        let msg = single_error(&c.play_clip(None, Some(&junk)));
        assert!(msg.starts_with(&format!("Can't play {junk}: ")), "{msg}");
        // Found + decodable in the second source: only "audio off" remains.
        assert_eq!(
            single_error(&c.play_clip(None, Some(&s(&b.join("y.wav"))))),
            "Audio is off"
        );
        for d in [a, b, outside] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn controller_hotkey_keys_play_paths_and_legacy_names() {
        let a = source_with("hk-a", &["x.wav"]);
        let b = source_with("hk-b", &["y.wav"]);
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folders: vec![s(&a), s(&b)],
            ..Default::default()
        });
        // Both resolve (so the only error is "Audio is off").
        let path_key = SoundKey::from(s(&b.join("y.wav")).as_str());
        assert_eq!(single_error(&c.play_key(&path_key)), "Audio is off");
        assert_eq!(
            single_error(&c.play_key(&SoundKey::from("x.wav"))),
            "Audio is off"
        );
        // A legacy name only looks in the first source.
        assert_eq!(
            single_error(&c.play_key(&SoundKey::from("y.wav"))),
            "Clip not found: y.wav"
        );
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn playing_json_derives_name_and_path_from_label() {
        assert_eq!(
            label_name_path(r"C:\snd\a.mp3"),
            ("a.mp3".to_string(), Some(r"C:\snd\a.mp3".to_string()))
        );
        assert_eq!(label_name_path("a.mp3"), ("a.mp3".to_string(), None));
    }

    struct MockVoices;
    impl tts::Synth for MockVoices {
        fn prefix(&self) -> &'static str {
            "mock:"
        }
        fn voices(&self) -> Vec<tts::Voice> {
            vec![tts::Voice {
                id: "mock:a".into(),
                name: "A".into(),
                source: "windows",
                installed: true,
                size_mb: None,
            }]
        }
        fn synthesize(&self, _: &str, _: &str, _: f32) -> Result<tts::Audio, String> {
            Err("mock failure".into())
        }
    }

    fn speak_controller() -> Controller {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.tts = Tts::new(vec![Arc::new(MockVoices)]);
        c
    }

    #[test]
    fn speak_empty_text_errors() {
        let mut c = speak_controller();
        // Empty text is reported first, even with audio off and a bad voice.
        assert_eq!(
            single_error(&c.speak("  \n ", "nope", None)),
            "Nothing to say"
        );
        assert_eq!(
            single_error(&c.speak_with("", "mock:a", None, true)),
            "Nothing to say"
        );
    }

    #[test]
    fn speak_audio_off_errors() {
        let mut c = speak_controller();
        assert_eq!(single_error(&c.speak("hi", "mock:a", None)), "Audio is off");
        // Audio off beats an unknown voice.
        assert_eq!(single_error(&c.speak("hi", "nope", None)), "Audio is off");
    }

    #[test]
    fn speak_unknown_voice_errors() {
        let mut c = speak_controller();
        assert_eq!(
            single_error(&c.speak_with("hi", "win:missing", None, true)),
            "Unknown voice: win:missing"
        );
        assert_eq!(
            single_error(&c.speak_with("hi", "mock:b", None, true)),
            "Unknown voice: mock:b"
        );
        // Nothing was queued, so nothing comes back.
        std::thread::sleep(Duration::from_millis(50));
        assert!(c.tick().is_empty());
    }

    #[test]
    fn speak_synthesis_failure_becomes_error_event() {
        let mut c = speak_controller();
        assert!(c.speak_with("hi", "mock:a", None, true).is_empty());
        let end = Instant::now() + Duration::from_secs(10);
        let msg = loop {
            let evs = c.tick();
            if !evs.is_empty() {
                break single_error(&evs);
            }
            assert!(Instant::now() < end, "no error event");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(msg, "mock failure");
        assert!(c.tts_live.is_empty());
    }

    fn waiting(name: &str) -> tts::Prepared {
        tts::Prepared {
            name: name.into(),
            stream: crate::soundboard::ClipStream::from_buffer(vec![0.0; 4]),
        }
    }

    #[test]
    fn tts_speaks_play_in_order() {
        let mut c = speak_controller();
        // One speech is playing (the test holds the soundboard's reference).
        let holder = Arc::new(ClipGains::new(1.0, 1.0, false));
        c.tts_live.insert(1, holder.clone());
        c.tts_wait.push_back(waiting("TTS: second"));
        c.tts_wait.push_back(waiting("TTS: third"));
        c.advance_tts(true);
        assert_eq!(c.tts_wait.len(), 2, "must wait while the first plays");
        // The first finishes: only the next one starts, not both.
        drop(holder);
        c.advance_tts(true);
        assert_eq!(c.tts_wait.len(), 1);
        assert_eq!(c.tts_live.len(), 1);
        assert_eq!(c.tts_wait[0].name, "TTS: third");
    }

    #[test]
    fn tts_stop_starts_next() {
        let mut c = speak_controller();
        let holder = Arc::new(ClipGains::new(1.0, 1.0, false));
        c.tts_live.insert(7, holder.clone());
        c.tts_wait.push_back(waiting("TTS: next"));
        c.stop_clip(7);
        // The soundboard drops the stopped item.
        drop(holder);
        c.advance_tts(true);
        assert!(c.tts_wait.is_empty());
        assert_eq!(c.tts_live.len(), 1);
        assert!(!c.tts_live.contains_key(&7));
    }

    #[test]
    fn stop_audio_drops_waiting_tts() {
        let mut c = speak_controller();
        c.tts_live
            .insert(1, Arc::new(ClipGains::new(1.0, 1.0, false)));
        c.tts_wait.push_back(waiting("TTS: a"));
        c.tts_wait.push_back(waiting("TTS: b"));
        c.stop_audio("test");
        assert!(c.tts_wait.is_empty());
        assert!(c.tts_live.is_empty());
        // And with audio off nothing starts.
        c.tts_wait.push_back(waiting("TTS: c"));
        c.advance_tts(false);
        assert!(c.tts_wait.is_empty());
    }

    #[test]
    fn speak_limit_counts_waiting_speech() {
        let mut c = speak_controller();
        // Finished speech waiting to play counts toward the limit of 8.
        for i in 0..8 {
            c.tts_wait.push_back(waiting(&format!("TTS: {i}")));
        }
        assert_eq!(
            single_error(&c.speak_with("hi", "mock:a", None, true)),
            "Too many speech requests queued"
        );
        c.tts_wait.pop_front();
        assert!(c.speak_with("hi", "mock:a", None, true).is_empty());
        // Requests still being synthesized count too (nothing polled yet).
        c.tts_wait.clear();
        c.tts_wait.push_back(waiting("TTS: a"));
        for _ in 0..6 {
            assert!(c.speak_with("hi", "mock:a", None, true).is_empty());
        }
        assert_eq!(
            single_error(&c.speak_with("hi", "mock:a", None, true)),
            "Too many speech requests queued"
        );
    }

    #[test]
    fn install_tts_voice_rejects_unknown_ids() {
        let mut c = speak_controller();
        assert_eq!(
            single_error(&c.install_tts_voice("piper:nope")),
            "Unknown voice: piper:nope"
        );
        assert_eq!(
            single_error(&c.install_tts_voice("win:x")),
            "Unknown voice: win:x"
        );
        assert!(state_of(&c).tts_install.is_none());
    }

    #[test]
    fn speak_uninstalled_piper_voice_errors() {
        let mut c = speak_controller();
        let dir = std::env::temp_dir().join(format!("o2i-ctl-piper-{}", std::process::id()));
        c.piper = tts::piper::Piper::system(dir.clone());
        c.tts = Tts::new(vec![c.piper.clone()]);
        let id = tts::piper::Catalogue::official().voices[0].id();
        assert_eq!(
            single_error(&c.speak_with("hi", &id, None, true)),
            format!("Voice not installed: {id}")
        );
        assert_eq!(
            single_error(&c.speak_with("hi", "piper:nope", None, true)),
            "Unknown voice: piper:nope"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tts_uses_global_gains_and_is_not_seekable() {
        let p = Profile {
            sb_global_others: Some(0.3),
            sb_global_self: Some(0.7),
            sb_global_hear_local: true,
            ..Default::default()
        };
        assert_eq!(tts_gains(&p), (0.3, 0.7, true));
        assert_eq!(tts_gains(&Profile::default()), (1.0, 1.0, false));
        let mut c = speak_controller();
        let g = Arc::new(ClipGains::new(1.0, 1.0, false));
        c.tts_live.insert(5, g.clone());
        c.configure(p);
        assert_eq!(g.load(), (0.3, 0.7, true));
        assert_eq!(single_error(&c.seek_clip(5, 1.0)), "Speech can't be seeked");
    }

    #[test]
    fn tts_volume_scales_speech_only() {
        let p = Profile {
            sb_global_others: Some(0.5),
            sb_global_self: Some(0.8),
            sb_global_hear_local: true,
            tts_volume: Some(1.5),
            ..Default::default()
        };
        assert_eq!(tts_gains(&p), (0.75, 1.2000001, true));
        // Clips are untouched, override or not.
        let q = Profile {
            sb_global_override: true,
            ..p.clone()
        };
        assert_eq!(
            resolve_clip_gains(&q, Path::new(r"C:.mp3")),
            (0.5, 0.8, true)
        );
        // Live: playing speech follows a change at once.
        let mut c = speak_controller();
        let g = Arc::new(ClipGains::new(1.0, 1.0, false));
        c.tts_live.insert(5, g.clone());
        c.configure(p.clone());
        assert_eq!(g.load(), (0.75, 1.2000001, true));
        c.configure(Profile {
            tts_volume: Some(0.5),
            ..p
        });
        assert_eq!(g.load(), (0.25, 0.4, true));
    }

    #[test]
    fn tts_volume_null_is_one() {
        assert_eq!(tts_gains(&Profile::default()), (1.0, 1.0, false));
        let p: Profile = serde_json::from_str(r#"{"tts_volume":null}"#).unwrap();
        assert_eq!(p.tts_volume, None);
        assert_eq!(tts_volume(&p), 1.0);
        let p: Profile = serde_json::from_str("{}").unwrap();
        assert_eq!(tts_volume(&p), 1.0);
    }

    #[test]
    fn tts_volume_clamped() {
        let v = |x: f32| {
            tts_volume(&Profile {
                tts_volume: Some(x),
                ..Default::default()
            })
        };
        assert_eq!(v(5.0), 2.0);
        assert_eq!(v(-1.0), 0.0);
        assert_eq!(v(0.0), 0.0);
        assert_eq!(v(f32::NAN), 1.0);
        assert_eq!(v(f32::INFINITY), 1.0);
        let big = Profile {
            tts_volume: Some(9.0),
            ..Default::default()
        };
        assert_eq!(tts_gains(&big), (2.0, 2.0, false));
    }

    #[test]
    fn controller_seek_unknown_id_errors() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        assert_eq!(single_error(&c.seek_clip(42, 1.0)), "No such playing sound");
        assert_eq!(single_error(&c.seek_clip(0, -3.0)), "No such playing sound");
    }

    #[test]
    fn seek_target_clamps_into_the_clip() {
        assert_eq!(seek_target_frames(0.5, Some(48_000)), 24_000);
        assert_eq!(seek_target_frames(-2.0, Some(48_000)), 0);
        assert_eq!(seek_target_frames(f64::NAN, Some(48_000)), 0);
        // [0, len): at/after the end clamps to the last frame.
        assert_eq!(seek_target_frames(1.0, Some(48_000)), 47_999);
        assert_eq!(seek_target_frames(99.0, Some(48_000)), 47_999);
        assert_eq!(seek_target_frames(3.0, Some(0)), 0);
        // Unknown length: unclamped above 0 (the decoder ends it if past the end).
        assert_eq!(seek_target_frames(42.5, None), 2_040_000);
        assert_eq!(seek_target_frames(1e300, None), u64::MAX);
    }

    #[test]
    fn controller_configure_updates_live_gains() {
        let a = source_with("live-gains", &["a.wav", "b.wav"]);
        let (pa, pb) = (a.join("a.wav"), a.join("b.wav"));
        let mut c = Controller::new(HotkeyThread::spawn());
        let base = Profile {
            sb_folders: vec![s(&a)],
            ..Default::default()
        };
        c.configure(base.clone());
        // Two playing instances; the test holds the soundboard's reference.
        let ga = Arc::new(ClipGains::new(1.0, 1.0, false));
        let gb = Arc::new(ClipGains::new(1.0, 1.0, false));
        c.live.insert(1, (pa.clone(), ga.clone()));
        c.live.insert(2, (pb.clone(), gb.clone()));

        // Per-sound settings (by path, and legacy by name) apply immediately.
        c.configure(Profile {
            sb_clip_settings: vec![
                clip(&s(&pa), 0.3, 0.6, true),
                clip("b.wav", 0.2, 0.4, false),
            ],
            ..base.clone()
        });
        assert_eq!(ga.load(), (0.3, 0.6, true));
        assert_eq!(gb.load(), (0.2, 0.4, false));

        // The global override wins for every playing instance.
        c.configure(Profile {
            sb_global_override: true,
            sb_global_others: Some(0.1),
            sb_global_self: Some(0.9),
            sb_global_hear_local: true,
            sb_clip_settings: vec![clip(&s(&pa), 0.3, 0.6, true)],
            ..base.clone()
        });
        assert_eq!(ga.load(), (0.1, 0.9, true));
        assert_eq!(gb.load(), (0.1, 0.9, true));

        // An instance that finished (the soundboard dropped it) is pruned.
        drop(gb);
        c.configure(base.clone());
        assert_eq!(ga.load(), (1.0, 1.0, false));
        assert_eq!(c.live.keys().copied().collect::<Vec<_>>(), vec![1]);
        let _ = std::fs::remove_dir_all(&a);
    }

    #[test]
    fn list_clips_flattens_all_sources_with_duplicate_names() {
        let a = source_with("list-a", &["a.wav", "b.wav"]);
        let b = source_with("list-b", &["a.wav"]);
        std::fs::write(b.join("notes.txt"), b"x").unwrap();
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folder: Some(r"C:\ignored-when-sb_folders-set".into()),
            sb_folders: vec![s(&a), s(&b), r"Z:\missing\folder".into()],
            ..Default::default()
        });
        match c.list_clips() {
            Event::Clips { folder, clips } => {
                assert_eq!(folder, Some(s(&a)));
                let got: Vec<(&str, &str, &str)> = clips
                    .iter()
                    .map(|c| (c.file.as_str(), c.path.as_str(), c.source.as_str()))
                    .collect();
                let (pa, pb, pa2) = (
                    s(&a.join("a.wav")),
                    s(&a.join("b.wav")),
                    s(&b.join("a.wav")),
                );
                let (sa, sb) = (s(&a), s(&b));
                assert_eq!(
                    got,
                    vec![
                        ("a.wav", pa.as_str(), sa.as_str()),
                        ("b.wav", pb.as_str(), sa.as_str()),
                        ("a.wav", pa2.as_str(), sb.as_str()),
                    ]
                );
                assert!(clips.iter().all(|c| c.duration_s.is_some()));
                // Every listed path plays back to itself.
                let p = &c.profile;
                for clip in &clips {
                    assert_eq!(
                        resolve_sound(p, None, Some(&clip.path)),
                        Ok(PathBuf::from(&clip.path))
                    );
                }
            }
            other => panic!("expected clips, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn controller_play_missing_file_errors() {
        let dir = temp_dir("missing");
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folder: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert_eq!(
            single_error(&c.play_clip(Some("nope.mp3"), None)),
            "Clip not found: nope.mp3"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn controller_play_rejects_paths_outside_folder() {
        let dir = temp_dir("traversal");
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folder: Some(dir.join("sub").to_string_lossy().into_owned()),
            ..Default::default()
        });
        std::fs::write(dir.join("outside.mp3"), b"x").unwrap();
        assert_eq!(
            single_error(&c.play_clip(Some("../outside.mp3"), None)),
            "Clip not found: ../outside.mp3"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn controller_play_undecodable_clip_errors() {
        let dir = temp_dir("undecodable");
        std::fs::write(dir.join("empty.mp3"), b"").unwrap();
        std::fs::write(dir.join("junk.wav"), b"definitely not audio data").unwrap();
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folder: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        });
        // Checked before "Audio is off" so it's reported with audio off too.
        for file in ["empty.mp3", "junk.wav"] {
            let msg = single_error(&c.play_clip(Some(file), None));
            let prefix = format!("Can't play {file}: ");
            assert!(msg.starts_with(&prefix), "{msg}");
            assert!(msg.len() > prefix.len(), "no reason in {msg:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn controller_play_with_audio_off_errors() {
        let dir = temp_dir("audiooff");
        write_test_wav(&dir.join("a.wav"), 48_000, 2, 4_800);
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            sb_folder: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        });
        assert_eq!(
            single_error(&c.play_clip(Some("a.wav"), None)),
            "Audio is off"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn controller_set_audio_without_mic_reports_error() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        c.set_audio(true);
        match c.state() {
            Event::State(s) => {
                assert_eq!(s.audio, AudioStatus::Error);
                assert_eq!(s.error.as_deref(), Some("No microphone selected"));
            }
            other => panic!("expected state, got {other:?}"),
        }
        // Turning audio off clears the error.
        c.set_audio(false);
        match c.state() {
            Event::State(s) => {
                assert_eq!(s.audio, AudioStatus::Off);
                assert!(s.error.is_none());
            }
            other => panic!("expected state, got {other:?}"),
        }
    }

    #[test]
    fn controller_state_lists_routed_apps_unattached_when_off() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile {
            routed_apps: vec![ra("Spotify.exe")],
            ..Default::default()
        });
        assert!(c.tick().is_empty());
        match c.state() {
            Event::State(s) => {
                assert_eq!(s.audio, AudioStatus::Off);
                assert!(s.playing.is_empty());
                assert_eq!(s.input_level, 0.0);
                assert_eq!(s.apps.len(), 1);
                assert_eq!(s.apps[0].name, "Spotify.exe");
                assert!(!s.apps[0].attached);
            }
            other => panic!("expected state, got {other:?}"),
        }
    }

    #[test]
    fn controller_list_clips() {
        let mut c = Controller::new(HotkeyThread::spawn());
        c.configure(Profile::default());
        match c.list_clips() {
            Event::Clips { folder, clips } => {
                assert!(folder.is_none());
                assert!(clips.is_empty());
            }
            other => panic!("expected clips, got {other:?}"),
        }
        let dir = temp_dir("list");
        std::fs::write(dir.join("b.wav"), b"not really audio").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let folder_s = dir.to_string_lossy().into_owned();
        c.configure(Profile {
            sb_folder: Some(folder_s.clone()),
            ..Default::default()
        });
        match c.list_clips() {
            Event::Clips { folder, clips } => {
                assert_eq!(folder.as_deref(), Some(folder_s.as_str()));
                assert_eq!(clips.len(), 1);
                assert_eq!(clips[0].file, "b.wav");
                assert!(clips[0].duration_s.is_none());
                assert_eq!(clips[0].path, s(&dir.join("b.wav")));
                assert_eq!(clips[0].source, folder_s);
            }
            other => panic!("expected clips, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn configure_summary_names_devices_counts_and_flags_but_no_sound_paths() {
        let p = Profile {
            input_id: Some("{mic-id}".into()),
            output_id: None,
            sb_monitor_device: Some("{phones-id}".into()),
            sb_folders: vec![r"C:\sounds\a".into(), r"C:\sounds\b".into()],
            sb_clip_settings: vec![SbClipSetting {
                name: r"C:\sounds\a\secret-ish name.wav".into(),
                vol_others: 0.5,
                vol_self: 0.5,
                hear_local: true,
            }],
            sb_clip_hotkeys: vec![(r"C:\sounds\a\x.wav".into(), "Ctrl+F1".into())],
            sb_stop_all_hotkey: Some("Ctrl+F12".into()),
            routed_apps: vec![RoutedApp {
                name: "spotify.exe".into(),
                volume: 0.7,
            }],
            gate_enabled: true,
            gate_auto: true,
            duck_enabled: true,
            voice_preset: Some("manly".into()),
            mic_mute_hotkey: Some("Mouse4".into()),
            ..Default::default()
        };
        let s = configure_summary(&p);
        for want in [
            "input={mic-id}",
            "output=auto",
            "monitor={phones-id}",
            "sources=2",
            "routed=spotify.exe",
            "hotkeys=2",
            "gate=auto",
            "suppress=off",
            "agc=off",
            "duck=on",
            "voice=manly",
            "mute_hotkey=Mouse4",
        ] {
            assert!(s.contains(want), "{want:?} missing from {s:?}");
        }
        assert!(!s.contains(r"C:\sounds"), "no paths in the summary: {s:?}");
        assert!(!s.contains('\n'));

        // Slider drags (volumes, thresholds) don't change it, so configure
        // logs it only when something that matters changed.
        let dragged = Profile {
            master_volume: Some(0.3),
            mic_volume: Some(1.4),
            gate_threshold: Some(0.02),
            ..p.clone()
        };
        assert_eq!(configure_summary(&dragged), s);
        assert_ne!(
            configure_summary(&Profile {
                input_id: Some("{other-mic}".into()),
                ..p
            }),
            s
        );
        let empty = configure_summary(&Profile::default());
        assert!(
            empty.contains("input=none") && empty.contains("routed=none"),
            "{empty}"
        );
        assert!(empty.contains("mute_hotkey=none"), "{empty}");
    }

    #[test]
    fn slow_list_detail_only_past_threshold() {
        assert_eq!(
            slow_list_detail("list_devices", Duration::from_millis(500), "3 inputs"),
            None
        );
        assert_eq!(
            slow_list_detail("list_apps", Duration::from_millis(812), "14 apps").as_deref(),
            Some("list_apps took 812 ms (14 apps)")
        );
    }
}
