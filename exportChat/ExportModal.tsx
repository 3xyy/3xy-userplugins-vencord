/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, TextButton } from "@components/Button";
import { Heading } from "@components/Heading";
import { copyToClipboard } from "@utils/clipboard";
import type { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, GuildStore, Modal, openModal, Select, showToast, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { Checkbox, PasswordField, SwitchRow } from "./controls";
import { saveRecord } from "./ExportHistory";
import { fetchAllMessages } from "./fetcher";
import { generateServerHtml } from "./htmlGenerator";
import { clearAll, clearSelections, getQueue, getSelections, Native } from "./index";
import { useModalWidth } from "./modalFit";
import { ExportOptions, ExportProgress, MediaMode } from "./types";
import { cfConfigError, MAX_SHARE_BYTES } from "./validation";

/** The legacy medium modal's width, which these modals always had. */
const MODAL_WIDTH = "min(600px, calc(100vw - 32px))";

function makeFilename(name: string, isAdmin?: boolean): string {
    const clean = name.replace(/[^a-zA-Z0-9]/g, "");
    const first3 = clean.slice(0, 3) || "exp";
    const last3 = clean.length > 3 ? clean.slice(-3) : first3;
    const ts = Math.floor(Date.now() / 1000);
    const prefix = isAdmin ? "admin_" : "";
    return `${prefix}${first3}-${last3}-${ts}.html`;
}

/** `YYYY-MM-DD` from a date input as local midnight (`new Date("YYYY-MM-DD")` would be UTC midnight). */
function parseLocalDate(value: string): Date | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

function getShareError(settings: any): string | null {
    const { cfApiToken, cfAccountId, cfPagesProject } = settings.store;
    return cfConfigError(cfApiToken, cfAccountId, cfPagesProject);
}

/** Deploys to Cloudflare Pages; returns this share's URL and deployment ID, or null if it failed. */
async function shareHtml(html: string, settings: any): Promise<{ url: string; deploymentId?: string; } | null> {
    showToast({ text: "Sharing..." });
    try {
        const { cfApiToken, cfAccountId, cfPagesProject } = settings.store;
        const result = await Native.shareToPages(html, cfApiToken, cfAccountId, cfPagesProject);
        if (result.success && result.url) {
            copyToClipboard(result.url).catch(() => { });
            showToast({ text: `Shared. Link copied: ${result.url}`, variant: "success", duration: 15000 });
            return { url: result.url, deploymentId: result.deploymentId };
        }
        showToast({ text: `Couldn't share it: ${result.error}`, variant: "critical" });
    } catch (e: any) {
        showToast({ text: `Couldn't share it: ${e?.message}`, variant: "critical" });
    }
    return null;
}

const MEDIA_OPTIONS = [
    { label: "Link to Discord's CDN (links can expire)", value: MediaMode.CDN },
    { label: "Embed in the file (works offline, bigger file)", value: MediaMode.BASE64 },
    { label: "Upload to catbox.moe (public, permanent)", value: MediaMode.CATBOX },
];

const MEDIA_TYPE_LABELS = { image: "Images", video: "Videos", file: "Files", link: "Links" } as const;

const SELECT_HELP = "Click a message to highlight it, click again to hide it, and once more to reset it. Then right-click a second message to highlight or hide everything in between.";

function downloadHtml(html: string, filename: string) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function saveToLocation(html: string, filename: string, saveLocation: string, behavior: string): Promise<string | undefined> {
    if (!saveLocation?.trim()) { downloadHtml(html, filename); return undefined; }
    try {
        // The native side writes into the save location from settings; we only pass the file name
        const result = await Native.saveExport(filename, html, behavior === "overwrite" ? "overwrite" : "increment");
        if (result.success && result.path) {
            showToast({ text: `Saved to ${result.path}`, variant: "success" });
            return result.path;
        }
        showToast({ text: `Couldn't save it (${result.error}), so it was downloaded instead.`, variant: "critical" });
        downloadHtml(html, filename);
    } catch {
        downloadHtml(html, filename);
    }
    return undefined;
}

function ShareOption({ shareError, checked, onChange, disabled }: { shareError: string | null; checked: boolean; onChange(v: boolean): void; disabled: boolean; }) {
    if (shareError) return <span className="vc-export-hint">{shareError}</span>;
    return <SwitchRow label="Share online" hint="Uploads the file to your Cloudflare Pages project and copies the link." value={checked} onChange={onChange} disabled={disabled} />;
}

/** Share, password and admin mode, the same in every export dialog. */
function ExportOptionsSection({ shareError, shouldShare, setShouldShare, passwordProtect, setPasswordProtect, password, setPassword, adminMode, setAdminMode, disabled }: {
    shareError: string | null;
    shouldShare: boolean; setShouldShare(v: boolean): void;
    passwordProtect: boolean; setPasswordProtect(v: boolean): void;
    password: string; setPassword(v: string): void;
    adminMode: boolean; setAdminMode(v: boolean): void;
    disabled: boolean;
}) {
    return (
        <div className="vc-export-options">
            <ShareOption shareError={shareError} checked={shouldShare} onChange={setShouldShare} disabled={disabled} />
            <SwitchRow label="Password" hint="Encrypts the messages (AES-256). People need the password to open the file." value={passwordProtect} onChange={setPasswordProtect} disabled={disabled} />
            {passwordProtect && <PasswordField value={password} onChange={setPassword} disabled={disabled} placeholder="Choose a password" />}
            <SwitchRow label="Admin mode" hint="Lets you edit, add, import and delete messages in the exported page, then download a clean copy." value={adminMode} onChange={setAdminMode} disabled={disabled} />
        </div>
    );
}

/** Progress (while exporting) or the Reset button, shown left of the modal's action buttons. */
function FooterLeft({ progress, isExporting, onDelete }: { progress: ExportProgress | null; isExporting: boolean; onDelete(): void; }) {
    if (progress) {
        return (
            <div className="vc-export-footer-progress">
                <div className="vc-export-progress-text">{progress.currentAction}</div>
                <div className="vc-export-progress-bar-outer">
                    <div className="vc-export-progress-bar-inner" style={{ width: progress.phase === "generating" ? "90%" : progress.phase === "done" ? "100%" : "50%" }} />
                </div>
            </div>
        );
    }
    return <TextButton variant="danger" onClick={onDelete} disabled={isExporting}>Reset</TextButton>;
}

/** Merges messages fetched for the same channel by several queue entries: no duplicates, oldest first. */
function mergeMessages(a: any[], b: any[]): any[] {
    const byId = new Map<string, any>();
    for (const m of a) byId.set(m.id, m);
    for (const m of b) byId.set(m.id, m);
    return [...byId.values()].sort((x, y) => {
        const dx = BigInt(x.id), dy = BigInt(y.id);
        return dx < dy ? -1 : dx > dy ? 1 : 0;
    });
}

function ExportMenu({ modalProps, settings }: { modalProps: RenderModalProps; settings: any; }) {
    const queue = getQueue();
    const selections = getSelections();
    const body = useRef<HTMLDivElement>(null);
    useModalWidth(body, MODAL_WIDTH);

    const [excludeUserIds, setExcludeUserIds] = useState("");
    const [mediaTypes, setMediaTypes] = useState({ image: false, video: false, file: false, link: false });
    const [mediaMode, setMediaMode] = useState<MediaMode>(settings.store.defaultMediaMode as MediaMode);
    const [shouldShare, setShouldShare] = useState(false);
    const [passwordProtect, setPasswordProtect] = useState(false);
    const [password, setPassword] = useState("");
    const [adminMode, setAdminMode] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState<ExportProgress | null>(null);
    const abortRef = useRef(false);
    const anyMediaSelected = Object.values(mediaTypes).some(Boolean);
    const toggleMediaType = (t: string) => setMediaTypes(p => ({ ...p, [t]: !p[t as keyof typeof p] }));
    const parseIds = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
    const shareError = getShareError(settings);

    // Closing the modal (X, Escape, Cancel) stops a running export
    useEffect(() => () => { abortRef.current = true; }, []);

    // Collect all highlight/hide IDs across all channels
    const allHighlights = new Set<string>();
    const allHides = new Set<string>();
    for (const [, s] of selections) {
        s.highlight.forEach(id => allHighlights.add(id));
        s.hide.forEach(id => allHides.add(id));
    }

    const doExport = useCallback(async () => {
        setIsExporting(true);
        abortRef.current = false;

        try {
            const allChannelMessages: Record<string, any[]> = {};
            let guildId: string | undefined;

            // Process each queue entry
            for (let i = 0; i < queue.length; i++) {
                const entry = queue[i];
                if (abortRef.current) return;

                if (entry.type === "server" && entry.guildId) {
                    // Server export: fetch every text channel
                    guildId = entry.guildId;
                    const guildChannels = GuildChannelStore.getChannels(entry.guildId);
                    const textChannels: any[] = [];
                    const seen = new Set<string>();
                    for (const cat of Object.values(guildChannels) as any[]) {
                        if (!Array.isArray(cat)) continue;
                        for (const e of cat) {
                            const ch = e.channel || e;
                            if (!ch?.id || seen.has(ch.id)) continue;
                            if ([0, 2, 5, 11, 12, 13, 15].includes(ch.type)) { seen.add(ch.id); textChannels.push(ch); }
                        }
                    }
                    for (let j = 0; j < textChannels.length; j++) {
                        if (abortRef.current) return;
                        const ch = textChannels[j];
                        setProgress({ phase: "fetching", fetchedCount: 0, currentAction: `[${i + 1}/${queue.length}] Fetching #${ch.name} (${j + 1}/${textChannels.length})` });
                        try {
                            const opts: ExportOptions = {
                                channelId: ch.id, mediaMode,
                                excludeUserIds: excludeUserIds.trim() ? parseIds(excludeUserIds) : undefined,
                                mediaTypes: anyMediaSelected ? (Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) as any) : undefined,
                                hiddenMessageIds: allHides.size > 0 ? allHides : undefined,
                            };
                            const msgs = await fetchAllMessages(ch.id, opts, () => { }, () => abortRef.current);
                            if (msgs.length > 0) allChannelMessages[ch.id] = msgs;
                        } catch { /* skip */ }
                    }
                } else {
                    // Channel or range export
                    const ch = ChannelStore.getChannel(entry.channelId);
                    if (!ch) continue;
                    if (ch.guild_id) guildId = ch.guild_id;

                    setProgress({ phase: "fetching", fetchedCount: 0, currentAction: `[${i + 1}/${queue.length}] Fetching ${entry.channelName}...` });

                    const opts: ExportOptions = {
                        channelId: entry.channelId, mediaMode,
                        excludeUserIds: excludeUserIds.trim() ? parseIds(excludeUserIds) : undefined,
                        mediaTypes: anyMediaSelected ? (Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) as any) : undefined,
                        hiddenMessageIds: allHides.size > 0 ? allHides : undefined,
                        rangeStartId: entry.rangeStartId,
                        rangeEndId: entry.rangeEndId,
                        catboxUserhash: mediaMode === MediaMode.CATBOX ? settings.store.catboxUserhash : undefined,
                    };

                    try {
                        const msgs = await fetchAllMessages(entry.channelId, opts, () => { }, () => abortRef.current);
                        if (msgs.length > 0) {
                            // Several entries (e.g. two ranges) for one channel: merge, deduplicated and in order
                            const existing = allChannelMessages[entry.channelId];
                            allChannelMessages[entry.channelId] = existing ? mergeMessages(existing, msgs) : msgs;
                        }
                    } catch (e) { console.warn("[ExportChat] Failed:", entry.channelName, e); }
                }
            }

            const total = Object.values(allChannelMessages).reduce((s, m) => s + m.length, 0);
            if (total === 0) { showToast({ text: "No messages found.", variant: "critical" }); return; }

            // Use the first available guildId, or infer from channels
            if (!guildId) {
                for (const chId of Object.keys(allChannelMessages)) {
                    const ch = ChannelStore.getChannel(chId);
                    if (ch?.guild_id) { guildId = ch.guild_id; break; }
                }
            }

            const html = await generateServerHtml(
                allChannelMessages, guildId || "0", mediaMode,
                settings.store.catboxUserhash || "",
                p => setProgress(p),
                allHighlights.size > 0 ? allHighlights : undefined,
                passwordProtect && password ? password : undefined,
                adminMode,
                () => abortRef.current
            );

            if (abortRef.current || !html) return;

            const primaryName = queue[0]?.channelName || "export";
            const filename = makeFilename(primaryName, adminMode);

            const fileSize = new Blob([html]).size;
            const savedPath = await saveToLocation(html, filename, settings.store.saveLocation, settings.store.fileExistsBehavior);
            showToast({ text: `Exported ${total} message${total !== 1 ? "s" : ""}.`, variant: "success" });

            let shared: { url: string; deploymentId?: string; } | null = null;
            if (shouldShare && !shareError) {
                if (fileSize > MAX_SHARE_BYTES) {
                    showToast({ text: `The file is ${(fileSize / 1024 / 1024).toFixed(1)} MB, over the 25 MB Cloudflare Pages limit, so it wasn't shared.`, variant: "critical", duration: 8000 });
                } else {
                    shared = await shareHtml(html, settings);
                }
            }

            // Save export record
            await saveRecord({
                id: String(Date.now()),
                timestamp: Date.now(),
                filename,
                filePath: savedPath,
                fileSize,
                messageCount: total,
                channelNames: queue.map(e => e.channelName),
                guildName: guildId ? GuildStore.getGuild(guildId)?.name : undefined,
                exportType: queue.length === 1 ? queue[0].type : "queue",
                mediaMode,
                passwordProtected: !!(passwordProtect && password),
                password: passwordProtect && password ? password : undefined,
                sharedUrl: shared?.url,
                cfDeploymentId: shared?.deploymentId,
                filters: {
                    excludeUserIds: excludeUserIds || undefined,
                    mediaTypes: anyMediaSelected ? Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) : undefined,
                    highlighted: allHighlights.size,
                    hidden: allHides.size,
                },
            });

            clearAll();
            modalProps.onClose();
        } catch (err: any) {
            console.error("[ExportChat]", err);
            showToast({ text: `Export failed: ${err?.message || "unknown error"}`, variant: "critical" });
        } finally { setIsExporting(false); setProgress(null); }
    }, [queue, mediaMode, excludeUserIds, mediaTypes, anyMediaSelected, allHighlights, allHides, settings, modalProps, shouldShare, shareError, passwordProtect, password, adminMode]);

    const cancel = () => { abortRef.current = true; modalProps.onClose(); };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Export Queue (${queue.length} item${queue.length !== 1 ? "s" : ""})`}
            actionBarInput={<FooterLeft progress={progress} isExporting={isExporting} onDelete={() => { clearAll(); showToast({ text: "Cleared the queue, range and selected messages." }); modalProps.onClose(); }} />}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: cancel },
                { text: isExporting ? "Exporting..." : "Export", variant: "primary", onClick: doExport, disabled: isExporting || queue.length === 0, loading: isExporting },
            ]}
        >
            <div className="vc-export-modal-body" ref={body}>
                {/* Queue summary */}
                <div className="vc-export-field">
                    <Heading tag="h5">Queue</Heading>
                    {queue.length === 0 ? (
                        <span className="vc-export-hint">Nothing queued yet. Right-click a channel, a server or a message range to add it.</span>
                    ) : (
                        <div className="vc-export-queue">
                            {queue.map((entry, i) => {
                                const label = entry.type === "server" ? `${entry.channelName} (whole server)` : entry.type === "range" ? `#${entry.channelName} (message range)` : `#${entry.channelName}`;
                                return (
                                    <div key={i} className="vc-export-queue-item">
                                        <span className="vc-export-queue-name">{label}</span>
                                        <button type="button" className="vc-export-icon-btn" aria-label={`Remove ${label} from the queue`} title="Remove"
                                            onClick={() => { queue.splice(i, 1); modalProps.onClose(); openExportMenu(settings); }}>✕</button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {(allHighlights.size > 0 || allHides.size > 0) && (
                        <span className="vc-export-hint">
                            {allHighlights.size > 0 ? `${allHighlights.size} highlighted` : ""}
                            {allHighlights.size > 0 && allHides.size > 0 ? ", " : ""}
                            {allHides.size > 0 ? `${allHides.size} hidden` : ""}
                        </span>
                    )}
                </div>

                {/* Select messages (highlight/hide) for the queued export */}
                <div className="vc-export-field">
                    <Heading tag="h5">Highlight or hide messages</Heading>
                    <div className="vc-export-row-inline">
                        <Button size="small" disabled={isExporting} onClick={() => {
                            (window as any).__ecSelectingFrom = "queue";
                            (window as any).__ecSelectingActive = true;
                            showToast({ text: "Click messages to highlight, hide or reset them. When you're done, right-click a message and choose Back to Export.", duration: 6000 });
                            modalProps.onClose();
                        }}>
                            Select in Chat
                        </Button>
                    </div>
                    <span className="vc-export-hint">{SELECT_HELP}</span>
                </div>

                <div className="vc-export-divider" />

                {/* Filters */}
                <div className="vc-export-field">
                    <Heading tag="h5">Leave out users (IDs, comma separated)</Heading>
                    <input type="text" className="vc-export-input" value={excludeUserIds} onChange={e => setExcludeUserIds(e.target.value)} disabled={isExporting} placeholder="Nobody" spellCheck={false} />
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">Only messages with</Heading>
                    <div className="vc-export-checkbox-group">
                        {(["image", "video", "file", "link"] as const).map(t => (
                            <Checkbox key={t} label={MEDIA_TYPE_LABELS[t]} checked={mediaTypes[t]} onChange={() => toggleMediaType(t)} disabled={isExporting} />
                        ))}
                    </div>
                    <span className="vc-export-hint">Leave all unticked to export every message.</span>
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">Media</Heading>
                    <Select options={MEDIA_OPTIONS} isSelected={v => v === mediaMode} select={v => setMediaMode(v)} serialize={v => v} isDisabled={isExporting} />
                </div>

                <ExportOptionsSection
                    shareError={shareError}
                    shouldShare={shouldShare} setShouldShare={setShouldShare}
                    passwordProtect={passwordProtect} setPasswordProtect={setPasswordProtect}
                    password={password} setPassword={setPassword}
                    adminMode={adminMode} setAdminMode={setAdminMode}
                    disabled={isExporting}
                />
            </div>
        </Modal>
    );
}

