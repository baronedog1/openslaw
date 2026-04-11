ALTER TABLE users
  ADD COLUMN IF NOT EXISTS membership_tier TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS membership_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS membership_note TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT chk_users_membership_tier
    CHECK (membership_tier IN ('standard', 'member_large_attachment_1gb'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_membership_tier
  ON users(membership_tier);

CREATE INDEX IF NOT EXISTS idx_users_membership_expires_at
  ON users(membership_expires_at);

CREATE TABLE IF NOT EXISTS owner_membership_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_membership_tier TEXT,
  next_membership_tier TEXT,
  previous_membership_starts_at TIMESTAMPTZ,
  next_membership_starts_at TIMESTAMPTZ,
  previous_membership_expires_at TIMESTAMPTZ,
  next_membership_expires_at TIMESTAMPTZ,
  previous_membership_note TEXT,
  next_membership_note TEXT,
  changed_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'db_trigger',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_membership_audit_logs_owner_user_id
  ON owner_membership_audit_logs(owner_user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION log_owner_membership_change()
RETURNS trigger AS $$
DECLARE
  changed_fields JSONB := '{}'::jsonb;
BEGIN
  IF OLD.membership_tier IS DISTINCT FROM NEW.membership_tier THEN
    changed_fields := changed_fields || jsonb_build_object(
      'membership_tier',
      jsonb_build_object('previous', OLD.membership_tier, 'next', NEW.membership_tier)
    );
  END IF;

  IF OLD.membership_starts_at IS DISTINCT FROM NEW.membership_starts_at THEN
    changed_fields := changed_fields || jsonb_build_object(
      'membership_starts_at',
      jsonb_build_object('previous', OLD.membership_starts_at, 'next', NEW.membership_starts_at)
    );
  END IF;

  IF OLD.membership_expires_at IS DISTINCT FROM NEW.membership_expires_at THEN
    changed_fields := changed_fields || jsonb_build_object(
      'membership_expires_at',
      jsonb_build_object('previous', OLD.membership_expires_at, 'next', NEW.membership_expires_at)
    );
  END IF;

  IF OLD.membership_note IS DISTINCT FROM NEW.membership_note THEN
    changed_fields := changed_fields || jsonb_build_object(
      'membership_note',
      jsonb_build_object('previous', OLD.membership_note, 'next', NEW.membership_note)
    );
  END IF;

  INSERT INTO owner_membership_audit_logs (
    owner_user_id,
    previous_membership_tier,
    next_membership_tier,
    previous_membership_starts_at,
    next_membership_starts_at,
    previous_membership_expires_at,
    next_membership_expires_at,
    previous_membership_note,
    next_membership_note,
    changed_fields_json,
    source
  )
  VALUES (
    NEW.id,
    OLD.membership_tier,
    NEW.membership_tier,
    OLD.membership_starts_at,
    NEW.membership_starts_at,
    OLD.membership_expires_at,
    NEW.membership_expires_at,
    OLD.membership_note,
    NEW.membership_note,
    changed_fields,
    'db_trigger'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owner_membership_audit ON users;

CREATE TRIGGER trg_owner_membership_audit
AFTER UPDATE OF membership_tier, membership_starts_at, membership_expires_at, membership_note
ON users
FOR EACH ROW
WHEN (
  OLD.membership_tier IS DISTINCT FROM NEW.membership_tier OR
  OLD.membership_starts_at IS DISTINCT FROM NEW.membership_starts_at OR
  OLD.membership_expires_at IS DISTINCT FROM NEW.membership_expires_at OR
  OLD.membership_note IS DISTINCT FROM NEW.membership_note
)
EXECUTE FUNCTION log_owner_membership_change();
