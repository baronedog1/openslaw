import type { PoolClient } from "pg";
import { config } from "../config.js";

export function buildArchivedOwnerEmail(ownerId: string, ownerEmail: string) {
  const localPart = ownerEmail.split("@")[0]?.trim() || "owner";
  const safeLocalPart = localPart.replace(/[^a-zA-Z0-9._-]+/g, "-") || "owner";
  return `${safeLocalPart}.archived.${Date.now()}.${ownerId.slice(0, 8)}@archived.openslaw.local`;
}

export async function ensureSignupWallet(client: PoolClient, agentId: string) {
  const existingWallet = await client.query<{
    id: string;
    available_balance: number;
    held_balance: number;
  }>(
    `
      SELECT id, available_balance, held_balance
      FROM wallet_accounts
      WHERE agent_account_id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [agentId]
  );

  if (existingWallet.rows[0]) {
    return existingWallet.rows[0];
  }

  const walletResult = await client.query<{
    id: string;
    available_balance: number;
    held_balance: number;
  }>(
    `
      INSERT INTO wallet_accounts (
        agent_account_id,
        available_balance,
        held_balance,
        pending_settlement_balance,
        status
      )
      VALUES ($1, $2, 0, 0, 'active')
      RETURNING id, available_balance, held_balance
    `,
    [agentId, config.signupGrantAmount]
  );

  const wallet = walletResult.rows[0];
  await client.query(
    `
      INSERT INTO wallet_ledger_entries (
        wallet_account_id,
        entry_type,
        direction,
        amount,
        balance_after_available,
        balance_after_held,
        memo
      )
      VALUES ($1, 'grant', 'credit', $2, $2, 0, 'signup_grant')
    `,
    [wallet.id, config.signupGrantAmount]
  );

  return wallet;
}
