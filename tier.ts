/**
 * Tier detection for Maus MCP.
 *
 * Reads the user's Maus tier (free or pro) from the same UserDefaults
 * key that Maus.app writes — see TierManager.swift, key "maus_tier".
 * Cached at module load: if the user upgrades mid-session, restart
 * the MCP server (in practice, restart Claude Code / Cursor).
 *
 * We shell out to `defaults` rather than parse the plist ourselves
 * because cfprefsd may have unflushed in-memory state that the on-disk
 * plist doesn't reflect; `defaults read` always goes through the daemon
 * and gets the authoritative value.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tier = "free" | "pro";

const TIER_KEY = "maus_tier";
// Read from the absolute plist path explicitly. Calling `defaults read com.app.maus`
// (bare bundle id) hits the sandbox container path which on this user's Mac
// is empty/abandoned — the authoritative plist lives in ~/Library/Preferences/.
// Same gotcha we hit when wiring the semantic-search flag.
const MAUS_PLIST = join(homedir(), "Library/Preferences/com.app.maus");

function readMausTierFromDefaults(): Tier {
  // Dev override — useful for testing the Pro path without modifying the
  // user's actual licence. Set MAUS_MCP_TIER_OVERRIDE=pro|free in the
  // environment. Not a security boundary; anyone who can set this env can
  // also write to the prefs file directly.
  const envOverride = (process.env.MAUS_MCP_TIER_OVERRIDE ?? "").toLowerCase();
  if (envOverride === "pro" || envOverride === "free") return envOverride;

  const r = spawnSync("/usr/bin/defaults", ["read", MAUS_PLIST, TIER_KEY], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (r.status !== 0) {
    // Key not present, or Maus has never run on this Mac. Either way,
    // safest is to treat as free.
    return "free";
  }
  const value = (r.stdout ?? "").trim().toLowerCase();
  return value === "pro" ? "pro" : "free";
}

// Short TTL cache so that an upgrade mid-session is picked up within ~10s
// without restarting Claude Code. `defaults read` is ~5-15ms, so refreshing
// on every tool call would add noticeable overhead under heavy use.
const CACHE_TTL_MS = 10_000;
let _cached: Tier = readMausTierFromDefaults();
let _cachedAt = Date.now();

export function getTier(): Tier {
  if (Date.now() - _cachedAt > CACHE_TTL_MS) {
    _cached = readMausTierFromDefaults();
    _cachedAt = Date.now();
  }
  return _cached;
}

export function isPro(): boolean {
  return getTier() === "pro";
}

export function isFree(): boolean {
  return getTier() === "free";
}

/**
 * Forces a refresh of the cached tier. Useful in tests, and as an escape
 * hatch if we ever want to wire an explicit "I just upgraded" signal.
 */
export function refreshTier(): Tier {
  _cached = readMausTierFromDefaults();
  _cachedAt = Date.now();
  return _cached;
}
