use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::audio::format::CHANNELS;
use crate::audio::ringbuffer::RingProducer;

pub mod decode;
pub mod folder;
pub mod stream;

pub use stream::{ClipStream, SeekPoll};

/// Concurrent-clip ceiling; `active` and the snapshot are preallocated to it.
const MAX_CLIPS: usize = 16;

/// Live per-instance gains of a playing clip. The owner (controller / UI)
/// keeps a clone and may `set` them at any time; the mixing thread `load`s
/// them every block (plain atomics, no locks). The three values are
/// independent atomics, so a block straddling a `set` may mix old and new
/// values for that one block.
#[derive(Debug)]
pub struct ClipGains {
    /// Gain into the "others" (→ VB-CABLE) path, f32 bits.
    others: AtomicU32,
    /// Gain into the local monitor (→ headphones) path, f32 bits.
    self_: AtomicU32,
    /// Whether the clip is monitored locally at all.
    hear_local: AtomicBool,
}

impl ClipGains {
    pub fn new(others: f32, self_: f32, hear_local: bool) -> ClipGains {
        ClipGains {
            others: AtomicU32::new(others.to_bits()),
            self_: AtomicU32::new(self_.to_bits()),
            hear_local: AtomicBool::new(hear_local),
        }
    }

    pub fn set(&self, others: f32, self_: f32, hear_local: bool) {
        self.others.store(others.to_bits(), Ordering::Relaxed);
        self.self_.store(self_.to_bits(), Ordering::Relaxed);
        self.hear_local.store(hear_local, Ordering::Relaxed);
    }

    /// `(others, self, hear_local)`.
    pub fn load(&self) -> (f32, f32, bool) {
        (
            f32::from_bits(self.others.load(Ordering::Relaxed)),
            f32::from_bits(self.self_.load(Ordering::Relaxed)),
            self.hear_local.load(Ordering::Relaxed),
        )
    }
}

pub struct Playing {
    pub id: u64,
    pub name: String,
    /// Decoder-fed ring this clip's audio is pulled from.
    pub stream: ClipStream,
    /// Stereo frames output so far (advances only on real samples, not on
    /// underrun silence or while paused; jumps on a seek).
    pub frames_played: u64,
    pub paused: bool,
    /// Live per-instance gains, read every block.
    pub gains: Arc<ClipGains>,
}

impl Playing {
    /// Jump to `pos_frames` (48 kHz). The worker performs the seek; until it
    /// lands the clip is silent, and the position shows the target at once.
    /// Paused clips stay paused. Allocation-free (mixing thread).
    pub fn seek(&mut self, pos_frames: u64) {
        self.stream.request_seek(pos_frames);
        self.frames_played = pos_frames;
    }
}

/// Snapshot of a playing clip, safe to clone and hand to the UI thread.
#[derive(Clone)]
pub struct PlayingState {
    pub id: u64,
    pub name: String,
    /// Stereo frames played so far (48 kHz).
    pub pos_frames: u64,
    /// Clip length in 48 kHz frames, if the container reports it.
    pub len_frames: Option<u64>,
    pub paused: bool,
}

