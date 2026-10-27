/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

import { RoleMembersIcon } from "./icons";
import { openRoleMembersModal } from "./modal";
import { PermSortOrder } from "./permissions";

export const settings = definePluginSettings({
    renderRoleStyles: {
        type: OptionType.BOOLEAN,
        description: "Render gradient/holographic role styling on the role colour dot",
        default: true
    },
    permissionSortOrder: {
        type: OptionType.SELECT,
        description: "How to sort the permissions list",
        options: [
            { label: "Importance", value: PermSortOrder.Importance, default: true },
            { label: "Discord default", value: PermSortOrder.DiscordDefault },
            { label: "Alphabetical", value: PermSortOrder.Alphabetical }
        ]
    },
    showPermissionIcons: {
        type: OptionType.BOOLEAN,
        description: "Show custom icons next to important permissions",
        default: true
    },
    showMemberCount: {
        type: OptionType.BOOLEAN,
        description: "Show a member-count badge next to each role",
        default: true
    },
    searchBox: {
        type: OptionType.BOOLEAN,
        description: "Show a search field to filter roles and members",
        default: true
    }
});

const contextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.guild) return;

    const item = (
        <Menu.MenuItem
            id="vc-role-members"
            label="Role Members"
            icon={RoleMembersIcon}
            action={() => openRoleMembersModal(props.guild)}
        />
    );

    const group = findGroupChildrenByChildId("privacy", children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

export default definePlugin({
    name: "RoleMembers",
    description: "Right-click a server to view its roles, each role's permissions (sorted by importance), and every member who has that role.",
    tags: ["Roles", "Servers", "Utility"],
    authors: [{ name: "3xyy", id: 596844241058267168n }],
    settings,
    contextMenus: {
        "guild-context": contextMenuPatch,
        "guild-header-popout": contextMenuPatch
    }
});
