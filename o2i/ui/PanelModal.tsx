/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useLayoutEffect, useRef } from "@webpack/common";

import { engineClient, isPluginRunning, usePluginRunning } from "../engineClient";
import { olog } from "../log";
import { Panel } from "./Panel";
import { logUiCrash } from "./uiErrors";

const cl = classNameFactory("vc-o2i-");

const MODAL_KEY = "vc-o2i-panel";

/** The expanded panel is open (one at a time). */
let expandedOpen = false;

/** How long Shrink keeps the panel counted open while the popout takes over (it takes its own hold on open). */
const SHRINK_HANDOFF_MS = 300;

/** Openers of mounted account-panel buttons' popouts (O2iButton registers one while mounted). */
const popoutOpeners = new Set<() => void>();

/** Called by O2iButton while it is mounted; returns the unregister function. */
export function registerPopoutOpener(open: () => void): () => void {
    popoutOpeners.add(open);
    return () => {
        popoutOpeners.delete(open);
    };
}

/** Opens the small popout from the most recently mounted account-panel button; false when there is none. */
function reopenPopout(): boolean {
    let open: (() => void) | undefined;
    for (const fn of popoutOpeners) open = fn;
    if (!open || !isPluginRunning()) return false;
    open();
    return true;
}

/**
 * Sizes Discord's modal container to 90vw, at most 1260 px so it hugs the 1200 px panel column (the
 * body's CSS sets the height), and hides the scrollbars of Discord's scrollers between the body and the
 * container (the body fits, so they never scroll).
 * Inline styles on purpose: this Discord build's Modal doesn't pass `className` to its container.
 * Returns false while the container isn't in the DOM yet.
 */
function fitModal(body: HTMLElement): boolean {
    const root = body.closest<HTMLElement>('[data-mana-component="modal"]');
    if (!root) return false;
    root.style.width = "min(90vw, 1260px)";
    root.style.maxWidth = "min(90vw, 1260px)";
    root.style.minWidth = "0";
    root.style.maxHeight = "calc(100vh - 32px)";
    for (let el = body.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === "auto" || overflowY === "scroll") el.style.setProperty("scrollbar-width", "none");
    }
    return true;
}

/** Discord's Modal with the fitted body and the panel. Rendered inside an ErrorBoundary (SafeExpandedPanel). */
function ExpandedPanel({ modalProps, running, onShrink }: { modalProps: RenderModalProps; running: boolean; onShrink(): void; }) {
    const { onClose } = modalProps;
    const body = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = body.current;
        if (!el || fitModal(el)) return;
        const id = requestAnimationFrame(() => {
            if (!fitModal(el)) olog.warn("expanded panel: Discord's modal container wasn't found; keeping its default size");
        });
        return () => cancelAnimationFrame(id);
    }, []);

    return (
        <Modal {...modalProps} size="xxl" title="o2i">
            <div className={cl("modal-body")} ref={body}>
                {running && (
                    <ErrorBoundary message="The o2i panel crashed. More info is in the console." onError={logUiCrash("the expanded panel")}>
                        <Panel onClose={onClose} onShrink={onShrink} expanded />
                    </ErrorBoundary>
                )}
            </div>
        </Modal>
    );
}

/** A crash here (e.g. Discord's Modal not found) shows an error card in the modal layer, never breaks it. */
const SafeExpandedPanel = ErrorBoundary.wrap(ExpandedPanel, {
    message: "The expanded o2i panel crashed. More info is in the console.",
    onError: logUiCrash("the expanded panel's modal"),
});

/**
 * The modal's bookkeeping, deliberately outside any ErrorBoundary so a crash below can't skip it:
 * the open-panel hold is released however the modal goes away, and the modal closes when the plugin stops.
 */
function ExpandedModal({ modalProps, release }: { modalProps: RenderModalProps; release(): void; }) {
    const { onClose } = modalProps;
    const running = usePluginRunning();

    // Release is idempotent (it also runs from the modal's onCloseCallback).
    useEffect(() => release, [release]);

    // Plugin turned off: the panel (and its Fix button) must not stay reachable.
    useEffect(() => {
        if (!running) onClose();
    }, [running, onClose]);

    // Shrink: close the modal and reopen the small popout. A short extra hold bridges the hand-off (the
    // modal's hold goes on close, the popout's comes when it opens). The popout opens after this click
    // has finished, so its outside-click handling can't catch the same click and close it again.
    const onShrink = () => {
        const bridge = engineClient.holdPanelOpen();
        onClose();
        setTimeout(() => {
            try {
                reopenPopout();
            } catch (e) {
                olog.error("couldn't reopen the o2i popout", e);
            } finally {
                setTimeout(bridge, SHRINK_HANDOFF_MS);
            }
        }, 0);
    };

    return <SafeExpandedPanel modalProps={modalProps} running={running} onShrink={onShrink} />;
}

/**
 * Opens the panel in a large centered modal. It counts as an open panel (audio runs, 50 ms polling)
 * from this call on, so the popout can close right after without a gap, until the modal closes.
 */
export function openPanelModal(): void {
    if (expandedOpen || !isPluginRunning()) return;
    expandedOpen = true;
    const hold = engineClient.holdPanelOpen();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        expandedOpen = false;
        hold();
    };
    try {
        openModal(props => <ExpandedModal modalProps={props} release={release} />, { modalKey: MODAL_KEY, onCloseCallback: release });
    } catch (e) {
        release();
        olog.error("couldn't open the expanded o2i panel", e);
    }
}