/// Mix the next block of every active clip into two buffers, each scaled by
/// the clip's live gains (loaded this block): `samples * others` into
/// `others_out` (→ VB-CABLE) and, if its `hear_local` is set,
/// `samples * self` into `monitor_out` (→ headphones). Both buffers are zeroed
/// first; `scratch` is the caller's preallocated pull buffer
/// (`scratch.len() == others_out.len()`). A clip with a seek in flight is
/// silent until the seek lands (then its stale audio is skipped and
/// `frames_played` set to where it landed). A clip is removed on the first
/// call that finds it finished (eof and ring drained), before pulling. A clip
/// whose ring is momentarily empty (decoder behind) contributes silence but
/// stays. Paused clips pull nothing. No clamping (the mixer clamps).
/// Lock-free and allocation-free; pure + testable.
pub fn mix_block_weighted(
    active: &mut Vec<Playing>,
    others_out: &mut [f32],
    monitor_out: &mut [f32],
    scratch: &mut [f32],
) {
    others_out.fill(0.0);
    monitor_out.fill(0.0);
    // All three are the same length in practice; the min keeps every slice
    // below in bounds regardless (the audio thread must never panic).
    let len = others_out.len().min(monitor_out.len()).min(scratch.len());
    let pull = &mut scratch[..len];
    active.retain_mut(|p| {
        match p.stream.poll_seek() {
            // Hold (silent, kept) until the worker has executed the seek.
            SeekPoll::Pending => return true,
            SeekPoll::Landed(pos) => p.frames_played = pos,
            SeekPoll::Idle => {}
        }
        if p.stream.is_finished() {
            return false;
        }
        // Paused clips stay in the list but pull nothing this block.
        if p.paused {
            return true;
        }
        let (vol_others, vol_self, hear_local) = p.gains.load();
        let n = p.stream.pop_into(pull);
        let got = &pull[..n];
        for (o, &s) in others_out.iter_mut().zip(got) {
            *o += s * vol_others;
        }
        if hear_local {
            for (m, &s) in monitor_out.iter_mut().zip(got) {
                *m += s * vol_self;
            }
        }
        p.frames_played += (n / CHANNELS as usize) as u64;
        true
    });
}

/// Refresh the UI snapshot from `active`, reusing the existing entries' `name`
/// allocations (a name is only rewritten when its slot now holds a different
/// clip instance). Allocates only when a new slot or a longer name is needed,
/// i.e. when clips start, never per block in steady state.
fn write_snapshot(snapshot: &mut Vec<PlayingState>, active: &[Playing]) {
    snapshot.truncate(active.len());
    for (i, p) in active.iter().enumerate() {
        let len_frames = p.stream.total_frames();
        match snapshot.get_mut(i) {
            Some(s) => {
                // Instance ids are unique, so a matching id means the name is
                // already right.
                if s.id != p.id {
                    s.id = p.id;
                    s.name.clear();
                    s.name.push_str(&p.name);
                }
                s.pos_frames = p.frames_played;
                s.len_frames = len_frames;
                s.paused = p.paused;
            }
            None => snapshot.push(PlayingState {
                id: p.id,
                name: p.name.clone(),
                pos_frames: p.frames_played,
                len_frames,
                paused: p.paused,
            }),
        }
    }
}

pub enum SbCommand {
    /// Start a clip. The stream is spawned by the caller (never on the
    /// mixing thread), so its decoder is already starting up.
    Play {
        id: u64,
        name: String,
        stream: ClipStream,
        /// Live gains; the sender keeps a clone to change them while playing.
        gains: Arc<ClipGains>,
    },
    /// Jump instance `id` to `pos_frames` (48 kHz frames).
    Seek {
        id: u64,
        pos_frames: u64,
    },
    Pause(u64),
    Resume(u64),
    Stop(u64),
    StopAll,
}

