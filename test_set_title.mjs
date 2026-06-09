// Smoke test set_title against real Maus DB. Restores original title at end
// so we don't leave noise on Manuel's clipboard history.

import { db } from "./db.ts";
import { set_title } from "./set_title.ts";

const targetId = db.prepare(
  `SELECT id, custom_title, preview FROM items
   WHERE type = 'text'
   ORDER BY id DESC LIMIT 1`,
).get();

if (!targetId) {
  console.log("No text item available to test on.");
  process.exit(0);
}

const originalTitle = targetId.custom_title;
console.log(`Test target id=${targetId.id}  preview="${targetId.preview}"`);
console.log(`Original custom_title: ${JSON.stringify(originalTitle)}\n`);

console.log("> set_title(non-existent id)");
console.log(" ", set_title({ id: 999999999, title: "x" }));
console.log();

console.log(`> set_title(${targetId.id}, title="mcp test title")`);
console.log(" ", set_title({ id: targetId.id, title: "mcp test title" }));
const afterSet = db.prepare("SELECT custom_title FROM items WHERE id = ?").get(targetId.id);
console.log("  DB now reads:", afterSet);
console.log();

console.log(`> set_title(${targetId.id}, title="")  // should clear`);
console.log(" ", set_title({ id: targetId.id, title: "" }));
const afterClear = db.prepare("SELECT custom_title FROM items WHERE id = ?").get(targetId.id);
console.log("  DB now reads:", afterClear);
console.log();

console.log(`> set_title(${targetId.id}, title=null)  // explicit null`);
console.log(" ", set_title({ id: targetId.id, title: null }));
console.log();

console.log(`> set_title(${targetId.id}, title="  whitespace  ")  // trim`);
console.log(" ", set_title({ id: targetId.id, title: "  whitespace  " }));
const afterTrim = db.prepare("SELECT custom_title FROM items WHERE id = ?").get(targetId.id);
console.log("  DB now reads:", afterTrim);
console.log();

// Restore original
console.log(`> restoring original title (${JSON.stringify(originalTitle)})`);
db.prepare("UPDATE items SET custom_title = ? WHERE id = ?").run(originalTitle, targetId.id);
const restored = db.prepare("SELECT custom_title FROM items WHERE id = ?").get(targetId.id);
console.log("  Restored:", restored);

// Test tier wall: try to rename an item >24h old (Free user)
const oldItem = db.prepare(
  `SELECT id, created_at FROM items
   WHERE datetime(created_at) < datetime('now', '-24 hours')
   LIMIT 1`,
).get();
if (oldItem) {
  console.log(`\n> set_title(${oldItem.id}, "x")  // item is ${oldItem.created_at}, >24h old`);
  console.log(" ", set_title({ id: oldItem.id, title: "x" }));
}
