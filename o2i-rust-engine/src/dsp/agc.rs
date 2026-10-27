/// Automatic gain control: drives the signal's RMS toward `target_rms` with a
/// smoothed, clamped gain. Does not pump up silence.
pub struct Agc {
    gain: f32,
    env: f32,
}

impl Agc {
    pub fn new() -> Self {
        Self {
            gain: 1.0,
            env: 0.0,
        }
    }

    pub fn process(&mut self, samples: &mut [f32], target_rms: f32) {
        const ENV_COEF: f32 = 0.001; // RMS envelope smoothing
        const GAIN_COEF: f32 = 0.0005; // gain adaptation speed
        const MIN_GAIN: f32 = 0.25;
        const MAX_GAIN: f32 = 8.0;
        const SILENCE: f32 = 1e-4;

        for s in samples.iter_mut() {
            let inst = (*s) * (*s);
            self.env += (inst - self.env) * ENV_COEF;
            let rms = self.env.sqrt();
            if rms > SILENCE {
                let desired = (target_rms / rms).clamp(MIN_GAIN, MAX_GAIN);
                self.gain += (desired - self.gain) * GAIN_COEF;
            }
            *s *= self.gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|&v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn quiet_signal_is_amplified_toward_target() {
        let mut a = Agc::new();
        // Quiet 100 Hz-ish tone; feed long enough to adapt.
        let mut buf = vec![0.02f32; 48_000 * 3];
        a.process(&mut buf, 0.1);
        let tail = rms(&buf[buf.len() - 4800..]);
        assert!(tail > 0.05, "tail rms after AGC = {}", tail);
    }

    #[test]
    fn gain_is_clamped_at_max() {
        let mut a = Agc::new();
        // Amplitude 0.001 is above SILENCE (1e-4 RMS), so adaptation branch is entered.
        // With target_rms=0.1 and input RMS≈0.001, desired gain ≈ 100 → clamped at MAX_GAIN=8.0.
        let mut buf = vec![0.001f32; 48_000 * 3];
        a.process(&mut buf, 0.1);
        assert!(
            a.gain <= 8.0 + 1e-3,
            "gain exceeded MAX_GAIN clamp: {}",
            a.gain
        );
        // Gain should have risen toward MAX_GAIN, confirming the adaptation branch was entered.
        assert!(
            a.gain > 1.0,
            "gain never adapted (adaptation branch not entered): {}",
            a.gain
        );
    }

    #[test]
    fn gain_is_clamped_at_min() {
        let mut a = Agc::new();
        // DC amplitude 1.0, RMS≈1.0; with target_rms=0.01, desired gain ≈ 0.01 → clamped at MIN_GAIN=0.25.
        let mut buf = vec![1.0f32; 48_000 * 3];
        a.process(&mut buf, 0.01);
        assert!(
            a.gain >= 0.25 - 1e-3,
            "gain fell below MIN_GAIN clamp: {}",
            a.gain
        );
    }

    #[test]
    fn loud_signal_is_attenuated_toward_target() {
        let mut a = Agc::new();
        let mut buf = vec![0.8f32; 48_000 * 3];
        a.process(&mut buf, 0.1);
        let tail = rms(&buf[buf.len() - 4800..]);
        assert!(tail < 0.4, "tail rms after AGC = {}", tail);
    }
}
