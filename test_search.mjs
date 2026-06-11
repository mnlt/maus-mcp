// Smoke test for search() against the real Maus DB.

import { search } from "./search.ts";

function summarize(r) {
  if (r.error) {
    console.log(`  ERROR ${r.error.code}: ${r.error.message}`);
    return;
  }
  if (r.limited_by_tier) {
    console.log(`  [tier note] blocked: ${r.limited_by_tier.features_blocked.join(", ")}`);
  }
  console.log(`  capped: ${r.capped}, items: ${r.items.length}`);
  for (const it of r.items.slice(0, 8)) {
    const ocr = it.ocr_preview ? ` ocr="${it.ocr_preview.slice(0, 40)}…"` : "";
    console.log(
      `    [${it.id}] ${it.type}/${it.content_pattern}  match=[${it.matched_in.join(",")}]  src=${JSON.stringify(it.source_app)}  preview="${String(it.preview).slice(0, 50)}"${ocr}`
    );
  }
}

const cases = [
  ["query too short", { query: "a" }],
  ["query missing", {}],
  ["'mcp'", { query: "mcp" }],
  ["'maus'", { query: "maus" }],
  ["'TypeError'  (probably no hits unless OCR catches it)", { query: "TypeError" }],
  ["'mistake' (text)", { query: "mistake" }],
  ["'pasteapp' (link match)", { query: "pasteapp" }],
  ["'zsh' (only in OCR sibling of image)", { query: "zsh" }],
  ["'command not found' (OCR catches multi-word)", { query: "command not found" }],
  ["'mcp' type=link only", { query: "mcp", type: "link" }],
  ["'mcp' type=image only (should find via OCR)", { query: "mcp", type: "image" }],
  ["'maus' source_apps=['Terminal']  ← Free ignora", { query: "maus", source_apps: ["Terminal"] }],
];

for (const [label, args] of cases) {
  console.log(`\n─── ${label} ───`);
  console.log(`  args: ${JSON.stringify(args)}`);
  const t0 = Date.now();
  const r = search(args);
  const ms = Date.now() - t0;
  console.log(`  [${ms} ms]`);
  summarize(r);
}
