//! Text-to-speech. A small `Synth` trait (list voices, synthesize text to mono
//! samples) with one implementation per voice family, routed by the voice id
//! prefix (`win:` Windows voices, `piper:` Piper voices). Jobs run one at a time on
//! their own thread; synthesis, WAV parsing and resampling to 48 kHz happen
//! there, and only a ready buffer (a `ClipStream`) is handed back to the
//! controller, which gives it to the soundboard like any other clip. Nothing
//! here runs on an audio thread.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;

use serde::Serialize;

use crate::audio::format::SAMPLE_RATE;
use crate::soundboard::ClipStream;

pub mod piper;
pub mod winrt;

/// Longest text spoken, in chars.
pub const MAX_TEXT_CHARS: usize = 1000;
/// Speech requests that may be outstanding at once: queued or being
/// synthesized here, plus finished ones waiting controller-side to play.
pub const MAX_PENDING: usize = 8;
const QUEUE_DEPTH: usize = MAX_PENDING;
/// Chars of the text shown in the Now Playing name.
const NAME_CHARS: usize = 30;

/// One selectable voice (`tts_voices` event entry).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Voice {
    /// Full id including the family prefix, e.g. `win:<Id>`.
    pub id: String,
    pub name: String,
    /// `"windows"` or `"piper"`.
    pub source: &'static str,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_mb: Option<u32>,
}

/// Mono synthesized speech at its native rate.
pub struct Audio {
    pub samples: Vec<f32>,
    pub rate: u32,
}

/// A voice family. `prefix` routes ids to it (`voices()` ids start with it).
pub trait Synth: Send + Sync {
    fn prefix(&self) -> &'static str;
    fn voices(&self) -> Vec<Voice>;
    /// Synthesize `text` with the voice `voice` (full id, prefix included) at
    /// `rate` (already clamped). Runs on the TTS thread.
    fn synthesize(&self, voice: &str, text: &str, rate: f32) -> Result<Audio, String>;
}

/// A finished job: the stream for the soundboard plus its Now Playing name.
pub struct Prepared {
    pub name: String,
    pub stream: ClipStream,
}

pub enum Done {
    Ready(Prepared),
    Failed(String),
}

struct Job {
    voice: String,
    text: String,
    rate: f32,
}

/// Trim and cap (in chars, never splitting one) the text; `None` if empty.
pub fn normalize_text(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(MAX_TEXT_CHARS).collect())
}

/// Speaking rate: default 1, clamped to 0.5..=2.
pub fn clamp_rate(rate: Option<f64>) -> f32 {
    match rate {
        Some(r) if r.is_finite() => r.clamp(0.5, 2.0) as f32,
        _ => 1.0,
    }
}

/// The voice families plus the worker thread that runs jobs.
pub struct Tts {
    synths: Vec<Arc<dyn Synth>>,
    jobs: SyncSender<Job>,
    done: Receiver<Done>,
    /// Submitted jobs whose result `poll` has not handed out yet.
    in_flight: AtomicUsize,
}

impl Tts {
    pub fn new(synths: Vec<Arc<dyn Synth>>) -> Tts {
        let (jobs, job_rx) = sync_channel::<Job>(QUEUE_DEPTH);
        let (done_tx, done) = channel::<Done>();
        let worker_synths = synths.clone();
        let spawned = thread::Builder::new().name("o2i-tts".into()).spawn(move || {
            // Ends when the `Tts` (and so `jobs`) is dropped.
            while let Ok(job) = job_rx.recv() {
                let result = match run_job(&worker_synths, &job) {
                    Ok(p) => Done::Ready(p),
                    Err(m) => Done::Failed(m),
                };
                if done_tx.send(result).is_err() {
                    return;
                }
            }
        });
        if let Err(e) = spawned {
            elog!("[tts] could not start the TTS thread: {e}");
        }
        Tts {
            synths,
            jobs,
            done,
            in_flight: AtomicUsize::new(0),
        }
    }

    /// The real families: Windows voices and Piper.
    pub fn system(piper: Arc<piper::Piper>) -> Tts {
        Tts::new(vec![Arc::new(winrt::WindowsSynth), piper])
    }

    /// Jobs submitted and not yet collected by `poll`.
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    fn route(&self, voice: &str) -> Option<&Arc<dyn Synth>> {
        self.synths.iter().find(|s| voice.starts_with(s.prefix()))
    }

