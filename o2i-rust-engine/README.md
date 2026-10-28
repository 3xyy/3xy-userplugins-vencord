# o2i-rust-engine

Source code of `o2i.exe`, the audio engine behind the [Output2Input](../o2i) plugin. Written in Rust, Windows only. Published so the engine can be inspected or built from source instead of downloaded.

## What it does

- Captures the microphone and processes it: noise removal (RNNoise, through the `nnnoiseless` crate), noise gate (40 ms of added latency, ignores sounds shorter than about 30 ms), auto gain, voice effect (Signalsmith Stretch), the Quality stage, mute and push to talk.
- Captures selected apps with Windows per-process loopback capture. The apps keep playing on their normal output.
- Plays soundboard files (MP3, WAV, OGG, FLAC, M4A, AAC), decoded with Symphonia and resampled with Rubato.
- Speaks text with Windows voices (WinRT `SpeechSynthesizer`) or Piper voices.
- Mixes everything into VB-CABLE's input, which Discord uses as a microphone.
- Handles hotkeys. Keyboard soundboard hotkeys use `RegisterHotKey` (through the `global-hotkey` crate) and do not reach the focused app. Mouse soundboard hotkeys (Mouse3 to Mouse5, alone or with Ctrl, Alt, Shift or Win), the mute key and the push to talk key use low-level hooks, so they work while a game has focus and the press still reaches the focused app.

The audio threads are lock-free, allocation-free and panic-free. File reads and writes, decoding, downloads and speech synthesis run on other threads.

## Running modes

| Mode | Command | Description |
|---|---|---|
| Headless | `o2i.exe --headless` | Used by the plugin. JSON protocol over stdin and stdout. No window, no config file. |
| Window | `o2i.exe` | Standalone window: devices, mic cleanup, voice effect, routed apps and a soundboard with hotkeys. Saves settings to `%APPDATA%\o2i\config.toml`. |
| Dump config | `o2i.exe --dump-config` | Prints the window's saved profile as one JSON line and exits. Used by the plugin's **Re-import from the o2i app**. |

- These features exist only in the plugin, not in the window: mic mute, push to talk, text to speech, the automatic gate, hear yourself and the Quality slider.
- Only one o2i runs audio at a time, window or headless. A second instance reports this and does not start audio.

## Protocol

In headless mode the engine reads commands from stdin and writes events to stdout, one JSON object per line. Commands are tagged with `"cmd"`, events with `"ev"`, and field names are snake_case. Nothing else is written to stdout. The engine exits on `shutdown` or when stdin closes.

The plugin sends the whole profile (devices, mic settings, mic mode and keys, routed apps, soundboard) with `configure`, so headless mode never reads or writes a config file. The message types are defined in [`src/headless/protocol.rs`](src/headless/protocol.rs).

| Command | Purpose |
|---|---|
| `configure` | Applies the full profile. |
| `set_audio` | Starts or stops the audio streams. |
| `play_clip`, `seek_clip`, `pause_clip`, `resume_clip`, `stop_clip`, `stop_all` | Soundboard playback. |
| `set_mic_muted` | Mutes or unmutes the mic. |
| `list_devices`, `list_apps`, `list_clips` | Lists audio devices, running apps and sounds. |
| `list_tts_voices` | Lists Windows and Piper voices. |
| `install_tts_voice` | Downloads a Piper voice, and the Piper runtime when missing. |
| `speak` | Speaks text with a voice and rate through the soundboard path. |
| `shutdown` | Stops audio and exits with code 0. |

| Event | Purpose |
|---|---|
| `ready` | Sent once at startup, with the engine version. |
| `state` | Audio status, input level, playing sounds, routed apps, hotkey errors, mute and mic-open state, voice install progress. Sent every 50 ms while audio runs, every second otherwise, and after `configure` or `set_audio`. |
| `devices`, `apps`, `clips`, `tts_voices` | Replies to the list commands. |
| `mic_muted` | The mute changed, by command or hotkey. |
| `mic_open` | The mic opened or closed (mute, push to talk). |
| `hotkey_error` | A hotkey could not be registered. |
| `error` | A command failed. Speech errors can arrive later. |

