/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { Guild, GuildMember } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildRoleStore, IconUtils, openUserProfileModal, ScrollerThin, SelectedChannelStore, useEffect, UserStore, UserUtils, useState, useStateFromStores } from "@webpack/common";

import { ProfileIcon } from "./icons";
import type { PermFilter } from "./modal";
import { ColumnSearch } from "./SearchBar";
import { cl, getMembersWithPermission, logger, onActivateKey, Selection } from "./utils";

// Triggers a gateway request for the members of a role (same finder BetterRoleContext uses).
const loadRoleMembers = findByCodeLazy(".GUILD_ROLE_MEMBER_IDS(", "requestMembersById");

// Roles whose members we already requested this session. This avoids hitting the rate-limited
// /guilds/:id/roles/:id/member-ids endpoint when revisiting a role.
const requestedRoles = new Set<string>();

/**
 * Open a member's profile in the server being inspected. (@utils/discord's openUserProfile uses the
 * currently *viewed* server, which is a different one when the modal was opened from the server list.)
 */
async function openProfileInGuild(userId: string, guildId: string) {
    const user = await UserUtils.getUser(userId);
    if (!user) return;
    const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    await openUserProfileModal({
        userId,
        guildId,
        channelId: channel?.guild_id === guildId ? channel.id : null,
        sourceAnalyticsLocations: ["username", "user profile popout"],
    });
}

function memberName(member: GuildMember | null, userId: string) {
    const user = UserStore.getUser(userId);
    return member?.nick ?? user?.globalName ?? user?.username ?? userId;
}

interface MembersColumnProps {
    guild: Guild;
    selection: Selection;
    permFilter: PermFilter | null;
    onSelectUser: (userId: string) => void;
    showSearch: boolean;
}

export function MembersColumn({ guild, selection, permFilter, onSelectUser, showSearch }: MembersColumnProps) {
    const [search, setSearch] = useState("");
    const q = search.toLowerCase().trim();
    const globalSearch = q.length > 0; // when searching, show ANY matching member regardless of selection/role

    const roleId = selection.kind === "role" ? selection.roleId : null;
    // The @everyone role id equals the guild id; everyone has it implicitly (not listed in member.roles).
    const isEveryone = roleId === guild.id;

    // Fetch a selected role's members (debounced + deduped).
    useEffect(() => {
        if (globalSearch || permFilter) return;
        if (roleId == null || isEveryone) {
            if (isEveryone) logger.debug("@everyone selected, not fetching member-ids (it would request the entire server)");
            return;
        }

        const key = `${guild.id}:${roleId}`;
        if (requestedRoles.has(key)) {
            logger.debug("Role already requested this session, using cached members");
            return;
        }

        const timer = setTimeout(() => {
            requestedRoles.add(key);
            logger.debug("Requesting member-ids for the selected role");
            try {
                loadRoleMembers(guild.id, roleId);
            } catch (err) {
                logger.error("loadRoleMembers failed", err);
            }
        }, 450);

        return () => clearTimeout(timer);
    }, [guild.id, roleId, isEveryone, globalSearch, permFilter]);

    // Server-side member search: ask the gateway for members matching the query (debounced).
    useEffect(() => {
        if (!globalSearch) return;
        const timer = setTimeout(() => {
            logger.debug("Searching members by name");
            try {
                FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guild.id], query: q, limit: 100 });
            } catch (err) {
                logger.error("member search dispatch failed", err);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [guild.id, q, globalSearch]);

    // Subscription value IS the list, so it re-renders as members stream in.
    const memberIds = useStateFromStores([GuildMemberStore, GuildRoleStore], () => {
        if (globalSearch) {
            return GuildMemberStore.getMembers(guild.id)
                .filter(member => memberName(member, member.userId).toLowerCase().includes(q)
                    || UserStore.getUser(member.userId)?.username.toLowerCase().includes(q))
                .map(member => member.userId);
        }
        if (permFilter) return getMembersWithPermission(guild, permFilter.bit);
        if (selection.kind === "owner") return [guild.ownerId];
        if (selection.kind === "user") return [selection.userId];
        return GuildMemberStore.getMembers(guild.id)
            .filter(member => isEveryone || member.roles.includes(roleId!))
            .map(member => member.userId);
    }, [guild.id, selection, permFilter, isEveryone, roleId, q, globalSearch]);

    useEffect(() => {
        logger.debug(`Members shown: ${memberIds.length} (${globalSearch ? "search" : permFilter ? `perm ${permFilter.title}` : selection.kind})`);
    }, [memberIds.length]);

    // The permission filter never fetches members (that would hit the rate-limited member-ids endpoint for
    // every role), so it only covers members Discord has loaded: say so.
    const headerLabel = globalSearch ? "Search" : permFilter ? `Has ${permFilter.title} (loaded)` : "Members";
    const activeUserId = selection.kind === "user" ? selection.userId : null;

    return (
        <div className={cl("col", "col-members")}>
            <div className={cl("col-header")}>
                <span className={cl("col-header-text")}>{headerLabel}</span>
                <span
                    className={cl("count-badge")}
                    title={permFilter || globalSearch ? "Members loaded so far (Discord loads members lazily)" : undefined}
                >
                    {memberIds.length}
                </span>
            </div>
            {showSearch && <ColumnSearch value={search} onChange={setSearch} placeholder="Search all members…" />}

            <ScrollerThin className={cl("col-scroller")} orientation="auto">
                {memberIds.length === 0
                    ? <div className={cl("empty")}><Paragraph size="md">{globalSearch ? "No members found." : "No members to show."}</Paragraph></div>
                    : memberIds.map(id => <MemberRow key={id} guildId={guild.id} userId={id} onSelect={onSelectUser} active={id === activeUserId} />)}
            </ScrollerThin>
        </div>
    );
}

function MemberRow({ guildId, userId, onSelect, active }: { guildId: string; userId: string; onSelect: (userId: string) => void; active: boolean; }) {
    const member = GuildMemberStore.getMember(guildId, userId);
    const user = UserStore.getUser(userId);
    const avatar = user?.getAvatarURL(guildId, 24, false) ?? IconUtils.getDefaultAvatarURL(userId);

    return (
        <div
            className={cl("list-item", { "list-item-active": active })}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(userId)}
            onKeyDown={onActivateKey(() => onSelect(userId))}
        >
            <img className={cl("member-avatar")} src={avatar} alt="" />
            <Paragraph size="md" className={cl("list-item-text")}>{memberName(member, userId)}</Paragraph>
            <button
                className={cl("row-action")}
                aria-label="Open profile"
                onClick={e => { e.stopPropagation(); void openProfileInGuild(userId, guildId).catch(() => { }); }}
            >
                <ProfileIcon />
            </button>
        </div>
    );
}
