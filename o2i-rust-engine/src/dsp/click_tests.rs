//! Keyboard-click regression tests for the mic chain (task 12).
//!
//! The user's setup: noise cleanup 100 %, auto gate, auto gain, volume 0.9.
//! Click-attributable signal = (run with clicks) - (run without), same seeds;
//! its energy relative to the input clicks' energy says how much of a click
//! survives the chain (0 dB = unchanged, positive = louder than the raw click).

use std::sync::Arc;

use super::gate::NoiseGate;
use super::{MicChain, MicParams};

const FS: usize = 48_000;
const WARMUP_S: usize = 3;
const MEASURE_S: usize = 10;

struct Lcg(u32);
impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
    fn gauss(&mut self) -> f32 {
        (0..12).map(|_| self.next()).sum::<f32>() - 6.0
    }
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|&v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum()
}

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[derive(Clone, Copy)]
enum Bg {
    White(f32),
    Pink(f32),
}

fn background(bg: Bg, n: usize, seed: u32) -> Vec<f32> {
    let mut r = Lcg(seed);
    let (mut x, level) = match bg {
        Bg::White(db) => ((0..n).map(|_| r.gauss()).collect::<Vec<f32>>(), db),
        Bg::Pink(db) => {
            // Paul Kellet's economy pink filter.
            let (mut b0, mut b1, mut b2) = (0f32, 0f32, 0f32);
            let v = (0..n)
                .map(|_| {
                    let w = r.gauss();
                    b0 = 0.99765 * b0 + w * 0.099_046;
                    b1 = 0.963 * b1 + w * 0.296_516_4;
                    b2 = 0.57 * b2 + w * 1.052_691_3;
                    b0 + b1 + b2 + w * 0.184_8
                })
                .collect::<Vec<f32>>();
            (v, db)
        }
    };
    let g = db_to_lin(level) / rms(&x).max(1e-9);
    for s in x.iter_mut() {
        *s *= g;
    }
    x
}

/// Keystroke clicks: ~6 per second (120-220 ms apart), burst lengths cycling
/// 2/5/8/12/15 ms, scaled to `peak_db` dBFS peak. `ring` adds a damped
/// 2.5-4 kHz keycap ring (model "burst + ring"); otherwise the noise burst
/// alone. Clicks start at `start` and end `tail` samples before `n`.
fn clicks(n: usize, start: usize, tail: usize, peak_db: f32, ring: bool, seed: u32) -> Vec<f32> {
    let mut r = Lcg(seed);
    let mut out = vec![0.0f32; n];
    let lens_ms = [2.0f32, 5.0, 8.0, 12.0, 15.0];
    let mut t = start + 2_400;
    let mut k = 0usize;
    loop {
        let len = (lens_ms[k % lens_ms.len()] * 48.0) as usize;
        let span = (len * 4).max(480);
        if t + span >= n - tail {
            break;
        }
        let f = 2_500.0 + 1_500.0 * r.next();
        let tau = len as f32 / 3.0;
        let mut c: Vec<f32> = (0..span)
            .map(|i| {
                let x = i as f32;
                let burst = if i < len {
                    r.gauss() * (-x / tau).exp()
                } else {
                    0.0
                };
                let rg = if ring {
                    (2.0 * std::f32::consts::PI * f * x / FS as f32).sin()
                        * (-x / 192.0).exp()
                        * 1.5
                } else {
                    0.0
                };
                burst + rg
            })
            .collect();
        let peak = c.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-9);
        let g = db_to_lin(peak_db) / peak;
        for (i, v) in c.iter_mut().enumerate() {
            out[t + i] += *v * g;
        }
        t += (FS as f32 * (0.12 + 0.10 * r.next())) as usize;
        k += 1;
    }
    out
}

/// The user's chain: noise cleanup 100 %, gate auto, auto gain 0.1, volume 0.9.
fn user_chain() -> (Arc<MicParams>, MicChain) {
    let p = Arc::new(MicParams::new());
    p.set_suppress_enabled(true);
    p.set_suppress_amount(1.0);
    p.set_gate_enabled(true);
    p.set_gate_auto(true);
    p.set_gate_auto_margin_db(6.0);
    p.set_agc_enabled(true);
    p.set_agc_target(0.1);
    p.set_volume(0.9);
    let c = MicChain::new(p.clone());
    (p, c)
}

