/**
 * get(id, want?) — return one item by id.
 *
 * For text/link/file items, content is returned directly.
 * For image items, the response shape depends on `want`:
 *   - "text"   → ocr_text + image_metadata (no image bytes)
 *   - "visual" → reduced_image_b64 + image_metadata (no OCR)
 *   - "both"   → ocr_text + reduced_image_b64 + image_metadata (default)
 *
 * OCR text for image items lives in a SIBLING text item created by Maus.app
 * at the same timestamp + source_app (see ClipboardManager.swift ~line 475).
 * We resolve it via that join.
 *
 * Tier: if Free and the item is >24h old, returns not_accessible. The MCP is
 * a window into what the user sees in their tier — same scope as the Maus UI.
 */

import { db, ItemRow } from "./db.ts";
import { isFree } from "./tier.ts";
import { detectImageExtension, getImageDimensions, reduceImage } from "./image.ts";

const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const UPGRADE_URL = "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

function isOlderThan24h(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  if (isNaN(t)) return false;
  return Date.now() - t > TWENTYFOUR_HOURS_MS;
}

/**
 * Find the OCR-extracted text sibling of an image item. Maus stores OCR as
 * a separate text item with identical created_at + source_app — see
 * ClipboardManager.swift around line 475.
 */
function findOCRSibling(imageId: number): string | null {
  const parent = db.prepare(
    "SELECT created_at, source_app FROM items WHERE id = ?",
  ).get(imageId) as { created_at: string; source_app: string | null } | undefined;
  if (!parent) return null;

  // Match created_at exactly. Handle null source_app explicitly because
  // SQL `= NULL` doesn't match.
  const sql = parent.source_app === null
    ? `SELECT text_content FROM items
       WHERE type='text' AND created_at=? AND source_app IS NULL AND id != ?
       LIMIT 1`
    : `SELECT text_content FROM items
       WHERE type='text' AND created_at=? AND source_app=? AND id != ?
       LIMIT 1`;

  const params = parent.source_app === null
    ? [parent.created_at, imageId]
    : [parent.created_at, parent.source_app, imageId];

  const row = db.prepare(sql).get(...params) as { text_content: string | null } | undefined;
  return row?.text_content ?? null;
}

export type GetArgs = {
  id: number;
  want?: "text" | "visual" | "both";
};

export type GetResult =
  | { error: { code: string; message: string; upgrade_url?: string } }
  | TextResult
  | LinkResult
  | FileResult
  | ImageResult;

type Base = {
  id: number;
  type: string;
  preview: string;
  source_app: string | null;
  source_url: string | null;
  created_at: string;
  is_pinned: boolean;
  custom_title: string | null;
};

type TextResult = Base & {
  content: string | null;
  content_size: number;
};

type LinkResult = Base & {
  content: string | null;
  link_url: string | null;
  content_size: number;
};

type FileResult = Base & {
  file_path: string | null;
};

type ImageResult = Base & {
  image_metadata: {
    format: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
  } | null;
  ocr_text?: string | null;
  reduced_image_b64?: string;
  maus_note?: string;
};

export function get(args: GetArgs): GetResult {
  if (typeof args.id !== "number" || !Number.isFinite(args.id)) {
    return { error: { code: "invalid_args", message: "id must be a finite number" } };
  }
  const want = args.want ?? "both";
  if (want !== "text" && want !== "visual" && want !== "both") {
    return { error: { code: "invalid_args", message: "want must be 'text', 'visual', or 'both'" } };
  }

  const row = db.prepare(`
    SELECT id, type, text_content, image_data, preview, source_app, source_url,
           created_at, is_pinned, file_path, link_url, custom_title
    FROM items WHERE id = ?
  `).get(args.id) as ItemRow | undefined;

  if (!row) {
    return { error: { code: "not_found", message: `item ${args.id} not found` } };
  }

  if (isFree() && isOlderThan24h(row.created_at)) {
    return {
      error: {
        code: "not_accessible",
        message: "Item is beyond the 24h window. Upgrade to Maus Pro for full history access.",
        upgrade_url: UPGRADE_URL,
      },
    };
  }

  const base: Base = {
    id: row.id,
    type: row.type,
    preview: row.preview,
    source_app: row.source_app,
    source_url: row.source_url,
    created_at: row.created_at,
    is_pinned: row.is_pinned === 1,
    custom_title: row.custom_title,
  };

  if (row.type === "text") {
    return {
      ...base,
      content: row.text_content,
      content_size: Buffer.byteLength(row.text_content ?? "", "utf8"),
    };
  }

  if (row.type === "link") {
    return {
      ...base,
      content: row.text_content,
      link_url: row.link_url,
      content_size: Buffer.byteLength(row.text_content ?? "", "utf8"),
    };
  }

  if (row.type === "file") {
    return {
      ...base,
      file_path: row.file_path,
    };
  }

  if (row.type === "image") {
    const result: ImageResult = { ...base, image_metadata: null };

    if (row.image_data) {
      const dims = getImageDimensions(row.image_data);
      result.image_metadata = {
        format: detectImageExtension(row.image_data),
        size_bytes: row.image_data.length,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      };
    }

    if (want === "text" || want === "both") {
      result.ocr_text = findOCRSibling(row.id);
    }

    if ((want === "visual" || want === "both") && row.image_data) {
      const reduced = reduceImage(row.image_data, 800, 80);
      if (reduced) {
        result.reduced_image_b64 = reduced.data.toString("base64");
        const w = result.image_metadata?.width ?? "?";
        const h = result.image_metadata?.height ?? "?";
        const origKB = Math.round(reduced.orig_size / 1024);
        const reducedKB = Math.round(reduced.reduced_size / 1024);
        result.maus_note = `Maus reduced ${w}x${h} (~${origKB}KB) to longest-side ≤800 JPEG q80 (~${reducedKB}KB) to save tokens.`;
      }
    }

    return result;
  }

  return { error: { code: "unknown_type", message: `unknown item type: ${row.type}` } };
}
