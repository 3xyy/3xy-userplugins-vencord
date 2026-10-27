use anyhow::Result;
use serde::{Deserialize, Deserializer, Serialize};
use std::path::PathBuf;

/// Deserialize a JSON `null` as the type's default (the protocol's "null =
/// default" for fields that aren't `Option`s); missing fields are covered by
/// `#[serde(default)]`.
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct RoutedApp {
    pub name: String,
    pub volume: f32,
}

/// Per-clip soundboard mixing settings, keyed by sound: an absolute path, or
/// (legacy) a file name in the first source folder.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct SbClipSetting {
    pub name: String,
    pub vol_others: f32,
    pub vol_self: f32,
    pub hear_local: bool,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub input_id: Option<String>,
    pub output_id: Option<String>,
    #[serde(default)]
    pub gate_enabled: bool,
    /// `None` means the field was absent in the file (a config from before the mic settings).
    /// `Some(0.0)` means the user deliberately saved 0.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_threshold: Option<f32>,
    #[serde(default)]
    pub suppress_enabled: bool,
    #[serde(default)]
    pub agc_enabled: bool,
    /// `None` means the field was absent in the file (a config from before the mic settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agc_target: Option<f32>,
    /// `None` means the field was absent in the file (a config from before the mic settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_volume: Option<f32>,
    /// `None` means the field was absent in the file (a config from before app routing and ducking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppress_amount: Option<f32>,
    /// Whether app-ducking is enabled while the mic is open.
    #[serde(default)]
    pub duck_enabled: bool,
    /// Duck target volume (0..1). `None` means field was absent (a config from before app routing and ducking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duck_target: Option<f32>,
    /// Apps to re-attach when routing starts (persisted by name + volume).
    #[serde(default)]
    pub routed_apps: Vec<RoutedApp>,
    /// `None` means the field was absent in the file (a config from before app routing and ducking).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_volume: Option<f32>,
    // ---- Soundboard settings ----
    /// Soundboard folder path (stored as a plain string for portability).
    /// Legacy single source: used only while `sb_folders` is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sb_folder: Option<String>,
    /// Soundboard source folders (the source of truth when non-empty).
    /// The first one is where legacy file-name keys resolve. `null` = empty.
    #[serde(default, deserialize_with = "null_as_default")]
    pub sb_folders: Vec<String>,
    /// Per-clip hotkeys: (sound key, accel_string). The key is a sound's
    /// absolute path, or (legacy) a bare file name in the first source.
    #[serde(default)]
    pub sb_clip_hotkeys: Vec<(String, String)>,
    /// Stop-all hotkey accelerator string (e.g. `"Ctrl+F12"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sb_stop_all_hotkey: Option<String>,
    /// Monitor output device id (`None` = system default render endpoint).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sb_monitor_device: Option<String>,
    /// Per-clip mixing settings (others/self volumes + hear-local), by sound
    /// key (absolute path, or a legacy file name in the first source).
    #[serde(default)]
    pub sb_clip_settings: Vec<SbClipSetting>,
    /// Global soundboard "others" gain. `None` = absent (use default 1.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sb_global_others: Option<f32>,
    /// Global soundboard "self" gain. `None` = absent (use default 1.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sb_global_self: Option<f32>,
    /// Global soundboard hear-local toggle.
    #[serde(default)]
    pub sb_global_hear_local: bool,
    /// When true, global settings override every clip's own settings at play time.
    #[serde(default)]
    pub sb_global_override: bool,
    // ---- Voice changer ----
    /// Voice preset id: "off" | "manly" | "girly". `None` = absent (a config from before the voice changer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_preset: Option<String>,
    /// Voice intensity (0..1). `None` = absent (a config from before the voice changer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_intensity: Option<f32>,
    // ---- Headless only: listen to yourself, auto gate ----
    /// Mix the processed mic into the monitor (headphones) output. `null` = false.
    #[serde(default, deserialize_with = "null_as_default")]
    pub monitor_mic: bool,
    /// Volume of the mic in the monitor (0..2). `None` = absent (default 1.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_mic_volume: Option<f32>,
    /// Track the noise floor and set the gate threshold automatically.
    /// `null` = false.
    #[serde(default, deserialize_with = "null_as_default")]
    pub gate_auto: bool,
    /// Auto-gate margin above the noise floor in dB. `None` = absent (default 6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_auto_margin_db: Option<f32>,
    // ---- Headless only: mic mute ----
    /// Mic mute hotkey (`llhooks::parse_mute_spec`), e.g. `"Mouse4"` or
    /// `"Ctrl+Shift+M"`. Missing, `null` or blank = no mute hotkey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_mute_hotkey: Option<String>,
    // ---- Headless only: mic quality ----
    /// Mic quality 0..100; lower sounds like a worse mic. `None` (missing or
    /// `null`) = 100, the mic untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_quality: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Config {
    #[serde(default)]
    pub last_profile: String,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