    /// Every voice of every family.
    pub fn voices(&self) -> Vec<Voice> {
        self.synths.iter().flat_map(|s| s.voices()).collect()
    }

    /// `Some(installed)` for a listed voice, `None` for an unknown one.
    pub fn voice_installed(&self, voice: &str) -> Option<bool> {
        self.route(voice)?
            .voices()
            .iter()
            .find(|v| v.id == voice)
            .map(|v| v.installed)
    }

    /// Whether `voice` is an installed voice of a known family.
    #[cfg(test)]
    pub fn knows_voice(&self, voice: &str) -> bool {
        self.voice_installed(voice) == Some(true)
    }

    /// Queue a job (non-blocking). `text` is trimmed and capped here, `rate`
    /// clamped. Errors: unknown voice family, empty text, or a full queue.
    pub fn submit(&self, voice: &str, text: &str, rate: f64) -> Result<(), String> {
        let Some(text) = normalize_text(text) else {
            return Err("Nothing to say".into());
        };
        if self.route(voice).is_none() {
            return Err(format!("Unknown voice: {voice}"));
        }
        let job = Job {
            voice: voice.to_string(),
            text,
            rate: clamp_rate(Some(rate)),
        };
        if self.in_flight() >= MAX_PENDING {
            return Err("Too many speech requests queued".into());
        }
        self.jobs.try_send(job).map_err(|e| match e {
            TrySendError::Full(_) => "Too many speech requests queued".to_string(),
            TrySendError::Disconnected(_) => "Text to speech is unavailable".to_string(),
        })?;
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Finished jobs, in order, without blocking.
    pub fn poll(&self) -> Vec<Done> {
        let done: Vec<Done> = self.done.try_iter().collect();
        if !done.is_empty() {
            self.in_flight.fetch_sub(done.len(), Ordering::SeqCst);
        }
        done
    }
}

/// `TTS: <first 30 chars>`, control chars shown as spaces.
fn item_name(text: &str) -> String {
    let head: String = text
        .chars()
        .take(NAME_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    format!("TTS: {head}")
}

fn run_job(synths: &[Arc<dyn Synth>], job: &Job) -> Result<Prepared, String> {
    let synth = synths
        .iter()
        .find(|s| job.voice.starts_with(s.prefix()))
        .ok_or_else(|| format!("Unknown voice: {}", job.voice))?;
    let audio = synth.synthesize(&job.voice, &job.text, job.rate)?;
    if audio.samples.is_empty() || audio.rate == 0 {
        return Err("The voice produced no audio".into());
    }
    let mut mono = resample_mono(&audio.samples, audio.rate, SAMPLE_RATE)?;
    level_speech(&mut mono);
    let mut stereo = Vec::with_capacity(mono.len() * 2);
    for s in mono {
        let s = if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 };
        stereo.push(s);
        stereo.push(s);
    }
    Ok(Prepared {
        name: item_name(&job.text),
        stream: ClipStream::from_buffer(stereo),
    })
}

/// Speech levelling window: 10 ms at 48 kHz.
const LEVEL_WINDOW: usize = (SAMPLE_RATE as usize) / 100;
/// A window counts as speech when its RMS is above -60 dBFS.
const LEVEL_FLOOR_RMS: f32 = 0.001;
/// Target RMS over the speech part: -16 dBFS.
const LEVEL_TARGET_RMS: f32 = 0.158_489_32;
/// Peak ceiling after levelling: -1 dBFS.
const LEVEL_PEAK_CEIL: f32 = 0.891_250_9;
/// Largest boost: +24 dB.
const LEVEL_MAX_GAIN: f32 = 15.848_932;

/// Level mono 48 kHz speech in place (runs on the TTS thread, never on an
/// audio thread). The gain is the smallest of: the gain that brings the RMS
/// of the non-silent part to -16 dBFS, the gain that brings the peak to
/// -1 dBFS, and +24 dB. The non-silent part is every 10 ms window (the last
/// one may be shorter) whose RMS is above -60 dBFS. A buffer with no such
/// window (silent, empty or non-finite) is left unchanged.
pub fn level_speech(samples: &mut [f32]) {
    let mut sum_sq = 0.0f64;
    let mut count = 0usize;
    let mut peak = 0.0f32;
    for w in samples.chunks(LEVEL_WINDOW) {
        let sq: f64 = w.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
        if (sq / w.len() as f64).sqrt() > f64::from(LEVEL_FLOOR_RMS) {
            sum_sq += sq;
            count += w.len();
        }
        peak = w.iter().fold(peak, |m, v| m.max(v.abs()));
    }
    if count == 0 || !sum_sq.is_finite() || !peak.is_finite() || peak <= 0.0 {
        return;
    }
    let rms = (sum_sq / count as f64).sqrt() as f32;
    let gain = (LEVEL_TARGET_RMS / rms)
        .min(LEVEL_PEAK_CEIL / peak)
        .min(LEVEL_MAX_GAIN);
    if gain.is_finite() && gain > 0.0 {
        for v in samples.iter_mut() {
            *v *= gain;
        }
    }
}

/// Resample mono `src` from `from` Hz to `to` Hz.
pub fn resample_mono(src: &[f32], from: u32, to: u32) -> Result<Vec<f32>, String> {
    use rubato::{FftFixedIn, Resampler};
    if from == to {
        return Ok(src.to_vec());
    }
    const CHUNK: usize = 1024;
    let mut rs = FftFixedIn::<f32>::new(from as usize, to as usize, CHUNK, 2, 1)
        .map_err(|e| format!("resampler: {e}"))?;
    let expected = (src.len() as u64 * to as u64 / from as u64) as usize;
    let mut out: Vec<f32> = Vec::with_capacity(expected + 2 * CHUNK);
    let mut pos = 0;
    while src.len() - pos >= rs.input_frames_next() {
        let n = rs.input_frames_next();
        let res = rs
            .process(&[&src[pos..pos + n]], None)
            .map_err(|e| format!("resample: {e}"))?;
        out.extend_from_slice(&res[0]);
        pos += n;
    }
    let rest = [src[pos..].to_vec()];
    let res = rs
        .process_partial(Some(&rest), None)
        .map_err(|e| format!("resample: {e}"))?;
    out.extend_from_slice(&res[0]);
    // Flush the filter's tail, then drop its start-up delay.
    let res = rs
        .process_partial(None::<&[Vec<f32>]>, None)
        .map_err(|e| format!("resample: {e}"))?;
    out.extend_from_slice(&res[0]);
    let delay = rs.output_delay().min(out.len());
    out.drain(..delay);
    out.truncate(expected);
    Ok(out)
}

/// Parse a RIFF/WAVE file: PCM 8/16/24/32-bit or 32-bit float, any channel
/// count (mixed down to mono).
pub fn parse_wav(bytes: &[u8]) -> Result<Audio, String> {
    let bad = || "Unsupported audio from the voice".to_string();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // tag, channels, rate, bits
    let mut data: Option<&[u8]> = None;
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32_at(i + 4) as usize;
        let body = i + 8;
        let end = body.saturating_add(size).min(bytes.len());
        if id == b"fmt " && end - body >= 16 {
            fmt = Some((u16_at(body), u16_at(body + 2), u32_at(body + 4), u16_at(body + 14)));
        } else if id == b"data" {
            data = Some(&bytes[body..end]);
            break;
        }
        i = body.saturating_add(size).saturating_add(size & 1);
    }
    let ((tag, channels, rate, bits), data) = fmt.zip(data).ok_or_else(bad)?;
    if channels == 0 || rate == 0 || bits % 8 != 0 || bits == 0 {
        return Err(bad());
    }
    let width = (bits / 8) as usize;
    let decode = |c: &[u8]| -> Option<f32> {
        Some(match (tag, bits) {
            (1, 8) => (c[0] as f32 - 128.0) / 128.0,
            (1, 16) => i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0,
            (1, 24) => (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0,
            (1, 32) => i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0,
            (3, 32) => f32::from_le_bytes([c[0], c[1], c[2], c[3]]),
            _ => return None,
        })
    };
    let frame = width * channels as usize;
    let mut samples = Vec::with_capacity(data.len() / frame);
    for f in data.chunks_exact(frame) {
        let mut sum = 0.0;
        for ch in f.chunks_exact(width) {
            sum += decode(ch).ok_or_else(bad)?;
        }
        samples.push(sum / channels as f32);
    }
    Ok(Audio { samples, rate })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Mock synthesizer: records the (voice, text, rate) it was asked for and
    /// returns a mono 24 kHz buffer of 0.5 s at amplitude 0.5.
    struct Mock {
        seen: Mutex<Vec<(String, String, f32)>>,
        fail: bool,
    }

    impl Mock {
        fn new(fail: bool) -> Arc<Mock> {
            Arc::new(Mock {
                seen: Mutex::new(Vec::new()),
                fail,
            })
        }
    }

    impl Synth for Mock {
        fn prefix(&self) -> &'static str {
            "mock:"
        }
        fn voices(&self) -> Vec<Voice> {
            vec![Voice {
                id: "mock:a".into(),
                name: "Mock A".into(),
                source: "windows",
                installed: true,
                size_mb: None,
            }]
        }
        fn synthesize(&self, voice: &str, text: &str, rate: f32) -> Result<Audio, String> {
            self.seen
                .lock()
                .unwrap()
                .push((voice.to_string(), text.to_string(), rate));
            if self.fail {
                return Err("boom".into());
            }
            Ok(Audio {
                samples: vec![0.5; 12_000],
                rate: 24_000,
            })
        }
    }

