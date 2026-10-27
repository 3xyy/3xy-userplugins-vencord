# ImageTools

Edit images before you send them: draw on them, blur or pixelate parts, add other images, crop, rotate and resize. It also adds Rotate left and Rotate right to the image right-click menu.

## Editing an image

1. Attach one or more images to a message, but don't send it yet.
2. Click the brush icon on the image (it says "Edit image" when you hover it). There's also a brush in the message bar, which asks which image you mean if there are several.
3. Make your edits.
4. Type a new file name in the bottom bar if you want one, then click **Save**. The attachment is swapped for the edited image, and you send the message as usual.

Your drawings stay editable until you send: open the editor on the same image again and you can still move, change or delete them.

### Tools

**Drawing:** Select, Brush, Line, Arrow, Rectangle, Ellipse, Text, Highlight, Blur, Pixelate, Insert, Crop and Eraser.

**Insert** opens a file picker. The image you pick is placed in the middle of the view and selected, so you can move or resize it right away. Dragging a corner keeps its proportions; hold Shift to stretch it. Delete removes it, and undo and redo work as usual. Very large pictures are shrunk to at most twice the size of the image you're editing, to save memory. Rotating, flipping, resizing or cropping the image moves inserted images along with it.

**Blur and Pixelate** hide everything under them: the photo, inserted images and anything drawn below. Drawings on top stay sharp. A blur on top of another blur covers what's under both instead of blurring the blur. Strength goes from 1 to 100, and further right is always stronger. The strength is measured in image pixels, so it looks the same at any zoom and in the saved file.

**Whole image:** rotate left or right, flip horizontally or vertically, and resize. **Start over** removes every edit.

### Zoom and pan

Ctrl+scroll (or pinch) zooms around the pointer, from 10% to 1600%. Ctrl+= and Ctrl+- zoom too. Drag with the middle mouse button, or hold Space and drag, to pan. Ctrl+0, or a click on the zoom percentage in the bottom bar, fits the image again.

### Undo

Ctrl+Z undoes and Ctrl+Y (or Ctrl+Shift+Z) redoes, up to 50 steps. Rotate, flip, resize, crop and Start over each keep a full copy of the image, so at most 10 of those steps are kept.

### Saving

- **File name:** the box in the bottom bar starts with the attachment's name. The extension after it follows the save format, so typing ".png" yourself isn't needed. Characters that aren't allowed in file names are replaced with "_".
- **Format:** PNG by default. You can pick WebP or "Same as the original" in the settings.
- **Size limit:** pick one in the bottom bar. If the edit is bigger, it's saved as WebP and compressed to fit: lower quality first, then smaller dimensions.
- The original stays attached until Discord accepts the edited image. If Discord turns it down (for example, it's over your upload limit), the editor stays open with your edits.
- Discord allows 10 attachments per message. If you already have 10, remove one before saving.
- Editing a GIF saves a still image.

## Rotating in the viewer

Right-click an image and pick **Rotate right** or **Rotate left** to turn it 90°. This only changes how it's shown; the file isn't touched.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Enable Upload Editor | On | Shows the brush button on attached images and in the message bar |
| Enable Viewer Rotate | On | Adds Rotate left and Rotate right to the image right-click menu |
| Default Save Format | PNG | PNG, WebP (smaller files), or the same as the original (JPEG stays JPEG, WebP stays WebP, anything else saves as PNG) |
| Default Size Limit MB | 10 | The size limit the editor starts with; 0 means no limit |
| Remember Last Tool | On | Opens the editor with the tool you used last |

The first two take effect after you reload Discord (Ctrl+R).

## Known limits

- GIFs and other animated images are saved as a single still frame.
- The brush on the attachment itself depends on Discord's upload preview. If a Discord update moves things around and it disappears, the brush in the message bar still works.
- Viewer rotation isn't saved anywhere. It resets once Discord draws the image again, for example when you reopen the viewer.

## Privacy

Everything happens on your computer. The edited image only leaves it when you send the message, the same as any attachment.

## Author

Made by 3xyy ([Discord](https://discord.com/users/596844241058267168)). GPL-3.0-or-later.
