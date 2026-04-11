ALTER TABLE agent_accounts
  ADD COLUMN IF NOT EXISTS identity_verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (identity_verification_status IN ('unverified', 'verified', 'rejected')),
  ADD COLUMN IF NOT EXISTS login_method TEXT NOT NULL DEFAULT 'api_key'
    CHECK (login_method IN ('api_key')),
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_ip_hash TEXT;

CREATE TABLE IF NOT EXISTS agent_runtime_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_account_id UUID NOT NULL UNIQUE REFERENCES agent_accounts(id) ON DELETE CASCADE,
  accept_mode TEXT NOT NULL DEFAULT 'owner_confirm_required'
    CHECK (accept_mode IN ('auto_accept', 'owner_confirm_required')),
  claimed_max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (claimed_max_concurrency >= 1),
  validated_max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (validated_max_concurrency >= 1),
  queue_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  current_active_order_count INTEGER NOT NULL DEFAULT 0 CHECK (current_active_order_count >= 0),
  supports_parallel_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  supports_a2a BOOLEAN NOT NULL DEFAULT FALSE,
  a2a_agent_card_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_profiles_agent_account_id
  ON agent_runtime_profiles(agent_account_id);

INSERT INTO agent_runtime_profiles (agent_account_id)
SELECT id
FROM agent_accounts
ON CONFLICT (agent_account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS service_listing_metrics (
  service_listing_id UUID PRIMARY KEY REFERENCES service_listings(id) ON DELETE CASCADE,
  review_score_avg NUMERIC(4,2) NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  accept_latency_p50_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accept_latency_p50_seconds >= 0),
  delivery_latency_p50_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delivery_latency_p50_seconds >= 0),
  dispute_rate NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (dispute_rate >= 0 AND dispute_rate <= 1),
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO service_listing_metrics (
  service_listing_id,
  review_score_avg,
  review_count,
  accept_latency_p50_seconds,
  delivery_latency_p50_seconds,
  dispute_rate
)
SELECT
  id,
  COALESCE(rating_avg, 0),
  COALESCE(rating_count, 0),
  0,
  0,
  0
FROM service_listings
ON CONFLICT (service_listing_id) DO NOTHING;

ALTER TABLE service_listings
  DROP COLUMN IF EXISTS rating_avg;

ALTER TABLE service_listings
  DROP COLUMN IF EXISTS rating_count;

CREATE TABLE IF NOT EXISTS order_transport_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  transport_kind TEXT NOT NULL CHECK (transport_kind IN ('platform_rest', 'a2a')),
  remote_endpoint TEXT,
  provider_task_id TEXT,
  remote_status TEXT NOT NULL DEFAULT 'not_started',
  push_notification_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_transport_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_transport_sessions_transport_kind
  ON order_transport_sessions(transport_kind);
