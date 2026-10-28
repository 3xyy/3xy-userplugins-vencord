//! The mic mute hotkey, seen through low-level keyboard and mouse hooks.
//!
//! The mute hotkey has to work while a game has focus, and the key has to
//! still reach the game. `RegisterHotKey` (the `global-hotkey` crate used for
//! soundboard hotkeys) takes the key away from the focused app, so the mute
//! hotkey uses `WH_KEYBOARD_LL` / `WH_MOUSE_LL` hooks instead. They run on a
//! dedicated thread with its own message loop, see every event and always pass
//! it on (`CallNextHookEx`); nothing is swallowed.
//!
//! Key spec (`Profile.mic_mute_hotkey`): optional modifiers `Ctrl`, `Alt`,
//! `Shift`, `Win` joined with `+`, then one main key. Key names are the soundboard
//! accelerators' (`V`, `F1`..`F24`, `CapsLock`, `Space`, `Num0`, ...), plus the
//! mouse buttons `Mouse3` (middle), `Mouse4` and `Mouse5` (side buttons). A bare
//! key or mouse button is fine and fires whatever modifiers are held (Shift to
//! sprint, Ctrl to crouch, ...). A combo matches its modifiers exactly: `Ctrl+M`
//! fires on Ctrl+M, not on Ctrl+Shift+M.
//!
//! Firing: on the main key's down event, once per physical press. For a
//! keyboard key, auto-repeat is ignored until the key goes up: fresh vs repeat
//! comes from the key's own async state, which inside a keyboard hook is
//! documented to still be the state from before the event. Mouse buttons
//! never auto-repeat, so every Mouse3/4/5 button-down is a press (no async
//! state involved). The hook procedure does the minimum: one atomic load of
//! the packed binding, the edge check (plus `GetAsyncKeyState` reads for a
//! down of the bound key), and on a press one atomic increment that the
//! controller drains on its next tick. No allocation, no locks, no logging,
//! no blocking.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use global_hotkey::hotkey::Code;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThread, GetCurrentThreadId, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
};
use windows::Win32::UI::Input::KeyboardAndMouse as km;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, HOOKPROC, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOWS_HOOK_ID, WM_APP, WM_KEYDOWN, WM_KEYUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_USER, WM_XBUTTONDOWN,
    WM_XBUTTONUP, XBUTTON1, XBUTTON2,
};

/// Modifier bits of a binding (and of the modifiers held right now).
pub const MOD_CTRL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_WIN: u8 = 8;

/// A mouse button the mute hotkey can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    /// `Mouse3`.
    Middle,
    /// `Mouse4` (XBUTTON1, usually "back").
    X1,
    /// `Mouse5` (XBUTTON2, usually "forward").
    X2,
}

/// What has to go down: a key (by virtual-key code) or a mouse button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Key(u16),
    Mouse(MouseButton),
}

/// A parsed mute hotkey: the trigger plus the exact modifiers it needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MuteBinding {
    pub trigger: Trigger,
    pub mods: u8,
}

/// Parse a mute hotkey spec (see the module docs). The error message names
/// the spec and what's wrong with it.
pub fn parse_mute_spec(spec: &str) -> Result<MuteBinding, String> {
    let bad = |why: &str| format!("invalid mute hotkey {spec:?}: {why}");
    let tokens: Vec<&str> = spec.split('+').map(str::trim).collect();
    let Some((&main, mods)) = tokens.split_last() else {
        return Err(bad("empty"));
    };
    if tokens.iter().any(|t| t.is_empty()) {
        return Err(bad(if tokens.len() == 1 {
            "empty"
        } else {
            "a key name is missing"
        }));
    }
    let mut bits = 0;
    for t in mods {
        bits |= modifier_bit(t)
            .ok_or_else(|| bad(&format!("{t:?} is not a modifier (Ctrl, Alt, Shift, Win)")))?;
    }
    if modifier_bit(main).is_some() {
        return Err(bad("needs a key or mouse button after the modifiers"));
    }
    let trigger = main_trigger(main).ok_or_else(|| bad(&format!("unknown key {main:?}")))?;
    Ok(MuteBinding {
        trigger,
        mods: bits,
    })
}

impl MuteBinding {
    /// Whether one physical event could fire both bindings: the same trigger,
    /// and equal modifiers or a bare binding on either side (a bare binding
    /// fires whatever modifiers are held).
    pub fn overlaps(self, other: MuteBinding) -> bool {
        self.trigger == other.trigger
            && (self.mods == other.mods || self.mods == 0 || other.mods == 0)
    }

    /// Whether the trigger is a mouse button.
    pub fn is_mouse(self) -> bool {
        matches!(self.trigger, Trigger::Mouse(_))
    }
}

fn modifier_bit(token: &str) -> Option<u8> {
    match token.to_ascii_uppercase().as_str() {
        "CTRL" | "CONTROL" => Some(MOD_CTRL),
        "ALT" | "OPTION" => Some(MOD_ALT),
        "SHIFT" => Some(MOD_SHIFT),
        "WIN" | "SUPER" | "META" | "CMD" | "COMMAND" => Some(MOD_WIN),
        _ => None,
    }
}

/// A main-key token: `Mouse3`/`Mouse4`/`Mouse5`, or a key name in the
/// soundboard accelerators' vocabulary.
fn main_trigger(token: &str) -> Option<Trigger> {
    match token.to_ascii_uppercase().as_str() {
        "MOUSE3" => return Some(Trigger::Mouse(MouseButton::Middle)),
        "MOUSE4" => return Some(Trigger::Mouse(MouseButton::X1)),
        "MOUSE5" => return Some(Trigger::Mouse(MouseButton::X2)),
        _ => {}
    }
    // A single token (no `+`), so the accelerator parser reads it as a bare key.
    let hotkey = crate::hotkeys::parse_accel(token)?;
    code_to_vk(hotkey.key).map(Trigger::Key)
}

