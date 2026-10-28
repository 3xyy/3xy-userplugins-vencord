use crate::dsp::params::DEFAULT_GATE_AUTO_MARGIN_DB;

/// Noise gate on the short-term RMS level, with a sustain rule and lookahead.
///
/// The detector measures the mean square of 5 ms sub-blocks of the
/// *undelayed* input and compares each sub-block's RMS with `threshold` (a
/// linear RMS on the same scale as the input meter, so the gate opens where
/// the UI draws its line).
/// - **Open:** after `SUSTAIN_BLOCKS` (8) consecutive sub-blocks at/above the
///   threshold. A sub-block counts if its own mean square reaches the
///   threshold, so a sound's partial first and last sub-blocks may count:
///   a sound of 30 ms or less never opens the gate (it covers at most 7
///   sub-blocks), one of about 45 ms or more (and clearly above the
///   threshold) always does. Keyboard clicks are a few ms to 20 ms.
/// - **Hold:** once open it stays open for `HOLD_SAMPLES` after the last
///   qualifying sub-block. While held, the hold is re-armed only by
///   `REARM_BLOCKS` (5, i.e. 25 ms) consecutive sub-blocks at/above the
///   threshold, so key clicks typed after speech don't keep it open.
///
/// The audio is delayed by `LOOKAHEAD` (40 ms, equal to the sustain) through
/// a preallocated ring, so the gate is open by the time the start of a word
/// is heard. That delay is the gate's added latency. The hold is counted on
/// the undelayed detector, so it includes the lookahead: the audio you hear
/// stays open 150 ms after the level drops. Manual and auto mode both use
/// it. Block boundaries are counted on the samples fed in, so any chain
/// block size works. Allocation-free after `new`, lock-free, O(1) per sample.
pub struct NoiseGate {
    /// Sum of squares of the detector sub-block in progress, and its length.
    block_sum: f32,
    block_len: usize,
    /// Consecutive detector sub-blocks at/above the threshold.
    run: u32,
    /// Samples left to stay open after the level dropped below the threshold.
    hold: u32,
    gain: f32,
    /// Lookahead delay line (`LOOKAHEAD` samples) and its write position.
    ring: Vec<f32>,
    pos: usize,
}

impl NoiseGate {
    /// Detector sub-block (5 ms at 48 kHz).
    const BLOCK: usize = 240;
    /// Sub-blocks at/above the threshold needed to open: 8 x 5 ms = 40 ms.
    const SUSTAIN_BLOCKS: u32 = 8;
    /// Sub-blocks at/above the threshold needed to re-arm a running hold:
    /// 5 x 5 ms = 25 ms (3 x 5 ms = 15 ms was not enough: a -20 dBFS click
    /// tail keeps 3 sub-blocks over the line and held the gate open).
    const REARM_BLOCKS: u32 = 5;
    /// Audio delay through the gate (40 ms at 48 kHz).
    pub const LOOKAHEAD: usize = 1_920;
    /// Stay open this long on the detector's clock: 150 ms of heard audio
    /// after the level drops below the threshold plus the lookahead, so soft
    /// word endings and short gaps between syllables aren't chopped.
    const HOLD_SAMPLES: u32 = 7_200 + Self::LOOKAHEAD as u32;

    pub fn new() -> Self {
        Self {
            block_sum: 0.0,
            block_len: 0,
            run: 0,
            hold: 0,
            gain: 1.0,
            ring: vec![0.0; Self::LOOKAHEAD],
            pos: 0,
        }
    }

    /// Forget the delayed audio and the detector's partial state, and close
    /// (the gate was bypassed; whatever is in the ring and the gain is stale).
    /// Allocation-free.
    pub fn flush(&mut self) {
        self.ring.fill(0.0);
        self.pos = 0;
        self.block_sum = 0.0;
        self.block_len = 0;
        self.run = 0;
        self.hold = 0;
        self.gain = 0.0;
    }

