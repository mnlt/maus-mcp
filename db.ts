/**
 * Shared SQLite connection to Maus's history DB.
 *
 * Opened in read-write mode so that tools that mutate (forget, set_title,
 * add_item) can share the same handle. Read tools work fine on a read-write
 * connection.
 *
 * WAL mode is enabled by Maus itself; concurrent reads/writes between this
 * server and the running Maus are safe.
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const DB_PATH = join(
  homedir(),
  "Library/Application Support/Maus/history.db",
);

// Friendly fail when Maus isn't installed yet. Without this the underlying
// SQLite error reads like a low-level crash; the agent should be able to tell
// the user exactly what to do.
if (!existsSync(DB_PATH)) {
  console.error(
    "[maus-mcp] Maus is not installed (or has never been launched). " +
    "Download the free macOS app at https://mausformac.com, run it once " +
    "so it creates its history database, then restart this MCP server.",
  );
  process.exit(1);
}

export const db = new DatabaseSync(DB_PATH);

// Sanity check: required columns exist. Fail fast with clear error
// rather than producing garbage at query time.
(function assertSchema() {
  const cols = db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
  const have = new Set(cols.map(c => c.name));
  const required = [
    "id", "type", "text_content", "image_data", "preview",
    "source_app", "source_url", "created_at", "is_pinned",
    "file_path", "link_url", "custom_title", "order_index",
  ];
  const missing = required.filter(c => !have.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Incompatible Maus database. Missing columns: ${missing.join(", ")}. ` +
      `Update Maus or maus-mcp.`,
    );
  }
})();

export type ItemRow = {
  id: number;
  type: string;
  text_content: string | null;
  image_data: Buffer | null;
  preview: string;
  source_app: string | null;
  source_url: string | null;
  created_at: string;
  is_pinned: number;
  file_path: string | null;
  link_url: string | null;
  custom_title: string | null;
};
