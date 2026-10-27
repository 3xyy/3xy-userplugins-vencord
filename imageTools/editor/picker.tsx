/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openModal } from "@utils/modal";
import { CloudUpload } from "@vencord/discord-types";
import { Modal, useEffect, useMemo } from "@webpack/common";
import { ComponentType } from "react";

import { openEditor } from "./EditorModal";

const M = Modal as ComponentType<any>;

/** Open a small picker so the user can choose which staged image to edit (used when several are staged). */
export function openImagePicker(uploads: CloudUpload[]) {
    openModal(modalProps => <Picker modalProps={modalProps} uploads={uploads} />);
}

function Picker({ modalProps, uploads }: { modalProps: any; uploads: CloudUpload[]; }) {
    const urls = useMemo(() => uploads.map(u => URL.createObjectURL(u.item.file)), [uploads]);
    useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls]);

    return (
        <M {...modalProps} size="md">
            <div className="vc-it-picker">
                <div className="vc-it-picker-title">Which image do you want to edit?</div>
                <div className="vc-it-picker-grid">
                    {uploads.map((u, i) => (
                        <button
                            key={u.id ?? i}
                            type="button"
                            className="vc-it-picker-item"
                            onClick={() => { modalProps.onClose(); void openEditor(u); }}
                        >
                            <img src={urls[i]} alt={u.filename} />
                            <span className="vc-it-picker-name">{u.filename}</span>
                        </button>
                    ))}
                </div>
            </div>
        </M>
    );
}
