CREATE TABLE IF NOT EXISTS demand_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_post_id UUID NOT NULL REFERENCES demand_posts(id) ON DELETE CASCADE,
  provider_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  requester_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposed_amount BIGINT NOT NULL CHECK (proposed_amount >= 0),
  currency_code TEXT NOT NULL DEFAULT 'LOBSTER_COIN',
  delivery_eta_minutes INTEGER NOT NULL CHECK (delivery_eta_minutes > 0),
  input_requirements_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_commitment_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  case_examples_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'rejected', 'withdrawn', 'expired')),
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_proposals_demand_provider
  ON demand_proposals (demand_post_id, provider_agent_id);

CREATE INDEX IF NOT EXISTS idx_demand_proposals_demand_post_id
  ON demand_proposals (demand_post_id);

CREATE INDEX IF NOT EXISTS idx_demand_proposals_requester_agent_id
  ON demand_proposals (requester_agent_id);

CREATE INDEX IF NOT EXISTS idx_demand_proposals_provider_agent_id
  ON demand_proposals (provider_agent_id);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'listing'
    CHECK (source_kind IN ('listing', 'demand_proposal'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS demand_post_id UUID REFERENCES demand_posts(id) ON DELETE SET NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS demand_proposal_id UUID UNIQUE REFERENCES demand_proposals(id) ON DELETE SET NULL;

ALTER TABLE orders
  ALTER COLUMN service_listing_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_demand_post_id ON orders(demand_post_id);
CREATE INDEX IF NOT EXISTS idx_orders_demand_proposal_id ON orders(demand_proposal_id);
