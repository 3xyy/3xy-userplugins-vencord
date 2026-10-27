//! Per-process (application) WASAPI loopback capture.
//!
//! Captures the audio rendered by a target process tree (e.g. a browser or
//! Spotify) via the WASAPI process-loopback activation path and pushes f32
//! stereo into a ring. Ported from the proven `spike-process-loopback` spike;
//! mirrors `CaptureStream` (capture.rs) for thread/closure/error-logging shape.

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Context, Result};
use windows::core::{implement, IUnknown, Interface, HRESULT, PCWSTR, PROPVARIANT};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::audio::devices::init_com;
use crate::audio::format::{i16_to_f32, CHANNELS, SAMPLE_RATE};
use crate::audio::ringbuffer::RingProducer;

const VT_BLOB_U16: u16 = 65;
const BITS: u16 = 16;

pub struct ProcessLoopbackCapture;

impl ProcessLoopbackCapture {
    /// Spawn a thread capturing the audio of the process tree rooted at `pid`.
    /// Stops cleanly when `stop` is set. The thread never panics; device-path
    /// errors are logged via `elog!` (stderr + engine log) at thread exit.
    pub fn start(
        pid: u32,
        mut producer: RingProducer,
        stop: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>> {
        Ok(thread::spawn(move || {
            if let Err(e) = run(pid, &mut producer, &stop) {
                elog!("[process_loopback] thread error: {e:#}");
            }
        }))
    }
}

// Layout-compatible mirror of a VT_BLOB PROPVARIANT (24 bytes on x64). The public
// `windows::core::PROPVARIANT` is an opaque newtype in 0.58 (inner union is
// private), so we build the C layout ourselves and cast the pointer when calling
// the API.
#[repr(C)]
struct PropVariantBlob {
    vt: u16,
    w1: u16,
    w2: u16,
    w3: u16,
    cb_size: u32, // BLOB.cbSize at union offset 0
    _pad: u32,    // pad so the pointer is 8-byte aligned (matches BLOB layout)
    p_blob_data: *mut u8,
}

const _: () = assert!(std::mem::size_of::<PropVariantBlob>() == 24);

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Handler(Arc<(Mutex<bool>, Condvar)>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(
        &self,
        _op: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let (lock, cvar) = &*self.0;
        let mut done = lock.lock().unwrap_or_else(|p| p.into_inner());
        *done = true;
        drop(done);
        cvar.notify_one();
        Ok(())
    }
}

fn make_format() -> WAVEFORMATEX {
    let block_align = (CHANNELS * (BITS / 8)) as u16;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: BITS,
        cbSize: 0,
    }
}

/// Activate an IAudioClient bound to the process-loopback virtual device for the
/// given target process tree.
fn activate_loopback_client(pid: u32) -> Result<IAudioClient> {
    unsafe {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        // Wrap the activation params struct in a VT_BLOB PROPVARIANT (built via the
        // layout-compatible mirror, then cast to the opaque public PROPVARIANT).
        let prop = PropVariantBlob {
            vt: VT_BLOB_U16,
            w1: 0,
            w2: 0,
            w3: 0,
            cb_size: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            _pad: 0,
            p_blob_data: &mut params as *mut _ as *mut u8,
        };
        let prop_ptr = &prop as *const PropVariantBlob as *const PROPVARIANT;

        let setup = Arc::new((Mutex::new(false), Condvar::new()));
        let handler: IActivateAudioInterfaceCompletionHandler = Handler(setup.clone()).into();

        let operation: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(prop_ptr),
            &handler,
        )
        .context("ActivateAudioInterfaceAsync")?;

        // Wait for the async completion callback (bounded: 10 s).
        {
            let (lock, cvar) = &*setup;
            let mut done = lock.lock().unwrap_or_else(|p| p.into_inner());
            let timeout = std::time::Duration::from_secs(10);
            loop {
                if *done {
                    break;
                }
                let (guard, timed_out) = cvar
                    .wait_timeout(done, timeout)
                    .unwrap_or_else(|p| p.into_inner());
                done = guard;
                if timed_out.timed_out() && !*done {
                    return Err(anyhow!("process loopback activation timed out"));
                }
            }
        }

        let mut hr: HRESULT = HRESULT(0);
        let mut unknown: Option<IUnknown> = None;
        operation
            .GetActivateResult(&mut hr, &mut unknown)
            .context("GetActivateResult")?;
        hr.ok().context("activation HRESULT")?;

        let client: IAudioClient = unknown
            .ok_or_else(|| anyhow!("GetActivateResult returned null interface"))?
            .cast()
            .context("cast IUnknown -> IAudioClient")?;
        Ok(client)
    }
}

fn run(pid: u32, producer: &mut RingProducer, stop: &AtomicBool) -> Result<()> {
    init_com()?;

    // Reusable conversion buffer (no per-packet allocation).
    let mut tmp: Vec<f32> = Vec::with_capacity(2048);

    let client = activate_loopback_client(pid)?;
    let fmt = make_format();

    unsafe {
        // Process-loopback clients must be Initialize()'d with
        // LOOPBACK | EVENTCALLBACK, hnsBufferDuration 0, and NO session GUID.
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                &fmt,
                None,
            )
            .context("IAudioClient::Initialize (process loopback)")?;

        let event = CreateEventW(None, false, false, PCWSTR::null())
            .context("CreateEventW (process loopback)")?;
        client
            .SetEventHandle(event)
            .context("SetEventHandle (process loopback)")?;

        let capture: IAudioCaptureClient = client
            .GetService()
            .context("GetService IAudioCaptureClient (process loopback)")?;

        client
            .Start()
            .context("IAudioClient::Start (process loopback)")?;

        while !stop.load(Ordering::Relaxed) {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
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

                // Silent flag (or null ptr) means push zeros (already done).
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) == 0 && !data_ptr.is_null() {
                    let src = std::slice::from_raw_parts(data_ptr as *const i16, n);
                    for (i, &s) in src.iter().enumerate() {
                        tmp[i] = i16_to_f32(s);
                    }
                }

                // Push into the ring; overflow drops samples (acceptable).
                producer.push_slice(&tmp);

                capture
                    .ReleaseBuffer(num_frames)
                    .context("IAudioCaptureClient::ReleaseBuffer")?;
            }
        }

        client
            .Stop()
            .context("IAudioClient::Stop (process loopback)")?;
        CloseHandle(event).ok();
    }

    Ok(())
}
