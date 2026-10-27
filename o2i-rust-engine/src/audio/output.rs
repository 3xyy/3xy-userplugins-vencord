use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use windows::core::PCWSTR;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::audio::devices::init_com;
use crate::audio::format::{f32_to_i16, CHANNELS, SAMPLE_RATE};
use crate::audio::health::StreamHealth;
use crate::audio::mixer::Mixer;

pub struct OutputStream;

impl OutputStream {
    /// Spawn the render thread. Never fails here: WASAPI errors happen on the
    /// thread and are reported through `health` (started once the client
    /// runs; failed with the reason when the thread exits) and stderr.
    pub fn start(
        device_id: &str,
        mut mixer: Mixer,
        stop: Arc<AtomicBool>,
        health: Arc<StreamHealth>,
    ) -> Result<JoinHandle<()>> {
        let device_id = device_id.to_owned();
        let handle = thread::spawn(move || {
            let result = run(&device_id, &mut mixer, &stop, &health);
            if let Err(e) = &result {
                elog!("[output] thread error: {e:#}");
            }
            health.mark_finished(result.err().map(|e| format!("{e:#}")));
        });
        Ok(handle)
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

fn run(device_id: &str, mixer: &mut Mixer, stop: &AtomicBool, health: &StreamHealth) -> Result<()> {
    init_com()?;

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .context("create IMMDeviceEnumerator")?;

        let wide: Vec<u16> = device_id.encode_utf16().chain([0u16]).collect();
        let device = enumerator
            .GetDevice(PCWSTR(wide.as_ptr()))
            .context("GetDevice(render)")?;

        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .context("Activate IAudioClient")?;

        let fmt = make_format();

        let event = CreateEventW(None, false, false, PCWSTR::null()).context("CreateEventW")?;

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0, // 0 = minimal default device period (~10 ms) for low latency
                0,
                &fmt,
                None,
            )
            .context("IAudioClient::Initialize")?;

        client.SetEventHandle(event).context("SetEventHandle")?;

        let buffer_frames = client.GetBufferSize().context("GetBufferSize")?;
        let render: IAudioRenderClient = client
            .GetService()
            .context("GetService IAudioRenderClient")?;

        client.Start().context("IAudioClient::Start")?;
        health.mark_started();

        let sample_capacity = buffer_frames as usize * CHANNELS as usize;
        let mut scratch = vec![0.0f32; sample_capacity];

        while !stop.load(Ordering::Relaxed) {
            let result = WaitForSingleObject(event, 200);
            if result != WAIT_OBJECT_0 {
                // No period for 200 ms. A removed/invalidated device can stop
                // signalling altogether, so touch the client: it then fails
                // (AUDCLNT_E_DEVICE_INVALIDATED) and the thread exits with the
                // reason instead of idling forever while looking healthy.
                client.GetCurrentPadding().context("render device check")?;
                continue;
            }

            let padding = client.GetCurrentPadding().context("GetCurrentPadding")?;
            let available = buffer_frames.saturating_sub(padding);
            if available == 0 {
                continue;
            }

            let needed_samples = available as usize * CHANNELS as usize;
            mixer.mix_into(&mut scratch[..needed_samples]);

            let data_ptr = render.GetBuffer(available).context("GetBuffer")?;
            let out = std::slice::from_raw_parts_mut(data_ptr as *mut i16, needed_samples);
            for (i, &s) in scratch[..needed_samples].iter().enumerate() {
                out[i] = f32_to_i16(s);
            }
            render
                .ReleaseBuffer(available, 0)
                .context("ReleaseBuffer")?;
        }

        client.Stop().context("IAudioClient::Stop")?;
        // Close the event handle
        windows::Win32::Foundation::CloseHandle(event).ok();
    }

    Ok(())
}
