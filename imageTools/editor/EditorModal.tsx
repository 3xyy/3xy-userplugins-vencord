/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { closeModal, openModal } from "@utils/modal";
import { CloudUpload } from "@vencord/discord-types";
import { Modal, showToast, useEffect, useMemo, useRef, useState } from "@webpack/common";
import { ComponentType } from "react";

import { DEFAULTS, EDIT_DOC_SYMBOL } from "../constants";
import { logger } from "../logger";
import { settings } from "../settings";
import { CanvasStage, StageApi, ZOOM_KEY_STEP } from "./CanvasStage";
import { insertRectInView, normRect, Rect } from "./geometry";
import { History } from "./history";
import { fileToCanvas } from "./loadImage";
import { cloneObjects, Doc, newId, Obj, Style, ToolId } from "./model";
import { OptionsStrip } from "./OptionsStrip";
import { promptText } from "./prompt";
import { legacyIntensity } from "./region";
import { clearRegionCache } from "./render";
import { SizeBar } from "./SizeBar";
import { Toolbar } from "./Toolbar";
import { bakeCrop } from "./transforms";

// cast: the editor renders Modal without the `title` its props type requires
const M = Modal as ComponentType<any>;

/** Input types you type text into. Checkboxes, radios, ranges, colour pickers and buttons aren't. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "password", "tel", "number"]);

/** True when a key event is meant for a text-entry control (text box, textarea, contenteditable). */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
    return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

const MODAL_SELECTOR = '[data-mana-component="modal"]';

/** True when a key event belongs to this editor: aimed inside its modal, not at a modal stacked on top. */
function isEditorTarget(target: EventTarget | null, root: HTMLElement | null): boolean {
    if (!root || !(target instanceof Node)) return false;
    const scope = root.closest<HTMLElement>(MODAL_SELECTOR) ?? root;
    if (scope.contains(target)) return true;
    // Focus fell back to <body>: ours unless another modal is open above the editor.
    if (target === document.body || target === document.documentElement) {
        const modals = document.querySelectorAll(MODAL_SELECTOR);
        return modals.length === 0 || modals[modals.length - 1] === scope;
    }
    return false;
}

/** Shared between the modal's close guard and the Save button: no closing while a save is in flight. */
export interface SaveState { saving: boolean; }

let lastTool: ToolId | null = null;
let lastStyle: Style | null = null;

/** Clone a canvas into a fresh, independent canvas (so later transforms don't mutate the original). */
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d")!.drawImage(src, 0, 0);
    return c;
}

/**
 * Blur and pixelate regions used to store their strength in plain pixels with no size basis. Convert
 * any such region once to the 1-100 scale, measured against the image it sits on, so it keeps about the
 * same look (see legacyIntensity). Docs only live in memory, so this only matters for a doc that
 * outlived a plugin update in the same session; it's a no-op for everything made by this version.
 */
function upgradeRegions(objs: Obj[], base: HTMLCanvasElement) {
    for (const o of objs) {
        if (o.type !== "blur" && o.type !== "pixelate") continue;
        if (o.ref && o.ref.w > 0 && o.ref.h > 0) continue;
        o.intensity = legacyIntensity(o.type, o.intensity, base.width, base.height);
        o.ref = { w: base.width, h: base.height };
    }
}

/**
 * Decode a picked file for Insert. A bitmap bigger than twice the base image on either side is shrunk
 * (aspect kept) to cap memory: it can never be shown larger than that without being upscaled anyway.
 */
async function decodeInsert(file: File, baseW: number, baseH: number): Promise<ImageBitmap> {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, (baseW * 2) / bmp.width, (baseH * 2) / bmp.height);
    if (k >= 1) return bmp;
    try {
        return await createImageBitmap(bmp, {
            resizeWidth: Math.max(1, Math.round(bmp.width * k)),
            resizeHeight: Math.max(1, Math.round(bmp.height * k)),
            resizeQuality: "high"
        });
    } finally {
        bmp.close();
    }
}

/** Full-image rect inset by ~8% so crop handles are visible from the start. */
function insetCropRect(base: HTMLCanvasElement): Rect {
    const ix = base.width * 0.08, iy = base.height * 0.08;
    return { x: ix, y: iy, w: base.width - ix * 2, h: base.height - iy * 2 };
}

