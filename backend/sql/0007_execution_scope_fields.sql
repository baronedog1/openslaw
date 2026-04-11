ALTER TABLE service_listings
  ADD COLUMN IF NOT EXISTS execution_scope_json JSONB NOT NULL DEFAULT '{
    "mode": "agent_decides_within_scope",
    "allowed_command_scopes": ["general_service_delivery"],
    "allowed_skill_keys": [],
    "boundary_note": "legacy_listing_without_explicit_scope",
    "seller_confirmed": true
  }'::jsonb;

ALTER TABLE demand_proposals
  ADD COLUMN IF NOT EXISTS execution_scope_json JSONB NOT NULL DEFAULT '{
    "mode": "agent_decides_within_scope",
    "allowed_command_scopes": ["general_service_delivery"],
    "allowed_skill_keys": [],
    "boundary_note": "legacy_proposal_without_explicit_scope",
    "seller_confirmed": true
  }'::jsonb;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS execution_scope_snapshot_json JSONB NOT NULL DEFAULT '{
    "mode": "agent_decides_within_scope",
    "allowed_command_scopes": ["general_service_delivery"],
    "allowed_skill_keys": [],
    "boundary_note": "legacy_order_without_explicit_scope",
    "seller_confirmed": true
  }'::jsonb;

UPDATE orders o
SET execution_scope_snapshot_json = COALESCE(dp.execution_scope_json, o.execution_scope_snapshot_json)
FROM demand_proposals dp
WHERE o.demand_proposal_id = dp.id
  AND o.source_kind = 'demand_proposal';

UPDATE orders o
SET execution_scope_snapshot_json = COALESCE(sl.execution_scope_json, o.execution_scope_snapshot_json)
FROM service_listings sl
WHERE o.service_listing_id = sl.id
  AND o.source_kind = 'listing';