fn run(chain: &mut MicChain, input: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(input.len());
    for c in input.chunks(480) {
        chain.process(c, &mut out);
    }
    out
}

/// Energy of the click-attributable output relative to the input clicks, dB
/// (f64::NEG_INFINITY when the gate never let anything through).
fn click_energy_db(bg: &[f32], clk: &[f32], base_out: &[f32], from: usize) -> f64 {
    let noisy: Vec<f32> = bg.iter().zip(clk).map(|(a, b)| a + b).collect();
    let (_p, mut chain) = user_chain();
    let out = run(&mut chain, &noisy);
    let diff: Vec<f32> = out[from..]
        .iter()
        .zip(&base_out[from..])
        .map(|(a, b)| a - b)
        .collect();
    let e_out = energy(&diff);
    let e_in = energy(&clk[from..]);
    10.0 * (e_out / e_in).log10()
}

#[test]
fn gate_ignores_isolated_clicks_silent() {
    let n = (WARMUP_S + MEASURE_S) * FS;
    let from = WARMUP_S * FS;
    let backgrounds = [
        ("white -60", Bg::White(-60.0)),
        ("white -50", Bg::White(-50.0)),
        ("pink -50", Bg::Pink(-50.0)),
        ("pink -40", Bg::Pink(-40.0)),
    ];
    let mut worst = f64::NEG_INFINITY;
    let mut report = String::new();
    for (name, bg) in backgrounds {
        let noise = background(bg, n, 11);
        let (_p, mut chain) = user_chain();
        let base = run(&mut chain, &noise);
        for ring in [true, false] {
            for peak in [-30.0f32, -20.0, -10.0] {
                let clk = clicks(n, from, 4_800, peak, ring, 5);
                let e = click_energy_db(&noise, &clk, &base, from);
                report.push_str(&format!("{name} ring={ring} peak={peak}: {e:.1} dB\n"));
                worst = worst.max(e);
            }
        }
    }
    println!("{report}");
    assert!(
        worst <= -30.0,
        "clicks must be attenuated by at least 30 dB, worst {worst:.1} dB\n{report}"
    );
}

#[test]
fn gate_ignores_clicks_typed_from_the_first_second() {
    // Typing starts with the mic: the floor is learned with clicks present.
    let n = 8 * FS;
    let noise = background(Bg::White(-60.0), n, 12);
    let (_p, mut chain) = user_chain();
    let base = run(&mut chain, &noise);
    let clk = clicks(n, 0, 4_800, -20.0, true, 6);
    let e = click_energy_db(&noise, &clk, &base, 2 * FS);
    println!("typing from t=0: {e:.1} dB");
    assert!(e <= -30.0, "clicks typed from the start passed: {e:.1} dB");
}

// ---- speech onsets -------------------------------------------------------

/// Voiced speech-like signal: f0 ~125 Hz with intonation and vibrato,
/// harmonics to 4 kHz (-6 dB/oct), 3-formant vowel envelope per syllable.
/// Syllables 120-260 ms, gaps 40-120 ms, a 450 ms pause every 6. Returns the
/// signal (0.05 RMS over voiced parts) and each syllable's start sample.
fn speech(n: usize, start: usize, pause_every: usize) -> (Vec<f32>, Vec<(usize, bool)>) {
    let mut r = Lcg(21);
    let mut out = vec![0.0f32; n];
    let mut starts = Vec::new();
    let mut t = start;
    let mut phase = 0.0f32;
    let mut syl = 0usize;
    let mut after_pause = true;
    while t + 15_000 < n {
        let len = (FS as f32 * (0.12 + 0.14 * r.next())) as usize;
        let f1 = 450.0 + 400.0 * r.next();
        let f2 = 1_100.0 + 1_000.0 * r.next();
        let f3 = 2_500.0 + 300.0 * r.next();
        starts.push((t, after_pause));
        for i in 0..len {
            let tt = i as f32 / FS as f32;
            let f0 = 125.0 * (1.0 + 0.08 * (tt * 6.0).sin()) * (1.0 + 0.01 * (r.next() - 0.5));
            phase += 2.0 * std::f32::consts::PI * f0 / FS as f32;
            let mut v = 0.0;
            let mut k = 1.0f32;
            while k * f0 < 4_000.0 {
                let f = k * f0;
                let form = (-((f - f1) / 150.0).powi(2)).exp()
                    + 0.6 * (-((f - f2) / 250.0).powi(2)).exp()
                    + 0.3 * (-((f - f3) / 300.0).powi(2)).exp()
                    + 0.05;
                v += (phase * k).sin() / k * form;
                k += 1.0;
            }
            let att = (i as f32 / 384.0).min(1.0); // 8 ms attack
            let rel = ((len - i) as f32 / 480.0).min(1.0);
            out[t + i] = v * att * rel;
        }
        syl += 1;
        after_pause = syl % pause_every == 0;
        let gap = if after_pause {
            (FS as f32 * 0.45) as usize
        } else {
            (FS as f32 * (0.04 + 0.08 * r.next())) as usize
        };
        t += len + gap;
    }
    let voiced: Vec<f32> = out.iter().copied().filter(|v| *v != 0.0).collect();
    let g = 0.05 / rms(&voiced).max(1e-9);
    for s in out.iter_mut() {
        *s *= g;
    }
    (out, starts)
}

