//! Per-clip streaming playback. Each playing clip owns a decoder worker thread
//! that fills an SPSC ring; the soundboard mixing thread pulls from the ring
//! without locking or allocating. File I/O, decoding and seeking never run on
//! the mixing thread.
//!
//! Seeking: the consumer (mixing thread) publishes a target and bumps a seek
//! generation; the worker seeks its decoder, records how many samples it had
//! pushed before the seek (the boundary) and publishes the generation as done.
//! The consumer then skips the ring up to that boundary (allocation-free);
//! everything after it is audio from the new position.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use super::decode::ClipDecoder;
use crate::audio::format::CHANNELS;

/// Per-clip ring capacity: 1 s of interleaved 48 kHz stereo.
const RING_SAMPLES: usize = 96_000;
/// The worker decodes and pushes this many samples per refill.
const CHUNK_SAMPLES: usize = 4096;
/// Worker back-off while the ring has no room for a whole chunk.
const REFILL_SLEEP: Duration = Duration::from_millis(5);
/// `total_frames` sentinel: length unknown (or decoder not opened yet).
const UNKNOWN_FRAMES: u64 = u64::MAX;

/// State shared between a `ClipStream` and its worker thread.
struct Shared {
    /// Set by the stream owner: the worker exits at its next check.
    stop: AtomicBool,
    /// Set by the worker after its final push (or on failure). Release/Acquire
    /// so a reader that sees `eof` also sees every sample pushed before it.
    eof: AtomicBool,
    failed: AtomicBool,
    /// No worker is running (it could not be spawned, or it panicked), so
    /// seek requests will never be answered.
    worker_gone: AtomicBool,
    total_frames: AtomicU64,
    /// Seek target in 48 kHz frames; written before `seek_req`.
    seek_target: AtomicU64,
    /// Latest seek generation requested by the consumer (Release).
    seek_req: AtomicU64,
    /// Latest seek generation the worker has executed (Release, after
    /// `seek_boundary`/`seek_pos` for it).
    seek_done: AtomicU64,
    /// Samples the worker had pushed when it executed `seek_done`: ring
    /// contents before this count are stale.
    seek_boundary: AtomicU64,
    /// Position (48 kHz frames) the `seek_done` seek landed on.
    seek_pos: AtomicU64,
}

impl Shared {
    fn new() -> Shared {
        Shared {
            stop: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            worker_gone: AtomicBool::new(false),
            total_frames: AtomicU64::new(UNKNOWN_FRAMES),
            seek_target: AtomicU64::new(0),
            seek_req: AtomicU64::new(0),
            seek_done: AtomicU64::new(0),
            seek_boundary: AtomicU64::new(0),
            seek_pos: AtomicU64::new(0),
        }
    }

    fn mark_failed(&self) {
        self.failed.store(true, Ordering::Release);
        self.eof.store(true, Ordering::Release);
    }
}

/// Outcome of `ClipStream::poll_seek`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SeekPoll {
    /// No seek in flight.
    Idle,
    /// The worker hasn't executed the latest seek yet; hold (no audio).
    Pending,
    /// The latest seek landed: stale audio was discarded and the ring now
    /// continues from this position (48 kHz frames).
    Landed(u64),
}

/// A clip being decoded on its own worker thread into a 1 s ring of
/// interleaved 48 kHz stereo f32. Dropping it (or calling `stop`) tells the
/// worker to exit.
pub struct ClipStream {
    cons: HeapCons<f32>,
    shared: Arc<Shared>,
    /// Latest seek generation this side requested.
    seek_req: u64,
    /// Seek generation whose stale-audio discard has been applied
    /// (`!= seek_req` while a seek is in flight).
    seek_applied: u64,
    /// Samples popped or skipped from the ring so far (pairs with the
    /// worker's pushed count for the seek boundary).
    popped: u64,
}

impl ClipStream {
    /// Start streaming `path`. Never blocks on file I/O and never fails here:
    /// the worker opens the decoder itself, and on any open/decode error it
    /// logs it (`elog!`) and marks the stream `failed` + finished.
    pub fn spawn(path: PathBuf) -> ClipStream {
        let (prod, cons) = HeapRb::<f32>::new(RING_SAMPLES).split();
        let shared = Arc::new(Shared::new());
        let worker_shared = shared.clone();
        let spawned = thread::Builder::new()
            .name("o2i-clip-decode".into())
            .spawn(move || run_worker(&path, prod, &worker_shared));
        if let Err(e) = spawned {
            elog!("[soundboard] could not start clip decoder thread: {e}");
            shared.worker_gone.store(true, Ordering::Release);
            shared.mark_failed();
        }
        Self::with_parts(cons, shared)
    }

    fn with_parts(cons: HeapCons<f32>, shared: Arc<Shared>) -> ClipStream {
        ClipStream {
            cons,
            shared,
            seek_req: 0,
            seek_applied: 0,
            popped: 0,
        }
    }

