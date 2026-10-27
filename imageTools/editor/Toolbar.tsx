/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast, Tooltip } from "@webpack/common";

import { logger } from "../logger";
import { Doc, ToolId } from "./model";
import { promptText } from "./prompt";
import { bakeFlip, bakeResize, bakeRotate90 } from "./transforms";

// [id, label (tooltip and accessible name), SVG path(s)]
const TOOL_ICONS: [ToolId, string, string][] = [
    ["select", "Select and move", "M4 0l16 12-7 2-4 8z"],
    ["brush", "Brush", "M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37-1.34-1.34a1 1 0 0 0-1.41 0L9 12.25 11.75 15l8.96-8.96a1 1 0 0 0 0-1.41z"],
    ["line", "Line", "M20 4H4v2h16V4zM4 20h16v-2H4v2zM4 13h16v-2H4v2z"],
    ["arrow", "Arrow", "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"],
    ["rect", "Rectangle", "M3 5v14h18V5H3zm16 12H5V7h14v10z"],
    ["ellipse", "Ellipse", "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"],
    ["text", "Text", "M2.5 4v3h5v12h3V7h5V4h-13zm19 5h-9v3h3v7h3v-7h3V9z"],
    ["highlight", "Highlight", "M18.5 1.15c-.53 0-1.04.19-1.43.58l-5.95 5.94 2.83 2.83 5.94-5.95c.79-.79.79-2.07.01-2.85-.38-.39-.9-.55-1.4-.55zM9.22 10.36L4 13.49l.73 2.77L3 17.85 6.15 21l1.59-1.73 2.77.73 3.13-5.22-4.42-4.42z"],
    ["blur", "Blur", "M6 13c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0-8c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-3 5.5c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zM12 1C5.93 1 1 5.93 1 12s4.93 11 11 11 11-4.93 11-11S18.07 1 12 1zm0 20c-4.96 0-9-4.04-9-9s4.04-9 9-9 9 4.04 9 9-4.04 9-9 9zm3-12.5c-.28 0-.5.22-.5.5s.22.5.5.5.5-.22.5-.5-.22-.5-.5-.5zM9 9c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3-6c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm3-4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"],
    ["pixelate", "Pixelate", "M4 4h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 10h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4zM4 16h4v4H4zm6 0h4v4h-4zm6 0h4v4h-4z"],
    ["insert", "Insert", "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"],
    ["crop", "Crop", "M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"],
    ["eraser", "Eraser", "M15.14 3c-.51 0-1.02.2-1.41.59L2.59 14.73c-.78.77-.78 2.04 0 2.83L5.03 20H2v2h14l5.41-5.39c.79-.78.79-2.05 0-2.83l-9-9A1.99 1.99 0 0 0 15.14 3zm0 2l4.56 4.56-3.41 3.44-4.97-5.03L15.14 5zM9.91 9.38l4.97 5.03-3.48 3.59H5.03l-2.44-2.44L9.91 9.38z"],
];

interface Props {
    tool: ToolId; setTool(t: ToolId): void;
    /** Insert button: pick an image file and place it on the canvas. */
    onInsert(): void;
    canUndo: boolean; canRedo: boolean; onUndo(): void; onRedo(): void;
    doc: Doc; setDoc(d: Doc): void; pushHistory(): void;
    onReset(): void;
}

// Upscale limits: past these a canvas fails to allocate (or eats GBs of RAM) and Save can't encode it.
const MAX_SIDE = 16384;
const MAX_PIXELS = 64_000_000;

async function resizePrompt(p: Props) {
    const { base } = p.doc;
    const s = await promptText({ title: "Resize image", label: "Width in pixels (the height follows)", initialValue: String(base.width), confirmText: "Resize" });
    if (!s) return;
    const tw = parseInt(s, 10);
    if (!tw || tw < 1) return;
    const th = Math.max(1, Math.round(base.height * tw / base.width));
    if (tw > base.width && (tw > MAX_SIDE || th > MAX_SIDE || tw * th > MAX_PIXELS)) {
        showToast({ text: `That's too big. The limit is ${MAX_SIDE} px per side and ${MAX_PIXELS / 1e6} megapixels.`, variant: "critical" });
        return;
    }
    try {
        const r = bakeResize(base, p.doc.objects, tw, th);
        p.pushHistory();
        p.setDoc({ ...p.doc, ...r, selectedId: null });
    } catch (e) {
        logger.error("resize failed", e);
        showToast({ text: "Couldn't resize the image.", variant: "critical" });
    }
}

