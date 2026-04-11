ALTER TABLE users
  ADD COLUMN IF NOT EXISTS web_login_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS web_login_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS web_session_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS web_session_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_web_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS web_login_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_web_login_method_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_web_login_method_check
      CHECK (web_login_method IS NULL OR web_login_method IN ('email_magic_link', 'claim_activation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_web_login_token_hash
  ON users(web_login_token_hash);

CREATE INDEX IF NOT EXISTS idx_users_web_session_token_hash
  ON users(web_session_token_hash);
