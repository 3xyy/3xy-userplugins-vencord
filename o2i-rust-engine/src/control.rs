//! Shared control helpers used by both the egui window and the headless engine.
//! Enumeration runs on a spawned MTA thread; never call it from the UI thread's COM state.

use crate::audio;
use crate::audio::devices::DeviceInfo;
use crate::config::{Profile, RoutedApp};
use crate::dsp::{MicParams, VoicePreset};
use crate::engine::Engine;

pub struct DeviceLists {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
    pub cable: Option<DeviceInfo>,
}

/// Enumerate capture/render devices and locate "CABLE Input" on a dedicated MTA thread.
pub fn enumerate_devices() -> DeviceLists {
    std::thread::spawn(|| {
        audio::devices::init_com().ok();
        let inputs = audio::devices::list_capture_devices().unwrap_or_default();
        let outputs = audio::devices::list_render_devices().unwrap_or_default();
        let cable = audio::devices::find_render_by_name("CABLE Input")
            .ok()
            .flatten();
        DeviceLists {
            inputs,
            outputs,
            cable,
        }
    })
    .join()
    .unwrap_or(DeviceLists {
        inputs: Vec::new(),
        outputs: Vec::new(),
        cable: None,
    })
}

/// Apply saved DSP values from `profile` to `params`.
///
/// The older `Option<f32>` fields are `None` when the key was absent from the
/// config file (older files) and `Some(x)` when the user deliberately
/// saved a value, 0.0 included. Only `Some` values are written; `None`
/// leaves `params` as is. The headless-only fields (`monitor_mic*`, `gate_auto*`,
/// `mic_quality`) are always written, `None` meaning the protocol default.
pub fn apply_profile_dsp(params: &MicParams, p: &Profile) {
    params.set_gate_enabled(p.gate_enabled);
    if let Some(v) = p.gate_threshold {
        params.set_gate_threshold(v);
    }
    params.set_suppress_enabled(p.suppress_enabled);
    if let Some(v) = p.suppress_amount {
        params.set_suppress_amount(v);
    }
    params.set_agc_enabled(p.agc_enabled);
    if let Some(v) = p.agc_target {
        params.set_agc_target(v);
    }
    if let Some(v) = p.mic_volume {
        params.set_volume(v);
    }
    if let Some(ref s) = p.voice_preset {
        params.set_voice_preset(VoicePreset::from_str_id(s));
    }
    if let Some(v) = p.voice_intensity {
        params.set_voice_intensity(v);
    }
    // Listen-to-yourself + auto gate (headless only). Here `None` (JSON null) means
    // the protocol default, so it is written too: a configure that drops a
    // value must not leave the previous one behind.
    params.set_monitor_mic(p.monitor_mic);
    params.set_monitor_mic_volume(p.monitor_mic_volume.unwrap_or(1.0).clamp(0.0, 2.0));
    params.set_gate_auto(p.gate_auto);
    params.set_gate_auto_margin_db(
        p.gate_auto_margin_db
            .unwrap_or(crate::dsp::params::DEFAULT_GATE_AUTO_MARGIN_DB),
    );
    // Mic quality (headless only), written the same way: `None` = 100.
    params.set_mic_quality(
        p.mic_quality
            .filter(|q| !q.is_nan())
            .unwrap_or(100.0)
            .clamp(0.0, 100.0),
    );
}

/// Attach each routed app (by name) to the running engine and restore its volume.
/// Returns the attached `(name, channel id)` pairs and human-readable skipped entries.
pub fn attach_routed_apps(
    engine: &mut Engine,
    apps: &[RoutedApp],
) -> (Vec<(String, u64)>, Vec<String>) {
    let procs = audio::processes::list_processes().unwrap_or_default();
    let mut attached = Vec::new();
    let mut skipped = Vec::new();
    for app in apps {
        match audio::processes::pick_tree_root(&procs, &app.name) {
            Some(pid) => match engine.add_app(pid, app.name.clone()) {
                Ok(id) => {
                    if let Some(ch) = engine.app_channels().iter().find(|ch| ch.id == id) {
                        audio::mixer::store_f32(&ch.volume, app.volume);
                    }
                    attached.push((app.name.clone(), id));
                }
                Err(e) => skipped.push(format!("{} (error: {e:#})", app.name)),
            },
            None => skipped.push(format!("{} isn't running, skipped", app.name)),
        }
    }
    (attached, skipped)
}