/// Virtual-key code for an accelerator key, matching what `global-hotkey`
/// registers for it (so a name means the same key in both). `NumpadEqual` is
/// left out: there is no Windows virtual key for it.
fn code_to_vk(code: Code) -> Option<u16> {
    use km::*;
    let vk = match code {
        Code::KeyA => VK_A,
        Code::KeyB => VK_B,
        Code::KeyC => VK_C,
        Code::KeyD => VK_D,
        Code::KeyE => VK_E,
        Code::KeyF => VK_F,
        Code::KeyG => VK_G,
        Code::KeyH => VK_H,
        Code::KeyI => VK_I,
        Code::KeyJ => VK_J,
        Code::KeyK => VK_K,
        Code::KeyL => VK_L,
        Code::KeyM => VK_M,
        Code::KeyN => VK_N,
        Code::KeyO => VK_O,
        Code::KeyP => VK_P,
        Code::KeyQ => VK_Q,
        Code::KeyR => VK_R,
        Code::KeyS => VK_S,
        Code::KeyT => VK_T,
        Code::KeyU => VK_U,
        Code::KeyV => VK_V,
        Code::KeyW => VK_W,
        Code::KeyX => VK_X,
        Code::KeyY => VK_Y,
        Code::KeyZ => VK_Z,
        Code::Digit0 => VK_0,
        Code::Digit1 => VK_1,
        Code::Digit2 => VK_2,
        Code::Digit3 => VK_3,
        Code::Digit4 => VK_4,
        Code::Digit5 => VK_5,
        Code::Digit6 => VK_6,
        Code::Digit7 => VK_7,
        Code::Digit8 => VK_8,
        Code::Digit9 => VK_9,
        Code::Equal => VK_OEM_PLUS,
        Code::Comma => VK_OEM_COMMA,
        Code::Minus => VK_OEM_MINUS,
        Code::Period => VK_OEM_PERIOD,
        Code::Semicolon => VK_OEM_1,
        Code::Slash => VK_OEM_2,
        Code::Backquote => VK_OEM_3,
        Code::BracketLeft => VK_OEM_4,
        Code::Backslash => VK_OEM_5,
        Code::BracketRight => VK_OEM_6,
        Code::Quote => VK_OEM_7,
        Code::Backspace => VK_BACK,
        Code::Tab => VK_TAB,
        Code::Space => VK_SPACE,
        Code::Enter | Code::NumpadEnter => VK_RETURN,
        Code::CapsLock => VK_CAPITAL,
        Code::Escape => VK_ESCAPE,
        Code::PageUp => VK_PRIOR,
        Code::PageDown => VK_NEXT,
        Code::End => VK_END,
        Code::Home => VK_HOME,
        Code::ArrowLeft => VK_LEFT,
        Code::ArrowUp => VK_UP,
        Code::ArrowRight => VK_RIGHT,
        Code::ArrowDown => VK_DOWN,
        Code::PrintScreen => VK_SNAPSHOT,
        Code::Insert => VK_INSERT,
        Code::Delete => VK_DELETE,
        Code::F1 => VK_F1,
        Code::F2 => VK_F2,
        Code::F3 => VK_F3,
        Code::F4 => VK_F4,
        Code::F5 => VK_F5,
        Code::F6 => VK_F6,
        Code::F7 => VK_F7,
        Code::F8 => VK_F8,
        Code::F9 => VK_F9,
        Code::F10 => VK_F10,
        Code::F11 => VK_F11,
        Code::F12 => VK_F12,
        Code::F13 => VK_F13,
        Code::F14 => VK_F14,
        Code::F15 => VK_F15,
        Code::F16 => VK_F16,
        Code::F17 => VK_F17,
        Code::F18 => VK_F18,
        Code::F19 => VK_F19,
        Code::F20 => VK_F20,
        Code::F21 => VK_F21,
        Code::F22 => VK_F22,
        Code::F23 => VK_F23,
        Code::F24 => VK_F24,
        Code::NumLock => VK_NUMLOCK,
        Code::Numpad0 => VK_NUMPAD0,
        Code::Numpad1 => VK_NUMPAD1,
        Code::Numpad2 => VK_NUMPAD2,
        Code::Numpad3 => VK_NUMPAD3,
        Code::Numpad4 => VK_NUMPAD4,
        Code::Numpad5 => VK_NUMPAD5,
        Code::Numpad6 => VK_NUMPAD6,
        Code::Numpad7 => VK_NUMPAD7,
        Code::Numpad8 => VK_NUMPAD8,
        Code::Numpad9 => VK_NUMPAD9,
        Code::NumpadAdd => VK_ADD,
        Code::NumpadDecimal => VK_DECIMAL,
        Code::NumpadDivide => VK_DIVIDE,
        Code::NumpadMultiply => VK_MULTIPLY,
        Code::NumpadSubtract => VK_SUBTRACT,
        Code::ScrollLock => VK_SCROLL,
        Code::AudioVolumeDown => VK_VOLUME_DOWN,
        Code::AudioVolumeUp => VK_VOLUME_UP,
        Code::AudioVolumeMute => VK_VOLUME_MUTE,
        Code::MediaPlay => VK_PLAY,
        Code::MediaPause | Code::Pause => VK_PAUSE,
        Code::MediaPlayPause => VK_MEDIA_PLAY_PAUSE,
        Code::MediaStop => VK_MEDIA_STOP,
        Code::MediaTrackNext => VK_MEDIA_NEXT_TRACK,
        Code::MediaTrackPrevious => VK_MEDIA_PREV_TRACK,
        _ => return None,
    };
    Some(vk.0)
}

// ---------------------------------------------------------------------------
// Packed binding + edge detection (what the hook procedure runs)
// ---------------------------------------------------------------------------

/// Set in every packed binding, so 0 means "no binding".
const PRESENT: u64 = 1 << 32;
/// Marks a mouse trigger in the packed trigger bits.
const MOUSE_FLAG: u64 = 1 << 24;
/// The trigger part of a packed binding (key code, or mouse flag + button).
const TRIGGER_MASK: u64 = MOUSE_FLAG | 0xFFFF;

const fn trigger_bits(trigger: Trigger) -> u64 {
    match trigger {
        Trigger::Key(vk) => vk as u64,
        Trigger::Mouse(MouseButton::Middle) => MOUSE_FLAG | 3,
        Trigger::Mouse(MouseButton::X1) => MOUSE_FLAG | 4,
        Trigger::Mouse(MouseButton::X2) => MOUSE_FLAG | 5,
    }
}

impl MuteBinding {
    /// Pack into the `u64` the hook procedure loads atomically (never 0).
    pub const fn pack(self) -> u64 {
        PRESENT | (self.mods as u64) << 16 | trigger_bits(self.trigger)
    }

    fn kind(self) -> HookKind {
        match self.trigger {
            Trigger::Key(_) => HookKind::Keyboard,
            Trigger::Mouse(_) => HookKind::Mouse,
        }
    }
}

/// Edge detection for one binding: fires once per physical press.
#[derive(Clone, Copy, Debug, Default)]
pub struct EdgeDetector {
    /// The bound key or button went down and hasn't come up (as far as this
    /// detector saw); the fallback when the key's own state is unknown.
    held: bool,
    /// The packed binding `held` belongs to; a new binding starts released.
    binding: u64,
}

impl EdgeDetector {
    pub const fn new() -> EdgeDetector {
        EdgeDetector {
            held: false,
            binding: 0,
        }
    }

    /// Feed one input event against the packed `binding` (0 = none). Returns
    /// true when the mute should toggle: the bound key or button went down as
    /// a fresh press (not an auto-repeat), and for a combo exactly its
    /// modifiers are held. A bare key or mouse button fires whatever
    /// modifiers are held.
    ///
    /// Fresh or repeat, for a keyboard key: `key_was_down` gives the key's own
    /// state from before this event (the hook reads its async state, which
    /// doesn't include the event yet), so a lost key-up can't swallow the next
    /// press and a key held through a rebind doesn't fire on auto-repeat.
    /// `None` (unknown) falls back to the tracked `held`. A press with the
    /// wrong modifiers is spent too: adding them during auto-repeat doesn't
    /// fire it late. Mouse buttons never auto-repeat: every button-down is a
    /// fresh press, and neither `key_was_down` nor `held` is used for them.
    /// `key_was_down` is called only for a down of a bound key, `held_mods`
    /// only for a fresh press of a combo. Never allocates, locks or panics.
    pub fn on_input(
        &mut self,
        binding: u64,
        trigger: Trigger,
        down: bool,
        key_was_down: impl FnOnce() -> Option<bool>,
        held_mods: impl FnOnce() -> u8,
    ) -> bool {
        if binding != self.binding {
            self.binding = binding;
            self.held = false;
        }
        if binding & PRESENT == 0 || binding & TRIGGER_MASK != trigger_bits(trigger) {
            return false;
        }
        if !down {
            self.held = false;
            return false;
        }
        if let Trigger::Key(_) = trigger {
            let repeat = key_was_down().unwrap_or(self.held);
            self.held = true;
            if repeat {
                return false;
            }
        }
        let want = (binding >> 16) as u8;
        want == 0 || held_mods() == want
    }
}

/// A keyboard hook message as `(trigger, down)`; `None` for anything else.
impl EdgeDetector {
    /// `on_input` plus release tracking, for hold semantics (push-to-talk):
    /// `Some(true)` on a fresh press of the binding, `Some(false)` when the
    /// bound key or button goes up, `None` for everything else (auto-repeat,
    /// other keys, a combo with the wrong modifiers). A down of a key that
    /// was already physically down before we saw it (held at startup, after
    /// a restart) is a repeat, so it never reports `Some(true)`: the state
    /// stays released until a fresh press. A lost key-up self-heals the same
    /// way: the next real press is fresh and reports `Some(true)` again.
    pub fn on_input_held(
        &mut self,
        binding: u64,
        trigger: Trigger,
        down: bool,
        key_was_down: impl FnOnce() -> Option<bool>,
        held_mods: impl FnOnce() -> u8,
    ) -> Option<bool> {
        let fired = self.on_input(binding, trigger, down, key_was_down, held_mods);
        if fired {
            Some(true)
        } else if !down && binding & PRESENT != 0 && binding & TRIGGER_MASK == trigger_bits(trigger)
        {
            Some(false)
        } else {
            None
        }
    }
}

fn key_event(msg: u32, vk: u32) -> Option<(Trigger, bool)> {
    let down = match msg {
        WM_KEYDOWN | WM_SYSKEYDOWN => true,
        WM_KEYUP | WM_SYSKEYUP => false,
        _ => return None,
    };
    Some((Trigger::Key(vk as u16), down))
}

