/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Guild, Role } from "@vencord/discord-types";
import { extractAndLoadChunksLazy, findByPropsLazy } from "@webpack";
import { GuildMemberStore, GuildRoleStore, i18n, PermissionsBits } from "@webpack/common";
import type { KeyboardEvent } from "react";

export const cl = classNameFactory("vc-rolemembers-");
export const logger = new Logger("RoleMembers");

// Self-contained copies of PermissionsViewer's spec-map finders so this plugin doesn't depend on it.
export const loadGetGuildPermissionSpecMap = extractAndLoadChunksLazy([".PRIMARY,badgeTooltipDelay:"]);
export const { getGuildPermissionSpecMap } = findByPropsLazy("getGuildPermissionSpecMap");

// A row in the Roles column.
export type ColumnItem =
    | { kind: "owner"; userId: string; }
    | { kind: "role"; role: Role; };

// The active selection that drives the Permissions column (and, without a perm filter, the Members column).
export type Selection =
    | { kind: "owner"; }
    | { kind: "role"; roleId: string; }
    | { kind: "user"; userId: string; };

export const itemKey = (item: ColumnItem) => item.kind === "owner" ? "owner" : item.role.id;

export function itemToSelection(item: ColumnItem): Selection {
    return item.kind === "owner" ? { kind: "owner" } : { kind: "role", roleId: item.role.id };
}

export function isItemActive(item: ColumnItem, sel: Selection): boolean {
    if (item.kind === "owner") return sel.kind === "owner";
    return sel.kind === "role" && sel.roleId === item.role.id;
}

/** Owner pinned at top, then roles sorted by position (highest first; @everyone ends up last). */
export function buildColumnItems(guild: Guild): ColumnItem[] {
    const roles = [...GuildRoleStore.getSortedRoles(guild.id)].sort((a, b) => b.position - a.position);
    return [
        { kind: "owner", userId: guild.ownerId },
        ...roles.map(role => ({ kind: "role", role } as const))
    ];
}

/** The full permission bitfield, which is what the owner (and admins) effectively have. */
export function getAllPermissions(): bigint {
    return Object.values(PermissionsBits).reduce((prev, curr) => prev | curr, 0n);
}

/** Administrator bypasses every permission check, so it implies every permission. */
function withAdminBypass(perms: bigint): bigint {
    const admin = PermissionsBits.ADMINISTRATOR;
    return (perms & admin) === admin ? getAllPermissions() : perms;
}

/**
 * Effective permission bits for the current selection: owner ⇒ everything; a role ⇒ its bits, or everything
 * if it has Administrator; a user ⇒ OR of @everyone and their roles, or everything if that includes Administrator.
 */
export function computeEffectivePermissions(guild: Guild, sel: Selection): bigint {
    if (sel.kind === "owner") return getAllPermissions();

    const snapshot = GuildRoleStore.getRolesSnapshot(guild.id);
    if (sel.kind === "role") return withAdminBypass(snapshot[sel.roleId]?.permissions ?? 0n);

    // user
    if (guild.ownerId === sel.userId) return getAllPermissions();
    const member = GuildMemberStore.getMember(guild.id, sel.userId);
    let perms = snapshot[guild.id]?.permissions ?? 0n; // @everyone
    for (const id of member?.roles ?? []) perms |= snapshot[id]?.permissions ?? 0n;
    return withAdminBypass(perms);
}

/** A user's roles (including @everyone), sorted highest-first. */
export function getUserRoles(guild: Guild, userId: string): Role[] {
    const snapshot = GuildRoleStore.getRolesSnapshot(guild.id);
    const member = GuildMemberStore.getMember(guild.id, userId);
    const roles = (member?.roles ?? []).map(id => snapshot[id]).filter(Boolean);
    const everyone = snapshot[guild.id];
    if (everyone) roles.push(everyone);
    return roles.sort((a, b) => b.position - a.position);
}

/**
 * Whether a role's permissions grant `bit`: literally, or through Administrator (which bypasses every
 * permission check). Same rule as computeEffectivePermissions (withAdminBypass) for roles and users.
 */
function roleGrants(perms: bigint, bit: bigint): boolean {
    const admin = PermissionsBits.ADMINISTRATOR;
    return (perms & bit) === bit || (perms & admin) === admin;
}

/** Roles that grant a given permission bit (directly or via Administrator), sorted highest-first. */
export function getRolesWithPermission(guild: Guild, bit: bigint): Role[] {
    return [...GuildRoleStore.getSortedRoles(guild.id)]
        .filter(role => roleGrants(role.permissions, bit))
        .sort((a, b) => b.position - a.position);
}

/**
 * Member ids who have the permission: the owner, plus members with a role granting it (directly or via
 * Administrator); everyone if @everyone grants it.
 */
export function getMembersWithPermission(guild: Guild, bit: bigint): string[] {
    const snapshot = GuildRoleStore.getRolesSnapshot(guild.id);
    const everyoneHas = roleGrants(snapshot[guild.id]?.permissions ?? 0n, bit);
    const rolesWith = new Set(Object.values(snapshot).filter(role => roleGrants(role.permissions, bit)).map(role => role.id));

    const ids = new Set<string>([guild.ownerId]); // the owner has every permission
    for (const member of GuildMemberStore.getMembers(guild.id))
        if (everyoneHas || member.roles.some(roleId => rolesWith.has(roleId))) ids.add(member.userId);
    return [...ids];
}

/** onKeyDown for a `role="button"` row: Enter/Space activate it (ignores keys from buttons inside the row). */
export function onActivateKey(activate: () => void) {
    return (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
        }
    };
}

interface PermissionSpec {
    title: string;
    description: string | ((...args: any[]) => string);
}

export function getPermissionDescription(spec: PermissionSpec | undefined): string {
    if (!spec) return "";
    const { description } = spec;
    return typeof description === "function" ? i18n.intl.format(description, {}) : description;
}
