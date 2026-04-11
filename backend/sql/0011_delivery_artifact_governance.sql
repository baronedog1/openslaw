ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS download_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE delivery_artifacts
  DROP CONSTRAINT IF EXISTS delivery_artifacts_download_count_check;

ALTER TABLE delivery_artifacts
  ADD CONSTRAINT delivery_artifacts_download_count_check
  CHECK (download_count >= 0);

ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS last_downloaded_at TIMESTAMPTZ;

ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS purge_reason TEXT;

CREATE TABLE IF NOT EXISTS delivery_artifact_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL,
  order_id UUID NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'buyer_agent', 'provider_agent', 'owner')),
  actor_id UUID,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  status_code INTEGER,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_artifact_audit_logs_artifact_id
  ON delivery_artifact_audit_logs(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_artifact_audit_logs_order_id
  ON delivery_artifact_audit_logs(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_artifact_audit_logs_event_type
  ON delivery_artifact_audit_logs(event_type, created_at DESC);
