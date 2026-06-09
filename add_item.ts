/**
 * add_item(content, ...) — write a new clipboard item authored by the agent.
 *
 * The defining feature of Maus MCP. When Claude writes an email / summary /
 * snippet, instead of dropping it as markdown into the chat (where the user
 * inherits monospace + asterisks + extra newlines), it stores the clean text
 * in Maus. The user pastes it from Maus into the real destination unedited.
 *
 * The item is tagged with the calling MCP client's name (e.g. "Claude Code",
 * "Cursor") so the user can search `#claude` / `#cursor` in Maus to find
 * AI-authored items.
 *
 * Tier: Pro-only. Free returns tier_required with the upgrade URL. The
 * pitch surfaces in the agent's voice at the exact moment the user wanted
 * it — sharper than any banner inside Maus.
 *
 * The MCP client name is provided by the server wiring (see server.ts) and
 * passed in via `clientName`. add_item doesn't read it on its own because
 * the MCP handshake metadata isn't accessible from a stateless tool fn.
 */

import { db } from "./db.ts";
import { isPro } from "./tier.ts";

const MAX_CONTENT_BYTES = 1024 * 1024; // 1 MB
const MAX_TITLE_LEN = 200;
const MAX_SOURCE_LABEL_LEN = 80;
const UPGRADE_URL =
  "https://mausformac.lemonsqueezy.com/checkout/buy/fa311099-77f7-4b0d-8d39-eab756710f15";

export type AddItemArgs = {
  content: string;
  title?: string;
  source_label?: string;
  pinned?: boolean;
};

export type AddItemContext = {
  /** Name of the MCP client that called us, e.g. "Claude Code" or "Cursor".
   *  Used as default source_label when the caller doesn't provide one. */
  clientName?: string;
};

export type AddItemResult =
  | {
      error: {
        code: string;
        message: string;
        upgrade_url?: string;
      };
    }
  | {
      id: number;
      created_at: string;
      source_app: string;
      pinned: boolean;
    };

function buildPreview(text: string): string {
  // Mirror Maus's preview logic: first non-empty line, capped to 50 chars
  // with ellipsis. See ClipboardItem.fromText() in the app code.
  const firstLine = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0) ?? text.trim();
  if (firstLine.length > 50) {
    return firstLine.slice(0, 47) + "...";
  }
  return firstLine;
}

export function add_item(args: AddItemArgs, ctx: AddItemContext = {}): AddItemResult {
  // Pro gate first. Verbalise the upgrade pitch in the agent's response.
  if (!isPro()) {
    return {
      error: {
        code: "tier_required",
        message:
          "Writing items to Maus history requires Maus Pro. " +
          "It's $12.99 one-time. The link below opens the secure checkout.",
        upgrade_url: UPGRADE_URL,
      },
    };
  }

  // Input validation.
  if (typeof args.content !== "string" || args.content.length === 0) {
    return { error: { code: "invalid_args", message: "content is required (non-empty string)" } };
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    return {
      error: {
        code: "size_limit_exceeded",
        message: `content is ${(bytes / 1024 / 1024).toFixed(2)} MB; max ${MAX_CONTENT_BYTES / 1024 / 1024} MB. ` +
          "Consider splitting into multiple items.",
      },
    };
  }

  // Normalise title.
  let title: string | null = null;
  if (typeof args.title === "string") {
    const t = args.title.trim();
    if (t.length > 0) title = t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) : t;
  }

  // Default source_label to the calling client; fall back to a safe generic.
  let sourceLabel = (args.source_label ?? ctx.clientName ?? "AI").trim();
  if (sourceLabel.length === 0) sourceLabel = "AI";
  if (sourceLabel.length > MAX_SOURCE_LABEL_LEN) {
    sourceLabel = sourceLabel.slice(0, MAX_SOURCE_LABEL_LEN);
  }

  const pinned = args.pinned === true;
  const preview = buildPreview(args.content);
  const createdAt = new Date().toISOString();
  const pinnedAt = pinned ? createdAt : null;

  // Compute next order_index. Matches DatabaseManager.insert in Maus —
  // see DatabaseManager.swift around getMaxOrderIndex().
  const maxIdx = (db.prepare(`SELECT MAX(order_index) AS m FROM items`).get() as { m: number | null }).m ?? 0;
  const orderIndex = maxIdx + 1;

  const result = db.prepare(`
    INSERT INTO items (
      type, text_content, image_data, preview,
      source_app, source_url, created_at,
      is_pinned, pinned_at, file_path, link_url,
      custom_title, order_index
    ) VALUES (
      'text', ?, NULL, ?,
      ?, NULL, ?,
      ?, ?, NULL, NULL,
      ?, ?
    )
  `).run(
    args.content,
    preview,
    sourceLabel,
    createdAt,
    pinned ? 1 : 0,
    pinnedAt,
    title,
    orderIndex,
  );

  return {
    id: Number(result.lastInsertRowid),
    created_at: createdAt,
    source_app: sourceLabel,
    pinned,
  };
}