#[cfg(test)]
mod tests {
    use super::apply_profile_dsp;
    use crate::{config, dsp};

    /// Hydration with explicit values (0.0 included) must store exactly those
    /// values, not silently revert to built-in defaults.
    #[test]
    fn apply_profile_dsp_restores_explicit_values() {
        let profile = config::Profile {
            name: "test".into(),
            input_id: None,
            output_id: None,
            gate_enabled: true,
            gate_threshold: Some(0.05),
            suppress_enabled: false,
            suppress_amount: Some(0.7),
            agc_enabled: true,
            agc_target: Some(0.15),
            mic_volume: Some(1.8),
            duck_enabled: false,
            duck_target: None,
            routed_apps: vec![],
            master_volume: None,
            ..Default::default()
        };
        let params = dsp::MicParams::new();
        apply_profile_dsp(&params, &profile);

        assert!(params.gate_enabled());
        assert!(
            (params.gate_threshold() - 0.05).abs() < 1e-6,
            "gate_threshold should be 0.05, got {}",
            params.gate_threshold()
        );
        assert!(params.agc_enabled());
        assert!(
            (params.agc_target() - 0.15).abs() < 1e-6,
            "agc_target should be 0.15, got {}",
            params.agc_target()
        );
        assert!(
            (params.volume() - 1.8).abs() < 1e-6,
            "volume should be 1.8, got {}",
            params.volume()
        );
        assert!(
            (params.suppress_amount() - 0.7).abs() < 1e-6,
            "suppress_amount should be 0.7, got {}",
            params.suppress_amount()
        );
    }

    /// Zero DSP values saved by the user must be restored as 0.0, not silently
    /// reverted to built-in defaults (gate=0.02, agc=0.1, vol=1.0).
    #[test]
    fn apply_profile_dsp_restores_zero_values() {
        let profile = config::Profile {
            name: "test".into(),
            input_id: None,
            output_id: None,
            gate_enabled: false,
            gate_threshold: Some(0.0),
            suppress_enabled: false,
            suppress_amount: Some(0.0),
            agc_enabled: false,
            agc_target: Some(0.0),
            mic_volume: Some(0.0),
            duck_enabled: false,
            duck_target: Some(0.0),
            routed_apps: vec![],
            master_volume: None,
            ..Default::default()
        };
        let params = dsp::MicParams::new();
        apply_profile_dsp(&params, &profile);

        assert!(
            (params.gate_threshold() - 0.0).abs() < 1e-6,
            "gate_threshold should be 0.0 (user-saved), got {}",
            params.gate_threshold()
        );
        assert!(
            (params.agc_target() - 0.0).abs() < 1e-6,
            "agc_target should be 0.0 (user-saved), got {}",
            params.agc_target()
        );
        assert!(
            (params.volume() - 0.0).abs() < 1e-6,
            "volume should be 0.0 (user-saved mute), got {}",
            params.volume()
        );
        assert!(
            (params.suppress_amount() - 0.0).abs() < 1e-6,
            "suppress_amount should be 0.0 (user-saved), got {}",
            params.suppress_amount()
        );
    }

    /// When DSP fields are absent from the config (an older file), params must
    /// stay at built-in defaults: gate_threshold=0.02, agc_target=0.1, volume=1.0.
    #[test]
    fn apply_profile_dsp_leaves_defaults_when_fields_absent() {
        let profile = config::Profile {
            name: "legacy".into(),
            input_id: Some("mic".into()),
            output_id: Some("cable".into()),
            // All Option<f32> fields are None (absent from old config file)
            ..Default::default()
        };
        let params = dsp::MicParams::new();
        apply_profile_dsp(&params, &profile);

        assert!(
            (params.gate_threshold() - 0.02).abs() < 1e-6,
            "gate_threshold default should be 0.02, got {}",
            params.gate_threshold()
        );
        assert!(
            (params.agc_target() - 0.1).abs() < 1e-6,
            "agc_target default should be 0.1, got {}",
            params.agc_target()
        );
        assert!(
            (params.volume() - 1.0).abs() < 1e-6,
            "volume default should be 1.0, got {}",
            params.volume()
        );
    }

