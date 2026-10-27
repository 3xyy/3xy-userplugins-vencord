# ExportChat

Saves Discord channels, DMs, group DMs, whole servers, or a queue of channels and message ranges as one HTML file. The file opens in any browser and looks like Discord.

## Exporting

- Right-click a channel, DM, group DM or thread and choose **Export Chat**. Right-click a server for **Export Server**.
- **Add to Export Queue** (channels) and **Add Server to Export Queue** (servers) collect several things into one file. Once something is queued, the menu shows **Export Queue (n items)**.
- To export part of a chat, right-click a message and choose **Start export range here**, then right-click another one and choose **End export range here**. **Add Range to Queue** adds it to the queue, and **Clear Range** removes the markers.

### Options in the export window

- **Dates** (both days included), **Only these users** and **Leave out users** (user IDs, comma separated), **Only messages with** images, videos, files or links, and **Most messages per channel**.
- **Highlight or hide messages** starts Select in Chat: click a message to highlight it, again to hide it, and once more to reset it. Highlighted messages are marked in the export, and hidden ones are left out. Right-click a message and pick **Highlight from the last click to here** or **Hide from the last click to here** to do a whole run at once. When you're done, right-click a message and choose **Back to Export**.
- **Media:**
  - **Link to Discord's CDN** (default): small files, but the links can expire.
  - **Embed in the file**: everything is stored in the file as Base64, so it works offline but gets big.
  - **Upload to catbox.moe**: files are re-hosted there. These uploads are public and permanent.
- **Password** encrypts the messages (AES-256-GCM, with the key from PBKDF2-SHA256). People need the password to open the file.
- **Admin mode** lets you edit, add, import or delete messages in the exported page, then download a clean copy with **Finish Editing**.
- **Share online** uploads the export to your Cloudflare Pages project and copies the link (see below).

## Export history

The plugin's settings page has the export history. From there you can show an export in its folder, open a shared page, copy its link, delete local files and delete shared pages, one at a time or several at once. It also has **Upload HTML** for sharing an export you already have.

## Sharing to Cloudflare Pages

Sharing stays off until all three Cloudflare settings are filled in: an **API token** with Pages edit permission, the **account ID**, and the name of an **existing Pages project**.

- It needs **Node.js with `npx` on Discord's PATH**. ExportChat runs `npx --yes wrangler@4.63.0 pages deploy`, and npx downloads that exact wrangler version the first time. The version is pinned on purpose, so a new wrangler release can't change what runs.
- On Windows the plugin looks for `node.exe` and `node_modules\npm\bin\npx-cli.js` in the same PATH folder, which is how the normal Node.js installer sets things up. **Node managers that use shims, such as Volta, aren't found**, and sharing then says Node.js is missing.
- Each share goes to its own random preview branch (`s-<random>`), never to your production branch. The link you get is that deployment's own random address, and **anyone with the link can open it**. Use a password for private chats.
- Delete shares from the export history when you don't need them any more.
- **Upload HTML** (in the export history) shares an export you already have, such as the clean copy admin mode's **Finish Editing** downloads. You can set a password and turn the admin tools on, the same as for a new export. Only ExportChat exports are accepted. A password-protected export can't be read, so pick the copy without a password and set the password in the dialog. After the upload, the dialog offers to delete the local file.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Default Media Mode | Link to Discord's CDN | What exports do with images, videos and files unless you pick something else |
| Catbox Userhash | empty | Optional. Your catbox.moe userhash, so catbox uploads show up in your account |
| Save Location | empty | Folder to save exports in. Empty means they're downloaded through the browser instead |
| File Exists Behavior | Add a number | When a file with the same name exists: add `_2`, `_3` and so on, or replace it |
| Cf Api Token | empty | Cloudflare API token with Pages edit permission |
| Cf Account Id | empty | Your Cloudflare account ID (32 hex characters) |
| Cf Pages Project | empty | Name of an existing Cloudflare Pages project |

## Save location and history