/// A mouse hook message as `(trigger, down)`; `None` for moves, wheel, the
/// left/right buttons and anything else.
fn mouse_event(msg: u32, mouse_data: u32) -> Option<(Trigger, bool)> {
    let (button, down) = match msg {
        WM_MBUTTONDOWN => (MouseButton::Middle, true),
        WM_MBUTTONUP => (MouseButton::Middle, false),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let button = match (mouse_data >> 16) as u16 {
                XBUTTON1 => MouseButton::X1,
                XBUTTON2 => MouseButton::X2,
                _ => return None,
            };
            (button, msg == WM_XBUTTONDOWN)
        }
        _ => return None,
    };
    Some((Trigger::Mouse(button), down))
}

/// Whether key `vk` is down. Inside a low-level keyboard hook the async state
/// is documented to still be the one from before the event being processed:
/// a fresh press reads up, an auto-repeat reads down.
fn async_down(vk: u16) -> bool {
    // SAFETY: GetAsyncKeyState only reads the key state.
    unsafe { km::GetAsyncKeyState(i32::from(vk)) < 0 }
}

/// The modifiers held right now (the main key's own event isn't in the
/// async state yet, see `async_down`).
fn held_mods() -> u8 {
    let mut mods = 0;
    if async_down(km::VK_CONTROL.0) {
        mods |= MOD_CTRL;
    }
    if async_down(km::VK_MENU.0) {
        mods |= MOD_ALT;
    }
    if async_down(km::VK_SHIFT.0) {
        mods |= MOD_SHIFT;
    }
    if async_down(km::VK_LWIN.0) || async_down(km::VK_RWIN.0) {
        mods |= MOD_WIN;
    }
    mods
}

// ---------------------------------------------------------------------------
// Hook thread
// ---------------------------------------------------------------------------

/// What `MuteHook` shares with its hook thread.
struct Shared {
    /// The packed binding (0 = none): stored by `MuteHook::set`, loaded by
    /// the hook procedure on every event.
    binding: AtomicU64,
    /// Presses the controller hasn't taken yet.
    presses: AtomicU32,
    /// The bound key or button is physically down (set on a fresh press,
    /// cleared on its release). Written by the hook proc (and reset by the
    /// owner on rebind); a plain atomic store, lock-free.
    held: Arc<AtomicBool>,
}

/// The hook procedure's state, in the hook thread's TLS.
struct HookCtx {
    shared: Arc<Shared>,
    detector: EdgeDetector,
    /// Soundboard mouse bindings (only the `MouseSoundHook` thread has any).
    slots: Option<Arc<SoundSlots>>,
}

impl HookCtx {
    fn observe(
        &mut self,
        trigger: Trigger,
        down: bool,
        key_was_down: impl FnOnce() -> Option<bool>,
        held_mods: impl FnOnce() -> u8,
    ) {
        let binding = self.shared.binding.load(Ordering::Relaxed);
        match self
            .detector
            .on_input_held(binding, trigger, down, key_was_down, held_mods)
        {
            Some(true) => {
                self.shared.presses.fetch_add(1, Ordering::Relaxed);
                self.shared.held.store(true, Ordering::Relaxed);
            }
            Some(false) => self.shared.held.store(false, Ordering::Relaxed),
            None => {}
        }
    }

    /// Count a press for every soundboard slot the event fires. Lock-free and
    /// allocation-free: a fixed array of atomics.
    fn observe_sound(&self, trigger: Trigger, down: bool, held_mods: impl Fn() -> u8) {
        let Some(slots) = &self.slots else {
            return;
        };
        for (binding, presses) in slots.bindings.iter().zip(slots.presses.iter()) {
            if sound_fires(binding.load(Ordering::Relaxed), trigger, down, &held_mods) {
                presses.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// Whether one soundboard mouse binding fires on this event: a button-down of
/// its button, with exactly its modifiers held (a bare binding fires whatever
/// is held). Mouse buttons never auto-repeat, so no edge state is needed.
fn sound_fires(binding: u64, trigger: Trigger, down: bool, held_mods: impl FnOnce() -> u8) -> bool {
    if !down || binding & PRESENT == 0 || binding & TRIGGER_MASK != trigger_bits(trigger) {
        return false;
    }
    let want = (binding >> 16) as u8;
    want == 0 || held_mods() == want
}

/// Most soundboard mouse bindings the hook serves at once.
pub const MAX_MOUSE_SOUND_BINDINGS: usize = 16;

/// The soundboard mouse bindings (packed, 0 = free slot) and the presses each
/// has collected; written by `MouseSoundHook`, read by the hook procedure.
struct SoundSlots {
    bindings: [AtomicU64; MAX_MOUSE_SOUND_BINDINGS],
    presses: [AtomicU32; MAX_MOUSE_SOUND_BINDINGS],
}

impl SoundSlots {
    fn new() -> SoundSlots {
        SoundSlots {
            bindings: std::array::from_fn(|_| AtomicU64::new(0)),
            presses: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }
}

thread_local! {
    /// Set on the hook thread for as long as its message loop runs.
    static HOOK_CTX: RefCell<Option<HookCtx>> = const { RefCell::new(None) };
}

fn set_hook_ctx(ctx: Option<HookCtx>) {
    let _ = HOOK_CTX.try_with(|cell| {
        if let Ok(mut slot) = cell.try_borrow_mut() {
            *slot = ctx;
        }
    });
}

/// The hook procedures' body: feed one event to this thread's `HookCtx`.
/// Panic-free (`try_with` / `try_borrow_mut`), no allocation.
fn observe(trigger: Trigger, down: bool) {
    let _ = HOOK_CTX.try_with(|cell| {
        if let Ok(mut slot) = cell.try_borrow_mut() {
            if let Some(ctx) = slot.as_mut() {
                // A key's own state tells a fresh press from auto-repeat;
                // mouse buttons don't repeat, so theirs is never needed.
                let key_was_down = || match trigger {
                    Trigger::Key(vk) => Some(async_down(vk)),
                    Trigger::Mouse(_) => None,
                };
                ctx.observe(trigger, down, key_was_down, held_mods);
                ctx.observe_sound(trigger, down, held_mods);
            }
        }
    });
}

extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        // SAFETY: for HC_ACTION, lparam points to a KBDLLHOOKSTRUCT.
        let vk = unsafe { (*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode };
        if let Some((trigger, down)) = key_event(wparam.0 as u32, vk) {
            observe(trigger, down);
        }
    }
    // Always pass the event on: the focused app (the game) gets the key too.
    // SAFETY: forwarding this hook call's own arguments.
    unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
}

extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam.0 != 0 {
        let msg = wparam.0 as u32;
        // Moves and wheel (most events) leave without touching lparam.
        if matches!(
            msg,
            WM_MBUTTONDOWN | WM_MBUTTONUP | WM_XBUTTONDOWN | WM_XBUTTONUP
        ) {
            // SAFETY: for HC_ACTION, lparam points to an MSLLHOOKSTRUCT.
            let data = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).mouseData };
            if let Some((trigger, down)) = mouse_event(msg, data) {
                observe(trigger, down);
            }
        }
    }
    // SAFETY: forwarding this hook call's own arguments.
    unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
}

/// Which hook a binding needs. Only that one is installed: a mouse hook
/// costs every mouse move a hop through this thread, so a key binding
/// doesn't take one (and vice versa).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HookKind {
    Keyboard,
    Mouse,
}

/// Posted to the hook thread to end its message loop.
const WM_STOP_HOOK: u32 = WM_APP + 1;
const STOP_POST_TRIES: u32 = 50;
const STOP_POST_RETRY: Duration = Duration::from_millis(10);

struct HookThread {
    tid: u32,
    kind: HookKind,
    handle: JoinHandle<()>,
}

