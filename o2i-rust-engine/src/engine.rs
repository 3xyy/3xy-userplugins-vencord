use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{anyhow, Result};

use crate::audio::capture::{CaptureStream, MonitorTap};
use crate::audio::format::{CHANNELS, SAMPLE_RATE};
use crate::audio::health::{StreamHealth, StreamState};
use crate::audio::mixer::{new_mixer, DuckParams, MixCommand, MixSource, Mixer};
use crate::audio::process_loopback::ProcessLoopbackCapture;
use crate::audio::{devices, output::OutputStream, ringbuffer};
use crate::dsp::{MicChain, MicParams};
use crate::soundboard::{ClipGains, ClipStream, PlayingState, SbCommand, Soundboard};

/// Reserved mixer source id for the soundboard "to others" channel. Far above
/// any app-channel id (which count up from 1) so it never collides, and != 0 so
/// it ducks while you talk.
const SB_SOURCE_ID: u64 = u64::MAX;

/// Monitor-mixer source ids: the soundboard's "self" ring and the processed
/// mic (listen to yourself). The monitor mixer never ducks.
const MON_SB_SOURCE_ID: u64 = 0;
const MON_MIC_SOURCE_ID: u64 = 1;

/// One of the two streams audio can't flow without.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CoreStream {
    /// Mic capture.
    Mic,
    /// Render output into VB-CABLE (or whatever output device was chosen).
    Output,
}

/// Combined health of the mic capture + main render output streams.
#[derive(Clone, Debug, PartialEq)]
pub enum CoreStatus {
    /// The engine isn't running.
    Off,
    /// Running, but at least one stream hasn't started its client yet.
    Starting,
    /// Both streams started and neither has exited.
    Running,
    /// A core stream exited; audio no longer flows.
    Failed { stream: CoreStream, reason: String },
}

/// Combine the two core streams' states: a mic failure wins over an output
/// failure, then both must be running for `Running`.
pub fn combine_core_status(mic: StreamState, output: StreamState) -> CoreStatus {
    match (mic, output) {
        (StreamState::Failed(reason), _) => CoreStatus::Failed {
            stream: CoreStream::Mic,
            reason,
        },
        (_, StreamState::Failed(reason)) => CoreStatus::Failed {
            stream: CoreStream::Output,
            reason,
        },
        (StreamState::Running, StreamState::Running) => CoreStatus::Running,
        _ => CoreStatus::Starting,
    }
}

