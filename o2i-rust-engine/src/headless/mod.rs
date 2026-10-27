pub mod apps;
pub mod controller;
pub mod protocol;

use crate::audio::devices::init_com;
use crate::elog;
use controller::Controller;
use protocol::{emit, parse_command, AudioStatus, Command, Event, MuteSource};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(50);
const STATE_RUNNING: Duration = Duration::from_millis(50);
const STATE_IDLE: Duration = Duration::from_millis(1000);
/// After stdin closes, the process exits on its own after this long even if
/// the controller is stuck (normal shutdown finishes well within it).
const EOF_WATCHDOG: Duration = Duration::from_secs(5);

enum Input {
    Line(String),
    Eof,
}

/// Log why the engine is exiting and get the log onto disk.
fn log_shutdown(reason: &str) {
    elog::event("shutdown", reason);
    elog::flush();
}

/// Run the stdin/stdout protocol loop. Returns the process exit code.
pub fn run() -> i32 {
    let _ = init_com();
    let version = env!("CARGO_PKG_VERSION");
    elog::event(
        "startup",
        &format!("o2i {version} mode=headless pid={}", std::process::id()),
    );
    emit(&Event::Ready { version: version.to_string() });

    let (tx, rx) = channel::<Input>();
    let spawned = std::thread::Builder::new().name("o2i-stdin".into()).spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(Input::Line(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Input::Eof);
        // Watchdog: the run loop normally shuts down and returns (ending the
        // process) long before this; if it's stuck in a long call, the parent
        // is gone and nobody will ever stop us, so leave anyway.
        std::thread::sleep(EOF_WATCHDOG);
        elog!("[headless] still running {EOF_WATCHDOG:?} after stdin closed; exiting");
        log_shutdown("watchdog: still running after stdin closed");
        std::process::exit(0);
    });
    if spawned.is_err() {
        emit(&Event::Error { message: "failed to start stdin reader".into() });
        log_shutdown("failed to start stdin reader");
        return 1;
    }

    let mut ctl = Controller::new(crate::hotkey_thread::HotkeyThread::spawn());
    emit(&ctl.state());
    let mut last_state = Instant::now();

    loop {
        let mut force_state = false;
        let mut quit: Option<&str> = None;
        match rx.recv_timeout(TICK) {
            Ok(Input::Line(line)) => {
                if !line.trim().is_empty() {
                    match parse_command(&line) {
                        Err(message) => emit(&Event::Error { message }),
                        Ok(cmd) => match cmd {
                            Command::Configure { profile } => {
                                ctl.configure(profile).iter().for_each(emit);
                                force_state = true;
                            }
                            Command::SetAudio { on } => {
                                ctl.set_audio(on).iter().for_each(emit);
                                force_state = true;
                            }
                            Command::PlayClip { file, path } => {
                                ctl.play_clip(file.as_deref(), path.as_deref()).iter().for_each(emit)
                            }
                            Command::SeekClip { id, pos_s } => ctl.seek_clip(id, pos_s).iter().for_each(emit),
                            Command::PauseClip { id } => ctl.pause_clip(id),
                            Command::ResumeClip { id } => ctl.resume_clip(id),
                            Command::StopClip { id } => ctl.stop_clip(id),
                            Command::StopAll => ctl.stop_all(),
                            Command::SetMicMuted { muted } => {
                                // The event goes out now, not on the next state tick.
                                ctl.set_mic_muted(muted, MuteSource::Command).iter().for_each(emit)
                            }
                            Command::ListDevices => emit(&ctl.list_devices()),
                            Command::ListApps => emit(&ctl.list_apps()),
                            Command::ListClips => emit(&ctl.list_clips()),
                            Command::Shutdown => quit = Some("shutdown command"),
                        },
                    }
                }
            }
            Ok(Input::Eof) => quit = Some("stdin closed"),
            Err(RecvTimeoutError::Disconnected) => quit = Some("stdin reader ended"),
            Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some(reason) = quit {
            // Final state so the controller sees the stop, then tear down.
            ctl.shutdown();
            emit(&ctl.state());
            log_shutdown(reason);
            return 0;
        }

        ctl.tick().iter().for_each(emit);

        let running = matches!(
            ctl.state(),
            Event::State(ref s) if s.audio == AudioStatus::Running
        );
        let interval = if running { STATE_RUNNING } else { STATE_IDLE };
        if force_state || last_state.elapsed() >= interval {
            emit(&ctl.state());
            last_state = Instant::now();
        }
    }
}