    #[test]
    fn apply_profile_dsp_sets_voice_fields() {
        let profile = config::Profile {
            name: "default".into(),
            voice_preset: Some("girly".into()),
            voice_intensity: Some(0.8),
            ..Default::default()
        };
        let params = dsp::MicParams::new();
        apply_profile_dsp(&params, &profile);
        assert_eq!(params.voice_preset(), dsp::VoicePreset::Girly);
        assert!((params.voice_intensity() - 0.8).abs() < 1e-6);
    }

    #[test]
    fn apply_profile_dsp_sets_monitor_and_auto_gate() {
        let params = dsp::MicParams::new();
        apply_profile_dsp(
            &params,
            &config::Profile {
                name: "default".into(),
                monitor_mic: true,
                monitor_mic_volume: Some(1.5),
                gate_auto: true,
                gate_auto_margin_db: Some(9.0),
                ..Default::default()
            },
        );
        assert!(params.monitor_mic());
        assert!((params.monitor_mic_volume() - 1.5).abs() < 1e-6);
        assert!(params.gate_auto());
        assert!((params.gate_auto_margin_db() - 9.0).abs() < 1e-6);

        // The monitor volume is clamped to 0..2.
        apply_profile_dsp(
            &params,
            &config::Profile {
                monitor_mic: true,
                monitor_mic_volume: Some(7.0),
                ..Default::default()
            },
        );
        assert!((params.monitor_mic_volume() - 2.0).abs() < 1e-6);

        // Absent (null) values mean the protocol defaults (volume 1, margin
        // 6 dB) and the toggles follow the profile (both off).
        apply_profile_dsp(&params, &config::Profile::default());
        assert!(!params.monitor_mic());
        assert!(!params.gate_auto());
        assert!((params.monitor_mic_volume() - 1.0).abs() < 1e-6);
        assert!((params.gate_auto_margin_db() - 6.0).abs() < 1e-6);
    }

    #[test]
    fn parse_mic_quality_null_is_100() {
        let params = dsp::MicParams::new();
        let apply = |json: &str| {
            let p: config::Profile = serde_json::from_str(json).unwrap();
            apply_profile_dsp(&params, &p);
            params.mic_quality()
        };
        assert_eq!(apply(r#"{"name":"x","mic_quality":40}"#), 40.0);
        // null and missing both mean 100, applied explicitly (not "keep").
        assert_eq!(apply(r#"{"name":"x","mic_quality":null}"#), 100.0);
        assert_eq!(apply(r#"{"name":"x","mic_quality":12.5}"#), 12.5);
        assert_eq!(apply(r#"{"name":"x"}"#), 100.0);
        // Clamped to 0..100.
        assert_eq!(apply(r#"{"mic_quality":250}"#), 100.0);
        assert_eq!(apply(r#"{"mic_quality":-3}"#), 0.0);
        assert_eq!(apply(r#"{"mic_quality":0}"#), 0.0);
        // A wrong type rejects the line, like the other numeric fields.
        assert!(serde_json::from_str::<config::Profile>(r#"{"mic_quality":"low"}"#).is_err());
        // Round-trips through the TOML config and JSON.
        let p = config::Profile {
            name: "d".into(),
            mic_quality: Some(55.0),
            ..Default::default()
        };
        let cfg = config::Config {
            last_profile: "d".into(),
            profiles: vec![p.clone()],
        };
        let back: config::Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert_eq!(back.profiles[0], p);
        let back: config::Profile =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn apply_profile_dsp_without_voice_keeps_defaults() {
        // A profile from before the voice changer (no voice fields) must leave params at defaults: Off / 0.6.
        let profile = config::Profile {
            name: "default".into(),
            ..Default::default()
        };
        let params = dsp::MicParams::new();
        apply_profile_dsp(&params, &profile);
        assert_eq!(params.voice_preset(), dsp::VoicePreset::Off);
        assert!((params.voice_intensity() - 0.6).abs() < 1e-6);
    }
}
