#!/usr/bin/env node
/**
 * maus-mcp — MCP server exposing Maus.app's clipboard history.
 *
 * v1 surface (6 tools):
 *   get         — fetch one item by id, with OCR + reduced image for type=image
 *   list_recent — chronological list with filters
 *   search      — substring search including OCR text
 *   set_title   — rename an item (lets the agent organise the clipboard)
 *   forget      — delete one or many items
 *   add_item    — Pro-only; the agent writes clean text into Maus history
 *
 * Tier rules: every tool mirrors the Maus UI scope for the user's tier.
 * Free sees only items ≤24h; Pro sees everything. Tier-clamped responses
 * surface `limited_by_tier` with an upgrade URL so the agent verbalises
 * the pitch in context.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { get } from "./get.ts";
import { list_recent } from "./list_recent.ts";
import { search } from "./search.ts";
import { set_title } from "./set_title.ts";
import { forget } from "./forget.ts";
import { add_item } from "./add_item.ts";
import { getTier } from "./tier.ts";
import {
  setClientInfo,
  trackInstall,
  trackToolCall,
  shapeOf,
  type ToolStatus,
} from "./telemetry.ts";

const server = new Server(
  { name: "maus", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Use these MCP tools to interact with the user's Maus clipboard.",
      "Do NOT read or write to Maus's local store directly through filesystem or shell tools —",
      "the MCP tools enforce the user's tier (Free vs Pro) and content safety. Bypassing them",
      "violates the user's data scope and produces inconsistent state. If a tool returns a",
      "`limited_by_tier` block, surface the upgrade option to the user; do not work around it.",
    ].join(" "),
  },
);

// ─── Tool catalog ─────────────────────────────────────────────────────────
// Descriptions are kept tight — each tool eats agent context. Single-purpose
// boundaries between tools let the agent decide quickly.

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_recent",
      description:
        "Lists items from the user's local Maus clipboard, newest first. " +
        "Use when the user wants 'recent items', 'what I copied', or browsing by time. " +
        "Returns lightweight summaries (call `get` for full content of a specific id).",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max items. Default 20, max 100." },
          since: { type: "string", description: "ISO 8601 lower bound on created_at." },
          source_apps: {
            type: "array",
            items: { type: "string" },
            description: "Filter by source app name(s) (e.g. 'Cursor', 'Claude'). Maus Pro.",
          },
          content_patterns: {
            type: "array",
            items: { type: "string", enum: ["url", "code", "password", "email", "phone", "color", "single_word", "short_text", "long_text", "image", "file"] },
            description: "Filter by inferred content shape. Maus Pro.",
          },
          type: {
            type: "string",
            enum: ["text", "image", "link", "file"],
            description: "Filter by item type.",
          },
        },
      },
    },
    {
      name: "search",
      description:
        "Substring search across content, titles, source apps, URLs, file paths, " +
        "AND OCR text of image items. Use when the user has a keyword in mind. " +
        "Same filter/tier rules as list_recent.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term, ≥2 chars." },
          limit: { type: "number", description: "Max items. Default 20, max 100." },
          since: { type: "string", description: "ISO 8601 lower bound on created_at." },
          until: { type: "string", description: "ISO 8601 upper bound on created_at." },
          source_apps: {
            type: "array",
            items: { type: "string" },
            description: "Filter by source app name(s). Maus Pro.",
          },
          content_patterns: {
            type: "array",
            items: { type: "string", enum: ["url", "code", "password", "email", "phone", "color", "single_word", "short_text", "long_text", "image", "file"] },
            description: "Filter by inferred content shape. Maus Pro.",
          },
          type: {
            type: "string",
            enum: ["text", "image", "link", "file"],
            description: "Filter by item type.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get",
      description:
        "Fetch one item by id. For text/link/file, returns content. " +
        "For images, `want` controls the payload: 'text' gives OCR + metadata, " +
        "'visual' gives a token-light reduced JPEG + metadata, 'both' (default) gives all.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Item id from list_recent/search." },
          want: {
            type: "string",
            enum: ["text", "visual", "both"],
            description: "For image items: 'text' (OCR only), 'visual' (image only), 'both' (default).",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "set_title",
      description:
        "Rename (or clear the name of) an item. Use to organise the clipboard — e.g. " +
        "after identifying a password, set_title(id, 'wifi router password') so the " +
        "user sees a readable name in Maus. Empty title clears.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Item id." },
          title: { type: "string", description: "New title (empty/omitted clears)." },
        },
        required: ["id"],
      },
    },
    {
      name: "forget",
      description:
        "Permanently delete one item (pass `id`) or many (pass any filter combo). " +
        "Use when the user wants something gone from history (privacy, accidental copy). " +
        "Hard delete — no recovery. The response gives deleted ids, never content.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Single item to delete." },
          since: { type: "string", description: "ISO 8601 lower bound." },
          until: { type: "string", description: "ISO 8601 upper bound." },
          source_apps: {
            type: "array",
            items: { type: "string" },
            description: "Source app filter. Maus Pro.",
          },
          content_patterns: {
            type: "array",
            items: { type: "string", enum: ["url", "code", "password", "email", "phone", "color", "single_word", "short_text", "long_text", "image", "file"] },
            description: "Content pattern filter. Maus Pro.",
          },
          include_pinned: {
            type: "boolean",
            description: "Bulk only — also delete pinned items. Default false.",
          },
        },
      },
    },
    {
      name: "add_item",
      description:
        "Write a new text item into Maus history. Use whenever you produce text the " +
        "user will paste somewhere (email, message, snippet) — they paste from Maus " +
        "with clean formatting instead of copying from the chat with monospace + markdown. " +
        "Tag with `title` for identifiability. Maus Pro only.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Text to store. Up to 1 MB." },
          title: { type: "string", description: "Optional title shown in Maus instead of preview." },
          source_label: { type: "string", description: "Override source app tag (default: calling client name)." },
          pinned: { type: "boolean", description: "Pin the item. Default false." },
        },
        required: ["content"],
      },
    },
  ],
}));

// ─── Tool router ──────────────────────────────────────────────────────────

/**
 * Pull the status code (ok / tier_required / not_found / etc.) out of a tool
 * result so we can record it. Tool functions return either a result object
 * or an `{ error: { code } }` object — both shapes are handled here.
 *
 * Success-with-tier-clamp (e.g. list_recent ran but ignored a Pro-only
 * filter) is distinguished from a clean success because that's the funnel
 * signal for the upgrade pitch.
 */
