//! Global hotkeys on a dedicated thread with its own Win32 message pump.
//!
//! `global-hotkey`'s manager owns a hidden window and is not `Send`, so it must
//! live on a thread that pumps Win32 messages. `HotkeyThread` spawns that
//! thread, accepts binding sets over a channel, and reports presses/errors back.
//! The press channel inside `global-hotkey` is process-global: ids this thread
//! did not register are ignored.
//!
//! Bindings whose registration failed (another app holds the key) are retried
//! every `RETRY_INTERVAL`; `failing()` lists every binding currently not
//! registered.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::config::Profile;
use crate::hotkeys::{parse_accel, Hotkeys};
use crate::llhooks::{parse_mute_spec, MuteBinding, MAX_MOUSE_SOUND_BINDINGS};

/// How a profile names a sound (`sb_clip_hotkeys[][0]`, `sb_clip_settings[].name`).
#[derive(Clone, Debug, PartialEq)]
pub enum SoundKey {
    /// An absolute path (must be inside a source folder to play).
    Path(String),
    /// Legacy: a bare file name in the first source folder.
    File(String),
}

impl SoundKey {
    /// `(file, path)` as `play_clip` takes them.
    pub fn args(&self) -> (Option<&str>, Option<&str>) {
        match self {
            SoundKey::Path(p) => (None, Some(p)),
            SoundKey::File(f) => (Some(f), None),
        }
    }
}

