/**
 * Lightweight content-pattern inference. Maus.app does its own pattern
 * classification at copy time (see copy_events.content_pattern) but that
 * value is not stored on the items table — it lives in the analytics
 * pipeline only. We infer a coarse pattern from the row content here so
 * the MCP can offer the same filter semantics without touching Maus's
 * schema.
 *
 * Categories match what Maus's analytics uses, so users who got used to
 * `#code` / `#url` filters in the app see the same names from the MCP.
 */

import type { ItemRow } from "./db.ts";

export type ContentPattern =
  | "image"
  | "file"
  | "url"
  | "code"
  | "password"
  | "email"
  | "phone"
  | "color"
  | "single_word"
  | "short_text"
  | "long_text";

const URL_RE = /^https?:\/\/\S+$/;
const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
const PHONE_RE = /^\+?[\d][\d\s\-().]{6,19}$/;
const COLOR_RE = /^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3}([A-Fa-f0-9]{2})?)?$|^rgba?\([^)]+\)$|^hsla?\([^)]+\)$/;
// Hex-like long random strings — looks like API keys / tokens / hashes.
// Tight enough to avoid matching real prose.
const SECRET_RE = /^[A-Za-z0-9+/=_-]{24,}$/;
// Code heuristic: braces, semicolons, indented lines.
const CODE_HINTS = /[{};]|^\s{2,}/m;

export function inferContentPattern(row: Pick<ItemRow, "type" | "text_content">): ContentPattern {
  if (row.type === "image") return "image";
  if (row.type === "file") return "file";
  if (row.type === "link") return "url";

  const raw = (row.text_content ?? "").trim();
  if (raw.length === 0) return "short_text";

  if (URL_RE.test(raw)) return "url";
  if (EMAIL_RE.test(raw)) return "email";
  if (PHONE_RE.test(raw)) return "phone";
  if (COLOR_RE.test(raw)) return "color";

  // Code first: multi-line with structural hints
  const lines = raw.split("\n");
  if (lines.length > 1 && CODE_HINTS.test(raw)) return "code";

  // Single token short, no whitespace inside → single_word
  if (!/\s/.test(raw) && raw.length <= 30) {
    if (SECRET_RE.test(raw) && raw.length >= 32) return "password";
    return "single_word";
  }

  if (raw.length > 200) return "long_text";
  return "short_text";
}
