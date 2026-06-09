/**
 * set_title(id, title?) — rename an item by writing to its custom_title.
 *
 * Use case: let the agent organise the user's clipboard by giving items
 * meaningful names. Example flow: agent calls list_recent, identifies a
 * password-looking value, calls set_title(id, "wifi router password").
 * The user later opens Maus and sees that name instead of the cryptic
 * preview.
 *
 * Empty / null title clears the custom title (the preview is shown again).
 *
 * Tier: same window rule as the rest of the read tools. Free can only
 * rename items it can see (<24h). Pro can rename anything.
 */

import { db } from "./db.ts";
import { isFree } from "./tier.ts";

const TWENTYFOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_TITLE_LEN = 200; // Maus UI only shows ~50; keep it sane.
const UPGRADE_URL =
  "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

export type SetTitleArgs = {
  id: number;
  title?: string | null;
};

export type SetTitleResult =
  | { error: { code: string; message: string; upgrade_url?: string } }
  | { id: number; updated: boolean; title: string | null };

function isOlderThan24h(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  if (isNaN(t)) return false;
  return Date.now() - t > TWENTYFOUR_HOURS_MS;
}

export function set_title(args: SetTitleArgs): SetTitleResult {
  if (typeof args.id !== "number" || !Number.isFinite(args.id)) {
    return { error: { code: "invalid_args", message: "id must be a finite number" } };
  }

  // Normalise title: trim, treat empty as null, cap length.
  let title: string | null = null;
  if (typeof args.title === "string") {
    const trimmed = args.title.trim();
    if (trimmed.length > 0) {
      title = trimmed.length > MAX_TITLE_LEN
        ? trimmed.slice(0, MAX_TITLE_LEN)
        : trimmed;
    }
  }

  // Confirm the item exists and check tier scope.
  const row = db.prepare(
    "SELECT id, created_at FROM items WHERE id = ?",
  ).get(args.id) as { id: number; created_at: string } | undefined;

  if (!row) {
    return { error: { code: "not_found", message: `item ${args.id} not found` } };
  }

  if (isFree() && isOlderThan24h(row.created_at)) {
    return {
      error: {
        code: "not_accessible",
        message: "Item is beyond the 24h window. Upgrade to Maus Pro to rename older items.",
        upgrade_url: UPGRADE_URL,
      },
    };
  }

  const result = db.prepare(
    "UPDATE items SET custom_title = ? WHERE id = ?",
  ).run(title, args.id);

  return {
    id: args.id,
    updated: (result.changes ?? 0) > 0,
    title,
  };
}
