//! Single-instance audio lock: only one o2i (window or headless) may run audio at a time.

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

pub struct InstanceLock(HANDLE);

/// Serialises tests that take the machine-wide lock (they run in parallel).
#[cfg(test)]
pub static TEST_LOCK_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

// The handle is an opaque kernel object handle, safe to move/close from any thread.
unsafe impl Send for InstanceLock {}

impl InstanceLock {
    /// Take the named mutex. `None` if another o2i already holds it (or creation failed).
    pub fn acquire() -> Option<InstanceLock> {
        unsafe {
            let h = CreateMutexW(None, false, w!(r"Local\o2i-audio-engine")).ok()?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(h);
                return None;
            }
            Some(InstanceLock(h))
        }
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::InstanceLock;

    #[test]
    fn instance_lock_is_exclusive() {
        let _serial = super::TEST_LOCK_SERIAL
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let a = InstanceLock::acquire();
        assert!(a.is_some());
        assert!(InstanceLock::acquire().is_none());
        drop(a);
        assert!(InstanceLock::acquire().is_some());
    }
}