    fn wait_done(tts: &Tts) -> Done {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(d) = tts.poll().into_iter().next() {
                return d;
            }
            assert!(Instant::now() < end, "no tts result");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn speak_empty_text_errors() {
        assert_eq!(normalize_text(""), None);
        assert_eq!(normalize_text("  \n\t "), None);
        assert_eq!(normalize_text("  hi  ").as_deref(), Some("hi"));
    }

    #[test]
    fn speak_caps_long_text() {
        // Chars, not bytes: 1500 two-byte chars cap at 1000 chars intact.
        let long = "é".repeat(1500);
        let t = normalize_text(&long).unwrap();
        assert_eq!(t.chars().count(), 1000);
        assert!(t.chars().all(|c| c == 'é'));

        let mock = Mock::new(false);
        let tts = Tts::new(vec![mock.clone()]);
        tts.submit("mock:a", &long, 1.0).unwrap();
        let _ = wait_done(&tts);
        let seen = mock.seen.lock().unwrap();
        assert_eq!(seen[0].1.chars().count(), 1000);
    }

    #[test]
    fn rate_clamped() {
        assert_eq!(clamp_rate(None), 1.0);
        assert_eq!(clamp_rate(Some(0.1)), 0.5);
        assert_eq!(clamp_rate(Some(9.0)), 2.0);
        assert_eq!(clamp_rate(Some(1.25)), 1.25);
        assert_eq!(clamp_rate(Some(f64::NAN)), 1.0);
        let mock = Mock::new(false);
        let tts = Tts::new(vec![mock.clone()]);
        tts.submit("mock:a", "hi", 7.0).unwrap();
        let _ = wait_done(&tts);
        assert_eq!(mock.seen.lock().unwrap()[0].2, 2.0);
    }

    #[test]
    fn routes_by_prefix_and_knows_voices() {
        let tts = Tts::new(vec![Mock::new(false)]);
        assert!(tts.knows_voice("mock:a"));
        assert!(!tts.knows_voice("mock:b"));
        assert!(!tts.knows_voice("win:a"));
        assert!(!tts.knows_voice(""));
        assert_eq!(tts.voices().len(), 1);
        assert!(tts.submit("win:a", "hi", 1.0).is_err());
    }

    #[test]
    fn tts_playing_item_shape() {
        let mock = Mock::new(false);
        let tts = Tts::new(vec![mock.clone()]);
        let text = "Hello there, this is a long sentence for naming";
        tts.submit("mock:a", text, 1.0).unwrap();
        let Done::Ready(p) = wait_done(&tts) else {
            panic!("expected a ready buffer");
        };
        assert_eq!(p.name, "TTS: Hello there, this is a long se");
        assert_eq!(p.name.chars().count(), 5 + 30);
        // 0.5 s at 24 kHz resampled to 48 kHz, stereo.
        let frames = p.stream.total_frames().unwrap();
        assert!((frames as i64 - 24_000).abs() < 64, "{frames}");
        // Mono is duplicated to both channels and plays out through the mixer.
        let gains = Arc::new(crate::soundboard::ClipGains::new(0.5, 2.0, true));
        let mut active = vec![crate::soundboard::Playing {
            id: 1,
            name: p.name.clone(),
            stream: p.stream,
            frames_played: 0,
            paused: false,
            gains,
        }];
        let (mut o, mut m, mut s) = ([0.0f32; 2], [0.0f32; 2], [0.0f32; 2]);
        // Skip the resampler's startup ramp.
        for _ in 0..4000 {
            crate::soundboard::mix_block_weighted(&mut active, &mut o, &mut m, &mut s);
        }
        // A constant 0.5 is levelled down to the -16 dBFS RMS target.
        let lv = LEVEL_TARGET_RMS;
        assert!((o[0] - 0.5 * lv).abs() < 0.01 && (o[1] - 0.5 * lv).abs() < 0.01, "{o:?}");
        assert!((m[0] - 2.0 * lv).abs() < 0.02, "{m:?}");
    }

    #[test]
    fn synth_failure_reports_error() {
        let tts = Tts::new(vec![Mock::new(true)]);
        tts.submit("mock:a", "hi", 1.0).unwrap();
        match wait_done(&tts) {
            Done::Failed(m) => assert!(m.contains("boom"), "{m}"),
            Done::Ready(_) => panic!("should fail"),
        }
    }

    #[test]
    fn resample_changes_length_and_keeps_level() {
        let src = vec![0.5f32; 22_050];
        let out = resample_mono(&src, 22_050, 48_000).unwrap();
        assert!((out.len() as i64 - 48_000).abs() < 8, "{}", out.len());
        assert!((out[24_000] - 0.5).abs() < 0.01);
        assert_eq!(resample_mono(&src, 48_000, 48_000).unwrap().len(), src.len());
    }

    #[test]
    fn parses_pcm16_wav() {
        let mut w = Vec::new();
        let data: Vec<u8> = [0i16, 16384, -16384].iter().flat_map(|s| s.to_le_bytes()).collect();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&22_050u32.to_le_bytes());
        w.extend_from_slice(&44_100u32.to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(data.len() as u32).to_le_bytes());
        w.extend_from_slice(&data);
        let a = parse_wav(&w).unwrap();
        assert_eq!(a.rate, 22_050);
        assert_eq!(a.samples, vec![0.0, 0.5, -0.5]);
        assert!(parse_wav(b"nope").is_err());
    }

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0).sin())
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    fn db(x: f32) -> f32 {
        20.0 * x.log10()
    }

    #[test]
    fn speech_level_quiet_buffer_raised() {
        // Sine at -28 dBFS peak (RMS -31): raised about 15 dB to -16 dBFS RMS,
        // under both the peak limit and the +24 dB cap.
        let mut x = sine(0.04, 48_000);
        level_speech(&mut x);
        assert!((db(rms(&x)) + 16.0).abs() < 0.1, "rms {}", db(rms(&x)));
    }

    #[test]
    fn speech_level_peak_capped() {
        // Spiky buffer: a quiet tone plus one loud click. Reaching -16 dBFS
        // RMS would push the click past -1 dBFS, so the peak limit wins.
        let mut x = sine(0.05, 48_000);
        x[100] = 0.5;
        level_speech(&mut x);
        assert!((db(peak(&x)) + 1.0).abs() < 0.01, "peak {}", db(peak(&x)));
        assert!(db(rms(&x)) < -16.0);
    }

    #[test]
    fn speech_level_silent_unchanged() {
        let mut z = vec![0.0f32; 4800];
        level_speech(&mut z);
        assert!(z.iter().all(|v| *v == 0.0));
        // Everything under the floor (-80 dBFS) is left alone too.
        let mut q = vec![0.0001f32; 4800];
        level_speech(&mut q);
        assert!(q.iter().all(|v| *v == 0.0001));
        let mut e: Vec<f32> = Vec::new();
        level_speech(&mut e);
        assert!(e.is_empty());
    }

    #[test]
    fn speech_level_boost_capped_24db() {
        // -57 dBFS RMS (above the -60 floor) would need +41 dB; gets +24 dB.
        let mut x = sine(0.002, 48_000); // peak -54 dBFS, rms -57
        let before = rms(&x);
        level_speech(&mut x);
        let gain = rms(&x) / before;
        assert!((db(gain) - 24.0).abs() < 0.01, "gain {} dB", db(gain));
        assert!(x.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn speech_level_ignores_silent_gaps() {
        // Half silence: levelled over the speech part only.
        let mut x = sine(0.04, 24_000);
        x.extend(vec![0.0; 24_000]);
        level_speech(&mut x);
        assert!((db(rms(&x[..24_000])) + 16.0).abs() < 0.1);
    }
}
