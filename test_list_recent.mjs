// Test list_recent() against the real Maus DB.
// Usage: npx tsx test_list_recent.mjs

import { list_recent } from "./list_recent.ts";

function summarize(r) {
  if (r.limited_by_tier) {
    console.log(`  [tier note] ${r.limited_by_tier.message}`);
    console.log(`  [tier note] blocked: ${r.limited_by_tier.features_blocked.join(", ")}`);
  }
  console.log(`  capped: ${r.capped}, items: ${r.items.length}`);
  for (const it of r.items.slice(0, 8)) {
    const ocr = it.ocr_preview ? ` ocr="${it.ocr_preview.slice(0, 40)}…"` : "";
    console.log(
      `    [${it.id}] ${it.type}/${it.content_pattern}  src=${JSON.stringify(it.source_app)}` +
        `  age=${ageStr(it.created_at)}  pin=${it.is_pinned}` +
        `  preview="${String(it.preview).slice(0, 50)}"` + ocr
    );
  }
  if (r.items.length > 8) console.log(`    … and ${r.items.length - 8} more`);
}

function ageStr(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "?";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

const cases = [
  ["default (no args)", {}],
  ["limit=5", { limit: 5 }],
  ["since='hace 2h'", { since: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }],
  ["since='hace 7 días'  ← Free clamp esperado", { since: new Date(Date.now() - 7 * 86400 * 1000).toISOString() }],
  ["type=image, limit=3", { type: "image", limit: 3 }],
  ["type=link, limit=5", { type: "link", limit: 5 }],
  ["source_apps=['Cursor']  ← Free ignora esperado", { source_apps: ["Cursor"] }],
  ["content_patterns=['url']  ← Free ignora esperado", { content_patterns: ["url"] }],
  ["limit=150  ← cap a 100", { limit: 150 }],
];

for (const [label, args] of cases) {
  console.log(`\n─── ${label} ───`);
  console.log(`  args: ${JSON.stringify(args)}`);
  const t0 = Date.now();
  const r = list_recent(args);
  const ms = Date.now() - t0;
  console.log(`  [${ms} ms]`);
  summarize(r);
}
