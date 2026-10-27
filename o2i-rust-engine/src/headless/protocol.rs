//! JSON line protocol between a controller (Vencord plugin) and headless o2i.
//! Commands arrive on stdin; events leave on stdout (one JSON object per line).

use crate::config::{Config, Profile};
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Deserialize, Debug)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Configure { profile: Profile },
    SetAudio { on: bool },
    /// Play a sound by `path` (absolute, inside a source folder) or, legacy,
    /// by `file` name in the first source. `path` wins when both are given;
    /// `parse_command` rejects neither.
    PlayClip { file: Option<String>, path: Option<String> },
    /// Jump a playing instance to `pos_s` seconds.
    SeekClip { id: u64, pos_s: f64 },
    PauseClip { id: u64 },
    ResumeClip { id: u64 },
    StopClip { id: u64 },
    StopAll,
    /// Mute (`true`) or unmute the mic. Only the mic is silenced: the
    /// soundboard and routed apps keep playing.
    SetMicMuted { muted: bool },
    ListDevices,
    ListApps,
    ListClips,
    Shutdown,
}

/// What changed the mic mute (`mic_muted` event).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MuteSource {
    /// A `set_mic_muted` command.
    Command,
    /// The mute hotkey (`profile.mic_mute_hotkey`).
    Hotkey,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioStatus {
    Off,
    Running,
    Error,
}