- Exports are saved to the folder in the **save location** setting, or downloaded through the browser when it's empty.
- **Network folders (`\\server\share`) aren't supported** as the save location. A mapped drive letter works.
- **Show in folder** and **Delete file** in the export history only work for exports in the **current** save folder. For a file saved to an earlier save location, the history says so; open or delete it from that folder yourself.
- The Upload dialog's **Delete the local file** deletes the file you picked in that dialog, in any local folder (Downloads, for example). It still refuses network paths, links, and files that aren't ExportChat exports.

## Requirements

- Vencord built from source, in the Discord desktop app.
- Node.js, only if you want to share to Cloudflare Pages.
- A Cloudflare account with a Pages project, also only for sharing.

## Known limits

- Big exports take a while. Messages are fetched through Discord's API, which is rate limited, and embedding media makes the file grow quickly.
- CDN links in an export stop working once Discord's links expire. Use Embed or catbox if the export needs to last.
- At most 100 invite links per export are turned into invite cards.
- Sharing or uploading an export is capped at 25 MB per file.
- Volta and other shim-based Node managers aren't detected for sharing.

## Privacy notes

- **Settings Sync:** the Cloudflare API token and the catbox userhash are ordinary plugin settings. If you use Vencord Settings Sync, they are uploaded with your other settings.
- **Catbox uploads are public and permanent.** With catbox, every attachment, avatar, emoji, sticker and embed image in the export is re-hosted on catbox.moe. Only Discord CDN and Twemoji links are re-hosted; other links stay as they are.
- **Password-protected exports** encrypt the messages, but the page title (`Export: <server or DM name>`) and the IDs of highlighted messages are not encrypted.
- **Admin mode's Finish Editing** downloads an **unencrypted** copy, even when the export had a password.
- **Admin mode's Import** uses pasted DCEF-format JSON almost as it is. It only limits links to http(s), stickers to plain images, and lists and objects to their usual shape, so only paste JSON you made yourself. **Upload HTML** checks a file's data more strictly: it also limits images and other media to http(s) links and `data:` files that aren't HTML or SVG pages, and colours and sizes to plain values.
- **Export history:** it's stored on this computer (not synced), keeps each export's password as a reminder, and shows it in the plugin settings.
- **Invite links:** `discord.gg` links in exported messages are looked up through the Discord API to show invite cards, at most 100 per export.
- **What an opened export loads by itself** (these hosts see the viewer's IP address):
  - images and videos from Discord's CDN and media proxy (`cdn.discordapp.com`, `media.discordapp.net`, `images-ext-*.discordapp.net`), unless the export embeds them;
  - `files.catbox.moe` for catbox exports;
  - Twemoji images from `cdn.jsdelivr.net`;
  - embedded players (iframes) for YouTube, Twitch clips, Spotify and Tenor when a message with one of those embeds is shown.

  Markdown images (`![x](url)`) aren't shown, as in Discord, so message text can't make the page load other sites.

## Credits and license

The export viewer, `dcef-template.html`, is a **modified build of [DiscordChatExporter-frontend (DCEF)](https://github.com/slatinsky/DiscordChatExporter-frontend) by slatinsky**. DCEF is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html), and the bundled file is distributed under the same license.

- The bundled file is a pre-built, minified copy of the DCEF viewer, changed for ExportChat. It doesn't record which DCEF version it was built from; the upstream source is in the DCEF repository linked above.
- The changes were made directly in the built, minified file. That file is the preferred form for these changes, and its header comment lists them:
  - it reads the export from `window.__DCEF_DATA` instead of the DCEF backend;
  - highlighted messages, invite cards and admin-mode hooks;
  - the bundled Discord fonts (gg sans, Whitney) are removed in favour of local and system fonts;
  - YouTube embeds use https;
  - the markdown renderer escapes every value that comes from a message.
- Third-party code bundled in the viewer stays under its own license: the Svelte runtime, moment.js, highlight.js, lottie-web and simple-markdown.

The rest of the plugin is GPL-3.0-or-later, like Vencord.

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)).
