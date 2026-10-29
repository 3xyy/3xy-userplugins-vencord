/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { InfoIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Guild, Permissions } from "@vencord/discord-types";
import { GuildMemberStore, GuildRoleStore, PermissionsBits, ScrollerThin, Tooltip, useMemo, useState, useStateFromStores } from "@webpack/common";

import { PermissionAllowedIcon, PermissionDeniedIcon } from "./icons";
import type { PermFilter } from "./modal";
import { permissionIcons, PermSortOrder, sortPermissionEntries } from "./permissions";
import { ColumnSearch } from "./SearchBar";
import { cl, computeEffectivePermissions, getPermissionDescription, onActivateKey, Selection } from "./utils";

interface PermissionsColumnProps {
    guild: Guild;
    selection: Selection;
    permFilter: PermFilter | null;
    specMap: Record<string, { title: string; description: string | ((...args: any[]) => string); }>;
    showPermissionIcons: boolean;
    sortOrder: PermSortOrder;
    showSearch: boolean;
    onTogglePerm: (bit: bigint, title: string) => void;
}

export function PermissionsColumn({ guild, selection, permFilter, specMap, showPermissionIcons, sortOrder, showSearch, onTogglePerm }: PermissionsColumnProps) {
    const [search, setSearch] = useState("");

    // Effective permissions of the current selection (role / owner / user). Reactive to role + member changes.
    const permissions = useStateFromStores(
        [GuildRoleStore, GuildMemberStore],
        () => computeEffectivePermissions(guild, selection),
        [guild.id, selection]
    );

    const orderedPerms = useMemo(
        () => sortPermissionEntries(Object.entries(PermissionsBits), sortOrder, specMap),
        [sortOrder, specMap]
    );

    const q = search.toLowerCase();
    const visiblePerms = q
        ? orderedPerms.filter(([name, bit]) => (specMap[String(bit)]?.title ?? name).toLowerCase().includes(q))
        : orderedPerms;

    return (
        <div className={cl("col", "col-perms")}>
            <div className={cl("col-header")}>
                <span className={cl("col-header-text")}>Permissions</span>
            </div>
            {showSearch && <ColumnSearch value={search} onChange={setSearch} placeholder="Search permissions…" />}

            <ScrollerThin className={cl("col-scroller")} orientation="auto">
                {visiblePerms.length === 0
                    ? <div className={cl("empty")}><Paragraph size="md">No permissions match.</Paragraph></div>
                    : visiblePerms.map(([name, bit]) => {
                        const granted = (permissions & bit) === bit;
                        const Glyph = showPermissionIcons ? permissionIcons[name as Permissions] : undefined;
                        const spec = specMap[String(bit)];
                        const title = spec?.title ?? name;

                        return (
                            <div
                                key={String(bit)}
                                role="button"
                                tabIndex={0}
                                className={cl("perms-item", { "perms-item-active": permFilter?.bit === bit })}
                                onClick={() => onTogglePerm(bit, title)}
                                onKeyDown={onActivateKey(() => onTogglePerm(bit, title))}
                            >
                                <div className={cl("perms-item-icon")}>
                                    {granted ? <PermissionAllowedIcon /> : <PermissionDeniedIcon />}
                                </div>
                                {Glyph != null && <Glyph />}
                                <Paragraph size="md" className={cl("perms-item-text")}>{title}</Paragraph>
                                <Tooltip text={getPermissionDescription(spec)}>
                                    {props => <InfoIcon {...props} />}
                                </Tooltip>
                            </div>
                        );
                    })}
            </ScrollerThin>
        </div>
    );
}
