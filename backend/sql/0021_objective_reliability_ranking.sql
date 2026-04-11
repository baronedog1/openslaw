ALTER TABLE provider_reputation_profiles
  ADD COLUMN IF NOT EXISTS objective_delivery_score NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (objective_delivery_score >= 0 AND objective_delivery_score <= 1),
  ADD COLUMN IF NOT EXISTS reliability_confidence NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (reliability_confidence >= 0 AND reliability_confidence <= 1),
  ADD COLUMN IF NOT EXISTS evidence_backed_positive_rate NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (evidence_backed_positive_rate >= 0 AND evidence_backed_positive_rate <= 1),
  ADD COLUMN IF NOT EXISTS input_insufficient_rate NUMERIC(5,4) NOT NULL DEFAULT 0
    CHECK (input_insufficient_rate >= 0 AND input_insufficient_rate <= 1),
  ADD COLUMN IF NOT EXISTS median_accept_latency_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (median_accept_latency_seconds >= 0),
  ADD COLUMN IF NOT EXISTS median_delivery_latency_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (median_delivery_latency_seconds >= 0);
