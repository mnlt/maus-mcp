/**
 * forget(...) — permanently delete one or many items.
 *
 * Two modes share the same signature:
 *   - Surgical: pass `id` for a single item.
 *   - Bulk: pass any combination of since/until/source_apps/content_patterns
 *     to delete a filtered set.
 *
 * Safety belt: callers MUST pass either `id` OR at least one filter. A call
 * with neither raises an error rather than wiping the whole window — that
 * prevents the catastrophic "Claude misunderstood and deleted everything"
 * scenario.
 *
 * Hard delete. The response carries the deleted ids (so the user can spot
 * if the agent erased the wrong thing) but never echoes the content —
 * critical for the privacy use case, where the whole point is making a
 * secret disappear without leaking it into the conversation log.
 *
 * Tier rule: the MCP window matches the user's Maus tier. Free can only
 * forget items it can see (<24h). The since/until range is clamped to that
 * window when Free, with `limited_by_tier` in the response.
 *
 * Pinned items: skipped in bulk by default. Pass `include_pinned: true` to
 * delete them too. For a single-id call, the pin is respected (you asked
 * for that exact item).
 */

import { db } from "./db.ts";
import { isFree } from "./tier.ts";
import { inferContentPattern, type ContentPattern } from "./pattern.ts";

const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_DELETES_PER_CALL = 200;
const UPGRADE_URL =
  "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

export type ForgetArgs = {
  id?: number;
  since?: string;
  until?: string;
  source_apps?: string[];
  content_patterns?: ContentPattern[] | string[];
  include_pinned?: boolean;
};

type LimitedByTier = {
  message: string;
  features_blocked: string[];
  upgrade_url: string;
};

export type ForgetResult =
  | { error: { code: string; message: string; upgrade_url?: string } }
  | {
      deleted_count: number;
      deleted_ids: number[];
      more_remaining: boolean;
      limited_by_tier?: LimitedByTier;
    };

function isoNowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isOlderThan24h(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  if (isNaN(t)) return false;
  return Date.now() - t > TWENTYFOUR_HOURS_MS;
}

export function forget(args: ForgetArgs = {}): ForgetResult {
  const hasId = typeof args.id === "number";
  const hasFilters = !!(
    args.since
    || args.until
    || (args.source_apps && args.source_apps.length > 0)
    || (args.content_patterns && args.content_patterns.length > 0)
  );

  if (!hasId && !hasFilters) {
    return {
      error: {
        code: "invalid_args",
        message:
          "forget requires either `id` or at least one filter (since, until, source_apps, content_patterns). " +
          "Passing neither would risk wiping everything in scope.",
      },
    };
  }

  // ── Single-id mode ───────────────────────────────────────────────────
  if (hasId) {
    const id = args.id as number;
    const row = db.prepare(
      "SELECT id, created_at FROM items WHERE id = ?",
    ).get(id) as { id: number; created_at: string } | undefined;

    if (!row) {
      return { error: { code: "not_found", message: `item ${id} not found` } };
    }
    if (isFree() && isOlderThan24h(row.created_at)) {
      return {
        error: {
          code: "not_accessible",
          message: "Item is beyond the 24h window. Upgrade to Maus Pro to manage older items.",
          upgrade_url: UPGRADE_URL,
        },
      };
    }
    const r = db.prepare("DELETE FROM items WHERE id = ?").run(id);
    const changes = Number(r.changes ?? 0);
    return {
      deleted_count: changes,
      deleted_ids: changes > 0 ? [id] : [],
      more_remaining: false,
    };
  }

  // ── Bulk mode ────────────────────────────────────────────────────────
  const free = isFree();
  const blocked: string[] = [];
  let since = args.since;
  let until = args.until;
  let sourceApps = args.source_apps;
  let contentPatterns = args.content_patterns;

  if (free) {
    const floor = isoNowMinus(TWENTYFOUR_HOURS_MS);
    if (since && since < floor) {
      blocked.push("since>24h");
      since = floor;
    } else if (!since) {
      since = floor;
    }
    if (sourceApps && sourceApps.length > 0) {
      blocked.push("source_apps filter");
      sourceApps = undefined;
    }
    if (contentPatterns && contentPatterns.length > 0) {
      blocked.push("content_patterns filter");
      contentPatterns = undefined;
    }
  }

  // Build candidate query. We SELECT ids first, then DELETE — gives us the
  // exact list we deleted plus lets us cap at MAX_DELETES_PER_CALL.
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (since) {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("created_at < ?");
    params.push(until);
  }
  if (sourceApps && sourceApps.length > 0) {
    where.push(`source_app IN (${sourceApps.map(() => "?").join(",")})`);
    params.push(...sourceApps);
  }
  if (!args.include_pinned) {
    where.push("is_pinned = 0");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Over-fetch so we can post-filter by content_pattern (computed in JS).
  const willPostFilter = contentPatterns && contentPatterns.length > 0;
  const fetchLimit = willPostFilter ? MAX_DELETES_PER_CALL * 5 : MAX_DELETES_PER_CALL + 1;

  const candidates = db.prepare(`
    SELECT id, type, text_content
    FROM items
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, fetchLimit) as Array<{ id: number; type: string; text_content: string | null }>;

  let matched: number[];
  if (willPostFilter) {
    const wanted = new Set<string>(contentPatterns!);
    matched = candidates
      .filter(c => wanted.has(inferContentPattern(c)))
      .map(c => c.id);
  } else {
    matched = candidates.map(c => c.id);
  }

  const moreRemaining = matched.length > MAX_DELETES_PER_CALL;
  const toDelete = matched.slice(0, MAX_DELETES_PER_CALL);

  if (toDelete.length === 0) {
    const empty: ForgetResult = {
      deleted_count: 0,
      deleted_ids: [],
      more_remaining: false,
    };
    if (blocked.length > 0) {
      empty.limited_by_tier = {
        message:
          "Some requested options were ignored because you're on Maus Free. " +
          "Upgrade unlocks full history and filters.",
        features_blocked: blocked,
        upgrade_url: UPGRADE_URL,
      };
    }
    return empty;
  }

  // Execute deletion in a single statement using IN(...).
  const placeholders = toDelete.map(() => "?").join(",");
  const r = db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...toDelete);
  const changes = Number(r.changes ?? toDelete.length);

  const out: Exclude<ForgetResult, { error: unknown }> = {
    deleted_count: changes,
    deleted_ids: toDelete,
    more_remaining: moreRemaining,
  };
  if (blocked.length > 0) {
    out.limited_by_tier = {
      message:
        "Some requested options were ignored because you're on Maus Free. " +
        "Upgrade unlocks full history and filters.",
      features_blocked: blocked,
      upgrade_url: UPGRADE_URL,
    };
  }
  return out;
}
