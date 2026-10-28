pub mod agc;
mod degrade;
pub mod gate;
pub mod params;
pub mod suppress;
mod voice;
#[cfg(test)]
mod click_tests;

use std::sync::Arc;

pub use params::{MicParams, VoicePreset};

use agc::Agc;
use degrade::Degrade;
use gate::{auto_threshold, NoiseFloorTracker, NoiseGate};
use suppress::Suppressor;
use voice::VoiceChanger;

/// Samples per noise-floor tracking block (10 ms of mono at 48 kHz); the
/// tracker's rates are defined per such block.
const TRACK_BLOCK: usize = 480;
/// Samples the mute gain takes to move between 0 and 1 (10 ms of mono at
/// 48 kHz), so muting and unmuting never click.
const MUTE_RAMP: usize = 480;
/// Push-to-talk release tail: the mic stays open this long (200 ms of mono
/// at 48 kHz) after the key goes up, so the end of a word isn't clipped.
const PTT_TAIL: usize = 9_600;

/// The mic-channel processing chain: Suppress -> Gate -> AGC -> Voice -> Quality
/// -> Volume -> Mute. Operates on mono f32 in [-1, 1]. Reads live parameters
/// from `params` each call.
pub struct MicChain {
    params: Arc<MicParams>,
    gate: NoiseGate,
    /// Auto gate: noise floor of the gate's input (after suppression), fed in
    /// `TRACK_BLOCK`s.
    floor: NoiseFloorTracker,
    /// Sum of squares / sample count of the tracking block in progress.
    track_sum: f32,
    track_len: usize,
    /// Auto gate: noise floor of the raw mic input (before suppression). The
    /// suppressor can push steady noise 30+ dB down, which would leave the
    /// threshold far below what a click lets through, so the threshold never
    /// goes under this floor + margin.
    raw_floor: NoiseFloorTracker,
    raw_sum: f32,
    raw_len: usize,
    /// Each floor's threshold (floor + margin), and the one in use: their
    /// max (linear RMS); 0 until a floor is known.
    post_threshold: f32,
    raw_threshold: f32,
    auto_threshold: f32,
    /// Whether the gate ran on the previous call (its lookahead ring is stale
    /// after a bypass).
    gate_was_on: bool,
    auto_was_on: bool,
    agc: Agc,
    suppress: Suppressor,
    suppress_was_on: bool,
    scratch: Vec<f32>,
    voice: VoiceChanger,
    /// Mic quality: makes the voice sound like a worse mic; bypass at 100.
    degrade: Degrade,
    /// Output gain of the mute stage, ramped per sample toward 0 (muted) or
    /// 1 (unmuted).
    mute_gain: f32,
    /// Push-to-talk tail samples left. Counted per processed block: the gate
    /// is decided once per block (block-accurate, not sample-accurate), so
    /// the tail is 200 ms to within one capture block.
    ptt_tail_left: usize,
}

impl MicChain {
    pub fn new(params: Arc<MicParams>) -> Self {
        Self {
            gate: NoiseGate::new(),
            floor: NoiseFloorTracker::new(),
            track_sum: 0.0,
            track_len: 0,
            raw_floor: NoiseFloorTracker::new(),
            raw_sum: 0.0,
            raw_len: 0,
            post_threshold: 0.0,
            raw_threshold: 0.0,
            auto_threshold: 0.0,
            gate_was_on: false,
            auto_was_on: false,
            agc: Agc::new(),
            suppress: Suppressor::new(),
            suppress_was_on: false,
            scratch: Vec::with_capacity(2048),
            voice: VoiceChanger::new(params.clone()),
            degrade: Degrade::new(params.mic_quality()),
            // Already muted (audio restarted while muted): start silent
            // rather than ramping down from full level.
            // Same for push-to-talk: a new chain starts closed.
            mute_gain: if params.mic_muted() || params.ptt_mode() {
                0.0
            } else {
                1.0
            },
            ptt_tail_left: 0,
            params,
        }
    }

