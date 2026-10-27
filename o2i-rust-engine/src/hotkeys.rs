use anyhow::{anyhow, Context, Result};
use global_hotkey::{hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::collections::HashMap;

/// Wraps the global-hotkey manager and tracks registered hotkeys by id so they
/// can be unregistered by id (the crate's `unregister` takes a `HotKey` value).
pub struct Hotkeys {
    manager: GlobalHotKeyManager,
    registered: HashMap<u32, HotKey>,
}

impl Hotkeys {
    /// Create a new hotkey manager.
    ///
    /// On Windows this must be called on the thread that owns the win32 event
    /// loop (the egui/eframe UI thread satisfies this requirement).
    pub fn new() -> Result<Self> {
        let manager = GlobalHotKeyManager::new().context("GlobalHotKeyManager::new")?;
        Ok(Self {
            manager,
            registered: HashMap::new(),
        })
    }

    /// Parse `accel`, register it, and return the hotkey id.
    ///
    /// If a hotkey with the same id is already registered it is silently
    /// unregistered first so callers can freely re-bind.
    pub fn register(&mut self, accel: &str) -> Result<u32> {
        let hotkey = parse_accel(accel).ok_or_else(|| anyhow!("invalid accelerator: {accel:?}"))?;
        let id = hotkey.id();
        // Unregister the previous binding for this id if any.
        if let Some(old) = self.registered.remove(&id) {
            let _ = self.manager.unregister(old);
        }
        self.manager.register(hotkey).context("register hotkey")?;
        self.registered.insert(id, hotkey);
        Ok(id)
    }

    /// Unregister a previously registered hotkey by its id.
    ///
    /// Silently ignores unknown ids.
    pub fn unregister(&mut self, id: u32) {
        if let Some(hotkey) = self.registered.remove(&id) {
            let _ = self.manager.unregister(hotkey);
        }
    }

    /// Drain all pending `Pressed` events from the global channel and return
    /// the fired hotkey ids. Doesn't need `&mut self`: the event channel
    /// is process-global.
    pub fn poll() -> Vec<u32> {
        let receiver = GlobalHotKeyEvent::receiver();
        let mut fired = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            if event.state == HotKeyState::Pressed {
                fired.push(event.id);
            }
        }
        fired
    }
}

/// Parse a human-friendly accelerator string into a [`HotKey`].
///
/// Uses the `global-hotkey` crate's built-in `FromStr` impl.  Modifiers and
/// the key are separated by `+`.  Modifier names are case-insensitive:
/// `Ctrl` / `Control`, `Shift`, `Alt`, `Super` / `Cmd`.  Key names follow the
/// W3C `KeyboardEvent.code` convention (e.g. `F8`, `KeyA`, `A`, `Digit1`,
/// `1`).
///
/// Returns `None` if the string cannot be parsed.
pub fn parse_accel(s: &str) -> Option<HotKey> {
    s.parse::<HotKey>().ok()
}

// ---------------------------------------------------------------------------
// Unit tests (pure parser; no hardware / no manager)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use global_hotkey::hotkey::{Code, Modifiers};

    #[test]
    fn parse_f8_no_mods() {
        let hk = parse_accel("F8").expect("F8 should parse");
        assert_eq!(hk.key, Code::F8);
        assert!(hk.mods.is_empty(), "F8 should have no modifiers");
    }

    #[test]
    fn parse_ctrl_shift_a() {
        let hk = parse_accel("Ctrl+Shift+A").expect("Ctrl+Shift+A should parse");
        assert_eq!(hk.key, Code::KeyA);
        assert!(
            hk.mods.contains(Modifiers::CONTROL),
            "should have Ctrl modifier"
        );
        assert!(
            hk.mods.contains(Modifiers::SHIFT),
            "should have Shift modifier"
        );
    }

    #[test]
    fn parse_invalid_returns_none() {
        assert!(
            parse_accel("NotAValidKey!!!").is_none(),
            "garbage should return None"
        );
    }
}
