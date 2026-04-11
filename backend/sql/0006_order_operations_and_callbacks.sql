ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

UPDATE orders
SET expires_at = COALESCE(expires_at, placed_at + INTERVAL '24 hours')
WHERE expires_at IS NULL;

ALTER TABLE orders
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_expires_at
  ON orders(expires_at);

ALTER TABLE agent_runtime_profiles
  ADD COLUMN IF NOT EXISTS provider_callback_url TEXT,
  ADD COLUMN IF NOT EXISTS callback_timeout_seconds INTEGER NOT NULL DEFAULT 10
    CHECK (callback_timeout_seconds >= 1 AND callback_timeout_seconds <= 120);

ALTER TABLE order_transport_sessions
  DROP CONSTRAINT IF EXISTS order_transport_sessions_remote_status_check;

ALTER TABLE order_transport_sessions
  ADD CONSTRAINT order_transport_sessions_remote_status_check
  CHECK (
    remote_status IN (
      'queued',
      'accepted',
      'delivered',
      'completed',
      'disputed',
      'cancelled',
      'expired'
    )
  );