impl From<&str> for SoundKey {
    /// Absolute paths are paths; anything else is a (legacy) file name.
    fn from(key: &str) -> SoundKey {
        if std::path::Path::new(key).is_absolute() {
            SoundKey::Path(key.to_string())
        } else {
            SoundKey::File(key.to_string())
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum HotkeyAction {
    /// Play this sound.
    Clip(SoundKey),
    StopAll,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HotkeyEvent {
    Pressed(HotkeyAction),
    /// Binding `accel` could not be registered.
    Error {
        accel: String,
        message: String,
    },
}

/// The profile's hotkey bindings: every per-clip hotkey (in order), then stop-all.
pub fn bindings_from_profile(p: &Profile) -> Vec<(String, HotkeyAction)> {
    let mut out: Vec<(String, HotkeyAction)> = p
        .sb_clip_hotkeys
        .iter()
        .map(|(key, accel)| (accel.clone(), HotkeyAction::Clip(key.as_str().into())))
        .collect();
    if let Some(accel) = &p.sb_stop_all_hotkey {
        out.push((accel.clone(), HotkeyAction::StopAll));
    }
    out
}

/// A soundboard binding served by the mouse hook.
#[derive(Clone, Debug, PartialEq)]
pub struct MouseBind {
    pub accel: String,
    pub binding: MuteBinding,
    pub action: HotkeyAction,
}

/// The profile's bindings split by who serves them.
#[derive(Debug, Default, PartialEq)]
pub struct BindingPlan {
    /// Keyboard (and unparseable) bindings, for the `global-hotkey` thread.
    pub keyboard: Vec<(String, HotkeyAction)>,
    /// Mouse bindings to register with the mouse hook, in order.
    pub mouse: Vec<MouseBind>,
    /// `(accel, message)` for mouse bindings that can't be registered.
    pub errors: Vec<(String, String)>,
}

/// Split `binds`: a binding whose trigger is Mouse3/4/5 (bare or with
/// modifiers) goes to the mouse hook, everything else stays on
/// `global-hotkey`. A mouse binding is refused (an error, not registered)
/// when it equals an earlier mouse binding ("already bound", as on the
/// keyboard path), overlaps the mute or PTT key (`reserved`: `(name, spec)`),
/// or is past `MAX_MOUSE_SOUND_BINDINGS`.
pub fn plan_bindings(
    binds: Vec<(String, HotkeyAction)>,
    reserved: &[(&str, MuteBinding)],
) -> BindingPlan {
    let mut plan = BindingPlan::default();
    for (accel, action) in binds {
        let Some(binding) = parse_mute_spec(&accel).ok().filter(|b| b.is_mouse()) else {
            plan.keyboard.push((accel, action));
            continue;
        };
        if plan.mouse.iter().any(|m| m.binding == binding) {
            plan.errors
                .push((accel, "already bound to another action".to_string()));
        } else if let Some((name, _)) = reserved.iter().find(|(_, r)| r.overlaps(binding)) {
            let message = format!("{accel} is already the {name}");
            plan.errors.push((accel, message));
        } else if plan.mouse.len() >= MAX_MOUSE_SOUND_BINDINGS {
            plan.errors
                .push((accel, "Too many mouse hotkeys".to_string()));
        } else {
            plan.mouse.push(MouseBind {
                accel,
                binding,
                action,
            });
        }
    }
    plan
}

const UNAVAILABLE: &str = "global hotkeys unavailable";

/// How often bindings that failed to register are tried again.
const RETRY_INTERVAL: Duration = Duration::from_secs(5);

/// `(accel, message)` for every binding currently not registered.
type FailingList = Arc<Mutex<Vec<(String, String)>>>;

/// A binding that isn't registered.
#[derive(Clone, Debug, PartialEq)]
struct Failure {
    accel: String,
    message: String,
    /// `Some` when registering may succeed later (the key is taken by another
    /// app), so it is retried; `None` when it never can as written (invalid,
    /// duplicate, hotkeys unavailable).
    retry: Option<HotkeyAction>,
}

/// `(accel, message)` per failure, in binding order.
fn failing_snapshot(failures: &[Failure]) -> Vec<(String, String)> {
    failures
        .iter()
        .map(|f| (f.accel.clone(), f.message.clone()))
        .collect()
}

/// Try `register` again for each retryable failure: successes move into
/// `bound` and leave `failures`; repeat failures keep their entry with the
/// latest message. Returns whether the failing list changed.
fn retry_failures(
    failures: &mut Vec<Failure>,
    bound: &mut HashMap<u32, HotkeyAction>,
    mut register: impl FnMut(&str) -> Result<u32, String>,
) -> bool {
    let mut changed = false;
    failures.retain_mut(|f| {
        let Some(action) = &f.retry else {
            return true;
        };
        match register(&f.accel) {
            Ok(id) => {
                bound.insert(id, action.clone());
                changed = true;
                false
            }
            Err(message) => {
                if message != f.message {
                    f.message = message;
                    changed = true;
                }
                true
            }
        }
    });
    changed
}

pub struct HotkeyThread {
    set_tx: Option<Sender<Vec<(String, HotkeyAction)>>>,
    ev_rx: Receiver<HotkeyEvent>,
    /// Only set when the pump thread could not be spawned: `set` reports every
    /// binding as failed through it.
    fail_tx: Option<Sender<HotkeyEvent>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    /// Bindings currently not registered; written by the pump thread.
    failing: FailingList,
    /// The pump thread holds a clone until it exits (lets tests observe exit).
    #[allow(dead_code)] // read only by tests
    alive: Arc<()>,
}

impl HotkeyThread {
    pub fn spawn() -> HotkeyThread {
        HotkeyThread::spawn_with_retry(RETRY_INTERVAL)
    }

    /// `spawn` with a custom retry interval for failed registrations.
    pub fn spawn_with_retry(retry_every: Duration) -> HotkeyThread {
        let (set_tx, set_rx) = channel::<Vec<(String, HotkeyAction)>>();
        let (ev_tx, ev_rx) = channel::<HotkeyEvent>();
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(());
        let failing: FailingList = Arc::new(Mutex::new(Vec::new()));
        let thread_stop = stop.clone();
        let thread_alive = alive.clone();
        let thread_failing = failing.clone();
        let fail_tx = ev_tx.clone();
        let spawned = std::thread::Builder::new()
            .name("o2i-hotkeys".into())
            .spawn(move || {
                let _alive = thread_alive;
                run(set_rx, ev_tx, thread_stop, thread_failing, retry_every);
            });
        let (handle, fail_tx) = match spawned {
            Ok(h) => (Some(h), None),
            Err(e) => {
                elog!("[hotkeys] failed to spawn hotkey thread: {e}");
                (None, Some(fail_tx))
            }
        };
        HotkeyThread {
            set_tx: Some(set_tx),
            ev_rx,
            fail_tx,
            stop,
            handle,
            failing,
            alive,
        }
    }

    /// Replace all bindings: unregister the current set, register `binds`.
    /// Failures arrive later as `HotkeyEvent::Error` via `try_recv` (once per
    /// failing binding) and are listed by `failing()` until they register.
    pub fn set(&self, binds: Vec<(String, HotkeyAction)>) {
        if let Some(fail) = &self.fail_tx {
            let list = binds
                .iter()
                .map(|(accel, _)| (accel.clone(), UNAVAILABLE.to_string()))
                .collect();
            *self.failing.lock().unwrap_or_else(|p| p.into_inner()) = list;
            for (accel, _) in binds {
                let _ = fail.send(HotkeyEvent::Error {
                    accel,
                    message: UNAVAILABLE.to_string(),
                });
            }
            return;
        }
        if let Some(tx) = &self.set_tx {
            let _ = tx.send(binds);
        }
    }

    /// Next pending press or registration error, if any (non-blocking).
    pub fn try_recv(&self) -> Option<HotkeyEvent> {
        self.ev_rx.try_recv().ok()
    }

    /// `(accel, message)` for every binding of the current set that is not
    /// registered right now (empty when all are).
    pub fn failing(&self) -> Vec<(String, String)> {
        self.failing
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    #[cfg(test)]
    fn alive_token(&self) -> Arc<()> {
        self.alive.clone()
    }
}

impl Drop for HotkeyThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.set_tx = None; // disconnects the request channel too
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Body of the pump thread. Never panics; exits when `stop` is set or the
/// request channel disconnects, unregistering everything first.
fn run(
    set_rx: Receiver<Vec<(String, HotkeyAction)>>,
    ev_tx: Sender<HotkeyEvent>,
    stop: Arc<AtomicBool>,
    failing: FailingList,
    retry_every: Duration,
) {
    // The manager's hidden window belongs to this thread, so create it here.
    let mut hotkeys = match Hotkeys::new() {
        Ok(h) => Some(h),
        Err(e) => {
            elog!("[hotkeys] init failed: {e:#}");
            None
        }
    };
    let mut bound: HashMap<u32, HotkeyAction> = HashMap::new();
    let mut failures: Vec<Failure> = Vec::new();
    let mut last_retry = Instant::now();
    let publish = |failures: &[Failure]| {
        *failing.lock().unwrap_or_else(|p| p.into_inner()) = failing_snapshot(failures);
    };

    while !stop.load(Ordering::Relaxed) {
        pump_messages();

        loop {
            match set_rx.try_recv() {
                Ok(binds) => {
                    failures = apply_bindings(hotkeys.as_mut(), &mut bound, binds, &ev_tx);
                    publish(&failures);
                    last_retry = Instant::now();
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }

        if !failures.is_empty() && last_retry.elapsed() >= retry_every {
            last_retry = Instant::now();
            if let Some(hk) = hotkeys.as_mut() {
                let changed = retry_failures(&mut failures, &mut bound, |accel| {
                    hk.register(accel).map_err(|e| format!("{e:#}"))
                });
                if changed {
                    publish(&failures);
                }
            }
        }

        for id in Hotkeys::poll() {
            // Ids registered by another manager in this process are not ours.
            if let Some(action) = bound.get(&id) {
                let _ = ev_tx.send(HotkeyEvent::Pressed(action.clone()));
            }
        }

        wait_for_messages(10);
    }

    if let Some(hk) = hotkeys.as_mut() {
        for id in bound.keys() {
            hk.unregister(*id);
        }
    }
    // `hotkeys` drops here, destroying its window on the thread that created it.
}

/// Unregister every current binding, then register `binds` in order. A bad or
/// duplicate accelerator, or a registration failure, becomes an `Error` event
/// and is returned as a `Failure` (registration failures are retryable).
fn apply_bindings(
    hotkeys: Option<&mut Hotkeys>,
    bound: &mut HashMap<u32, HotkeyAction>,
    binds: Vec<(String, HotkeyAction)>,
    ev_tx: &Sender<HotkeyEvent>,
) -> Vec<Failure> {
    let mut failures = Vec::new();
    let mut fail = |accel: String, message: String, retry: Option<HotkeyAction>| {
        let _ = ev_tx.send(HotkeyEvent::Error {
            accel: accel.clone(),
            message: message.clone(),
        });
        failures.push(Failure {
            accel,
            message,
            retry,
        });
    };
    let Some(hk) = hotkeys else {
        bound.clear();
        for (accel, _) in binds {
            fail(accel, UNAVAILABLE.to_string(), None);
        }
        return failures;
    };
    for id in bound.keys() {
        hk.unregister(*id);
    }
    bound.clear();

    let mut seen: HashSet<u32> = HashSet::new();
    for (accel, action) in binds {
        let Some(parsed) = parse_accel(&accel) else {
            let message = format!("invalid accelerator: {accel:?}");
            fail(accel, message, None);
            continue;
        };
        if !seen.insert(parsed.id()) {
            fail(accel, "already bound to another action".to_string(), None);
            continue;
        }
        match hk.register(&accel) {
            Ok(id) => {
                bound.insert(id, action);
            }
            Err(e) => fail(accel, format!("{e:#}"), Some(action)),
        }
    }
    failures
}

/// Dispatch every queued message for this thread (delivers WM_HOTKEY to the
/// manager's window procedure, which forwards it to the global event channel).
fn pump_messages() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Sleep up to `ms` milliseconds, waking early when a message arrives.
fn wait_for_messages(ms: u32) {
    use windows::Win32::UI::WindowsAndMessaging::{MsgWaitForMultipleObjects, QS_ALLINPUT};
    unsafe {
        let _ = MsgWaitForMultipleObjects(None, false, ms, QS_ALLINPUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Profile;
    use std::time::{Duration, Instant};

    /// Poll `try_recv` until an event arrives or `timeout` elapses.
    fn recv_within(t: &HotkeyThread, timeout: Duration) -> Vec<HotkeyEvent> {
        let deadline = Instant::now() + timeout;
        let mut out = Vec::new();
        while Instant::now() < deadline {
            while let Some(ev) = t.try_recv() {
                out.push(ev);
            }
            if !out.is_empty() {
                return out;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        out
    }

    #[test]
    fn bindings_from_profile_maps_clips_then_stop_all() {
        let p = Profile {
            sb_clip_hotkeys: vec![("a.mp3".into(), "F8".into())],
            sb_stop_all_hotkey: Some("Ctrl+F12".into()),
            ..Default::default()
        };
        assert_eq!(
            bindings_from_profile(&p),
            vec![
                ("F8".to_string(), HotkeyAction::Clip("a.mp3".into())),
                ("Ctrl+F12".to_string(), HotkeyAction::StopAll),
            ]
        );
    }

    #[test]
    fn bindings_accept_paths_and_legacy_names() {
        let p = Profile {
            sb_clip_hotkeys: vec![
                (r"C:\sounds\a.mp3".into(), "F8".into()),
                ("b.mp3".into(), "F9".into()),
                (r"\\nas\share\c.mp3".into(), "F10".into()),
                (r"sub\d.mp3".into(), "F11".into()),
            ],
            ..Default::default()
        };
        assert_eq!(
            bindings_from_profile(&p),
            vec![
                (
                    "F8".to_string(),
                    HotkeyAction::Clip(SoundKey::Path(r"C:\sounds\a.mp3".into()))
                ),
                (
                    "F9".to_string(),
                    HotkeyAction::Clip(SoundKey::File("b.mp3".into()))
                ),
                (
                    "F10".to_string(),
                    HotkeyAction::Clip(SoundKey::Path(r"\\nas\share\c.mp3".into()))
                ),
                // Not absolute: a (legacy) name, which `play_clip` then rejects.
                (
                    "F11".to_string(),
                    HotkeyAction::Clip(SoundKey::File(r"sub\d.mp3".into()))
                ),
            ]
        );
        assert_eq!(
            SoundKey::Path(r"C:\a.mp3".into()).args(),
            (None, Some(r"C:\a.mp3"))
        );
        assert_eq!(SoundKey::File("a.mp3".into()).args(), (Some("a.mp3"), None));
    }

    #[test]
    fn bindings_from_profile_empty_for_default() {
        assert!(bindings_from_profile(&Profile::default()).is_empty());
    }

    #[test]
    fn hotkey_thread_reports_invalid_accel() {
        let t = HotkeyThread::spawn();
        t.set(vec![("NotAKey!!!".into(), HotkeyAction::StopAll)]);
        let evs = recv_within(&t, Duration::from_secs(3));
        assert!(
            evs.iter()
                .any(|e| matches!(e, HotkeyEvent::Error { accel, .. } if accel == "NotAKey!!!")),
            "expected an Error event for the bad accel, got {evs:?}"
        );
    }

    #[test]
    fn hotkey_thread_reports_duplicate_accel() {
        let t = HotkeyThread::spawn();
        t.set(vec![
            (
                "Ctrl+Alt+Shift+F23".into(),
                HotkeyAction::Clip("a.mp3".into()),
            ),
            (
                "Ctrl+Alt+Shift+F23".into(),
                HotkeyAction::Clip("b.mp3".into()),
            ),
        ]);
        let evs = recv_within(&t, Duration::from_secs(3));
        assert!(
            evs.iter().any(|e| matches!(
                e,
                HotkeyEvent::Error { accel, message }
                    if accel == "Ctrl+Alt+Shift+F23" && message.contains("already bound")
            )),
            "expected a duplicate-binding Error, got {evs:?}"
        );
    }

    // ---- retry bookkeeping ----

    fn retryable(accel: &str, action: HotkeyAction, message: &str) -> Failure {
        Failure {
            accel: accel.into(),
            message: message.into(),
            retry: Some(action),
        }
    }

    fn permanent(accel: &str, message: &str) -> Failure {
        Failure {
            accel: accel.into(),
            message: message.into(),
            retry: None,
        }
    }

    #[test]
    fn retry_registers_recovered_bindings_and_keeps_the_rest() {
        let mut failures = vec![
            retryable("F8", HotkeyAction::Clip("a.mp3".into()), "taken"),
            permanent("NotAKey!!!", "invalid accelerator"),
            retryable("F9", HotkeyAction::StopAll, "taken"),
        ];
        let mut bound = HashMap::new();
        let changed = retry_failures(&mut failures, &mut bound, |accel| match accel {
            "F8" => Ok(8),
            "F9" => Err("taken".to_string()),
            other => panic!("permanent failure {other} must not be retried"),
        });
        assert!(changed);
        assert_eq!(bound.get(&8), Some(&HotkeyAction::Clip("a.mp3".into())));
        assert_eq!(bound.len(), 1);
        assert_eq!(
            failing_snapshot(&failures),
            vec![
                ("NotAKey!!!".to_string(), "invalid accelerator".to_string()),
                ("F9".to_string(), "taken".to_string()),
            ]
        );
    }

    #[test]
    fn retry_with_same_failure_reports_no_change() {
        let mut failures = vec![retryable("F9", HotkeyAction::StopAll, "taken")];
        let mut bound = HashMap::new();
        assert!(!retry_failures(&mut failures, &mut bound, |_| Err(
            "taken".to_string()
        )));
        assert!(retry_failures(&mut failures, &mut bound, |_| Err(
            "other".to_string()
        )));
        assert_eq!(
            failing_snapshot(&failures),
            vec![("F9".to_string(), "other".to_string())]
        );
        assert!(bound.is_empty());
    }

    /// Poll `failing()` until `pred` holds or `timeout` elapses.
    fn failing_within(
        t: &HotkeyThread,
        timeout: Duration,
        pred: impl Fn(&[(String, String)]) -> bool,
    ) -> Vec<(String, String)> {
        let deadline = Instant::now() + timeout;
        loop {
            let f = t.failing();
            if pred(&f) || Instant::now() >= deadline {
                return f;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn hotkey_thread_lists_failing_bindings_until_replaced() {
        let t = HotkeyThread::spawn();
        t.set(vec![("NotAKey!!!".into(), HotkeyAction::StopAll)]);
        let f = failing_within(&t, Duration::from_secs(3), |f| !f.is_empty());
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].0, "NotAKey!!!");
        assert!(f[0].1.contains("invalid accelerator"), "{f:?}");
        t.set(Vec::new());
        let f = failing_within(&t, Duration::from_secs(3), |f| f.is_empty());
        assert!(f.is_empty(), "{f:?}");
    }

    #[test]
    fn hotkey_thread_retries_a_taken_binding_until_it_registers() {
        const ACCEL: &str = "Ctrl+Alt+Shift+F22";
        let holder = HotkeyThread::spawn();
        holder.set(vec![(ACCEL.into(), HotkeyAction::StopAll)]);
        std::thread::sleep(Duration::from_millis(300)); // let it register

        let t = HotkeyThread::spawn_with_retry(Duration::from_millis(200));
        t.set(vec![(ACCEL.into(), HotkeyAction::StopAll)]);
        let evs = recv_within(&t, Duration::from_secs(3));
        assert!(
            evs.iter()
                .any(|e| matches!(e, HotkeyEvent::Error { accel, .. } if accel == ACCEL)),
            "expected the taken binding to fail first, got {evs:?}"
        );
        assert_eq!(t.failing().len(), 1);

        drop(holder); // frees the key
        let f = failing_within(&t, Duration::from_secs(3), |f| f.is_empty());
        assert!(f.is_empty(), "binding never re-registered: {f:?}");
        // A recovery is silent: no second one-shot error.
        assert!(recv_within(&t, Duration::from_millis(100)).is_empty());
    }

    #[test]
    fn plan_splits_mouse_from_keyboard() {
        let clip = |n: &str| HotkeyAction::Clip(n.into());
        let plan = plan_bindings(
            vec![
                ("F8".into(), clip("a.mp3")),
                ("Mouse4".into(), clip("b.mp3")),
                ("Ctrl+Mouse5".into(), clip("c.mp3")),
                ("Mouse9".into(), clip("d.mp3")),
                ("Ctrl+F12".into(), HotkeyAction::StopAll),
            ],
            &[],
        );
        let kb: Vec<&str> = plan.keyboard.iter().map(|(a, _)| a.as_str()).collect();
        assert_eq!(kb, ["F8", "Mouse9", "Ctrl+F12"]);
        let mouse: Vec<&str> = plan.mouse.iter().map(|m| m.accel.as_str()).collect();
        assert_eq!(mouse, ["Mouse4", "Ctrl+Mouse5"]);
        assert!(plan.errors.is_empty());
    }

    #[test]
    fn hotkey_thread_exits_when_dropped() {
        let t = HotkeyThread::spawn();
        t.set(Vec::new());
        let token = t.alive_token();
        drop(t);
        // The pump thread held the other clone; after drop (which joins) it's gone.
        assert_eq!(std::sync::Arc::strong_count(&token), 1);
    }

    #[test]
    fn many_hotkey_threads_in_parallel_do_not_deadlock() {
        let workers: Vec<_> = (0..6)
            .map(|_| {
                std::thread::spawn(|| {
                    let t = HotkeyThread::spawn();
                    t.set(Vec::new());
                    t.set(vec![("NotAKey!!!".into(), HotkeyAction::StopAll)]);
                    // Events from other threads' managers are not ours; must not panic.
                    let _ = recv_within(&t, Duration::from_millis(200));
                    drop(t);
                })
            })
            .collect();
        for w in workers {
            assert!(w.join().is_ok());
        }
    }
}