export function openExportMenu(settings: any) {
    (window as any).__ecSelectingActive = false;
    openModal(props => <ExportMenu modalProps={props} settings={settings} />);
}

// ===== Single Channel / Server Export Modal (full options) =====

function SingleExportModal({ modalProps, channelId, guildId, serverExport, settings }: { modalProps: RenderModalProps; channelId: string; guildId?: string; serverExport: boolean; settings: any; }) {
    const channel = ChannelStore.getChannel(channelId);
    const channelName = channel?.name || "Channel";
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const title = serverExport ? `Export Server: ${guild?.name || "Server"}` : `Export Chat: #${channelName}`;
    const body = useRef<HTMLDivElement>(null);
    useModalWidth(body, MODAL_WIDTH);

    // Restore state saved by "Select in Chat", but only for the same channel/server it was saved for
    // (kept until the export finishes, so "Back to Export" reopens with it)
    const savedRaw = (window as any).__ecSingleExportState;
    const saved = savedRaw && savedRaw.channelId === channelId && !!savedRaw.serverExport === serverExport && (!serverExport || savedRaw.guildId === guildId)
        ? savedRaw
        : undefined;

    const [dateFrom, setDateFrom] = useState(saved?.dateFrom || "");
    const [dateTo, setDateTo] = useState(saved?.dateTo || "");
    const [includeUserIds, setIncludeUserIds] = useState(saved?.includeUserIds || "");
    const [excludeUserIds, setExcludeUserIds] = useState(saved?.excludeUserIds || "");
    const [messageCount, setMessageCount] = useState(saved?.messageCount || "");
    const [mediaTypes, setMediaTypes] = useState(saved?.mediaTypes || { image: false, video: false, file: false, link: false });
    const [mediaMode, setMediaMode] = useState<MediaMode>(saved?.mediaMode || settings.store.defaultMediaMode as MediaMode);
    const [shouldShare, setShouldShare] = useState(saved?.shouldShare || false);
    const [passwordProtect, setPasswordProtect] = useState(saved?.passwordProtect || false);
    const [password, setPassword] = useState(saved?.password || "");
    const [adminMode, setAdminMode] = useState(saved?.adminMode || false);
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState<ExportProgress | null>(null);
    const abortRef = useRef(false);
    const shareError = getShareError(settings);

    // Closing the modal (X, Escape, Cancel) stops a running export
    useEffect(() => () => { abortRef.current = true; }, []);

    const anyMediaSelected = Object.values(mediaTypes).some(Boolean);
    const toggleMediaType = (t: string) => setMediaTypes(p => ({ ...p, [t]: !p[t as keyof typeof p] }));
    const parseIds = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);

    // Get selections for this channel
    const sel = getSelections();
    const allHighlights = new Set<string>();
    const allHides = new Set<string>();
    for (const [, s] of sel) { s.highlight.forEach(id => allHighlights.add(id)); s.hide.forEach(id => allHides.add(id)); }

    const doExport = useCallback(async () => {
        setIsExporting(true);
        abortRef.current = false;
        try {
            const allMsgs: Record<string, any[]> = {};

            if (serverExport && guildId) {
                const guildChannels = GuildChannelStore.getChannels(guildId);
                const textChannels: any[] = [];
                const seen = new Set<string>();
                for (const cat of Object.values(guildChannels) as any[]) {
                    if (!Array.isArray(cat)) continue;
                    for (const e of cat) {
                        const ch = e.channel || e;
                        if (!ch?.id || seen.has(ch.id)) continue;
                        if ([0, 2, 5, 11, 12, 13, 15].includes(ch.type)) { seen.add(ch.id); textChannels.push(ch); }
                    }
                }
                for (let i = 0; i < textChannels.length; i++) {
                    if (abortRef.current) return;
                    const ch = textChannels[i];
                    setProgress({ phase: "fetching", fetchedCount: 0, currentAction: `Fetching #${ch.name} (${i + 1}/${textChannels.length})` });
                    try {
                        const opts: ExportOptions = {
                            channelId: ch.id, mediaMode,
                            dateFrom: parseLocalDate(dateFrom),
                            dateTo: parseLocalDate(dateTo),
                            includeUserIds: includeUserIds.trim() ? parseIds(includeUserIds) : undefined,
                            excludeUserIds: excludeUserIds.trim() ? parseIds(excludeUserIds) : undefined,
                            messageCount: messageCount ? parseInt(messageCount) || undefined : undefined,
                            mediaTypes: anyMediaSelected ? (Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) as any) : undefined,
                            hiddenMessageIds: allHides.size > 0 ? allHides : undefined,
                            catboxUserhash: mediaMode === MediaMode.CATBOX ? settings.store.catboxUserhash : undefined,
                        };
                        const msgs = await fetchAllMessages(ch.id, opts, () => { }, () => abortRef.current);
                        if (msgs.length > 0) allMsgs[ch.id] = msgs;
                    } catch { /* skip */ }
                }
            } else {
                setProgress({ phase: "fetching", fetchedCount: 0, currentAction: `Fetching #${channelName}...` });
                const opts: ExportOptions = {
                    channelId, mediaMode,
                    dateFrom: parseLocalDate(dateFrom),
                    dateTo: parseLocalDate(dateTo),
                    includeUserIds: includeUserIds.trim() ? parseIds(includeUserIds) : undefined,
                    excludeUserIds: excludeUserIds.trim() ? parseIds(excludeUserIds) : undefined,
                    messageCount: messageCount ? parseInt(messageCount) || undefined : undefined,
                    mediaTypes: anyMediaSelected ? (Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) as any) : undefined,
                    hiddenMessageIds: allHides.size > 0 ? allHides : undefined,
                    catboxUserhash: mediaMode === MediaMode.CATBOX ? settings.store.catboxUserhash : undefined,
                };
                const msgs = await fetchAllMessages(channelId, opts, p => setProgress(p), () => abortRef.current);
                if (msgs.length > 0) allMsgs[channelId] = msgs;
            }
            if (abortRef.current) return;

            const total = Object.values(allMsgs).reduce((s, m) => s + m.length, 0);
            if (total === 0) { showToast({ text: "No messages found.", variant: "critical" }); return; }

            const effectiveGuildId = guildId || channel?.guild_id || "0";
            const html = await generateServerHtml(allMsgs, effectiveGuildId, mediaMode, settings.store.catboxUserhash || "", p => setProgress(p), allHighlights.size > 0 ? allHighlights : undefined, passwordProtect && password ? password : undefined, adminMode, () => abortRef.current);
            if (abortRef.current || !html) return;

            const displayName = serverExport ? guild?.name || "server" : channelName;
            const filename = makeFilename(displayName, adminMode);
            const fileSize = new Blob([html]).size;
            const savedPath = await saveToLocation(html, filename, settings.store.saveLocation, settings.store.fileExistsBehavior);
            showToast({ text: `Exported ${total} message${total !== 1 ? "s" : ""}.`, variant: "success" });

            let shared: { url: string; deploymentId?: string; } | null = null;
            if (shouldShare && !shareError) {
                if (fileSize > MAX_SHARE_BYTES) {
                    showToast({ text: `The file is ${(fileSize / 1024 / 1024).toFixed(1)} MB, over the 25 MB Cloudflare Pages limit, so it wasn't shared.`, variant: "critical", duration: 8000 });
                } else {
                    shared = await shareHtml(html, settings);
                }
            }

            await saveRecord({
                id: String(Date.now()),
                timestamp: Date.now(),
                filename,
                filePath: savedPath,
                fileSize,
                messageCount: total,
                channelNames: serverExport ? Object.keys(allMsgs).map(id => { const c = ChannelStore.getChannel(id); return c?.name || id; }) : [channelName],
                guildName: effectiveGuildId !== "0" ? (GuildStore.getGuild(effectiveGuildId)?.name) : undefined,
                exportType: serverExport ? "server" : "channel",
                mediaMode,
                passwordProtected: !!(passwordProtect && password),
                password: passwordProtect && password ? password : undefined,
                sharedUrl: shared?.url,
                cfDeploymentId: shared?.deploymentId,
                filters: {
                    dateFrom: dateFrom || undefined,
                    dateTo: dateTo || undefined,
                    excludeUserIds: excludeUserIds || undefined,
                    mediaTypes: anyMediaSelected ? Object.entries(mediaTypes).filter(([, v]) => v).map(([k]) => k) : undefined,
                    highlighted: allHighlights.size,
                    hidden: allHides.size,
                },
            });

            // The highlighted/hidden messages and the saved form state were used up by this export
            clearSelections();
            modalProps.onClose();
        } catch (err: any) {
            console.error("[ExportChat]", err);
            showToast({ text: `Export failed: ${err?.message || "unknown error"}`, variant: "critical" });
        } finally { setIsExporting(false); setProgress(null); }
    }, [channelId, guildId, serverExport, mediaMode, dateFrom, dateTo, includeUserIds, excludeUserIds, messageCount, mediaTypes, anyMediaSelected, allHighlights, allHides, settings, modalProps, channelName, guild, shouldShare, shareError, passwordProtect, password, adminMode]);

    const cancel = () => { abortRef.current = true; modalProps.onClose(); };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={title}
            actionBarInput={<FooterLeft progress={progress} isExporting={isExporting} onDelete={() => { clearAll(); showToast({ text: "Cleared the queue, range and selected messages." }); modalProps.onClose(); }} />}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: cancel },
                { text: isExporting ? "Exporting..." : "Export", variant: "primary", onClick: doExport, disabled: isExporting, loading: isExporting },
            ]}
        >
            <div className="vc-export-modal-body" ref={body}>
                <div className="vc-export-field">
                    <Heading tag="h5">Dates (both days included)</Heading>
                    <div className="vc-export-row">
                        <input type="date" className="vc-export-input vc-export-input-date" aria-label="From" value={dateFrom} onChange={e => setDateFrom(e.target.value)} disabled={isExporting} />
                        <span className="vc-export-hint vc-export-row-sep">to</span>
                        <input type="date" className="vc-export-input vc-export-input-date" aria-label="To" value={dateTo} onChange={e => setDateTo(e.target.value)} disabled={isExporting} />
                    </div>
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">Only these users (IDs, comma separated)</Heading>
                    <input type="text" className="vc-export-input" value={includeUserIds} onChange={e => setIncludeUserIds(e.target.value)} disabled={isExporting} placeholder="Everyone" spellCheck={false} />
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">Leave out users (IDs, comma separated)</Heading>
                    <input type="text" className="vc-export-input" value={excludeUserIds} onChange={e => setExcludeUserIds(e.target.value)} disabled={isExporting} placeholder="Nobody" spellCheck={false} />
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">Only messages with</Heading>
                    <div className="vc-export-checkbox-group">
                        {(["image", "video", "file", "link"] as const).map(t => (
                            <Checkbox key={t} label={MEDIA_TYPE_LABELS[t]} checked={mediaTypes[t]} onChange={() => toggleMediaType(t)} disabled={isExporting} />
                        ))}
                    </div>
                    <span className="vc-export-hint">Leave all unticked to export every message.</span>
                </div>
                <div className="vc-export-field">
                    <Heading tag="h5">{serverExport ? "Most messages per channel" : "Most messages"}</Heading>
                    <input type="number" className="vc-export-input vc-export-input-number" value={messageCount} onChange={e => setMessageCount(e.target.value)} disabled={isExporting} min="1" placeholder="All" />
                </div>
                {/* Select messages */}
                <div className="vc-export-field">
                    <Heading tag="h5">Highlight or hide messages</Heading>
                    <div className="vc-export-row-inline">
                        <Button size="small" disabled={isExporting} onClick={() => {
                            (window as any).__ecSingleExportState = { channelId, guildId, serverExport, dateFrom, dateTo, includeUserIds, excludeUserIds, messageCount, mediaTypes, mediaMode, passwordProtect, password, shouldShare, adminMode };
                            (window as any).__ecSelectingFrom = "single";
                            (window as any).__ecSelectingActive = true;
                            showToast({ text: "Click messages to highlight, hide or reset them. When you're done, right-click a message and choose Back to Export.", duration: 6000 });
                            modalProps.onClose();
                        }}>
                            Select in Chat
                        </Button>
                        {(allHighlights.size > 0 || allHides.size > 0) && (
                            <span className="vc-export-hint">
                                {allHighlights.size > 0 ? `${allHighlights.size} highlighted` : ""}
                                {allHighlights.size > 0 && allHides.size > 0 ? ", " : ""}
                                {allHides.size > 0 ? `${allHides.size} hidden` : ""}
                            </span>
                        )}
                    </div>
                    <span className="vc-export-hint">{SELECT_HELP}</span>
                </div>
                <div className="vc-export-divider" />
                <div className="vc-export-field">
                    <Heading tag="h5">Media</Heading>
                    <Select options={MEDIA_OPTIONS} isSelected={v => v === mediaMode} select={v => setMediaMode(v)} serialize={v => v} isDisabled={isExporting} />
                </div>
                <ExportOptionsSection
                    shareError={shareError}
                    shouldShare={shouldShare} setShouldShare={setShouldShare}
                    passwordProtect={passwordProtect} setPasswordProtect={setPasswordProtect}
                    password={password} setPassword={setPassword}
                    adminMode={adminMode} setAdminMode={setAdminMode}
                    disabled={isExporting}
                />
            </div>
        </Modal>
    );
}

export function openSingleExportModal(channelId: string, settings: any) {
    (window as any).__ecSelectingActive = false;
    const ch = ChannelStore.getChannel(channelId);
    openModal(props => <SingleExportModal modalProps={props} channelId={channelId} guildId={ch?.guild_id} serverExport={false} settings={settings} />);
}

export function openServerExportModal(guildId: string, settings: any) {
    (window as any).__ecSelectingActive = false;
    const channels = GuildChannelStore.getChannels(guildId);
    let firstChId = "";
    for (const cat of Object.values(channels) as any[]) {
        if (!Array.isArray(cat)) continue;
        for (const e of cat) {
            const ch = e.channel || e;
            if (ch?.id && [0, 2, 5].includes(ch.type)) { firstChId = ch.id; break; }
        }
        if (firstChId) break;
    }
    openModal(props => <SingleExportModal modalProps={props} channelId={firstChId || guildId} guildId={guildId} serverExport={true} settings={settings} />);
}
