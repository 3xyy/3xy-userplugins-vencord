//! Mic quality: makes the mic sound like a worse one. Quality 100 is a true
//! bypass; lower values narrow the band (high-pass rising, low-pass falling),
//! then lower the sample rate (sampled and rebuilt by linear interpolation,
//! with aliasing below 25) and the bit depth, with a little soft clipping
//! near 0. Mono f32 at 48 kHz, in place.
//!
//! Real-time safe: all state is plain scalars (the type is `Copy`, so it can't
//! own heap memory), no locks, no panics. The quality glides and the filters
//! are recomputed every `CTRL` samples, so dragging the slider never clicks;
//! turning the stage on or off crossfades with the dry signal over `FADE`
//! samples.

use crate::audio::format::SAMPLE_RATE;

const FS: f32 = SAMPLE_RATE as f32;
/// Samples between filter/parameter updates.
const CTRL: usize = 16;
/// Time constant of the quality glide, in seconds.
const GLIDE_S: f32 = 0.04;
/// Dry/wet crossfade length when the stage turns on or off (10 ms).
const FADE: f32 = 480.0;
/// Bit depth from which the quantizer is off (its noise is inaudible).
const BITS_OFF: f32 = 16.0;
/// The wet path's input is limited to this, so no state can overflow.
const IN_LIMIT: f32 = 8.0;

/// Butterworth Q values: 2nd order, and the two sections of 4th order.
const Q_BW2: f32 = std::f32::consts::FRAC_1_SQRT_2;
const Q_BW4: [f32; 2] = [0.541_196_1, 1.306_563];

// The quality-to-sound mapping. Each table is (quality, value) by ascending
// quality; values between anchors are interpolated (frequencies on a log
// scale). Targets: ~75 slightly muffled, ~50 cheap headset, ~25 bad phone
// call, near 0 crushed and barely intelligible.

/// High-pass (2nd order) cutoff, Hz: the missing lows of a small mic.
const HP_HZ: [(f32, f32); 7] = [
    (0.0, 550.0),
    (10.0, 450.0),
    (25.0, 350.0),
    (40.0, 180.0),
    (50.0, 120.0),
    (75.0, 50.0),
    (100.0, 20.0),
];
/// Final low-pass (4th order) cutoff, Hz: the muffling.
const LP_HZ: [(f32, f32); 7] = [
    (0.0, 1_300.0),
    (10.0, 1_800.0),
    (25.0, 2_500.0),
    (40.0, 2_900.0),
    (50.0, 3_200.0),
    (75.0, 6_500.0),
    (100.0, 20_000.0),
];
/// Low-pass (4th order) before the sample-rate reduction, Hz. Equal to the
/// final low-pass down to 25 (a clean phone band); below that it opens past
/// half the sample rate, so content aliases into the band (the grit).
const PRE_HZ: [(f32, f32); 7] = [
    (0.0, 2_800.0),
    (10.0, 3_000.0),
    (25.0, 2_500.0),
    (40.0, 2_900.0),
    (50.0, 3_200.0),
    (75.0, 6_500.0),
    (100.0, 20_000.0),
];
/// Reduced sample rate, Hz (48000 = off).
const HOLD_HZ: [(f32, f32); 5] = [
    (0.0, 3_000.0),
    (10.0, 4_400.0),
    (25.0, 7_000.0),
    (40.0, 48_000.0),
    (100.0, 48_000.0),
];
/// Bit depth (16 and up = off).
const BITS: [(f32, f32); 5] = [
    (0.0, 6.0),
    (10.0, 8.0),
    (25.0, 10.0),
    (30.0, 16.0),
    (100.0, 16.0),
];
/// Soft-clip drive (`tanh(d x) / d`; 0 = off).
const DRIVE: [(f32, f32); 3] = [(0.0, 2.5), (15.0, 0.0), (100.0, 0.0)];
/// Make-up gain, dB, for the level the narrow band takes away.
const MAKEUP_DB: [(f32, f32); 4] = [(0.0, 4.0), (25.0, 2.0), (40.0, 0.0), (100.0, 0.0)];

