# SpotifyStatus

Shows the current song in the custom status, as a rich presence activity, or both. The song can come from Spotify, Windows media controls or Last.fm.

## Features

- Three sources: the Spotify connection in Discord, Windows media controls (most players and browser tabs) or Last.fm.
- Templates for the status text and each rich presence line, with placeholders.
- Unicode letter styles, a rotating `{icon}` and a random status emoji.
- Rich presence with a configurable activity type, image, hover text and timestamp.
- Artist and song filters (whitelist or blacklist), with bulk import from a pasted list or a Spotify playlist.
- A live preview at the top of the settings page, with a Playing and Paused switch.
- Clears or restores only the status it set itself. A status changed by hand is left alone.

## Screenshots

![SpotifyStatus settings with the live preview](../assets/spotifyStatus/settings.png)

## Usage

1. Enable SpotifyStatus and open its settings.
2. Choose a **Source**:
   - **Spotify (your Discord connection)**: connect Spotify under **Settings > Connections**. Updates are immediate.
   - **Windows media controls**: reads what Windows shows in its media overlay. Set **Check every (seconds)** (minimum 2).
   - **Last.fm**: enter the **Last.fm username** and set **Check every (seconds)**. Without a **Last.fm API key (optional)**, the plugin uses the shared key of Vencord's own music plugin.
3. Turn on **Update Custom Status**, **Update Activity**, or both.
4. Edit the templates and check the result in the preview.

### Template placeholders

| Placeholder | Value |
|---|---|
| `{song}` | Song title |
| `{artist}` | Artist |
| `{album}` | Album |
| `{position}` | Elapsed time, such as `1:23` |
| `{duration}` | Song length, such as `3:45` |
| `{icon}` | An icon from **Icon Pool** |

## Settings

### Source and format

| Setting | Default | Description |
|---|---|---|
| Source | Spotify | Spotify connection, Windows media controls or Last.fm. |
| Update Custom Status | On | Shows the song in the custom status. |
| Update Activity | Off | Shows the song as a rich presence activity. |
| Template | `{icon} {song} - {artist}` | Status text while playing. |
| Paused Template | Empty | Status text while paused, used only when **Clear On Pause** is off. Empty clears the status. |
| Strip Parens | Off | Removes bracketed parts, so "Song (Remastered)" becomes "Song". |
| Font Style | Normal | Letter style for the custom status: Bold, Italic, Bold italic, Script, Bold script, Fraktur, Double-struck, Monospace, Small caps, Fullwidth, Circled or Squared. |

### Icons and emoji

| Setting | Default | Description |
|---|---|---|
| Icon Pool | `♪` | Icons for `{icon}`, separated by spaces or commas. |
| Icon Randomize Every | Every new song | When to pick a new icon: every new song, every update, or never. |
| Emoji | Musical note emoji | Emoji before the status text. Ignored when **Emoji Randomize** is on. |
| Emoji Randomize | Off | Picks a random emoji from **Emoji Pool** for each new song. |
| Emoji Pool | Six music emoji and symbols | Emoji to pick from, separated by spaces or commas. |

### Rich presence

| Setting | Default | Description |
|---|---|---|
| Activity Type | Listening to | Listening to, Playing, Watching, Competing in, Streaming, or Hang status. |
| Activity Name | `Music` | Top line. Avoid "Spotify", which Discord confuses with its own Spotify activity. |
| Activity Details | `{song}` | Second line. |
| Activity State | `by {artist}` | Third line. |
| Activity Status Display | Top line | The line shown next to the name in the member list. |
| Large Image Source | Album cover | Album cover (Spotify and Last.fm), artist picture (Spotify, needs SpotifyControls), an image link, or none. |
| Large Image Custom Url | Empty | Image URL (http or https) for the Image link option. |
| Large Image Text | `{album}` | Hover text for the image. Empty shows the album name. |
| Timestamp Mode | Song progress | Song progress with a bar, time into the song, time since the plugin started, time since midnight, or none. |

Leave a line empty to hide it.

### Filters and timing

| Setting | Default | Description |
|---|---|---|
| Artist Filter Mode | Off | Off, Only show these (whitelist), or Hide these (blacklist). |
| Song Filter Mode | Off | Same options for the song list. Songs can be names or Spotify URIs. |
| Tick Time | Off | Updates every second. Needed only for `{position}` and `{duration}`. |
| Custom Status Throttle Seconds | 10 | Minimum seconds between custom status changes. Keep at 8 or more when using `{position}` or `{duration}`. |
| Clear On Pause | On | Clears the status when playback pauses. |
| Restore On Stop | Off | Restores the previous custom status when the plugin is turned off, unless it was changed since. |
| Debug | Off | Logs details to the console (filter by SpotifyStatus). |

## Requirements

- Vencord built from source.
- Spotify source: Spotify connected to the Discord account.
- Windows media controls source: Windows 10 or 11 (read through a local PowerShell script).
- Last.fm source: a Last.fm account that scrobbles playback.
- Artist pictures and playlist import: Vencord's SpotifyControls plugin. Playlist import also needs Spotify open.

## Notes

- Text is capped at 128 characters, Discord's limit. Most letter styles use two characters per letter, so they reach the limit sooner.
- Discord limits how often the custom status can change, so `{position}` does not update every second on the profile.
- If Discord's **Share your activity** setting is off, others cannot see the activity. The settings page shows a warning and a button to turn it on. The custom status is not affected.
- Windows media controls provide no cover image. Last.fm provides only the album cover.
- Last.fm reports a song only once it shows as now playing there, so it can lag slightly.
- Filtered songs show nothing. Filter matching ignores letter case. Long lists show 200 entries at a time.
- Privacy: the Last.fm source sends the username to `ws.audioscrobbler.com` every few seconds. With Debug on, song names appear in Discord's console.

## Author

3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
