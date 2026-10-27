/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, Menu, SelectedChannelStore, showToast } from "@webpack/common";

import ExportHistory from "./ExportHistory";
import { openExportMenu, openServerExportModal, openSingleExportModal } from "./ExportModal";
import { setNativeModule } from "./mediaHandler";
import managedStyle from "./styles.css?managed";
import { ExportQueueEntry, FileExistsBehavior, MediaMode } from "./types";

const Native = VencordNative.pluginHelpers.ExportChat as PluginNative<typeof import("./native")>;
setNativeModule(Native);

const settings = definePluginSettings({
    defaultMediaMode: {
        type: OptionType.SELECT,
        description: "What exports do with images, videos and files unless you pick something else",
        options: [
            { label: "Link to Discord's CDN (links can expire)", value: MediaMode.CDN, default: true },
            { label: "Embed in the file (works offline, bigger file)", value: MediaMode.BASE64 },
            { label: "Upload to catbox.moe (public, permanent)", value: MediaMode.CATBOX },
        ],
    },
    catboxUserhash: {
        type: OptionType.STRING,
        description: "Your catbox.moe userhash, so catbox uploads show up in your account. Optional.",
        default: "",
    },
    saveLocation: {
        type: OptionType.STRING,
        description: "Folder to save exports in. Leave it empty to download them through the browser instead.",
        default: "",
    },
    fileExistsBehavior: {
        type: OptionType.SELECT,
        description: "When a file with the same name is already in the folder",
        options: [
            { label: "Add a number to the new file's name (_2, _3, ...)", value: FileExistsBehavior.INCREMENT, default: true },
            { label: "Replace the old file", value: FileExistsBehavior.OVERWRITE },
        ],
    },
    cfApiToken: {
        type: OptionType.STRING,
        description: "Cloudflare API token with Pages edit permission, used to share exports online. Sharing stays off until the token, account ID and project are all set. Needs Node.js (npx).",
        default: "",
    },
    cfAccountId: {
        type: OptionType.STRING,
        description: "Cloudflare account ID (32 hex characters)",
        default: "",
    },
    cfPagesProject: {
        type: OptionType.STRING,
        description: "Name of an existing Cloudflare Pages project (lowercase letters, digits and hyphens). Each share goes to its own random preview branch, never to production. Anyone with the link can open a share, so use a password for private chats.",
        default: "",
    },
});

// ===== Export Queue =====
// Persistent across channel switches, modal open/close, etc.

function getQueue(): ExportQueueEntry[] {
    if (!(window as any).__ecQueue) (window as any).__ecQueue = [];
    return (window as any).__ecQueue;
}

function getSelections(): Map<string, { highlight: Set<string>; hide: Set<string>; }> {
    if (!(window as any).__ecSelections) (window as any).__ecSelections = new Map();
    return (window as any).__ecSelections;
}

function addToQueue(entry: ExportQueueEntry) {
    const q = getQueue();
    // Don't add duplicates
    const exists = q.find(e => e.channelId === entry.channelId && e.type === entry.type && e.rangeStartId === entry.rangeStartId);
    if (exists) { showToast({ text: "That's already in the export queue." }); return; }
    q.push(entry);
    showToast({ text: `Added ${entry.channelName} to the export queue (${q.length} item${q.length > 1 ? "s" : ""}).`, variant: "success" });
}

function getChannelDisplayName(channelId: string): string {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return "Unknown";
    if (ch.type === 1) {
        // DM: the other person's name
        const recipients = (ch as any).recipients || [];
        if (recipients.length > 0) {
            const user = (window as any).Vencord?.Webpack?.Common?.UserStore?.getUser(recipients[0]);
            return user?.globalName || user?.username || "DM";
        }
        return ch.name || "DM";
    }
    if (ch.type === 3) {
        // Group DM: its name, or how many people are in it
        if (ch.name) return ch.name;
        const recipients = (ch as any).recipients || [];
        return recipients.length > 0 ? `Group (${recipients.length + 1})` : "Group Chat";
    }
    return ch.name || "Channel";
}

function hasQueue(): boolean { return getQueue().length > 0; }

