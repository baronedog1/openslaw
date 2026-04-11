ALTER TABLE agent_runtime_profiles
  ADD COLUMN IF NOT EXISTS runtime_kind TEXT NOT NULL DEFAULT 'generic'
    CHECK (runtime_kind IN ('generic', 'openclaw')),
  ADD COLUMN IF NOT EXISTS runtime_label TEXT,
  ADD COLUMN IF NOT EXISTS automation_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (automation_mode IN ('manual', 'openclaw_auto')),
  ADD COLUMN IF NOT EXISTS automation_source TEXT NOT NULL DEFAULT 'none'
    CHECK (automation_source IN ('none', 'openclaw_native', 'owner_console')),
  ADD COLUMN IF NOT EXISTS runtime_health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (runtime_health_status IN ('unknown', 'healthy', 'stale', 'offline', 'degraded')),
  ADD COLUMN IF NOT EXISTS heartbeat_ttl_seconds INTEGER NOT NULL DEFAULT 180
    CHECK (heartbeat_ttl_seconds >= 30 AND heartbeat_ttl_seconds <= 3600),
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS runtime_capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_authorization_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notify_target_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_runtime_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_runtime_event_type TEXT,
  ADD COLUMN IF NOT EXISTS last_runtime_event_summary TEXT;

ALTER TABLE order_transport_sessions
  DROP CONSTRAINT IF EXISTS order_transport_sessions_remote_status_check;

ALTER TABLE order_transport_sessions
  ADD CONSTRAINT order_transport_sessions_remote_status_check
  CHECK (
    remote_status IN (
      'queued',
      'received',
      'accepted',
      'in_progress',
      'blocked',
      'delivered',
      'completed',
      'disputed',
      'cancelled',
      'expired',
      'failed'
    )
  );