pub struct Soundboard {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Soundboard {
    /// Spawn the mixing thread. It drains commands, mixes a fixed block per
    /// iteration applying each clip's own gains, and pushes into the `others`
    /// (→ main mixer / VB-CABLE) and `monitor` (→ headphones) rings. Paced by
    /// ring free-space so it never overflow-drops; sleeps briefly when full.
    ///
    /// `playing` is a shared snapshot updated (non-blocking, via `try_lock`)
    /// after each mixed block so the UI can poll it without ever blocking the
    /// audio thread.
    pub fn start(
        mut others: RingProducer,
        mut monitor: RingProducer,
        stop: Arc<AtomicBool>,
        playing: Arc<Mutex<Vec<PlayingState>>>,
    ) -> (Soundboard, Sender<SbCommand>) {
        let (tx, rx): (Sender<SbCommand>, Receiver<SbCommand>) = channel();
        let stop2 = stop.clone();
        // Reserve the snapshot's slots here, on the caller's thread, so the
        // mixing thread never grows that Vec.
        if let Ok(mut snapshot) = playing.lock() {
            snapshot.reserve(MAX_CLIPS);
        }
        let handle = thread::spawn(move || {
            const BLOCK: usize = 480 * CHANNELS as usize; // 10ms stereo
                                                          // Preallocate a ceiling of concurrent clips so a burst of Play
                                                          // commands never reallocates on the audio thread.
            let mut active: Vec<Playing> = Vec::with_capacity(MAX_CLIPS);
            let mut others_block = vec![0.0f32; BLOCK];
            let mut monitor_block = vec![0.0f32; BLOCK];
            // Pull buffer for each clip's ring, allocated once.
            let mut scratch = vec![0.0f32; BLOCK];
            while !stop2.load(Ordering::Relaxed) {
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        SbCommand::Play {
                            id,
                            name,
                            stream,
                            gains,
                        } => {
                            // Cap concurrent clips at preallocated capacity to
                            // avoid reallocation on the audio thread. Dropping
                            // an evicted/stopped clip's stream stops its worker.
                            if active.len() >= MAX_CLIPS {
                                active.remove(0);
                            }
                            active.push(Playing {
                                id,
                                name,
                                stream,
                                frames_played: 0,
                                paused: false,
                                gains,
                            });
                        }
                        SbCommand::Seek { id, pos_frames } => {
                            if let Some(p) = active.iter_mut().find(|p| p.id == id) {
                                p.seek(pos_frames);
                            }
                        }
                        SbCommand::Pause(id) => {
                            if let Some(p) = active.iter_mut().find(|p| p.id == id) {
                                p.paused = true;
                            }
                        }
                        SbCommand::Resume(id) => {
                            if let Some(p) = active.iter_mut().find(|p| p.id == id) {
                                p.paused = false;
                            }
                        }
                        SbCommand::Stop(id) => {
                            active.retain(|p| p.id != id);
                        }
                        SbCommand::StopAll => active.clear(),
                    }
                }
                // Pace ONLY on the primary (others) ring. A stalled or absent
                // monitor consumer must never block the VB-CABLE path.
                if others.free_len() < BLOCK {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                // Mix with per-clip gains directly into both buffers. No global
                // scaling: each clip carries its own live gains.
                mix_block_weighted(
                    &mut active,
                    &mut others_block,
                    &mut monitor_block,
                    &mut scratch,
                );
                others.push_slice(&others_block);
                // Monitor is best-effort: skip this block if the ring is full
                // (stale/absent consumer) rather than stalling the primary path.
                if monitor.free_len() >= BLOCK {
                    monitor.push_slice(&monitor_block);
                }
                // Update the UI snapshot non-blocking. If the lock is held by the
                // UI thread (rare), skip this block rather than ever blocking the
                // audio-producing thread.
                if let Ok(mut snapshot) = playing.try_lock() {
                    write_snapshot(&mut snapshot, &active);
                }
            }
        });
        (
            Soundboard {
                stop,
                handle: Some(handle),
            },
            tx,
        )
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::soundboard::decode::test_util::{ramp, temp_wav, write_ramp_wav};
    use std::time::Instant;

    fn with_gains(id: u64, stream: ClipStream, gains: Arc<ClipGains>) -> Playing {
        Playing {
            id,
            name: "x".into(),
            stream,
            frames_played: 0,
            paused: false,
            gains,
        }
    }

    /// Test helper: build a Playing with unit gains and local monitoring on, so
    /// the existing mix tests keep their original "raw sum" intent.
    fn unit(id: u64, name: &str, stream: ClipStream, paused: bool) -> Playing {
        let mut p = with_gains(id, stream, Arc::new(ClipGains::new(1.0, 1.0, true)));
        p.name = name.into();
        p.paused = paused;
        p
    }

    /// Mix one block with a scratch buffer sized like the output (as the
    /// soundboard thread preallocates it).
    fn mix(active: &mut Vec<Playing>, out: &mut [f32], mon: &mut [f32]) {
        let mut scratch = vec![0.0f32; out.len()];
        mix_block_weighted(active, out, mon, &mut scratch);
    }