function statusOf(result: unknown): ToolStatus {
  if (!result || typeof result !== "object") return "ok";
  if ("error" in result) {
    const code = (result as { error: { code?: string } }).error?.code;
    if (
      code === "tier_required"
      || code === "not_found"
      || code === "not_accessible"
      || code === "invalid_args"
      || code === "size_limit_exceeded"
    ) {
      return code;
    }
    return "error";
  }
  if ("limited_by_tier" in result) {
    return "ok_tier_clamped";
  }
  return "ok";
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  const t0 = Date.now();
  let status: ToolStatus = "ok";

  try {
    let result: unknown;
    switch (name) {
      case "list_recent":
        result = list_recent(a);
        break;
      case "search":
        result = search(a as Parameters<typeof search>[0]);
        break;
      case "get": {
        const r = get(a as Parameters<typeof get>[0]);
        status = statusOf(r);
        trackToolCall({
          tool: name,
          tier: getTier(),
          duration_ms: Date.now() - t0,
          status,
          arg_shape: shapeOf(name, a),
        });
        return shapeGetResponse(r);
      }
      case "set_title":
        result = set_title(a as Parameters<typeof set_title>[0]);
        break;
      case "forget":
        result = forget(a);
        break;
      case "add_item": {
        const clientName = server.getClientVersion()?.name;
        result = add_item(a as Parameters<typeof add_item>[0], { clientName });
        break;
      }
      default:
        status = "error";
        trackToolCall({
          tool: name,
          tier: getTier(),
          duration_ms: Date.now() - t0,
          status,
          arg_shape: {},
        });
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    status = statusOf(result);
    trackToolCall({
      tool: name,
      tier: getTier(),
      duration_ms: Date.now() - t0,
      status,
      arg_shape: shapeOf(name, a),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    trackToolCall({
      tool: name,
      tier: getTier(),
      duration_ms: Date.now() - t0,
      status: "error",
      arg_shape: shapeOf(name, a),
    });
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

/**
 * `get` for an image item carries a reduced JPEG as base64. Surface it as a
 * native MCP image content block so Claude/Cursor can actually look at it,
 * while keeping the JSON metadata in a paired text block.
 */
function shapeGetResponse(result: ReturnType<typeof get>) {
  if ("error" in result) {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (result.type !== "image") {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  const imageResult = result as { reduced_image_b64?: string };
  const b64 = imageResult.reduced_image_b64;
  // Strip the base64 from the JSON blob so we don't double-send the bytes.
  const meta = { ...result };
  if ("reduced_image_b64" in meta) delete (meta as Record<string, unknown>).reduced_image_b64;
  const blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
    { type: "text", text: JSON.stringify(meta, null, 2) },
  ];
  if (b64) {
    blocks.push({ type: "image", data: b64, mimeType: "image/jpeg" });
  }
  return { content: blocks };
}

// ─── Boot ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Wait a tick so the initialize handshake completes, then read the client
// info and fire the install heartbeat. clientInfo isn't populated until the
// peer sends `initialize` — see SDK Server._clientVersion.
setTimeout(() => {
  const ci = server.getClientVersion();
  setClientInfo({ name: ci?.name, version: ci?.version });
  trackInstall(getTier());
}, 500);
