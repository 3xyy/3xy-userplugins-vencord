# Output2Input (o2i)

Output2Input puts more than your mic into your Discord mic. It mixes three things into one virtual mic:

- your real mic, cleaned up (noise removal, a noise gate, auto gain, and optional voice effects)
- the sound of apps you pick, like a music player or a game
- a soundboard made from your own audio files

The mixing is done by a small audio engine, `o2i.exe`, which runs in the background while Discord is open. The plugin starts and stops it and gives you a panel to control it, right next to Discord's mute and deafen buttons.

In Vencord's plugin list it's called **Output2Input**. Everywhere else (the button, the panel, toasts) it just says o2i. The folder is `o2i`.

Windows only, and only in the Discord desktop app (not the browser or Vesktop).

## How it works

```
real mic + apps + soundboard  ->  o2i.exe  ->  CABLE Input  ->  CABLE Output  ->  Discord
```

VB-CABLE is a virtual cable: whatever plays into **CABLE Input** comes out of **CABLE Output** as if it were a microphone. o2i plays its mix into CABLE Input, and Discord uses CABLE Output as your mic. Apps you route still play on your speakers as normal; o2i takes a copy.

The engine only runs audio while you're in a call or have the o2i panel open, unless you turn on **Keep Running Outside Calls**.

## Setup