impl HookThread {
    /// Start the hook thread and wait until its hook is installed (or
    /// failed: `Err` with a message, and the thread has exited). With
    /// `install` false the thread runs its message loop without a hook
    /// (unit tests).
    fn start(
        kind: HookKind,
        shared: Arc<Shared>,
        slots: Option<Arc<SoundSlots>>,
        install: bool,
    ) -> Result<HookThread, String> {
        let (ready_tx, ready_rx) = sync_channel(1);
        let handle = std::thread::Builder::new()
            .name("o2i-mute-hook".into())
            .spawn(move || run(kind, shared, slots, install, ready_tx))
            .map_err(|e| format!("couldn't start the mute hotkey thread: {e}"))?;
        // The thread always answers (or drops the sender by ending).
        match ready_rx.recv() {
            Ok(Ok(tid)) => Ok(HookThread { tid, kind, handle }),
            Ok(Err(message)) => {
                let _ = handle.join();
                Err(message)
            }
            Err(_) => {
                let _ = handle.join();
                Err("the mute hotkey thread ended early".into())
            }
        }
    }

    /// End the message loop and join; the thread unhooks on its way out.
    fn stop(self) {
        for _ in 0..STOP_POST_TRIES {
            if self.handle.is_finished() {
                break;
            }
            // SAFETY: posts a message to a thread this module started.
            if unsafe { PostThreadMessageW(self.tid, WM_STOP_HOOK, WPARAM(0), LPARAM(0)) }.is_ok() {
                let _ = self.handle.join();
                return;
            }
            std::thread::sleep(STOP_POST_RETRY);
        }
        if self.handle.is_finished() {
            let _ = self.handle.join();
        } else {
            elog!("[llhooks] couldn't reach the mute hotkey thread to stop it");
        }
    }
}

/// Body of the hook thread: install the hook, report, pump messages until
/// `WM_STOP_HOOK`, unhook. Never panics.
fn run(
    kind: HookKind,
    shared: Arc<Shared>,
    slots: Option<Arc<SoundSlots>>,
    install: bool,
    ready: SyncSender<Result<u32, String>>,
) {
    let mut msg = MSG::default();
    // SAFETY: plain Win32 calls on this thread's own queue and handle.
    let tid = unsafe {
        // Create this thread's message queue before anyone posts to it.
        let _ = PeekMessageW(&mut msg, HWND::default(), WM_USER, WM_USER, PM_NOREMOVE);
        // Every key or mouse event on the machine waits for the hook to
        // return, so a busy game must not starve this (almost always idle)
        // thread; Windows also drops hooks that answer too slowly.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        GetCurrentThreadId()
    };
    set_hook_ctx(Some(HookCtx {
        shared,
        detector: EdgeDetector::new(),
        slots,
    }));
    let hook = if install {
        match install_hook(kind) {
            Ok(h) => Some(h),
            Err(message) => {
                set_hook_ctx(None);
                let _ = ready.send(Err(message));
                return;
            }
        }
    } else {
        None
    };
    let _ = ready.send(Ok(tid));
    drop(ready);

    loop {
        // SAFETY: `msg` is a valid out-parameter.
        let r = unsafe { GetMessageW(&mut msg, HWND::default(), 0, 0) };
        // 0 = WM_QUIT, -1 = error: either way, stop. The hook procedures run
        // inside this call.
        if r.0 == 0 || r.0 == -1 || msg.message == WM_STOP_HOOK {
            break;
        }
    }

    if let Some(h) = hook {
        // SAFETY: `h` was installed by this thread and not removed yet.
        if let Err(e) = unsafe { UnhookWindowsHookEx(h) } {
            elog!("[llhooks] removing the mute hotkey hook failed: {e}");
        }
    }
    set_hook_ctx(None);
}

fn install_hook(kind: HookKind) -> Result<HHOOK, String> {
    let fail = |e: windows::core::Error| format!("couldn't install the input hook: {e}");
    let (id, proc_): (WINDOWS_HOOK_ID, HOOKPROC) = match kind {
        HookKind::Keyboard => (WH_KEYBOARD_LL, Some(keyboard_proc)),
        HookKind::Mouse => (WH_MOUSE_LL, Some(mouse_proc)),
    };
    // SAFETY: the procedures are plain functions of this module, the module
    // handle is this exe's own, and 0 = a global (low-level) hook.
    unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).map_err(fail)?;
        SetWindowsHookExW(id, proc_, HINSTANCE::from(module), 0).map_err(fail)
    }
}

// ---------------------------------------------------------------------------
// MuteHook: what the controller owns
// ---------------------------------------------------------------------------

/// The mute hotkey: owns the hook thread, which runs only while a valid spec
/// is bound.
pub struct MuteHook {
    shared: Arc<Shared>,
    thread: Option<HookThread>,
    /// `(spec, message)` while the configured spec can't be used.
    error: Option<(String, String)>,
    /// False in unit tests: the thread runs its loop without installing a
    /// real hook.
    install: bool,
}

/// The main key or button of a packed binding (`None` = no binding).
fn unpack_trigger(binding: u64) -> Option<Trigger> {
    if binding & PRESENT == 0 {
        return None;
    }
    let t = binding & TRIGGER_MASK;
    Some(match t {
        x if x == MOUSE_FLAG | 3 => Trigger::Mouse(MouseButton::Middle),
        x if x == MOUSE_FLAG | 4 => Trigger::Mouse(MouseButton::X1),
        x if x == MOUSE_FLAG | 5 => Trigger::Mouse(MouseButton::X2),
        x if x & MOUSE_FLAG != 0 => return None,
        x => Trigger::Key(x as u16),
    })
}

/// Whether the key or button is physically down right now.
pub fn physically_down(trigger: Trigger) -> bool {
    let vk = match trigger {
        Trigger::Key(vk) => vk,
        Trigger::Mouse(MouseButton::Middle) => km::VK_MBUTTON.0,
        Trigger::Mouse(MouseButton::X1) => km::VK_XBUTTON1.0,
        Trigger::Mouse(MouseButton::X2) => km::VK_XBUTTON2.0,
    };
    async_down(vk)
}

impl MuteHook {
    pub fn new() -> MuteHook {
        MuteHook::with_held(Arc::new(AtomicBool::new(false)))
    }

    /// A hook that publishes "the bound key is down" into `held` (the PTT
    /// flag in `MicParams`).
    pub fn with_held(held: Arc<AtomicBool>) -> MuteHook {
        MuteHook {
            shared: Arc::new(Shared {
                binding: AtomicU64::new(0),
                presses: AtomicU32::new(0),
                held,
            }),
            thread: None,
            error: None,
            install: !cfg!(test),
        }
    }

    /// Bind `spec`; `None` or blank means no mute hotkey. A valid spec starts
    /// the hook thread, or only swaps the binding when the right hook already
    /// runs; clearing it (or an unusable spec) stops the thread. Returns
    /// `(spec, message)` when the spec can't be used (it doesn't parse, or the
    /// hook couldn't be installed); `error()` lists it until the next `set`.
    pub fn set(&mut self, spec: Option<&str>) -> Option<(String, String)> {
        self.error = None;
        let Some(spec) = spec.filter(|s| !s.trim().is_empty()) else {
            self.disable();
            return None;
        };
        match parse_mute_spec(spec) {
            Err(message) => {
                self.disable();
                self.error = Some((spec.to_string(), message));
            }
            Ok(binding) => {
                let kind = binding.kind();
                self.clear_held();
                self.shared.binding.store(binding.pack(), Ordering::Relaxed);
                // A thread that ended on its own (its message loop failed)
                // has no hook any more: start a fresh one.
                if self.thread.as_ref().is_some_and(|t| t.handle.is_finished()) {
                    self.stop_thread();
                }
                if self.thread.as_ref().map(|t| t.kind) != Some(kind) {
                    self.stop_thread();
                    match HookThread::start(kind, self.shared.clone(), None, self.install) {
                        Ok(t) => self.thread = Some(t),
                        Err(message) => {
                            self.shared.binding.store(0, Ordering::Relaxed);
                            self.error = Some((spec.to_string(), message));
                        }
                    }
                }
            }
        }
        self.error.clone()
    }

