/**
 * Telemetry for maus-mcp — shape-only, no clipboard content.
 *
 * Two tables in the same Supabase project Maus already uses:
 *   - mcp_installs: one row each time the MCP server boots (heartbeat), with
 *                   first_start true the first time a client starts it on this Mac.
 *   - mcp_events:   one row per tool call (tool, tier, duration, status,
 *                   structural arg shape — never values).
 *
 * device_id matches the one Maus computes (SHA256 of IOPlatformUUID).
 * This lets us correlate MCP usage with the existing pro_activations,
 * daily_metrics, copy_events etc. tables. Same device, same id.
 *
 * Opt-out: set `MAUS_MCP_TELEMETRY=off` in the environment. All sends become
 * no-ops; nothing is buffered.
 *
 * Every row carries internal (dev runs), client_event_id (a retry is a 409, not a
 * duplicate), and seq / seq_epoch (per-Mac counter, kept in mcp_state.json).
 *
 * Every send is fire-and-forget. Telemetry must never block a tool response,
 * and must never throw — failures are retried once and logged to stderr.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SUPABASE_URL = "https://nxvibvrbhcdwhhefzyej.supabase.co/rest/v1";
const SUPABASE_KEY = "sb_publishable_pxHcqc5STbL6lmqspvlOcQ_ztal72Lw";
const INSTALLS_TABLE = "mcp_installs";
const EVENTS_TABLE = "mcp_events";

const TELEMETRY_DISABLED = (process.env.MAUS_MCP_TELEMETRY ?? "").toLowerCase() === "off";

/** Dev runs (tsx on the .ts sources) or MAUS_MCP_INTERNAL=1: leave out of every analysis. */
const INTERNAL = process.env.MAUS_MCP_INTERNAL === "1" || (process.argv[1] ?? "").endsWith(".ts");

/** The package's own version: dist/telemetry.js reads ../package.json, a tsx run ./package.json. */
const MCP_VERSION: string = (() => {
  const require = createRequire(import.meta.url);
  for (const path of ["../package.json", "./package.json"]) {
    try {
      const version = require(path).version;
      if (typeof version === "string") return version;
    } catch {
      // try the next one
    }
  }
  return "unknown";
})();

// MARK: state kept between runs

type State = { fallback_device_id?: string; seq_epoch: string; seq: number; clients: string[] };

const STATE_PATH = join(homedir(), "Library", "Application Support", "Maus", "mcp_state.json");

/** Read and written synchronously, never throws. A missing file starts a new seq_epoch. */
const state: State = (() => {
  try {
    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (typeof saved.seq_epoch === "string" && typeof saved.seq === "number") {
      return { ...saved, clients: Array.isArray(saved.clients) ? saved.clients : [] };
    }
  } catch {
    // missing or unreadable: start over
  }
  return { seq_epoch: randomUUID(), seq: 0, clients: [] };
})();

function saveState(): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {
    // Telemetry must never break the tool flow.
  }
}

/** Per-Mac event number, taken when the row is built (a retry sends the same one). */
function nextSeq(): { seq: number; seq_epoch: string } {
  state.seq += 1;
  saveState();
  return { seq: state.seq, seq_epoch: state.seq_epoch };
}

let _deviceId: string | null = null;

/**
 * Derive the device_id the same way Maus does (DeviceIdentifier.swift):
 * SHA256 of the hardware IOPlatformUUID. Cached on first call.
 */
export function getDeviceId(): string {
  if (_deviceId !== null) return _deviceId;

  const r = spawnSync(
    "/bin/sh",
    ["-c", `ioreg -d2 -c IOPlatformExpertDevice | awk -F\\" '/IOPlatformUUID/ {print $4}'`],
    { encoding: "utf8", timeout: 2000 },
  );
  const hwUUID = (r.stdout ?? "").trim();
  if (hwUUID.length > 0) {
    _deviceId = createHash("sha256").update(hwUUID, "utf8").digest("hex");
  } else {
    // Fallback: won't crash. Persisted in mcp_state.json so subsequent runs
    // of the MCP get the same id even without ioreg.
    if (!state.fallback_device_id) {
      let random: string;
      try {
        random = randomUUID();
      } catch {
        random = randomBytes(16).toString("hex");
      }
      state.fallback_device_id = createHash("sha256")
        .update("maus-mcp-fallback-" + process.env.HOME + "-" + random)
        .digest("hex");
      saveState();
    }
    _deviceId = state.fallback_device_id;
  }
  return _deviceId;
}

let _clientInfo: { name?: string; version?: string } = {};
export function setClientInfo(info: { name?: string; version?: string }) {
  _clientInfo = info;
}