    /// Pop up to `dst.len()` buffered samples into the front of `dst`; returns
    /// how many were written (`dst[n..]` is left untouched). Pops nothing
    /// while a seek is in flight (the ring still holds stale audio).
    /// Non-blocking and allocation-free, so safe on the mixing thread.
    pub fn pop_into(&mut self, dst: &mut [f32]) -> usize {
        if self.seek_pending() {
            return 0;
        }
        let n = self.cons.pop_slice(dst);
        self.popped += n as u64;
        n
    }

    /// Ask the worker to jump to `pos_frames` (48 kHz frames). Only the latest
    /// request matters. Two atomic stores, safe on the mixing thread; the
    /// seek itself runs on the worker. Call `poll_seek` each block to learn
    /// when it landed.
    pub fn request_seek(&mut self, pos_frames: u64) {
        self.seek_req = self.seek_req.wrapping_add(1);
        self.shared.seek_target.store(pos_frames, Ordering::Relaxed);
        self.shared.seek_req.store(self.seek_req, Ordering::Release);
    }

    /// True between `request_seek` and the `poll_seek` that reports it landed.
    pub fn seek_pending(&self) -> bool {
        self.seek_applied != self.seek_req
    }

    /// Resolve an in-flight seek: once the worker has executed the latest
    /// request, skip the stale samples buffered before it and report where it
    /// landed. Lock-free and allocation-free, so safe on the mixing thread.
    pub fn poll_seek(&mut self) -> SeekPoll {
        if !self.seek_pending() {
            return SeekPoll::Idle;
        }
        if self.shared.seek_done.load(Ordering::Acquire) != self.seek_req {
            if self.shared.worker_gone.load(Ordering::Acquire) {
                // Nobody will answer: drop the request; the stream is failed
                // (eof) and simply plays out what it has.
                self.seek_applied = self.seek_req;
                return SeekPoll::Idle;
            }
            return SeekPoll::Pending;
        }
        // Written before `seek_done` (Acquire above), and the worker can't
        // move on to a newer generation until this side requests one.
        let boundary = self.shared.seek_boundary.load(Ordering::Relaxed);
        let pos = self.shared.seek_pos.load(Ordering::Relaxed);
        let stale = boundary.saturating_sub(self.popped);
        let skipped = self.cons.skip(usize::try_from(stale).unwrap_or(usize::MAX));
        self.popped += skipped as u64;
        self.seek_applied = self.seek_req;
        // Nothing past the boundary is popped while pending, so `extra` is 0
        // in practice; kept so the position can never run backwards.
        let extra = self.popped.saturating_sub(boundary) / CHANNELS as u64;
        SeekPoll::Landed(pos.saturating_add(extra))
    }

    /// True once the worker has finished (end of file or failure) **and**
    /// every sample it produced has been popped. Never while a seek is in
    /// flight (the seek may rewind a finished decoder).
    pub fn is_finished(&self) -> bool {
        if self.seek_pending() {
            return false;
        }
        // eof first: its Acquire makes all pushes before it visible, so an
        // empty ring afterwards really is drained (not just not-yet-filled).
        self.shared.eof.load(Ordering::Acquire) && self.cons.is_empty()
    }

    /// True if the clip could not be opened or decoding failed part-way.
    #[cfg_attr(not(test), allow(dead_code))] // public stream API; no window caller yet
    pub fn failed(&self) -> bool {
        self.shared.failed.load(Ordering::Acquire)
    }

    /// Clip length in 48 kHz output frames, once the worker has opened the
    /// file and if the container reports a length.
    pub fn total_frames(&self) -> Option<u64> {
        match self.shared.total_frames.load(Ordering::Acquire) {
            UNKNOWN_FRAMES => None,
            n => Some(n),
        }
    }

    /// Tell the worker to exit. Idempotent; also done on drop. Buffered
    /// samples stay poppable.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }

    /// Samples currently buffered in the ring.
    #[cfg(test)]
    pub fn buffered(&self) -> usize {
        self.cons.occupied_len()
    }

    /// Test stream: pre-filled with `samples`, eof set, no worker thread.
    #[cfg(test)]
    pub fn from_samples(samples: Vec<f32>) -> ClipStream {
        let s = Self::from_samples_live(samples);
        s.shared.eof.store(true, Ordering::Release);
        s
    }

    /// Test stream: pre-filled with `samples` but eof NOT set, modelling a
    /// worker that has not produced anything further yet. No thread.
    #[cfg(test)]
    pub fn from_samples_live(samples: Vec<f32>) -> ClipStream {
        let (mut prod, cons) = HeapRb::<f32>::new(samples.len().max(2)).split();
        prod.push_slice(&samples);
        let shared = Arc::new(Shared::new());
        shared
            .total_frames
            .store((samples.len() / 2) as u64, Ordering::Release);
        Self::with_parts(cons, shared)
    }
}