    /// Up to `max` of the presses not taken yet; each one toggles the mute.
    /// Presses beyond `max` stay counted for the next call, so none is lost
    /// and the final mute state always matches the number of presses.
    pub fn take_presses(&self, max: u32) -> u32 {
        let pending = self
            .shared
            .presses
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(max))
            })
            .unwrap_or_else(|n| n);
        pending.min(max)
    }

    /// `(spec, message)` while the configured spec can't be used.
    pub fn error(&self) -> Option<&(String, String)> {
        self.error.as_ref()
    }

    /// Safety net for a key-up the hook never saw (released while an elevated
    /// window had focus, secure desktop, hook timeout). While the flag says
    /// held, ask `probe` whether the bound key or button is physically down;
    /// returns true when the flag is held and the probe says up. The caller
    /// decides when to clear (see `clear_held`). Runs off the hook thread.
    pub fn held_but_physically_up(&self, probe: impl FnOnce(Trigger) -> bool) -> bool {
        if !self.shared.held.load(Ordering::Relaxed) {
            return false;
        }
        match unpack_trigger(self.shared.binding.load(Ordering::Relaxed)) {
            Some(t) => !probe(t),
            None => false,
        }
    }

    /// Forget a held key: the flag reads released until the next fresh press
    /// (a key still physically down only auto-repeats, which doesn't count).
    pub fn clear_held(&self) {
        self.shared.held.store(false, Ordering::Relaxed);
    }

    fn disable(&mut self) {
        self.shared.binding.store(0, Ordering::Relaxed);
        self.stop_thread();
        self.shared.presses.store(0, Ordering::Relaxed);
        self.clear_held();
    }

    fn stop_thread(&mut self) {
        if let Some(t) = self.thread.take() {
            t.stop();
        }
    }
}

impl Drop for MuteHook {
    fn drop(&mut self) {
        self.disable();
    }
}

/// The soundboard hotkeys that use a mouse button: one `WH_MOUSE_LL` hook
/// thread (same pass-through and press rules as the mute key) serving up to
/// `MAX_MOUSE_SOUND_BINDINGS` bindings. The thread runs only while at least
/// one binding is set. Presses are counted per slot in atomics and drained by
/// the controller's tick.
pub struct MouseSoundHook {
    /// Unused by the procedure here (its mute binding stays 0).
    shared: Arc<Shared>,
    slots: Arc<SoundSlots>,
    thread: Option<HookThread>,
    install: bool,
}

impl MouseSoundHook {
    pub fn new() -> MouseSoundHook {
        MouseSoundHook {
            shared: Arc::new(Shared {
                binding: AtomicU64::new(0),
                presses: AtomicU32::new(0),
                held: Arc::new(AtomicBool::new(false)),
            }),
            slots: Arc::new(SoundSlots::new()),
            thread: None,
            install: !cfg!(test),
        }
    }

    /// Replace the bindings (slot `i` = `bindings[i]`; extra ones beyond the
    /// maximum are ignored, callers check the count). An empty list stops the
    /// thread. `Err` when the hook couldn't be installed; no binding is active
    /// then.
    pub fn set(&mut self, bindings: &[MuteBinding]) -> Result<(), String> {
        for (i, slot) in self.slots.bindings.iter().enumerate() {
            let packed = bindings.get(i).map_or(0, |b| b.pack());
            slot.store(packed, Ordering::Relaxed);
            self.slots.presses[i].store(0, Ordering::Relaxed);
        }
        if bindings.is_empty() {
            self.stop_thread();
            return Ok(());
        }
        if self.thread.as_ref().is_some_and(|t| t.handle.is_finished()) {
            self.stop_thread();
        }
        if self.thread.is_none() {
            match HookThread::start(
                HookKind::Mouse,
                self.shared.clone(),
                Some(self.slots.clone()),
                self.install,
            ) {
                Ok(t) => self.thread = Some(t),
                Err(message) => {
                    self.clear_slots();
                    return Err(message);
                }
            }
        }
        Ok(())
    }

    /// Take the presses collected per slot since the last call.
    pub fn take_presses(&self) -> [u32; MAX_MOUSE_SOUND_BINDINGS] {
        std::array::from_fn(|i| self.slots.presses[i].swap(0, Ordering::Relaxed))
    }

    fn clear_slots(&self) {
        for (b, p) in self.slots.bindings.iter().zip(self.slots.presses.iter()) {
            b.store(0, Ordering::Relaxed);
            p.store(0, Ordering::Relaxed);
        }
    }

    fn stop_thread(&mut self) {
        if let Some(t) = self.thread.take() {
            t.stop();
        }
    }
}

impl Drop for MouseSoundHook {
    fn drop(&mut self) {
        self.clear_slots();
        self.stop_thread();
    }
}

#[cfg(test)]
impl MouseSoundHook {
    pub(crate) fn running(&self) -> bool {
        self.thread.is_some()
    }

    /// Feed one injected mouse event through the same per-slot rule the hook
    /// procedure runs; counts a press for every slot that fires.
    pub(crate) fn simulate_event(&self, trigger: Trigger, down: bool, held_mods: u8) {
        let ctx = HookCtx {
            shared: self.shared.clone(),
            detector: EdgeDetector::new(),
            slots: Some(self.slots.clone()),
        };
        ctx.observe_sound(trigger, down, || held_mods);
    }
}