/// A dynamically-added per-application capture channel feeding the mixer.
/// Each channel owns its own stop flag so it can be removed independently
/// without tearing down the rest of the engine.
pub struct AppChannel {
    pub id: u64,
    pub name: String,
    /// The process (tree root) this channel captures.
    pub pid: u32,
    pub volume: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

impl AppChannel {
    /// False once the capture thread has exited (activation or device error,
    /// or the target went away): the channel no longer delivers audio.
    pub fn is_alive(&self) -> bool {
        !self.handle.is_finished()
    }
}

pub struct Engine {
    /// Shared stop flag for the mic capture + render output threads.
    stop: Option<Arc<AtomicBool>>,
    /// mic capture + output render handles.
    handles: Vec<JoinHandle<()>>,
    /// Health of the mic capture / main render threads of the current run.
    mic_health: Arc<StreamHealth>,
    out_health: Arc<StreamHealth>,
    params: Arc<MicParams>,
    /// Master output volume (f32 bits). Read by the Mixer each block.
    master: Arc<AtomicU32>,
    /// Sidechain ducking parameters. Read by the Mixer each block.
    duck: Arc<DuckParams>,
    /// Command channel to the running Mixer (Some while running).
    cmd_tx: Option<Sender<MixCommand>>,
    /// Monotonic source-id allocator for app channels (mic is id 0).
    next_id: u64,
    app_channels: Vec<AppChannel>,
    /// Command channel to the running soundboard thread (Some while running).
    sb_tx: Option<Sender<SbCommand>>,
    /// The soundboard mixing thread (Some while running).
    soundboard: Option<Soundboard>,
    /// Monotonic id for soundboard clip instances. UI reads returned ids to
    /// address pause/resume/stop per clip.
    next_instance_id: AtomicU64,
    /// Shared snapshot of currently-playing clips, updated by the sb thread
    /// (non-blocking) and polled by the UI.
    sb_playing: Arc<Mutex<Vec<PlayingState>>>,
    /// Stop flag + handle for the monitor output (Some while a monitor runs).
    monitor_stop: Option<Arc<AtomicBool>>,
    monitor_handle: Option<JoinHandle<()>>,
    /// Chosen monitor render device id; `None` → system default. Takes effect on
    /// next start().
    monitor_device_id: Option<String>,
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            stop: None,
            handles: Vec::new(),
            mic_health: Arc::new(StreamHealth::new()),
            out_health: Arc::new(StreamHealth::new()),
            params: Arc::new(MicParams::new()),
            master: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            duck: Arc::new(DuckParams::new()),
            cmd_tx: None,
            next_id: 0,
            app_channels: Vec::new(),
            sb_tx: None,
            soundboard: None,
            next_instance_id: AtomicU64::new(0),
            sb_playing: Arc::new(Mutex::new(Vec::new())),
            monitor_stop: None,
            monitor_handle: None,
            monitor_device_id: None,
        }
    }

    /// Shared, live-tunable mic-processing parameters. The UI thread writes
    /// these; the capture thread's `MicChain` reads them each block.
    pub fn params(&self) -> Arc<MicParams> {
        self.params.clone()
    }

    /// Shared master output volume (f32 bits via AtomicU32). UI writes; Mixer reads.
    pub fn master(&self) -> Arc<AtomicU32> {
        self.master.clone()
    }

    /// Shared sidechain-ducking parameters. UI writes; Mixer reads each block.
    pub fn duck_params(&self) -> Arc<DuckParams> {
        self.duck.clone()
    }

    /// True between a successful `start()` and `stop()`. It means the threads
    /// were spawned, not that audio flows; see `core_stream_status` for that.
    pub fn is_running(&self) -> bool {
        self.stop.is_some()
    }

    /// Whether the mic capture and main render output really run. Lock-free
    /// for the audio threads (they write their health only at start/exit).
    /// A core thread that exited without reporting (it never should) also
    /// counts as failed.
    pub fn core_stream_status(&self) -> CoreStatus {
        if !self.is_running() {
            return CoreStatus::Off;
        }
        let state_of = |health: &StreamHealth, index: usize| match health.state() {
            StreamState::Failed(reason) => StreamState::Failed(reason),
            _ if self.handles.get(index).is_some_and(|h| h.is_finished()) => {
                StreamState::Failed("stream thread exited".to_string())
            }
            other => other,
        };
        combine_core_status(state_of(&self.mic_health, 0), state_of(&self.out_health, 1))
    }

    /// Currently-attached per-application channels.
    pub fn app_channels(&self) -> &[AppChannel] {
        &self.app_channels
    }

    /// Start the engine: builds the mixer, starts mic capture (with the mic DSP
    /// chain) as mixer source id 0, and drives the render output from the mixer.
    /// The mic + output threads share one stop flag.
    ///
    /// Signature reconciliation:
    ///   - OutputStream::start takes `&str`  → pass `&output_id`
    ///   - CaptureStream::start takes `String` → pass `input_id` (owned)
    pub fn start(&mut self, input_id: String, output_id: String) -> Result<()> {
        if self.is_running() {
            return Ok(());
        }

        // Build the mixer and its command channel, bound to the shared master.
        let (mixer, tx): (Mixer, Sender<MixCommand>) =
            new_mixer(self.master.clone(), self.duck.clone());

        let stop = Arc::new(AtomicBool::new(false));

        // The monitor (headphones) device, resolved up front: the mic's
        // listen-to-yourself ring only exists when there is a monitor output.
        let monitor_id = self.monitor_device_id.clone().or_else(|| {
            // default_render_id() calls WASAPI/COM and must run on an MTA thread.
            // start() runs on the eframe UI thread, which winit makes STA. Calling
            // it directly would get RPC_E_CHANGED_MODE and fail/deadlock. Resolve it
            // on a spawned+joined worker, the same pattern as enumerate_devices().
            std::thread::spawn(|| devices::default_render_id().ok())
                .join()
                .ok()
                .flatten()
        });

        // Mic channel: capture (with MicChain) -> ~200ms stereo ring -> MixSource id 0.
        let cap = SAMPLE_RATE as usize * CHANNELS as usize / 5; // ~200 ms of stereo
        let (mic_prod, mic_cons) = ringbuffer::new(cap);
        // Listen to yourself: the capture thread also copies the processed mic
        // into its own ~200 ms ring (only while `monitor_mic` is on), read by
        // the monitor mixer below.
        let (mic_tap, mic_mon_cons) = if monitor_id.is_some() {
            let (prod, cons) = ringbuffer::new(cap);
            (Some(MonitorTap::new(prod, self.params.clone())), Some(cons))
        } else {
            (None, None)
        };
        let chain = MicChain::new(self.params.clone());
        let mic_health = Arc::new(StreamHealth::new());
        let mic_handle = CaptureStream::start(
            input_id,
            mic_prod,
            stop.clone(),
            Some(chain),
            mic_tap,
            mic_health.clone(),
        )?;
        let mic_vol = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        tx.send(MixCommand::Add(MixSource::new(0, mic_cons, mic_vol)))
            .ok();

        // Render output is driven by the mixer; shares the mic stop flag.
        let out_health = Arc::new(StreamHealth::new());
        let out_handle = OutputStream::start(&output_id, mixer, stop.clone(), out_health.clone())?;

        // Soundboard: a dedicated mixing thread feeds two ~200 ms rings. The
        // "others" ring becomes a non-mic mixer source (→ VB-CABLE, ducked while
        // talking) and the "monitor" ring drives a separate output (→ headphones,
        // not ducked). Per-path volume scaling happens inside the sb thread, so
        // both mixer volumes stay 1.0.
        let sb_cap = SAMPLE_RATE as usize * CHANNELS as usize / 5; // ~200 ms stereo
        let (others_prod, others_cons) = ringbuffer::new(sb_cap);
        let (monitor_prod, monitor_cons) = ringbuffer::new(sb_cap);
        let sb_stop = Arc::new(AtomicBool::new(false));
        let (soundboard, sb_tx) =
            Soundboard::start(others_prod, monitor_prod, sb_stop, self.sb_playing.clone());

        // "others" → main mixer as a ducked source (id != 0), volume 1.0.
        let sb_vol = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        tx.send(MixCommand::Add(MixSource::new(
            SB_SOURCE_ID,
            others_cons,
            sb_vol,
        )))
        .ok();

        // Monitor output: a separate mixer (no ducking, master 1.0) on the
        // chosen monitor device → headphones, summing the soundboard's "self"
        // ring and the listen-to-yourself mic (volume = `monitor_mic_volume`,
        // read live). Skipped (logged) if no device.
        match monitor_id {
            Some(mid) => {
                let mon_master = Arc::new(AtomicU32::new(1.0f32.to_bits()));
                let mon_duck = Arc::new(DuckParams::new()); // disabled → never ducks
                let (mon_mixer, mon_tx): (Mixer, Sender<MixCommand>) =
                    new_mixer(mon_master, mon_duck);
                let mon_vol = Arc::new(AtomicU32::new(1.0f32.to_bits()));
                mon_tx
                    .send(MixCommand::Add(MixSource::new(
                        MON_SB_SOURCE_ID,
                        monitor_cons,
                        mon_vol,
                    )))
                    .ok();
                if let Some(cons) = mic_mon_cons {
                    mon_tx
                        .send(MixCommand::Add(MixSource::new(
                            MON_MIC_SOURCE_ID,
                            cons,
                            self.params.monitor_mic_volume_handle(),
                        )))
                        .ok();
                }
                let mon_stop = Arc::new(AtomicBool::new(false));
                // OutputStream::start is infallible: it always spawns the render
                // thread and returns Ok(handle), moving any WASAPI init failure
                // into that thread (logged there as "[output] thread error: ...").
                // So there is no Err to handle here. If the monitor device id is
                // stale the render thread exits early; stop() later joins the
                // already-finished handle harmlessly. Monitor failure is not
                // fatal, so its health isn't tracked.
                let h = OutputStream::start(
                    &mid,
                    mon_mixer,
                    mon_stop.clone(),
                    Arc::new(StreamHealth::new()),
                )?;
                self.monitor_handle = Some(h);
                self.monitor_stop = Some(mon_stop);
            }
            None => {
                // Also no listen-to-yourself: the capture thread got no tap.
                elog!("[engine] no monitor render device; monitor output disabled");
            }
        }

        self.handles = vec![mic_handle, out_handle];
        self.mic_health = mic_health;
        self.out_health = out_health;
        self.stop = Some(stop);
        self.cmd_tx = Some(tx);
        self.soundboard = Some(soundboard);
        self.sb_tx = Some(sb_tx);
        // App channels are (re)added by the UI via add_app() after start().
        Ok(())
    }

    /// Start streaming the audio file at `path` with live per-instance
    /// `gains` (others → the VB-CABLE path, self → the local monitor when
    /// hear_local). Keep a clone of `gains` to change them while it plays; the
    /// mixing thread reads them every block. The clip is decoded on its own
    /// worker thread while it plays (never on this thread or the mixing
    /// thread; a file that fails to open is logged and ends immediately).
    /// Returns the instance id for pause/resume/seek/stop_clip. No-op
    /// (returns the id) if not running.
    pub fn play_clip(&self, name: String, path: PathBuf, gains: Arc<ClipGains>) -> u64 {
        let id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
        if let Some(tx) = self.sb_tx.as_ref() {
            // If the soundboard thread is gone the command (and the stream in
            // it) is dropped, which stops the worker.
            tx.send(SbCommand::Play {
                id,
                name,
                stream: ClipStream::spawn(path),
                gains,
            })
            .ok();
        }
        id
    }

    /// Jump a playing clip to `pos_frames` (48 kHz frames). The seek runs on
    /// the clip's decoder worker; the clip is silent until it lands, a paused
    /// clip stays paused, and a target at/after the end finishes it. No-op if
    /// not found or not running.
    pub fn seek_clip(&self, id: u64, pos_frames: u64) {
        if let Some(tx) = self.sb_tx.as_ref() {
            tx.send(SbCommand::Seek { id, pos_frames }).ok();
        }
    }

    /// Pause a clip by instance id. No-op if not found or not running.
    pub fn pause_clip(&self, id: u64) {
        if let Some(tx) = self.sb_tx.as_ref() {
            tx.send(SbCommand::Pause(id)).ok();
        }
    }

    /// Resume a paused clip by instance id. No-op if not found or not running.
    pub fn resume_clip(&self, id: u64) {
        if let Some(tx) = self.sb_tx.as_ref() {
            tx.send(SbCommand::Resume(id)).ok();
        }
    }

    /// Stop (remove) a single clip by instance id. No-op if not found or not running.
    pub fn stop_clip(&self, id: u64) {
        if let Some(tx) = self.sb_tx.as_ref() {
            tx.send(SbCommand::Stop(id)).ok();
        }
    }

    /// Stop all currently-playing soundboard clips (panic key). No-op if idle.
    pub fn stop_all_clips(&self) {
        if let Some(tx) = self.sb_tx.as_ref() {
            tx.send(SbCommand::StopAll).ok();
        }
    }

    /// Shared snapshot of currently-playing soundboard clips. The UI thread
    /// should lock briefly, clone the Vec, and release. The audio thread
    /// updates this non-blocking (try_lock) after each mixed block.
    pub fn sb_playing(&self) -> Arc<Mutex<Vec<PlayingState>>> {
        self.sb_playing.clone()
    }

    /// Choose the monitor render device (`None` → system default). Takes effect
    /// on the next start(); changing it while running requires a restart.
    pub fn set_monitor_device(&mut self, id: Option<String>) {
        self.monitor_device_id = id;
    }

    /// Add a per-application loopback capture channel. Only valid while running.
    /// Allocates a fresh mixer source id (>= 1), starts process-loopback capture,
    /// and registers the source with the mixer. Returns the new channel id.
    pub fn add_app(&mut self, pid: u32, name: String) -> Result<u64> {
        let tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("engine not running; cannot add app channel"))?;

        self.next_id += 1;
        let id = self.next_id;

        let cap = SAMPLE_RATE as usize * CHANNELS as usize / 5; // ~200 ms of stereo
        let (prod, cons) = ringbuffer::new(cap);
        let app_stop = Arc::new(AtomicBool::new(false));

        let handle = ProcessLoopbackCapture::start(pid, prod, app_stop.clone())?;
        let volume = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        tx.send(MixCommand::Add(MixSource::new(id, cons, volume.clone())))
            .ok();

        self.app_channels.push(AppChannel {
            id,
            name,
            pid,
            volume,
            stop: app_stop,
            handle,
        });
        Ok(id)
    }

    /// Remove a per-application channel: detach from the mixer, stop its capture
    /// thread, join it, and drop it. No-op for an unknown id.
    pub fn remove_app(&mut self, id: u64) {
        if let Some(pos) = self.app_channels.iter().position(|c| c.id == id) {
            let ch = self.app_channels.remove(pos);
            if let Some(tx) = self.cmd_tx.as_ref() {
                tx.send(MixCommand::Remove(id)).ok();
            }
            ch.stop.store(true, Ordering::Relaxed);
            let _ = ch.handle.join();
        }
    }

    /// Signal all threads to stop and join them. Safe to call when idle (no-op).
    pub fn stop(&mut self) {
        // Stop the soundboard thread + monitor output first so they stop pushing.
        if let Some(mut sb) = self.soundboard.take() {
            sb.stop();
        }
        self.sb_tx = None;
        if let Some(mon_stop) = self.monitor_stop.take() {
            mon_stop.store(true, Ordering::Relaxed);
            if let Some(h) = self.monitor_handle.take() {
                let _ = h.join();
            }
        }
        // Stop and join all per-app channels next.
        for ch in self.app_channels.drain(..) {
            if let Some(tx) = self.cmd_tx.as_ref() {
                tx.send(MixCommand::Remove(ch.id)).ok();
            }
            ch.stop.store(true, Ordering::Relaxed);
            let _ = ch.handle.join();
        }
        // Then stop the mic + output threads.
        if let Some(stop) = self.stop.take() {
            stop.store(true, Ordering::Relaxed);
            for h in self.handles.drain(..) {
                let _ = h.join();
            }
        }
        self.cmd_tx = None;
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(r: &str) -> StreamState {
        StreamState::Failed(r.to_string())
    }

    #[test]
    fn core_status_running_only_when_both_run() {
        use StreamState::{Running, Starting};
        assert_eq!(combine_core_status(Running, Running), CoreStatus::Running);
        assert_eq!(combine_core_status(Starting, Running), CoreStatus::Starting);
        assert_eq!(combine_core_status(Running, Starting), CoreStatus::Starting);
        assert_eq!(
            combine_core_status(Starting, Starting),
            CoreStatus::Starting
        );
    }

    #[test]
    fn core_status_reports_which_stream_failed() {
        assert_eq!(
            combine_core_status(failed("no mic"), StreamState::Running),
            CoreStatus::Failed {
                stream: CoreStream::Mic,
                reason: "no mic".into()
            }
        );
        assert_eq!(
            combine_core_status(StreamState::Starting, failed("no cable")),
            CoreStatus::Failed {
                stream: CoreStream::Output,
                reason: "no cable".into()
            }
        );
        // Both failed: the mic is reported.
        assert_eq!(
            combine_core_status(failed("a"), failed("b")),
            CoreStatus::Failed {
                stream: CoreStream::Mic,
                reason: "a".into()
            }
        );
    }

    #[test]
    fn idle_engine_core_status_is_off() {
        assert_eq!(Engine::new().core_stream_status(), CoreStatus::Off);
    }
}