/// `table` at `q` (clamped to its ends), linear or log interpolation.
fn interp(table: &[(f32, f32)], q: f32, log: bool) -> f32 {
    let (first, last) = (table[0], table[table.len() - 1]);
    if q <= first.0 {
        return first.1;
    }
    for w in table.windows(2) {
        let ((q0, v0), (q1, v1)) = (w[0], w[1]);
        if q <= q1 {
            let t = (q - q0) / (q1 - q0);
            return if log {
                v0 * (v1 / v0).powf(t)
            } else {
                v0 + (v1 - v0) * t
            };
        }
    }
    last.1
}

/// The stage's settings at quality `q` (0..100).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Settings {
    hp_hz: f32,
    pre_hz: f32,
    lp_hz: f32,
    hold_hz: f32,
    bits: f32,
    drive: f32,
    makeup_db: f32,
}

fn settings_at(q: f32) -> Settings {
    Settings {
        hp_hz: interp(&HP_HZ, q, true),
        pre_hz: interp(&PRE_HZ, q, true),
        lp_hz: interp(&LP_HZ, q, true),
        hold_hz: interp(&HOLD_HZ, q, true),
        bits: interp(&BITS, q, false),
        drive: interp(&DRIVE, q, false),
        makeup_db: interp(&MAKEUP_DB, q, false),
    }
}

/// Topology-preserving state-variable filter (Simper): stays well behaved
/// while its cutoff moves, which is what a dragged slider does.
#[derive(Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32,
}

