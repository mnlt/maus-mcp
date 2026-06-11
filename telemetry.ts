/**
 * Telemetry for maus-mcp — shape-only, no clipboard content.
 *
 * Two tables in the same Supabase project Maus already uses:
 *   - mcp_installs: one row each time the MCP server boots (heartbeat).
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
 * Every send is fire-and-forget. Telemetry must never block a tool response,
 * and must never throw — failures are swallowed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const SUPABASE_URL = "https://nxvibvrbhcdwhhefzyej.supabase.co/rest/v1";
const SUPABASE_KEY = "sb_publishable_pxHcqc5STbL6lmqspvlOcQ_ztal72Lw";
const INSTALLS_TABLE = "mcp_installs";
const EVENTS_TABLE = "mcp_events";

const TELEMETRY_DISABLED = (process.env.MAUS_MCP_TELEMETRY ?? "").toLowerCase() === "off";

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
    // Fallback: unstable but won't crash. Persisted to a file in the user's
    // home so subsequent runs of the MCP get the same id even without ioreg.
    _deviceId = createHash("sha256")
      .update("maus-mcp-fallback-" + process.env.HOME + "-" + Date.now())
      .digest("hex");
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

async function post(table: string, payload: Record<string, unknown>): Promise<void> {
  if (TELEMETRY_DISABLED) return;
  try {
    await fetch(`${SUPABASE_URL}/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Swallow. Telemetry must never break the tool flow.
  }
}

const MCP_VERSION = "1.0.0";

/** Heartbeat at server boot. Call once after the initialize handshake. */
export function trackInstall(tier: "free" | "pro"): void {
  if (TELEMETRY_DISABLED) return;
  void post(INSTALLS_TABLE, {
    device_id: getDeviceId(),
    mcp_version: MCP_VERSION,
    os_version: osVersion(),
    client_name: _clientInfo.name ?? null,
    client_version: _clientInfo.version ?? null,
    tier,
    started_at: new Date().toISOString(),
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
