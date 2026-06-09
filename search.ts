/**
 * search(query, ...filters) — substring search across all queryable fields,
 * including OCR text from image siblings.
 *
 * The match surface is:
 *   - text_content, preview, custom_title (the item's own content)
 *   - source_app, source_url, link_url, file_path (its metadata)
 *   - the text_content of the OCR sibling for image items (Maus stores OCR
 *     output as a separate text item; matching it surfaces the image too)
 *
 * Tier rules identical to list_recent:
 *   - Free: `since` clamped to ≥ now-24h; `source_apps` and
 *     `content_patterns` filters dropped, surfaced via `limited_by_tier`.
 *   - Pro: all filters honoured.
 *
 * Ranking: chronological (created_at DESC). No relevance scoring in v1 —
 * substring matches don't really have a meaningful score, and the agent
 * does the semantic ranking itself once it sees the candidates.
 */

import { db, ItemRow } from "./db.ts";
import { isFree } from "./tier.ts";
import { inferContentPattern, type ContentPattern } from "./pattern.ts";

const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_QUERY_LEN = 2;
const UPGRADE_URL =
  "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

export type SearchArgs = {
  query: string;
  limit?: number;
  since?: string;
  until?: string;
  source_apps?: string[];
  content_patterns?: ContentPattern[] | string[];
  type?: "text" | "image" | "link" | "file";
};

type LimitedByTier = {
  message: string;
  features_blocked: string[];
  upgrade_url: string;
};

type SearchItem = {
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
  matched_in: ("content" | "title" | "source" | "url" | "ocr")[];
};

export type SearchResult =
  | { error: { code: string; message: string } }
  | {
      items: SearchItem[];
      capped: boolean;
      limited_by_tier?: LimitedByTier;
    };

function isoNowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function ocrPreviewFor(imageRow: { id: number; created_at: string; source_app: string | null }, maxChars = 200): string | null {
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
  const row = db.prepare(sql).get(...params) as { text_content: string | null } | undefined;
  return row?.text_content?.slice(0, maxChars) ?? null;
}

/**
 * Compute where the query matched on a given row. Used to populate
 * matched_in so the agent can verbalise "found in OCR text" vs "found in
 * the source URL" etc.
 */
function whereMatched(
  row: { type: string; text_content: string | null; preview: string; custom_title: string | null;
         source_app: string | null; source_url: string | null; link_url: string | null;
         file_path: string | null },
  q: string,
  ocrText: string | null,
): SearchItem["matched_in"] {
  const ql = q.toLowerCase();
  const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(ql);
  const where: SearchItem["matched_in"] = [];
  if (has(row.text_content) || has(row.preview)) where.push("content");
  if (has(row.custom_title)) where.push("title");
  if (has(row.source_app)) where.push("source");
  if (has(row.source_url) || has(row.link_url) || has(row.file_path)) where.push("url");
  if (has(ocrText)) where.push("ocr");
  return where;
}