#[cfg(test)]
impl MuteHook {
    /// Which hook the thread runs (`None` = no thread).
    pub(crate) fn running(&self) -> Option<&'static str> {
        self.thread.as_ref().map(|t| match t.kind {
            HookKind::Keyboard => "keyboard",
            HookKind::Mouse => "mouse",
        })
    }

    /// What the hook procedure does for a press of the bound key.
    pub(crate) fn simulate_held(&self, held: bool) {
        self.shared.held.store(held, Ordering::Relaxed);
    }

    pub(crate) fn simulate_press(&self) {
        self.shared.presses.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_V: u16 = 0x56;

    /// The key's own state is unknown: the detector falls back to `held`.
    fn untracked() -> Option<bool> {
        None
    }
    const VK_M: u16 = 0x4D;

    fn key(vk: u16) -> MuteBinding {
        MuteBinding {
            trigger: Trigger::Key(vk),
            mods: 0,
        }
    }

    #[test]
    fn parse_mute_spec_bare_key() {
        assert_eq!(parse_mute_spec("V"), Ok(key(VK_V)));
        assert_eq!(parse_mute_spec("v"), Ok(key(VK_V)));
        assert_eq!(parse_mute_spec(" V "), Ok(key(VK_V)));
        // Same names as the soundboard accelerators.
        assert_eq!(parse_mute_spec("KeyV"), Ok(key(VK_V)));
        assert_eq!(parse_mute_spec("CapsLock"), Ok(key(0x14)));
        assert_eq!(parse_mute_spec("Space"), Ok(key(0x20)));
        assert_eq!(parse_mute_spec("F1"), Ok(key(0x70)));
        assert_eq!(parse_mute_spec("F24"), Ok(key(0x87)));
        assert_eq!(parse_mute_spec("5"), Ok(key(0x35)));
        assert_eq!(parse_mute_spec("Digit5"), Ok(key(0x35)));
        assert_eq!(parse_mute_spec("Num5"), Ok(key(0x65)));
        assert_eq!(parse_mute_spec("`"), Ok(key(0xC0)));
        assert_eq!(parse_mute_spec("Escape"), Ok(key(0x1B)));
    }

    #[test]
    fn parse_mute_spec_combo() {
        assert_eq!(
            parse_mute_spec("Ctrl+Shift+M"),
            Ok(MuteBinding {
                trigger: Trigger::Key(VK_M),
                mods: MOD_CTRL | MOD_SHIFT,
            })
        );
        // Order of modifiers, case and spaces don't matter.
        assert_eq!(
            parse_mute_spec("shift + ctrl + m"),
            parse_mute_spec("Ctrl+Shift+M")
        );
        assert_eq!(
            parse_mute_spec("Win+Alt+F5"),
            Ok(MuteBinding {
                trigger: Trigger::Key(0x74),
                mods: MOD_WIN | MOD_ALT,
            })
        );
        // The accelerators' aliases for the modifiers.
        assert_eq!(parse_mute_spec("Control+M"), parse_mute_spec("Ctrl+M"));
        assert_eq!(parse_mute_spec("Super+M"), parse_mute_spec("Win+M"));
    }

    #[test]
    fn parse_mute_spec_mouse() {
        let mouse = |b| MuteBinding {
            trigger: Trigger::Mouse(b),
            mods: 0,
        };
        assert_eq!(parse_mute_spec("Mouse4"), Ok(mouse(MouseButton::X1)));
        assert_eq!(parse_mute_spec("mouse3"), Ok(mouse(MouseButton::Middle)));
        assert_eq!(parse_mute_spec("Mouse5"), Ok(mouse(MouseButton::X2)));
        assert_eq!(
            parse_mute_spec("Ctrl+Mouse5"),
            Ok(MuteBinding {
                trigger: Trigger::Mouse(MouseButton::X2),
                mods: MOD_CTRL,
            })
        );
    }

    #[test]
    fn parse_mute_spec_rejects_garbage() {
        for bad in [
            "Ctrl+",
            "",
            "   ",
            "Mouse9",
            "Mouse1",
            "Mouse2",
            "+V",
            "Ctrl++V",
            "Ctrl",
            "Ctrl+Shift",
            "V+Ctrl",
            "Ctrl+V+B",
            "Hyper+V",
            "NotAKey!!!",
        ] {
            let err = parse_mute_spec(bad).expect_err(bad);
            assert!(
                err.contains(&format!("{bad:?}")),
                "{bad:?}: message should name the spec: {err}"
            );
        }
    }

    /// Run `events` (`(down, held_mods)`) for `trigger` against `spec`; count fires.
    fn fires(spec: &str, trigger: Trigger, events: &[(bool, u8)]) -> usize {
        let binding = parse_mute_spec(spec).expect(spec).pack();
        let mut d = EdgeDetector::new();
        events
            .iter()
            .filter(|(down, mods)| d.on_input(binding, trigger, *down, untracked, || *mods))
            .count()
    }

    #[test]
    fn edge_detector_fires_once_per_press() {
        // down, down (auto-repeat), up, down: two presses.
        let v = Trigger::Key(VK_V);
        assert_eq!(
            fires("V", v, &[(true, 0), (true, 0), (false, 0), (true, 0)]),
            2
        );
        // Many repeats are still one press.
        assert_eq!(fires("V", v, &[(true, 0); 10]), 1);
        // A stray key-up first changes nothing.
        assert_eq!(fires("V", v, &[(false, 0), (true, 0), (false, 0)]), 1);
        // Other keys and buttons never fire or disturb the state.
        let mut d = EdgeDetector::new();
        let b = parse_mute_spec("V").unwrap().pack();
        assert!(!d.on_input(b, Trigger::Key(VK_M), true, untracked, || 0));
        assert!(!d.on_input(b, Trigger::Mouse(MouseButton::X1), true, untracked, || 0));
        assert!(d.on_input(b, v, true, untracked, || 0));
        assert!(
            !d.on_input(b, Trigger::Key(VK_M), false, untracked, || 0),
            "M up doesn't re-arm V"
        );
        assert!(
            !d.on_input(b, v, true, untracked, || 0),
            "still a repeat of the same V press"
        );
        // Mouse buttons work the same way.
        let x1 = Trigger::Mouse(MouseButton::X1);
        assert_eq!(
            fires(
                "Mouse4",
                x1,
                &[(true, 0), (false, 0), (true, 0), (false, 0)]
            ),
            2
        );
        // No binding: nothing fires.
        let mut d = EdgeDetector::new();
        assert!(!d.on_input(0, v, true, untracked, || 0));
    }

    /// Fold a sequence of (down, key_was_down, mods) events into the held flag,
    /// the way the hook proc does. `key_was_down` of `None` = untracked.
    fn held_after(spec: &str, trigger: Trigger, events: &[(bool, Option<bool>, u8)]) -> bool {
        let binding = parse_mute_spec(spec).unwrap().pack();
        let mut d = EdgeDetector::new();
        let mut held = false;
        for &(down, was_down, mods) in events {
            match d.on_input_held(binding, trigger, down, || was_down, || mods) {
                Some(h) => held = h,
                None => {}
            }
        }
        held
    }

    #[test]
    fn ptt_opens_only_while_held() {
        let v = Trigger::Key(VK_V);
        // Fresh press (key was up before the event), repeats, release.
        assert!(held_after("V", v, &[(true, Some(false), 0)]));
        assert!(held_after(
            "V",
            v,
            &[
                (true, Some(false), 0),
                (true, Some(true), 0),
                (true, Some(true), 0)
            ]
        ));
        assert!(!held_after(
            "V",
            v,
            &[
                (true, Some(false), 0),
                (true, Some(true), 0),
                (false, Some(true), 0)
            ]
        ));
        // Nothing yet: released.
        assert!(!held_after("V", v, &[]));
        // Other keys and buttons never press or release it.
        let mut d = EdgeDetector::new();
        let b = parse_mute_spec("V").unwrap().pack();
        let m = Trigger::Key(VK_M);
        assert_eq!(d.on_input_held(b, m, true, || Some(false), || 0), None);
        assert_eq!(
            d.on_input_held(b, v, true, || Some(false), || 0),
            Some(true)
        );
        assert_eq!(d.on_input_held(b, m, false, || Some(true), || 0), None);
        assert_eq!(
            d.on_input_held(b, v, false, || Some(true), || 0),
            Some(false)
        );
        // No binding: nothing.
        assert_eq!(d.on_input_held(0, v, true, || Some(false), || 0), None);
        assert_eq!(d.on_input_held(0, v, false, || Some(true), || 0), None);
        // Mouse buttons: every down is a press, up releases.
        let x2 = Trigger::Mouse(MouseButton::X2);
        assert!(held_after("Mouse5", x2, &[(true, None, 0)]));
        assert!(!held_after(
            "Mouse5",
            x2,
            &[(true, None, 0), (false, None, 0)]
        ));
        // A bare key is held whatever modifiers are down; a combo needs them.
        assert!(held_after("V", v, &[(true, Some(false), MOD_SHIFT)]));
        assert!(!held_after("Ctrl+V", v, &[(true, Some(false), 0)]));
        assert!(held_after("Ctrl+V", v, &[(true, Some(false), MOD_CTRL)]));
        // Ctrl released first: the combo stays held until V itself is up.
        assert!(held_after(
            "Ctrl+V",
            v,
            &[(true, Some(false), MOD_CTRL), (true, Some(true), 0)]
        ));
    }

    #[test]
    fn ptt_key_already_down_is_not_held_until_fresh_press() {
        // Held when the engine started: only auto-repeats arrive.
        let v = Trigger::Key(VK_V);
        assert!(!held_after(
            "V",
            v,
            &[(true, Some(true), 0), (true, Some(true), 0)]
        ));
        // Released and pressed again: now held.
        assert!(held_after(
            "V",
            v,
            &[
                (true, Some(true), 0),
                (false, Some(true), 0),
                (true, Some(false), 0)
            ]
        ));
    }

    #[test]
    fn ptt_lost_keyup_then_down_works() {
        // The key-up was swallowed (secure desktop, hook timeout): the flag is
        // stuck held. The next real press sees the key as up and is fresh,
        // so the cycle continues normally.
        let v = Trigger::Key(VK_V);
        let binding = parse_mute_spec("V").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert_eq!(
            d.on_input_held(binding, v, true, || Some(false), || 0),
            Some(true)
        );
        // (key-up lost) next press:
        assert_eq!(
            d.on_input_held(binding, v, true, || Some(false), || 0),
            Some(true)
        );
        assert_eq!(
            d.on_input_held(binding, v, false, || Some(true), || 0),
            Some(false)
        );
        // Also when async state is unavailable: the old held state would make
        // it a repeat, so the key-up is what recovers. Rebinding resets.
        let other = parse_mute_spec("F8").unwrap().pack();
        assert_eq!(
            d.on_input_held(other, Trigger::Key(0x77), true, || None, || 0),
            Some(true)
        );
    }

    #[test]
    fn combo_requires_modifiers_held() {
        let m = Trigger::Key(VK_M);
        let both = MOD_CTRL | MOD_SHIFT;
        assert_eq!(fires("Ctrl+Shift+M", m, &[(true, 0), (false, 0)]), 0);
        assert_eq!(
            fires("Ctrl+Shift+M", m, &[(true, MOD_CTRL), (false, MOD_CTRL)]),
            0
        );
        assert_eq!(fires("Ctrl+Shift+M", m, &[(true, both), (false, both)]), 1);
        // A combo matches exactly: an extra modifier doesn't fire.
        assert_eq!(fires("Ctrl+M", m, &[(true, both)]), 0);
        assert_eq!(fires("Ctrl+M", m, &[(true, MOD_CTRL | MOD_ALT)]), 0);
        assert_eq!(fires("Ctrl+M", m, &[(true, MOD_CTRL | MOD_WIN)]), 0);
        assert_eq!(
            fires(
                "Shift+Mouse4",
                Trigger::Mouse(MouseButton::X1),
                &[(true, both)]
            ),
            0
        );
        // A press with the wrong modifiers is spent: adding them during
        // auto-repeat doesn't fire it late.
        assert_eq!(
            fires(
                "Ctrl+Shift+M",
                m,
                &[(true, MOD_CTRL), (true, both), (false, both)]
            ),
            0
        );
        // The modifiers are only read for a fresh press of the main key.
        let b = parse_mute_spec("Ctrl+M").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert!(
            !d.on_input(b, Trigger::Key(VK_V), true, untracked, || panic!(
                "read for another key"
            ))
        );
        assert!(d.on_input(b, m, true, untracked, || MOD_CTRL));
        assert!(!d.on_input(b, m, true, untracked, || panic!("read for a repeat")));
        assert!(!d.on_input(b, m, false, untracked, || panic!("read for a key-up")));
    }

    #[test]
    fn bare_key_fires_whatever_modifiers_are_held() {
        // A bare key or mouse button ignores held modifiers (sprint,
        // crouch, ... in a game), so it fires with any of them held.
        let m = Trigger::Key(VK_M);
        let x1 = Trigger::Mouse(MouseButton::X1);
        for mods in [
            0,
            MOD_SHIFT,
            MOD_CTRL,
            MOD_ALT,
            MOD_WIN,
            MOD_CTRL | MOD_SHIFT,
        ] {
            assert_eq!(
                fires("M", m, &[(true, mods), (false, mods)]),
                1,
                "M, mods {mods}"
            );
            assert_eq!(
                fires("Mouse4", x1, &[(true, mods), (false, mods)]),
                1,
                "Mouse4, mods {mods}"
            );
        }
        // A bare press never reads the modifiers; a key repeat is still one press.
        let b = parse_mute_spec("Mouse4").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert!(d.on_input(b, x1, true, untracked, || panic!("bare press read mods")));
        let b = parse_mute_spec("M").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert!(d.on_input(b, m, true, untracked, || panic!("bare press read mods")));
        assert!(!d.on_input(b, m, true, untracked, || panic!("read for a repeat")));
    }

    #[test]
    fn mouse_button_downs_are_always_fresh_presses() {
        // Mouse buttons never auto-repeat, so every button-down is
        // a press, and the button's own state is never consulted.
        let unread = || -> Option<bool> { panic!("mouse button state read") };
        for (spec, button) in [
            ("Mouse3", MouseButton::Middle),
            ("Mouse4", MouseButton::X1),
            ("Mouse5", MouseButton::X2),
        ] {
            let t = Trigger::Mouse(button);
            let b = parse_mute_spec(spec).unwrap().pack();
            let mut d = EdgeDetector::new();
            assert!(d.on_input(b, t, true, unread, || 0), "{spec}");
            // The up was lost (released over an admin window): still a press.
            assert!(
                d.on_input(b, t, true, unread, || 0),
                "{spec} after a lost up"
            );
            assert!(!d.on_input(b, t, false, unread, || 0));
            assert!(d.on_input(b, t, true, unread, || 0), "{spec} again");
        }
        // Down twice is two presses; a combo still needs its modifiers.
        let x1 = Trigger::Mouse(MouseButton::X1);
        assert_eq!(fires("Mouse4", x1, &[(true, 0), (true, 0)]), 2);
        assert_eq!(
            fires("Ctrl+Mouse4", x1, &[(true, 0), (true, MOD_CTRL)]),
            1,
            "a press with the wrong modifiers doesn't spend the next one"
        );
    }

    #[test]
    fn edge_detector_uses_the_keys_own_state_when_known() {
        let v = Trigger::Key(VK_V);
        let b = parse_mute_spec("V").unwrap().pack();
        let was = |state: bool| move || Some(state);

        // The key's own state from before the event decides fresh vs repeat.
        let mut d = EdgeDetector::new();
        assert!(d.on_input(b, v, true, was(false), || 0));
        assert!(!d.on_input(b, v, true, was(true), || 0), "auto-repeat");
        // The key-up was lost (secure desktop, released over an admin
        // window): the key reads up again, so the next press still fires.
        assert!(
            d.on_input(b, v, true, was(false), || 0),
            "press after a lost key-up"
        );

        // A key still held when the binding changes (or a new hook thread
        // starts) doesn't fire on its next auto-repeat.
        let ctrl_v = parse_mute_spec("Ctrl+V").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert!(!d.on_input(ctrl_v, v, true, was(true), || MOD_CTRL));
        assert!(!d.on_input(ctrl_v, v, false, was(true), || MOD_CTRL));
        assert!(d.on_input(ctrl_v, v, true, was(false), || MOD_CTRL));

        // Only read for a down of the bound key.
        let mut d = EdgeDetector::new();
        let unread = || -> Option<bool> { panic!("key state read") };
        assert!(!d.on_input(b, Trigger::Key(VK_M), true, unread, || 0));
        assert!(!d.on_input(b, v, false, unread, || 0));
        assert!(!d.on_input(0, v, true, unread, || 0));
    }

    #[test]
    fn take_presses_leaves_the_rest_for_later() {
        let h = MuteHook::new();
        for _ in 0..21 {
            h.simulate_press();
        }
        assert_eq!(h.take_presses(16), 16);
        assert_eq!(h.take_presses(16), 5, "the rest comes next time, none lost");
        assert_eq!(h.take_presses(16), 0);
    }

    #[test]
    fn edge_detector_resets_when_the_binding_changes() {
        let v = Trigger::Key(VK_V);
        let plain = parse_mute_spec("V").unwrap().pack();
        let ctrl = parse_mute_spec("Ctrl+V").unwrap().pack();
        let mut d = EdgeDetector::new();
        assert!(d.on_input(plain, v, true, untracked, || 0));
        // Rebound while V is held: the next V down is a fresh press of the new binding.
        assert!(d.on_input(ctrl, v, true, untracked, || MOD_CTRL));
        // Cleared while held: nothing fires.
        assert!(!d.on_input(0, v, true, untracked, || 0));
    }

    #[test]
    fn packed_bindings_are_nonzero_and_distinct() {
        let specs = [
            "V",
            "Ctrl+V",
            "Shift+V",
            "Mouse3",
            "Mouse4",
            "Mouse5",
            "Win+Mouse4",
            "F24",
        ];
        let packed: Vec<u64> = specs
            .iter()
            .map(|s| parse_mute_spec(s).unwrap().pack())
            .collect();
        for (i, a) in packed.iter().enumerate() {
            assert_ne!(*a, 0, "{}", specs[i]);
            for (j, b) in packed.iter().enumerate().skip(i + 1) {
                assert_ne!(a, b, "{} vs {}", specs[i], specs[j]);
            }
        }
    }

    #[test]
    fn hook_messages_translate_to_triggers() {
        assert_eq!(
            key_event(WM_KEYDOWN, 0x56),
            Some((Trigger::Key(VK_V), true))
        );
        assert_eq!(
            key_event(WM_SYSKEYDOWN, 0x56),
            Some((Trigger::Key(VK_V), true))
        );
        assert_eq!(key_event(WM_KEYUP, 0x56), Some((Trigger::Key(VK_V), false)));
        assert_eq!(
            key_event(WM_SYSKEYUP, 0x56),
            Some((Trigger::Key(VK_V), false))
        );
        assert_eq!(key_event(WM_APP, 0x56), None);

        let x = |n: u16| u32::from(n) << 16;
        assert_eq!(
            mouse_event(WM_XBUTTONDOWN, x(XBUTTON1)),
            Some((Trigger::Mouse(MouseButton::X1), true))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONUP, x(XBUTTON2)),
            Some((Trigger::Mouse(MouseButton::X2), false))
        );
        assert_eq!(
            mouse_event(WM_MBUTTONDOWN, 0),
            Some((Trigger::Mouse(MouseButton::Middle), true))
        );
        assert_eq!(
            mouse_event(WM_MBUTTONUP, 0),
            Some((Trigger::Mouse(MouseButton::Middle), false))
        );
        assert_eq!(mouse_event(WM_XBUTTONDOWN, x(3)), None);
        use windows::Win32::UI::WindowsAndMessaging::{
            WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONDOWN,
        };
        for msg in [WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_RBUTTONDOWN] {
            assert_eq!(mouse_event(msg, x(XBUTTON1)), None);
        }
    }

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            binding: AtomicU64::new(0),
            presses: AtomicU32::new(0),
            held: Arc::new(AtomicBool::new(false)),
        })
    }

    #[test]
    fn hook_ctx_counts_presses_for_the_controller() {
        let shared = shared();
        let mut ctx = HookCtx {
            shared: shared.clone(),
            detector: EdgeDetector::new(),
            slots: None,
        };
        let x1 = Trigger::Mouse(MouseButton::X1);
        ctx.observe(x1, true, untracked, || 0);
        assert_eq!(shared.presses.load(Ordering::Relaxed), 0, "no binding yet");
        ctx.observe(x1, false, untracked, || 0);

        shared
            .binding
            .store(parse_mute_spec("Mouse4").unwrap().pack(), Ordering::Relaxed);
        // Every mouse button-down counts (no auto-repeat to filter).
        for down in [true, false, true, true, false] {
            ctx.observe(x1, down, untracked, || 0);
        }
        assert_eq!(shared.presses.swap(0, Ordering::Relaxed), 3);
        ctx.observe(Trigger::Mouse(MouseButton::X2), true, untracked, || 0);
        assert_eq!(shared.presses.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn hook_ctx_publishes_held_state() {
        let shared = shared();
        shared
            .binding
            .store(parse_mute_spec("Mouse5").unwrap().pack(), Ordering::Relaxed);
        let mut ctx = HookCtx {
            shared: shared.clone(),
            detector: EdgeDetector::new(),
            slots: None,
        };
        let x2 = Trigger::Mouse(MouseButton::X2);
        assert!(!shared.held.load(Ordering::Relaxed));
        ctx.observe(x2, true, untracked, || 0);
        assert!(shared.held.load(Ordering::Relaxed));
        ctx.observe(Trigger::Mouse(MouseButton::X1), false, untracked, || 0);
        assert!(shared.held.load(Ordering::Relaxed), "another button's up");
        ctx.observe(x2, false, untracked, || 0);
        assert!(!shared.held.load(Ordering::Relaxed));
    }

    #[test]
    fn mouse_sound_hook_runs_only_while_bound_and_counts_per_slot() {
        let mut h = MouseSoundHook::new();
        assert!(!h.running());
        let a = parse_mute_spec("Mouse4").unwrap();
        let b = parse_mute_spec("Ctrl+Mouse4").unwrap();
        assert!(h.set(&[a, b]).is_ok());
        assert!(h.running());
        let x1 = Trigger::Mouse(MouseButton::X1);
        h.simulate_event(x1, true, MOD_CTRL);
        h.simulate_event(x1, false, MOD_CTRL);
        h.simulate_event(x1, true, 0);
        let mut want = [0u32; MAX_MOUSE_SOUND_BINDINGS];
        want[0] = 2; // bare: both downs
        want[1] = 1; // combo: only the Ctrl one
        assert_eq!(h.take_presses(), want);
        assert_eq!(h.take_presses(), [0; MAX_MOUSE_SOUND_BINDINGS]);
        // Rebinding drops the old bindings; empty stops the thread.
        assert!(h.set(&[b]).is_ok());
        h.simulate_event(x1, true, 0);
        assert_eq!(h.take_presses(), [0; MAX_MOUSE_SOUND_BINDINGS]);
        assert!(h.set(&[]).is_ok());
        assert!(!h.running());
    }

    #[test]
    fn mute_hook_thread_follows_the_spec() {
        let mut h = MuteHook::new();
        assert!(!h.install, "unit tests never install real hooks");
        assert_eq!(h.running(), None);

        assert_eq!(h.set(Some("V")), None);
        assert_eq!(h.running(), Some("keyboard"));
        assert_eq!(
            Arc::strong_count(&h.shared),
            2,
            "the hook thread holds the shared state"
        );
        let tid = h.thread.as_ref().map(|t| t.tid);

        // Same hook kind: the binding is swapped in place.
        assert_eq!(h.set(Some("Ctrl+Shift+M")), None);
        assert_eq!(h.thread.as_ref().map(|t| t.tid), tid);
        assert_eq!(
            h.shared.binding.load(Ordering::Relaxed),
            parse_mute_spec("Ctrl+Shift+M").unwrap().pack()
        );

        // A mouse button: the keyboard thread is replaced by a mouse one.
        assert_eq!(h.set(Some("Mouse4")), None);
        assert_eq!(h.running(), Some("mouse"));
        assert_eq!(Arc::strong_count(&h.shared), 2, "the old thread is gone");

        // A bad spec stops the thread and is reported with the spec as given.
        let (accel, message) = h.set(Some("Mouse9")).expect("bad spec");
        assert_eq!(accel, "Mouse9");
        assert!(message.contains("unknown key"), "{message}");
        assert_eq!(h.error(), Some(&(accel, message)));
        assert_eq!(h.running(), None);
        assert_eq!(h.shared.binding.load(Ordering::Relaxed), 0);
        assert_eq!(
            Arc::strong_count(&h.shared),
            1,
            "thread exited and cleared its TLS"
        );

        assert_eq!(h.set(Some("V")), None);
        assert_eq!(h.error(), None);
        assert_eq!(h.set(Some("   ")), None, "blank clears without an error");
        assert_eq!(h.running(), None);
        assert_eq!(h.set(Some("Mouse5")), None);
        assert_eq!(h.set(None), None);
        assert_eq!(h.running(), None);
        assert_eq!(Arc::strong_count(&h.shared), 1);
    }

    #[test]
    fn mute_hook_restarts_a_thread_that_ended_on_its_own() {
        let mut h = MuteHook::new();
        assert_eq!(h.set(Some("V")), None);
        let tid = h.thread.as_ref().map(|t| t.tid).unwrap();
        // End its loop behind MuteHook's back (as a failing GetMessageW would).
        // SAFETY: a plain message post to the test's own hook thread.
        unsafe { PostThreadMessageW(tid, WM_STOP_HOOK, WPARAM(0), LPARAM(0)) }.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !h.thread.as_ref().unwrap().handle.is_finished() {
            assert!(std::time::Instant::now() < deadline, "thread didn't end");
            std::thread::sleep(Duration::from_millis(5));
        }
        // Same kind, but the dead thread is replaced instead of reused.
        assert_eq!(h.set(Some("Ctrl+V")), None);
        assert!(!h.thread.as_ref().unwrap().handle.is_finished());
        assert_eq!(Arc::strong_count(&h.shared), 2);
        h.set(None);
        assert_eq!(Arc::strong_count(&h.shared), 1);
    }

    #[test]
    fn mute_hook_drop_stops_the_thread() {
        let mut h = MuteHook::new();
        assert_eq!(h.set(Some("Mouse4")), None);
        let shared = h.shared.clone();
        assert_eq!(Arc::strong_count(&shared), 3);
        drop(h);
        assert_eq!(Arc::strong_count(&shared), 1, "drop joined the hook thread");
    }

    #[test]
    fn many_mute_hooks_start_and_stop_in_parallel() {
        let workers: Vec<_> = (0..6)
            .map(|i| {
                std::thread::spawn(move || {
                    let mut h = MuteHook::new();
                    for spec in ["V", "Mouse4", "Ctrl+M", "Mouse5", "F13"] {
                        assert_eq!(h.set(Some(spec)), None, "worker {i}: {spec}");
                    }
                    h.set(None);
                    assert_eq!(Arc::strong_count(&h.shared), 1);
                })
            })
            .collect();
        for w in workers {
            assert!(w.join().is_ok());
        }
    }
}
