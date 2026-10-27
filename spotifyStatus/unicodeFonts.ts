/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type FontStyle =
    | "none"
    | "bold"
    | "italic"
    | "boldItalic"
    | "script"
    | "boldScript"
    | "fraktur"
    | "doubleStruck"
    | "monospace"
    | "smallCaps"
    | "fullwidth"
    | "circled"
    | "squared";

// Build a map by offsetting from the base ASCII code point to a target Unicode block.
// A char is transformed only if it lies in the source range; otherwise passed through.
interface Range {
    from: number;
    to: number;
    target: number; // code point where the target range starts
}

const ranges: Record<FontStyle, Range[]> = {
    none: [],
    bold: [
        { from: 0x41, to: 0x5a, target: 0x1d400 }, // A-Z -> 𝐀-𝐙
        { from: 0x61, to: 0x7a, target: 0x1d41a }, // a-z
        { from: 0x30, to: 0x39, target: 0x1d7ce }, // 0-9
    ],
    italic: [
        { from: 0x41, to: 0x5a, target: 0x1d434 },
        { from: 0x61, to: 0x7a, target: 0x1d44e },
    ],
    boldItalic: [
        { from: 0x41, to: 0x5a, target: 0x1d468 },
        { from: 0x61, to: 0x7a, target: 0x1d482 },
    ],
    script: [
        { from: 0x41, to: 0x5a, target: 0x1d49c },
        { from: 0x61, to: 0x7a, target: 0x1d4b6 },
    ],
    boldScript: [
        { from: 0x41, to: 0x5a, target: 0x1d4d0 },
        { from: 0x61, to: 0x7a, target: 0x1d4ea },
    ],
    fraktur: [
        { from: 0x41, to: 0x5a, target: 0x1d504 },
        { from: 0x61, to: 0x7a, target: 0x1d51e },
    ],
    doubleStruck: [
        { from: 0x41, to: 0x5a, target: 0x1d538 },
        { from: 0x61, to: 0x7a, target: 0x1d552 },
        { from: 0x30, to: 0x39, target: 0x1d7d8 },
    ],
    monospace: [
        { from: 0x41, to: 0x5a, target: 0x1d670 },
        { from: 0x61, to: 0x7a, target: 0x1d68a },
        { from: 0x30, to: 0x39, target: 0x1d7f6 },
    ],
    smallCaps: [
        // small caps in Unicode aren't contiguous; handled via explicit map below
    ],
    fullwidth: [
        { from: 0x21, to: 0x7e, target: 0xff01 }, // ! to ~ -> fullwidth forms
    ],
    circled: [
        { from: 0x41, to: 0x5a, target: 0x24b6 }, // Ⓐ-Ⓩ
        { from: 0x61, to: 0x7a, target: 0x24d0 }, // ⓐ-ⓩ
        { from: 0x31, to: 0x39, target: 0x2460 }, // ①-⑨
    ],
    squared: [
        { from: 0x41, to: 0x5a, target: 0x1f130 }, // 🅰-🆉
    ],
};

// Unicode has no tidy contiguous block for small caps; these are the canonical mappings.
const smallCapsMap: Record<string, string> = {
    a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ",
    i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ",
    q: "ǫ", r: "ʀ", s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x",
    y: "ʏ", z: "ᴢ",
};

// Some code points in the Mathematical Alphanumeric Symbols block are
// reserved and the actual glyph lives elsewhere (e.g. italic h at U+210E).
const mathSymbolHoles: Record<number, string> = {
    0x1d455: "\u210E", // italic h
    0x1d49d: "\u212C", // script B
    0x1d4a0: "\u2130", // script E
    0x1d4a1: "\u2131", // script F
    0x1d4a3: "\u210B", // script H
    0x1d4a4: "\u2110", // script I
    0x1d4a7: "\u2112", // script L
    0x1d4a8: "\u2133", // script M
    0x1d4ad: "\u211B", // script R
    0x1d4ba: "\u212F", // script e
    0x1d4bc: "\u210A", // script g
    0x1d4c4: "\u2134", // script o
    0x1d506: "\u212D", // fraktur C
    0x1d50b: "\u210C", // fraktur H
    0x1d50c: "\u2111", // fraktur I
    0x1d515: "\u211C", // fraktur R
    0x1d51d: "\u2128", // fraktur Z
    0x1d53a: "\u2102", // double-struck C
    0x1d53f: "\u210D",
    0x1d545: "\u2115",
    0x1d547: "\u2119",
    0x1d548: "\u211A",
    0x1d549: "\u211D",
    0x1d551: "\u2124",
};

export function applyFont(text: string, style: FontStyle): string {
    if (style === "none" || !text) return text;

    if (style === "smallCaps") {
        return text.replace(/[a-zA-Z]/g, c => smallCapsMap[c.toLowerCase()] ?? c);
    }

    const rules = ranges[style];
    if (!rules.length) return text;

    let out = "";
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        let mapped: string | null = null;
        for (const r of rules) {
            if (cp >= r.from && cp <= r.to) {
                const target = r.target + (cp - r.from);
                mapped = mathSymbolHoles[target] ?? String.fromCodePoint(target);
                break;
            }
        }
        out += mapped ?? ch;
    }
    return out;
}
