/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ClearIcon, SearchIcon } from "./icons";
import { cl } from "./utils";

interface ColumnSearchProps {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
}

export function ColumnSearch({ value, onChange, placeholder }: ColumnSearchProps) {
    return (
        <div className={cl("search")}>
            <SearchIcon className={cl("search-icon")} />
            <input
                className={cl("search-input")}
                placeholder={placeholder}
                value={value}
                spellCheck={false}
                onChange={e => onChange(e.currentTarget.value)}
            />
            {value.length > 0 && (
                <button className={cl("search-clear")} onClick={() => onChange("")} aria-label="Clear search">
                    <ClearIcon />
                </button>
            )}
        </div>
    );
}