impl Svf {
    fn set(&mut self, hz: f32, q: f32) {
        let g = (std::f32::consts::PI * hz.clamp(10.0, 0.45 * FS) / FS).tan();
        self.k = 1.0 / q;
        self.a1 = 1.0 / (1.0 + g * (g + self.k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    /// One sample; returns (low-pass, high-pass).
    #[inline]
    fn tick(&mut self, v0: f32) -> (f32, f32) {
        let v3 = v0 - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v0 - self.k * v1 - v2)
    }

    fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// Zeroes states too small to matter (no subnormal arithmetic during
    /// silence, e.g. behind a closed gate) and reports whether the state is
    /// finite.
    fn tidy(&mut self) -> bool {
        for v in [&mut self.ic1, &mut self.ic2] {
            if v.abs() < 1e-20 {
                *v = 0.0;
            }
        }
        self.ic1.is_finite() && self.ic2.is_finite()
    }
}

/// An out-of-range quality is read as the nearest valid value; NaN as 100.
fn sanitize_quality(q: f32) -> f32 {
    if q.is_nan() {
        100.0
    } else {
        q.clamp(0.0, 100.0)
    }
}

/// The mic quality stage. See the module docs.
#[derive(Clone, Copy)]
pub struct Degrade {
    /// Gliding quality the filters are set for.
    q: f32,
    /// `q` the current settings were computed for (NaN = none yet).
    set_for: f32,
    /// Samples until the next parameter update.
    ctrl: usize,
    hp: Svf,
    pre: [Svf; 2],
    lp: [Svf; 2],
    /// Reduced-rate phase step (rate / 48 kHz; 1 = every sample) and phase
    /// (0..1 through the current period), the last two reduced-rate samples
    /// the output interpolates between.
    hold_step: f32,
    phase: f32,
    prev: f32,
    held: f32,
    /// Quantizer step and its inverse (step 0 = off).
    step: f32,
    inv_step: f32,
    drive: f32,
    makeup: f32,
    /// Dry/wet mix (0 = dry) and where it is heading.
    wet: f32,
    wet_target: f32,
    /// Per-update glide coefficient.
    glide: f32,
}

impl Degrade {
    /// A stage already settled at `quality`: audio that starts with a lowered
    /// quality is degraded from the first sample, with no glide.
    pub fn new(quality: f32) -> Self {
        let q = sanitize_quality(quality);
        let on = if q < 100.0 { 1.0 } else { 0.0 };
        let mut d = Self {
            q,
            set_for: f32::NAN,
            ctrl: 0,
            hp: Svf::default(),
            pre: [Svf::default(); 2],
            lp: [Svf::default(); 2],
            hold_step: 1.0,
            phase: 1.0,
            prev: 0.0,
            held: 0.0,
            step: 0.0,
            inv_step: 0.0,
            drive: 0.0,
            makeup: 1.0,
            wet: on,
            wet_target: on,
            glide: 1.0 - (-(CTRL as f32) / (GLIDE_S * FS)).exp(),
        };
        d.apply_settings();
        d
    }

    /// Degrade `buf` in place for `quality` (0..100). At 100, once any glide
    /// and fade back are done, it returns at once without touching `buf`.
    pub fn process(&mut self, buf: &mut [f32], quality: f32) {
        let target = sanitize_quality(quality);
        if target >= 100.0 && self.wet == 0.0 {
            return;
        }
        let fade = 1.0 / FADE;
        for s in buf.iter_mut() {
            if self.ctrl == 0 {
                self.update(target);
                self.ctrl = CTRL;
            }
            self.ctrl -= 1;

            let dry = if s.is_finite() { *s } else { 0.0 };
            let wet = self.tick(dry.clamp(-IN_LIMIT, IN_LIMIT));
            if self.wet != self.wet_target {
                self.wet = if self.wet_target > self.wet {
                    (self.wet + fade).min(1.0)
                } else {
                    (self.wet - fade).max(0.0)
                };
            }
            *s = if self.wet >= 1.0 {
                wet
            } else if self.wet <= 0.0 {
                dry
            } else {
                dry + (wet - dry) * self.wet
            };
        }
        // A non-finite state can't arise with the input limited, but a NaN
        // must never stick: start the filters over.
        let mut finite = self.prev.is_finite() && self.held.is_finite();
        finite &= self.hp.tidy();
        for f in self.pre.iter_mut().chain(self.lp.iter_mut()) {
            finite &= f.tidy();
        }
        // Faded back to dry at 100: idle (and clean) until the quality drops.
        if !finite || (target >= 100.0 && self.wet == 0.0) {
            self.reset_state();
        }
    }

    /// Glide toward `target` and refresh the settings (every `CTRL` samples).
    fn update(&mut self, target: f32) {
        if self.wet == 0.0 && self.wet_target == 0.0 {
            // Leaving bypass: glide down from 100.
            self.q = 100.0;
        }
        let diff = target - self.q;
        self.q = if diff.abs() < 0.01 {
            target
        } else {
            self.q + diff * self.glide
        };
        // Wet while degraded; fade back to dry only once the glide is at 100.
        self.wet_target = if target < 100.0 || self.q < 100.0 {
            1.0
        } else {
            0.0
        };
        if self.q != self.set_for {
            self.apply_settings();
        }
    }

    fn apply_settings(&mut self) {
        let s = settings_at(self.q);
        self.hp.set(s.hp_hz, Q_BW2);
        self.pre[0].set(s.pre_hz, Q_BW4[0]);
        self.pre[1].set(s.pre_hz, Q_BW4[1]);
        self.lp[0].set(s.lp_hz, Q_BW4[0]);
        self.lp[1].set(s.lp_hz, Q_BW4[1]);
        self.hold_step = (s.hold_hz / FS).clamp(0.0, 1.0);
        if self.hold_step >= 1.0 {
            // Full rate: output the newest sample, no interpolation delay.
            self.phase = 1.0;
        }
        if s.bits >= BITS_OFF {
            self.step = 0.0;
            self.inv_step = 0.0;
        } else {
            self.step = 2.0f32.powf(1.0 - s.bits);
            self.inv_step = 1.0 / self.step;
        }
        self.drive = s.drive;
        self.makeup = 10.0f32.powf(s.makeup_db / 20.0);
        self.set_for = self.q;
    }

    /// One sample of the wet path: high-pass, pre low-pass, soft clip,
    /// reduced rate with quantizing, final low-pass, make-up gain.
    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let mut v = self.hp.tick(x).1;
        v = self.pre[0].tick(v).0;
        v = self.pre[1].tick(v).0;
        if self.drive > 1e-3 {
            v = (v * self.drive).tanh() / self.drive;
        }
        // Take a reduced-rate sample once per period, and rebuild the signal
        // by linear interpolation between the last two (one period late).
        // Its images fall off much faster than a plain hold's, so lowering
        // the rate adds grit in the band without adding hiss above it. At
        // full rate the phase stays at 1 and this outputs `v` itself.
        self.phase += self.hold_step;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
            self.prev = self.held;
            self.held = if self.step > 0.0 {
                (v * self.inv_step).round() * self.step
            } else {
                v
            };
        }
        let rebuilt = self.prev + (self.held - self.prev) * self.phase;
        let y = self.lp[0].tick(rebuilt).0;
        self.lp[1].tick(y).0 * self.makeup
    }