    /// Gate the signal against `threshold` (linear RMS) as described on the
    /// type: 40 ms sustain to open, 150 ms hold, 40 ms lookahead. In place;
    /// the output is the input delayed by `LOOKAHEAD` samples.
    pub fn process_rms(&mut self, samples: &mut [f32], threshold: f32) {
        // Gain smoothing per sample (open fast, close a touch slower).
        const GAIN_ATTACK: f32 = 0.01;
        const GAIN_RELEASE: f32 = 0.002;

        let threshold_sq = threshold * threshold * Self::BLOCK as f32;
        for s in samples.iter_mut() {
            let x = *s;
            // Detector on the undelayed sample; a NaN/inf sample is not
            // allowed to stick in the sum (and is not stored for replay).
            let xf = if x.is_finite() { x } else { 0.0 };
            self.block_sum += xf * xf;
            self.block_len += 1;
            if self.block_len == Self::BLOCK {
                let above = self.block_sum >= threshold_sq;
                self.block_sum = 0.0;
                self.block_len = 0;
                if above {
                    self.run = self.run.saturating_add(1);
                    if self.run >= Self::SUSTAIN_BLOCKS
                        || (self.hold > 0 && self.run >= Self::REARM_BLOCKS)
                    {
                        self.hold = Self::HOLD_SAMPLES;
                    }
                } else {
                    self.run = 0;
                }
            }
            let open = if self.hold > 0 {
                self.hold -= 1;
                true
            } else {
                false
            };
            let target = if open { 1.0 } else { 0.0 };
            let coef = if target > self.gain {
                GAIN_ATTACK
            } else {
                GAIN_RELEASE
            };
            self.gain += (target - self.gain) * coef;
            // Delay line: emit the sample from LOOKAHEAD samples ago.
            let delayed = self.ring[self.pos];
            self.ring[self.pos] = xf;
            self.pos += 1;
            if self.pos == Self::LOOKAHEAD {
                self.pos = 0;
            }
            *s = delayed * self.gain;
        }
    }

    /// Whether the gate is (mostly) open after the last processed sample.
    pub fn is_open(&self) -> bool {
        self.gain > 0.5
    }
}

/// Tracks the mic's noise floor (linear RMS) for the auto gate. Pure,
/// allocation-free, O(1) per call.
///
/// One `update` is one ~10 ms block (`MicChain` feeds it 480-sample blocks),
/// so the rates below are per 10 ms. It works in dB:
/// - **warm-up**: for `WARMUP_BLOCKS` (0.75 s) after the first block (or a
///   re-learn) it follows the level both ways (`WARMUP_COEF` of the gap per
///   block) and ignores the open flag: a first block far under the real
///   noise is corrected in ~0.15 s instead of the gate passing noise;
/// - a block quieter than the floor pulls it down fast: `FALL_COEF` of the
///   gap per block (20 dB lower is followed to within 2 dB in ~220 ms);
/// - a louder block with the gate closed lets it rise at `RISE_DB` per block
///   (5 dB/s), never past that block's level;
/// - while open (speech) it doesn't rise. A run of open blocks means the
///   floor may sit below the real noise:
///   - after `STEADY_BLOCKS` (1.5 s) open at a *steady* level (std of the
///     run's levels under `STEADY_STD_DB`; speech swings far more), it is
///     noise: the floor is re-learned (a new warm-up). 1.5 s lets held
///     vowels / hums through and still absorbs a noise jump within ~2 s.
///     (The std alone can't separate them: room noise ~2.3 dB, held
///     vowels ~3 dB - so the time does.);
///   - after `STUCK_BLOCKS` (2 s) open at an unsteady level it creeps up at
///     `STUCK_RISE_DB` (5 dB/s) until the gate can close;
/// - digital silence (below -120 dBFS, e.g. a muted mic) and non-finite
///   values carry no information and are skipped.
///
/// Fall-fast/rise-slow keeps mistakes cheap: a wrong rise (long speech) is
/// undone at the first pause. Near equilibrium it sits at about the noise's
/// median block level (within ~0.5 dB for broadband noise, ~2 dB under it
/// for very fluctuating rumble), so floor + 6 dB stays above the noise.
pub struct NoiseFloorTracker {
    floor_db: f32,
    initialized: bool,
    /// Warm-up blocks left.
    warmup: u32,
    /// Consecutive blocks seen with the gate open, and the running mean /
    /// sum of squared deviations (Welford) of their levels in dB.
    open_run: u32,
    run_mean_db: f32,
    run_m2: f32,
}

