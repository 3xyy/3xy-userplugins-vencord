use std::sync::Arc;

use signalsmith_stretch::Stretch;

use super::params::{MicParams, VoicePreset};
use crate::audio::format::SAMPLE_RATE;

/// Mic-channel voice changer: independent pitch + formant shift via Signalsmith
/// Stretch. Mono, 48 kHz. The `Stretch` instance is constructed here (off the
/// audio thread); `process` is allocation-free in steady state (the output
/// scratch is pre-reserved and reused). `Off` is a true bypass.
pub struct VoiceChanger {
    params: Arc<MicParams>,
    stretch: Stretch,
    scratch: Vec<f32>,
    last_pitch: f32,
    last_formant: f32,
    was_active: bool,
}

impl VoiceChanger {
    pub fn new(params: Arc<MicParams>) -> Self {
        // preset_default = higher-quality config; latency (tens of ms) is well within
        // the user's multi-second tolerance. Mono (1 channel).
        let stretch = Stretch::preset_default(1, SAMPLE_RATE);
        Self {
            params,
            stretch,
            scratch: Vec::with_capacity(8192),
            // NaN sentinel: NaN != any f32 (incl. NaN), so the pitch/formant setters fire on the first active block.
            last_pitch: f32::NAN,
            last_formant: f32::NAN,
            was_active: false,
        }
    }

    /// Transform `work` (mono f32) in place. On `Off` or zero shift (intensity=0),
    /// `work` is left untouched.
    pub fn process(&mut self, work: &mut Vec<f32>) {
        let preset = self.params.voice_preset();

        // Compute shift early so zero-intensity can take the same bypass path as Off.
        let (pitch, formant) = preset.semitones_at(self.params.voice_intensity());

        if preset == VoicePreset::Off || (pitch == 0.0 && formant == 0.0) {
            // True bypass. Reset the shifter once on the active->bypass transition so a
            // later re-enable starts from a clean state. reset() is cheap and safe
            // on the audio thread (no allocation).
            if self.was_active {
                self.stretch.reset();
                self.was_active = false;
                self.last_pitch = f32::NAN;
                self.last_formant = f32::NAN;
            }
            return;
        }

        // Apply pitch/formant only when they actually change. The setters are
        // allocation-free, but caching avoids redundant FFI calls per block.
        // Float == is intentional and safe: values are recomputed from semitones_at each
        // block (not accumulated), so identical inputs always produce identical bit patterns.
        if pitch != self.last_pitch {
            self.stretch.set_transpose_factor_semitones(pitch, None);
            self.last_pitch = pitch;
        }
        if formant != self.last_formant {
            // compensate_pitch = false: we supply an absolute formant shift so the
            // preset can move formants independently of pitch (natural gender change).
            self.stretch.set_formant_factor_semitones(formant, false);
            self.last_formant = formant;
        }
        self.was_active = true;

        let n = work.len();
        if n == 0 {
            return;
        }
        // Output must be a buffer distinct from the input. Reuse `scratch`
        // (pre-reserved to 8192; device blocks are far smaller, so resize stays
        // within capacity and does not allocate on the hot path).
        self.scratch.clear();
        self.scratch.resize(n, 0.0);
        self.stretch.process(&work[..], &mut self.scratch[..]);
        work.clear();
        work.extend_from_slice(&self.scratch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_preset_is_passthrough() {
        let p = Arc::new(MicParams::new()); // default preset = Off
        let mut vc = VoiceChanger::new(p);
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.02).sin() * 0.3).collect();
        let mut work = input.clone();
        vc.process(&mut work);
        assert_eq!(work.len(), input.len());
        for (a, b) in input.iter().zip(work.iter()) {
            assert!((a - b).abs() < 1e-9, "Off must be exact passthrough");
        }
    }

    #[test]
    fn zero_intensity_is_passthrough() {
        // Girly at intensity=0.0 → semitones_at returns (0.0, 0.0) → must bypass the
        // stretcher entirely and return the input unchanged, just like Off.
        let p = Arc::new(MicParams::new());
        p.set_voice_preset(VoicePreset::Girly);
        p.set_voice_intensity(0.0);
        let mut vc = VoiceChanger::new(p);
        let input: Vec<f32> = (0..960).map(|i| (i as f32 * 0.02).sin() * 0.3).collect();
        let mut work = input.clone();
        vc.process(&mut work);
        assert_eq!(work.len(), input.len());
        for (a, b) in input.iter().zip(work.iter()) {
            assert!((a - b).abs() < 1e-9, "zero-intensity must be exact passthrough");
        }
    }

    #[test]
    fn active_preset_preserves_length() {
        let p = Arc::new(MicParams::new());
        p.set_voice_preset(VoicePreset::Girly);
        p.set_voice_intensity(1.0);
        let mut vc = VoiceChanger::new(p);
        let input = vec![0.2f32; 4800];
        let mut work = input.clone();
        vc.process(&mut work);
        assert_eq!(work.len(), input.len(), "shifter must be 1:1 in/out length");
    }

    /// Count zero crossings (sign changes). For a clean sine this is proportional
    /// to its frequency, so it tracks pitch without needing an FFT.
    fn zero_crossings(s: &[f32]) -> usize {
        s.windows(2)
            .filter(|w| (w[0] <= 0.0) != (w[1] <= 0.0))
            .count()
    }

    fn run_preset(preset: VoicePreset) -> Vec<f32> {
        let p = Arc::new(MicParams::new());
        p.set_voice_preset(preset);
        p.set_voice_intensity(1.0);
        let mut vc = VoiceChanger::new(p);
        // 1 second of a 200 Hz sine at 48 kHz, plenty past the shifter's latency.
        let f = 200.0_f32;
        let input: Vec<f32> = (0..SAMPLE_RATE as usize)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / SAMPLE_RATE as f32).sin() * 0.5)
            .collect();
        let mut work = input.clone();
        vc.process(&mut work);
        work
    }

    #[test]
    fn pitch_shifts_up_for_girly_and_down_for_manly() {
        // Measure on the second-half tail to skip the shifter's startup latency.
        let half = (SAMPLE_RATE as usize) / 2;
        let off = run_preset(VoicePreset::Off);
        let girly = run_preset(VoicePreset::Girly);
        let manly = run_preset(VoicePreset::Manly);

        let zc_off = zero_crossings(&off[half..]);
        let zc_girly = zero_crossings(&girly[half..]);
        let zc_manly = zero_crossings(&manly[half..]);

        // +4 semitones ≈ ×1.26 frequency; -4 ≈ ×0.79. Use loose margins for safety.
        assert!(
            zc_girly as f32 > zc_off as f32 * 1.10,
            "girly must raise pitch: off={zc_off} girly={zc_girly}"
        );
        assert!(
            (zc_manly as f32) < zc_off as f32 * 0.92,
            "manly must lower pitch: off={zc_off} manly={zc_manly}"
        );
    }
}