/** Drops highlighted/hidden messages, "Select in Chat" mode and the saved form state (keeps the queue and range). */
function clearSelections() {
    (window as any).__ecSelections = new Map();
    (window as any).__ecSelectingActive = false;
    document.querySelectorAll(".vc-export-sel-highlight, .vc-export-sel-hide").forEach(el => {
        el.classList.remove("vc-export-sel-highlight", "vc-export-sel-hide");
    });
    delete (window as any).__ecLastClicked;
    delete (window as any).__ecSingleExportState;
    delete (window as any).__ecSelectingFrom;
}

function clearAll() {
    clearSelections();
    (window as any).__ecQueue = [];
    document.querySelectorAll(".vc-export-range-start, .vc-export-range-end").forEach(el => {
        el.classList.remove("vc-export-range-start", "vc-export-range-end");
    });
    delete (window as any).__ecRangeStart;
    delete (window as any).__ecRangeEnd;
}

// ===== Message highlight / hide (always on) =====

function findMsgElement(msgId: string): HTMLElement | null {
    return document.querySelector(`[id$="-${msgId}"]`) as HTMLElement;
}

function getCurrentChannelSets(): { highlight: Set<string>; hide: Set<string>; } {
    const chId = SelectedChannelStore.getChannelId();
    const sel = getSelections();
    if (!sel.has(chId)) sel.set(chId, { highlight: new Set(), hide: new Set() });
    return sel.get(chId)!;
}

/** True if any channel has a highlighted or hidden message (empty per-channel entries don't count). */
function hasAnySelection(): boolean {
    for (const s of getSelections().values()) if (s.highlight.size || s.hide.size) return true;
    return false;
}

function getMsgState(msgId: string): "none" | "highlight" | "hide" {
    const s = getSelections().get(SelectedChannelStore.getChannelId());
    if (s?.highlight.has(msgId)) return "highlight";
    if (s?.hide.has(msgId)) return "hide";
    return "none";
}

function setMsgState(msgId: string, state: "none" | "highlight" | "hide") {
    const s = getCurrentChannelSets();
    s.highlight.delete(msgId); s.hide.delete(msgId);
    if (state === "highlight") s.highlight.add(msgId);
    else if (state === "hide") s.hide.add(msgId);
}

function updateVisual(msgId: string) {
    const el = findMsgElement(msgId);
    if (!el) return;
    el.classList.remove("vc-export-sel-highlight", "vc-export-sel-hide");
    const s = getMsgState(msgId);
    if (s === "highlight") el.classList.add("vc-export-sel-highlight");
    else if (s === "hide") el.classList.add("vc-export-sel-hide");
}

function reapplyVisuals() {
    document.querySelectorAll(".vc-export-sel-highlight, .vc-export-sel-hide").forEach(el => {
        el.classList.remove("vc-export-sel-highlight", "vc-export-sel-hide");
    });
    // Range markers are redrawn too, even when nothing is highlighted/hidden
    if (!hasAnySelection() && !(window as any).__ecRangeStart) return;
    setTimeout(() => {
        const s = getSelections().get(SelectedChannelStore.getChannelId());
        s?.highlight.forEach(id => { const el = findMsgElement(id); if (el) el.classList.add("vc-export-sel-highlight"); });
        s?.hide.forEach(id => { const el = findMsgElement(id); if (el) el.classList.add("vc-export-sel-hide"); });
        // Reapply range bounds
        const rs = (window as any).__ecRangeStart;
        const re = (window as any).__ecRangeEnd;
        if (rs) { const el = findMsgElement(rs); if (el) el.classList.add("vc-export-range-start"); }
        if (re) { const el = findMsgElement(re); if (el) el.classList.add("vc-export-range-end"); }
    }, 400);
}

function getOrderedIds(): string[] {
    const ids: string[] = [], seen = new Set<string>();
    document.querySelectorAll('[id^="chat-messages-"]').forEach(el => {
        const parts = el.id.split("-");
        const msgId = parts[parts.length - 1];
        if (msgId?.length >= 17 && !seen.has(msgId)) { seen.add(msgId); ids.push(msgId); }
    });
    return ids;
}

function fillRange(fromId: string, toId: string, state: "highlight" | "hide") {
    const ids = getOrderedIds();
    const a = ids.indexOf(fromId), b = ids.indexOf(toId);
    if (a === -1 || b === -1) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { setMsgState(ids[i], state); updateVisual(ids[i]); }
}

// Message click: cycles highlight / hide while "Select in Chat" is on or a selection is waiting to be exported
import { addMessageClickListener, removeMessageClickListener } from "@api/MessageEvents";