    #[test]
    fn mixes_and_advances_and_drops() {
        let a = ClipStream::from_samples(vec![1.0f32, 1.0, 1.0, 1.0]);
        let b = ClipStream::from_samples(vec![0.5f32, 0.5]);
        let mut active = vec![unit(1, "a", a, false), unit(2, "b", b, false)];
        let mut out = [0.0f32; 2];
        let mut mon = [0.0f32; 2];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [1.5, 1.5]); // both contribute
        assert_eq!(mon, [1.5, 1.5]); // hear_local on, unit self gain
        assert_eq!(active.len(), 2); // b still present; lazily cleaned next block
        let mut out2 = [0.0f32; 2];
        let mut mon2 = [0.0f32; 2];
        mix(&mut active, &mut out2, &mut mon2);
        assert_eq!(out2, [1.0, 1.0]); // b exhausted last block → dropped now
        assert_eq!(active.len(), 1); // only a remains
        let mut out3 = [0.0f32; 4];
        let mut mon3 = [0.0f32; 4];
        mix(&mut active, &mut out3, &mut mon3);
        assert!(active.is_empty()); // a drained + eof → dropped
    }

    #[test]
    fn empty_is_silence() {
        let mut active: Vec<Playing> = Vec::new();
        let mut out = [9.0f32; 4];
        let mut mon = [9.0f32; 4];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(mon, [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn paused_clip_contributes_nothing_and_stays() {
        let s = ClipStream::from_samples(vec![1.0f32, 1.0, 1.0, 1.0]);
        let mut active = vec![unit(1, "x", s, true)];
        let mut out = [0.0f32; 2];
        let mut mon = [0.0f32; 2];
        mix(&mut active, &mut out, &mut mon);
        // Paused: output is silence, position unchanged, clip still present.
        assert_eq!(out, [0.0, 0.0]);
        assert_eq!(mon, [0.0, 0.0]);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].frames_played, 0);
    }

    #[test]
    fn resume_after_pause_continues_from_same_position() {
        let s = ClipStream::from_samples(vec![1.0f32, 2.0, 3.0, 4.0]);
        let mut active = vec![unit(1, "x", s, false)];
        // Play first 2 samples (one stereo frame).
        let mut out = [0.0f32; 2];
        let mut mon = [0.0f32; 2];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [1.0, 2.0]);
        assert_eq!(active[0].frames_played, 1);
        // Pause: block contributes nothing, position frozen.
        active[0].paused = true;
        let mut out2 = [0.0f32; 2];
        let mut mon2 = [0.0f32; 2];
        mix(&mut active, &mut out2, &mut mon2);
        assert_eq!(out2, [0.0, 0.0]);
        assert_eq!(active[0].frames_played, 1);
        // Resume: continues where it left off.
        active[0].paused = false;
        let mut out3 = [0.0f32; 2];
        let mut mon3 = [0.0f32; 2];
        mix(&mut active, &mut out3, &mut mon3);
        assert_eq!(out3, [3.0, 4.0]);
    }

    #[test]
    fn per_clip_gains_and_hear_local_route_correctly() {
        // vol_others=0.5, vol_self=0.0, hear_local=false → 0.5 to others, 0 to monitor.
        let mut active = vec![with_gains(
            1,
            ClipStream::from_samples(vec![1.0f32, 1.0]),
            Arc::new(ClipGains::new(0.5, 0.0, false)),
        )];
        let mut out = [0.0f32; 2];
        let mut mon = [0.0f32; 2];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [0.5, 0.5]);
        assert_eq!(mon, [0.0, 0.0]);