impl Default for NoiseFloorTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl NoiseFloorTracker {
    /// Blocks below this RMS (-120 dBFS) are digital silence: ignored.
    const SILENCE: f32 = 1e-6;
    const WARMUP_BLOCKS: u32 = 75;
    const WARMUP_COEF: f32 = 0.2;
    const FALL_COEF: f32 = 0.1;
    const RISE_DB: f32 = 0.05;
    const STEADY_BLOCKS: u32 = 150;
    const STEADY_STD_DB: f32 = 3.0;
    const STUCK_BLOCKS: u32 = 200;
    const STUCK_RISE_DB: f32 = 0.05;
    const MIN_DB: f32 = -120.0;
    const MAX_DB: f32 = 0.0;

    pub fn new() -> Self {
        Self {
            floor_db: Self::MIN_DB,
            initialized: false,
            warmup: 0,
            open_run: 0,
            run_mean_db: 0.0,
            run_m2: 0.0,
        }
    }

    /// Forget the floor; the next non-silent block re-initializes it (and
    /// starts a warm-up).
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// The current floor (linear RMS); 0.0 until the first non-silent block.
    pub fn floor(&self) -> f32 {
        if self.initialized {
            10f32.powf(self.floor_db / 20.0)
        } else {
            0.0
        }
    }

    fn clear_run(&mut self) {
        self.open_run = 0;
        self.run_mean_db = 0.0;
        self.run_m2 = 0.0;
    }

    /// Feed one block's RMS and whether the gate is open (speech); returns
    /// the updated floor (linear RMS).
    pub fn update(&mut self, block_rms: f32, gate_open: bool) -> f32 {
        if !block_rms.is_finite() || block_rms < Self::SILENCE {
            return self.floor();
        }
        let level_db = (20.0 * block_rms.log10()).clamp(Self::MIN_DB, Self::MAX_DB);
        if !self.initialized {
            self.floor_db = level_db;
            self.initialized = true;
            self.warmup = Self::WARMUP_BLOCKS;
            self.clear_run();
            return self.floor();
        }
        if self.warmup > 0 {
            self.warmup -= 1;
            self.floor_db += (level_db - self.floor_db) * Self::WARMUP_COEF;
            return self.floor();
        }
        if gate_open {
            self.open_run = self.open_run.saturating_add(1);
            let d = level_db - self.run_mean_db;
            self.run_mean_db += d / self.open_run as f32;
            self.run_m2 += d * (level_db - self.run_mean_db);
        } else {
            self.clear_run();
        }
        if level_db < self.floor_db {
            // Quieter: always follow (a lower floor never cuts speech).
            self.floor_db += (level_db - self.floor_db) * Self::FALL_COEF;
        } else if !gate_open {
            self.floor_db = (self.floor_db + Self::RISE_DB).min(level_db);
        } else if self.open_run >= Self::STEADY_BLOCKS
            && self.run_m2 < Self::STEADY_STD_DB * Self::STEADY_STD_DB * self.open_run as f32
        {
            // Open for 1.5 s on a steady level: that's noise, not speech.
            self.warmup = Self::WARMUP_BLOCKS;
            self.clear_run();
            self.floor_db += (level_db - self.floor_db) * Self::WARMUP_COEF;
        } else if self.open_run >= Self::STUCK_BLOCKS {
            self.floor_db = (self.floor_db + Self::STUCK_RISE_DB).min(level_db);
        }
        self.floor()
    }
}

