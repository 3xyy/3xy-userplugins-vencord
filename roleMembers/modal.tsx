/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { GuildRoleStore, Modal, openModalLazy, useEffect, useLayoutEffect, useMemo, useRef, useState, useStateFromStores } from "@webpack/common";
import { CSSProperties } from "react";

import { settings } from "./index";
import { MembersColumn } from "./MembersColumn";
import { PermissionsColumn } from "./PermissionsColumn";
import { RolesColumn } from "./RolesColumn";
import { buildColumnItems, cl, ColumnItem, getGuildPermissionSpecMap, itemToSelection, loadGetGuildPermissionSpecMap, logger, Selection } from "./utils";

export interface PermFilter { bit: bigint; title: string; }

/**
 * Widen Discord's modal container to 92vw. Inline styles on our own modal's container, found from inside:
 * the current Modal drops `className`, and a global CSS selector on Discord's modal would hit every modal.
 * Returns false while the container isn't in the DOM yet.
 */
function widenModal(root: HTMLElement): boolean {
    const container = root.closest<HTMLElement>('[data-mana-component="modal"]');
    if (!container) return false;
    container.style.width = "92vw";
    container.style.minWidth = "92vw";
    container.style.maxWidth = "92vw";
    container.style.maxHeight = "90vh";
    return true;
}

// Smallest a column may be dragged to; the boundary is the modal edge (measured at drag time).
const MIN_COL = 60;
const PERMS_MIN = 80;
const DIVIDERS = 8;

function RoleMembersModalComponent({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    // Reactive so roles added/removed/reordered while the modal is open update the list.
    const items = useStateFromStores([GuildRoleStore], () => buildColumnItems(guild), [guild.id]);
    const specMap = useMemo(() => getGuildPermissionSpecMap(guild), [guild.id]);

    const { renderRoleStyles, permissionSortOrder, showPermissionIcons, showMemberCount, searchBox } =
        settings.use(["renderRoleStyles", "permissionSortOrder", "showPermissionIcons", "showMemberCount", "searchBox"]);

    // Default selection: highest role (items[1]), else the owner (items[0]).
    const [selection, setSelection] = useState<Selection>(() => itemToSelection(items[1] ?? items[0]));
    const [permFilter, setPermFilter] = useState<PermFilter | null>(null);

    // Where to return when a selected user is clicked again (toggled off).
    const returnSelectionRef = useRef<Selection | null>(null);

    // Draggable column widths (the middle Permissions column flexes to fill the rest).
    const containerRef = useRef<HTMLDivElement>(null);
    const rolesRef = useRef(240);
    const membersRef = useRef(280);
    const [rolesWidth, setRolesWidth] = useState(240);
    const [membersWidth, setMembersWidth] = useState(280);

    // Size the modal from inside once it's mounted (retry next frame if Discord hasn't attached it yet).
    const rootRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = rootRef.current;
        if (!el || widenModal(el)) return;
        const id = requestAnimationFrame(() => {
            if (!widenModal(el)) logger.warn("Discord's modal container wasn't found; keeping its default width");
        });
        return () => cancelAnimationFrame(id);
    }, []);

    useEffect(() => {
        logger.debug(`Opened with ${items.length - 1} roles`);
    }, [guild.id]);

    // Selecting a role/owner/user clears the permission cross-filter (returns to normal view).
    const selectItem = (item: ColumnItem) => {
        setSelection(itemToSelection(item));
        setPermFilter(null);
    };
    const selectUser = (userId: string) => {
        // Clicking the already-selected user toggles back to where we were.
        if (selection.kind === "user" && selection.userId === userId) {
            const back = returnSelectionRef.current ?? { kind: "owner" as const };
            returnSelectionRef.current = null;
            setSelection(back);
            return;
        }
        if (selection.kind !== "user") returnSelectionRef.current = selection;
        setSelection({ kind: "user", userId });
        setPermFilter(null);
    };
    const togglePerm = (bit: bigint, title: string) => {
        setPermFilter(prev => prev && prev.bit === bit ? null : { bit, title });
    };

    const setRoles = (w: number) => { rolesRef.current = w; setRolesWidth(w); };
    const setMembers = (w: number) => { membersRef.current = w; setMembersWidth(w); };

    const startResize = (which: "roles" | "members") => (e: React.MouseEvent) => {
        e.preventDefault();
        let lastX = e.clientX;
        const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - lastX;
            lastX = ev.clientX;
            const total = containerRef.current?.clientWidth ?? 2000;
            if (which === "roles") {
                const max = Math.max(MIN_COL, total - membersRef.current - PERMS_MIN - DIVIDERS);
                setRoles(Math.max(MIN_COL, Math.min(max, rolesRef.current + dx)));
            } else {
                const max = Math.max(MIN_COL, total - rolesRef.current - PERMS_MIN - DIVIDERS);
                setMembers(Math.max(MIN_COL, Math.min(max, membersRef.current - dx)));
            }
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const containerStyle = {
        "--vc-rm-roles-w": `${rolesWidth}px`,
        "--vc-rm-members-w": `${membersWidth}px`
    } as CSSProperties;

    return (
        <Modal {...modalProps} size="xxl" title={`${guild.name} Role Members`}>
            <div className={cl("root")} ref={rootRef}>
                <div className={cl("container")} style={containerStyle} ref={containerRef}>
                    <RolesColumn
                        guild={guild}
                        items={items}
                        selection={selection}
                        permFilter={permFilter}
                        onSelect={selectItem}
                        showSearch={searchBox}
                        renderRoleStyles={renderRoleStyles}
                        showMemberCount={showMemberCount}
                    />
                    <div className={cl("divider")} onMouseDown={startResize("roles")} />
                    <PermissionsColumn
                        guild={guild}
                        selection={selection}
                        permFilter={permFilter}
                        specMap={specMap}
                        showPermissionIcons={showPermissionIcons}
                        sortOrder={permissionSortOrder}
                        showSearch={searchBox}
                        onTogglePerm={togglePerm}
                    />
                    <div className={cl("divider")} onMouseDown={startResize("members")} />
                    <MembersColumn
                        guild={guild}
                        selection={selection}
                        permFilter={permFilter}
                        onSelectUser={selectUser}
                        showSearch={searchBox}
                    />
                </div>
            </div>
        </Modal>
    );
}

const RoleMembersModal = ErrorBoundary.wrap(RoleMembersModalComponent);

export function openRoleMembersModal(guild: Guild) {
    return openModalLazy(async () => {
        await loadGetGuildPermissionSpecMap();
        return modalProps => <RoleMembersModal guild={guild} modalProps={modalProps} />;
    });
}