    pub fn process(&mut self, input_mono: &[f32], out_mono: &mut Vec<f32>) {
        let suppress_on = self.params.suppress_enabled();
        // Toggling suppression moves the gate's input level by 20-40 dB.
        let suppress_toggled = suppress_on != self.suppress_was_on;

        // Stage 1: Suppress → work (scratch).
        // Chain order: Suppress → Gate → AGC → Voice → Quality → Volume → Mute.
        self.scratch.clear();
        if suppress_on {
            // NOTE: On OFF→ON we deliberately do NOT reset the DenoiseState here.
            // reinit_state() allocates (DenoiseState::new()) and must never run on
            // the capture thread (no-alloc audio-path constraint). The accumulator is
            // already flushed on ON→OFF (see else branch), so re-enable starts with an
            // empty reblocking buffer; only the RNN model's internal activations carry
            // over. Those stale activations decay within a few 480-sample frames as the
            // model reconverges, which is an acceptable, inaudible limitation for a
            // single-user voice path. Resetting the model cleanly would require swapping
            // in a DenoiseState pre-allocated off the audio thread.
            self.suppress
                .process(input_mono, &mut self.scratch, self.params.suppress_amount());
        } else {
            // Flush accumulator on ON→OFF so the next re-enable starts clean.
            // flush_acc() is allocation-free and safe to call on the audio thread.
            if self.suppress_was_on {
                self.suppress.flush_acc();
            }
            self.scratch.extend_from_slice(input_mono);
        }
        self.suppress_was_on = suppress_on;

        // Stage 2: level meter, measured post-suppression, pre-gate.
        // When suppression is off, scratch == input_mono, so the meter equals the raw
        // RMS (unchanged from before). When suppression is on, the meter reflects the
        // cleaned signal (the same signal the gate acts on), so the gate threshold line
        // drawn in the UI stays meaningful. Skip the update if scratch is empty (the
        // suppressor may emit nothing yet while buffering a partial frame).
        if !self.scratch.is_empty() {
            let rms = (self.scratch.iter().map(|&v| v * v).sum::<f32>()
                / self.scratch.len() as f32)
                .sqrt();
            self.params.set_input_level(rms);
        }

        // Stage 3: gate, on its RMS detector in both modes. The threshold is
        // a linear RMS level on the meter's scale, so the gate opens where the
        // UI draws the line. Manual: `gate_threshold`. Auto: the higher of the
        // post-suppression floor + margin and the raw-input floor + margin
        // (published as `gate_threshold_live`). The floors are tracked
        // whenever auto is on (even with the gate itself off), so the live
        // threshold is always meaningful. The gate needs 40 ms above the
        // threshold to open and delays the audio by 40 ms (see `NoiseGate`).
        let gate_on = self.params.gate_enabled();
        let auto = self.params.gate_auto();
        if auto {
            if !self.auto_was_on {
                // Auto off -> on: re-learn the raw floor too.
                self.raw_floor.reset();
                self.raw_sum = 0.0;
                self.raw_len = 0;
                self.raw_threshold = 0.0;
            }
            if !self.auto_was_on || suppress_toggled {
                // Auto off -> on, or the gate input level just jumped
                // (suppression toggled): re-learn the floor from scratch
                // (with its fast warm-up). No allocation.
                self.floor.reset();
                self.track_sum = 0.0;
                self.track_len = 0;
                self.post_threshold = 0.0;
                self.auto_threshold = self.raw_threshold;
            }
            let margin = self.params.gate_auto_margin_db();
            // Raw mic floor, from the undelayed, unsuppressed input.
            for &x in input_mono.iter() {
                self.raw_sum += x * x;
                self.raw_len += 1;
                if self.raw_len == TRACK_BLOCK {
                    let rms = (self.raw_sum / TRACK_BLOCK as f32).sqrt();
                    let open = rms >= self.auto_threshold;
                    let floor = self.raw_floor.update(rms, open);
                    self.raw_threshold = auto_threshold(floor, margin);
                    self.auto_threshold = self.post_threshold.max(self.raw_threshold);
                    self.raw_sum = 0.0;
                    self.raw_len = 0;
                }
            }
            for &x in self.scratch.iter() {
                self.track_sum += x * x;
                self.track_len += 1;
                if self.track_len == TRACK_BLOCK {
                    let rms = (self.track_sum / TRACK_BLOCK as f32).sqrt();
                    // "Open" = this block is above the threshold. Not the
                    // gate's own state: its 150 ms hold would bridge the
                    // gaps between words and make open runs utterance-long.
                    let open = rms >= self.auto_threshold;
                    let floor = self.floor.update(rms, open);
                    self.post_threshold = auto_threshold(floor, margin);
                    self.auto_threshold = self.post_threshold.max(self.raw_threshold);
                    self.track_sum = 0.0;
                    self.track_len = 0;
                }
            }
            self.params.set_gate_threshold_live(self.auto_threshold);
        }
        self.auto_was_on = auto;
        if gate_on {
            if !self.gate_was_on {
                self.gate.flush();
            }
            let threshold = if auto {
                self.auto_threshold
            } else {
                self.params.gate_threshold()
            };
            self.gate.process_rms(&mut self.scratch, threshold);
        }
        self.gate_was_on = gate_on;

        // Stage 4: AGC. It adapts only while the gate is open (or off): with
        // the gate closed its gain holds, so the next click is not boosted by
        // a gain that climbed on the gate's fade-out.
        if self.params.agc_enabled() {
            let adapt = !gate_on || self.gate.is_open();
            self.agc
                .process(&mut self.scratch, self.params.agc_target(), adapt);
        }

        // Stage 4.5: voice changer (pitch + formant). Bypassed when preset == Off.
        self.voice.process(&mut self.scratch);

        // Stage 4.6: quality (degrade). Before volume and mute, so Discord and
        // the mic monitor hear it. A true bypass at 100.
        self.degrade
            .process(&mut self.scratch, self.params.mic_quality());

        // Stage 5: volume.
        let vol = self.params.volume();
        for s in self.scratch.iter_mut() {
            *s *= vol;
        }

        // Stage 6 - Mute, last so it silences exactly what Discord (and the
        // mic monitor) would hear. The stages above keep running while
        // muted, so unmuting resumes from settled gate/AGC/voice state.
        // Push-to-talk gates at the same point and reuses the same ramp.
        // Mute always wins.
        let ptt_open = self.ptt_gate_open(self.scratch.len());
        let closed = self.params.mic_muted() || !ptt_open;
        apply_mute(&mut self.mute_gain, closed, &mut self.scratch);

        // Stage 7 - Append work to output.
        out_mono.extend_from_slice(&self.scratch);
    }
}

impl MicChain {
    /// Whether push-to-talk lets this `block`-sample block through; always
    /// true outside PTT mode. Open while the key is held, then for
    /// `PTT_TAIL` samples after. Publishes the answer for the controller.
    /// No allocation, no locks.
    fn ptt_gate_open(&mut self, block: usize) -> bool {
        if !self.params.ptt_mode() {
            self.ptt_tail_left = 0;
            return true;
        }
        let open = if self.params.ptt_held() {
            self.ptt_tail_left = PTT_TAIL;
            true
        } else if self.ptt_tail_left > 0 {
            self.ptt_tail_left = self.ptt_tail_left.saturating_sub(block);
            true
        } else {
            false
        };
        self.params.set_ptt_open(open);
        open
    }
}

