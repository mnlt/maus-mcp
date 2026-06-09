-- ───────────────────────────────────────────────────────────────
-- maus-mcp telemetry tables
-- Run once in Supabase SQL editor.
-- ───────────────────────────────────────────────────────────────

-- Boot heartbeats
CREATE TABLE IF NOT EXISTS public.mcp_installs (
  id              BIGSERIAL PRIMARY KEY,
  device_id       TEXT NOT NULL,
  mcp_version     TEXT,
  os_version      TEXT,
  client_name     TEXT,
  client_version  TEXT,
  tier            TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mcp_installs_device_id_idx  ON public.mcp_installs (device_id);
CREATE INDEX IF NOT EXISTS mcp_installs_started_at_idx ON public.mcp_installs (started_at DESC);

-- Per-tool-call events
CREATE TABLE IF NOT EXISTS public.mcp_events (
  id           BIGSERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL,
  tool         TEXT NOT NULL,
  tier         TEXT,
  duration_ms  INTEGER,
  status       TEXT,
  arg_shape    JSONB,
  client_name  TEXT,
  mcp_version  TEXT,
  ts           TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mcp_events_device_id_idx ON public.mcp_events (device_id);
CREATE INDEX IF NOT EXISTS mcp_events_ts_idx        ON public.mcp_events (ts DESC);
CREATE INDEX IF NOT EXISTS mcp_events_tool_idx      ON public.mcp_events (tool);

-- ───────────────────────────────────────────────────────────────
-- Row Level Security
-- The publishable key (anon role) must be able to INSERT and ONLY INSERT.
-- SELECT/UPDATE/DELETE go through the dashboard with the postgres role,
-- bypassing RLS.
-- ───────────────────────────────────────────────────────────────

ALTER TABLE public.mcp_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_events   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon insert mcp_installs" ON public.mcp_installs;
CREATE POLICY "anon insert mcp_installs"
  ON public.mcp_installs FOR INSERT
  TO anon
  WITH CHECK (true);

DROP POLICY IF EXISTS "anon insert mcp_events" ON public.mcp_events;
CREATE POLICY "anon insert mcp_events"
  ON public.mcp_events FOR INSERT
  TO anon
  WITH CHECK (true);

GRANT INSERT ON public.mcp_installs TO anon;
GRANT INSERT ON public.mcp_events   TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.mcp_installs_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.mcp_events_id_seq   TO anon;

-- ───────────────────────────────────────────────────────────────
-- Sanity: verify with a dummy insert (run separately, or skip).
-- ───────────────────────────────────────────────────────────────

-- INSERT INTO public.mcp_events (device_id, tool, tier, duration_ms, status, arg_shape, ts)
-- VALUES ('test', 'list_recent', 'free', 12, 'ok', '{"has_since": false}'::jsonb, NOW());
