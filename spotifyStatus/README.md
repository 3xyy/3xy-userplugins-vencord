# SpotifyStatus

Shows the song you're playing as your custom status (the line under your name), as a rich presence activity on your profile, or both. It can read the song from Spotify, from Windows' media controls (so most players and browser tabs work), or from Last.fm.

## Getting started

1. Turn on SpotifyStatus and open its settings.
2. Pick a **Source**:
   - **Spotify (your Discord connection)**: connect Spotify in Discord under Settings > Connections. Song changes show up right away.
   - **Windows media controls**: reads whatever Windows shows in its media overlay, like the Spotify app, a browser tab or most music players. It checks every few seconds (at least 2). Windows only.
   - **Last.fm**: enter your Last.fm username. It checks your profile for the song Last.fm shows as now playing. An API key is optional; without one it uses the same shared key as Vencord's own music plugin. You can get your own at last.fm/api/account/create.
3. Choose where it shows up: **Update Custom Status** (on by default), **Update Activity** (rich presence, off by default), or both.

The preview at the top of the settings page shows what your status and activity will look like while you change things. It sticks to the top as you scroll, uses the song you're playing (or a sample song when nothing is), and has a Playing / Paused switch so you can check both. You can fold it away with the arrow.

## Templates

The status text and each rich presence line are templates. These placeholders get filled in:

| Placeholder | Becomes |
|-------------|---------|
| `{song}` | Song title |
| `{artist}` | Artist |
| `{album}` | Album |
| `{position}` | How far into the song you are, like `1:23` |
| `{duration}` | Song length, like `3:45` |
| `{icon}` | One of your icons (see below) |

The default status is `{icon} {song} - {artist}`. If you use `{position}` or `{duration}`, also turn on **Tick Time** so they update every second, and keep **Custom Status Throttle Seconds** at 8 or more.

Text is capped at 128 characters, Discord's limit. Fancy fonts use two characters per letter, so they reach the limit sooner.

## Fonts, icons and emoji

- **Font Style** turns the custom status into Bold, Italic, Bold italic, Script, Bold script, Fraktur, Double-struck, Monospace, Small caps, Fullwidth, Circled or Squared letters. Rich presence always uses plain letters.
- **Icon Pool** is the list `{icon}` picks from, separated by spaces or commas (default `♪`). **Icon Randomize Every** picks a new one every song, every update, or never. The Music icons row lets you click an icon to copy it.
- **Emoji** is the emoji in front of your custom status (default 🎵). Turn on **Emoji Randomize** to pick a random one from **Emoji Pool** for each new song.

## Rich presence

| Setting | Default | What it does |
|---------|---------|--------------|
| Activity Type | Listening to | Listening to, Playing, Watching, Competing in, Streaming, or Hang status |
| Activity Name | `Music` | Top line. Avoid "Spotify" here, or Discord mixes it up with its own Spotify activity |
| Activity Details | `{song}` | Second line |
| Activity State | `by {artist}` | Third line |
| Activity Status Display | Top line | Which line shows next to your name in the member list |
| Large Image Source | Album cover | Album cover (Spotify and Last.fm), artist picture (Spotify only, needs the SpotifyControls plugin), an image link, or none |
| Large Image Custom Url | empty | The picture's link, when the source is set to Image link |
| Large Image Text | `{album}` | Shown when someone hovers the picture |
| Timestamp Mode | Song progress | Song progress with a bar, time into the song without a bar, time since the plugin started, time since midnight, or none |

Leave a line empty to hide it. If Discord's **Share your activity** setting is off, others can't see the activity; the settings page warns you and has a button to turn it on. Your custom status isn't affected by that setting.

## Filters

**Artist Filter Mode** and **Song Filter Mode** can each be Off, **Only show these** (whitelist) or **Hide these** (blacklist). When a song is filtered out, nothing is shown for it.

- The Artists and Songs lists start folded so the page stays short. Click a list to open it. Long lists show 200 entries at a time.
- Artist names and song names don't care about capital letters. Songs can also be Spotify URIs like `spotify:track:63OQupATfueTdZMWTxW03A`.
- **Import artists** and **Import songs** under the lists add many entries at once: paste a list (one per line), or pull them from a Spotify playlist by its link (needs Spotify open and the SpotifyControls plugin). Songs can be added as names or as Spotify URIs.

## Timing and other settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Strip Parens | Off | Removes parts in brackets from song names, so "Song (Remastered)" becomes "Song" |
| Paused Template | empty | Status text while paused, used only when Clear On Pause is off. Empty clears the status on pause |
| Tick Time | Off | Updates every second. Only needed for `{position}` or `{duration}` |
| Custom Status Throttle Seconds | 10 | Seconds between custom status changes. Discord limits how often it can change |
| Clear On Pause | On | Clears the status when you pause |
| Restore On Stop | Off | When you turn the plugin off, puts back the custom status you had before. Off just clears the song |
| Debug | Off | Logs details to the console (filter by SpotifyStatus) |

## It only clears what it set

SpotifyStatus remembers the exact status it set. When it needs to clear it (you paused, the song got filtered, you turned the plugin off), it first checks that your status is still that one. If you changed your status by hand in the meantime, it leaves yours alone. Restore On Stop works the same way and skips the restore if you've changed your status since.

## Requirements

- Vencord built from source.
- For the Spotify source: Spotify connected to your Discord account.
- For Windows media controls: Windows 10 or 11 (it reads them through a small PowerShell script).
- For Last.fm: a Last.fm account that scrobbles what you play.

## Known limits

- Discord limits how often your custom status can change, so with `{position}` it won't tick every second on your profile. The throttle setting keeps it under the limit.
- Windows media controls and Last.fm don't give an album cover the same way Spotify does: Windows media controls has no picture at all, and Last.fm only has the album cover.
- The artist picture and playlist import need Vencord's SpotifyControls plugin.
- Last.fm only knows a song once it shows as now playing there, so it can lag behind a little.

## Privacy

- With the Last.fm source, your Last.fm username is sent to Last.fm's API (`ws.audioscrobbler.com`) every few seconds.
- With Windows media controls, the PowerShell script runs locally. Its copy lives in Vencord's data folder.
- Your custom status and rich presence are visible to other people, the same as if you set them yourself.
- With Debug on, song names show up in Discord's console.

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
