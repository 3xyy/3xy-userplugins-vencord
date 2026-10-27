/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Button, TextButton } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, useEffect, useRef, useState } from "@webpack/common";

import { Checkbox, PasswordField, SwitchRow } from "./controls";
import { exportMessageCount, exportNames, guessMediaMode, isEncryptedExport, type ParsedExport, parseExportHtml } from "./exportUpload";
import { rebuildForUpload } from "./htmlGenerator";
import { Native } from "./index";
import { useModalWidth } from "./modalFit";
import { ExportRecord } from "./types";
import { cfConfigError, MAX_SHARE_BYTES } from "./validation";

const STORE_KEY = "exportChat_history";

const MEDIA_LABELS: Record<string, string> = { cdn: "Discord CDN", base64: "media embedded", catbox: "catbox.moe" };
const TYPE_LABELS: Record<string, string> = { channel: "channel", server: "server", range: "message range", queue: "queue", upload: "uploaded file" };

export async function getHistory(): Promise<ExportRecord[]> {
    return (await DataStore.get(STORE_KEY)) || [];
}

export async function saveRecord(record: ExportRecord) {
    const history = await getHistory();
    history.unshift(record);
    await DataStore.set(STORE_KEY, history);
}

async function removeRecord(id: string) {
    const history = await getHistory();
    await DataStore.set(STORE_KEY, history.filter(r => r.id !== id));
}

