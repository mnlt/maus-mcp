// Betty's measurement. Made by Betty for Maus: when Betty gives a new one, replace this file whole.
//
// Every event goes to one place, `betty_track` in the product's database (schema `betty`). The names are closed
// lists: a feature, journey or offer that isn't in them doesn't type-check. Never blocks and never throws: in a
// browser, events wait in a queue (kept across pages) and are retried with the same id until they arrive; on a
// server, `await` the call (it resolves when sent, and never rejects).

// Where events go: `betty_track` in the product's database (the one place to change to send them elsewhere).
const ENDPOINT = "https://nxvibvrbhcdwhhefzyej.supabase.co/rest/v1/rpc/betty_track";
const KEY = "sb_publishable_pxHcqc5STbL6lmqspvlOcQ_ztal72Lw";

// The product's names
export type Feature = "call_tool" | "add_item" | "install_mcp";
export type Setting = "install_mcp";
export type Flow = never;
export type Steps = { };
export type Ends = { };
export type Surface = "mcp_upgrade_url";
export type Gate = "add_item_pro_only" | "history_retention_24h_mcp" | "mcp_filters";

declare const process: { env: Record<string, string | undefined> }; // a build variable, when there is one

/** Who did it. In a browser Betty remembers it (identify); on a server, pass it with every call. */
export type Who = { actor?: string; anonymous?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = globalThis as any; // the browser's window, when there is one: no DOM types needed
const browser = typeof w.window !== "undefined" && typeof w.localStorage !== "undefined";
const store = {
  get(k: string): string | null { try { return browser ? w.localStorage.getItem(k) : null; } catch { return null; } },
  set(k: string, v: string | null) { try { if (browser) { if (v === null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } } catch { /* private mode */ } },
};
const uuid = (): string => (w.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

function anonymousId(): string | undefined {
  if (!browser) return undefined;
  let id = store.get("betty_anonymous_id");
  if (!id) { id = uuid(); store.set("betty_anonymous_id", id); }
  return id;
}

function isInternal(): boolean {
  if (browser) return /^(localhost|127\.|0\.0\.0\.0|\[::1\])|\.local$/.test(w.location.hostname);
  try { return process.env.NODE_ENV !== "production"; } catch { return false; }
}

function version(): string {
  try { return process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version || "unknown"; } catch { return "unknown"; }
}

function context(): Record<string, unknown> {
  const c: Record<string, unknown> = { app_version: version(), internal: isInternal() };
  if (browser) {
    let epoch = store.get("betty_seq_epoch"), seq = Number(store.get("betty_seq") ?? 0);
    if (!epoch) { epoch = uuid(); seq = 0; store.set("betty_seq_epoch", epoch); }
    store.set("betty_seq", String(++seq));
    Object.assign(c, { seq, seq_epoch: epoch });
  }
  return c;
}

type Payload = Record<string, unknown>;
const QUEUE = "betty_queue";
const queued = (): Payload[] => { try { return JSON.parse(store.get(QUEUE) ?? "[]"); } catch { return []; } };
let sending = false;

async function post(p: Payload): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ ...p, p_sent_at: new Date().toISOString() }),
    });
    return r.ok || r.status === 400 || r.status === 422; // sent, or malformed (it would never pass)
  } catch { return false; } // offline: later
}

async function flush(): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    for (let q = queued(); q.length; q = queued()) {
      if (!(await post(q[0]))) break;
      store.set(QUEUE, JSON.stringify(queued().filter((x) => x.p_message_id !== q[0].p_message_id)));
    }
  } finally { sending = false; }
}
if (browser) { setInterval(() => void flush(), 60_000); w.addEventListener("online", () => void flush()); }

function send(event: string, properties: Record<string, string>, who?: Who): Promise<void> {
  const actor = who?.actor ?? store.get("betty_actor_id") ?? undefined;
  const p: Payload = {
    p_event: event, p_occurred_at: new Date().toISOString(), p_properties: properties, p_message_id: uuid(),
    p_context: context(), ...(actor ? { p_actor_id: actor } : {}),
    ...((who?.anonymous ?? anonymousId()) ? { p_anonymous_id: who?.anonymous ?? anonymousId() } : {}),
  };
  if (betty.sink) { betty.sink(event, properties); return Promise.resolve(); }
  if (!browser) return post(p).then(() => undefined);
  store.set(QUEUE, JSON.stringify([...queued(), p].slice(-2000)));
  return flush();
}

export const betty = {
  /** When set, events go here instead of the network (tests). */
  sink: undefined as undefined | ((event: string, properties: Record<string, string>) => void),

  /** The product's own id for the device, once it is known (in a browser; on a server pass `{ actor }` instead). */
  identify(actorId: string) { store.set("betty_actor_id", actorId); },
  /** Each time the feature is done (after it succeeds). */
  used: (feature: Feature, who?: Who) => send("Feature Used", { feature }, who),
  /** Each time the setting or state changes, with its new value. */
  changed: (setting: Setting, value: string, who?: Who) => send("State Changed", { feature: setting, value }, who),
  /** The offer is shown on screen (once per showing). */
  offerViewed: (surface: Surface, who?: Who) => send("Offer Viewed", { surface }, who),
  /** The person clicks or taps the offer. */
  offerClicked: (surface: Surface, who?: Who) => send("Offer Clicked", { surface }, who),
  /** A limit of the free plan stops the person. */
  limitHit: (gate: Gate, who?: Who) => send("Limit Hit", { gate }, who),
};