A test that opens no audio device:

```
printf '%s\n' '{"cmd":"list_devices"}' '{"cmd":"shutdown"}' | o2i.exe --headless
```

The output is a `ready` line, `state` lines and a `devices` line listing the inputs and outputs.

## Building

Requirements:

- Windows 11, 64-bit. Windows 10 is untested, and per-app capture needs a recent Windows build.
- [Rust](https://rustup.rs) stable with the MSVC toolchain (`x86_64-pc-windows-msvc`, the default on Windows). The release was built with Rust 1.96.
- Visual Studio Build Tools with the "Desktop development with C++" workload. The voice effect library is C++.
- [LLVM](https://github.com/llvm/llvm-project/releases) for libclang (`winget install LLVM.LLVM`). If the build cannot find it, set `LIBCLANG_PATH` to LLVM's `bin` folder.

Build in this folder:

```
cargo build --release
```

The executable is written to `target\release\o2i.exe`. Set the plugin's **Engine path** to it.

`cargo test` runs the unit tests. They open no audio device, need no VB-CABLE and use no network.

The `o2i.exe` on the Releases page is built with `cargo build --release` and `--remap-path-prefix` flags in `RUSTFLAGS`, so no local build paths are embedded.

## Text to speech downloads

- Windows voices are the ones installed in Windows. They need no download.
- Piper voices are downloaded only when the plugin's **Install** button sends `install_tts_voice`. This is the engine's only network access.
- Voices come from `rhasspy/piper-voices` on Hugging Face (tag `v1.0.0`). The runtime comes from the `rhasspy/piper` GitHub release `2023.11.14-2`. HTTPS only.
- Each file is checked against a size and SHA-256 hash compiled into the engine before it is moved into place. A failed download removes its partial files.
- Each voice is about 60 MB. The first voice also downloads the runtime, about 22 MB.
- Files are stored in `%APPDATA%\o2i\tts`: `runtime\` holds `piper.exe` and its data, `voices\` holds one `.onnx` model and `.onnx.json` config per voice.
- Catalogue: `en_US-lessac-medium`, `en_US-amy-medium`, `en_US-joe-medium`, `en_GB-alan-medium`, `en_GB-alba-medium` and `en_GB-jenny_dioco-medium`. Each voice has its own dataset license, listed in its model card in `rhasspy/piper-voices`. No voice is bundled with o2i.

## Logs

- The engine writes `%APPDATA%\o2i\logs\engine.log`, rotated at 5 MB, keeping `engine.log`, `engine.1.log` and `engine.2.log`.
- The plugin writes `plugin.log` in the same folder. Its **Export logs** button zips both.
- Logs contain device, app and file names, never secrets or message content.

## Source layout

| Path | Contents |
|---|---|
| `src/main.rs` | Entry point and the standalone window (egui) |
| `src/headless/` | JSON protocol and the controller the plugin talks to |
| `src/audio/` | Mic capture, output, per-app loopback capture, devices and the mixer |
| `src/dsp/` | Noise removal, gate, auto gain, voice effect and the Quality stage |
| `src/soundboard/` | Finding, decoding and streaming sound files |
| `src/tts/` | Text to speech: Windows voices, Piper download and synthesis |
| `src/llhooks.rs` | Mute and push to talk keys (low-level keyboard and mouse hooks) |
| `src/hotkeys.rs`, `src/hotkey_thread.rs` | Soundboard hotkeys |
| `src/instance.rs` | The lock that allows one o2i to run audio at a time |
| `src/elog.rs` | The log file |
| `src/config.rs` | The window's config file |

## License

GPL-3.0-or-later, like the rest of this repository. See [LICENSE](../LICENSE). Dependencies keep their own licenses (mostly MIT or Apache-2.0; `nnnoiseless` is BSD-3-Clause and Symphonia is MPL-2.0). Piper voices keep their dataset licenses.

## Author

3xyy ([Discord](https://discord.com/users/596844241058267168)).
