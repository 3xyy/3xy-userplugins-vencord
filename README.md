# userplugins-vencord

my s-tier vencord userplugins

These are the [Vencord](https://vencord.dev) plugins I made for myself and use every day. Each folder is one plugin, and each one has its own README with the details.

| Plugin | What it does |
|--------|--------------|
| [ExportChat](exportChat) | Saves channels, DMs or whole servers as one HTML file that looks like Discord |
| [ImageTools](imageTools) | Draw on, blur, crop and resize images before you send them |
| [Output2Input](o2i) | Mixes app audio, a soundboard and a cleaned-up mic into your Discord mic (Windows) |
| [RoleMembers](roleMembers) | Right-click a server to see its roles, what they can do, and who has them |
| [SpotifyStatus](spotifyStatus) | Puts the song you're playing in your custom status or a rich presence |

[`o2i-rust-engine`](o2i-rust-engine) isn't a plugin. It's the source code of `o2i.exe`, the audio engine Output2Input runs.

## A closer look

**ExportChat.** Right-click a channel, DM or server and pick Export. You get one HTML file that opens in any browser and looks like Discord. There are filters, an export queue, message ranges, optional passwords, and you can share an export through your own Cloudflare Pages project.

**ImageTools.** Attach an image, click the brush, and you get a small editor: brush, shapes, arrows, text, highlight, blur, pixelate, insert another image, crop, rotate and resize. Save, and the attachment is swapped for the edited one. It also adds Rotate left and Rotate right to the image viewer.

**Output2Input (o2i).** Runs a small audio engine next to Discord. Your mic gets noise cleanup, a noise gate, auto gain and optional voice effects, apps you pick (music, a game) are mixed in, and there's a soundboard with hotkeys. A mute hotkey works while you're in a game. Everything is controlled from a button next to Discord's mute and deafen buttons.

**RoleMembers.** A three-column window: every role, the permissions of whatever you select, and the members who have it. Click a permission to see every role and member that has it, admins included.

**SpotifyStatus.** Shows what you're listening to as your custom status, a rich presence activity, or both. It reads from Spotify, Windows' media controls (any player) or Last.fm, and has templates, fancy fonts, icons, artist and song filters and a live preview.

## Installing

Userplugins only work with Vencord built from source. The regular Vencord installer can't load them.

You need [Git](https://git-scm.com), [Node.js](https://nodejs.org) (the LTS version is fine) and pnpm (`npm install -g pnpm`).

1. Clone Vencord and install its dependencies:
   ```
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
2. Download this repo: the green **Code** button, then **Download ZIP**, or `git clone https://github.com/3xyy/userplugins-vencord`.
3. Copy the plugin folders you want into `Vencord/src/userplugins/`. Make the `userplugins` folder if it isn't there. You should end up with paths like `src/userplugins/imageTools/index.tsx`.
4. Build Vencord and patch Discord:
   ```
   pnpm build
   pnpm inject
   ```
5. Restart Discord, then turn the plugins on in **Settings > Vencord > Plugins**.

Copy only the plugin folders. Vencord treats everything sitting directly in `src/userplugins` as a plugin, so this repo's README, LICENSE or the `o2i-rust-engine` folder in there will break the build.

Vencord's own guides go into more detail: [installing from source](https://docs.vencord.dev/installing/) and [custom plugins](https://docs.vencord.dev/installing/custom-plugins/).

### Updating

Copy the new plugin folders over the old ones, run `pnpm build`, and reload Discord with Ctrl+R. You only need `pnpm inject` again if a Discord update removed Vencord.

## Output2Input needs two extra things

The o2i plugin controls a separate program, so on top of the plugin you need:

- [VB-CABLE](https://vb-audio.com/Cable), a free virtual audio cable. o2i plays into it, and Discord uses it as your mic.
- `o2i.exe` from this repo's [Releases](https://github.com/3xyy/userplugins-vencord/releases/latest). You can also build it yourself from [`o2i-rust-engine`](o2i-rust-engine).

The [o2i README](o2i/README.md) walks through the setup.

## Checks

Some plugins have a `_dev` folder with small checks for their logic. They run without Discord. From the Vencord folder:

```
pnpm exec tsx src/userplugins/o2i/_dev/check-logic.ts
```

Nothing in the plugins imports these files, so they never end up in your build.

## License

GPL-3.0-or-later, same as Vencord. See [LICENSE](LICENSE).

ExportChat bundles a modified build of [DiscordChatExporter-frontend](https://github.com/slatinsky/DiscordChatExporter-frontend) by slatinsky (GPL-3.0). Its README has the details.

## Author

Made by 3xyy. You can find me on [Discord](https://discord.com/users/596844241058267168). If something breaks, open an issue here.
