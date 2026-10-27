//! Health of a WASAPI stream thread (mic capture / render output), so callers
//! can tell whether audio is really flowing instead of trusting "the thread
//! was spawned".
//!
//! The stream thread writes it only twice (once after its client starts and
//! once as the thread exits), never on the per-buffer path, so the capture and
//! render loops stay lock-free and allocation-free.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// What a stream thread is doing, as seen from outside.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamState {
    /// Spawned; the WASAPI client hasn't started yet.
    Starting,
    /// The WASAPI client initialised and started.
    Running,
    /// The thread has exited (init failure, device error, or any other end),
    /// with the reason.
    Failed(String),
}

/// Shared between a stream thread (writer) and the engine (reader).
#[derive(Default)]
pub struct StreamHealth {
    started: AtomicBool,
    finished: AtomicBool,
    /// Why the thread exited; set once, just before `finished`.
    error: Mutex<Option<String>>,
}

impl StreamHealth {
    pub fn new() -> StreamHealth {
        StreamHealth::default()
    }

    /// Called by the stream thread once its client has started.
    pub fn mark_started(&self) {
        self.started.store(true, Ordering::Release);
    }

    /// Called by the stream thread as it exits; `error` is why (None for a
    /// requested stop).
    pub fn mark_finished(&self, error: Option<String>) {
        if let Some(e) = error {
            *self.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
        }
        self.finished.store(true, Ordering::Release);
    }

    /// Current state. Meant to be read while the stream should be running:
    /// an exit for any reason (even without an error) reads as `Failed`.
    pub fn state(&self) -> StreamState {
        if self.finished.load(Ordering::Acquire) {
            let reason = self
                .error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
                .unwrap_or_else(|| "stream ended".to_string());
            return StreamState::Failed(reason);
        }
        if self.started.load(Ordering::Acquire) {
            StreamState::Running
        } else {
            StreamState::Starting
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_health_is_starting() {
        assert_eq!(StreamHealth::new().state(), StreamState::Starting);
    }

    #[test]
    fn started_health_is_running() {
        let h = StreamHealth::new();
        h.mark_started();
        assert_eq!(h.state(), StreamState::Running);
    }

    #[test]
    fn init_failure_is_failed_with_reason() {
        let h = StreamHealth::new();
        h.mark_finished(Some("GetDevice(capture): Element not found.".into()));
        assert_eq!(
            h.state(),
            StreamState::Failed("GetDevice(capture): Element not found.".into())
        );
    }

    #[test]
    fn failure_after_start_is_failed() {
        let h = StreamHealth::new();
        h.mark_started();
        h.mark_finished(Some("GetBuffer: device invalidated".into()));
        assert_eq!(
            h.state(),
            StreamState::Failed("GetBuffer: device invalidated".into())
        );
    }

    #[test]
    fn exit_without_error_still_counts_as_failed() {
        // Only queried while the engine runs (stop flag clear), so any exit
        // means the stream is no longer delivering audio.
        let h = StreamHealth::new();
        h.mark_started();
        h.mark_finished(None);
        assert!(matches!(h.state(), StreamState::Failed(_)));
    }
}