fn speech_chain(gate: bool) -> MicChain {
    let p = Arc::new(MicParams::new());
    p.set_suppress_enabled(true);
    p.set_suppress_amount(1.0);
    p.set_gate_enabled(gate);
    p.set_gate_auto(true);
    p.set_gate_auto_margin_db(6.0);
    MicChain::new(p)
}

#[test]
fn gate_keeps_speech_onset_with_lookahead() {
    // Only onsets that start from a closed gate (after a pause longer than
    // the hold) can lose anything; measure the worst of them.
    let n = 16 * FS;
    let (sp, starts) = speech(n, 3 * FS, 3);
    let noise = background(Bg::White(-60.0), n, 13);
    let x: Vec<f32> = sp.iter().zip(&noise).map(|(a, b)| a + b).collect();
    let reference = run(&mut speech_chain(false), &x);
    let gated = run(&mut speech_chain(true), &x);
    // Gated output is the reference delayed by the 40 ms lookahead; compare
    // the first 40 ms of each onset (RNNoise's own 10 ms delay included).
    let look = super::gate::NoiseGate::LOOKAHEAD;
    let (mut worst, mut count) = (0f64, 0);
    for &(s, closed) in &starts {
        if !closed {
            continue;
        }
        let (a, b) = (s, s + 1_920);
        let loss = 10.0 * (energy(&reference[a..b]) / energy(&gated[a + look..b + look])).log10();
        println!("onset at {s}: loss {loss:.2} dB");
        worst = worst.max(loss);
        count += 1;
    }
    assert!(count >= 5, "{count} closed-gate onsets");
    assert!(worst <= 1.0, "worst onset loss {worst:.2} dB");
}

#[test]
fn gate_closes_when_typing_after_speech() {
    // Speech, then 3 s of typing (key-down and key-up clicks ~100 ms apart,
    // ~6 keys/s) over a -60 dBFS floor. Threshold = raw floor + 6 dB.
    let thr = 0.001 * db_to_lin(6.0);
    for peak in [-30.0f32, -20.0, -10.0] {
        let lead = 2 * FS;
        let speech_len = FS;
        let n = lead + speech_len + 3 * FS;
        let mut x = background(Bg::White(-60.0), n, 41);
        for (i, v) in x[lead..lead + speech_len].iter_mut().enumerate() {
            *v += (i as f32 * 0.05).sin() * 0.07;
        }
        let typing_start = lead + speech_len;
        let down = clicks(n, typing_start, 4_800, peak, true, 7);
        let mut r = Lcg(9);
        let mut clk = down.clone();
        // Key-up click = a second click train shifted by 80-120 ms.
        let shift = (FS as f32 * (0.08 + 0.04 * r.next())) as usize;
        for i in 0..n - shift {
            clk[i + shift] += 0.7 * down[i];
        }
        for (v, c) in x.iter_mut().zip(&clk) {
            *v += c;
        }
        let mut g = super::gate::NoiseGate::new();
        let mut open_after = 0usize;
        let mut open_chunks = 0usize;
        let mut y = x.clone();
        for (k, c) in y.chunks_mut(480).enumerate() {
            g.process_rms(c, thr);
            let t = k * 480;
            if t > typing_start + FS / 4 + 480 && t < n - 4_800 {
                open_chunks += g.is_open() as usize;
                open_after += 1;
            }
        }
        // Closed within ~250 ms after the speech ended, and stays closed.
        assert!(open_after > 100);
        assert_eq!(
            open_chunks, 0,
            "peak {peak}: gate open in {open_chunks}/{open_after} chunks while typing"
        );
        println!("typing after speech peak {peak}: closed throughout");
    }
}