function ToolIcon({ path }: { path: string; }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d={path} />
        </svg>
    );
}

/** An icon button with a tooltip; `label` is both the tooltip and the accessible name. */
function IconButton({ label, path, selected, disabled, onClick }: { label: string; path: string; selected?: boolean; disabled?: boolean; onClick(): void; }) {
    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    aria-label={label}
                    className={"vc-it-tool" + (selected ? " selected" : "")}
                    disabled={disabled}
                    onClick={onClick}
                >
                    <ToolIcon path={path} />
                </button>
            )}
        </Tooltip>
    );
}

// icons of the buttons after the tools
const ICON_UNDO = "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z";
const ICON_REDO = "M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z";
const ICON_RESET = "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z";
const ICON_ROTATE_LEFT = "M7.11 8.53 5.7 7.11C4.8 8.27 4.24 9.61 4.07 11h2.02c.14-.87.49-1.72 1.02-2.47zM6.09 13H4.07c.17 1.39.72 2.73 1.62 3.89l1.41-1.42c-.52-.75-.87-1.59-1.01-2.47zm1.01 5.32c1.16.9 2.51 1.44 3.9 1.61V17.9c-.87-.15-1.71-.49-2.46-1.03L7.1 18.32zM13 4.07V1L8.45 5.55 13 10V6.09c2.84.48 5 2.94 5 5.91s-2.16 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93s-3.05-7.44-7-7.93z";
const ICON_ROTATE_RIGHT = "M15.55 5.55 11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42 1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.48z";
const ICON_FLIP_H = "M15 21h2v-2h-2v2zm4-12h2V7h-2v2zM3 5v14c0 1.1.9 2 2 2h4v-2H5V5h4V3H5c-1.1 0-2 .9-2 2zm16-2v2h2c0-1.1-.9-2-2-2zm-8 20h2V1h-2v22zm8-6h2v-2h-2v2zM15 5h2V3h-2v2zm4 8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2z";
const ICON_FLIP_V = "M3 15v2h2v-2H3zm0-4v2h22v-2H3zm18-6v2h2V5h-2zm0 14c0 1.1-.9 2-2 2v-2h2zm0-10h2V7h-2v2zM1 11v2h2v-2H1zm2-6C3 3.9 3.9 3 5 3v2H3zm18 0v2h2c0-1.1-.9-2-2-2zM5 3h14v2H5V3zM3 19h2v2c-1.1 0-2-.9-2-2zm18 2v-2h2c0 1.1-.9 2-2 2z";
const ICON_RESIZE = "M21 15l-5 5H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2v9zm-2-8H5v12h10l4-4V7z";

export function Toolbar(p: Props) {
    /** Run a whole-canvas operation (rotate/flip) as one undo step. */
    const bake = (fn: (d: Doc) => Pick<Doc, "base" | "objects">) => {
        p.pushHistory();
        p.setDoc({ ...p.doc, ...fn(p.doc), selectedId: null });
    };
    return (
        <div className="vc-it-toolbar">
            {TOOL_ICONS.map(([id, label, iconPath]) => (
                <IconButton
                    key={id}
                    label={label}
                    path={iconPath}
                    selected={p.tool === id}
                    onClick={() => (id === "insert" ? p.onInsert() : p.setTool(id))}
                />
            ))}
            <div className="vc-it-spacer" />
            <IconButton label="Undo (Ctrl+Z)" path={ICON_UNDO} disabled={!p.canUndo} onClick={p.onUndo} />
            <IconButton label="Redo (Ctrl+Y)" path={ICON_REDO} disabled={!p.canRedo} onClick={p.onRedo} />
            <IconButton label="Start over (removes every edit)" path={ICON_RESET} onClick={p.onReset} />
            <div className="vc-it-divider" />
            <IconButton label="Rotate left" path={ICON_ROTATE_LEFT} onClick={() => bake(d => bakeRotate90(d.base, d.objects, -1))} />
            <IconButton label="Rotate right" path={ICON_ROTATE_RIGHT} onClick={() => bake(d => bakeRotate90(d.base, d.objects, 1))} />
            <IconButton label="Flip horizontally" path={ICON_FLIP_H} onClick={() => bake(d => bakeFlip(d.base, d.objects, "h"))} />
            <IconButton label="Flip vertically" path={ICON_FLIP_V} onClick={() => bake(d => bakeFlip(d.base, d.objects, "v"))} />
            <IconButton label="Resize image" path={ICON_RESIZE} onClick={() => void resizePrompt(p)} />
        </div>
    );
}
