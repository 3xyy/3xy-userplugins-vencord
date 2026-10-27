/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { IconComponent } from "@utils/types";
import { CloudUpload } from "@vencord/discord-types";
import { DraftType, Menu, Tooltip, UploadAttachmentStore, useStateFromStores } from "@webpack/common";

import { openEditor } from "./editor/EditorModal";
import { openImagePicker } from "./editor/picker";
import { logger } from "./logger";
import { settings } from "./settings";
import { findViewerMedia, rotateMedia } from "./viewer/ViewerRotate";

/** Paint brush (same shape as the editor's Brush tool). */
const BrushIcon: IconComponent = props => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" {...props}>
        <path fill="currentColor" d="M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37-1.34-1.34a1 1 0 0 0-1.41 0L9 12.25 11.75 15l8.96-8.96a1 1 0 0 0 0-1.41z" />
    </svg>
);

/** Self-contained toolbar button (no dependency on Discord's ActionBarIcon webpack finder). */
const EditUploadButton = ErrorBoundary.wrap(({ upload }: { upload: CloudUpload; }) => (
    <Tooltip text="Edit image">
        {tooltipProps => (
            <button
                {...tooltipProps}
                type="button"
                className="vc-it-upload-btn"
                aria-label="Edit image"
                onClick={() => { tooltipProps.onClick(); void openEditor(upload); }}
            >
                <BrushIcon />
            </button>
        )}
    </Tooltip>
), { noop: true });

/** Reliable fallback entry point: a brush button in the message bar, shown when an image is staged. */
const ChatBarBrush: ChatBarButtonFactory = ({ channel }) => {
    const images = useStateFromStores(
        [UploadAttachmentStore],
        () => (channel ? (UploadAttachmentStore.getUploads(channel.id, DraftType.ChannelMessage) as CloudUpload[]).filter(u => u.isImage) : [])
    );
    if (!settings.store.enableUploadEditor || images.length === 0) return null;
    return (
        <ChatBarButton
            tooltip={images.length === 1 ? "Edit image" : `Edit an image (${images.length} attached)`}
            onClick={() => {
                if (images.length === 1) void openEditor(images[0]);
                else openImagePicker(images);
            }}
        >
            <BrushIcon />
        </ChatBarButton>
    );
};

const imageCtx: NavContextMenuPatchCallback = (children, props) => {
    if (!settings.store.enableViewerRotate) return;
    // Discord re-uses the image context menu for links (copy/open buttons), so skip those
    if ("href" in props) return;
    // Skip emoji targets (e.g. emojis in user statuses)
    if (props.target?.classList?.contains("emoji")) return;
    const media = findViewerMedia(props?.target ?? null);
    if (!media) return;
    children.push(
        <Menu.MenuGroup id="vc-it-rotate">
            <Menu.MenuItem id="vc-it-rot-cw" label="Rotate right" action={() => rotateMedia(media, 90)} />
            <Menu.MenuItem id="vc-it-rot-ccw" label="Rotate left" action={() => rotateMedia(media, -90)} />
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "ImageTools",
    description: "Draw on, blur, crop and resize images before you send them, and rotate images in the media viewer",
    authors: [{ name: "3xyy", id: 596844241058267168n }],
    tags: ["Utility", "Media"],
    settings,

    patches: [
        {
            // Inject into the pending-upload action bar, anchored loosely on the stable spoiler
            // toggle `spoiler:!o.spoiler` (NOT on the button structure immediately after `children:[`)
            // so it still matches when AnonymiseFileNames (a core plugin that patches this exact
            // spot first) has already injected its own button right after `children:[`.
            // `all: true` keeps the patch alive across multiple find-matching module loads.
            find: "#{intl::ATTACHMENT_UTILITIES_SPOILER}",
            all: true,
            replacement: {
                match: /(?<=children:\[)(?=.{0,300}spoiler:!\i\.spoiler)/,
                replace: "$self.renderEditButton(arguments[0]),"
            },
        },
    ],

    contextMenus: {
        "image-context": imageCtx
    },

    // Reliable message-bar entry point (does not depend on the fragile upload-toolbar patch above).
    chatBarButton: {
        icon: BrushIcon,
        render: ChatBarBrush
    },

    /** Called by the upload-toolbar patch on every render of every pending upload, so: no logging here. */
    renderEditButton(props: any) {
        try {
            if (!settings.store.enableUploadEditor) return null;
            if (props?.canEdit === false) return null;
            if (!props?.upload?.isImage) return null;
            return <EditUploadButton upload={props.upload} />;
        } catch (e) {
            logger.error("renderEditButton threw:", e);
            return null;
        }
    },
});