function formatSize(bytes: number): string {
    if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

function formatDate(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function ExportHistory({ settings }: { settings: any; }) {
    const [history, setHistory] = useState<ExportRecord[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [deleting, setDeleting] = useState(false);

    const reload = async () => {
        let h = await getHistory();
        // Drop entries that have neither a local file nor a shared page any more
        const before = h.length;
        h = h.filter(r => r.filePath || r.sharedUrl);
        if (h.length < before) await DataStore.set(STORE_KEY, h);
        setHistory(h);
    };
    useEffect(() => { reload(); }, []);

    const toggle = (id: string) => {
        const s = new Set(selected);
        s.has(id) ? s.delete(id) : s.add(id);
        setSelected(s);
    };

    const selectAllLocal = () => {
        const s = new Set(selected);
        history.filter(r => r.filePath).forEach(r => s.add(r.id));
        setSelected(s);
    };

    const selectAllCF = () => {
        const s = new Set(selected);
        history.filter(r => r.sharedUrl).forEach(r => s.add(r.id));
        setSelected(s);
    };

    const deleteSelectedLocal = async () => {
        const toDelete = history.filter(r => selected.has(r.id) && r.filePath);
        let deleted = 0;
        let firstError = "";
        for (const r of toDelete) {
            const result = await Native.deleteLocalFile(r.filePath!);
            if (result.success) {
                r.filePath = undefined;
                deleted++;
            } else if (!firstError) firstError = result.error ?? "Unknown error";
        }
        await DataStore.set(STORE_KEY, history);
        const failed = toDelete.length - deleted;
        showToast({
            text: `Deleted ${deleted} local file${deleted !== 1 ? "s" : ""}.${failed ? ` ${failed} couldn't be deleted: ${firstError}` : ""}`,
            variant: failed ? "critical" : "success",
        });
        setSelected(new Set());
        reload();
    };

    const deleteSelectedCF = async () => {
        const toDelete = history.filter(r => selected.has(r.id) && r.sharedUrl && r.cfDeploymentId);
        if (toDelete.length === 0) { showToast({ text: "None of the selected exports are shared." }); return; }
        setDeleting(true);
        let deleted = 0;
        const errors: string[] = [];
        for (const r of toDelete) {
            showToast({ text: `Deleting page ${deleted + errors.length + 1} of ${toDelete.length}...` });
            const result = await Native.deletePagesDeployment(
                settings.store.cfApiToken, settings.store.cfAccountId,
                settings.store.cfPagesProject, r.cfDeploymentId!
            );
            if (result.success) {
                r.sharedUrl = undefined;
                r.cfDeploymentId = undefined;
                deleted++;
            } else {
                errors.push(`${r.filename}: ${result.error}`);
            }
            await new Promise(r => setTimeout(r, 500));
        }
        await DataStore.set(STORE_KEY, history);
        setDeleting(false);
        if (errors.length > 0) {
            showToast({ text: `Deleted ${deleted} of ${toDelete.length}. ${errors[0]}`, variant: deleted > 0 ? "success" : "critical" });
        } else {
            showToast({ text: `Deleted ${deleted} shared page${deleted !== 1 ? "s" : ""}.`, variant: "success" });
        }
        setSelected(new Set());
        reload();
    };

    const removeFromHistory = async (id: string) => {
        await removeRecord(id);
        reload();
    };

    const uploadHtml = () => {
        openModal(props => <UploadModal modalProps={props} settings={settings} onDone={reload} />);
    };

    if (history.length === 0) {
        return (
            <div className="vc-export-history-empty">
                <Button size="small" onClick={uploadHtml}>Upload HTML</Button>
                <span className="vc-export-hint">No exports yet. Right-click a channel, DM or server to export it.</span>
            </div>
        );
    }

    const selectedLocal = history.filter(r => selected.has(r.id) && r.filePath).length;
    const selectedShared = history.filter(r => selected.has(r.id) && r.sharedUrl).length;

    return (
        <div className="vc-export-history">
            <div className="vc-export-history-toolbar">
                <Button size="small" onClick={uploadHtml}>Upload HTML</Button>
                <Button size="small" variant="secondary" onClick={selectAllLocal}>Select local files</Button>
                <Button size="small" variant="secondary" onClick={selectAllCF}>Select shared pages</Button>
                {selected.size > 0 && (
                    <>
                        <Button size="small" variant="dangerPrimary" onClick={deleteSelectedLocal} disabled={deleting || !selectedLocal}>
                            Delete {selectedLocal} local file{selectedLocal !== 1 ? "s" : ""}
                        </Button>
                        <Button size="small" variant="dangerPrimary" onClick={deleteSelectedCF} disabled={deleting || !selectedShared}>
                            Delete {selectedShared} shared page{selectedShared !== 1 ? "s" : ""}
                        </Button>
                        <TextButton variant="primary" onClick={() => setSelected(new Set())}>Clear selection</TextButton>
                    </>
                )}
            </div>

            {history.map(r => {
                const name = r.channelNames.join(", ");
                const meta = [formatDate(r.timestamp), `${r.messageCount} messages`, formatSize(r.fileSize), MEDIA_LABELS[r.mediaMode] ?? r.mediaMode, TYPE_LABELS[r.exportType] ?? r.exportType];
                const f = r.filters;
                const filters = [
                    f.dateFrom ? (f.dateTo ? `${f.dateFrom} to ${f.dateTo}` : `from ${f.dateFrom}`) : f.dateTo ? `until ${f.dateTo}` : "",
                    f.excludeUserIds ? `left out: ${f.excludeUserIds}` : "",
                    f.highlighted > 0 ? `${f.highlighted} highlighted` : "",
                    f.hidden > 0 ? `${f.hidden} hidden` : "",
                    f.mediaTypes?.length ? `only messages with ${f.mediaTypes.join(", ")}` : "",
                ].filter(Boolean);
                return (
                    <div key={r.id} className={`vc-export-history-row${selected.has(r.id) ? " vc-export-history-row-selected" : ""}`}>
                        <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} ariaLabel={`Select ${name}`} />
                        <div className="vc-export-history-main">
                            <div className="vc-export-history-head">
                                <span className="vc-export-history-name">{name}</span>
                                {r.guildName && <span className="vc-export-hint">in {r.guildName}</span>}
                                {r.passwordProtected && <span className="vc-export-badge">Password</span>}
                                {r.sharedUrl && <span className="vc-export-badge">Shared</span>}
                            </div>
                            <span className="vc-export-hint">{meta.join(" · ")}</span>
                            {r.password && <span className="vc-export-history-password">Password: {r.password}</span>}
                            {filters.length > 0 && <span className="vc-export-hint">{filters.join(" · ")}</span>}
                            <div className="vc-export-history-actions">
                                {r.filePath && <Button size="xs" variant="secondary" onClick={async () => {
                                    const result = await Native.openFileLocation(r.filePath!);
                                    if (!result.success) showToast({ text: `Couldn't open it: ${result.error}`, variant: "critical", duration: 6000 });
                                }}>Show in folder</Button>}
                                {r.sharedUrl && <Button size="xs" variant="secondary" onClick={() => window.open(r.sharedUrl, "_blank")}>Open page</Button>}
                                {r.filePath && <Button size="xs" variant="dangerPrimary" onClick={async () => {
                                    const result = await Native.deleteLocalFile(r.filePath!);
                                    if (result.success) { r.filePath = undefined; await DataStore.set(STORE_KEY, history); showToast({ text: "Deleted the local file.", variant: "success" }); reload(); }
                                    else showToast({ text: `Couldn't delete it: ${result.error}`, variant: "critical", duration: 6000 });
                                }}>Delete file</Button>}
                                {r.sharedUrl && r.cfDeploymentId && <Button size="xs" variant="dangerPrimary" onClick={async () => {
                                    const result = await Native.deletePagesDeployment(settings.store.cfApiToken, settings.store.cfAccountId, settings.store.cfPagesProject, r.cfDeploymentId!);
                                    if (result.success) { r.sharedUrl = undefined; r.cfDeploymentId = undefined; await DataStore.set(STORE_KEY, history); showToast({ text: "Deleted the shared page.", variant: "success" }); reload(); }
                                    else showToast({ text: `Couldn't delete the shared page: ${result.error}`, variant: "critical" });
                                }}>Delete page</Button>}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

interface PickedExport {
    /** The path native's file picker returned; the only path the delete button sends back. */
    path: string;
    name: string;
    size: number;
    parsed: ParsedExport;
    mediaMode: string;
    /** Native confirmed the pick (confirmPick), so its delete button works. */
    deletable: boolean;
}

// Upload HTML Modal: re-wraps an export (usually the clean copy Finish Editing downloads) with an optional
// password and admin tools, uploads it, then offers to delete the local file.
function UploadModal({ modalProps, settings, onDone }: { modalProps: RenderModalProps; settings: any; onDone: () => void; }) {
    const [picked, setPicked] = useState<PickedExport | null>(null);
    const [picking, setPicking] = useState(false);
    const [password, setPassword] = useState("");
    const [adminMode, setAdminMode] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
    const [local, setLocal] = useState<"kept" | "deleting" | "deleted">("kept");
    const body = useRef<HTMLDivElement>(null);
    // Set synchronously, so a quick double click can't start two uploads (two deployments)
    const inFlight = useRef(false);
    useModalWidth(body, "min(440px, calc(100vw - 32px))");

    const { cfApiToken, cfAccountId, cfPagesProject } = settings.store;
    const shareError = cfConfigError(cfApiToken, cfAccountId, cfPagesProject);
    const busy = picking || uploading;

    const pickFile = async () => {
        setPicking(true);
        // A pick that isn't confirmed by the end (rejected, or the check threw) gives its token back
        let pendingToken = "";
        try {
            const res = await Native.pickHtmlFile();
            if (!res) return;
            if ("error" in res) {
                showToast({ text: res.error, variant: "critical", duration: 6000 });
                return;
            }
            pendingToken = res.token;
            const parsed = parseExportHtml(res.content);
            if (!parsed) {
                showToast({
                    text: isEncryptedExport(res.content)
                        ? "That export has a password, so it can't be read. Pick the copy without one and set the password here."
                        : "That file isn't an ExportChat export.",
                    variant: "critical",
                    duration: 6000,
                });
                return;
            }
            // Only a file that passed parseExportHtml becomes deletable from this dialog
            pendingToken = "";
            const deletable = await Native.confirmPick(res.token).catch(() => false);
            setPicked({ path: res.path, name: res.name, size: new Blob([res.content]).size, parsed, mediaMode: guessMediaMode(res.content), deletable });
        } catch (e: any) {
            showToast({ text: `Couldn't open the file: ${e?.message ?? e}`, variant: "critical" });
        } finally {
            if (pendingToken) Native.rejectPick(pendingToken).catch(() => { });
            setPicking(false);
        }
    };

    const doUpload = async () => {
        if (!picked || shareError || busy || inFlight.current) return;
        inFlight.current = true;
        setUploading(true);
        try {
            const html = await rebuildForUpload(picked.parsed, { password: password || undefined, adminMode });
            const { size } = new Blob([html]);
            if (size > MAX_SHARE_BYTES) {
                showToast({ text: `With these options the file is ${mb(size)} MB, over the 25 MB Cloudflare Pages limit.`, variant: "critical", duration: 8000 });
                return;
            }
            showToast({ text: "Uploading..." });
            const result = await Native.shareToPages(html, cfApiToken, cfAccountId, cfPagesProject);
            if (!result.success || !result.url) {
                showToast({ text: `Upload failed: ${result.error}`, variant: "critical" });
                return;
            }
            copyToClipboard(result.url).catch(() => { });
            showToast({ text: `Uploaded. Link copied: ${result.url}`, variant: "success", duration: 10000 });
            const { channelNames, guildName } = exportNames(picked.parsed);
            await saveRecord({
                id: String(Date.now()), timestamp: Date.now(), filename: picked.name,
                fileSize: size, messageCount: exportMessageCount(picked.parsed), channelNames, guildName,
                exportType: "upload", mediaMode: picked.mediaMode,
                passwordProtected: !!password, password: password || undefined,
                sharedUrl: result.url, cfDeploymentId: result.deploymentId,
                filters: { highlighted: picked.parsed.highlightedIds.length, hidden: 0 },
            });
            setUploadedUrl(result.url);
            onDone();
        } catch (e: any) {
            showToast({ text: `Upload failed: ${e?.message ?? e}`, variant: "critical" });
        } finally {
            inFlight.current = false;
            setUploading(false);
        }
    };

    const deleteLocal = async () => {
        if (!picked?.deletable || local !== "kept") return;
        setLocal("deleting");
        try {
            const res = await Native.deleteLocalFile(picked.path);
            if (res.success) {
                setLocal("deleted");
                showToast({ text: "Deleted the local copy.", variant: "success" });
                return;
            }
            showToast({ text: `Couldn't delete it: ${res.error}`, variant: "critical", duration: 6000 });
        } catch (e: any) {
            showToast({ text: `Couldn't delete it: ${e?.message ?? e}`, variant: "critical", duration: 6000 });
        }
        setLocal("kept");
    };

    if (uploadedUrl && picked) {
        return (
            <Modal
                {...modalProps}
                size="sm"
                title="Uploaded"
                actions={[{ text: "Done", variant: "primary", onClick: modalProps.onClose }]}
            >
                <div className="vc-export-upload-body" ref={body}>
                    <div className="vc-export-upload-section">
                        <span className="vc-export-upload-label">Link</span>
                        <a
                            className="vc-export-upload-link"
                            href={uploadedUrl}
                            onClick={e => { e.preventDefault(); window.open(uploadedUrl, "_blank"); }}
                        >
                            {uploadedUrl}
                        </a>
                        <span className="vc-export-hint">
                            It's copied to your clipboard.{password ? " People need the password to open it." : ""}
                        </span>
                        <div className="vc-export-upload-buttons">
                            <Button size="small" variant="secondary" onClick={() => {
                                copyToClipboard(uploadedUrl).then(() => showToast({ text: "Link copied.", variant: "success" })).catch(() => { });
                            }}>Copy link</Button>
                        </div>
                    </div>
                    <div className="vc-export-upload-section">
                        <span className="vc-export-upload-label">Local file</span>
                        <span className="vc-export-upload-path" title={picked.path}>{picked.path}</span>
                        {picked.deletable ? (
                            <>
                                <div className="vc-export-upload-buttons">
                                    <Button size="small" variant="dangerPrimary" onClick={deleteLocal} disabled={local !== "kept"}>
                                        {local === "deleted" ? "Deleted" : local === "deleting" ? "Deleting..." : "Delete the local file"}
                                    </Button>
                                </div>
                                <span className="vc-export-hint">
                                    {local === "deleted" ? "The local copy is gone. The uploaded page stays up." : "Or keep it and close this."}
                                </span>
                            </>
                        ) : (
                            <span className="vc-export-hint">It can't be deleted from here. Delete it yourself if you want.</span>
                        )}
                    </div>
                </div>
            </Modal>
        );
    }

    const meta = picked
        ? [picked.parsed.title, `${exportMessageCount(picked.parsed)} messages`, `${mb(picked.size)} MB`].join(" · ")
        : "";

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Upload HTML to Cloudflare Pages"
            notice={shareError ? { message: shareError, type: "critical" } : undefined}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: uploading ? "Uploading..." : "Upload & Share", variant: "primary", onClick: doUpload, disabled: !picked || busy || !!shareError, loading: uploading },
            ]}
        >
            <div className="vc-export-upload-body" ref={body}>
                <div className="vc-export-upload-section">
                    <div className="vc-export-upload-buttons">
                        <Button onClick={pickFile} size="small" variant={picked ? "secondary" : "primary"} disabled={busy}>
                            {picked ? "Choose another file" : "Choose HTML file"}
                        </Button>
                    </div>
                    {picked ? (
                        <>
                            <span className="vc-export-upload-name" title={picked.path}>{picked.name}</span>
                            <span className="vc-export-hint">{meta}</span>
                        </>
                    ) : (
                        <span className="vc-export-hint">An ExportChat export, like the clean copy Finish Editing downloads.</span>
                    )}
                </div>
                <div className="vc-export-upload-section">
                    <span className="vc-export-upload-label">Password</span>
                    <PasswordField value={password} onChange={setPassword} disabled={uploading} />
                    <span className="vc-export-hint">Optional. The page is encrypted and asks for it, like a password-protected export.</span>
                </div>
                <SwitchRow
                    label="Admin tools"
                    hint="Adds the edit, import and Finish Editing buttons, like admin mode on a new export."
                    value={adminMode}
                    onChange={setAdminMode}
                    disabled={uploading}
                />
            </div>
        </Modal>
    );
}
