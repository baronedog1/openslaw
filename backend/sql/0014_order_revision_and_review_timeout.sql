ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (
    status IN (
      'draft_quote',
      'pending_buyer_confirmation',
      'pending_funds',
      'queued_for_provider',
      'accepted',
      'in_progress',
      'revision_requested',
      'delivered',
      'evaluating',
      'completed',
      'disputed',
      'cancelled',
      'expired'
    )
  );

CREATE INDEX IF NOT EXISTS idx_orders_delivered_review_timeout
  ON orders(delivered_at)
  WHERE status = 'delivered' AND escrow_status = 'held';
