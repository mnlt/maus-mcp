// Standalone test of get(). Runs directly without MCP wiring.
// Usage: npx tsx test_get.mjs [id]

import { get } from "./get.ts";
import { db } from "./db.ts";

function summarize(result) {
  if (result.error) {
    return `ERROR ${result.error.code}: ${result.error.message}`;
  }
  const lines = [
    `id=${result.id} type=${result.type}`,
    `source_app=${JSON.stringify(result.source_app)}`,
    `created_at=${result.created_at}`,
    `is_pinned=${result.is_pinned}`,
    `preview=${JSON.stringify(String(result.preview ?? "").slice(0, 60))}`,
  ];
  if (result.type === "text" || result.type === "link") {
    lines.push(`content_size=${result.content_size}`);
    lines.push(`content_preview=${JSON.stringify(String(result.content ?? "").slice(0, 80))}`);
  }
  if (result.type === "file") {
    lines.push(`file_path=${result.file_path}`);
  }
  if (result.type === "image") {
    if (result.image_metadata) {
      lines.push(`image: ${result.image_metadata.format} ${result.image_metadata.width}x${result.image_metadata.height} (${result.image_metadata.size_bytes} bytes)`);
    } else {
      lines.push(`image: no data`);
    }
    if (result.ocr_text !== undefined) {
      lines.push(`ocr_text=${result.ocr_text === null ? "(none)" : JSON.stringify(result.ocr_text.slice(0, 80))}`);
    }
    if (result.reduced_image_b64) {
      lines.push(`reduced_image_b64: ${result.reduced_image_b64.length} chars (~${Math.round(result.reduced_image_b64.length * 3 / 4 / 1024)}KB raw)`);
    }
    if (result.maus_note) {
      lines.push(`note: ${result.maus_note}`);
    }
  }
  return lines.join("\n  ");
}

function pickRecent(type) {
  const row = db.prepare(`SELECT id FROM items WHERE type = ? ORDER BY id DESC LIMIT 1`).get(type);
  return row?.id ?? null;
}

const argId = process.argv[2] ? parseInt(process.argv[2], 10) : null;

console.log("─── get() smoke test ───\n");

if (argId !== null) {
  console.log(`> get(${argId}, want="both")`);
  console.log("  " + summarize(get({ id: argId })));
  console.log();
} else {
  // Auto-test: latest text + latest image + latest link + latest file + nonexistent + image with each `want`
  console.log("> get(non-existent id 999999999)");
  console.log("  " + summarize(get({ id: 999999999 })));
  console.log();

  const latestText = pickRecent("text");
  if (latestText) {
    console.log(`> get(${latestText})  // latest text item`);
    console.log("  " + summarize(get({ id: latestText })));
    console.log();
  }

  const latestLink = pickRecent("link");
  if (latestLink) {
    console.log(`> get(${latestLink})  // latest link item`);
    console.log("  " + summarize(get({ id: latestLink })));
    console.log();
  }

  const latestFile = pickRecent("file");
  if (latestFile) {
    console.log(`> get(${latestFile})  // latest file item`);
    console.log("  " + summarize(get({ id: latestFile })));
    console.log();
  }

  const latestImage = pickRecent("image");
  if (latestImage) {
    for (const want of ["text", "visual", "both"]) {
      console.log(`> get(${latestImage}, want="${want}")  // latest image item`);
      const t0 = Date.now();
      const r = get({ id: latestImage, want });
      const ms = Date.now() - t0;
      console.log(`  [${ms} ms]`);
      console.log("  " + summarize(r));
      console.log();
    }
  } else {
    console.log("(no image items in DB to test)");
  }
}
