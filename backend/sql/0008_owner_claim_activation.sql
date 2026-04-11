ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verification_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;

ALTER TABLE agent_accounts
  ADD COLUMN IF NOT EXISTS claim_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS claim_token_expires_at TIMESTAMPTZ;