function onMessageClick(msg: any, _channel: any, event: MouseEvent) {
    // Only intercept while selecting, or while highlighted/hidden messages are waiting to be exported
    if (!(window as any).__ecSelectingActive && !hasAnySelection()) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    const msgId = msg.id;
    if (!msgId) return;

    const cur = getMsgState(msgId);
    const next = cur === "none" ? "highlight" : cur === "highlight" ? "hide" : "none";
    setMsgState(msgId, next);
    updateVisual(msgId);
    (window as any).__ecLastClicked = msgId;
}

function onChannelSelect() {
    setTimeout(() => reapplyVisuals(), 400);
}

// ===== Range bounds =====

function setRangeStart(msgId: string) {
    document.querySelectorAll(".vc-export-range-start, .vc-export-range-end").forEach(el => el.classList.remove("vc-export-range-start", "vc-export-range-end"));
    delete (window as any).__ecRangeEnd;
    (window as any).__ecRangeStart = msgId;
    const el = findMsgElement(msgId);
    if (el) el.classList.add("vc-export-range-start");
    showToast({ text: "Range start set. Right-click another message to set the end." });
}

function setRangeEnd(msgId: string) {
    (window as any).__ecRangeEnd = msgId;

    // Normalize: always put "start" class on the OLDER message (smaller ID) and "end" on NEWER
    const startId = (window as any).__ecRangeStart;
    const endId = msgId;
    if (startId && BigInt(startId) > BigInt(endId)) {
        // The newer message was picked first: swap the markers
        document.querySelectorAll(".vc-export-range-start").forEach(el => el.classList.remove("vc-export-range-start"));
        const olderEl = findMsgElement(endId);
        const newerEl = findMsgElement(startId);
        if (olderEl) olderEl.classList.add("vc-export-range-start");
        if (newerEl) newerEl.classList.add("vc-export-range-end");
    } else {
        const el = findMsgElement(msgId);
        if (el) el.classList.add("vc-export-range-end");
    }
    showToast({ text: "Range set. Right-click a message and choose Add Range to Queue.", variant: "success" });
}

// ===== Context menus =====

const channelMenu: NavContextMenuPatchCallback = (children, props) => {
    const { channel } = props;
    if (!channel) return;
    const name = getChannelDisplayName(channel.id);
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-ec-export" label="Export Chat" action={() => openSingleExportModal(channel.id, settings)} />
            <Menu.MenuItem id="vc-ec-add" label="Add to Export Queue" action={() => addToQueue({ channelId: channel.id, channelName: name, type: "channel" })} />
            {hasQueue() && <Menu.MenuItem id="vc-ec-menu" label={`Export Queue (${getQueue().length} item${getQueue().length !== 1 ? "s" : ""})`} action={() => openExportMenu(settings)} />}
        </Menu.MenuGroup>
    );
};

const serverMenu: NavContextMenuPatchCallback = (children, props) => {
    const { guild } = props;
    if (!guild?.id) return;
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-ec-export-server" label="Export Server" action={() => openServerExportModal(guild.id, settings)} />
            <Menu.MenuItem id="vc-ec-add-server" label="Add Server to Export Queue" action={() => addToQueue({ channelId: guild.id, channelName: guild.name, type: "server", guildId: guild.id })} />
            {hasQueue() && <Menu.MenuItem id="vc-ec-menu" label={`Export Queue (${getQueue().length} item${getQueue().length !== 1 ? "s" : ""})`} action={() => openExportMenu(settings)} />}
        </Menu.MenuGroup>
    );
};

