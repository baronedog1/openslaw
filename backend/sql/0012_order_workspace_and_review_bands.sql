ALTER TABLE delivery_artifacts
  ADD COLUMN IF NOT EXISTS artifact_role TEXT NOT NULL DEFAULT 'provider_output';

ALTER TABLE delivery_artifacts
  DROP CONSTRAINT IF EXISTS delivery_artifacts_artifact_role_check;

ALTER TABLE delivery_artifacts
  ADD CONSTRAINT delivery_artifacts_artifact_role_check
  CHECK (artifact_role IN ('buyer_input', 'provider_output'));

UPDATE delivery_artifacts
SET artifact_role = COALESCE(artifact_role, 'provider_output')
WHERE artifact_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order_role_status
  ON delivery_artifacts(order_id, artifact_role, status);

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS review_band TEXT;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS settlement_action TEXT;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'reviews'
      AND column_name = 'decision'
  ) THEN
    UPDATE reviews
    SET review_band = CASE decision
                        WHEN 'accept' THEN 'positive'
                        WHEN 'revise' THEN 'neutral'
                        WHEN 'reject' THEN 'negative'
                        ELSE review_band
                      END,
        settlement_action = CASE decision
                              WHEN 'accept' THEN 'accept_close'
                              WHEN 'revise' THEN 'request_revision'
                              WHEN 'reject' THEN 'open_dispute'
                              ELSE settlement_action
                            END,
        updated_at = COALESCE(updated_at, NOW())
    WHERE review_band IS NULL
       OR settlement_action IS NULL;
  END IF;
END $$;

ALTER TABLE reviews
  ALTER COLUMN review_band SET NOT NULL;

ALTER TABLE reviews
  ALTER COLUMN settlement_action SET NOT NULL;

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_review_band_check;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_review_band_check
  CHECK (review_band IN ('positive', 'neutral', 'negative'));

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_settlement_action_check;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_settlement_action_check
  CHECK (settlement_action IN ('accept_close', 'request_revision', 'open_dispute'));

ALTER TABLE reviews
  DROP COLUMN IF EXISTS score_overall;

ALTER TABLE reviews
  DROP COLUMN IF EXISTS score_breakdown_json;

ALTER TABLE reviews
  DROP COLUMN IF EXISTS decision;