/// The auto gate's threshold: `floor` raised by `margin_db` (clamped to
/// 0..40 dB; a non-finite margin uses the 6 dB default).
pub fn auto_threshold(floor: f32, margin_db: f32) -> f32 {
    let margin = if margin_db.is_finite() {
        margin_db.clamp(0.0, 40.0)
    } else {
        DEFAULT_GATE_AUTO_MARGIN_DB
    };
    floor * 10f32.powf(margin / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        if x.is_empty() {
            return 0.0;
        }
        (x.iter().map(|&v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn loud_signal_passes() {
        // Start gate fully closed (gain=0.0) so it must actually open via GAIN_ATTACK.
        let mut g = NoiseGate::new();
        g.gain = 0.0;
        let mut buf = vec![0.5f32; 4800]; // constant loud
        g.process_rms(&mut buf, 0.02);
        // After settling, gate should have opened; tail RMS close to 0.5.
        assert!(rms(&buf[2400..]) > 0.45, "tail rms = {}", rms(&buf[2400..]));
    }

    #[test]
    fn quiet_signal_is_silenced() {
        let mut g = NoiseGate::new();
        let mut buf = vec![0.001f32; 4800]; // below threshold
        g.process_rms(&mut buf, 0.02);
        assert!(
            rms(&buf[2400..]) < 0.0005,
            "tail rms = {}",
            rms(&buf[2400..])
        );
    }

    #[test]
    fn no_instant_jump_on_open() {
        // Gain ramps rather than snapping: first sample of a loud burst is attenuated.
        let mut g = NoiseGate::new();
        g.gain = 0.0;
        let mut buf = vec![1.0f32; 8];
        g.process_rms(&mut buf, 0.02);
        assert!(
            buf[0] < 0.2,
            "first sample should be ramped, got {}",
            buf[0]
        );
    }

    #[test]
    fn gate_recloses_after_loud_burst() {
        // Start closed; a loud burst opens the gate (and arms the hold); a
        // quiet signal under the threshold then closes it again: the 10 ms
        // mean square falls under the threshold in ~65 ms, then the 150 ms
        // hold runs out and the gain fades.
        let mut g = NoiseGate::new();
        g.gain = 0.0;
        // Phase 1: loud burst, the gate opens.
        let mut open_buf = vec![0.5f32; 2400];
        g.process_rms(&mut open_buf, 0.02);
        assert!(g.is_open());
        // Phase 2: 500 ms at 0.005 (12 dB under the threshold).
        let mut close_buf = vec![0.005f32; 24_000];
        g.process_rms(&mut close_buf, 0.02);
        // Still open (held) ~100 ms in; closed by 400-500 ms.
        assert!(close_buf[4_800] > 0.0045, "held: {}", close_buf[4_800]);
        assert!(!g.is_open());
        assert!(
            rms(&close_buf[19_200..]) < 0.0005 * 0.1,
            "gate should re-close; tail rms = {}",
            rms(&close_buf[19_200..])
        );
    }

    // ---- auto gate: noise-floor tracker (one update = one 10 ms block) ----

    /// Deterministic LCG in [0, 1).
    struct Lcg(u32);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32
        }
        /// Approximately standard-normal (Irwin-Hall, 12 uniforms).
        fn gauss(&mut self) -> f32 {
            (0..12).map(|_| self.next()).sum::<f32>() - 6.0
        }
    }

    /// Block RMS values around `level` with +/-`jitter` relative spread.
    fn blocks(level: f32, jitter: f32, n: usize, seed: u32) -> Vec<f32> {
        let mut r = Lcg(seed);
        (0..n)
            .map(|_| level * (1.0 + jitter * (2.0 * r.next() - 1.0)))
            .collect()
    }

    fn db(ratio: f32) -> f32 {
        20.0 * ratio.log10()
    }

    /// Speech-like block levels: 4 Hz syllables swinging ~0.05..0.45
    /// (about 20 dB) with +/-30 % jitter - unsteady, unlike noise.
    fn speech_blocks(n: usize, seed: u32) -> Vec<f32> {
        let mut r = Lcg(seed);
        (0..n)
            .map(|i| {
                let syl = (i as f32 * 2.0 * std::f32::consts::PI * 4.0 * 0.01)
                    .sin()
                    .abs();
                (0.4 * syl + 0.05) * (1.0 + 0.3 * (2.0 * r.next() - 1.0))
            })
            .collect()
    }

    #[test]
    fn noise_floor_converges_on_steady_noise() {
        // Fresh tracker on steady noise (0.01 RMS, +/-20 % block-to-block).
        let mut t = NoiseFloorTracker::new();
        let mut f = 0.0;
        for b in blocks(0.01, 0.2, 300, 1) {
            f = t.update(b, false);
        }
        assert!(
            (-2.0..=0.5).contains(&db(f / 0.01)),
            "floor {f} should settle near 0.01 ({} dB)",
            db(f / 0.01)
        );

        // Started 6 dB too low (a quiet first block), it rises to the noise
        // within a few seconds and then holds there.
        let mut t = NoiseFloorTracker::new();
        t.update(0.005, false);
        let seq = blocks(0.01, 0.2, 700, 2);
        for (i, &b) in seq.iter().enumerate() {
            let f = t.update(b, false);
            if i >= 500 {
                assert!(
                    (-2.0..=0.5).contains(&db(f / 0.01)),
                    "block {i}: floor {f} drifted ({} dB)",
                    db(f / 0.01)
                );
            }
        }
    }

    #[test]
    fn noise_floor_ignores_speech_bursts() {
        let mut t = NoiseFloorTracker::new();
        for b in blocks(0.01, 0.2, 300, 3) {
            t.update(b, false);
        }
        let f0 = t.floor();
        assert!(f0 > 0.007, "floor established: {f0}");
        // 1.5 s of loud speech while the gate is open: the floor must not move up.
        for b in speech_blocks(150, 4) {
            let f = t.update(b, true);
            assert!(f <= f0 * 1.0001, "speech raised the floor: {f0} -> {f}");
        }
        // Back to the same noise: still near 0.01.
        let mut f = 0.0;
        for b in blocks(0.01, 0.2, 100, 5) {
            f = t.update(b, false);
        }
        assert!((-2.0..=0.5).contains(&db(f / 0.01)), "floor {f}");
    }

    #[test]
    fn noise_floor_falls_quickly_when_quieter() {
        let mut t = NoiseFloorTracker::new();
        for b in blocks(0.01, 0.2, 300, 6) {
            t.update(b, false);
        }
        // The room gets 20 dB quieter: within 300 ms the floor is within 2 dB.
        let mut f = 0.0;
        for b in blocks(0.001, 0.1, 30, 7) {
            f = t.update(b, false);
        }
        assert!(
            f < 0.001 * 1.26,
            "floor should follow down quickly, got {f}"
        );
        assert!(f > 0.0008, "floor must not undershoot the new level: {f}");
    }

    #[test]
    fn noise_floor_warms_up_fast_from_a_low_first_block() {
        // The first block is 20 dB under the real noise (start, reset,
        // suppression toggle): every later block reads as "open", but the
        // warm-up ignores that and reaches the noise within 300 ms.
        let mut t = NoiseFloorTracker::new();
        for round in 0..2 {
            t.update(0.001, false);
            let mut f = 0.0;
            for b in blocks(0.01, 0.2, 30, 10 + round) {
                f = t.update(b, true);
            }
            assert!(
                (-2.0..=1.6).contains(&db(f / 0.01)),
                "round {round}: floor {f} after 300 ms ({} dB)",
                db(f / 0.01)
            );
            t.reset();
        }
    }

    #[test]
    fn noise_floor_relearns_a_steady_level_when_stuck_open() {
        // The noise jumps 20 dB (mic gain raised, a fan turns on): every
        // block now reads as "open". A steady level for 1.5 s is noise, not
        // speech (a held vowel rarely lasts that long), so the floor is
        // re-learned right after that - within 2 s.
        let mut t = NoiseFloorTracker::new();
        for b in blocks(0.01, 0.2, 300, 8) {
            t.update(b, false);
        }
        let f0 = t.floor();
        let loud = blocks(0.1, 0.2, 200, 9);
        for &b in &loud[..140] {
            t.update(b, true);
        }
        assert!(
            t.floor() <= f0 * 1.0001,
            "no jump before 1.5 s of steady level"
        );
        for &b in &loud[140..] {
            t.update(b, true);
        }
        let f = t.floor();
        assert!(
            (-2.0..=0.5).contains(&db(f / 0.1)),
            "floor {f} should re-learn the new level within 2 s"
        );
    }

    #[test]
    fn noise_floor_rises_slowly_when_stuck_open_on_an_unsteady_level() {
        // Stuck open on an unsteady (speech-like) level: nothing for 2 s,
        // then a slow 5 dB/s creep.
        let mut t = NoiseFloorTracker::new();
        for b in blocks(0.01, 0.2, 300, 12) {
            t.update(b, false);
        }
        let f0 = t.floor();
        let lv = speech_blocks(400, 13);
        for &b in &lv[..190] {
            t.update(b, true);
        }
        assert!(t.floor() <= f0 * 1.0001, "no rise during the first 2 s");
        for &b in &lv[190..] {
            t.update(b, true);
        }
        let rise = db(t.floor() / f0);
        assert!((7.0..=12.0).contains(&rise), "creep after 4 s: {rise} dB");
    }

    #[test]
    fn noise_floor_skips_digital_silence() {
        let mut t = NoiseFloorTracker::new();
        // Silence before any real block leaves the tracker uninitialized.
        assert_eq!(t.update(0.0, false), 0.0);
        for b in blocks(0.01, 0.2, 300, 9) {
            t.update(b, false);
        }
        let f0 = t.floor();
        assert!(f0 > 0.0, "initialized: {f0}");
        // A muted mic (exact zeros) is not a noise floor.
        for _ in 0..200 {
            t.update(0.0, false);
        }
        assert_eq!(t.floor(), f0);
        // Non-finite input is ignored too.
        assert_eq!(t.update(f32::NAN, false), f0);
        // reset() forgets the floor; the next real block re-initializes it.
        t.reset();
        assert_eq!(t.floor(), 0.0);
        assert!((t.update(0.004, false) - 0.004).abs() < 1e-6);
    }

    #[test]
    fn rms_detector_recovers_from_a_nan_sample() {
        let mut g = NoiseGate::new();
        let mut buf = vec![0.1f32; 480];
        buf[10] = f32::NAN;
        g.process_rms(&mut buf, 0.02);
        // Next block: the envelope was reset, a loud signal opens the gate.
        let mut loud = vec![0.3f32; 4_800];
        g.process_rms(&mut loud, 0.02);
        assert!(g.is_open());
        assert!(rms(&loud[2_400..]) > 0.25, "{}", rms(&loud[2_400..]));
    }

    #[test]
    fn rms_gate_holds_open_after_level_drops() {
        let sigma = 0.01f32;
        let mut r = Lcg(77);
        let noise: Vec<f32> = (0..28_800).map(|_| r.gauss() * sigma).collect();
        let thr = sigma * 2.0;
        let mut g = NoiseGate::new();
        // 100 ms of speech-level tone opens the gate...
        let mut tone: Vec<f32> = (0..4_800)
            .map(|i| (i as f32 * 0.05).sin() * 0.14 + noise[i])
            .collect();
        g.process_rms(&mut tone, thr);
        // ...then the level drops to the noise (below the threshold).
        let dry = noise[4_800..].to_vec();
        let mut tail = dry.clone();
        g.process_rms(&mut tail, thr);
        // 50-140 ms after the drop: still open (held), the tail passes.
        let (a, b) = (2_400, 6_720);
        assert!(
            rms(&tail[a..b]) > 0.9 * rms(&dry[a..b]),
            "held: {} vs {}",
            rms(&tail[a..b]),
            rms(&dry[a..b])
        );
        // 300-500 ms after: closed.
        assert!(
            rms(&tail[14_400..24_000]) < 0.1 * sigma,
            "closed after the hold"
        );
    }

    #[test]
    fn rms_gate_does_not_hold_for_a_brief_blip() {
        // A blip that lifts the 10 ms level over the threshold for only a
        // few ms (noise fluctuation, a click) may open the gate briefly, but
        // must not arm the 150 ms hold.
        let sigma = 0.01f32;
        let mut r = Lcg(91);
        let n = 48_000;
        let start = 24_000;
        let len = 144; // 3 ms
        let mut x: Vec<f32> = (0..n).map(|_| r.gauss() * sigma).collect();
        for (i, v) in x[start..start + len].iter_mut().enumerate() {
            *v += (i as f32 * 0.05).sin() * 4.0 * sigma * std::f32::consts::SQRT_2;
        }
        let mut g = NoiseGate::new();
        g.process_rms(&mut x, sigma * 2.0);
        let (a, b) = (start + len + 1_440, start + len + 6_240); // 30-130 ms after
        let w = rms(&x[a..b]);
        assert!(w < 0.1 * sigma, "blip held the gate open: {w}");
    }

    #[test]
    fn auto_threshold_is_floor_plus_margin() {
        assert!((auto_threshold(0.01, 6.0) - 0.019_953).abs() < 1e-5);
        assert!((auto_threshold(0.01, 0.0) - 0.01).abs() < 1e-7);
        assert!((auto_threshold(0.01, 20.0) - 0.1).abs() < 1e-6);
        // Out-of-range margins clamp to 0..40 dB; a non-finite one uses 6 dB.
        assert!((auto_threshold(0.01, -10.0) - 0.01).abs() < 1e-7);
        assert!((auto_threshold(0.01, 100.0) - 1.0).abs() < 1e-5);
        assert!((auto_threshold(0.01, f32::NAN) - 0.019_953).abs() < 1e-5);
        assert_eq!(auto_threshold(0.0, 6.0), 0.0);
    }

    /// Why the gate uses an RMS detector: its threshold is a *linear RMS*
    /// level (the meter's scale; auto: floor + 6 dB), but a Gaussian-like
    /// noise's peaks sit ~9-10 dB above its RMS, so a peak detector would
    /// never close here.
    #[test]
    fn rms_detector_closes_on_noise_at_an_rms_threshold() {
        let sigma = 0.01f32;
        let mut r = Lcg(42);
        let noise: Vec<f32> = (0..48_000).map(|_| r.gauss() * sigma).collect();
        let thr = sigma * 2.0; // floor + ~6 dB
        // The noise's peaks keep crossing the threshold (~4-5 % of samples).
        let crossings = noise[24_000..].iter().filter(|v| v.abs() >= thr).count();
        assert!(crossings > 500, "peaks over the threshold: {crossings}");

        let mut g = NoiseGate::new();
        let mut buf = noise.clone();
        g.process_rms(&mut buf, thr);
        assert!(
            rms(&buf[24_000..]) < 0.1 * sigma,
            "RMS detector must close on noise, tail rms = {}",
            rms(&buf[24_000..])
        );
        assert!(!g.is_open());

        // Speech-level tone (20 dB above the noise) opens it.
        let mut tone: Vec<f32> = (0..9_600)
            .map(|i| (i as f32 * 0.05).sin() * 0.14 + noise[i])
            .collect();
        let dry = rms(&tone[4_800..]);
        g.process_rms(&mut tone, thr);
        assert!(g.is_open());
        assert!(
            rms(&tone[4_800..]) > 0.95 * dry,
            "tone should pass, {} vs {dry}",
            rms(&tone[4_800..])
        );
    }

    /// Output energy of a `burst_ms` tone burst (12 dB over the line) that
    /// starts `offset` samples into the stream, through a fresh closed gate.
    fn burst_through_gate(burst_ms: usize, offset: usize) -> f32 {
        let mut x = vec![0.0f32; 4_800 + offset];
        x.extend((0..burst_ms * 48).map(|i| (i as f32 * 0.05).sin() * 0.3));
        x.extend(vec![0.0f32; 9_600]);
        let mut g = NoiseGate::new();
        g.gain = 0.0;
        g.process_rms(&mut x, 0.075);
        rms(&x) * (x.len() as f32).sqrt()
    }

    #[test]
    fn gate_opens_only_after_40ms_sustain() {
        // Sweep the burst's start across two detector sub-blocks (25 offsets,
        // 20 samples apart): short sounds never open the gate at any
        // alignment, long ones always do and are kept.
        let full = |ms: usize| 0.3 / std::f32::consts::SQRT_2 * ((ms * 48) as f32).sqrt();
        for k in 0..25 {
            let off = k * 20;
            for ms in [2, 5, 15, 30] {
                let e = burst_through_gate(ms, off);
                assert!(e < 0.05 * full(ms).max(1.0), "{ms} ms @ {off}: {e}");
            }
            let e = burst_through_gate(50, off);
            assert!(e > 0.3 * full(50), "50 ms @ {off}: {e} vs {}", full(50));
        }
    }

    #[test]
    fn heard_audio_gets_the_full_150ms_hold() {
        // The hold runs on the undelayed detector: it must include the 40 ms
        // lookahead, so the gate closes ~150 ms after the *heard* audio ends
        // (~190 ms after the input drops).
        let mut g = NoiseGate::new();
        let mut x = vec![0.5f32; 24_000];
        g.process_rms(&mut x, 0.02);
        let ms = |n: usize| n * 48;
        let mut open_at = |after_ms: usize, g: &mut NoiseGate| {
            let mut z = vec![0.0f32; ms(after_ms)];
            g.process_rms(&mut z, 0.02);
            g.is_open()
        };
        assert!(open_at(170, &mut g), "closed too early");
        assert!(!open_at(60, &mut g), "still open at 230 ms");
    }

    #[test]
    fn flush_closes_the_gate() {
        let mut g = NoiseGate::new();
        assert!(g.is_open());
        g.flush();
        assert!(!g.is_open());
    }
}
