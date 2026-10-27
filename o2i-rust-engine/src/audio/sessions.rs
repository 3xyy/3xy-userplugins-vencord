//! Point-in-time detection of which process IDs are actively rendering audio
//! on the default playback endpoint, via the WASAPI audio session APIs.
//!
//! Used to sort apps that are currently PLAYING audio to the top of the
//! "Routed apps" picker. This is hardware/COM and therefore has no unit test;
//! it must compile and be panic-free (top-level failures return an empty set).

use super::devices::init_com;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows_core::Interface;

/// Return the set of process IDs that have an *active* audio session on the
/// default render (playback) endpoint. Tolerates per-session errors (skips
/// them) and returns an empty set on any top-level failure. Never panics.
pub fn pids_playing_audio() -> std::collections::HashSet<u32> {
    enumerate().unwrap_or_default()
}

fn enumerate() -> windows::core::Result<std::collections::HashSet<u32>> {
    init_com().ok();
    let mut pids = std::collections::HashSet::new();

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;
        let count = sessions.GetCount()?;

        for i in 0..count {
            // Tolerate per-session errors: a single bad session must not
            // abort the whole scan.
            let control = match sessions.GetSession(i) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let pid = match control2.GetProcessId() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if pid == 0 {
                continue;
            }
            match control2.GetState() {
                Ok(state) if state == AudioSessionStateActive => {
                    pids.insert(pid);
                }
                _ => {}
            }
        }
    }

    Ok(pids)
}
