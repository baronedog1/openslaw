CREATE TABLE IF NOT EXISTS owner_binding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  owner_display_name TEXT NOT NULL,
  requested_agent_name TEXT NOT NULL,
  requested_agent_slug TEXT NOT NULL,
  requested_agent_description TEXT NOT NULL DEFAULT '',
  requested_budget_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_api_key_hash TEXT NOT NULL UNIQUE,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_agent_id UUID REFERENCES agent_accounts(id) ON DELETE SET NULL,
  flow_kind TEXT NOT NULL CHECK (flow_kind IN ('new_registration', 'existing_email_resolution')),
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('pending', 'activated', 'cancelled')),
  claim_token_hash TEXT,
  claim_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_binding_requests_owner_email_pending
  ON owner_binding_requests(owner_email)
  WHERE resolution_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_owner_binding_requests_target_user_id
  ON owner_binding_requests(target_user_id);

CREATE INDEX IF NOT EXISTS idx_owner_binding_requests_target_agent_id
  ON owner_binding_requests(target_agent_id);

WITH latest_pending_claim_per_email AS (
  SELECT DISTINCT ON (u.email)
    u.email,
    u.display_name,
    u.id AS user_id,
    aa.id AS agent_id,
    aa.agent_name,
    aa.slug,
    aa.description,
    aa.budget_policy_json,
    aa.api_key_hash,
    aa.claim_token_hash,
    aa.claim_token_expires_at
  FROM agent_accounts aa
  JOIN users u ON u.id = aa.user_id
  WHERE aa.status = 'pending_claim'
  ORDER BY
    u.email,
    aa.claim_token_expires_at DESC NULLS LAST,
    aa.updated_at DESC,
    aa.created_at DESC,
    aa.id DESC
)
INSERT INTO owner_binding_requests (
  owner_email,
  owner_display_name,
  requested_agent_name,
  requested_agent_slug,
  requested_agent_description,
  requested_budget_policy_json,
  pending_api_key_hash,
  target_user_id,
  target_agent_id,
  flow_kind,
  resolution_status,
  claim_token_hash,
  claim_token_expires_at
)
SELECT
  candidate.email,
  candidate.display_name,
  candidate.agent_name,
  candidate.slug,
  candidate.description,
  candidate.budget_policy_json,
  candidate.api_key_hash,
  candidate.user_id,
  candidate.agent_id,
  'new_registration',
  'pending',
  candidate.claim_token_hash,
  candidate.claim_token_expires_at
FROM latest_pending_claim_per_email candidate
WHERE NOT EXISTS (
  SELECT 1
  FROM owner_binding_requests obr
  WHERE obr.target_agent_id = candidate.agent_id
    AND obr.resolution_status = 'pending'
)
AND NOT EXISTS (
  SELECT 1
  FROM owner_binding_requests obr
  WHERE obr.owner_email = candidate.email
    AND obr.resolution_status = 'pending'
);
