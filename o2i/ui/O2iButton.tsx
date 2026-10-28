/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { filters, find, findComponentByCodeLazy } from "@webpack";
import { Popout, Slider, TabBar, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentType, RefObject } from "react";

import { engineClient, useMicMuted, useMicOpen, usePluginRunning } from "../engineClient";
import { olog } from "../log";
import { isPttMode } from "../logic/profile";
import { usePowered } from "../power";
import { settings } from "../settings";
import type { EngineSnapshot } from "../types";
import { Panel } from "./Panel";
import { openPanelModal, registerPopoutOpener } from "./PanelModal";
import { logUiCrash } from "./uiErrors";
import { useEngineValue } from "./useEngineValue";

const cl = classNameFactory("vc-o2i-");

/** Discord's account-panel (mute / deafen) button, found the same way as in Vencord's GameActivityToggle. */
const ACCOUNT_BUTTON_CODE = ".GREEN,positionKeyStemOverride:";

/** What Discord's account-panel button passes to `icon` (it renders `<icon width height size colorClass color />`). */
interface IconProps {
    width?: number;
    height?: number;
}

interface AccountPanelButtonProps {
    tooltipText: string;
    tooltipShouldShow?: boolean;
    icon: ComponentType<IconProps>;
    plated?: boolean;
    onClick(): void;
    ref?: RefObject<HTMLButtonElement | null>;
}

const AccountPanelButton = findComponentByCodeLazy<AccountPanelButtonProps>(ACCOUNT_BUTTON_CODE);

/** The muted mark: a slash from top left to bottom right, with a gap cut around it in the icon. */
const MUTE_SLASH = "M3 2.5 21.5 21";
/** Numbers each icon's mask id, so several icons on the page never share one. */
let maskSeq = 0;

/** A microphone with a sound wave; `muted` adds a red slash. */
function O2iSvg({ width = 20, height = 20, fill, opacity, muted, closed }: IconProps & { fill: string; opacity?: number; muted?: boolean; closed?: boolean; }) {
    const [maskId] = useState(() => `vc-o2i-mute-mask-${++maskSeq}`);
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" opacity={opacity} aria-hidden="true">
            {muted && (
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                    <rect width="24" height="24" fill="white" />
                    <path d={MUTE_SLASH} stroke="black" strokeWidth="5" strokeLinecap="round" />
                </mask>
            )}
            <g mask={muted ? `url(#${maskId})` : undefined}>
                <path fill={fill} d="M9 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path fill={fill} d="M4 10a1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V19H6a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 16 10a1 1 0 1 0-2 0 5 5 0 0 1-10 0Z" />
                <path fill={fill} d="M19.5 6.2a1 1 0 0 1 1.4.1 7 7 0 0 1 0 8.4 1 1 0 1 1-1.5-1.3 5 5 0 0 0 0-5.8 1 1 0 0 1 .1-1.4Z" />
            </g>
            {muted && <path d={MUTE_SLASH} stroke={closed ? "currentColor" : "var(--status-danger, #da373c)"} strokeWidth="2.2" strokeLinecap="round" />}
        </svg>
    );
}

// Stable components (not one built per render) so the button never remounts its icon.
const HealthyIcon = (p: IconProps) => <O2iSvg {...p} fill="currentColor" />;
const DownIcon = (p: IconProps) => <O2iSvg {...p} fill="var(--status-danger, #da373c)" />;
/** Turned off with the power button: dimmed, never red (off is intentional). */
const OffIcon = (p: IconProps) => <O2iSvg {...p} fill="currentColor" opacity={0.4} />;
/** o2i's mic is muted (apps and sounds still play). */
const MutedIcon = (p: IconProps) => <O2iSvg {...p} fill="currentColor" muted />;
/** Push to talk with the key not held: the mic is closed. */
const ClosedIcon = (p: IconProps) => <O2iSvg {...p} fill="currentColor" muted closed />;
const DownMutedIcon = (p: IconProps) => <O2iSvg {...p} fill="var(--status-danger, #da373c)" muted />;

/** Engine not running, or running with its audio in error (audio "off" outside a call is normal). */
const selectUnhealthy = (s: EngineSnapshot) => s.status !== "running" || s.state?.audio === "error";

function PopoutBody({ onClose }: { onClose(): void; }) {
    // The modal is counted as open before the popout closes, so audio and fast polling carry straight over.
    const expand = () => {
        openPanelModal();
        onClose();
    };
    return (
        <div className={cl("popout")} role="dialog" aria-label="o2i">
            <ErrorBoundary message="The o2i panel crashed. More info is in the console." onError={logUiCrash("the popout panel")}>
                <Panel onClose={onClose} onExpand={expand} />
            </ErrorBoundary>
        </div>
    );
}