export function search(args: SearchArgs): SearchResult {
  if (!args.query || typeof args.query !== "string") {
    return { error: { code: "invalid_args", message: "query is required" } };
  }
  const q = args.query.trim();
  if (q.length < MIN_QUERY_LEN) {
    return {
      error: { code: "invalid_args", message: `query must be at least ${MIN_QUERY_LEN} chars` },
    };
  }

  const free = isFree();

  const requestedLimit = typeof args.limit === "number" && args.limit > 0
    ? Math.floor(args.limit)
    : DEFAULT_LIMIT;
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  const blockedFeatures: string[] = [];
  let since = args.since;
  if (free) {
    const floor = isoNowMinus(TWENTYFOUR_HOURS_MS);
    if (!since || since < floor) {
      if (since && since < floor) blockedFeatures.push("since>24h");
      since = floor;
    }
    if (args.source_apps?.length) blockedFeatures.push("source_apps filter");
    if (args.content_patterns?.length) blockedFeatures.push("content_patterns filter");
  }

  const like = `%${q.toLowerCase()}%`;

  // Build the structural filters that apply to both queries below.
  const filterClauses: string[] = [];
  const filterParams: (string | number)[] = [];
  if (since) {
    filterClauses.push("created_at >= ?");
    filterParams.push(since);
  }
  if (args.until) {
    filterClauses.push("created_at < ?");
    filterParams.push(args.until);
  }
  if (args.type) {
    filterClauses.push("type = ?");
    filterParams.push(args.type);
  }
  if (!free && args.source_apps?.length) {
    filterClauses.push(
      `source_app IN (${args.source_apps.map(() => "?").join(",")})`,
    );
    filterParams.push(...args.source_apps);
  }
  const baseWhere = filterClauses.length ? `AND ${filterClauses.join(" AND ")}` : "";

  // Query 1: direct match on the item's own fields.
  const directSql = `
    SELECT id, type, text_content, preview, source_app, source_url,
           created_at, is_pinned, file_path, link_url, custom_title,
           LENGTH(image_data) AS image_data_size
    FROM items
    WHERE (
      LOWER(text_content) LIKE ? OR
      LOWER(preview)      LIKE ? OR
      LOWER(custom_title) LIKE ? OR
      LOWER(source_app)   LIKE ? OR
      LOWER(source_url)   LIKE ? OR
      LOWER(link_url)     LIKE ? OR
      LOWER(file_path)    LIKE ?
    )
    ${baseWhere}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  const overFetch = Math.min(limit * 3, MAX_LIMIT * 3);
  const directRows = db.prepare(directSql).all(
    like, like, like, like, like, like, like,
    ...filterParams,
    overFetch,
  ) as Array<Omit<ItemRow, "image_data"> & { image_data_size: number | null }>;

  // Query 2: image items whose OCR sibling matches. Only run if no type
  // filter or type=image. Skips work when the user explicitly asked for
  // text/link/file only.
  let ocrRows: typeof directRows = [];
  if (!args.type || args.type === "image") {
    const ocrSql = `
      SELECT i.id, i.type, i.text_content, i.preview, i.source_app, i.source_url,
             i.created_at, i.is_pinned, i.file_path, i.link_url, i.custom_title,
             LENGTH(i.image_data) AS image_data_size
      FROM items i
      WHERE i.type = 'image'
        AND EXISTS (
          SELECT 1 FROM items t
          WHERE t.type = 'text'
            AND t.created_at = i.created_at
            AND ((t.source_app IS NULL AND i.source_app IS NULL)
                 OR t.source_app = i.source_app)
            AND t.id != i.id
            AND LOWER(t.text_content) LIKE ?
        )
        ${baseWhere.replaceAll("source_app", "i.source_app")
                   .replaceAll("created_at", "i.created_at")
                   .replaceAll("type =", "i.type =")}
      ORDER BY i.created_at DESC
      LIMIT ?
    `;
    ocrRows = db.prepare(ocrSql).all(
      like,
      ...filterParams,
      overFetch,
    ) as typeof directRows;
  }

  // Merge by id, preserving first occurrence (direct matches first since
  // they're more "direct" semantically).
  const seen = new Set<number>();
  const merged: typeof directRows = [];
  for (const r of [...directRows, ...ocrRows]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push(r);
    }
  }

  // Sort by created_at DESC (since each list was sorted but the merge isn't).
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  // Apply post-fetch content_pattern filter (Pro only).
  const wanted = new Set<string>(args.content_patterns ?? []);
  const willPostFilter = !free && wanted.size > 0;

  const enriched = merged.map(row => ({ row, pattern: inferContentPattern(row) }));
  const filtered = willPostFilter
    ? enriched.filter(e => wanted.has(e.pattern))
    : enriched;

  const capped = filtered.length > limit;
  const slice = filtered.slice(0, limit);

  const items: SearchItem[] = slice.map(({ row, pattern }) => {
    const ocrText = row.type === "image" ? ocrPreviewFor(row) : null;
    const item: SearchItem = {
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
      matched_in: whereMatched(row, q, ocrText),
    };
    if (row.type === "image" && ocrText) {
      item.ocr_preview = ocrText;
    }
    return item;
  });

  const result: SearchResult = { items, capped };
  if (blockedFeatures.length > 0) {
    (result as Exclude<SearchResult, { error: unknown }>).limited_by_tier = {
      message:
        "Some requested options were ignored because you're on Maus Free. " +
        "Upgrade unlocks full history and filters.",
      features_blocked: blockedFeatures,
      upgrade_url: UPGRADE_URL,
    };
  }
  return result;
}
