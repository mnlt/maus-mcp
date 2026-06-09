/**
 * Image helpers using macOS-native `sips`. Avoids native deps (sharp, jimp)
 * that would bloat the install footprint and require platform-specific binaries.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const TMP_DIR = join(tmpdir(), "maus-mcp-img");
mkdirSync(TMP_DIR, { recursive: true });

/** Detect image format by magic bytes. Returns one of: png, jpg, gif, webp, heic, bin. */
export function detectImageExtension(blob: Buffer): string {
  if (blob.length < 4) return "bin";
  if (blob[0] === 0x89 && blob[1] === 0x50 && blob[2] === 0x4E && blob[3] === 0x47) return "png";
  if (blob[0] === 0xFF && blob[1] === 0xD8 && blob[2] === 0xFF) return "jpg";
  if (blob[0] === 0x47 && blob[1] === 0x49 && blob[2] === 0x46 && blob[3] === 0x38) return "gif";
  if (blob[0] === 0x52 && blob[1] === 0x49 && blob[2] === 0x46 && blob[3] === 0x46
      && blob.length > 11
      && blob[8] === 0x57 && blob[9] === 0x45 && blob[10] === 0x42 && blob[11] === 0x50) return "webp";
  // Maus stores screenshots as TIFF (NSImage.tiffRepresentation). TIFF: 0x4D4D or 0x4949.
  if ((blob[0] === 0x4D && blob[1] === 0x4D) || (blob[0] === 0x49 && blob[1] === 0x49)) return "tiff";
  if (blob.length > 11 && blob[4] === 0x66 && blob[5] === 0x74 && blob[6] === 0x79 && blob[7] === 0x70) return "heic";
  return "bin";
}

function tmpPath(prefix: string, ext: string): string {
  return join(TMP_DIR, `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}.${ext}`);
}

/**
 * Get original dimensions of an image blob.
 */
export function getImageDimensions(blob: Buffer): { width: number; height: number } | null {
  const ext = detectImageExtension(blob);
  if (ext === "bin") return null;
  const tmp = tmpPath("dim", ext);
  try {
    writeFileSync(tmp, blob);
    const r = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", tmp], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status !== 0) return null;
    const wMatch = r.stdout.match(/pixelWidth:\s+(\d+)/);
    const hMatch = r.stdout.match(/pixelHeight:\s+(\d+)/);
    if (!wMatch || !hMatch) return null;
    return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) };
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Resize image to longest side ≤ maxDim, convert to JPEG quality 80.
 * Returns null on failure.
 */
export function reduceImage(
  blob: Buffer,
  maxDim: number = 800,
  quality: number = 80,
): { data: Buffer; format: "jpeg"; reduced_size: number; orig_size: number } | null {
  const ext = detectImageExtension(blob);
  if (ext === "bin") return null;
  const tmpIn = tmpPath("in", ext);
  const tmpOut = tmpPath("out", "jpg");
  try {
    writeFileSync(tmpIn, blob);
    const r = spawnSync("/usr/bin/sips", [
      "-Z", String(maxDim),
      "--setProperty", "format", "jpeg",
      "--setProperty", "formatOptions", String(quality),
      tmpIn,
      "--out", tmpOut,
    ], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || !existsSync(tmpOut)) return null;
    const out = readFileSync(tmpOut);
    return {
      data: out,
      format: "jpeg",
      reduced_size: out.length,
      orig_size: blob.length,
    };
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}
