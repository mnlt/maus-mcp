// Test add_item. Uses MAUS_MCP_TIER_OVERRIDE env (set in shell) to flip
// tier without touching the real licence. Run as:
//   MAUS_MCP_TIER_OVERRIDE=pro npx tsx test_add_item.mjs
//   MAUS_MCP_TIER_OVERRIDE=free npx tsx test_add_item.mjs

import { db } from "./db.ts";
import { add_item } from "./add_item.ts";
import { getTier } from "./tier.ts";

console.log(`Tier this run: ${getTier()}`);

console.log("\n─── case 1: simple insert ───");
const r1 = add_item(
  { content: "Hello from MCP add_item test" },
  { clientName: "Claude Code" },
);
console.log("  ", r1);
let id1 = null;
if (!r1.error) {
  id1 = r1.id;
  const row = db.prepare(`SELECT id, type, source_app, custom_title, is_pinned, preview FROM items WHERE id = ?`).get(id1);
  console.log("  DB row:", row);
}

console.log("\n─── case 2: with title + custom source_label + pinned ───");
const r2 = add_item(
  {
    content: "Multi-line\nemail body\n\nwith blank lines",
    title: "Reply to Maria",
    source_label: "Cursor",
    pinned: true,
  },
  { clientName: "Claude Code" }, // should be overridden by source_label
);
console.log("  ", r2);
let id2 = null;
if (!r2.error) {
  id2 = r2.id;
  const row = db.prepare(`SELECT id, source_app, custom_title, is_pinned, pinned_at, preview FROM items WHERE id = ?`).get(id2);
  console.log("  DB row:", row);
}

console.log("\n─── case 3: empty content ───");
console.log("  ", add_item({ content: "" }));

console.log("\n─── case 4: oversize (>1MB) ───");
console.log("  ", add_item({ content: "x".repeat(1024 * 1024 + 10) }));

console.log("\n─── cleanup ───");
let removed = 0;
for (const id of [id1, id2].filter(Boolean)) {
  const r = db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
  removed += r.changes ?? 0;
}
console.log(`Removed ${removed} test items.`);
