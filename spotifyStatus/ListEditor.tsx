/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { SYM_GET_RAW_TARGET } from "@shared/SettingsStore";
import { classNameFactory } from "@utils/css";
import { useEffect, useReducer, useRef, useState } from "@webpack/common";

const cl = classNameFactory("vc-sps-");

/** Rows rendered at a time when expanded, so a list of thousands (playlist imports) doesn't render all at once. */
const PAGE = 200;

interface Props {
    title: string;
    description: string;
    placeholder: string;
    list: string[];
}

// Stable ids per row, tracked out-of-band so removing middle rows doesn't scramble React keys
// (a known gotcha with index-as-key in editable lists). Keyed by the settings' raw array: every read of
// a settings array is a new Proxy, so keying by the proxy gave new ids (and remounted rows) on each render.
const idMap = new WeakMap<string[], string[]>();
function getIds(list: string[]): string[] {
    const key: string[] = (list as any)[SYM_GET_RAW_TARGET] ?? list;
    let ids = idMap.get(key);
    if (!ids) { ids = list.map(() => crypto.randomUUID()); idMap.set(key, ids); }
    while (ids.length < list.length) ids.push(crypto.randomUUID());
    while (ids.length > list.length) ids.pop();
    return ids;
}

let nextListId = 0;

function Chevron({ open }: { open: boolean; }) {
    return (
        <svg className={cl("chevron", { "chevron-open": open })} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ListEditor({ title, description, placeholder, list }: Props) {
    const [open, setOpen] = useState(false);
    const [shown, setShown] = useState(PAGE);
    const [draft, setDraft] = useState("");
    const [note, setNote] = useState("");
    const [, bump] = useReducer((n: number) => n + 1, 0);
    const [listId] = useState(() => `vc-sps-list-${++nextListId}`);
    const rowsRef = useRef<HTMLDivElement>(null);
    const addRef = useRef<HTMLInputElement>(null);
    const scrollToEnd = useRef(false);
    /** Row index whose remove button gets focus after a keyboard removal (the row that moved up into its place). */
    const focusRow = useRef<number | null>(null);
    const ids = getIds(list);
    const count = list.length;

    useEffect(() => {
        // After adding while expanded, show the new row at the bottom of the scroll area.
        if (scrollToEnd.current) {
            scrollToEnd.current = false;
            const el = rowsRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        }
        // After removing a row with the keyboard, keep focus in the list: the next row's remove button,
        // or the add field when it was the last row.
        if (focusRow.current !== null) {
            const i = focusRow.current;
            focusRow.current = null;
            const next = rowsRef.current?.querySelectorAll<HTMLButtonElement>(`.${cl("list-remove")}`)[i];
            (next ?? addRef.current)?.focus();
        }
    });

    const setAt = (id: string, v: string) => {
        const i = ids.indexOf(id);
        if (i !== -1) { list[i] = v; bump(); }
    };
    const removeAt = (id: string, byKeyboard: boolean) => {
        const i = ids.indexOf(id);
        if (i === -1) return;
        list.splice(i, 1);
        ids.splice(i, 1);
        if (byKeyboard) focusRow.current = i;
        bump();
    };
    const add = () => {
        const v = draft.trim();
        if (!v) return;
        if (list.some(e => e.trim().toLowerCase() === v.toLowerCase())) {
            setNote(`"${v}" is already in the list.`);
            return;
        }
        list.push(v);
        ids.push(crypto.randomUUID());
        setDraft("");
        setNote(`Added "${v}".`);
        if (open && count < shown) scrollToEnd.current = true;
        bump();
    };

    return (
        <div className={cl("list")}>
            <h3 className={cl("list-heading")}>
                <button
                    type="button"
                    className={cl("list-toggle")}
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => setOpen(o => !o)}
                >
                    <Chevron open={open} />
                    <span>{title}</span>
                    <span className={cl("list-count")}>({count})</span>
                </button>
            </h3>
            <div className={cl("field-hint")}>{description}</div>
            <div className={cl("list-add")}>
                <input
                    ref={addRef}
                    className={cl("input")}
                    type="text"
                    value={draft}
                    placeholder={placeholder}
                    aria-label={`Add to ${title}`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={e => { setDraft(e.currentTarget.value); setNote(""); }}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
                />
                <Button size="small" onClick={add} disabled={!draft.trim()}>Add</Button>
            </div>
            {note && <div className={cl("list-note")} role="status">{note}</div>}
            <div id={listId} ref={rowsRef} className={cl("list-rows")} hidden={!open}>
                {open && (count === 0
                    ? <div className={cl("list-empty")}>Nothing here yet.</div>
                    : (
                        <>
                            {list.slice(0, shown).map((value, i) => (
                                <Row
                                    key={ids[i]}
                                    placeholder={placeholder}
                                    initialValue={value}
                                    onCommit={v => setAt(ids[i], v)}
                                    onRemove={byKeyboard => removeAt(ids[i], byKeyboard)}
                                />
                            ))}
                            {count > shown && (
                                <Button variant="secondary" size="small" onClick={() => setShown(n => n + PAGE)}>
                                    Show {Math.min(PAGE, count - shown)} more ({count - shown} hidden)
                                </Button>
                            )}
                        </>
                    ))}
            </div>
        </div>
    );
}

function Row({ placeholder, initialValue, onCommit, onRemove }: {
    placeholder: string;
    initialValue: string;
    onCommit(v: string): void;
    /** byKeyboard: activated with Enter or Space (a click event with detail 0). */
    onRemove(byKeyboard: boolean): void;
}) {
    const [value, setValue] = useState(initialValue);
    const label = initialValue || "empty entry";
    return (
        <div className={cl("list-row")}>
            <input
                className={cl("input")}
                type="text"
                value={value}
                placeholder={placeholder}
                aria-label={`Edit ${label}`}
                spellCheck={false}
                autoComplete="off"
                onChange={e => setValue(e.currentTarget.value)}
                onBlur={() => value !== initialValue && onCommit(value)}
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
            <button type="button" className={cl("list-remove")} aria-label={`Remove ${label}`} title="Remove" onClick={e => onRemove(e.detail === 0)}>
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
                </svg>
            </button>
        </div>
    );
}
