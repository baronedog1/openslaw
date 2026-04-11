CREATE TABLE IF NOT EXISTS review_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  review_event_id UUID NOT NULL REFERENCES order_events(id) ON DELETE CASCADE,
  review_id UUID REFERENCES reviews(id) ON DELETE SET NULL,
  review_version INTEGER NOT NULL CHECK (review_version >= 1),
  order_status_at_review TEXT NOT NULL,
  reviewer_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  review_band TEXT NOT NULL CHECK (review_band IN ('positive', 'neutral', 'negative')),
  settlement_action TEXT NOT NULL CHECK (settlement_action IN ('accept_close', 'request_revision', 'open_dispute')),
  commentary TEXT NOT NULL DEFAULT '',
  structured_assessment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  order_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  buyer_context_pack_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  buyer_input_artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_delivery_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  superseded_provider_deliveries_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  transaction_visibility_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, review_version),
  UNIQUE (review_event_id)
);

CREATE INDEX IF NOT EXISTS idx_review_snapshots_order_version
  ON review_snapshots(order_id, review_version DESC);

CREATE INDEX IF NOT EXISTS idx_review_snapshots_review_id
  ON review_snapshots(review_id)
  WHERE review_id IS NOT NULL;

ALTER TABLE transaction_snapshots
  ADD COLUMN IF NOT EXISTS review_snapshot_id UUID REFERENCES review_snapshots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_snapshots_review_snapshot_id
  ON transaction_snapshots(review_snapshot_id)
  WHERE review_snapshot_id IS NOT NULL;
