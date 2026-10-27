use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::audio::devices::init_com;
use crate::audio::format::{i16_to_f32, CHANNELS, SAMPLE_RATE};
use crate::audio::health::StreamHealth;
use crate::audio::ringbuffer::RingProducer;
use crate::dsp::{MicChain, MicParams};

/// Most audio (samples; ~30 ms of stereo, 3 capture packets) queued for the
/// monitor before further blocks are dropped, so at most ~40 ms waits. The
/// mic and the headphones run on different clocks; without a cap, drift
/// would slowly grow the self-monitoring delay toward the full ring
/// (~200 ms), which is very disorienting to talk over.
pub const MONITOR_MAX_FILL: usize = SAMPLE_RATE as usize * CHANNELS as usize * 30 / 1000;

/// "Listen to yourself": copies the processed mic (what Discord hears) into
/// the monitor ring while `params.monitor_mic()` is on. Runs on the capture
/// thread: one atomic load when off; when on, a lock-free, allocation-free
/// ring push that never blocks (drops whole blocks when backed up).
pub struct MonitorTap {
    producer: RingProducer,
    params: Arc<MicParams>,
}

impl MonitorTap {
    pub fn new(producer: RingProducer, params: Arc<MicParams>) -> Self {
        Self { producer, params }
    }

    /// Push one interleaved-stereo block; returns the samples written (0 when
    /// monitoring is off or the block was dropped). Whole blocks only, so the
    /// left/right interleave can never slip.
    pub fn feed(&mut self, stereo: &[f32]) -> usize {
        if !self.params.monitor_mic() {
            return 0;
        }
        if self.producer.occupied_len() >= MONITOR_MAX_FILL
            || self.producer.free_len() < stereo.len()
        {
            return 0;
        }
        self.producer.push_slice(stereo)
    }
}

pub struct CaptureStream;

impl CaptureStream {
    /// Spawn the capture thread. Never fails here: WASAPI errors happen on the
    /// thread and are reported through `health` (started once the client
    /// runs; failed with the reason when the thread exits) and stderr.
    /// `monitor` (optional) also receives every pushed block while
    /// listen-to-yourself is on.
    pub fn start(
        device_id: String,
        mut producer: RingProducer,
        stop: Arc<AtomicBool>,
        chain: Option<MicChain>,
        mut monitor: Option<MonitorTap>,
        health: Arc<StreamHealth>,
    ) -> Result<JoinHandle<()>> {
        Ok(thread::spawn(move || {
            let result = run(
                &device_id,
                &mut producer,
                &stop,
                chain,
                monitor.as_mut(),
                &health,
            );
            if let Err(e) = &result {
                elog!("[capture] thread error: {e:#}");
            }
            health.mark_finished(result.err().map(|e| format!("{e:#}")));
        }))
    }
}

