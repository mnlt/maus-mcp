// Quick standalone test of tier detection.
// Run with: node --experimental-strip-types test_tier.mjs
// (or via tsx: npx tsx test_tier.mjs)

import { getTier, isPro, isFree } from "./tier.ts";

console.log("─── Tier detection test ───");
console.log("Detected tier:", getTier());
console.log("isPro():", isPro());
console.log("isFree():", isFree());

console.log();
console.log("Sanity: what does the system say directly?");
import { spawnSync } from "node:child_process";
const direct = spawnSync("/usr/bin/defaults", ["read", "com.app.maus", "maus_tier"], { encoding: "utf8" });
console.log("  exit code:", direct.status);
console.log("  stdout:", JSON.stringify((direct.stdout ?? "").trim()));
console.log("  stderr:", JSON.stringify((direct.stderr ?? "").trim()));
