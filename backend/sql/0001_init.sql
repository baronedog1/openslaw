CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  public_key_hint TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending_claim', 'suspended')),
  budget_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_account_id UUID NOT NULL UNIQUE REFERENCES agent_accounts(id) ON DELETE CASCADE,
  available_balance BIGINT NOT NULL DEFAULT 0,
  held_balance BIGINT NOT NULL DEFAULT 0,
  pending_settlement_balance BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_packages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  case_examples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_min BIGINT NOT NULL CHECK (price_min >= 0),
  price_max BIGINT NOT NULL CHECK (price_max >= price_min),
  currency_code TEXT NOT NULL DEFAULT 'LOBSTER_COIN',
  delivery_eta_minutes INTEGER NOT NULL CHECK (delivery_eta_minutes > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'banned')),
  rating_avg NUMERIC(4,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT NOT NULL UNIQUE,
  buyer_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  service_listing_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE RESTRICT,
  quoted_amount BIGINT NOT NULL CHECK (quoted_amount >= 0),
  final_amount BIGINT NOT NULL CHECK (final_amount >= 0),
  currency_code TEXT NOT NULL DEFAULT 'LOBSTER_COIN',
  input_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_output_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_confirmation_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN (
    'draft_quote',
    'pending_buyer_confirmation',
    'pending_funds',
    'queued_for_provider',
    'accepted',
    'in_progress',
    'delivered',
    'evaluating',
    'completed',
    'disputed',
    'cancelled',
    'expired'
  )),
  escrow_status TEXT NOT NULL CHECK (escrow_status IN ('none', 'held', 'released', 'refunded')),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'buyer_agent', 'provider_agent', 'admin')),
  actor_id UUID,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  submitted_by_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  artifact_role TEXT NOT NULL CHECK (artifact_role IN ('buyer_input', 'provider_output')),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('text', 'file', 'url', 'bundle')),
  delivery_mode TEXT NOT NULL DEFAULT 'provider_managed' CHECK (delivery_mode IN ('provider_managed', 'platform_managed')),
  storage_provider TEXT CHECK (storage_provider IS NULL OR storage_provider IN ('external_url', 'aliyun_oss')),
  storage_url TEXT,
  bucket_name TEXT,
  object_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  checksum_sha256 TEXT,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('uploading', 'uploaded', 'submitted', 'superseded', 'accepted', 'rejected')),
  uploaded_at TIMESTAMPTZ,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  purge_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  reviewer_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  review_band TEXT NOT NULL CHECK (review_band IN ('positive', 'neutral', 'negative')),
  settlement_action TEXT NOT NULL CHECK (settlement_action IN ('accept_close', 'request_revision', 'open_dispute')),
  commentary TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_account_id UUID NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('grant', 'hold', 'release', 'refund', 'reward', 'penalty', 'settlement')),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  balance_after_available BIGINT NOT NULL,
  balance_after_held BIGINT NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  memo TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_accounts_user_id ON agent_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_service_listings_provider_agent_id ON service_listings(provider_agent_id);
CREATE INDEX IF NOT EXISTS idx_service_listings_status ON service_listings(status);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_agent_id ON orders(buyer_agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_provider_agent_id ON orders(provider_agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_listing_id ON orders(service_listing_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order_id ON delivery_artifacts(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order_status ON delivery_artifacts(order_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order_role_status ON delivery_artifacts(order_id, artifact_role, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_artifacts_object_key
  ON delivery_artifacts(object_key)
  WHERE object_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_entries_wallet_account_id ON wallet_ledger_entries(wallet_account_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_entries_order_id ON wallet_ledger_entries(order_id);
