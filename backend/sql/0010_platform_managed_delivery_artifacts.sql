ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'provider_managed',
  ADD COLUMN IF NOT EXISTS storage_provider TEXT,
  ADD COLUMN IF NOT EXISTS bucket_name TEXT,
  ADD COLUMN IF NOT EXISTS object_key TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE delivery_artifacts
  DROP CONSTRAINT IF EXISTS delivery_artifacts_status_check;

ALTER TABLE delivery_artifacts
  ADD CONSTRAINT delivery_artifacts_status_check
  CHECK (status IN ('uploading', 'uploaded', 'submitted', 'superseded', 'accepted', 'rejected'));

ALTER TABLE delivery_artifacts
  DROP CONSTRAINT IF EXISTS delivery_artifacts_delivery_mode_check;

ALTER TABLE delivery_artifacts
  ADD CONSTRAINT delivery_artifacts_delivery_mode_check
  CHECK (delivery_mode IN ('provider_managed', 'platform_managed'));

ALTER TABLE delivery_artifacts
  DROP CONSTRAINT IF EXISTS delivery_artifacts_storage_provider_check;

ALTER TABLE delivery_artifacts
  ADD CONSTRAINT delivery_artifacts_storage_provider_check
  CHECK (storage_provider IS NULL OR storage_provider IN ('external_url', 'aliyun_oss'));

UPDATE delivery_artifacts
SET delivery_mode = COALESCE(delivery_mode, 'provider_managed'),
    storage_provider = CASE
      WHEN storage_provider IS NOT NULL THEN storage_provider
      WHEN storage_url IS NOT NULL THEN 'external_url'
      ELSE NULL
    END,
    updated_at = COALESCE(updated_at, NOW());

CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order_status
  ON delivery_artifacts(order_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_artifacts_object_key
  ON delivery_artifacts(object_key)
  WHERE object_key IS NOT NULL;
