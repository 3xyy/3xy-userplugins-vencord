use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use crate::audio::ringbuffer::RingConsumer;

pub fn store_f32(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed);
}
pub fn load_f32(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

/// Sidechain ducking parameters: when enabled and the mic is active, all
/// non-mic sources are attenuated toward `target` (a linear gain in 0..1).
/// UI thread writes; the Mixer reads each block.
pub struct DuckParams {
    pub enabled: AtomicBool,
    pub target: AtomicU32,
}

impl Default for DuckParams {
    fn default() -> Self {
        Self::new()
    }
}

impl DuckParams {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            target: AtomicU32::new(0.25f32.to_bits()),
        }
    }
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
    pub fn set_enabled(&self, v: bool) {
        self.enabled.store(v, Ordering::Relaxed);
    }
    pub fn target(&self) -> f32 {
        load_f32(&self.target)
    }
    pub fn set_target(&self, v: f32) {
        store_f32(&self.target, v);
    }
}

pub struct MixSource {
    pub id: u64,
    consumer: RingConsumer,
    volume: Arc<AtomicU32>,
}

impl MixSource {
    pub fn new(id: u64, consumer: RingConsumer, volume: Arc<AtomicU32>) -> Self {
        Self {
            id,
            consumer,
            volume,
        }
    }
}

pub enum MixCommand {
    Add(MixSource),
    Remove(u64),
}

pub struct Mixer {
    sources: Vec<MixSource>,
    rx: Receiver<MixCommand>,
    master: Arc<AtomicU32>,
    scratch: Vec<f32>,
    duck: Arc<DuckParams>,
    duck_gain: f32,
    last_mic_rms: f32,
}

pub fn new_mixer(master: Arc<AtomicU32>, duck: Arc<DuckParams>) -> (Mixer, Sender<MixCommand>) {
    let (tx, rx) = channel();
    (
        Mixer {
            sources: Vec::new(),
            rx,
            master,
            scratch: vec![0.0; 4096],
            duck,
            duck_gain: 1.0,
            last_mic_rms: 0.0,
        },
        tx,
    )
}

impl Mixer {
    fn apply_commands(&mut self) {
        while let Ok(cmd) = self.rx.try_recv() {
            match cmd {
                MixCommand::Add(s) => self.sources.push(s),
                MixCommand::Remove(id) => self.sources.retain(|s| s.id != id),
            }
        }
    }