#[derive(Serialize, Debug, Clone)]
pub struct PlayingJson {
    pub id: u64,
    pub name: String,
    pub pos_s: f32,
    pub len_s: Option<f32>,
    pub paused: bool,
    /// The sound's absolute path (its identity), `None` if unknown.
    pub path: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct AppStatusJson {
    pub name: String,
    pub attached: bool,
}

/// A hotkey binding that is currently not registered.
#[derive(Serialize, Debug, Clone)]
pub struct HotkeyErrorJson {
    pub accel: String,
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct StateEv {
    pub audio: AudioStatus,
    pub error: Option<String>,
    pub input_level: f32,
    pub playing: Vec<PlayingJson>,
    pub apps: Vec<AppStatusJson>,
    /// Every binding of the current profile that isn't registered right now.
    pub hotkey_errors: Vec<HotkeyErrorJson>,
    /// The auto gate's current threshold (linear RMS) while `gate_auto` and
    /// audio runs; `None` otherwise.
    pub gate_threshold_live: Option<f32>,
    /// The mic is muted (whether or not audio runs).
    pub mic_muted: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct DeviceJson {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct AppJson {
    pub name: String,
    pub pid: u32,
    pub playing: bool,
    pub icon: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ClipJson {
    pub file: String,
    pub duration_s: Option<f32>,
    /// Absolute path: the sound's identity (`play_clip`'s `path`).
    pub path: String,
    /// The source folder it's in, exactly as configured.
    pub source: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Ready { version: String },
    State(StateEv),
    Devices { inputs: Vec<DeviceJson>, outputs: Vec<DeviceJson>, cable: Option<DeviceJson> },
    Apps { apps: Vec<AppJson> },
    Clips { folder: Option<String>, clips: Vec<ClipJson> },
    HotkeyError { accel: String, message: String },
    /// The mic mute changed (sent once per change, right away).
    MicMuted { muted: bool, source: MuteSource },
    Error { message: String },
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    let cmd: Command = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if let Command::PlayClip { file: None, path: None } = cmd {
        return Err(r#"play_clip needs "file" or "path""#.to_string());
    }
    Ok(cmd)
}

/// Write one event as a single JSON line to stdout. Write errors are ignored.
pub fn emit(ev: &Event) {
    let Ok(s) = serde_json::to_string(ev) else { return };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{s}");
    let _ = out.flush();
}

/// The `last_profile` profile as JSON, or `"null"` if it doesn't exist.
pub fn legacy_profile_json(cfg: &Config) -> String {
    cfg.profiles
        .iter()
        .find(|p| p.name == cfg.last_profile)
        .and_then(|p| serde_json::to_string(p).ok())
        .unwrap_or_else(|| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Profile};

    #[test]
    fn parses_configure_with_profile_shape() {
        let c = parse_command(r#"{"cmd":"configure","profile":{"name":"default","gate_enabled":true}}"#).unwrap();
        match c {
            Command::Configure { profile } => {
                assert!(profile.gate_enabled);
                assert_eq!(profile.name, "default");
                assert!(!profile.agc_enabled);
                assert!(profile.input_id.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn configure_accepts_null_round2_fields_as_defaults() {
        // The protocol says null = default for these: a null must not reject
        // the whole configure line.
        let line = r#"{"cmd":"configure","profile":{"name":"p","gate_enabled":true,
            "sb_folders":null,"monitor_mic":null,"monitor_mic_volume":null,
            "gate_auto":null,"gate_auto_margin_db":null,"mic_quality":null}}"#;
        match parse_command(line).unwrap() {
            Command::Configure { profile } => {
                assert!(profile.gate_enabled, "the rest of the line still applies");
                assert!(profile.sb_folders.is_empty());
                assert!(!profile.monitor_mic);
                assert!(!profile.gate_auto);
                assert!(profile.monitor_mic_volume.is_none());
                assert!(profile.gate_auto_margin_db.is_none());
                assert!(profile.mic_quality.is_none());
            }
            _ => panic!("wrong variant"),
        }
        // Explicit values still parse.
        let line = r#"{"cmd":"configure","profile":{"sb_folders":["C:\\a","D:\\b"],
            "monitor_mic":true,"gate_auto":true}}"#;
        match parse_command(line).unwrap() {
            Command::Configure { profile } => {
                assert_eq!(profile.sb_folders, vec![r"C:\a".to_string(), r"D:\b".to_string()]);
                assert!(profile.monitor_mic);
                assert!(profile.gate_auto);
            }
            _ => panic!("wrong variant"),
        }
        // A wrong type is still an error.
        assert!(parse_command(r#"{"cmd":"configure","profile":{"gate_auto":"yes"}}"#).is_err());
    }

    #[test]
    fn parses_simple_commands() {
        assert!(matches!(parse_command(r#"{"cmd":"set_audio","on":false}"#).unwrap(), Command::SetAudio { on: false }));
        match parse_command(r#"{"cmd":"play_clip","file":"a.mp3"}"#).unwrap() {
            Command::PlayClip { file, path } => {
                assert_eq!(file.as_deref(), Some("a.mp3"));
                assert!(path.is_none());
            }
            _ => panic!(),
        }
        assert!(matches!(parse_command(r#"{"cmd":"stop_clip","id":3}"#).unwrap(), Command::StopClip { id: 3 }));
        assert!(matches!(parse_command(r#"{"cmd":"stop_all"}"#).unwrap(), Command::StopAll));
        assert!(matches!(parse_command(r#"{"cmd":"list_devices"}"#).unwrap(), Command::ListDevices));
        assert!(matches!(parse_command(r#"{"cmd":"shutdown"}"#).unwrap(), Command::Shutdown));
    }

    #[test]
    fn parses_play_clip_with_path_or_file() {
        match parse_command(r#"{"cmd":"play_clip","path":"C:\\snd\\a.mp3"}"#).unwrap() {
            Command::PlayClip { file, path } => {
                assert!(file.is_none());
                assert_eq!(path.as_deref(), Some(r"C:\snd\a.mp3"));
            }
            other => panic!("wrong variant {other:?}"),
        }
        match parse_command(r#"{"cmd":"play_clip","file":"a.mp3","path":null}"#).unwrap() {
            Command::PlayClip { file, path } => {
                assert_eq!(file.as_deref(), Some("a.mp3"));
                assert!(path.is_none());
            }
            other => panic!("wrong variant {other:?}"),
        }
        match parse_command(r#"{"cmd":"play_clip","file":"a.mp3","path":"C:\\a.mp3"}"#).unwrap() {
            Command::PlayClip { file, path } => {
                assert_eq!(file.as_deref(), Some("a.mp3"));
                assert_eq!(path.as_deref(), Some(r"C:\a.mp3"));
            }
            other => panic!("wrong variant {other:?}"),
        }
    }

    #[test]
    fn rejects_play_clip_with_neither() {
        for s in [
            r#"{"cmd":"play_clip"}"#,
            r#"{"cmd":"play_clip","file":null}"#,
            r#"{"cmd":"play_clip","file":null,"path":null}"#,
        ] {
            assert_eq!(parse_command(s).unwrap_err(), r#"play_clip needs "file" or "path""#, "{s}");
        }
    }

    #[test]
    fn parses_seek_clip() {
        match parse_command(r#"{"cmd":"seek_clip","id":7,"pos_s":42.5}"#).unwrap() {
            Command::SeekClip { id, pos_s } => {
                assert_eq!(id, 7);
                assert_eq!(pos_s, 42.5);
            }
            other => panic!("wrong variant {other:?}"),
        }
        assert!(parse_command(r#"{"cmd":"seek_clip","id":7,"pos_s":3}"#).is_ok());
        assert!(parse_command(r#"{"cmd":"seek_clip","id":7}"#).is_err());
        assert!(parse_command(r#"{"cmd":"seek_clip","pos_s":1.0}"#).is_err());
    }

    #[test]
    fn clips_event_serializes_path_and_source() {
        let ev = Event::Clips {
            folder: Some(r"C:\a".into()),
            clips: vec![ClipJson {
                file: "x.wav".into(),
                duration_s: None,
                path: r"C:\b\x.wav".into(),
                source: r"C:\b".into(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"clips","folder":"C:\\a","clips":[{"file":"x.wav","duration_s":null,"path":"C:\\b\\x.wav","source":"C:\\b"}]}"#
        );
    }

    #[test]
    fn rejects_unknown_and_malformed() {
        for s in [r#"{"cmd":"nope"}"#, r#"{"cmd":"set_audio"}"#, "not json", ""] {
            assert!(parse_command(s).is_err(), "{s}");
        }
    }

    #[test]
    fn state_event_serializes_exactly() {
        let ev = Event::State(StateEv {
            audio: AudioStatus::Running,
            error: None,
            input_level: 0.5,
            playing: vec![
                PlayingJson {
                    id: 1,
                    name: "a.mp3".into(),
                    pos_s: 1.0,
                    len_s: None,
                    paused: false,
                    path: Some(r"C:\s\a.mp3".into()),
                },
                PlayingJson { id: 2, name: "b.mp3".into(), pos_s: 0.0, len_s: Some(2.0), paused: true, path: None },
            ],
            apps: vec![AppStatusJson { name: "Spotify.exe".into(), attached: true }],
            hotkey_errors: vec![HotkeyErrorJson { accel: "F8".into(), message: "taken".into() }],
            gate_threshold_live: Some(0.25),
            mic_muted: true,
        });
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"state","audio":"running","error":null,"input_level":0.5,"playing":[{"id":1,"name":"a.mp3","pos_s":1.0,"len_s":null,"paused":false,"path":"C:\\s\\a.mp3"},{"id":2,"name":"b.mp3","pos_s":0.0,"len_s":2.0,"paused":true,"path":null}],"apps":[{"name":"Spotify.exe","attached":true}],"hotkey_errors":[{"accel":"F8","message":"taken"}],"gate_threshold_live":0.25,"mic_muted":true}"#
        );
    }

    #[test]
    fn state_event_serializes_empty_hotkey_errors() {
        let ev = Event::State(StateEv {
            audio: AudioStatus::Off,
            error: None,
            input_level: 0.0,
            playing: vec![],
            apps: vec![],
            hotkey_errors: vec![],
            gate_threshold_live: None,
            mic_muted: false,
        });
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"state","audio":"off","error":null,"input_level":0.0,"playing":[],"apps":[],"hotkey_errors":[],"gate_threshold_live":null,"mic_muted":false}"#
        );
    }

    #[test]
    fn parse_set_mic_muted() {
        assert!(matches!(
            parse_command(r#"{"cmd":"set_mic_muted","muted":true}"#).unwrap(),
            Command::SetMicMuted { muted: true }
        ));
        assert!(matches!(
            parse_command(r#"{"cmd":"set_mic_muted","muted":false}"#).unwrap(),
            Command::SetMicMuted { muted: false }
        ));
        for s in [
            r#"{"cmd":"set_mic_muted"}"#,
            r#"{"cmd":"set_mic_muted","muted":null}"#,
            r#"{"cmd":"set_mic_muted","muted":"yes"}"#,
            r#"{"cmd":"set_mic_muted","muted":1}"#,
        ] {
            assert!(parse_command(s).is_err(), "{s}");
        }
    }

    #[test]
    fn mic_muted_event_serializes() {
        let ev = Event::MicMuted { muted: true, source: MuteSource::Command };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"mic_muted","muted":true,"source":"command"}"#
        );
        let ev = Event::MicMuted { muted: false, source: MuteSource::Hotkey };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"ev":"mic_muted","muted":false,"source":"hotkey"}"#
        );
    }

    #[test]
    fn ready_event_serializes() {
        let ev = Event::Ready { version: "0.1.0".into() };
        assert_eq!(serde_json::to_string(&ev).unwrap(), r#"{"ev":"ready","version":"0.1.0"}"#);
    }

    #[test]
    fn legacy_profile_json_null_when_missing() {
        assert_eq!(legacy_profile_json(&Config::default()), "null");
        let cfg = Config { last_profile: "zzz".into(), profiles: vec![Profile { name: "a".into(), ..Default::default() }] };
        assert_eq!(legacy_profile_json(&cfg), "null");
    }

    #[test]
    fn legacy_profile_json_picks_last_profile() {
        let cfg = Config {
            last_profile: "two".into(),
            profiles: vec![
                Profile { name: "one".into(), ..Default::default() },
                Profile { name: "two".into(), ..Default::default() },
            ],
        };
        let p: Profile = serde_json::from_str(&legacy_profile_json(&cfg)).unwrap();
        assert_eq!(p.name, "two");
    }
}