fn make_format() -> WAVEFORMATEX {
    let block_align = (CHANNELS * 2) as u16; // 16-bit stereo = 4 bytes/frame
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

fn run(
    device_id: &str,
    producer: &mut RingProducer,
    stop: &AtomicBool,
    mut chain: Option<MicChain>,
    mut monitor: Option<&mut MonitorTap>,
    health: &StreamHealth,
) -> Result<()> {
    init_com()?;

    // Reusable buffers for the optional mic-DSP path (no per-packet allocation).
    let mut tmp: Vec<f32> = Vec::with_capacity(2048);
    let mut mono_in: Vec<f32> = Vec::with_capacity(1024);
    let mut mono_out: Vec<f32> = Vec::with_capacity(1024);
    let mut stereo_out: Vec<f32> = Vec::with_capacity(2048);

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .context("create IMMDeviceEnumerator (capture)")?;

        let wide: Vec<u16> = device_id.encode_utf16().chain([0u16]).collect();
        let device = enumerator
            .GetDevice(PCWSTR(wide.as_ptr()))
            .context("GetDevice(capture)")?;

        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .context("Activate IAudioClient (capture)")?;

        let fmt = make_format();

        let event =
            CreateEventW(None, false, false, PCWSTR::null()).context("CreateEventW (capture)")?;

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0, // 0 = minimal default device period (~10 ms) for low latency
                0,
                &fmt,
                None,
            )
            .context("IAudioClient::Initialize (capture)")?;

        client
            .SetEventHandle(event)
            .context("SetEventHandle (capture)")?;

        let capture: IAudioCaptureClient = client
            .GetService()
            .context("GetService IAudioCaptureClient")?;

        client.Start().context("IAudioClient::Start (capture)")?;
        health.mark_started();

        while !stop.load(Ordering::Relaxed) {
            let result = WaitForSingleObject(event, 200);
            if result != WAIT_OBJECT_0 {
                // No buffer for 200 ms. A removed/invalidated device can stop
                // signalling altogether, so touch the client: it then fails
                // (AUDCLNT_E_DEVICE_INVALIDATED) and the thread exits with the
                // reason instead of idling forever while looking healthy.
                capture
                    .GetNextPacketSize()
                    .context("capture device check")?;
                continue;
            }

            loop {
                let packet = capture.GetNextPacketSize().context("GetNextPacketSize")?;
                if packet == 0 {
                    break;
                }

                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                capture
                    .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                    .context("IAudioCaptureClient::GetBuffer")?;

                let n = num_frames as usize * CHANNELS as usize;
                tmp.clear();
                tmp.resize(n, 0.0f32);

                // Only convert samples when not silent; silent flag means push zeros (already done)
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 && !data_ptr.is_null() {
                    let src = std::slice::from_raw_parts(data_ptr as *const i16, n);
                    for (i, &s) in src.iter().enumerate() {
                        tmp[i] = i16_to_f32(s);
                    }
                }

                // Push into the ring; overflow drops samples (acceptable for passthrough).
                // When a mic chain is present, downmix to mono, process, and upmix.
                match &mut chain {
                    Some(c) => {
                        // Downmix interleaved stereo -> mono
                        mono_in.clear();
                        for frame in tmp.chunks_exact(CHANNELS as usize) {
                            mono_in.push((frame[0] + frame[1]) * 0.5);
                        }
                        mono_out.clear();
                        c.process(&mono_in, &mut mono_out);
                        // Upmix mono -> interleaved stereo
                        stereo_out.clear();
                        for &s in &mono_out {
                            stereo_out.push(s);
                            stereo_out.push(s);
                        }
                        producer.push_slice(&stereo_out);
                        if let Some(m) = monitor.as_deref_mut() {
                            m.feed(&stereo_out);
                        }
                    }
                    None => {
                        producer.push_slice(&tmp);
                        if let Some(m) = monitor.as_deref_mut() {
                            m.feed(&tmp);
                        }
                    }
                }

                capture
                    .ReleaseBuffer(num_frames)
                    .context("IAudioCaptureClient::ReleaseBuffer")?;
            }
        }

        client.Stop().context("IAudioClient::Stop (capture)")?;
        windows::Win32::Foundation::CloseHandle(event).ok();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ringbuffer;

    const RING: usize = SAMPLE_RATE as usize * CHANNELS as usize / 5; // ~200 ms

    #[test]
    fn monitor_mic_off_pushes_nothing() {
        let params = Arc::new(MicParams::new()); // monitor_mic defaults off
        let (prod, mut cons) = ringbuffer::new(RING);
        let mut tap = MonitorTap::new(prod, params.clone());
        let block = [0.5f32; 960]; // 10 ms of stereo
        let mut out = [9.0f32; 960];

        assert_eq!(tap.feed(&block), 0);
        assert_eq!(cons.pop_slice(&mut out), 0, "off: the ring stays empty");

        // On: the processed block goes to the monitor unchanged.
        params.set_monitor_mic(true);
        assert_eq!(tap.feed(&block), 960);
        assert_eq!(cons.pop_slice(&mut out), 960);
        assert!(out.iter().all(|&s| s == 0.5));

        // Off again: nothing more is pushed.
        params.set_monitor_mic(false);
        assert_eq!(tap.feed(&block), 0);
        assert_eq!(cons.pop_slice(&mut out), 0);
    }

    #[test]
    fn monitor_tap_drops_whole_blocks_when_backed_up() {
        // Nothing drains the ring (e.g. the monitor device failed): pushes
        // never block, never split a block (keeps L/R aligned), and stop at
        // the latency cap far below the 200 ms ring.
        let params = Arc::new(MicParams::new());
        params.set_monitor_mic(true);
        let (prod, _cons) = ringbuffer::new(RING);
        let mut tap = MonitorTap::new(prod, params);
        let block = [0.25f32; 960];
        let mut total = 0;
        for _ in 0..100 {
            let n = tap.feed(&block);
            assert!(n == 0 || n == block.len(), "partial block pushed: {n}");
            total += n;
        }
        assert!(total >= MONITOR_MAX_FILL, "queued {total}");
        // Hearing yourself: never more than ~40 ms queued (4 capture packets).
        let ms40 = SAMPLE_RATE as usize * CHANNELS as usize * 40 / 1000;
        assert!(total <= ms40, "queued {total} > 40 ms");
        assert!(total <= MONITOR_MAX_FILL + block.len(), "queued {total}");
        assert!(total < RING);
    }
}
