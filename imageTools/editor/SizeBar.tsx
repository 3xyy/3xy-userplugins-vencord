/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { CloudUpload } from "@vencord/discord-types";
import { showToast, Tooltip, useEffect, useState } from "@webpack/common";

import { SIZE_PRESETS_MB } from "../constants";
import { settings } from "../settings";
import type { SaveState } from "./EditorModal";
import { encodeToFit, estimateSize, extFor, PreferredFormat, SaveFormat, stripExtension } from "./encode";
import { Doc } from "./model";
import { isDraftFull, MAX_ATTACHMENTS, replaceUpload } from "./replaceUpload";

const fmtMB = (b: number) => (b / 1024 / 1024).toFixed(2) + " MB";

/** View zoom as a percentage: "100%", "1600%", or "7.5%" for huge images fitted below 10%. */
function fmtZoom(scale: number): string {
    const pct = scale * 100;
    return (pct < 10 ? String(Math.round(pct * 10) / 10) : String(Math.round(pct))) + "%";
}

/** "Match source": keep JPEG as JPEG and WebP as WebP; everything else (PNG, GIF, ...) saves as PNG. */
function resolveFormat(fmt: SaveFormat, sourceType: string | undefined): PreferredFormat {
    if (fmt === "webp") return "webp";
    if (fmt === "match") {
        if (sourceType === "image/jpeg") return "jpeg";
        if (sourceType === "image/webp") return "webp";
    }
    return "png";
}

export function SizeBar({ doc, upload, modalProps, save, zoom, onFit }: { doc: Doc; upload: CloudUpload; modalProps: any; save: SaveState; zoom: number; onFit(): void; }) {
    const fmt = settings.store.defaultSaveFormat as SaveFormat;
    const preferred = resolveFormat(fmt, upload.item?.file?.type);
    const [limitMB, setLimitMB] = useState<number>(settings.store.defaultSizeLimitMB);
    const [size, setSize] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    // Starts as the attached file's name. A saved edit is attached under the typed name, so opening the
    // editor on it again starts from that name.
    const [name, setName] = useState(() => stripExtension(upload.filename ?? ""));
    // a size-limit setting that isn't one of the presets still shows (and stays selectable)
    const limitOptions = SIZE_PRESETS_MB.includes(limitMB) ? SIZE_PRESETS_MB : [...SIZE_PRESETS_MB, limitMB].sort((a, b) => (a || Infinity) - (b || Infinity));

    // debounced live estimate
    useEffect(() => {
        let cancelled = false;
        setSize(null);
        const h = setTimeout(async () => {
            try {
                const b = await estimateSize(doc, preferred);
                if (!cancelled) setSize(b);
            } catch {
                if (!cancelled) setSize(null);
            }
        }, 500);
        return () => { cancelled = true; clearTimeout(h); };
    }, [doc, preferred]);

    const limitBytes = limitMB > 0 ? limitMB * 1024 * 1024 : 0;
    const over = size != null && limitBytes > 0 && size > limitBytes;
    // Over the limit, Save falls back to WebP to fit (encodeToFit), so the name box shows that extension.
    const ext = over ? "webp" : extFor(preferred);

    async function onSave() {
        // The original keeps its slot until the edited copy is in, so a full draft can never take the copy.
        if (isDraftFull(upload)) {
            showToast({ text: `This message already has ${MAX_ATTACHMENTS} attachments, which is Discord's limit. Remove one, then save again.`, variant: "critical" });
            return;
        }
        setSaving(true);
        save.saving = true; // blocks closing the editor (Cancel, Escape, backdrop) until this finishes
        let added: File | null = null;
        try {
            const res = await encodeToFit(doc, preferred, limitBytes);
            const mime = `image/${res.format}`;
            added = await replaceUpload(upload, res.blob, extFor(res.format), mime, doc, name);
            if (!added) showToast({ text: "Discord didn't take the edited image, probably because it's over your upload limit. Your original is still attached.", variant: "critical" });
        } catch {
            showToast({ text: "Couldn't save the edited image. Your original is still attached.", variant: "critical" });
        } finally {
            save.saving = false;
            setSaving(false);
        }
        if (added) modalProps.onClose();
    }

    return (
        <div className="vc-it-sizebar">
            <label className="vc-it-name">
                <input
                    className="vc-it-name-input"
                    type="text"
                    value={name}
                    placeholder="image"
                    aria-label="File name"
                    maxLength={100}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={saving}
                    onChange={e => setName(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                <Tooltip text="Over the size limit, so it saves as WebP" shouldShow={over}>
                    {tooltipProps => <span {...tooltipProps} className="vc-it-name-ext">.{ext}</span>}
                </Tooltip>
            </label>
            <span className={"vc-it-size" + (over ? " over" : "")}>
                {preferred.toUpperCase()} · {size == null ? "estimating…" : "~" + fmtMB(size)}{limitMB > 0 ? ` / ${limitMB} MB` : ""}
            </span>
            <Tooltip text="Size limit">
                {tooltipProps => (
                    <select {...tooltipProps} className="vc-it-limit" aria-label="Size limit" value={limitMB} onChange={e => setLimitMB(Number(e.currentTarget.value))}>
                        {limitOptions.map(mb => <option key={mb} value={mb}>{mb === 0 ? "No limit" : mb + " MB"}</option>)}
                    </select>
                )}
            </Tooltip>
            <Tooltip text="Click to fit the image (Ctrl+0). Zoom with Ctrl+scroll. Pan with the middle mouse button or Space+drag.">
                {tooltipProps => (
                    <button
                        {...tooltipProps}
                        type="button"
                        className="vc-it-tool vc-it-zoom"
                        aria-label="Zoom, click to fit"
                        onClick={() => { tooltipProps.onClick(); onFit(); }}
                    >
                        {fmtZoom(zoom)}
                    </button>
                )}
            </Tooltip>
            <div className="vc-it-spacer" />
            <Button variant="secondary" size="small" disabled={saving} onClick={() => modalProps.onClose()}>Cancel</Button>
            <Button variant="primary" size="small" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</Button>
        </div>
    );
}
