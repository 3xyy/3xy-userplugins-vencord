/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sanitizeFileName, stripExtension } from "../editor/encode";

// Mirror the constant to assert ordering without running canvas code.
const QUALITY_WALK = [0.92, 0.85, 0.8, 0.7, 0.6, 0.5];
function assert(c: boolean, m: string) { if (!c) throw new Error("FAIL: " + m); }
function eq(actual: string, expected: string, what: string) { assert(actual === expected, `${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }

assert(QUALITY_WALK.every((q, i) => i === 0 || q < QUALITY_WALK[i - 1]), "quality walk descending");
assert(QUALITY_WALK[0] <= 0.92 && QUALITY_WALK[QUALITY_WALK.length - 1] >= 0.4, "quality walk bounds");

// sanitizeFileName: the brief's cases
eq(sanitizeFileName("my pic", "png"), "my pic.png", "plain name");
eq(sanitizeFileName("../a:b?", "webp"), "a_b_.webp", "separators stripped, invalid chars replaced");
eq(sanitizeFileName("   ", "png"), "image.png", "blank falls back to image");
eq(sanitizeFileName("x.png", "jpg"), "x.jpg", "old extension replaced by the save format");

// more edge cases
eq(sanitizeFileName("", "png"), "image.png", "empty falls back to image");
eq(sanitizeFileName("...", "png"), "image.png", "only dots falls back to image");
eq(sanitizeFileName("  name. ", "png"), "name.png", "dots and spaces trimmed");
eq(sanitizeFileName("a\\b/c", "png"), "abc.png", "both separators stripped");
eq(sanitizeFileName("<a>|\"*", "png"), "_a____.png", "every Windows-invalid char replaced");
eq(sanitizeFileName("tab\there\u0000", "png"), "tab_here_.png", "control chars replaced");
eq(sanitizeFileName("photo.JPEG", "webp"), "photo.webp", "image extension stripped regardless of case");
eq(sanitizeFileName("my.vacation", "png"), "my.vacation.png", "a dot inside the name is kept");
eq(sanitizeFileName("con", "png"), "con_.png", "reserved Windows device name gets a suffix");
eq(sanitizeFileName("x".repeat(150), "png"), "x".repeat(100) + ".png", "base capped at 100 chars");
eq(sanitizeFileName("😀".repeat(120), "png"), "😀".repeat(100) + ".png", "cap never splits an emoji");
eq(sanitizeFileName("x".repeat(99) + " y", "png"), "x".repeat(99) + ".png", "trimmed again after the cap");
assert(sanitizeFileName("../a:b?", "webp").endsWith(".webp"), "always ends in the extension");

// stripExtension: the starting value of the file-name field
eq(stripExtension("image.png"), "image", "strip .png");
eq(stripExtension("my.vacation.jpg"), "my.vacation", "only the last extension");
eq(stripExtension("noext"), "noext", "no extension");

console.log("OK");
