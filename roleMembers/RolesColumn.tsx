/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { OwnerCrownIcon } from "@components/Icons";
import { Guild } from "@vencord/discord-types";
import { GuildMemberCountStore, GuildMemberStore, IconUtils, ScrollerThin, Text, UserStore,useState, useStateFromStores } from "@webpack/common";

import type { PermFilter } from "./modal";
import { getRoleDotStyle, getRoleIconSrc } from "./roleStyle";
import { ColumnSearch } from "./SearchBar";
import { cl, ColumnItem, getRolesWithPermission, getUserRoles, isItemActive, onActivateKey, Selection } from "./utils";

interface RolesColumnProps {
    guild: Guild;
    items: ColumnItem[];
    selection: Selection;
    permFilter: PermFilter | null;
    onSelect: (item: ColumnItem) => void;
    showSearch: boolean;
    renderRoleStyles: boolean;
    showMemberCount: boolean;
}

export function RolesColumn({ guild, items, selection, permFilter, onSelect, showSearch, renderRoleStyles, showMemberCount }: RolesColumnProps) {
    const [search, setSearch] = useState("");

    const memberData = useStateFromStores([GuildMemberStore, GuildMemberCountStore], () => {
        const members = GuildMemberStore.getMembers(guild.id);
        const everyone = GuildMemberCountStore.getMemberCount(guild.id) ?? members.length;
        if (!showMemberCount) return { counts: null as Record<string, number> | null, everyone };

        const counts: Record<string, number> = {};
        for (const member of members)
            for (const roleId of member.roles)
                counts[roleId] = (counts[roleId] ?? 0) + 1;
        return { counts, everyone };
    }, [guild.id, showMemberCount]);

    // Subscribed so the owner row updates if the owner's user object streams in after the modal opens.
    const ownerUser = useStateFromStores([UserStore], () => UserStore.getUser(guild.ownerId), [guild.ownerId]);

    // What roles to show: filtered by permission, a user's roles, or all roles.
    const displayItems: ColumnItem[] = permFilter
        ? getRolesWithPermission(guild, permFilter.bit).map(role => ({ kind: "role", role } as const))
        : selection.kind === "user"
            ? getUserRoles(guild, selection.userId).map(role => ({ kind: "role", role } as const))
            : items;

    const headerLabel = permFilter
        ? `Roles with ${permFilter.title}`
        : selection.kind === "user"
            ? "User's roles"
            : "Roles";

    const q = search.toLowerCase();
    const visible = displayItems.filter(item => {
        if (!q) return true;
        if (item.kind === "owner") {
            const name = ownerUser?.globalName ?? ownerUser?.username ?? "";
            return name.toLowerCase().includes(q) || "owner".includes(q);
        }
        return item.role.name.toLowerCase().includes(q);
    });

    return (
        <div className={cl("col", "col-roles")}>
            <div className={cl("col-header")}>
                <span className={cl("col-header-text")}>{headerLabel}</span>
                <span className={cl("count-badge")}>{visible.length}</span>
            </div>
            {showSearch && <ColumnSearch value={search} onChange={setSearch} placeholder="Search roles…" />}

            <ScrollerThin className={cl("col-scroller")} orientation="auto">
                {visible.length === 0
                    ? <div className={cl("empty")}><Text variant="text-md/normal">No roles to show.</Text></div>
                    : visible.map(item => {
                        const key = item.kind === "owner" ? "owner" : item.role.id;
                        const active = isItemActive(item, selection);

                        if (item.kind === "owner") {
                            const name = ownerUser?.globalName ?? ownerUser?.username ?? "Server Owner";
                            const avatar = ownerUser?.getAvatarURL(guild.id, 24, false) ?? IconUtils.getDefaultAvatarURL(guild.ownerId);
                            return (
                                <div
                                    key={key}
                                    role="button"
                                    tabIndex={0}
                                    className={cl("list-item", { "list-item-active": active })}
                                    onClick={() => onSelect(item)}
                                    onKeyDown={onActivateKey(() => onSelect(item))}
                                >
                                    <img className={cl("member-avatar")} src={avatar} alt="" />
                                    <Text variant="text-md/normal" className={cl("list-item-text")}>{name}</Text>
                                    <OwnerCrownIcon className={cl("owner-crown")} height={18} width={18} aria-hidden="true" />
                                </div>
                            );
                        }

                        const { role } = item;
                        const iconSrc = getRoleIconSrc(role);
                        const count = role.id === guild.id ? memberData.everyone : (memberData.counts?.[role.id] ?? 0);

                        return (
                            <div
                                key={key}
                                role="button"
                                tabIndex={0}
                                className={cl("list-item", { "list-item-active": active })}
                                onClick={() => onSelect(item)}
                                onKeyDown={onActivateKey(() => onSelect(item))}
                            >
                                <span className={cl("role-dot")} style={getRoleDotStyle(role, renderRoleStyles)} />
                                {iconSrc != null && <img className={cl("role-img")} src={iconSrc} alt="" />}
                                <Text variant="text-md/normal" className={cl("list-item-text")}>{role.name}</Text>
                                {showMemberCount && (
                                    <span
                                        className={cl("count-badge")}
                                        // @everyone uses the server's total; other roles only count members Discord has loaded
                                        title={role.id === guild.id ? "Members in the server" : "Members loaded so far (Discord loads members lazily; select the role to load all of them)"}
                                    >
                                        {count}
                                    </span>
                                )}
                            </div>
                        );
                    })}
            </ScrollerThin>
        </div>
    );
}
