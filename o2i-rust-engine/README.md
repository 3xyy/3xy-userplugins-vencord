# o2i-rust-engine

This is the source code of `o2i.exe`, the audio engine behind the [Output2Input](../o2i) plugin. It's written in Rust and only runs on Windows. I'm putting it here so anyone can see what the exe does, or build it themselves instead of downloading it.

## What it does

- Captures your mic and runs it through noise removal (RNNoise, through the nnnoiseless crate), a noise gate, auto gain, an optional voice effect (Signalsmith Stretch) and the Quality stage that can make your mic sound worse on purpose.
- Captures the audio of apps you pick, using Windows' per-process loopback capture. The app still plays on your speakers as usual.
- Plays soundboard files (MP3, WAV, OGG, FLAC, M4A, AAC), decoded with Symphonia and resampled with Rubato.
- Mixes all of that and plays it into VB-CABLE's input, which Discord then uses as a mic.
- Handles hotkeys. Soundboard hotkeys use Windows' `RegisterHotKey` (through the global-hotkey crate). The mute hotkey uses low-level keyboard and mouse hooks instead, so it works while a game has focus and the key still reaches the game.

The audio threads are kept free of locks, memory allocation and panics, so a busy window or plugin doesn't make the audio stutter.

## Two ways to run it

### Headless (what the plugin uses)

The plugin starts `o2i.exe --headless` and talks to it over stdin and stdout, one JSON object per line. Nothing else is ever printed on stdout.

Commands it reads (`"cmd"`): `configure`, `set_audio`, `play_clip`, `seek_clip`, `pause_clip`, `resume_clip`, `stop_clip`, `stop_all`, `set_mic_muted`, `list_devices`, `list_apps`, `list_clips`, `shutdown`.

Events it writes (`"ev"`): `ready`, `state`, `devices`, `apps`, `clips`, `hotkey_error`, `mic_muted`, `error`.

The plugin sends the whole profile (devices, mic settings, routed apps, soundboard) with `configure`, so headless mode never reads or writes a config file. It exits when it gets `shutdown` or when stdin closes. The full protocol is in [`src/headless/protocol.rs`](src/headless/protocol.rs).

A quick test that doesn't open any audio device:

```
printf '%s\n' '{"cmd":"list_devices"}' '{"cmd":"shutdown"}' | o2i.exe --headless
```

You should get a `ready` line, a `state` line and a `devices` line listing your inputs and outputs.

### Window

Run `o2i.exe` with no arguments and you get a small window of its own: devices, mic cleanup, the voice effect, routed apps and a soundboard with hotkeys. It saves its settings to `%APPDATA%\o2i\config.toml`. Mic mute, the automatic gate, hear yourself and the Quality slider are only in the plugin.

`o2i.exe --dump-config` prints the window's saved profile as JSON and exits. The plugin's **Re-import from the o2i app** button uses it.

Only one o2i can run audio at a time, window or headless. If one already is, the other says so and doesn't start its audio.

## Building

You need:

- Windows 11, 64-bit. Windows 10 isn't tested, and capturing a single app's audio needs a recent Windows build.
- [Rust](https://rustup.rs) stable with the MSVC toolchain (`x86_64-pc-windows-msvc`, the default on Windows). The release was built with Rust 1.96.
- Visual Studio Build Tools with the "Desktop development with C++" workload. The voice effect library is C++.
- [LLVM](https://github.com/llvm/llvm-project/releases), for libclang (`winget install LLVM.LLVM` works). If the build can't find it, set `LIBCLANG_PATH` to LLVM's `bin` folder.

Then, in this folder:

```
cargo build --release
```

The exe ends up in `target\release\o2i.exe`. Point the plugin's **Engine path** at it.

`cargo test` runs the unit tests. They don't open your mic or need VB-CABLE.

The `o2i.exe` on the Releases page is built from this folder with `cargo build --release`, plus `--remap-path-prefix` flags in `RUSTFLAGS` so no paths from my PC end up inside the exe.

## Where things are

| Path | What's in it |
|------|--------------|
| `src/main.rs` | Entry point and the standalone window (egui) |
| `src/headless/` | The JSON protocol and the controller the plugin talks to |
| `src/audio/` | Mic capture, output, per-app loopback capture, devices and the mixer |
| `src/dsp/` | Noise removal, gate, auto gain, voice effect and the Quality stage |
| `src/soundboard/` | Finding, decoding and streaming sound files |
| `src/llhooks.rs` | The mute hotkey (low-level keyboard and mouse hooks) |
| `src/hotkeys.rs`, `src/hotkey_thread.rs` | Soundboard hotkeys |
| `src/instance.rs` | The lock that keeps it to one o2i running audio at a time |
| `src/elog.rs` | The log file |
| `src/config.rs` | The window's config file |

## Logs

The engine logs to `%APPDATA%\o2i\logs\engine.log`. It's rotated at 5 MB and keeps three files (`engine.log`, `engine.1.log`, `engine.2.log`). The plugin writes its own `plugin.log` in the same folder, and its **Export logs** button zips both.

## License

GPL-3.0-or-later, like the rest of this repo. See [LICENSE](../LICENSE). The crates it uses keep their own licenses (mostly MIT or Apache-2.0; nnnoiseless is BSD-3-Clause and Symphonia is MPL-2.0).

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)).
