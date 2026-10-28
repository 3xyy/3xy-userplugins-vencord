# 3xy-userplugins-vencord

my overengineered s-tier vencord userplugins

Userplugins for [Vencord](https://vencord.dev). Each plugin folder has its own README.

## Plugins

| Plugin | Purpose |
|---|---|
| [ExportChat](exportChat) | Exports channels, DMs and servers to a single HTML file that renders like Discord. |
| [ImageTools](imageTools) | Edits attached images before sending: annotate, blur, crop, rotate and resize. |
| [Output2Input (o2i)](o2i) | Mixes a processed mic, app audio, a soundboard and text to speech into one virtual mic. Windows only. |
| [RoleMembers](roleMembers) | Shows a server's roles, their permissions and their members in one window. |
| [SpotifyStatus](spotifyStatus) | Shows the current song in the custom status, a rich presence activity, or both. |

[`o2i-rust-engine`](o2i-rust-engine) is not a plugin. It contains the source code of `o2i.exe`, the audio engine that Output2Input controls.

## Requirements

- The Discord desktop app.
- Vencord built from source. The standard Vencord installer cannot load userplugins.
- [Git](https://git-scm.com), [Node.js](https://nodejs.org) (LTS) and pnpm (`npm install -g pnpm`).

## Installation

1. Clone Vencord and install its dependencies:
   ```
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
2. Download this repository: **Code** > **Download ZIP**, or `git clone https://github.com/3xyy/3xy-userplugins-vencord`.
3. Copy the plugin folders into `Vencord/src/userplugins/`. Create the `userplugins` folder if it does not exist. Paths should look like `src/userplugins/imageTools/index.tsx`.
4. Build Vencord and patch Discord:
   ```
   pnpm build
   pnpm inject
   ```
5. Restart Discord and enable the plugins in **Settings > Vencord > Plugins**.

> [!WARNING]
> Copy only the plugin folders. Vencord treats every entry directly inside `src/userplugins` as a plugin. Placing this repository's `README.md`, `LICENSE`, `assets` folder or `o2i-rust-engine` folder there breaks the build.

Vencord's documentation covers [installing from source](https://docs.vencord.dev/installing/) and [custom plugins](https://docs.vencord.dev/installing/custom-plugins/) in more detail.

## Updating

1. Download the latest version of this repository.
2. Replace the plugin folders in `src/userplugins` with the new ones.
3. Run `pnpm build` and reload Discord with Ctrl+R.

Run `pnpm inject` again only if a Discord update removed Vencord. For Output2Input, also replace `o2i.exe` with the one from the [latest release](https://github.com/3xyy/3xy-userplugins-vencord/releases/latest).

## Output2Input requirements

Output2Input controls a separate program. In addition to the plugin, it needs:

- Windows 11.
- [VB-CABLE](https://vb-audio.com/Cable), a free virtual audio cable. o2i plays into it, and Discord uses it as the microphone.
- `o2i.exe` from the [latest release](https://github.com/3xyy/3xy-userplugins-vencord/releases/latest), or built from [`o2i-rust-engine`](o2i-rust-engine).

Setup steps are in the [o2i README](o2i/README.md).

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="assets/o2i/panel-mic.png" alt="The o2i panel, Mic tab"></td>
    <td width="50%"><img src="assets/imageTools/editor.png" alt="The ImageTools editor"></td>
  </tr>
  <tr>
    <td align="center">Output2Input</td>
    <td align="center">ImageTools</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/roleMembers/modal.png" alt="The RoleMembers window"></td>
    <td width="50%"><img src="assets/exportChat/exported-page.png" alt="An ExportChat export open in a browser"></td>
  </tr>
  <tr>
    <td align="center">RoleMembers</td>
    <td align="center">ExportChat</td>
  </tr>
</table>

## Development checks

Some plugins include a `_dev` folder with logic checks that run without Discord. From the Vencord folder:

```
pnpm exec tsx src/userplugins/o2i/_dev/check-logic.ts
```

No plugin code imports these files, so they are not part of the build.

## License

GPL-3.0-or-later, the same as Vencord. See [LICENSE](LICENSE).

ExportChat bundles a modified build of [DiscordChatExporter-frontend](https://github.com/slatinsky/DiscordChatExporter-frontend) by slatinsky (GPL-3.0). See the [ExportChat README](exportChat/README.md#credits-and-license) for details.

## Author

Made by 3xyy. Contact me on [Discord](https://discord.com/users/596844241058267168).

Report problems in [GitHub Issues](https://github.com/3xyy/3xy-userplugins-vencord/issues).
