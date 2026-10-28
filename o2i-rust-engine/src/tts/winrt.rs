//! Windows voices through WinRT `SpeechSynthesizer`. Synthesis returns an
//! in-memory WAV stream, which is read out and parsed here; resampling to
//! 48 kHz happens in the caller. Every entry point initializes WinRT on the
//! calling thread (MTA) first.

use windows::core::HSTRING;
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::{parse_wav, Audio, Synth, Voice};

const PREFIX: &str = "win:";
/// HRESULT_FROM_WIN32(ERROR_NOT_FOUND): the voice id no longer exists.
const NOT_FOUND: windows::core::HRESULT = windows::core::HRESULT(0x8007_0490_u32 as i32);

pub struct WindowsSynth;

/// Join the multithreaded apartment on this thread. A thread that is already
/// initialized (either mode) reports so in the result, which is fine to
/// ignore: WinRT calls work either way.
fn init_winrt() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

fn all_voices() -> windows::core::Result<Vec<Voice>> {
    init_winrt();
    let mut out = Vec::new();
    for v in SpeechSynthesizer::AllVoices()? {
        out.push(Voice {
            id: format!("{PREFIX}{}", v.Id()?),
            name: v.DisplayName()?.to_string(),
            source: "windows",
            installed: true,
            size_mb: None,
        });
    }
    Ok(out)
}

fn synth_wav(voice_id: &str, text: &str, rate: f32) -> windows::core::Result<Vec<u8>> {
    init_winrt();
    let synth = SpeechSynthesizer::new()?;
    let info = SpeechSynthesizer::AllVoices()?
        .into_iter()
        .find(|v| v.Id().is_ok_and(|id| id.to_string() == voice_id))
        .ok_or_else(|| windows::core::Error::new(NOT_FOUND, "voice not found"))?;
    synth.SetVoice(&info)?;
    synth.Options()?.SetSpeakingRate(rate as f64)?;
    let stream = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))?
        .get()?;
    let size = stream.Size()? as u32;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    reader.LoadAsync(size)?.get()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

impl Synth for WindowsSynth {
    fn prefix(&self) -> &'static str {
        PREFIX
    }

    fn voices(&self) -> Vec<Voice> {
        all_voices().unwrap_or_else(|e| {
            elog!("[tts] could not list Windows voices: {e}");
            Vec::new()
        })
    }

    fn synthesize(&self, voice: &str, text: &str, rate: f32) -> Result<Audio, String> {
        let id = voice.strip_prefix(PREFIX).unwrap_or(voice);
        let bytes = synth_wav(id, text, rate).map_err(|e| {
            if e.code() == NOT_FOUND {
                format!("Unknown voice: {voice}")
            } else {
                format!("Speech failed: {e}")
            }
        })?;
        parse_wav(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real WinRT round trip (no audio output): skipped when the machine has
    /// no Windows voices.
    #[test]
    fn windows_voice_synthesizes_audio() {
        let s = WindowsSynth;
        let Some(v) = s.voices().into_iter().next() else {
            return;
        };
        assert!(v.id.starts_with("win:"));
        let a = s.synthesize(&v.id, "Hello", 1.0).expect("synthesis");
        assert!(a.rate >= 8000, "{}", a.rate);
        assert!(a.samples.len() as u32 > a.rate / 4, "too short: {}", a.samples.len());
        assert!(a.samples.iter().any(|&x| x.abs() > 0.01), "silent");
        // A voice that no longer exists is an error, not the default voice.
        let err = s.synthesize("win:no-such-voice", "Hello", 1.0).err().expect("must fail");
        assert!(err.starts_with("Unknown voice"), "{err}");
    }
}