    pub fn mix_into(&mut self, out: &mut [f32]) {
        self.apply_commands();
        for x in out.iter_mut() {
            *x = 0.0;
        }
        if self.scratch.len() < out.len() {
            self.scratch.resize(out.len(), 0.0);
        }

        // Sidechain ducking: when the mic was active last block, attenuate all
        // non-mic sources toward `target`; otherwise restore to 1.0. Smooth the
        // gain per block (duck down fast, release slow), with no per-sample state.
        let duck_target = if self.duck.enabled() && self.last_mic_rms > 0.02 {
            self.duck.target()
        } else {
            1.0
        };
        let coef = if duck_target < self.duck_gain {
            0.06
        } else {
            0.01
        };
        self.duck_gain += (duck_target - self.duck_gain) * coef;

        for src in self.sources.iter_mut() {
            let buf = &mut self.scratch[..out.len()];
            src.consumer.pop_slice(buf); // zero-fills underflow
            let v = load_f32(&src.volume);
            // The mic (id 0) is never ducked; everything else follows duck_gain.
            let gain = if src.id == 0 { 1.0 } else { self.duck_gain };
            // Measure the mic block's RMS for next block's duck decision.
            if src.id == 0 {
                let mut sum_sq = 0.0f32;
                for &s in buf.iter() {
                    sum_sq += s * s;
                }
                self.last_mic_rms = if buf.is_empty() {
                    0.0
                } else {
                    (sum_sq / buf.len() as f32).sqrt()
                };
            }
            let g = v * gain;
            for (o, &s) in out.iter_mut().zip(buf.iter()) {
                *o += s * g;
            }
        }
        let master = load_f32(&self.master);
        for x in out.iter_mut() {
            *x = (*x * master).clamp(-1.0, 1.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ringbuffer;

    fn vol(v: f32) -> Arc<AtomicU32> {
        Arc::new(AtomicU32::new(v.to_bits()))
    }

    fn no_duck() -> Arc<DuckParams> {
        Arc::new(DuckParams::new())
    }

    #[test]
    fn sums_two_sources_with_volume() {
        let master = vol(1.0);
        let (mut mixer, tx) = new_mixer(master, no_duck());
        let (mut p1, c1) = ringbuffer::new(16);
        let (mut p2, c2) = ringbuffer::new(16);
        p1.push_slice(&[1.0, 1.0, 1.0, 1.0]);
        p2.push_slice(&[0.5, 0.5, 0.5, 0.5]);
        tx.send(MixCommand::Add(MixSource::new(1, c1, vol(0.5))))
            .unwrap();
        tx.send(MixCommand::Add(MixSource::new(2, c2, vol(1.0))))
            .unwrap();
        let mut out = [9.0; 4];
        mixer.mix_into(&mut out);
        // 1.0*0.5 + 0.5*1.0 = 1.0 each
        for &x in &out {
            assert!((x - 1.0).abs() < 1e-6, "got {}", x);
        }
    }

    #[test]
    fn master_volume_and_clip() {
        let master = vol(1.0);
        let (mut mixer, tx) = new_mixer(master.clone(), no_duck());
        let (mut p, c) = ringbuffer::new(16);
        p.push_slice(&[1.0, 1.0]);
        tx.send(MixCommand::Add(MixSource::new(1, c, vol(2.0))))
            .unwrap();
        let mut out = [0.0; 2];
        mixer.mix_into(&mut out); // 1.0*2.0 = 2.0 -> clamped to 1.0
        assert!((out[0] - 1.0).abs() < 1e-6);
        store_f32(&master, 0.25);
        let (mut p2, c2) = ringbuffer::new(16);
        p2.push_slice(&[0.8, 0.8]);
        tx.send(MixCommand::Remove(1)).unwrap();
        tx.send(MixCommand::Add(MixSource::new(2, c2, vol(1.0))))
            .unwrap();
        let mut out2 = [0.0; 2];
        mixer.mix_into(&mut out2); // 0.8 * master 0.25 = 0.2
        assert!((out2[0] - 0.2).abs() < 1e-6, "got {}", out2[0]);
    }

    #[test]
    fn no_sources_is_silence() {
        let (mut mixer, _tx) = new_mixer(vol(1.0), no_duck());
        let mut out = [7.0; 8];
        mixer.mix_into(&mut out);
        assert!(out.iter().all(|&x| x == 0.0));
    }

    /// With ducking enabled and a loud mic, the app source's contribution to the
    /// output settles toward `target` (0.25) of its undugged level.
    #[test]
    fn ducking_attenuates_app_toward_target() {
        // Helper: run `blocks` mix passes, refilling a loud mic (id 0) and an
        // app (id 1) each block, returning the last block's app-only output.
        fn run(duck: Arc<DuckParams>) -> f32 {
            let master = vol(1.0);
            let (mut mixer, tx) = new_mixer(master, duck);
            // Mic loud constant; app constant 0.5. Use large rings so refills fit.
            let (mut pm, cm) = ringbuffer::new(8192);
            let (mut pa, ca) = ringbuffer::new(8192);
            tx.send(MixCommand::Add(MixSource::new(0, cm, vol(1.0))))
                .unwrap();
            tx.send(MixCommand::Add(MixSource::new(1, ca, vol(1.0))))
                .unwrap();
            let mut out = [0.0f32; 64];
            let mut last = 0.0;
            for _ in 0..60 {
                pm.push_slice(&[0.5; 64]); // loud mic, RMS 0.5 > 0.02
                pa.push_slice(&[0.5; 64]); // app signal
                mixer.mix_into(&mut out);
                // out = mic*1.0 + app*duck_gain. Subtract the (constant) mic part
                // to isolate the app contribution.
                last = out[0] - 0.5;
            }
            last
        }

        let duck = Arc::new(DuckParams::new());
        duck.set_enabled(true);
        duck.set_target(0.25);
        let ducked_app = run(duck);

        let undugged_app = run(Arc::new(DuckParams::new())); // disabled by default

        // Undugged app contributes ~0.5; ducked should be ~0.25 * 0.5 = 0.125.
        assert!(
            (undugged_app - 0.5).abs() < 1e-3,
            "undugged app = {}",
            undugged_app
        );
        let expected = undugged_app * 0.25;
        assert!(
            (ducked_app - expected).abs() < 0.02,
            "ducked app = {} (expected ~{})",
            ducked_app,
            expected
        );
    }
}
