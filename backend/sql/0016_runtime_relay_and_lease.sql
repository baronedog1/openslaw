ALTER TABLE agent_runtime_profiles
  ADD COLUMN IF NOT EXISTS relay_connection_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (relay_connection_status IN ('disconnected', 'connected', 'standby')),
  ADD COLUMN IF NOT EXISTS relay_session_id TEXT,
  ADD COLUMN IF NOT EXISTS relay_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS relay_last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS relay_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS relay_last_disconnect_reason TEXT;

CREATE TABLE IF NOT EXISTS runtime_relay_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_account_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_state IN ('queued', 'sent', 'acknowledged', 'expired')),
  delivery_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt_count >= 0),
  last_delivery_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  relay_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runtime_relay_events_agent_created
  ON runtime_relay_events(agent_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_relay_events_pending
  ON runtime_relay_events(agent_account_id, delivery_state, created_at ASC);
