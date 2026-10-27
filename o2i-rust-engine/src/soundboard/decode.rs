use std::path::Path;

use anyhow::{anyhow, Context, Result};

use crate::audio::format::SAMPLE_RATE;

pub fn resample_ratio(src_hz: u32, dst_hz: u32) -> f64 {
    dst_hz as f64 / src_hz as f64
}

/// Convert a planar set of channel buffers to interleaved stereo (duplicate mono;
/// take first two channels otherwise). Pure + testable.
pub fn planar_to_interleaved_stereo(planar: &[Vec<f32>]) -> Vec<f32> {
    match planar.len() {
        0 => Vec::new(),
        1 => {
            let m = &planar[0];
            let mut out = Vec::with_capacity(m.len() * 2);
            for &s in m {
                out.push(s);
                out.push(s);
            }
            out
        }
        _ => {
            let l = &planar[0];
            let r = &planar[1];
            let n = l.len().min(r.len());
            let mut out = Vec::with_capacity(n * 2);
            for i in 0..n {
                out.push(l[i]);
                out.push(r[i]);
            }
            out
        }
    }
}

type SymFormat = Box<dyn symphonia::core::formats::FormatReader>;

fn probe_file(path: &Path) -> Result<SymFormat> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path).with_context(|| format!("open {path:?}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("probe format")?;
    Ok(probed.format)
}

/// Clip duration in seconds from container metadata only (no decode).
pub fn probe_duration(path: &Path) -> Option<f64> {
    let format = probe_file(path).ok()?;
    let params = &format.default_track()?.codec_params;
    let n = params.n_frames?;
    let hz = params.sample_rate?;
    if hz == 0 {
        return None;
    }
    Some(n as f64 / hz as f64)
}

const RESAMPLE_CHUNK: usize = 1024;

/// `frames` at `from_hz` expressed at `to_hz`, rounded (no overflow, no panic).
fn convert_frames(frames: u64, from_hz: u64, to_hz: u64) -> u64 {
    if from_hz == 0 {
        return 0;
    }
    let v = (frames as u128 * to_hz as u128 + from_hz as u128 / 2) / from_hz as u128;
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// Streaming decoder: yields interleaved 48 kHz stereo f32 in bounded pieces.
pub struct ClipDecoder {
    format: SymFormat,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    src_hz: u32,
    /// The track's time base as `(numer, denom)` seconds per timestamp tick
    /// (`(1, src_hz)` when the container doesn't say); both non-zero.
    time_base: (u64, u64),
    total_frames: Option<u64>,
    resampler: Option<rubato::SincFixedIn<f32>>,
    /// Planar input frames not yet fed to the resampler (< RESAMPLE_CHUNK after each pump).
    pending_in: Vec<Vec<f32>>,
    /// Interleaved output produced but not yet handed to the caller.
    pending_out: std::collections::VecDeque<f32>,
    /// Input frames fed to the resampler / output frames it produced (for tail trim).
    in_frames: u64,
    out_frames: u64,
    /// Decoded source frames still to drop after an accurate seek (the reader
    /// lands on a packet at or before the target).
    skip_in: u64,
    eof: bool,
}

impl ClipDecoder {
    pub fn open(path: &Path) -> Result<ClipDecoder> {
        use symphonia::core::codecs::DecoderOptions;

        let format = probe_file(path)?;
        let track = format
            .default_track()
            .ok_or_else(|| anyhow!("no default track"))?;
        let track_id = track.id;
        let src_hz = track
            .codec_params
            .sample_rate
            .ok_or_else(|| anyhow!("unknown sample rate"))?;
        if src_hz == 0 {
            return Err(anyhow!("invalid sample rate"));
        }
        let time_base = match track.codec_params.time_base {
            Some(tb) if tb.numer > 0 && tb.denom > 0 => (tb.numer as u64, tb.denom as u64),
            _ => (1, src_hz as u64),
        };
        let total_frames = track
            .codec_params
            .n_frames
            .map(|n| (n as f64 * resample_ratio(src_hz, SAMPLE_RATE)).round() as u64);
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .context("make decoder")?;
        Ok(ClipDecoder {
            format,
            decoder,
            track_id,
            src_hz,
            time_base,
            total_frames,
            resampler: None,
            pending_in: Vec::new(),
            pending_out: std::collections::VecDeque::new(),
            in_frames: 0,
            out_frames: 0,
            skip_in: 0,
            eof: false,
        })
    }

    /// Jump to `pos_frames_48k` (48 kHz output frames). Sample-accurate in
    /// source frames: the reader seeks to a packet at or before the target and
    /// the remainder is decoded and dropped. Everything buffered for the old
    /// position is discarded and the resampler is reset, so the next `fill`
    /// starts at the target. A target at/after the end leaves the decoder at
    /// end of stream (the next `fill` reports done). Returns the position
    /// landed on, in 48 kHz frames. File I/O: call on a worker thread only.
    pub fn seek(&mut self, pos_frames_48k: u64) -> Result<u64> {
        use rubato::Resampler;
        use symphonia::core::errors::{Error as SymError, SeekErrorKind};
        use symphonia::core::formats::{SeekMode, SeekTo};

        self.pending_out.clear();
        for c in self.pending_in.iter_mut() {
            c.clear();
        }
        if let Some(rs) = self.resampler.as_mut() {
            rs.reset();
        }
        self.in_frames = 0;
        self.out_frames = 0;
        self.skip_in = 0;
        self.eof = false;

        if let Some(total) = self.total_frames {
            if pos_frames_48k >= total {
                self.eof = true;
                return Ok(total);
            }
        }
        let src_hz = self.src_hz as u64;
        let (numer, denom) = self.time_base;
        let target_src = convert_frames(pos_frames_48k, SAMPLE_RATE as u64, src_hz);
        // source frames -> timestamp ticks: frames / src_hz seconds / (numer / denom).
        let ts = convert_frames(target_src, src_hz * numer, denom);
        let seeked = match self.format.seek(
            SeekMode::Accurate,
            SeekTo::TimeStamp {
                ts,
                track_id: self.track_id,
            },
        ) {
            Ok(s) => s,
            Err(SymError::SeekError(SeekErrorKind::OutOfRange)) => {
                self.eof = true;
                return Ok(self.total_frames.unwrap_or(pos_frames_48k));
            }
            Err(e) => return Err(anyhow!(e).context("seek")),
        };
        self.decoder.reset();
        let to_src = |t: u64| convert_frames(t, denom, src_hz * numer);
        let required = to_src(seeked.required_ts);
        self.skip_in = required.saturating_sub(to_src(seeked.actual_ts));
        Ok(convert_frames(required, src_hz, SAMPLE_RATE as u64))
    }

    /// Output frames at 48 kHz, if the container reports a length.
    pub fn total_frames(&self) -> Option<u64> {
        self.total_frames
    }

    /// Append up to `max_samples` interleaved stereo samples to `out`.
    /// Returns true once the stream is exhausted and fully drained.
    pub fn fill(&mut self, out: &mut Vec<f32>, max_samples: usize) -> Result<bool> {
        let want = (max_samples & !1).max(2);
        let mut added = 0usize;
        loop {
            while added < want {
                match self.pending_out.pop_front() {
                    Some(s) => {
                        out.push(s);
                        added += 1;
                    }
                    None => break,
                }
            }
            if added >= want {
                return Ok(false);
            }
            if self.eof {
                return Ok(true);
            }
            self.pump()?;
        }
    }

    /// Decode one more packet (or flush at end of stream) into `pending_out`.
    fn pump(&mut self) -> Result<()> {
        use symphonia::core::audio::SampleBuffer;
        use symphonia::core::errors::Error as SymError;

        let packet = match self.format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return self.finish();
            }
            Err(SymError::ResetRequired) => return self.finish(),
            Err(e) => return Err(anyhow!(e).context("read packet")),
        };
        if packet.track_id() != self.track_id {
            return Ok(());
        }
        let decoded = match self.decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => return Ok(()), // skip corrupt packet
            Err(e) => return Err(anyhow!(e).context("decode")),
        };
        let spec = *decoded.spec();
        let actual_ch = spec.channels.count();
        if actual_ch == 0 {
            return Ok(());
        }
        let mut sb = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sb.copy_planar_ref(decoded);
        let data = sb.samples();
        let frames = data.len() / actual_ch;
        // After an accurate seek, drop the frames before the target.
        let skip = (self.skip_in.min(frames as u64)) as usize;
        self.skip_in -= skip as u64;
        if skip == frames {
            return Ok(());
        }
        // Only the first two channels are used; the count is fixed by the first packet.
        if self.pending_in.is_empty() {
            self.pending_in = vec![Vec::new(); actual_ch.min(2)];
        }
        for (c, buf) in self.pending_in.iter_mut().enumerate() {
            if c < actual_ch {
                buf.extend_from_slice(&data[c * frames + skip..(c + 1) * frames]);
            } else {
                buf.resize(buf.len() + frames - skip, 0.0);
            }
        }
        self.drain_input(false)
    }

    fn finish(&mut self) -> Result<()> {
        self.drain_input(true)?;
        self.eof = true;
        Ok(())
    }

    /// Move buffered input to `pending_out`, resampling when needed.
    fn drain_input(&mut self, flush: bool) -> Result<()> {
        use rubato::{
            Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
            WindowFunction,
        };

        if self.pending_in.is_empty() {
            return Ok(());
        }
        if self.src_hz == SAMPLE_RATE {
            let n = self.pending_in.len();
            let planar = std::mem::replace(&mut self.pending_in, vec![Vec::new(); n]);
            self.pending_out
                .extend(planar_to_interleaved_stereo(&planar));
            return Ok(());
        }
        if self.resampler.is_none() {
            let params = SincInterpolationParameters {
                sinc_len: 64,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 32,
                window: WindowFunction::BlackmanHarris2,
            };
            self.resampler = Some(
                SincFixedIn::<f32>::new(
                    resample_ratio(self.src_hz, SAMPLE_RATE),
                    // max_resample_ratio_relative: 8.0 covers ~6 kHz -> 48 kHz so low-rate
                    // clips (8/11.025/16/22.05 kHz) are not rejected with RatioOutOfBounds.
                    8.0,
                    params,
                    RESAMPLE_CHUNK,
                    self.pending_in.len(),
                )
                .context("build resampler")?,
            );
        }
        let Some(rs) = self.resampler.as_mut() else {
            return Ok(());
        };
        while self.pending_in[0].len() >= RESAMPLE_CHUNK {
            let chunk: Vec<Vec<f32>> = self
                .pending_in
                .iter()
                .map(|c| c[..RESAMPLE_CHUNK].to_vec())
                .collect();
            let res = rs.process(&chunk, None).context("resample")?;
            self.in_frames += RESAMPLE_CHUNK as u64;
            self.out_frames += res.first().map_or(0, |c| c.len()) as u64;
            self.pending_out.extend(planar_to_interleaved_stereo(&res));
            for c in self.pending_in.iter_mut() {
                c.drain(..RESAMPLE_CHUNK);
            }
        }
        if flush && !self.pending_in[0].is_empty() {
            let tail_in = self.pending_in[0].len() as u64;
            let mut res = rs
                .process_partial(Some(&self.pending_in), None)
                .context("resample tail")?;
            // process_partial pads to a full chunk; keep only the real signal
            // (input length * ratio, plus the filter delay).
            self.in_frames += tail_in;
            let target = (self.in_frames as f64 * resample_ratio(self.src_hz, SAMPLE_RATE))
                .round() as u64
                + rs.output_delay() as u64;
            let keep = target.saturating_sub(self.out_frames) as usize;
            for c in res.iter_mut() {
                c.truncate(keep);
            }
            self.pending_out.extend(planar_to_interleaved_stereo(&res));
            for c in self.pending_in.iter_mut() {
                c.clear();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::Path;

    /// Write a 16-bit PCM WAV containing a 440 Hz sine.
    pub(crate) fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, frames: u32) {
        let mut data = Vec::with_capacity((frames as usize) * channels as usize * 2);
        for i in 0..frames {
            let t = i as f32 / sample_rate as f32;
            let v = ((t * 440.0 * std::f32::consts::TAU).sin() * 0.5 * i16::MAX as f32) as i16;
            for _ in 0..channels {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        write_wav_bytes(path, sample_rate, channels, &data);
    }

    /// Value a ramp WAV (see `write_ramp_wav`) holds at `frame` of `frames`.
    pub(crate) fn ramp(frame: u64, frames: u64) -> f32 {
        frame as f32 / frames as f32 * 0.8
    }

    /// Write a 16-bit PCM WAV whose channels all ramp linearly from 0 to 0.8
    /// over the file, so a decoded sample's value encodes its position.
    pub(crate) fn write_ramp_wav(path: &Path, sample_rate: u32, channels: u16, frames: u32) {
        let mut data = Vec::with_capacity((frames as usize) * channels as usize * 2);
        for i in 0..frames {
            let v = (ramp(i as u64, frames as u64) * i16::MAX as f32) as i16;
            for _ in 0..channels {
                data.extend_from_slice(&v.to_le_bytes());
            }
        }
        write_wav_bytes(path, sample_rate, channels, &data);
    }

    fn write_wav_bytes(path: &Path, sample_rate: u32, channels: u16, data: &[u8]) {
        let block = channels * 2;
        let mut f = Vec::new();
        f.extend_from_slice(b"RIFF");
        f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        f.extend_from_slice(b"WAVEfmt ");
        f.extend_from_slice(&16u32.to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes());
        f.extend_from_slice(&channels.to_le_bytes());
        f.extend_from_slice(&sample_rate.to_le_bytes());
        f.extend_from_slice(&(sample_rate * block as u32).to_le_bytes());
        f.extend_from_slice(&block.to_le_bytes());
        f.extend_from_slice(&16u16.to_le_bytes());
        f.extend_from_slice(b"data");
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(data);
        std::fs::write(path, f).expect("write test wav");
    }

    /// Unique temp path per test name + process id (parallel-safe).
    pub(crate) fn temp_wav(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("o2i_{}_{}.wav", name, std::process::id()))
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::{ramp, temp_wav, write_ramp_wav, write_test_wav};
    use super::*;

    fn decode_all(path: &Path, chunk: usize) -> Vec<f32> {
        let mut d = ClipDecoder::open(path).unwrap();
        let mut out = Vec::new();
        while !d.fill(&mut out, chunk).unwrap() {}
        out
    }

    #[test]
    fn stream_decode_44k_mono_one_second() {
        let p = temp_wav("mono44");
        write_test_wav(&p, 44_100, 1, 44_100);
        let out = decode_all(&p, 4096);
        let _ = std::fs::remove_file(&p);
        assert_eq!(out.len() % 2, 0);
        assert!(((out.len() / 2) as i64 - 48_000).abs() <= 600, "{}", out.len() / 2);
        for k in 0..out.len() / 2 {
            assert_eq!(out[2 * k], out[2 * k + 1]);
        }
    }

    #[test]
    fn stream_decode_48k_stereo_passthrough_length() {
        let p = temp_wav("st48");
        write_test_wav(&p, 48_000, 2, 24_000);
        let out = decode_all(&p, 4096);
        let _ = std::fs::remove_file(&p);
        assert!(((out.len() / 2) as i64 - 24_000).abs() <= 1, "{}", out.len() / 2);
    }

    #[test]
    fn fill_respects_max_samples() {
        let p = temp_wav("maxs");
        write_test_wav(&p, 44_100, 1, 44_100);
        let mut d = ClipDecoder::open(&p).unwrap();
        let mut out = Vec::new();
        d.fill(&mut out, 1000).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(out.len() <= 1000 && !out.is_empty());
    }

    #[test]
    fn total_frames_known_for_wav() {
        let p = temp_wav("totf");
        write_test_wav(&p, 44_100, 1, 44_100);
        let d = ClipDecoder::open(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        let n = d.total_frames().expect("known");
        assert!((n as i64 - 48_000).abs() <= 600, "{n}");
    }

    #[test]
    fn decoder_seek_lands_near_target() {
        // 48 kHz stereo: no resampler, so the seek is sample-exact.
        let p = temp_wav("seek48");
        write_ramp_wav(&p, 48_000, 2, 48_000);
        let mut d = ClipDecoder::open(&p).unwrap();
        let mut out = Vec::new();
        d.fill(&mut out, 4096).unwrap(); // play a little first
        assert_eq!(d.seek(24_000).unwrap(), 24_000);
        out.clear();
        d.fill(&mut out, 512).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!((out[0] - ramp(24_000, 48_000)).abs() < 1e-3, "{}", out[0]);
        assert!((out[2] - ramp(24_001, 48_000)).abs() < 1e-3, "{}", out[2]);

        // 44.1 kHz mono: resampled; lands within one resampler chunk.
        let p = temp_wav("seek44");
        write_ramp_wav(&p, 44_100, 1, 44_100);
        let mut d = ClipDecoder::open(&p).unwrap();
        out.clear();
        d.fill(&mut out, 4096).unwrap();
        let actual = d.seek(24_000).unwrap();
        assert!((actual as i64 - 24_000).abs() <= 2, "{actual}");
        out.clear();
        while out.len() < 2 * 600 {
            if d.fill(&mut out, 4096).unwrap() {
                break;
            }
        }
        let _ = std::fs::remove_file(&p);
        // Past the resampler's start-up transient, the value is the source's
        // at ~0.5 s + k frames.
        let k = 400u64;
        let got = out[2 * k as usize];
        let want = ramp(24_000 + k, 48_000);
        let one_chunk = RESAMPLE_CHUNK as f32 / 44_100.0 * 0.8;
        assert!((got - want).abs() < one_chunk, "got {got}, want {want}");
        // Seeking back to the start works too.
        let p = temp_wav("seek44b");
        write_ramp_wav(&p, 44_100, 1, 44_100);
        let mut d = ClipDecoder::open(&p).unwrap();
        d.seek(36_000).unwrap();
        assert_eq!(d.seek(0).unwrap(), 0);
        out.clear();
        d.fill(&mut out, 2048).unwrap();
        let _ = std::fs::remove_file(&p);
        let v = out[2 * 400];
        assert!(v.abs() < ramp(400 + 1024, 48_000), "{v}");
    }

    #[test]
    fn decoder_seek_past_end_is_eof() {
        let p = temp_wav("seekend");
        write_ramp_wav(&p, 44_100, 1, 22_050);
        let mut d = ClipDecoder::open(&p).unwrap();
        let mut out = Vec::new();
        assert!(d.seek(10 * 48_000).is_ok());
        let done = d.fill(&mut out, 4096).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(done, "a seek past the end leaves nothing to decode");
        assert!(out.is_empty(), "{} samples", out.len());
    }

    #[test]
    fn open_missing_file_errors() {
        assert!(ClipDecoder::open(Path::new("Z:/nope.wav")).is_err());
    }

    #[test]
    fn probe_duration_wav() {
        let p = temp_wav("probe");
        write_test_wav(&p, 44_100, 1, 44_100);
        let d = probe_duration(&p);
        let _ = std::fs::remove_file(&p);
        assert!((d.expect("known") - 1.0).abs() < 0.01);
    }

    #[test]
    fn ratio_44k_to_48k() {
        assert!((resample_ratio(44_100, 48_000) - 1.0884).abs() < 0.001);
        assert!((resample_ratio(48_000, 48_000) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn mono_duplicates_to_stereo() {
        let out = planar_to_interleaved_stereo(&[vec![0.1, 0.2, 0.3]]);
        assert_eq!(out, vec![0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    }

    #[test]
    fn stereo_interleaves_first_two() {
        let out = planar_to_interleaved_stereo(&[vec![0.1, 0.2], vec![0.5, 0.6], vec![9.0, 9.0]]);
        assert_eq!(out, vec![0.1, 0.5, 0.2, 0.6]);
    }
}