const messageMenu: NavContextMenuPatchCallback = (children, props) => {
    const msgId = props.message?.id;
    const channelId = props.message?.channel_id;
    if (!msgId) return;

    const lastClicked: string | undefined = (window as any).__ecLastClicked;
    const canFillRange = !!(lastClicked && msgId !== lastClicked);
    const rangeStart: string | undefined = (window as any).__ecRangeStart;
    const rangeEnd: string | undefined = (window as any).__ecRangeEnd;
    const hasStart = !!rangeStart;
    const hasBoth = hasStart && !!rangeEnd;

    const items: any[] = [];

    // Fill range (highlight/hide)
    if (canFillRange) {
        items.push(<Menu.MenuItem key="vc-ec-fill-hl" id="vc-ec-fill-hl" label="Highlight from the last click to here" action={() => { fillRange(lastClicked!, msgId, "highlight"); (window as any).__ecLastClicked = msgId; }} />);
        items.push(<Menu.MenuItem key="vc-ec-fill-hide" id="vc-ec-fill-hide" label="Hide from the last click to here" action={() => { fillRange(lastClicked!, msgId, "hide"); (window as any).__ecLastClicked = msgId; }} />);
        items.push(<Menu.MenuSeparator key="vc-ec-sep-fill" />);
    }

    // Range bounds
    items.push(<Menu.MenuItem key="vc-ec-start" id="vc-ec-start" label={hasStart ? "Move range start here" : "Start export range here"} action={() => setRangeStart(msgId)} />);
    if (hasStart && !hasBoth) {
        items.push(<Menu.MenuItem key="vc-ec-end" id="vc-ec-end" label="End export range here" action={() => setRangeEnd(msgId)} />);
    }
    if (hasBoth) {
        const chName = getChannelDisplayName(channelId!);
        items.push(<Menu.MenuItem key="vc-ec-add-range" id="vc-ec-add-range" label="Add Range to Queue" action={() => {
            addToQueue({ channelId: channelId!, channelName: chName, type: "range", rangeStartId: rangeStart!, rangeEndId: rangeEnd! });
        }} />);
        items.push(<Menu.MenuItem key="vc-ec-clear-range" id="vc-ec-clear-range" label="Clear Range" action={() => {
            document.querySelectorAll(".vc-export-range-start, .vc-export-range-end").forEach(el => el.classList.remove("vc-export-range-start", "vc-export-range-end"));
            delete (window as any).__ecRangeStart; delete (window as any).__ecRangeEnd;
        }} />);
    }

    // Open export menu / return to export modal
    const isSelecting = (window as any).__ecSelectingActive;
    const savedState = (window as any).__ecSingleExportState;

    items.push(<Menu.MenuSeparator key="vc-ec-sep-menu" />);

    if (isSelecting) {
        items.push(<Menu.MenuItem key="vc-ec-back" id="vc-ec-back" label="Back to Export" action={() => {
            // (No logging of savedState: it holds the export password.)
            (window as any).__ecSelectingActive = false;
            const openSaved = () => savedState?.serverExport && savedState?.guildId
                ? openServerExportModal(savedState.guildId, settings)
                : openSingleExportModal(savedState.channelId, settings);
            // Return to the modal "Select in Chat" was started from; otherwise the queue comes first
            if ((window as any).__ecSelectingFrom === "single" && savedState?.channelId) {
                openSaved();
            } else if (hasQueue()) {
                openExportMenu(settings);
            } else if (savedState?.channelId) {
                openSaved();
            } else {
                // Nothing to return to: open the export dialog for the current channel
                const chId = SelectedChannelStore.getChannelId();
                if (chId) openSingleExportModal(chId, settings);
            }
        }} />);
    }

    if (hasQueue()) {
        items.push(<Menu.MenuItem key="vc-ec-open" id="vc-ec-open" label={`Export Queue (${getQueue().length} item${getQueue().length !== 1 ? "s" : ""})`} action={() => openExportMenu(settings)} />);
    }

    children.push(<Menu.MenuGroup>{items}</Menu.MenuGroup>);
};

export { clearAll, clearSelections, getChannelDisplayName, getQueue, getSelections, Native };

export default definePlugin({
    name: "ExportChat",
    description: "Save channels, DMs and whole servers as one HTML file that looks like Discord. It opens in any browser.",
    authors: [{ name: "3xyy", id: 596844241058267168n }],
    settings,
    managedStyle,
    settingsAboutComponent: () => <ExportHistory settings={settings} />,

    start() {
        addMessageClickListener(onMessageClick);
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
        // The viewer template is bundled into native.ts and fetched on the first export (htmlGenerator.ts)
    },

    stop() {
        removeMessageClickListener(onMessageClick);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
        clearAll();
    },

    contextMenus: {
        "channel-context": channelMenu,
        "gdm-context": channelMenu,
        "thread-context": channelMenu,
        "user-context": (children, props) => { if (props.channel) channelMenu(children, props); },
        "guild-context": serverMenu,
        "message": messageMenu,
    },
});