export async function openEditor(upload: CloudUpload) {
    try {
        if (!(upload as any)[EDIT_DOC_SYMBOL] && upload.item.file.type === "image/gif") {
            showToast({ text: "Editing a GIF turns it into a still image." });
        }
        const stashed: Doc | undefined = (upload as any)[EDIT_DOC_SYMBOL];
        const base = stashed ? stashed.base : await fileToCanvas(upload.item.file);
        logger.debug("editor opening:", base.width, "x", base.height, stashed ? "(re-edit)" : "(new)");
        // Re-edit works on a copy of the stashed objects: edits mutate objects in place, and a Cancel
        // must leave the stash matching the file that's actually attached.
        const initial: Doc = stashed
            ? { base: stashed.base, objects: cloneObjects(stashed.objects), selectedId: null }
            : { base, objects: [], selectedId: null };
        upgradeRegions(initial.objects, initial.base);
        const save: SaveState = { saving: false };
        const key = openModal(modalProps => <EditorModal modalProps={modalProps} upload={upload} initialDoc={initial} save={save} />, {
            // Escape / backdrop click: ignored mid-save (the upload would still be replaced after the editor vanished)
            onCloseRequest: () => { if (!save.saving) closeModal(key); }
        });
    } catch (e) {
        logger.error("openEditor failed:", e);
        showToast({ text: "ImageTools couldn't open the editor. The console has details.", variant: "critical" });
    }
}