impl Drop for ClipStream {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Worker body: runs until the stream is stopped/dropped, so this thread
/// normally holds the last reference to the ring and frees its buffer here,
/// not on the mixing thread when the finished clip is removed there. A panic
/// in the decoder is contained: the stream is marked failed and the worker
/// keeps the ring until stopped.
fn run_worker(path: &Path, mut prod: HeapProd<f32>, shared: &Shared) {
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        stream_until_stopped(path, &mut prod, shared)
    }));
    if run.is_err() {
        elog!("[soundboard] clip decoder panicked: {}", path.display());
        shared.worker_gone.store(true, Ordering::Release);
        shared.mark_failed();
        while !shared.stop.load(Ordering::Relaxed) {
            thread::sleep(REFILL_SLEEP);
        }
    }
}

/// Open the decoder, then until `stop`: execute seek requests, and keep the
/// ring topped up in `CHUNK_SAMPLES` pieces until end of file or failure. The
/// decoder stays open after end of file so a seek can rewind it.
fn stream_until_stopped(path: &Path, prod: &mut HeapProd<f32>, shared: &Shared) {
    let mut dec = match ClipDecoder::open(path) {
        Ok(d) => Some(d),
        Err(e) => {
            elog!("[soundboard] cannot open clip {}: {e:#}", path.display());
            shared.mark_failed();
            None
        }
    };
    if let Some(n) = dec.as_ref().and_then(|d| d.total_frames()) {
        shared.total_frames.store(n, Ordering::Release);
    }
    let mut decoding = dec.is_some();
    // Samples pushed so far, and the last seek generation executed.
    let mut pushed: u64 = 0;
    let mut handled: u64 = 0;
    let mut chunk: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES);
    loop {
        if shared.stop.load(Ordering::Relaxed) {
            return;
        }
        // Acquire pairs with the consumer's Release: the target read below is
        // at least as new as the generation read here.
        let req = shared.seek_req.load(Ordering::Acquire);
        if req != handled {
            let target = shared.seek_target.load(Ordering::Relaxed);
            let landed = match dec.as_mut().map(|d| d.seek(target)) {
                Some(Ok(pos)) => {
                    // Decoding resumes from the new position (it reports eof
                    // again at once if that is the end).
                    shared.eof.store(false, Ordering::Relaxed);
                    decoding = true;
                    pos
                }
                Some(Err(e)) => {
                    elog!("[soundboard] seek failed in {}: {e:#}", path.display());
                    shared.mark_failed();
                    dec = None;
                    decoding = false;
                    target
                }
                // Failed earlier: nothing to seek; the consumer discards the
                // stale tail and the clip ends.
                None => target,
            };
            shared.seek_boundary.store(pushed, Ordering::Relaxed);
            shared.seek_pos.store(landed, Ordering::Relaxed);
            shared.seek_done.store(req, Ordering::Release);
            handled = req;
            continue;
        }
        let Some(d) = dec.as_mut().filter(|_| decoding) else {
            thread::sleep(REFILL_SLEEP);
            continue;
        };
        if prod.vacant_len() < CHUNK_SAMPLES {
            thread::sleep(REFILL_SLEEP);
            continue;
        }
        chunk.clear();
        match d.fill(&mut chunk, CHUNK_SAMPLES) {
            Ok(done) => {
                // `fill` appends at most CHUNK_SAMPLES and this thread is the
                // ring's only producer (free space only grows meanwhile), so
                // it all fits.
                pushed += prod.push_slice(&chunk) as u64;
                if done {
                    shared.eof.store(true, Ordering::Release);
                    decoding = false;
                }
            }
            Err(e) => {
                elog!("[soundboard] decode error in {}: {e:#}", path.display());
                shared.mark_failed();
                dec = None;
                decoding = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soundboard::decode::test_util::{temp_wav, write_test_wav};
    use std::time::{Duration, Instant};

    #[test]
    fn spawned_stream_plays_wav_to_end() {
        let p = temp_wav("stream_play");
        write_test_wav(&p, 44_100, 1, 11_025); // 0.25 s
        let mut s = ClipStream::spawn(p.clone());
        let mut buf = [0.0f32; 960];
        let mut total = 0usize;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !s.is_finished() {
            assert!(Instant::now() < deadline, "stream never finished");
            total += s.pop_into(&mut buf);
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = std::fs::remove_file(&p);
        assert!(!s.failed());
        let expected = (0.25 * 48_000.0 * 2.0) as i64;
        assert!((total as i64 - expected).abs() <= 600 * 2, "{total}");
        let frames = s.total_frames().expect("wav length known");
        assert!((frames as i64 - 12_000).abs() <= 600, "{frames}");
    }

    #[test]
    fn spawn_missing_file_fails_and_finishes() {
        let p = temp_wav("stream_missing"); // never written
        let _ = std::fs::remove_file(&p);
        let s = ClipStream::spawn(p);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !(s.failed() && s.is_finished()) {
            assert!(
                Instant::now() < deadline,
                "missing file did not fail within 1 s"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(s.total_frames().is_none());
    }
}
