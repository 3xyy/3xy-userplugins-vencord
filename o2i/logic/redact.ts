/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Export logs" privacy: the Windows home folder becomes %USERPROFILE% and the user name <user> in
// summary.json (value by value: `redactJson`) and the copied logs (as text). Pure (native.ts passes
// os.homedir() / os.userInfo().username).

/** Names shorter than this are only removed as part of the home folder (on their own they'd hit ordinary words). */
const MIN_BARE_NAME = 3;

/** One or more slashes of either style: also matches the doubled backslashes of JSON text. */
const SEP = String.raw`[\\/]+`;
/** A letter, digit or underscore (Unicode): a name or folder that goes on is a different one. */
const WORD = String.raw`[\p{L}\p{N}_]`;

/** Only the syntax characters: the patterns use the `u` flag, where escaping anything else is an error. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A function that replaces, case-insensitively and wherever it appears, `home` written with either
 * slash style (also after a `\\?\` or `\??\` prefix and JSON-escaped) by `%USERPROFILE%`, then the
 * whole-word `user` name by `<user>`. A home of fewer than two path parts (a drive root) is left alone.
 */
export function makeRedactor(home: string | null | undefined, user: string | null | undefined): (text: string) => string {
    const rules: [RegExp, string][] = [];
    const parts = (home ?? "").split(/[\\/]+/).filter(Boolean);
    if (parts.length >= 2) {
        // Not followed by more of a name ("Alexander", "Alex.old"); a sentence's full stop is fine.
        rules.push([new RegExp(`${parts.map(escapeRe).join(SEP)}(?!${WORD}|-|\\.${WORD})`, "giu"), "%USERPROFILE%"]);
    }
    const name = (user ?? "").trim();
    if ([...name].length >= MIN_BARE_NAME) {
        rules.push([new RegExp(`(?<!${WORD})${escapeRe(name)}(?!${WORD})`, "giu"), "<user>"]);
    }
    return text => {
        let out = text;
        for (const [re, to] of rules) out = out.replace(re, to);
        return out;
    };
}

/** Deeper than this is never real summary data; replaced rather than copied unredacted. */
const MAX_JSON_DEPTH = 64;

/**
 * A copy of JSON data (from JSON.parse or plain objects) with `redact` applied to every string value and
 * object key. For summary.json: redacting before JSON.stringify, never the JSON text, so escapes (`\n`,
 * `\t`, `\uXXXX`) can neither hide a name nor be broken by a replacement. Objects come back without a
 * prototype, so a "__proto__" key stays a plain key.
 */
export function redactJson(value: unknown, redact: (text: string) => string, depth = 0): unknown {
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_JSON_DEPTH) return "[too deep]";
    if (Array.isArray(value)) return value.map(v => redactJson(v, redact, depth + 1));
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactJson(v, redact, depth + 1);
    return out;
}