function EditorModal({ modalProps, upload, initialDoc, save }: { modalProps: any; upload: CloudUpload; initialDoc: Doc; save: SaveState; }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [doc, setDoc] = useState<Doc>(initialDoc);
    const [tool, setTool] = useState<ToolId>(() => (settings.store.rememberLastTool ? (lastTool ?? "select") : "select"));
    const [style, setStyle] = useState<Style>(lastStyle ?? {
        color: settings.store.defaultBrushColor, width: settings.store.defaultBrushWidth,
        fill: false, fontSize: DEFAULTS.fontSize, blurIntensity: DEFAULTS.blurIntensity, pixelIntensity: DEFAULTS.pixelIntensity,
    });
    // Lazy initialisers: `useRef(expr)` would evaluate expr (a full-size canvas copy!) on every render.
    const [history] = useState(() => new History());
    // opening on the Crop tool (remembered from last time) starts with a crop box, like picking the tool does
    const [cropRect, setCropRect] = useState<Rect | null>(() => (tool === "crop" ? insetCropRect(initialDoc.base) : null));
    // the ORIGINAL base canvas at open, cloned once so transforms can't mutate it (used by Reset)
    const [originalBase] = useState(() => cloneCanvas(initialDoc.base));
    const stageApi = useRef<StageApi | null>(null);
    const [zoom, setZoom] = useState(1);
    const rerender = () => setDoc(d => ({ ...d }));
    // for async work that finishes later (Insert's decode): the latest doc, and whether the editor is still open
    const docRef = useRef(doc);
    docRef.current = doc;
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    // remember last-used style across editor opens
    useEffect(() => { lastStyle = style; }, [style]);
    // the cached blur/pixelate bitmaps hold image-sized canvases: let them go with the editor
    useEffect(() => () => clearRegionCache(), []);

    function pushHistory() { history.push(doc); }
    function mutate(fn: (d: Doc) => void) { history.push(doc); setDoc(d => { const nd = { ...d, objects: [...d.objects] }; fn(nd); return nd; }); }

    const selectTool = (t: ToolId) => {
        lastTool = t;
        setTool(t);
        if (t !== "crop") setCropRect(null);
        else setCropRect(r => r ?? insetCropRect(doc.base));
    };

    /** Insert button: ask for an image file, decode it and place it in the middle of what's on screen. */
    function onInsert() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            let img: ImageBitmap;
            try {
                const { base } = docRef.current;
                img = await decodeInsert(file, base.width, base.height);
            } catch (e) {
                logger.warn("insert image failed:", e);
                if (alive.current) showToast({ text: "Couldn't open that file as an image.", variant: "critical" });
                return;
            }
            // the editor was closed while the file decoded: nothing to add it to
            if (!alive.current) { img.close(); return; }
            const cur = docRef.current, { base } = cur;
            const view = stageApi.current?.visibleRect() ?? { x: 0, y: 0, w: base.width, h: base.height };
            const rect = insertRectInView(img.width, img.height, base.width, base.height, view);
            const o: Obj = { id: newId(), type: "image", img, rect, rot: 0, flip: false };
            history.push(cur);
            setDoc(d => ({ ...d, objects: [...d.objects, o], selectedId: o.id }));
            selectTool("select");
        };
        input.click();
    }

    function onReset() {
        pushHistory();
        setDoc({ base: cloneCanvas(originalBase), objects: [], selectedId: null });
        setCropRect(null);
    }

    function applyCrop() {
        if (!cropRect) return;
        // a crop that rounds to 0 px wide/high would leave an empty canvas that can't be saved
        const n = normRect(cropRect);
        if (Math.round(n.w) < 1 || Math.round(n.h) < 1) {
            showToast({ text: "The crop area is too small.", variant: "critical" });
            return;
        }
        pushHistory();
        const r = bakeCrop(doc.base, doc.objects, cropRect);
        setDoc({ ...doc, ...r, selectedId: null });
        selectTool("select"); // also drops the crop box
    }
    const selected = useMemo(() => doc.objects.find(o => o.id === doc.selectedId) ?? null, [doc]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            // Only keys aimed at the editor itself: not at a modal stacked on top (e.g. Discord's
            // "file too large" dialog), and not at a text box (resize/text prompt, number boxes, colour
            // hex field), where Backspace/Delete must edit the text and Ctrl+Z must undo typing.
            if (!isEditorTarget(e.target, rootRef.current) || isTypingTarget(e.target)) return;
            if (e.key === "Delete" || e.key === "Backspace") {
                if (doc.selectedId) { e.preventDefault(); mutate(d => { d.objects = d.objects.filter(o => o.id !== d.selectedId); d.selectedId = null; }); }
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
                e.preventDefault(); const s = history.undo(doc); if (s) setDoc({ base: s.base, objects: s.objects, selectedId: null });
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
                e.preventDefault(); const s = history.redo(doc); if (s) setDoc({ base: s.base, objects: s.objects, selectedId: null });
            } else if (e.key === "Escape") {
                setDoc(d => ({ ...d, selectedId: null }));
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [doc]);

    // View keys: Ctrl+0 fits, Ctrl+= / Ctrl+- zoom, Space held pans. Same target rules as above.
    useEffect(() => {
        function onViewKey(e: KeyboardEvent) {
            const stage = stageApi.current;
            if (!stage || !isEditorTarget(e.target, rootRef.current) || isTypingTarget(e.target)) return;
            if (e.ctrlKey || e.metaKey) {
                if (e.altKey) return;
                if (e.key === "0" || e.code === "Numpad0") stage.fit();
                else if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") stage.zoomBy(ZOOM_KEY_STEP);
                else if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") stage.zoomBy(1 / ZOOM_KEY_STEP);
                else return;
                // capture phase + stopPropagation: inside the editor these zoom the image, not Discord
                e.preventDefault();
                e.stopPropagation();
            } else if (e.key === " " && !e.altKey && !e.shiftKey && stage.setSpace(true)) {
                e.preventDefault(); // no page scroll, no click on a focused button
            }
        }
        // Space up anywhere ends Space-panning, even if focus moved while it was held
        function onKeyUp(e: KeyboardEvent) {
            if (e.key === " " && stageApi.current?.setSpace(false)) e.preventDefault();
        }
        const onBlur = () => stageApi.current?.setSpace(false);
        window.addEventListener("keydown", onViewKey, true);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onViewKey, true);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };
    }, []);

    return (
        <M {...modalProps} size="xxl" onClose={() => { if (!save.saving) modalProps.onClose(); }}>
            {/* tabIndex -1: clicking the (unfocusable) canvas focuses the editor, so its shortcuts apply */}
            <div className="vc-it-root" ref={rootRef} tabIndex={-1}>
                <Toolbar
                    tool={tool} setTool={selectTool} onInsert={onInsert}
                    canUndo={history.canUndo()} canRedo={history.canRedo()}
                    onUndo={() => { const s = history.undo(doc); if (s) setDoc({ base: s.base, objects: s.objects, selectedId: null }); }}
                    onRedo={() => { const s = history.redo(doc); if (s) setDoc({ base: s.base, objects: s.objects, selectedId: null }); }}
                    doc={doc} setDoc={setDoc} pushHistory={pushHistory}
                    onReset={onReset}
                />
                <OptionsStrip tool={tool} style={style} setStyle={setStyle} selected={selected}
                    onChangeSelected={() => { rerender(); }} pushHistory={pushHistory}
                    cropRect={cropRect} onApplyCrop={applyCrop} onCancelCrop={() => selectTool("select")} />
                <CanvasStage
                    doc={doc} tool={tool} style={style}
                    onCommit={obj => mutate(d => { d.objects.push(obj); d.selectedId = null; })}
                    onMutate={() => rerender()}
                    onSelect={id => setDoc(d => ({ ...d, selectedId: id }))}
                    onTextRequest={async pt => {
                        const text = await promptText({ title: "Add text", placeholder: "Your text", confirmText: "Add" });
                        if (!text) return;
                        mutate(d => {
                            const o: Obj = { id: newId(), type: "text", pos: pt, text, color: style.color, size: style.fontSize };
                            d.objects.push(o); d.selectedId = o.id;
                        });
                    }}
                    onErase={id => mutate(d => { d.objects = d.objects.filter(o => o.id !== id); d.selectedId = null; })}
                    pushHistory={pushHistory}
                    cropRect={cropRect} setCropRect={setCropRect}
                    apiRef={stageApi} onZoomChange={setZoom}
                />
                <SizeBar doc={doc} upload={upload} modalProps={modalProps} save={save} zoom={zoom} onFit={() => stageApi.current?.fit()} />
            </div>
        </M>
    );
}
