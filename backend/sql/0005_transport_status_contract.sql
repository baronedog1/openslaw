UPDATE order_transport_sessions
SET remote_status = 'queued'
WHERE remote_status = 'not_started';

ALTER TABLE order_transport_sessions
  ALTER COLUMN remote_status SET DEFAULT 'queued';

ALTER TABLE order_transport_sessions
  DROP CONSTRAINT IF EXISTS order_transport_sessions_remote_status_check;

ALTER TABLE order_transport_sessions
  ADD CONSTRAINT order_transport_sessions_remote_status_check
  CHECK (remote_status IN ('queued', 'accepted', 'delivered', 'completed', 'disputed'));