    fn reset_state(&mut self) {
        self.hp.reset();
        for f in self.pre.iter_mut() {
            f.reset();
        }
        for f in self.lp.iter_mut() {
            f.reset();
        }
        self.phase = 1.0;
        self.prev = 0.0;
        self.held = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::format::SAMPLE_RATE;

    const SR: usize = SAMPLE_RATE as usize;

    /// Allocation counter for the current thread (the test harness runs
    /// tests on several threads, so a global count would see the others).
    mod alloc_count {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static COUNT: Cell<usize> = const { Cell::new(0) };
        }

        pub struct Counting;

        unsafe impl GlobalAlloc for Counting {
            unsafe fn alloc(&self, l: Layout) -> *mut u8 {
                let _ = COUNT.try_with(|c| c.set(c.get() + 1));
                System.alloc(l)
            }
            unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
                System.dealloc(p, l)
            }
            unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
                let _ = COUNT.try_with(|c| c.set(c.get() + 1));
                System.alloc_zeroed(l)
            }
            unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
                let _ = COUNT.try_with(|c| c.set(c.get() + 1));
                System.realloc(p, l, n)
            }
        }

        #[global_allocator]
        static ALLOC: Counting = Counting;

        pub fn allocations() -> usize {
            COUNT.with(|c| c.get())
        }
    }

    fn sine(n: usize, hz: f32, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin() * amp)
            .collect()
    }

    /// Deterministic uniform noise in [-amp, amp].
    fn noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((x >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    fn energy(s: &[f32]) -> f64 {
        s.iter().map(|&v| (v as f64) * (v as f64)).sum()
    }

    /// Runs `input` through a fresh stage at `quality`, in 480-sample blocks
    /// like the capture thread.
    fn run(input: &[f32], quality: f32) -> Vec<f32> {
        let mut d = Degrade::new(quality);
        let mut out = input.to_vec();
        for c in out.chunks_mut(480) {
            d.process(c, quality);
        }
        out
    }

    /// Energy above ~5 kHz from sample `skip` on: a 4th-order Butterworth
    /// high-pass (two RBJ biquads, test-side, independent of the stage's
    /// filters) run over the whole signal, so its own start-up isn't counted.
    fn hf_energy(s: &[f32], skip: usize) -> f64 {
        let mut y: Vec<f64> = s.iter().map(|&v| v as f64).collect();
        for q in [0.541_196_1f64, 1.306_563] {
            let w = 2.0 * std::f64::consts::PI * 5_000.0 / SR as f64;
            let (sn, cs) = w.sin_cos();
            let alpha = sn / (2.0 * q);
            let a0 = 1.0 + alpha;
            let b0 = (1.0 + cs) / 2.0 / a0;
            let b1 = -(1.0 + cs) / a0;
            let b2 = b0;
            let a1 = -2.0 * cs / a0;
            let a2 = (1.0 - alpha) / a0;
            let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
            for v in y.iter_mut() {
                let x0 = *v;
                let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                x2 = x1;
                x1 = x0;
                y2 = y1;
                y1 = y0;
                *v = y0;
            }
        }
        y[skip..].iter().map(|v| v * v).sum()
    }

    fn db(ratio: f64) -> f64 {
        10.0 * ratio.log10()
    }

    #[test]
    fn degrade_100_is_bit_identical() {
        let x = noise(SR / 2, 0.8, 1);
        let out = run(&x, 100.0);
        assert!(
            x.iter().zip(&out).all(|(a, b)| a.to_bits() == b.to_bits()),
            "quality 100 must not touch a single bit"
        );
        // Also after being lowered and brought back: once the glide and the
        // fade back to dry are done, the stage is a true bypass again.
        let mut d = Degrade::new(100.0);
        let mut buf = noise(SR / 2, 0.5, 2);
        for c in buf.chunks_mut(480) {
            d.process(c, 30.0);
        }
        let mut buf = noise(SR, 0.5, 3);
        for c in buf.chunks_mut(480) {
            d.process(c, 100.0);
        }
        let x = noise(SR / 4, 0.5, 4);
        let mut y = x.clone();
        for c in y.chunks_mut(480) {
            d.process(c, 100.0);
        }
        assert!(
            x.iter().zip(&y).all(|(a, b)| a.to_bits() == b.to_bits()),
            "back at 100 the stage must be a true bypass again"
        );
    }

    #[test]
    fn degrade_lower_quality_cuts_high_frequencies() {
        let skip = SR / 10; // filter start-up
        let hi = sine(SR, 6_000.0, 0.5);
        let hi_out = run(&hi, 50.0);
        let cut = db(energy(&hi_out[skip..]) / energy(&hi[skip..]));
        assert!(
            cut <= -20.0,
            "6 kHz at quality 50: {cut:.1} dB (need <= -20)"
        );

        let lo = sine(SR, 300.0, 0.5);
        let lo_out = run(&lo, 50.0);
        let kept = db(energy(&lo_out[skip..]) / energy(&lo[skip..]));
        assert!(
            kept.abs() <= 3.0,
            "300 Hz at quality 50: {kept:.2} dB (need within 3)"
        );
    }

    #[test]
    fn degrade_quality_monotonic() {
        // Broadband input; energy above 5 kHz must never grow as the quality
        // goes down, at every whole step from 100 to 0.
        let skip = SR / 10;
        let x = noise(SR / 2, 0.3, 5);
        let mut prev = f64::INFINITY;
        let mut prev_q = 101;
        for q in (0..=100).rev() {
            let out = run(&x, q as f32);
            let e = hf_energy(&out, skip);
            assert!(
                e <= prev * 1.000_001 + 1e-12,
                "HF energy grew from q={prev_q} ({prev:.6e}) to q={q} ({e:.6e})"
            );
            prev = e;
            prev_q = q;
        }
        // ...and quality 0 has removed nearly all of it.
        let full = hf_energy(&x, skip);
        assert!(db(prev / full) < -40.0, "q=0 HF: {:.1} dB", db(prev / full));
    }

    #[test]
    fn degrade_no_alloc_no_nan() {
        let mut d = Degrade::new(0.0);
        let mut silence = vec![0.0f32; 4_800];
        let mut full: Vec<f32> = (0..SR)
            .map(|i| if (i / 40) % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let mut rnd = noise(SR, 1.0, 6);
        let mut bad = noise(4_800, 0.5, 7);
        bad[10] = f32::NAN;
        bad[500] = f32::INFINITY;
        bad[900] = f32::NEG_INFINITY;
        bad[1_300] = 1e30;
        let mut after = sine(4_800, 440.0, 0.5);

        let before = alloc_count::allocations();
        for c in silence.chunks_mut(480) {
            d.process(c, 0.0);
        }
        for c in full.chunks_mut(480) {
            d.process(c, 0.0);
        }
        for c in rnd.chunks_mut(480) {
            d.process(c, 0.0);
        }
        for c in bad.chunks_mut(480) {
            d.process(c, 0.0);
        }
        // Quality itself garbage: treated as a valid value, never NaN state.
        for c in after.chunks_mut(480) {
            d.process(c, f32::NAN);
        }
        let allocated = alloc_count::allocations() - before;
        assert_eq!(allocated, 0, "the stage allocated on the audio path");

        assert!(
            silence.iter().all(|&s| s == 0.0),
            "silence must stay silent"
        );
        assert!(
            full.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
            "full scale"
        );
        assert!(
            rnd.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
            "random input"
        );
        assert!(bad.iter().all(|s| s.is_finite()), "NaN/inf input leaked");
        assert!(after.iter().all(|s| s.is_finite()), "state stuck after NaN");
        assert!(
            energy(&after[2_400..]) > 0.0,
            "the stage must recover after bad input"
        );

        // Every quality: finite and bounded on full-scale random input.
        for q in (0..100).step_by(5) {
            let out = run(&noise(SR / 4, 1.0, 8), q as f32);
            assert!(
                out.iter().all(|s| s.is_finite() && s.abs() <= 2.0),
                "q={q} out of bounds"
            );
        }
    }

    #[test]
    fn degrade_dragging_does_not_click() {
        // A 200 Hz tone while the slider jumps around (one value per 100 ms
        // preview, plus an instant start and stop): no sample-to-sample step
        // much larger than the tone's own slope.
        let x = sine(SR * 2, 200.0, 0.5);
        let mut y = x.clone();
        let mut d = Degrade::new(100.0);
        let path = [100.0, 60.0, 20.0, 5.0, 45.0, 90.0, 0.0, 100.0, 100.0, 100.0];
        let block = 480;
        for (i, c) in y.chunks_mut(block).enumerate() {
            let q = path[(i * block / (SR / 5)).min(path.len() - 1)];
            d.process(c, q);
        }
        let slope = 0.5 * 2.0 * std::f32::consts::PI * 200.0 / SR as f32;
        let worst = y
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            worst < 4.0 * slope + 0.02,
            "click while dragging: step {worst:.4} vs tone slope {slope:.4}"
        );
    }

    #[test]
    fn degrade_targets_sound_like_the_spec() {
        // ~25 is a phone line: voice band passes, lows and highs are cut.
        let skip = SR / 10;
        let gain = |hz: f32, q: f32| {
            let x = sine(SR / 2, hz, 0.3);
            let y = run(&x, q);
            db(energy(&y[skip..]) / energy(&x[skip..]))
        };
        assert!(
            gain(1_000.0, 25.0).abs() < 3.5,
            "1 kHz at 25: {:.1}",
            gain(1_000.0, 25.0)
        );
        assert!(
            gain(100.0, 25.0) < -10.0,
            "100 Hz at 25: {:.1}",
            gain(100.0, 25.0)
        );
        assert!(
            gain(4_500.0, 25.0) < -20.0,
            "4.5 kHz at 25: {:.1}",
            gain(4_500.0, 25.0)
        );
        // ~75 is only slightly muffled: speech band untouched, top end cut.
        assert!(
            gain(1_000.0, 75.0).abs() < 0.5,
            "1 kHz at 75: {:.2}",
            gain(1_000.0, 75.0)
        );
        assert!(
            gain(3_000.0, 75.0).abs() < 1.0,
            "3 kHz at 75: {:.2}",
            gain(3_000.0, 75.0)
        );
        assert!(
            gain(14_000.0, 75.0) < -20.0,
            "14 kHz at 75: {:.1}",
            gain(14_000.0, 75.0)
        );
    }
}