pub fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("o2i").join("config.toml")
}

pub fn load() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => toml::from_str(&s).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

pub fn save(cfg: &Config) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let s = toml::to_string_pretty(cfg)?;
    std::fs::write(&path, s)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_serializes_and_parses() {
        let cfg = Config {
            last_profile: "gaming".into(),
            profiles: vec![Profile {
                name: "gaming".into(),
                input_id: Some("mic-id".into()),
                output_id: Some("cable-id".into()),
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles, cfg.profiles);
        assert_eq!(parsed.last_profile, "gaming");
    }

    #[test]
    fn missing_file_is_default() {
        // Empty TOML string parses to default (no panic, empty profiles)
        let parsed: Config = toml::from_str("").unwrap();
        assert_eq!(parsed.profiles.len(), 0);
    }

    #[test]
    fn profile_with_dsp_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                input_id: Some("mic".into()),
                output_id: Some("cable".into()),
                gate_enabled: true,
                gate_threshold: Some(0.03),
                suppress_enabled: true,
                suppress_amount: Some(0.75),
                agc_enabled: false,
                agc_target: Some(0.12),
                mic_volume: Some(1.5),
                duck_enabled: true,
                duck_target: Some(0.2),
                routed_apps: vec![],
                master_volume: None,
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles, cfg.profiles);
    }

    #[test]
    fn profile_with_zero_dsp_values_round_trips() {
        // gate_threshold=0.0, agc_target=0.0, mic_volume=0.0 are valid user choices
        // (gate fully open, AGC target=0, muted) and must survive a save/load cycle.
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
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
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles[0].gate_threshold, Some(0.0));
        assert_eq!(parsed.profiles[0].agc_target, Some(0.0));
        assert_eq!(parsed.profiles[0].mic_volume, Some(0.0));
        assert_eq!(parsed.profiles[0].suppress_amount, Some(0.0));
        assert_eq!(parsed.profiles[0].duck_target, Some(0.0));
    }

    #[test]
    fn profile_with_duck_and_suppress_amount_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                suppress_amount: Some(0.6),
                duck_enabled: true,
                duck_target: Some(0.3),
                master_volume: Some(1.1),
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles[0].suppress_amount, Some(0.6));
        assert!(parsed.profiles[0].duck_enabled);
        assert_eq!(parsed.profiles[0].duck_target, Some(0.3));
        assert_eq!(parsed.profiles[0].master_volume, Some(1.1));
    }

    #[test]
    fn old_config_without_duck_fields_loads() {
        // Older configs without duck/suppress_amount must parse cleanly,
        // with duck_enabled=false and None for the Option<f32> fields.
        let parsed: Config =
            toml::from_str("last_profile=\"d\"\n[[profiles]]\nname=\"d\"\n").unwrap();
        assert!(!parsed.profiles[0].duck_enabled);
        assert_eq!(parsed.profiles[0].duck_target, None);
        assert_eq!(parsed.profiles[0].suppress_amount, None);
    }

    #[test]
    fn profile_with_routed_apps_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                routed_apps: vec![RoutedApp {
                    name: "chrome.exe".into(),
                    volume: 0.8,
                }],
                master_volume: Some(0.9),
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles, cfg.profiles);
    }

    #[test]
    fn old_config_without_routed_apps_loads() {
        let parsed: Config =
            toml::from_str("last_profile=\"d\"\n[[profiles]]\nname=\"d\"\n").unwrap();
        assert!(parsed.profiles[0].routed_apps.is_empty());
        assert_eq!(parsed.profiles[0].master_volume, None);
    }

    #[test]
    fn profile_with_sb_settings_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                sb_folder: Some("C:/sounds".into()),
                sb_clip_hotkeys: vec![
                    ("horn.wav".into(), "Ctrl+F1".into()),
                    ("bell.mp3".into(), "Ctrl+F2".into()),
                ],
                sb_stop_all_hotkey: Some("Ctrl+F12".into()),
                sb_monitor_device: Some("dev-id-abc".into()),
                sb_clip_settings: vec![
                    SbClipSetting {
                        name: "horn.wav".into(),
                        vol_others: 0.75,
                        vol_self: 1.25,
                        hear_local: true,
                    },
                    SbClipSetting {
                        name: "bell.mp3".into(),
                        vol_others: 0.5,
                        vol_self: 0.0,
                        hear_local: false,
                    },
                ],
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        let p = &parsed.profiles[0];
        assert_eq!(p.sb_folder, Some("C:/sounds".into()));
        assert_eq!(p.sb_clip_hotkeys.len(), 2);
        assert_eq!(p.sb_clip_hotkeys[0], ("horn.wav".into(), "Ctrl+F1".into()));
        assert_eq!(p.sb_clip_hotkeys[1], ("bell.mp3".into(), "Ctrl+F2".into()));
        assert_eq!(p.sb_stop_all_hotkey, Some("Ctrl+F12".into()));
        assert_eq!(p.sb_monitor_device, Some("dev-id-abc".into()));
        assert_eq!(p.sb_clip_settings.len(), 2);
        assert_eq!(p.sb_clip_settings[0].name, "horn.wav");
        assert_eq!(p.sb_clip_settings[0].vol_others, 0.75);
        assert_eq!(p.sb_clip_settings[0].vol_self, 1.25);
        assert!(p.sb_clip_settings[0].hear_local);
        assert_eq!(p.sb_clip_settings[1].name, "bell.mp3");
        assert!(!p.sb_clip_settings[1].hear_local);
    }

    #[test]
    fn old_config_without_sb_fields_loads() {
        // Older profiles without any soundboard keys must parse cleanly with
        // defaults (None / false / empty vec), for backward compatibility.
        let parsed: Config =
            toml::from_str("last_profile=\"d\"\n[[profiles]]\nname=\"d\"\n").unwrap();
        let p = &parsed.profiles[0];
        assert!(p.sb_folder.is_none());
        assert!(p.sb_clip_hotkeys.is_empty());
        assert!(p.sb_stop_all_hotkey.is_none());
        assert!(p.sb_monitor_device.is_none());
        assert!(p.sb_clip_settings.is_empty());
        // Global soundboard settings default to absent / false.
        assert!(p.sb_global_others.is_none());
        assert!(p.sb_global_self.is_none());
        assert!(!p.sb_global_hear_local);
        assert!(!p.sb_global_override);
    }

    #[test]
    fn profile_with_sb_global_settings_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                sb_global_others: Some(0.4),
                sb_global_self: Some(1.8),
                sb_global_hear_local: true,
                sb_global_override: true,
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        let p = &parsed.profiles[0];
        assert_eq!(p.sb_global_others, Some(0.4));
        assert_eq!(p.sb_global_self, Some(1.8));
        assert!(p.sb_global_hear_local);
        assert!(p.sb_global_override);
    }

    #[test]
    fn old_config_with_removed_sb_global_vol_keys_loads() {
        // Pre-soundboard-v2 configs may carry sb_monitor_enabled/sb_vol_to_others/
        // sb_vol_to_self; serde must ignore these now-absent keys and still parse.
        let toml_str = r#"
last_profile = "d"
[[profiles]]
name = "d"
sb_monitor_enabled = true
sb_vol_to_others = 0.75
sb_vol_to_self = 1.25
"#;
        let parsed: Config = toml::from_str(toml_str).unwrap();
        let p = &parsed.profiles[0];
        assert_eq!(p.name, "d");
        assert!(p.sb_clip_settings.is_empty());
    }

    #[test]
    fn old_config_without_dsp_fields_loads() {
        // An older profile (no DSP keys) must still parse, with None for the
        // Option<f32> fields, so they can be told apart from an explicit 0.0 saved by the user.
        let toml_str = r#"
last_profile = "default"
[[profiles]]
name = "default"
input_id = "mic"
output_id = "cable"
"#;
        let parsed: Config = toml::from_str(toml_str).unwrap();
        assert_eq!(parsed.profiles[0].mic_volume, None);
        assert_eq!(parsed.profiles[0].gate_threshold, None);
        assert_eq!(parsed.profiles[0].agc_target, None);
        assert!(!parsed.profiles[0].suppress_enabled);
    }

    #[test]
    fn profile_with_voice_fields_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                voice_preset: Some("manly".into()),
                voice_intensity: Some(0.8),
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles[0].voice_preset, Some("manly".into()));
        assert_eq!(parsed.profiles[0].voice_intensity, Some(0.8));
    }

    #[test]
    fn profile_with_round2_fields_round_trips() {
        let cfg = Config {
            last_profile: "default".into(),
            profiles: vec![Profile {
                name: "default".into(),
                sb_folders: vec![r"C:\a".into(), r"D:\b".into()],
                sb_clip_hotkeys: vec![(r"C:\a\x.wav".into(), "F8".into())],
                monitor_mic: true,
                monitor_mic_volume: Some(1.5),
                gate_auto: true,
                gate_auto_margin_db: Some(9.0),
                ..Default::default()
            }],
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        let parsed: Config = toml::from_str(&s).unwrap();
        assert_eq!(parsed.profiles, cfg.profiles);
        let json = serde_json::to_string(&cfg.profiles[0]).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg.profiles[0]);
    }

    #[test]
    fn profile_without_round2_fields_defaults() {
        let parsed: Config =
            toml::from_str("last_profile=\"d\"\n[[profiles]]\nname=\"d\"\nsb_folder=\"C:/s\"\n")
                .unwrap();
        let p = &parsed.profiles[0];
        assert!(p.sb_folders.is_empty());
        assert_eq!(p.sb_folder.as_deref(), Some("C:/s"));
        assert!(!p.monitor_mic);
        assert_eq!(p.monitor_mic_volume, None);
        assert!(!p.gate_auto);
        assert_eq!(p.gate_auto_margin_db, None);
        let j: Profile = serde_json::from_str(r#"{"name":"x","monitor_mic_volume":null}"#).unwrap();
        assert!(j.sb_folders.is_empty());
        assert_eq!(j.monitor_mic_volume, None);
    }

    #[test]
    fn mic_mute_hotkey_is_optional_and_null_tolerant() {
        let j: Profile = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert_eq!(j.mic_mute_hotkey, None);
        let j: Profile =
            serde_json::from_str(r#"{"name":"x","mic_mute_hotkey":null,"gate_enabled":true}"#)
                .unwrap();
        assert_eq!(j.mic_mute_hotkey, None);
        assert!(j.gate_enabled, "the rest of the profile still applies");
        let j: Profile = serde_json::from_str(r#"{"mic_mute_hotkey":"Mouse4"}"#).unwrap();
        assert_eq!(j.mic_mute_hotkey.as_deref(), Some("Mouse4"));
        assert!(serde_json::from_str::<Profile>(r#"{"mic_mute_hotkey":4}"#).is_err());
        // Round-trips through the TOML config and JSON.
        let p = Profile {
            name: "d".into(),
            mic_mute_hotkey: Some("Ctrl+Shift+M".into()),
            ..Default::default()
        };
        let cfg = Config {
            last_profile: "d".into(),
            profiles: vec![p.clone()],
        };
        let parsed: Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert_eq!(parsed.profiles[0], p);
        let back: Profile = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn old_config_without_voice_fields_loads() {
        let parsed: Config =
            toml::from_str("last_profile=\"d\"\n[[profiles]]\nname=\"d\"\n").unwrap();
        assert_eq!(parsed.profiles[0].voice_preset, None);
        assert_eq!(parsed.profiles[0].voice_intensity, None);
    }
}
