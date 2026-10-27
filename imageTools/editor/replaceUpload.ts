/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CloudUpload } from "@vencord/discord-types";
import { ChannelStore, DraftType, showToast, UploadAttachmentStore, UploadHandler } from "@webpack/common";

import { EDIT_DOC_SYMBOL } from "../constants";
import { logger } from "../logger";
import { sanitizeFileName, stripExtension } from "./encode";
import { Doc } from "./model";

/** Discord's per-message attachment limit. */
export const MAX_ATTACHMENTS = 10;
/** How long to wait for Discord to add the edited file to the draft before treating it as refused. */
const ACCEPT_TIMEOUT_MS = 4000;
/** After a timeout, how long to keep watching for Discord adding the file late anyway. */
const LATE_WATCH_MS = 60_000;

/** uniqueIds of edited uploads a save has taken over, so a late-copy cleanup can never remove one. */
const claimed = new Set<string>();
/** Number of timed-out saves still watching for a late copy. */
let lateWatchers = 0;

function getUploads(channelId: string, draftType: number): CloudUpload[] {
    return UploadAttachmentStore.getUploads(channelId, draftType as any) ?? [];
}

/** The draft (channel message, forum post being created, …) the original upload belongs to. */
function findDraftType(original: CloudUpload): number {
    const types = Object.values(DraftType).filter((v): v is number => typeof v === "number");
    for (const type of types) {
        try {
            if (getUploads(original.channelId, type).some(u => u.uniqueId === original.uniqueId))
                return type;
        } catch { /* ignore */ }
    }
    return DraftType.ChannelMessage;
}

/**
 * True when the original's draft already holds the maximum number of attachments. The original keeps its
 * slot until the edited copy is in, so Discord would refuse the copy.
 */
export function isDraftFull(original: CloudUpload): boolean {
    return getUploads(original.channelId, findDraftType(original)).length >= MAX_ATTACHMENTS;
}

/**
 * The user was told the save failed and the original is still attached. If Discord adds the edited file
 * late anyway, remove that copy again, so the draft never ends up with both.
 */
function removeLateCopy(channelId: string, draftType: number, isLateCopy: (u: CloudUpload) => boolean) {
    lateWatchers++;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        lateWatchers--;
        clearTimeout(timer);
        UploadAttachmentStore.removeChangeListener(check);
    };
    function check() {
        const late = getUploads(channelId, draftType).find(isLateCopy);
        if (!late) return;
        finish();
        // not from inside the store's change emit: removing dispatches another Flux action
        setTimeout(() => {
            try { (late as any).cancel?.(); } catch { }
            try {
                late.removeFromMsgDraft();
                showToast({ text: "ImageTools: the edited image showed up late, so it was removed again. Your original is still attached." });
            } catch (e) {
                logger.error("replaceUpload: couldn't remove the late copy", e);
            }
        }, 0);
    }
    const timer = setTimeout(finish, LATE_WATCH_MS);
    UploadAttachmentStore.addChangeListener(check);
    check();
}

/**
 * Replace `original`'s file in its draft with `blob`, preserving spoiler/description; stash `doc` for re-edit.
 * `name` is the file name typed in the editor (without extension); it defaults to the original's name.
 * The original is removed only once Discord has accepted the new file into the draft. Resolves to null
 * (original left in place) if Discord refused it, e.g. over the upload size limit or the attachment limit.
 */
export async function replaceUpload(original: CloudUpload, blob: Blob, ext: string, mime: string, doc: Doc, name = stripExtension(original.filename)): Promise<File | null> {
    const channel = ChannelStore.getChannel(original.channelId);
    if (!channel) throw new Error("ImageTools: channel not found for upload");

    const draftType = findDraftType(original);
    // the new upload carries this name, so re-opening the editor on it starts from the edited name
    const file = new File([blob], sanitizeFileName(name, ext), { type: mime });

    // snapshot existing upload identities BEFORE adding the new one
    const beforeIds = new Set(getUploads(original.channelId, draftType).map(u => u.uniqueId));

    // Our upload is the one wrapping this exact File. As a fallback (in case Discord wraps the File),
    // accept any upload that wasn't there before, but only when no timed-out save could own it.
    // Uniqueness via uniqueId is robust against filename renames (e.g. AnonymiseFileNames).
    const fallbackOk = lateWatchers === 0;
    const isOurs = (u: CloudUpload) => !claimed.has(u.uniqueId)
        && (u.item?.file === file || (fallbackOk && !beforeIds.has(u.uniqueId)));

    // carry metadata from the original before we drop it
    const { spoiler } = original;
    const { description } = original;

    UploadHandler.promptToUpload([file], channel, draftType);

    // The new CloudUpload appears in the store asynchronously after a Flux flush, or never if Discord
    // refused the file (it shows its own error).
    const started = Date.now();
    let attempt = 0;
    while (true) {
        const fresh = getUploads(original.channelId, draftType).find(isOurs);
        if (fresh) {
            claimed.add(fresh.uniqueId);
            fresh.spoiler = spoiler;
            if (description) fresh.description = description;
            (fresh as any)[EDIT_DOC_SYMBOL] = doc;
            // only now that the edited file is in the draft is it safe to drop the original
            try { (original as any).cancel?.(); } catch { }
            try { original.removeFromMsgDraft(); } catch (e) { logger.error("replaceUpload: removeFromMsgDraft failed", e); }
            return file;
        }
        if (Date.now() - started >= ACCEPT_TIMEOUT_MS) break;
        await new Promise(r => setTimeout(r, attempt++ < 3 ? 16 : 100));
    }

    removeLateCopy(original.channelId, draftType, u => !claimed.has(u.uniqueId) && u.item?.file === file);
    return null;
}
