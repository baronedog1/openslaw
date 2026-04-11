CREATE TABLE IF NOT EXISTS transaction_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  service_listing_id UUID NOT NULL REFERENCES service_listings(id) ON DELETE RESTRICT,
  buyer_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  review_id UUID REFERENCES reviews(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  review_band TEXT NOT NULL CHECK (review_band IN ('positive', 'neutral', 'negative')),
  settlement_action TEXT NOT NULL CHECK (settlement_action IN ('accept_close', 'request_revision', 'open_dispute')),
  completion_outcome TEXT NOT NULL CHECK (completion_outcome IN ('completed', 'disputed')),
  agreed_amount BIGINT NOT NULL CHECK (agreed_amount >= 0),
  currency_code TEXT NOT NULL DEFAULT 'LOBSTER_COIN',
  listing_title TEXT NOT NULL,
  listing_summary TEXT NOT NULL DEFAULT '',
  snapshot_title TEXT NOT NULL,
  snapshot_summary TEXT NOT NULL DEFAULT '',
  searchable_text TEXT NOT NULL DEFAULT '',
  provider_tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_keys_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_keys_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_output_types_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  buyer_context_summary TEXT NOT NULL DEFAULT '',
  buyer_context_has_artifacts BOOLEAN NOT NULL DEFAULT FALSE,
  buyer_context_has_external_links BOOLEAN NOT NULL DEFAULT FALSE,
  buyer_input_artifact_count INTEGER NOT NULL DEFAULT 0 CHECK (buyer_input_artifact_count >= 0),
  provider_output_artifact_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_output_artifact_count >= 0),
  review_commentary TEXT NOT NULL DEFAULT '',
  evidence_keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivery_eta_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delivery_eta_minutes >= 0),
  delivery_latency_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delivery_latency_seconds >= 0),
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  effective_visibility_scope TEXT NOT NULL DEFAULT 'private_audit_only'
    CHECK (effective_visibility_scope IN (
      'private_audit_only',
      'platform_index_only',
      'agent_search_preview',
      'public_verified_case'
    )),
  allow_in_agent_search BOOLEAN NOT NULL DEFAULT FALSE,
  allow_in_public_showcase BOOLEAN NOT NULL DEFAULT FALSE,
  visibility_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_snapshots_listing_visibility
  ON transaction_snapshots(service_listing_id, allow_in_agent_search, allow_in_public_showcase, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_snapshots_provider
  ON transaction_snapshots(provider_agent_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_snapshots_outcome
  ON transaction_snapshots(completion_outcome, completed_at DESC);

CREATE TABLE IF NOT EXISTS transaction_snapshot_visibility_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  granted_by_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('buyer_agent', 'provider_agent')),
  allow_platform_index BOOLEAN NOT NULL DEFAULT FALSE,
  allow_agent_search_preview BOOLEAN NOT NULL DEFAULT FALSE,
  allow_public_case_preview BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(order_id, granted_by_agent_id),
  UNIQUE(order_id, actor_role)
);

CREATE INDEX IF NOT EXISTS idx_transaction_snapshot_visibility_grants_order
  ON transaction_snapshot_visibility_grants(order_id, actor_role);

CREATE TABLE IF NOT EXISTS provider_reputation_profiles (
  provider_agent_id UUID PRIMARY KEY REFERENCES agent_accounts(id) ON DELETE CASCADE,
  completed_order_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_order_count >= 0),
  disputed_order_count INTEGER NOT NULL DEFAULT 0 CHECK (disputed_order_count >= 0),
  positive_review_count INTEGER NOT NULL DEFAULT 0 CHECK (positive_review_count >= 0),
  neutral_review_count INTEGER NOT NULL DEFAULT 0 CHECK (neutral_review_count >= 0),
  negative_review_count INTEGER NOT NULL DEFAULT 0 CHECK (negative_review_count >= 0),
  accept_close_count INTEGER NOT NULL DEFAULT 0 CHECK (accept_close_count >= 0),
  revision_requested_count INTEGER NOT NULL DEFAULT 0 CHECK (revision_requested_count >= 0),
  dispute_open_count INTEGER NOT NULL DEFAULT 0 CHECK (dispute_open_count >= 0),
  on_time_delivery_rate NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (on_time_delivery_rate >= 0 AND on_time_delivery_rate <= 1),
  accept_close_rate NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (accept_close_rate >= 0 AND accept_close_rate <= 1),
  revision_rate NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (revision_rate >= 0 AND revision_rate <= 1),
  dispute_rate NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (dispute_rate >= 0 AND dispute_rate <= 1),
  agent_search_case_count INTEGER NOT NULL DEFAULT 0 CHECK (agent_search_case_count >= 0),
  public_case_count INTEGER NOT NULL DEFAULT 0 CHECK (public_case_count >= 0),
  last_completed_order_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE service_listing_metrics
  ADD COLUMN IF NOT EXISTS accept_close_rate NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (accept_close_rate >= 0 AND accept_close_rate <= 1),
  ADD COLUMN IF NOT EXISTS on_time_delivery_rate NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (on_time_delivery_rate >= 0 AND on_time_delivery_rate <= 1),
  ADD COLUMN IF NOT EXISTS revision_rate NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (revision_rate >= 0 AND revision_rate <= 1),
  ADD COLUMN IF NOT EXISTS verified_case_count INTEGER NOT NULL DEFAULT 0
    CHECK (verified_case_count >= 0),
  ADD COLUMN IF NOT EXISTS public_case_count INTEGER NOT NULL DEFAULT 0
    CHECK (public_case_count >= 0);
