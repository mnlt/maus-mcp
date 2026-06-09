/**
 * list_recent(...) — chronological list of recent items, with filters.
 *
 * Returns lightweight summaries (id + metadata + preview). The agent calls
 * get(id) when it needs full content for a specific item.
 *
 * Tier rules (mirroring the user's Maus UI scope):
 *   - Free: `since` is clamped to ≥ now-24h; `source_apps` and
 *     `content_patterns` filters are dropped. The response surfaces a
 *     `limited_by_tier` block so the agent can verbalise the upgrade
 *     opportunity to the user at the right moment.
 *   - Pro: all filters honoured.
 *
 * `content_patterns` is computed on the fly (Maus does not persist the
 * pattern on the items table). To keep the SQL bounded we over-fetch by
 * a factor of 5 (capped) when content_pattern filtering is requested.
 */

import { db, ItemRow } from "./db.ts";
import { isFree } from "./tier.ts";
import { inferContentPattern, type ContentPattern } from "./pattern.ts";

const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const UPGRADE_URL =
  "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

export type ListRecentArgs = {
  limit?: number;
  since?: string; // ISO 8601
  source_apps?: string[];
  content_patterns?: ContentPattern[] | string[];
  type?: "text" | "image" | "link" | "file";
};

type LimitedByTier = {
  message: string;
  features_blocked: string[];
  upgrade_url: string;
};

type ListItem = {
  id: number;
  type: string;
  preview: string;
  ocr_preview?: string | null;
  source_app: string | null;
  source_url: string | null;
  created_at: string;
  is_pinned: boolean;
  content_pattern: ContentPattern;
  content_size: number;
};

export type ListRecentResult = {
  items: ListItem[];
  capped: boolean;
  limited_by_tier?: LimitedByTier;
};

/**
 * For image items, fetch the first chunk of the OCR text from the sibling
 * text item. Returns null when no OCR was extracted.
 */
function ocrPreviewFor(imageRow: ItemRow, maxChars = 200): string | null {
  // Same heuristic as get.ts: same created_at + same source_app, type=text.
  const sql = imageRow.source_app === null
    ? `SELECT text_content FROM items
       WHERE type='text' AND created_at=? AND source_app IS NULL AND id != ?
       LIMIT 1`
    : `SELECT text_content FROM items
       WHERE type='text' AND created_at=? AND source_app=? AND id != ?
       LIMIT 1`;
  const params = imageRow.source_app === null
    ? [imageRow.created_at, imageRow.id]
    : [imageRow.created_at, imageRow.source_app, imageRow.id];
  const row = db.prepare(sql).get(...params) as
    | { text_content: string | null }
    | undefined;
  const text = row?.text_content ?? null;
  if (!text) return null;
  return text.slice(0, maxChars);
}

function isoNowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function list_recent(args: ListRecentArgs = {}): ListRecentResult {
  const free = isFree();

  // Normalize limit
  const requestedLimit = typeof args.limit === "number" && args.limit > 0
    ? Math.floor(args.limit)
    : DEFAULT_LIMIT;
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  // Tier clamps
  const blockedFeatures: string[] = [];
  let since = args.since;

  if (free) {
    const floor = isoNowMinus(TWENTYFOUR_HOURS_MS);
    if (!since || since < floor) {
      if (since && since < floor) blockedFeatures.push("since>24h");
      since = floor;
    }
    if (args.source_apps && args.source_apps.length > 0) {
      blockedFeatures.push("source_apps filter");
    }
    if (args.content_patterns && args.content_patterns.length > 0) {
      blockedFeatures.push("content_patterns filter");
    }
  }

  // Build SQL
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (since) {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (args.type) {
    where.push("type = ?");
    params.push(args.type);
  }
  if (!free && args.source_apps && args.source_apps.length > 0) {
    where.push(`source_app IN (${args.source_apps.map(() => "?").join(",")})`);
    params.push(...args.source_apps);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Over-fetch when we have to post-filter by content_pattern. Cap at MAX_LIMIT*5
  // so we never scan unbounded rows.
  const willPostFilter = !free
    && args.content_patterns
    && args.content_patterns.length > 0;
  const fetchLimit = willPostFilter
    ? Math.min(limit * 5, MAX_LIMIT * 5)
    : limit + 1; // +1 so we can detect `capped`

  // Avoid materialising image_data blobs — we only need their byte length.
  // For large lists this is the difference between ~200ms and ~10ms.
  const sql = `
    SELECT id, type, text_content, preview, source_app, source_url,
           created_at, is_pinned, file_path, link_url, custom_title,
           LENGTH(image_data) AS image_data_size
    FROM items
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ?
  `;

  type RowWithSize = Omit<ItemRow, "image_data"> & { image_data_size: number | null };
  const rows = db.prepare(sql).all(...params, fetchLimit) as RowWithSize[];

  // Compute patterns; post-filter if needed
  const wanted = new Set<string>(args.content_patterns ?? []);
  const enriched = rows.map(row => {
    const pattern = inferContentPattern(row);
    return { row, pattern };
  });
  const filtered = willPostFilter
    ? enriched.filter(e => wanted.has(e.pattern))
    : enriched;

  const capped = filtered.length > limit;
  const slice = filtered.slice(0, limit);

  const items: ListItem[] = slice.map(({ row, pattern }) => {
    const item: ListItem = {
      id: row.id,
      type: row.type,
      preview: row.preview,
      source_app: row.source_app,
      source_url: row.source_url,
      created_at: row.created_at,
      is_pinned: row.is_pinned === 1,
      content_pattern: pattern,
      content_size: row.type === "image"
        ? (row.image_data_size ?? 0)
        : Buffer.byteLength(row.text_content ?? "", "utf8"),
    };
    if (row.type === "image") {
      // `ocrPreviewFor` only uses created_at + source_app + id, so this
      // cast is safe — it doesn't need image_data.
      item.ocr_preview = ocrPreviewFor(row as unknown as ItemRow);
    }
    return item;
  });

  const result: ListRecentResult = { items, capped };
  if (blockedFeatures.length > 0) {
    result.limited_by_tier = {
      message:
        "Some requested options were ignored because you're on Maus Free. " +
        "Upgrade unlocks full history and filters.",
      features_blocked: blockedFeatures,
      upgrade_url: UPGRADE_URL,
    };
  }
  return result;
}