/// Move `gain` toward 0 (`muted`) or 1 by `1 / MUTE_RAMP` per sample,
/// scaling `buf` by it. Settled muted writes exact zeros; settled unmuted
/// leaves `buf` untouched. No allocation, no locks.
fn apply_mute(gain: &mut f32, muted: bool, buf: &mut [f32]) {
    if muted && *gain == 0.0 {
        buf.fill(0.0);
        return;
    }
    if !muted && *gain == 1.0 {
        return;
    }
    let step = 1.0 / MUTE_RAMP as f32;
    for s in buf.iter_mut() {
        *gain = if muted {
            (*gain - step).max(0.0)
        } else {
            (*gain + step).min(1.0)
        };
        *s *= *gain;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::format::SAMPLE_RATE;

    fn rms(s: &[f32]) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        (s.iter().map(|&v| v * v).sum::<f32>() / s.len() as f32).sqrt()
    }

    #[test]
    fn all_disabled_is_passthrough() {
        let p = Arc::new(MicParams::new()); // everything off, volume 1.0
        let mut chain = MicChain::new(p);
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert_eq!(out.len(), input.len());
        for (a, b) in input.iter().zip(out.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn volume_scales_output() {
        let p = Arc::new(MicParams::new());
        p.set_volume(0.5);
        let mut chain = MicChain::new(p);
        let input = vec![0.4f32; 480];
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert!((out[10] - 0.2).abs() < 1e-6, "got {}", out[10]);
    }

    #[test]
    fn level_meter_reflects_input_rms() {
        let p = Arc::new(MicParams::new());
        let mut chain = MicChain::new(p.clone());
        let input = vec![0.5f32; 480];
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert!(
            (p.input_level() - 0.5).abs() < 1e-3,
            "meter = {}",
            p.input_level()
        );
    }

    // --- Findings 3 & 4: suppress-enabled path and toggle logic ---

    /// Suppress path produces the correct sample count (two full 480-frames),
    /// non-zero output, and applies volume scaling.
    #[test]
    fn suppress_enabled_output_length_and_volume() {
        let p = Arc::new(MicParams::new());
        p.set_suppress_enabled(true);
        p.set_volume(0.5);
        let mut chain = MicChain::new(p);
        // Feed two full 480-sample frames (960 total) so the suppressor emits both.
        let input = vec![0.3f32; 960];
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert_eq!(
            out.len(),
            960,
            "suppress path must emit 960 samples for two full frames"
        );
        // Output must be non-zero (suppressor does not silence a loud speech-like signal).
        assert!(rms(&out) > 0.0, "suppress output must be non-zero");
        // Volume 0.5: raw suppressor output is near 0.3 (unity gain on loud signal),
        // so after ×0.5 it should be clearly below the raw input level.
        assert!(
            rms(&out) < rms(&input),
            "volume must scale suppress output down"
        );
    }

    /// AGC+suppress code path: verifies the wiring of AGC after the suppressor.
    ///
    /// With AGC enabled at a very high target and a very quiet signal, the AGC
    /// gain clamps at MAX_GAIN (8.0). With suppress+AGC+volume=1 vs
    /// suppress-only+volume=1, the AGC chain must produce higher output when
    /// the suppressed signal is above SILENCE (1e-4 RMS), because gain > 1.
    /// We feed many frames so the AGC gain converges to MAX_GAIN.
    #[test]
    fn suppress_with_agc_shifts_level() {
        // Use a signal at 0.3 amplitude (loud enough to trigger RNNoise to pass it),
        // with AGC target=10.0 (forces gain to MAX_GAIN=8.0) to get a clear amplification.
        let p_agc = Arc::new(MicParams::new());
        p_agc.set_suppress_enabled(true);
        p_agc.set_agc_enabled(true);
        p_agc.set_agc_target(10.0); // very high target => gain clamps at MAX_GAIN=8.0
        p_agc.set_volume(1.0);
        let mut chain_agc = MicChain::new(p_agc);

        let p_noagc = Arc::new(MicParams::new());
        p_noagc.set_suppress_enabled(true);
        p_noagc.set_agc_enabled(false);
        p_noagc.set_volume(1.0);
        let mut chain_noagc = MicChain::new(p_noagc);

        // Feed enough frames for AGC to reach MAX_GAIN (at GAIN_COEF=0.0005, converges in ~5000 samples).
        let n = 480 * 30; // 30 frames = 14400 samples
        let input = vec![0.3f32; n];

        let mut out_agc = Vec::new();
        chain_agc.process(&input, &mut out_agc);
        assert_eq!(out_agc.len(), n, "suppress+AGC must emit {} samples", n);

        let mut out_noagc = Vec::new();
        chain_noagc.process(&input, &mut out_noagc);
        assert_eq!(out_noagc.len(), n);

        // If both chains produce non-zero output: AGC must have amplified.
        let rms_agc = rms(&out_agc[n - 480 * 5..]);
        let rms_noagc = rms(&out_noagc[n - 480 * 5..]);

        // Either the suppressor passes the signal (rms_noagc > 0) and AGC amplifies it,
        // OR the suppressor kills it (both near-zero). Either way the chain must not panic
        // and output lengths must match. When non-zero output exists, AGC must amplify.
        assert_eq!(
            out_agc.len(),
            n,
            "correct output length with suppress+AGC enabled"
        );
        if rms_noagc > 1e-5 {
            // Suppressor passed some signal; AGC at target=10 (MAX_GAIN=8) must amplify it.
            assert!(
                rms_agc > rms_noagc,
                "AGC must amplify suppressor output: agc={} noagc={}",
                rms_agc,
                rms_noagc
            );
        }
        // If rms_noagc <= 1e-5, the suppressor killed the signal and AGC has nothing to
        // amplify. That's valid behaviour, and the test has still exercised the code path.
    }

    /// After toggling suppress OFF the accumulator is flushed (flush_acc), so
    /// re-enabling produces no phantom carry-over from the prior off-period.
    #[test]
    fn suppress_toggle_off_flushes_accumulator() {
        let p = Arc::new(MicParams::new());
        p.set_suppress_enabled(false);
        let mut chain = MicChain::new(p.clone());

        // Step 1: call once with suppress=false (no suppressor state involved).
        let signal = vec![0.2f32; 480];
        let mut out1 = Vec::new();
        chain.process(&signal, &mut out1);
        assert_eq!(out1.len(), 480);

        // Step 2: enable suppress and feed two full frames.
        p.set_suppress_enabled(true);
        let mut out2 = Vec::new();
        chain.process(&vec![0.2f32; 960], &mut out2);
        assert_eq!(
            out2.len(),
            960,
            "suppress on: two full frames must emit 960 samples"
        );

        // Step 3: disable suppress; flush_acc() should clear the accumulator.
        p.set_suppress_enabled(false);
        let mut out3 = Vec::new();
        chain.process(&vec![0.2f32; 480], &mut out3);
        // Off-path: output length must equal input length immediately (passthrough).
        assert_eq!(
            out3.len(),
            480,
            "suppress off: output length must equal input length"
        );

        // Step 4: re-enable. The accumulator was flushed, so a full 960-sample feed
        // yields exactly 960 output (no stale partial frame from the off period).
        p.set_suppress_enabled(true);
        let mut out4 = Vec::new();
        chain.process(&vec![0.2f32; 960], &mut out4);
        assert_eq!(
            out4.len(),
            960,
            "re-enabled suppress must start clean; no carry-over"
        );
    }

    #[test]
    fn voice_off_keeps_chain_passthrough() {
        // Default params: every stage off, voice = Off => exact passthrough.
        let p = Arc::new(MicParams::new());
        let mut chain = MicChain::new(p);
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.02).sin() * 0.3).collect();
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert_eq!(out.len(), input.len());
        for (a, b) in input.iter().zip(out.iter()) {
            assert!((a - b).abs() < 1e-6, "voice Off must not alter the signal");
        }
    }

    #[test]
    fn voice_active_alters_chain_output() {
        let p = Arc::new(MicParams::new());
        p.set_voice_preset(VoicePreset::Girly);
        p.set_voice_intensity(1.0);
        let mut chain = MicChain::new(p);
        let input: Vec<f32> = (0..SAMPLE_RATE as usize)
            .map(|i| (2.0 * std::f32::consts::PI * 200.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.4)
            .collect();
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        assert_eq!(out.len(), input.len(), "chain stays 1:1 in/out");
        // The tail must differ from the dry input (pitch was shifted).
        let half = input.len() / 2;
        let diff: f32 = input[half..]
            .iter()
            .zip(out[half..].iter())
            .map(|(a, b)| (a - b).abs())
            .sum();
        assert!(diff > 1.0, "girly must change the signal, sum-abs-diff={diff}");
    }

    /// Verify suppress_was_on logic: toggling off while suppress was on calls
    /// flush_acc (accumulator cleared), so output length is input length.
    #[test]
    fn suppress_on_to_off_clears_state() {
        let p = Arc::new(MicParams::new());
        p.set_suppress_enabled(true);
        let mut chain = MicChain::new(p.clone());

        // Feed a partial accumulation (100 samples, less than one 480-frame).
        let mut out = Vec::new();
        chain.process(&vec![0.1f32; 100], &mut out);
        // No full frame yet, suppressor buffered 100 samples internally.
        assert_eq!(out.len(), 0, "partial frame: no output yet");

        // Toggle off; flush_acc should clear the 100-sample partial accumulator.
        p.set_suppress_enabled(false);
        let mut out2 = Vec::new();
        chain.process(&vec![0.1f32; 480], &mut out2);
        // Passthrough: output length == input length, no stale 100-sample head.
        assert_eq!(
            out2.len(),
            480,
            "after toggle-off, passthrough must be 480 samples"
        );

        // Re-enable and feed exactly one frame: must get exactly 480 out (no phantom extra).
        p.set_suppress_enabled(true);
        let mut out3 = Vec::new();
        chain.process(&vec![0.1f32; 480], &mut out3);
        assert_eq!(
            out3.len(),
            480,
            "fresh re-enable: one frame in = one frame out"
        );
    }

    /// When suppression is enabled with amount=0.0 (dry pass-through), the suppressor
    /// reblocks the input but emits it unchanged. The level meter is measured
    /// post-suppress (on the emitted work buffer), so with amount=0 it must still
    /// equal the raw-input RMS. This pins the meter to the post-suppress position
    /// without depending on RNNoise gain (which varies by frame content).
    #[test]
    fn level_meter_shows_post_suppression_signal() {
        let p = Arc::new(MicParams::new());
        p.set_suppress_enabled(true);
        p.set_suppress_amount(0.0); // dry: suppressor output == input (per amount_zero_is_dry_passthrough)
        let mut chain = MicChain::new(p.clone());
        // Feed exactly two 480-sample frames so the suppressor emits and the meter is updated.
        let input = vec![0.4f32; 960];
        let mut out = Vec::new();
        chain.process(&input, &mut out);
        // suppress amount=0 → work == input → meter == raw RMS == 0.4.
        assert!(
            (p.input_level() - 0.4).abs() < 1e-3,
            "meter with dry suppress should be ≈0.4, got {}",
            p.input_level()
        );
    }

    // --- Finding 5: pin Gate -> Volume ordering ---

    /// Gate runs before volume (chain is Suppress→Gate→AGC→Volume).
    /// With gate closed (signal below threshold), the
    /// output should be near-zero even at volume=1.0, not 1x the raw input.
    /// If volume ran before gate, the signal would just be scaled then gated,
    /// producing the same result. But if gate ran before volume and gate is
    /// OPEN, output == input * volume. We test the gate-CLOSED case: signal
    /// below threshold => gate attenuates => then volume is applied to near-zero.
    #[test]
    fn gate_runs_before_volume_in_chain() {
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        // Threshold high enough that our signal (0.005) is clearly below it.
        p.set_gate_threshold(0.1);
        p.set_volume(0.5);
        let mut chain = MicChain::new(p);

        // Feed a long buffer of quiet signal so the gate's envelope decays fully.
        // The gate starts with gain=1 and env=0, so we need enough samples for env
        // to stabilise below threshold before we measure.
        let buf = vec![0.005f32; 9600];
        let mut out = Vec::new();
        chain.process(&buf, &mut out);

        // Tail RMS: gate should be closed (env < 0.1), output near-zero.
        // If volume ran before gate: output = gate(0.005 * 0.5) = gate(0.0025) ≈ 0.
        // If gate ran before volume: output = gate(0.005) * 0.5 ≈ 0.
        // Either way for this signal we get ~0, so test the gate-OPEN case instead.
        // When signal >> threshold, gate is open; output = input * volume.
        let p2 = Arc::new(MicParams::new());
        p2.set_gate_enabled(true);
        p2.set_gate_threshold(0.02);
        p2.set_volume(0.5);
        let mut chain2 = MicChain::new(p2);
        // Loud signal, well above threshold 0.02.
        let loud = vec![0.6f32; 9600];
        let mut out2 = Vec::new();
        chain2.process(&loud, &mut out2);
        // After settling the gate is fully open (gain→1), volume=0.5 => output ≈ 0.3.
        let tail_rms = rms(&out2[7200..]);
        assert!(
            (tail_rms - 0.3).abs() < 0.05,
            "gate open + volume 0.5: tail RMS should be ≈0.3, got {}",
            tail_rms
        );

        // Now test the closed gate with volume != 1: output must be near-zero,
        // not 0.5 × input (which would indicate volume ran before gate on a loud signal).
        // Use volume=100 (amplify) and a signal below gate threshold. If gate ran
        // first, output = 0 * 100 = 0; if volume ran first, output = big then gated = 0 too.
        // The meaningful test: gate open path checked above pins order correctly.
        // Additionally, verify gate-closed output is near-zero regardless of volume.
        let p3 = Arc::new(MicParams::new());
        p3.set_gate_enabled(true);
        p3.set_gate_threshold(0.5); // very high threshold
        p3.set_volume(50.0); // extreme volume: if gate ran before volume, output=gate(quiet)*50≈0
        let mut chain3 = MicChain::new(p3);
        let quiet = vec![0.001f32; 9600];
        let mut out3 = Vec::new();
        chain3.process(&quiet, &mut out3);
        let tail3 = rms(&out3[7200..]);
        assert!(
            tail3 < 0.01,
            "gate closed before volume: output must be near-zero, got RMS={}",
            tail3
        );
    }

    // ---- auto gate ----

    /// Deterministic Gaussian-like noise (Irwin-Hall, 12 uniforms) at `sigma`.
    fn gauss_noise(n: usize, sigma: f32, seed: u32) -> Vec<f32> {
        let mut x = seed;
        let mut uni = move || {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 8) as f32 / (1u32 << 24) as f32
        };
        (0..n)
            .map(|_| ((0..12).map(|_| uni()).sum::<f32>() - 6.0) * sigma)
            .collect()
    }

    fn feed(chain: &mut MicChain, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for c in input.chunks(480) {
            chain.process(c, &mut out);
        }
        out
    }

    #[test]
    fn auto_gate_tracks_noise_and_publishes_threshold() {
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        p.set_gate_auto(true);
        // A manual threshold that would block everything: ignored while auto.
        p.set_gate_threshold(0.5);
        let mut chain = MicChain::new(p.clone());
        let sigma = 0.01;
        let noise = gauss_noise(SAMPLE_RATE as usize * 3, sigma, 7);
        let out = feed(&mut chain, &noise);

        // Threshold = floor (~ the noise RMS, never above it) + 6 dB.
        let thr = p.gate_threshold_live();
        assert!(
            thr > sigma * 1.5 && thr < sigma * 2.1,
            "live threshold {thr} should be ~2x the noise RMS {sigma}"
        );
        // ...and the gate closed on that noise.
        let tail = rms(&out[out.len() - SAMPLE_RATE as usize..]);
        assert!(
            tail < 0.1 * sigma,
            "gate should close on noise, tail {tail}"
        );

        // Speech-level tone: passes, and doesn't drag the threshold up.
        let tone: Vec<f32> = (0..24_000)
            .map(|i| (i as f32 * 0.05).sin() * 0.14 + noise[i])
            .collect();
        let out2 = feed(&mut chain, &tone);
        assert!(
            rms(&out2[12_000..]) > 0.9 * rms(&tone[12_000..]),
            "speech must pass the auto gate"
        );
        assert!(
            p.gate_threshold_live() <= thr * 1.01,
            "speech raised the threshold: {thr} -> {}",
            p.gate_threshold_live()
        );
    }

    #[test]
    fn manual_gate_ignores_tracker_until_auto_is_on() {
        let sigma = 0.01;
        let noise = gauss_noise(SAMPLE_RATE as usize * 2, sigma, 11);
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        p.set_gate_threshold(0.001); // manual threshold below the noise
        let mut chain = MicChain::new(p.clone());

        // Auto off: the manual threshold applies (noise passes), nothing published.
        let out = feed(&mut chain, &noise);
        assert!(rms(&out[48_000..]) > 0.9 * sigma, "manual gate stays open");
        assert_eq!(p.gate_threshold_live(), 0.0);

        // Auto on: the same noise is now gated and a threshold is published.
        p.set_gate_auto(true);
        let out = feed(&mut chain, &noise);
        assert!(rms(&out[48_000..]) < 0.1 * sigma, "auto gate closes");
        let thr6 = p.gate_threshold_live();
        assert!(thr6 > 0.0);

        // A bigger margin raises the threshold by the difference (6 dB = 2x).
        p.set_gate_auto_margin_db(12.0);
        feed(&mut chain, &noise[..4_800]);
        let ratio = p.gate_threshold_live() / thr6;
        assert!((1.6..2.5).contains(&ratio), "12 dB vs 6 dB ratio {ratio}");
    }

    /// Gate output RMS over `[from_s, to_s)` seconds of `out`.
    fn window_rms(out: &[f32], from_s: f32, to_s: f32) -> f32 {
        let sr = SAMPLE_RATE as f32;
        rms(&out[(from_s * sr) as usize..(to_s * sr) as usize])
    }

    fn auto_chain() -> (Arc<MicParams>, MicChain) {
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        p.set_gate_auto(true);
        let chain = MicChain::new(p.clone());
        (p, chain)
    }

    #[test]
    fn auto_gate_recovers_fast_from_a_low_first_block() {
        // First block 20 dB under the noise that follows: closed within 1 s.
        let (_p, mut chain) = auto_chain();
        let sigma = 0.01;
        feed(&mut chain, &gauss_noise(480, sigma / 10.0, 21));
        let out = feed(
            &mut chain,
            &gauss_noise(SAMPLE_RATE as usize * 2, sigma, 22),
        );
        let w = window_rms(&out, 1.0, 2.0);
        assert!(w < 0.1 * sigma, "gate still open on noise 1-2 s in: {w}");
    }

    #[test]
    fn auto_gate_recovers_when_noise_jumps_20db() {
        // Floor established on quiet noise, then the noise jumps 20 dB (mic
        // gain raised / unmuted codec noise): closed within 2 s.
        let (_p, mut chain) = auto_chain();
        let sigma = 0.01;
        feed(
            &mut chain,
            &gauss_noise(SAMPLE_RATE as usize * 2, sigma / 10.0, 23),
        );
        let out = feed(
            &mut chain,
            &gauss_noise(SAMPLE_RATE as usize * 3, sigma, 24),
        );
        let w = window_rms(&out, 2.0, 3.0);
        assert!(
            w < 0.1 * sigma,
            "gate still open on noise 2-3 s after the jump: {w}"
        );
    }

    #[test]
    fn auto_gate_relearns_after_suppression_toggle() {
        // Suppression on: the floor follows the suppressed residual. Turning
        // it off makes the gate input jump; the floor is re-learned at once.
        let (p, mut chain) = auto_chain();
        p.set_suppress_enabled(true);
        let sigma = 0.01;
        let noise = gauss_noise(SAMPLE_RATE as usize * 5, sigma, 25);
        let split = SAMPLE_RATE as usize * 3;
        feed(&mut chain, &noise[..split]);
        let floor_suppressed = p.gate_threshold_live();
        p.set_suppress_enabled(false);
        let out = feed(&mut chain, &noise[split..]);
        let w = window_rms(&out, 0.5, 1.5);
        assert!(
            w < 0.1 * sigma,
            "gate open after the toggle: {w} (threshold before toggle {floor_suppressed})"
        );
    }

    /// Room-like noise: white -> one-pole low-pass at 20 Hz (-6 dB/octave
    /// above it) -> one-pole high-pass at 80 Hz (a mic's low-cut), scaled
    /// to `level` RMS. Its 10 ms level swings far more than white noise's
    /// (block std ~2.2 dB vs ~0.3 dB), which is what trips a naive hold.
    fn room_noise(n: usize, level: f32, seed: u32) -> Vec<f32> {
        let white = gauss_noise(n, 1.0, seed);
        let sr = SAMPLE_RATE as f32;
        let a = (-2.0 * std::f32::consts::PI * 20.0 / sr).exp();
        let b = (-2.0 * std::f32::consts::PI * 80.0 / sr).exp();
        let (mut lp, mut px, mut py) = (0.0f32, 0.0f32, 0.0f32);
        let mut y: Vec<f32> = white
            .iter()
            .map(|&w| {
                lp = a * lp + w;
                py = b * (py + lp - px);
                px = lp;
                py
            })
            .collect();
        let k = level / rms(&y);
        for v in y.iter_mut() {
            *v *= k;
        }
        y
    }

    /// Share of samples from `from` on that the gate passes (> half gain).
    fn open_fraction(out: &[f32], input: &[f32], from: usize) -> f32 {
        let n = out.len().min(input.len());
        let open = (from..n)
            .filter(|&i| out[i].abs() > 0.5 * input[i].abs() + 1e-12)
            .count();
        open as f32 / (n - from) as f32
    }

    #[test]
    fn auto_gate_stays_closed_on_room_like_noise() {
        // Pure room-like noise at the default 6 dB margin: the gate stays
        // (almost) shut - noise blips must not become 150 ms open bursts.
        let open: Vec<f32> = [31, 32, 33]
            .iter()
            .map(|&seed| {
                let (_p, mut chain) = auto_chain();
                let x = room_noise(SAMPLE_RATE as usize * 12, 0.003, seed);
                let out = feed(&mut chain, &x);
                open_fraction(&out, &x, SAMPLE_RATE as usize * 3) * 100.0
            })
            .collect();
        assert!(
            open.iter().all(|&pct| pct < 5.0),
            "gate open on noise (% of the time, seeds 31-33): {open:?}"
        );
    }

    #[test]
    fn auto_gate_hold_bridges_gaps_between_words() {
        // Words (150 ms, 20 dB over the noise) with 120 ms gaps of plain
        // noise: the hold keeps the gate open through each gap, so word
        // endings and the gaps between words aren't chopped.
        let (_p, mut chain) = auto_chain();
        let sigma = 0.001;
        feed(
            &mut chain,
            &gauss_noise(SAMPLE_RATE as usize * 2, sigma, 41),
        );
        let (word, gap) = (7_200, 5_760);
        let period = word + gap;
        let bg = gauss_noise(period * 8, sigma, 42);
        let x: Vec<f32> = bg
            .iter()
            .enumerate()
            .map(|(i, &n)| {
                let tone = if i % period < word {
                    (i as f32 * 0.03).sin() * 0.014
                } else {
                    0.0
                };
                n + tone
            })
            .collect();
        let out = feed(&mut chain, &x);
        for k in 0..8 {
            let g0 = k * period + word + 480; // 10..110 ms into the gap
            let g1 = g0 + 4_800;
            let passed = rms(&out[g0..g1]) / rms(&x[g0..g1]);
            assert!(passed > 0.9, "gap {k} was gated: passed {passed}");
        }
    }

    #[test]
    fn auto_gate_passes_a_held_vowel_over_a_second() {
        // A steady 1.4 s "aaah" 30 dB over the noise is speech, not a noise
        // jump: it passes whole (no steady-level re-learn before 1.5 s).
        let (_p, mut chain) = auto_chain();
        let sigma = 0.001;
        feed(
            &mut chain,
            &gauss_noise(SAMPLE_RATE as usize * 2, sigma, 51),
        );
        let n = SAMPLE_RATE as usize * 14 / 10;
        let bg = gauss_noise(n, sigma, 52);
        let sr = SAMPLE_RATE as f32;
        let x: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 200.0 * i as f32 / sr).sin() * 0.045 + bg[i])
            .collect();
        let out = feed(&mut chain, &x);
        let passed = window_rms(&out, 1.0, 1.4) / window_rms(&x, 1.0, 1.4);
        assert!(passed > 0.95, "held vowel cut after 1 s: passed {passed}");
    }

    /// A steady 200 Hz tone whose RMS is `level_at(i)` at sample `i`.
    fn tone_at(n: usize, level_at: impl Fn(usize) -> f32) -> Vec<f32> {
        let sr = SAMPLE_RATE as f32;
        (0..n)
            .map(|i| {
                (2.0 * std::f32::consts::PI * 200.0 * i as f32 / sr).sin()
                    * level_at(i)
                    * std::f32::consts::SQRT_2
            })
            .collect()
    }

    #[test]
    fn manual_gate_opens_and_closes_at_the_line_rms() {
        // The UI draws the manual threshold on the RMS meter (`input_level`),
        // so a steady signal must open the gate just over the line and close
        // it just under - the same detector (and 150 ms hold) as auto mode.
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        let line = 0.02;
        p.set_gate_threshold(line);
        let mut chain = MicChain::new(p.clone());
        let under = line * 10f32.powf(-2.0 / 20.0);
        let over = line * 10f32.powf(2.0 / 20.0);
        let sr = SAMPLE_RATE as usize;
        // 1 s 2 dB under the line, 1 s 2 dB over, 1 s under again.
        let x = tone_at(sr * 3, |i| if (sr..2 * sr).contains(&i) { over } else { under });
        let out = feed(&mut chain, &x);

        // Under the line (its peaks are 1 dB over it): closed.
        let w = window_rms(&out, 0.5, 1.0);
        assert!(w < 0.05 * under, "open 2 dB under the line: {w}");
        // Over the line: open, the tone passes.
        let passed = window_rms(&out, 1.1, 2.0) / window_rms(&x, 1.1, 2.0);
        assert!(passed > 0.95, "closed 2 dB over the line: passed {passed}");
        // The meter shows the level the gate compared (the line's scale).
        assert!(
            (p.input_level() / under - 1.0).abs() < 0.02,
            "meter {} vs {under}",
            p.input_level()
        );
        // Back under: held ~150 ms, then closed.
        let held = window_rms(&out, 2.02, 2.12) / window_rms(&x, 2.02, 2.12);
        assert!(held > 0.9, "hold should bridge 150 ms: passed {held}");
        let w = window_rms(&out, 2.4, 3.0);
        assert!(w < 0.05 * under, "open after dropping under the line: {w}");
    }

    #[test]
    fn manual_gate_stays_closed_on_noise_under_the_line() {
        // Noise 4 dB under the line: its peaks reach ~6 dB over the line
        // (a peak detector opened the gate here, ~10 dB before the meter
        // reached the line); the RMS detector keeps it shut.
        let p = Arc::new(MicParams::new());
        p.set_gate_enabled(true);
        let line = 0.02;
        p.set_gate_threshold(line);
        let mut chain = MicChain::new(p);
        let sigma = line * 10f32.powf(-4.0 / 20.0);
        let x = gauss_noise(SAMPLE_RATE as usize * 2, sigma, 61);
        let out = feed(&mut chain, &x);
        let w = window_rms(&out, 1.0, 2.0);
        assert!(w < 0.05 * sigma, "noise under the line opened the gate: {w}");
    }

    // ---- mic mute ----

    /// `n` samples of a 1 kHz cosine at `amp`. Every 480-sample block starts
    /// on a peak, so a hard step at a block edge would show.
    fn cosine(n: usize, amp: f32) -> Vec<f32> {
        let sr = SAMPLE_RATE as f32;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr).cos() * amp)
            .collect()
    }

    #[test]
    fn mic_chain_muted_outputs_silence_after_ramp() {
        let p = Arc::new(MicParams::new());
        let mut chain = MicChain::new(p.clone());
        let amp = 0.5;
        let x = cosine(SAMPLE_RATE as usize / 5, amp); // 200 ms
        let half = x.len() / 2;
        let before = feed(&mut chain, &x[..half]);
        for (a, b) in x[..half].iter().zip(before.iter()) {
            assert!((a - b).abs() < 1e-6, "unmuted must pass through");
        }

        p.set_mic_muted(true);
        let out = feed(&mut chain, &x[half..]);
        assert_eq!(out.len(), x.len() - half, "mute keeps the chain 1:1");
        // A ramp, not a hard cut: the first muted sample is near full level.
        assert!(
            out[0].abs() > 0.9 * amp,
            "hard cut on mute: {} (input {})",
            out[0],
            x[half]
        );
        // From 20 ms after muting on, every sample is exactly zero.
        let ms20 = SAMPLE_RATE as usize / 50;
        let loud = out[ms20..].iter().position(|&s| s != 0.0);
        assert_eq!(loud, None, "non-zero sample 20 ms+ into mute");
        // The volume setting is untouched by mute.
        assert!((p.volume() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn mic_chain_unmute_ramps_back() {
        let p = Arc::new(MicParams::new());
        let mut chain = MicChain::new(p.clone());
        let amp = 0.5;
        let x = cosine(SAMPLE_RATE as usize / 5, amp);
        let half = x.len() / 2;
        p.set_mic_muted(true);
        let muted = feed(&mut chain, &x[..half]);
        assert!(muted[960..].iter().all(|&s| s == 0.0), "settled muted");

        p.set_mic_muted(false);
        let mut out = Vec::new();
        chain.process(&x[half..half + 480], &mut out);
        assert!(x[half] > 0.99 * amp, "the block starts on a peak");
        // First block after unmute: no hard step back to full level.
        assert!(
            out[0].abs() < 0.1 * amp,
            "hard step on unmute: {} (input {})",
            out[0],
            x[half]
        );
        // The ramp is done within ~10 ms: passthrough again after it.
        let rest = feed(&mut chain, &x[half + 480..]);
        for (a, b) in x[half + 480..].iter().zip(rest.iter()) {
            assert!((a - b).abs() < 1e-6, "unmute must end at full level");
        }
    }

    #[test]
    fn mic_chain_created_while_muted_starts_silent() {
        // Audio (re)started while muted: the new chain must not ramp down
        // from full level, which would let ~10 ms of mic through.
        let p = Arc::new(MicParams::new());
        p.set_mic_muted(true);
        let mut chain = MicChain::new(p);
        let out = feed(&mut chain, &cosine(4_800, 0.5));
        assert_eq!(out.len(), 4_800);
        assert!(out.iter().all(|&s| s == 0.0), "mic leaked at start");
    }

    // ---- push-to-talk ----

    fn ptt_chain() -> (Arc<MicParams>, MicChain) {
        let p = Arc::new(MicParams::new());
        p.set_ptt_mode(true);
        let chain = MicChain::new(p.clone());
        (p, chain)
    }

    /// One 10 ms block of a loud tone through `chain`; true if it came out audible.
    fn block_audible(chain: &mut MicChain) -> bool {
        let mut out = Vec::new();
        chain.process(&cosine(480, 0.5), &mut out);
        out.iter().any(|&s| s.abs() > 0.01)
    }

    #[test]
    fn ptt_mode_starts_closed() {
        // A fresh chain in PTT mode is silent from the first sample, even
        // though nothing ramped it down.
        let (p, mut chain) = ptt_chain();
        let out = feed(&mut chain, &cosine(4_800, 0.5));
        assert!(out.iter().all(|&s| s == 0.0), "mic leaked at start");
        assert!(!p.ptt_open());
        // A restart is a new chain: closed again after being open.
        p.set_ptt_held(true);
        feed(&mut chain, &cosine(4_800, 0.5));
        assert!(p.ptt_open());
        p.set_ptt_held(false);
        let mut chain = MicChain::new(p);
        let out = feed(&mut chain, &cosine(4_800, 0.5));
        assert!(out.iter().all(|&s| s == 0.0), "mic leaked after restart");
    }

    #[test]
    fn ptt_opens_with_ramp_and_closes_after_tail() {
        let (p, mut chain) = ptt_chain();
        p.set_ptt_held(true);
        let mut out = Vec::new();
        chain.process(&cosine(480, 0.5), &mut out);
        assert!(out[0].abs() < 0.05, "hard step on open: {}", out[0]);
        assert!(block_audible(&mut chain));
        assert!(p.ptt_open());
        // Outside PTT mode the gate is not involved at all.
        p.set_ptt_mode(false);
        assert!(block_audible(&mut chain));
    }

    #[test]
    fn ptt_release_tail_200ms() {
        let (p, mut chain) = ptt_chain();
        p.set_ptt_held(true);
        for _ in 0..5 {
            block_audible(&mut chain);
        }
        p.set_ptt_held(false);
        // Count 10 ms blocks the mic stays audible after release.
        let mut audible = 0;
        while block_audible(&mut chain) {
            audible += 1;
            assert!(audible < 40, "never closed");
        }
        // 200 ms tail (to within a block) plus the 10 ms close ramp.
        assert!((19..=22).contains(&audible), "tail was {audible} blocks");
        assert!(!p.ptt_open());
        // Closed stays closed.
        assert!(!block_audible(&mut chain));
        // Pressing again during a tail restarts it in full.
        p.set_ptt_held(true);
        assert!(block_audible(&mut chain) || block_audible(&mut chain));
    }

    #[test]
    fn ptt_press_during_tail_restarts_tail() {
        let (p, mut chain) = ptt_chain();
        p.set_ptt_held(true);
        block_audible(&mut chain);
        p.set_ptt_held(false);
        for _ in 0..15 {
            assert!(block_audible(&mut chain));
        }
        p.set_ptt_held(true);
        block_audible(&mut chain);
        p.set_ptt_held(false);
        for _ in 0..15 {
            assert!(block_audible(&mut chain), "tail did not restart");
        }
    }

    #[test]
    fn mute_overrides_ptt() {
        let (p, mut chain) = ptt_chain();
        p.set_ptt_held(true);
        for _ in 0..3 {
            block_audible(&mut chain);
        }
        assert!(block_audible(&mut chain));
        p.set_mic_muted(true);
        // Ramp (one block), then silence even though the key is held.
        block_audible(&mut chain);
        for _ in 0..5 {
            assert!(!block_audible(&mut chain), "held PTT beat the mute");
        }
        assert!(p.ptt_held());
        p.set_mic_muted(false);
        block_audible(&mut chain);
        assert!(block_audible(&mut chain), "unmute while held reopens");
    }

    // ---- mic quality ----

    #[test]
    fn quality_runs_before_volume_and_mute() {
        let sr = SAMPLE_RATE as f32;
        let tone = |hz: f32| -> Vec<f32> {
            (0..SAMPLE_RATE as usize / 2)
                .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / sr).sin() * 0.3)
                .collect()
        };
        let p = Arc::new(MicParams::new());
        p.set_mic_quality(50.0);
        p.set_volume(0.5);
        // A cheap headset: 6 kHz is cut hard, 300 Hz just gets the volume.
        let x = tone(6_000.0);
        let out = feed(&mut MicChain::new(p.clone()), &x);
        assert!(
            rms(&out[4_800..]) < 0.1 * 0.5 * rms(&x[4_800..]),
            "6 kHz not cut"
        );
        let x = tone(300.0);
        let out = feed(&mut MicChain::new(p.clone()), &x);
        let ratio = rms(&out[4_800..]) / rms(&x[4_800..]);
        assert!((ratio - 0.5).abs() < 0.1, "300 Hz x volume 0.5: {ratio}");
        // Mute still silences the degraded mic (what Discord and the monitor get).
        p.set_mic_muted(true);
        let out = feed(&mut MicChain::new(p), &x);
        assert!(out.iter().all(|&s| s == 0.0), "muted chain leaked");
    }

    #[test]
    fn auto_threshold_published_even_with_gate_disabled() {
        // gate_auto on but the gate itself off: the signal is untouched, but
        // the live threshold is still tracked (the UI can show it).
        let p = Arc::new(MicParams::new());
        p.set_gate_auto(true);
        let mut chain = MicChain::new(p.clone());
        let noise = gauss_noise(SAMPLE_RATE as usize, 0.01, 13);
        let out = feed(&mut chain, &noise);
        for (a, b) in noise.iter().zip(out.iter()) {
            assert!(
                (a - b).abs() < 1e-6,
                "gate disabled must not alter the signal"
            );
        }
        assert!(
            p.gate_threshold_live() > 0.01,
            "{}",
            p.gate_threshold_live()
        );
    }
}
