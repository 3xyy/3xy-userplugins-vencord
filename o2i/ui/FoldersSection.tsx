/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The soundboard's source folders: one row each (path, ✕ remove), then Add folder. Shown on the plugin's
// settings page and, collapsible, at the top of the panel's Soundboard tab. Both edit the same profile
// fields the same way (sb_folders + sb_folder, compared by pathKey).

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { showToast, Text, useState } from "@webpack/common";

import { getNative } from "../engineClient";
import { olog } from "../log";
import { pathKey, removeSource, sourcesOf, splitFolder, withSources } from "../logic/sources";
import { addSourceFolder, settings, updateProfile } from "../settings";
import { Section } from "./controls";

const cl = classNameFactory("vc-o2i-");

const FORMATS = "MP3, WAV, OGG, FLAC, M4A or AAC";

function toast(text: string, variant?: "critical") {
    try {
        showToast({ text, variant });
    } catch (e) {
        olog.error("toast failed", e);
    }
}

/**
 * Adds a folder picked with the system folder dialog (one dialog at a time). A folder already listed
 * (any case / slash style) only shows a toast. The first folder also runs the path migration.
 */
async function addFolder(): Promise<void> {
    if (!IS_DISCORD_DESKTOP) return;
    let picked: string | null;
    try {
        picked = await getNative().pickFolder("Add a soundboard folder");
    } catch (e) {
        olog.error("the folder picker failed", e);
        return;
    }
    if (!picked) return; // cancelled (or failed: native.ts logged it)
    if (!addSourceFolder(picked)) toast("That folder is already in your soundboard");
}

/** Opens a folder in File Explorer; a problem shows as a toast. */
async function openFolder(folder: string): Promise<void> {
    if (!IS_DISCORD_DESKTOP) return;
    try {
        const native = getNative();
        // native.ts from before this existed never defines it: needs a Discord restart.
        if (typeof native.openFolder !== "function") {
            toast("Restart Discord to finish updating o2i", "critical");
            return;
        }
        const res = await native.openFolder(folder);
        if (!res.ok) toast(res.error, "critical");
    } catch (e) {
        olog.error("open folder failed", e);
        toast("Couldn't open the folder", "critical");
    }
}

/** Removes a folder from the list; its sounds' settings, hotkeys and names stay (they show again if it's re-added). */
function removeFolder(folder: string) {
    const next = removeSource(sourcesOf(settings.store.profile), folder);
    updateProfile(p => withSources(p, next));
    olog.info(`soundboard folder removed: ${folder} (${next.length} folders)`);
}

function FolderRows({ folders, compact }: { folders: string[]; compact: boolean; }) {
    return (
        <div className={cl("folders", { "folders-compact": compact })}>
            {folders.map(f => {
                const [parent, name] = splitFolder(f);
                return (
                    <div key={pathKey(f)} className={cl("folder-row")} title={f}>
                        {/* The parent shrinks first, so the folder's own name stays readable. */}
                        <span className={cl("folder-path")}>
                            {parent && <span className={cl("folder-parent")}>{parent}</span>}
                            <button
                                type="button"
                                className={cl("folder-name", "folder-open")}
                                title="Open in File Explorer"
                                aria-label={`Open ${f} in File Explorer`}
                                onClick={() => void openFolder(f)}
                            >
                                {name}
                            </button>
                        </span>
                        <button
                            type="button"
                            className={cl("mini-btn")}
                            aria-label={`Remove ${f}`}
                            title="Remove (its sounds' settings are kept)"
                            onClick={() => removeFolder(f)}
                        >
                            ✕
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

/** Add folder, disabled while its dialog is open. */
function useAddFolder(): [picking: boolean, onAdd: () => void] {
    const [picking, setPicking] = useState(false);
    const onAdd = () => {
        if (picking) return;
        setPicking(true);
        void addFolder().finally(() => setPicking(false));
    };
    return [picking, onAdd];
}

/**
 * The soundboard folders. `compact`: the panel's Soundboard tab, as a section that starts collapsed when
 * there is at least one folder and open when there are none. Otherwise the settings page's block.
 */
export function FoldersSection({ compact = false }: { compact?: boolean; }) {
    const { profile } = settings.use(["profile"]);
    const folders = sourcesOf(profile);
    const [picking, onAdd] = useAddFolder();
    // Decided once per mount: adding the first folder keeps it open, the next visit starts collapsed.
    const [open, setOpen] = useState(() => folders.length === 0);
    const addLabel = picking ? "Choosing a folder…" : "Add folder";

    if (!compact) {
        return (
            <div>
                <Heading tag="h5">Soundboard folders</Heading>
                {folders.length === 0
                    ? (
                        <Text variant="text-sm/normal" className={cl("setup-text")}>
                            No folders yet. Add a folder with sound files ({FORMATS}) and its sounds show up in the
                            Soundboard tab of the o2i panel, ready to play into calls. You can add more than one.
                        </Text>
                    )
                    : <FolderRows folders={folders} compact={false} />}
                <Button variant="secondary" disabled={picking} onClick={onAdd}>{addLabel}</Button>
            </div>
        );
    }

    return (
        <Section
            title={folders.length ? `Folders (${folders.length})` : "Folders"}
            action={
                <button
                    type="button"
                    className={cl("mini-btn")}
                    aria-expanded={open}
                    aria-label={open ? "Hide folders" : "Show folders"}
                    onClick={() => setOpen(o => !o)}
                >
                    {open ? "Hide" : "Show"}
                </button>
            }
        >
            {open && (
                <>
                    {folders.length === 0
                        ? <div className={cl("note")}>No folders yet. Add a folder with sound files ({FORMATS}) and its sounds show up here. You can add more than one.</div>
                        : <FolderRows folders={folders} compact />}
                    <div>
                        <Button size="small" variant="secondary" disabled={picking} onClick={onAdd}>{addLabel}</Button>
                    </div>
                </>
            )}
        </Section>
    );
}