// ---- threshold, AGC, latency ---------------------------------------------

#[test]
fn auto_threshold_uses_raw_floor() {
    // RNNoise pushes steady noise 30+ dB down, so a threshold learned only
    // after suppression would sit near -90 dBFS. The raw mic floor (-60 dBFS)
    // + 6 dB must be the lower bound.
    let (p, mut chain) = user_chain();
    let noise = background(Bg::White(-60.0), 13 * FS, 14);
    let _ = run(&mut chain, &noise);
    let thr = p.gate_threshold_live();
    let raw_plus_6 = 0.001 * db_to_lin(6.0);
    assert!(
        thr >= raw_plus_6 * 0.8 && thr <= raw_plus_6 * 1.6,
        "threshold {thr} (dBFS {:.1}) should sit at the raw floor + 6 dB ({raw_plus_6})",
        20.0 * thr.log10()
    );

    // Suppression off: both floors are the same signal, the rule still holds.
    let p2 = Arc::new(MicParams::new());
    p2.set_gate_enabled(true);
    p2.set_gate_auto(true);
    let mut c2 = MicChain::new(p2.clone());
    let _ = run(&mut c2, &noise);
    let t2 = p2.gate_threshold_live();
    assert!(t2 >= raw_plus_6 * 0.8 && t2 <= raw_plus_6 * 1.6, "{t2}");
}

#[test]
fn agc_holds_gain_while_gate_closed() {
    let p = Arc::new(MicParams::new());
    p.set_gate_enabled(true);
    p.set_gate_threshold(0.02);
    p.set_agc_enabled(true);
    p.set_agc_target(0.01);
    let mut chain = MicChain::new(p);
    // 1 s of speech-level tone (0.1 RMS), then noise 6 dB under the line.
    let mut x: Vec<f32> = (0..FS).map(|i| (i as f32 * 0.05).sin() * 0.14).collect();
    let mut r = Lcg(31);
    x.extend((0..4 * FS).map(|_| r.gauss() * 0.01));
    let mut out = Vec::new();
    let mut gain_at_close = None;
    let mut last = 0.0;
    for (b, c) in x.chunks(480).enumerate() {
        chain.process(c, &mut out);
        if b * 480 > FS {
            if gain_at_close.is_none() && !chain.gate.is_open() {
                gain_at_close = Some(chain.agc.gain());
            }
            last = chain.agc.gain();
        }
    }
    let g0 = gain_at_close.expect("gate never closed");
    assert!(
        (last - g0).abs() <= 0.01 * g0,
        "AGC gain moved while the gate was closed: {g0} -> {last}"
    );
}

#[test]
fn gate_latency_is_40ms() {
    // Whatever the block size, the audio through an open gate is exactly
    // 1920 samples (40 ms) late.
    for block in [37usize, 480, 1_000, 4_096] {
        let mut g = NoiseGate::new();
        let n = FS;
        let spike_at = 30_000usize;
        let mut x: Vec<f32> = (0..n).map(|_| 0.3f32).collect();
        x[spike_at] = 0.9;
        let mut y = x.clone();
        for c in y.chunks_mut(block) {
            g.process_rms(c, 0.02);
        }
        let (idx, peak) = y
            .iter()
            .enumerate()
            .skip(20_000)
            .fold(
                (0, 0f32),
                |m, (i, v)| if v.abs() > m.1 { (i, v.abs()) } else { m },
            );
        assert_eq!(idx, spike_at + 1_920, "block {block}");
        assert!(peak > 0.89, "block {block}: peak {peak}");
    }
}