        // hear_local=true with a distinct self gain routes independently.
        let mut active2 = vec![with_gains(
            2,
            ClipStream::from_samples(vec![1.0f32, 1.0]),
            Arc::new(ClipGains::new(0.25, 2.0, true)),
        )];
        let mut out2 = [0.0f32; 2];
        let mut mon2 = [0.0f32; 2];
        mix(&mut active2, &mut out2, &mut mon2);
        assert_eq!(out2, [0.25, 0.25]);
        assert_eq!(mon2, [2.0, 2.0]);
    }

    #[test]
    fn underrun_yields_silence_without_ending() {
        // Worker still running (no eof) but nothing decoded yet.
        let s = ClipStream::from_samples_live(Vec::new());
        assert!(!s.is_finished());
        let mut active = vec![unit(1, "x", s, false)];
        let mut out = [9.0f32; 4];
        let mut mon = [9.0f32; 4];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [0.0; 4]);
        assert_eq!(mon, [0.0; 4]);
        assert_eq!(active.len(), 1); // an underrun is not the end of the clip
        assert_eq!(active[0].frames_played, 0);
    }

    #[test]
    fn removed_only_when_eof_and_drained() {
        // Exactly one block of audio with eof already set.
        let s = ClipStream::from_samples(vec![1.0f32, 2.0, 3.0, 4.0]);
        let mut active = vec![unit(1, "x", s, false)];
        // Mix #1: outputs the samples. The finished check runs *before*
        // pulling, so the clip is still present although now drained.
        let mut out = [0.0f32; 4];
        let mut mon = [0.0f32; 4];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(active.len(), 1);
        assert!(active[0].stream.is_finished());
        // Mix #2: finds it finished (eof && ring empty), removes it → silence.
        let mut out2 = [9.0f32; 4];
        let mut mon2 = [9.0f32; 4];
        mix(&mut active, &mut out2, &mut mon2);
        assert_eq!(out2, [0.0; 4]);
        assert!(active.is_empty());

        // Drained but not eof (decoder still working) → stays, never removed.
        let live = ClipStream::from_samples_live(vec![1.0f32, 2.0, 3.0, 4.0]);
        let mut active = vec![unit(2, "y", live, false)];
        let mut out3 = [0.0f32; 4];
        let mut mon3 = [0.0f32; 4];
        mix(&mut active, &mut out3, &mut mon3);
        mix(&mut active, &mut out3, &mut mon3);
        assert_eq!(active.len(), 1);
        assert!(!active[0].stream.is_finished());
    }

    #[test]
    fn paused_clip_does_not_consume() {
        let s = ClipStream::from_samples(vec![1.0f32; 8]);
        let mut active = vec![unit(1, "x", s, true)];
        let before = active[0].stream.buffered();
        assert_eq!(before, 8);
        let mut out = [0.0f32; 4];
        let mut mon = [0.0f32; 4];
        mix(&mut active, &mut out, &mut mon);
        assert_eq!(active[0].frames_played, 0);
        assert_eq!(active[0].stream.buffered(), before);
    }
    #[test]
    fn clip_gains_change_applies_to_next_block() {
        let gains = Arc::new(ClipGains::new(1.0, 1.0, true));
        let s = ClipStream::from_samples(vec![1.0f32; 6]);
        let mut active = vec![with_gains(1, s, gains.clone())];
        let (mut out, mut mon) = ([0.0f32; 2], [0.0f32; 2]);
        mix(&mut active, &mut out, &mut mon);
        assert_eq!((out, mon), ([1.0, 1.0], [1.0, 1.0]));
        // A live change (e.g. a configure) lands on the very next block.
        gains.set(0.5, 2.0, true);
        mix(&mut active, &mut out, &mut mon);
        assert_eq!((out, mon), ([0.5, 0.5], [2.0, 2.0]));
        gains.set(0.25, 3.0, false);
        mix(&mut active, &mut out, &mut mon);
        assert_eq!((out, mon), ([0.25, 0.25], [0.0, 0.0]));
        assert_eq!(gains.load(), (0.25, 3.0, false));
    }

    /// A Playing streaming a fresh 48 kHz stereo ramp WAV of `frames`,
    /// returned once its worker has buffered ~1 s (or all) of it.
    fn ramp_playing(tag: &str, frames: u32) -> (Playing, std::path::PathBuf) {
        let path = temp_wav(tag);
        write_ramp_wav(&path, 48_000, 2, frames);
        let p = unit(1, tag, ClipStream::spawn(path.clone()), false);
        let want = (frames as usize * 2).min(90_000);
        let deadline = Instant::now() + Duration::from_secs(10);
        while p.stream.buffered() < want {
            assert!(Instant::now() < deadline, "worker never filled the ring");
            thread::sleep(Duration::from_millis(2));
        }
        (p, path)
    }

    /// Mix 10 ms blocks until one carries audio; returns that block.
    fn mix_until_audio(active: &mut Vec<Playing>) -> [f32; 960] {
        let (mut out, mut mon) = ([0.0f32; 960], [0.0f32; 960]);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            mix(active, &mut out, &mut mon);
            if out.iter().any(|&s| s != 0.0) {
                return out;
            }
            assert!(Instant::now() < deadline, "no audio after the seek");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn stream_seek_discards_stale_samples() {
        let (p, path) = ramp_playing("sb_seek_stale", 96_000);
        let mut active = vec![p];
        let (mut out, mut mon) = ([0.0f32; 960], [0.0f32; 960]);
        mix(&mut active, &mut out, &mut mon);
        // Start of the ramp; ~1 s of early audio is now buffered.
        assert!(out[0] < 0.01, "{}", out[0]);
        // Jump to 1.5 s: the position reflects it at once.
        active[0].seek(72_000);
        assert_eq!(active[0].frames_played, 72_000);
        let out = mix_until_audio(&mut active);
        let _ = std::fs::remove_file(&path);
        // The first sample is the source at 1.5 s, not stale buffered audio.
        assert!((out[0] - ramp(72_000, 96_000)).abs() < 1e-3, "{}", out[0]);
        let f = active[0].frames_played;
        assert!(f > 72_000 && f <= 72_000 + 480, "{f}");
    }

    #[test]
    fn rapid_seeks_land_on_the_latest() {
        let (p, path) = ramp_playing("sb_seek_rapid", 96_000);
        let mut active = vec![p];
        let (mut out, mut mon) = ([0.0f32; 960], [0.0f32; 960]);
        for pos in [24_000, 48_000, 12_000, 84_000] {
            active[0].seek(pos);
            mix(&mut active, &mut out, &mut mon);
        }
        let out = mix_until_audio(&mut active);
        let _ = std::fs::remove_file(&path);
        assert!((out[0] - ramp(84_000, 96_000)).abs() < 1e-3, "{}", out[0]);
        let f = active[0].frames_played;
        assert!(f > 84_000, "{f}");
    }

    #[test]
    fn seek_past_end_finishes_cleanly() {
        for (i, target) in [24_000u64, 480_000].into_iter().enumerate() {
            // 0.5 s clip, fully buffered (worker already at end of file).
            let (p, path) = ramp_playing(&format!("sb_seek_end{i}"), 24_000);
            let mut active = vec![p];
            let (mut out, mut mon) = ([0.0f32; 960], [0.0f32; 960]);
            mix(&mut active, &mut out, &mut mon);
            active[0].seek(target);
            let deadline = Instant::now() + Duration::from_secs(10);
            while !active.is_empty() {
                assert!(
                    Instant::now() < deadline,
                    "clip never finished after seeking to {target}"
                );
                mix(&mut active, &mut out, &mut mon);
                // Nothing stale (or past the end) plays after the seek.
                assert!(
                    out.iter().all(|&s| s == 0.0),
                    "audio after seeking to {target}"
                );
                thread::sleep(Duration::from_millis(2));
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn seek_while_paused_keeps_paused() {
        let (p, path) = ramp_playing("sb_seek_paused", 96_000);
        let mut active = vec![p];
        let (mut out, mut mon) = ([0.0f32; 960], [0.0f32; 960]);
        mix(&mut active, &mut out, &mut mon);
        active[0].paused = true;
        active[0].seek(48_000);
        let deadline = Instant::now() + Duration::from_secs(10);
        while active[0].stream.seek_pending() {
            assert!(Instant::now() < deadline, "seek never landed");
            mix(&mut active, &mut out, &mut mon);
            assert!(out.iter().all(|&s| s == 0.0));
            thread::sleep(Duration::from_millis(2));
        }
        // Landed while paused: still paused, parked at the target.
        for _ in 0..5 {
            mix(&mut active, &mut out, &mut mon);
            assert!(out.iter().all(|&s| s == 0.0));
            assert!(active[0].paused);
            assert_eq!(active[0].frames_played, 48_000);
            thread::sleep(Duration::from_millis(2));
        }
        // Resuming plays from the seek target.
        active[0].paused = false;
        let out = mix_until_audio(&mut active);
        let _ = std::fs::remove_file(&path);
        assert!((out[0] - ramp(48_000, 96_000)).abs() < 1e-3, "{}", out[0]);
    }
}
