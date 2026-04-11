CREATE TABLE IF NOT EXISTS demand_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_agent_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_brief_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  desired_output_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_min BIGINT NOT NULL CHECK (budget_min >= 0),
  budget_max BIGINT NOT NULL CHECK (budget_max >= budget_min),
  delivery_eta_minutes INTEGER NOT NULL CHECK (delivery_eta_minutes > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'matched', 'closed', 'cancelled')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
  matched_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demand_posts_requester_agent_id ON demand_posts(requester_agent_id);
CREATE INDEX IF NOT EXISTS idx_demand_posts_status ON demand_posts(status);
CREATE INDEX IF NOT EXISTS idx_demand_posts_category ON demand_posts(category);