1. **Install [VB-CABLE](https://vb-audio.com/Cable).** It's free. Unzip it, run the setup as administrator, click Install Driver, and restart your PC if it asks.
2. **Get `o2i.exe`.** Download it from the [latest release](https://github.com/3xyy/userplugins-vencord/releases/latest) and put it somewhere it can stay, for example `C:\Tools\o2i\o2i.exe`. You can also build it yourself, see [o2i-rust-engine](../o2i-rust-engine).
3. **Turn on Output2Input** in Settings > Vencord > Plugins and open its settings.
4. **Paste the full path to `o2i.exe`** into **Engine path**. It says "Found" when the file is there, and the engine starts.
5. **Pick your devices.** **Microphone** is your real mic. **o2i output** should be `CABLE Input (VB-Audio Virtual Cable)`, which is the default when VB-CABLE is installed. **Headphones** is where you hear soundboard sounds and yourself.
6. **Point Discord at o2i.** Click the o2i button in the account panel (bottom left). If Discord isn't using o2i's mic yet, the panel shows a **Fix** button. It sets Discord's input device to CABLE Output and turns off Discord's own noise suppression, Krisp noise cancellation, echo cancellation and auto gain, since o2i does that part now.

That's it. Join a call and talk; the level meter in the Mic tab shows what o2i hears.

## The panel

Click the o2i button in the account panel to open it. The arrows in the corner open a bigger version.

The top row shows whether o2i is running, plus four buttons: mute, power, export logs and expand. While your mic is muted, the o2i button in the account panel gets a small slash through it.

### Mic tab

- **Mute mic** mutes only your real mic. Routed apps and soundboard sounds keep playing. Each toggle plays Discord's own mute or unmute sound, and the mute is remembered when you restart Discord.
- **Mute hotkey**: click the box, then press any key, a key combo, or the middle or side mouse buttons (Mouse3 to Mouse5). It works while a game has focus, and the key still reaches the game. A few things to know:
  - It doesn't fire while an app running as administrator has focus. Windows doesn't pass those keys to normal apps.
  - A plain letter or number key also toggles mute while you type.
  - Side mouse buttons may also go back or forward in Discord.
- **Voice**: Off, Deeper or Higher, with an **Intensity** slider.
- **Quality**: 100 is your normal mic. Lower it to make your mic sound worse on purpose. Around 75 sounds a bit muffled, 50 like a cheap headset, 25 like a bad phone call, and near 0 is barely understandable. It changes live while you drag.
- **Noise cleanup** removes background noise (RNNoise). **Amount** sets how much.
- **Noise gate** cuts your mic while it's quieter than the white line on the level meter. Drag the line to set it, or press **Auto** and the gate follows your background noise by itself.
- **Auto gain** keeps your voice at a steady loudness.
- **Hear yourself** plays your processed mic on your headphones, with a slight delay. Use headphones, or your mic picks it up. It has its own volume slider.
- **Mic volume** and **Master** (mic, apps and sounds together), from 0 to 200%.

### Apps tab

- **Add app** lists the apps that are running, with the ones playing sound first. Pick one and its audio is mixed into your mic.
- Each app has a volume slider (0 to 200%), a **Mute** button and a remove button. The dot is green while o2i is capturing that app. An app that isn't running yet gets picked up once it starts.
- **Lower apps while you talk** turns routed apps down to **Ducked volume** while you're speaking.

### Soundboard tab

- **Folders** sit at the top (they're on the settings page too). **Add folder** picks a folder, and o2i shows the MP3, WAV, OGG, FLAC, M4A and AAC files directly inside it. Subfolders aren't included. Removing a folder keeps its sounds' settings, in case you add it back.
- o2i comes with a default folder holding two sounds. On first start it copies them to `%APPDATA%\o2i\sounds` and adds that folder once. If you remove it, it stays removed, and the files in it are never overwritten.
- Click a sound to play it. **Show sounds from** picks which folders to show, and there's a search box.
- **Edit** on a sound sets its emoji, name and hotkey, how loud others hear it, how loud you hear it, and **Hear locally** (also play it on your headphones). Volume changes apply right away, even to a sound that's already playing.
- **Override all sounds** (under All sounds) uses one set of levels for every sound instead of each sound's own.
- **Now playing** lists what's playing. Each sound has a seek bar (drag it, or use the arrow keys, Home and End), Pause and Resume, Stop, and Volume. **Stop all sounds** stops everything, and there's a **Stop-all hotkey** too.
- Sound hotkeys are F1 to F12, or a letter or digit with Ctrl or Alt (Shift is optional). Unlike the mute hotkey, o2i keeps these keys, so the focused app doesn't get them.

### Power button

Turns o2i off completely. The engine, its hotkeys and the soundboard stop, and Discord goes back to your real mic. Turning it on starts the engine again, and Discord switches back to CABLE Output once audio is running. Off stays off after a restart.

### Export logs

Saves a zip to your Downloads folder (`o2i-logs-<date>-<time>.zip`) that you can attach to a bug report. It holds the engine and plugin logs plus a `summary.json` with versions, your o2i settings, your audio devices, Discord's voice settings, and your soundboard folder and file names.

Before zipping, your Windows user folder is replaced with `%USERPROFILE%`, and your Windows user name with `<user>` wherever it shows up as a whole word. Audio device names and the names of the apps you route are left as they are. Nothing from other plugins goes in.

## If o2i stops

If the engine crashes or stops sending audio during a call, Discord switches to your real mic so you don't go silent, and a toast tells you. When o2i is healthy again, Discord goes back to CABLE Output. The engine restarts by itself after a crash.

If your o2i mic was muted when that happens, Discord self-mutes before it switches, so you're never live by surprise. Your previous Discord mute comes back once o2i recovers.

The fallback only switches to the mic picked in o2i's **Microphone** setting, never to Discord's "Default" (which could be CABLE Output). If it can't find that mic, a toast asks you to pick your mic in Discord's Voice settings.

Turning the plugin off stops the engine and puts Discord's voice settings back the way they were before you clicked Fix.

## Settings page

| Setting | What it does |
|---------|--------------|
| Keep Running Outside Calls | Keeps o2i's audio running when you're not in a call, for example to use VB-CABLE in other apps. Off by default |
| Power | Same as the power button in the panel |
| Engine path | Full path to `o2i.exe` |
| Microphone | Your real mic. o2i needs a named device here, and so does the fallback |
| o2i output | Where o2i plays its mix. Use CABLE Input |
| Headphones (hear sounds locally) | Where soundboard sounds (with Hear locally on) and Hear yourself play |
| Soundboard folders | Same list as in the Soundboard tab |
| Re-import from the o2i app | Copies the settings saved by o2i's standalone window (see the engine README) |
| Export logs | Same as the button in the panel |

## Requirements

- Windows 11. Windows 10 isn't tested, and capturing a single app's audio needs a recent Windows build. It also needs the Discord desktop app with Vencord built from source.
- [VB-CABLE](https://vb-audio.com/Cable).
- `o2i.exe` from the [releases](https://github.com/3xyy/userplugins-vencord/releases/latest), or built from [o2i-rust-engine](../o2i-rust-engine).

## Known limits

- Only one o2i can run audio at a time. If o2i's standalone window is running audio, the plugin's engine can't, and the other way round.
- The mute hotkey doesn't fire while an app running as administrator has focus.
- Sound hotkeys are limited to F1 to F12 and Ctrl or Alt with a letter or digit. Win key combos aren't supported.
- Soundboard folders aren't searched into subfolders.
- The account panel button and the Fix button depend on Discord's UI, so a Discord update can break them until the plugin catches up.

## Privacy

- o2i doesn't send anything anywhere. The engine has no network code, and the only web page the plugin opens is the download page, when you click the link.
- Logs live in `%APPDATA%\o2i\logs` (`engine.log` and `plugin.log`, each rotated at 5 MB). They include device names, app names and sound file paths. Export logs cleans up your user folder and name as described above, but have a look before you post a zip publicly.
- The default sounds go to `%APPDATA%\o2i\sounds`. Only the standalone window writes `%APPDATA%\o2i\config.toml`.
- Your o2i settings are saved with Vencord's other plugin settings, so they're included if you use Vencord's Settings Sync.

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