/**
 * The account-panel patch stays applied after the plugin is disabled (until a restart): render nothing
 * then, so neither the button nor its panel (with the Fix button) is reachable.
 */
function O2iButtonInner(props: { nameplate?: unknown; }) {
    return usePluginRunning() ? <O2iButtonBody {...props} /> : null;
}

function O2iButtonBody({ nameplate }: { nameplate?: unknown; }) {
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const [show, setShow] = useState(false);
    // A boolean selector: the account panel re-renders only when health flips, not on every poll.
    const unhealthy = useEngineValue(selectUnhealthy);
    const powered = usePowered();
    // Only while on: turned off, o2i's mic isn't in use (the mute is kept for the next power on).
    const muted = useMicMuted() && powered;
    // Push to talk: open / closed. In "always" mode the button looks as it always has.
    const ptt = isPttMode(settings.use(["profile"]).profile) && powered;
    const micOpen = useMicOpen();
    const closed = micOpen === false && ptt && !muted;

    useEffect(() => {
        noteButtonRendered();
    }, []);

    // Lets the expanded modal's Shrink reopen this popout while the button is mounted.
    useEffect(() => registerPopoutOpener(() => setShow(true)), []);

    // Open popout ⇒ audio runs and polling is 50 ms. The release runs on close and on unmount while
    // open; an instance that was never opened never holds the panel open.
    useEffect(() => {
        if (!show) return;
        return engineClient.holdPanelOpen();
    }, [show]);

    return (
        <Popout
            position="top"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => <PopoutBody onClose={() => setShow(false)} />}
        >
            {(_, { isShown }) => (
                <AccountPanelButton
                    ref={buttonRef}
                    tooltipText={!powered ? "o2i (off)" : muted ? "o2i (mic muted)" : ptt ? (micOpen === null || unhealthy ? "o2i (push to talk)" : closed ? "o2i (push to talk, mic closed)" : "o2i (push to talk, mic open)") : "o2i"}
                    tooltipShouldShow={!isShown}
                    icon={!powered ? OffIcon : unhealthy ? (muted ? DownMutedIcon : DownIcon) : muted ? MutedIcon : closed ? ClosedIcon : HealthyIcon}
                    plated={nameplate != null}
                    onClick={() => setShow(v => !v)}
                />
            )}
        </Popout>
    );
}

/** Mounted by the account-panel patch (`$self.O2iButton(arguments[0])`); any error hides only the button. */
export const O2iButton = ErrorBoundary.wrap(O2iButtonInner, { noop: true, onError: logUiCrash("the account-panel button") });

// ---- startup UI self-check ----

/** After the button first mounts the UI is up, so report soon; if it never mounts, report that. */
const UI_CHECK_AFTER_RENDER_MS = 1000;
const UI_CHECK_FALLBACK_MS = 20000;

let buttonRendered = false;
let uiCheckTimer: ReturnType<typeof setTimeout> | null = null;

function noteButtonRendered() {
    if (buttonRendered) return;
    buttonRendered = true;
    if (uiCheckTimer) armUiCheck(UI_CHECK_AFTER_RENDER_MS); // a check is pending: run it now rather than at the fallback
}

/**
 * Vencord's waitForComponent copies the found component's statics onto its wrapper, so a static this
 * plugin relies on being present means the component resolved. The wrapper's getter is never called
 * here: before Discord's module has loaded it would cache a permanent miss for every plugin.
 */
function hasStatic(component: object, key: string): string {
    return key in component ? "ok" : "missing";
}

function uiSelfCheck() {
    try {
        // A plain module search: unlike the lazy finder it caches nothing and logs nothing on a miss.
        const button = find(filters.componentByCode(ACCOUNT_BUTTON_CODE), { isIndirect: true }) ? "found" : "missing";
        const patch = buttonRendered
            ? "rendered the o2i button"
            : `has not rendered the o2i button ${UI_CHECK_FALLBACK_MS / 1000} s after start`;
        olog.info(`ui self-check: account-panel patch ${patch}, Button=${button}, `
            + `Popout=${hasStatic(Popout, "Animation")}, TabBar=${hasStatic(TabBar, "Item")}, Slider=${hasStatic(Slider, "defaultProps")}`);
    } catch (e) {
        olog.error("ui self-check failed", e);
    }
}

function armUiCheck(ms: number) {
    cancelUiSelfCheck();
    uiCheckTimer = setTimeout(() => {
        uiCheckTimer = null;
        uiSelfCheck();
    }, ms);
}

/** Read-only, once per plugin start. */
export function scheduleUiSelfCheck(): void {
    armUiCheck(buttonRendered ? UI_CHECK_AFTER_RENDER_MS : UI_CHECK_FALLBACK_MS);
}

export function cancelUiSelfCheck(): void {
    if (uiCheckTimer) clearTimeout(uiCheckTimer);
    uiCheckTimer = null;
}