function osVersion(): string {
  try {
    const r = spawnSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1000,
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * One POST, retried once after 2 s with the same body (same client_event_id: a
 * 409 means the first one arrived, so it counts as sent). Failures go to stderr,
 * never stdout: stdout carries the MCP protocol. Never throws.
 */
async function post(table: string, payload: Record<string, unknown>): Promise<void> {
  if (TELEMETRY_DISABLED) return;
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const res = await fetch(`${SUPABASE_URL}/${table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body,
      });
      if (res.ok || res.status === 409) return;
      process.stderr.write(`[maus-mcp] telemetry ${table} HTTP ${res.status}\n`);
    } catch {
      process.stderr.write(`[maus-mcp] telemetry ${table} HTTP 0\n`);
    }
  }
}

/**
 * Heartbeat at server boot: one row per start, with first_start true the first
 * time this client starts it on this Mac. Call once after the initialize handshake.
 */
export function trackInstall(tier: "free" | "pro"): void {
  if (TELEMETRY_DISABLED) return;
  const key = _clientInfo.name ?? "unknown";
  const firstStart = !state.clients.includes(key);
  if (firstStart) {
    state.clients.push(key);
    saveState();
  }
  void post(INSTALLS_TABLE, {
    device_id: getDeviceId(),
    mcp_version: MCP_VERSION,
    os_version: osVersion(),
    client_name: _clientInfo.name ?? null,
    client_version: _clientInfo.version ?? null,
    tier,
    started_at: new Date().toISOString(),
    first_start: firstStart,
    internal: INTERNAL,
    client_event_id: randomUUID(),
    ...nextSeq(),
  });
}

export type ToolStatus =
  | "ok"
  | "ok_tier_clamped"     // succeeded but tier dropped a filter / clamped the window
  | "tier_required"
  | "not_found"
  | "not_accessible"
  | "invalid_args"
  | "size_limit_exceeded"
  | "error";

export type ArgShape = {
  has_id?: boolean;
  has_query?: boolean;
  query_length?: number;
  has_since?: boolean;
  has_until?: boolean;
  has_source_apps?: boolean;
  has_content_patterns?: boolean;
  has_type?: boolean;
  has_title?: boolean;
  has_source_label?: boolean;
  pinned?: boolean;
  include_pinned?: boolean;
  want?: "text" | "visual" | "both";
  limit?: number;
  content_size?: number;
};

/** Fire-and-forget per-tool event. */
export function trackToolCall(params: {
  tool: string;
  tier: "free" | "pro";
  duration_ms: number;
  status: ToolStatus;
  arg_shape: ArgShape;
}): void {
  if (TELEMETRY_DISABLED) return;
  void post(EVENTS_TABLE, {
    device_id: getDeviceId(),
    tool: params.tool,
    tier: params.tier,
    duration_ms: Math.round(params.duration_ms),
    status: params.status,
    arg_shape: params.arg_shape,
    client_name: _clientInfo.name ?? null,
    mcp_version: MCP_VERSION,
    ts: new Date().toISOString(),
    internal: INTERNAL,
    client_event_id: randomUUID(),
    ...nextSeq(),
  });
}

/**
 * Build a privacy-safe arg shape from the raw tool args. NEVER include the
 * actual content or query text — only its presence + length-class.
 */
export function shapeOf(toolName: string, args: Record<string, unknown>): ArgShape {
  const has = (k: string) => args[k] !== undefined && args[k] !== null;
  const shape: ArgShape = {};

  if (has("id")) shape.has_id = true;
  if (has("query")) {
    shape.has_query = true;
    shape.query_length = typeof args.query === "string" ? args.query.length : 0;
  }
  if (has("since")) shape.has_since = true;
  if (has("until")) shape.has_until = true;
  if (Array.isArray(args.source_apps) && args.source_apps.length > 0) shape.has_source_apps = true;
  if (Array.isArray(args.content_patterns) && args.content_patterns.length > 0)
    shape.has_content_patterns = true;
  if (has("type")) shape.has_type = true;
  if (has("title")) shape.has_title = true;
  if (has("source_label")) shape.has_source_label = true;
  if (typeof args.pinned === "boolean") shape.pinned = args.pinned;
  if (typeof args.include_pinned === "boolean") shape.include_pinned = args.include_pinned;
  if (toolName === "get" && typeof args.want === "string") {
    shape.want = args.want as "text" | "visual" | "both";
  }
  if (typeof args.limit === "number") shape.limit = args.limit;
  if (typeof args.content === "string") shape.content_size = args.content.length;

  return shape;
}
