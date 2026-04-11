import type { PoolClient } from "pg";

async function lockWalletByAgent(client: PoolClient, agentAccountId: string) {
  const result = await client.query<{
    id: string;
    available_balance: number;
    held_balance: number;
  }>(
    `
      SELECT id, available_balance, held_balance
      FROM wallet_accounts
      WHERE agent_account_id = $1
      FOR UPDATE
    `,
    [agentAccountId]
  );

  const wallet = result.rows[0];
  if (!wallet) {
    throw new Error("wallet_not_found");
  }

  return wallet;
}

export async function refundHeldEscrow(
  client: PoolClient,
  params: {
    orderId: string;
    buyerAgentId: string;
    amount: number;
    referenceType: string;
    memo: string;
  }
) {
  const buyerWallet = await lockWalletByAgent(client, params.buyerAgentId);
  const nextAvailable = Number(buyerWallet.available_balance) + params.amount;
  const nextHeld = Number(buyerWallet.held_balance) - params.amount;

  if (nextHeld < 0) {
    throw new Error("wallet_held_balance_underflow");
  }

  await client.query(
    `
      UPDATE wallet_accounts
      SET available_balance = $2,
          held_balance = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [buyerWallet.id, nextAvailable, nextHeld]
  );

  await client.query(
    `
      INSERT INTO wallet_ledger_entries (
        wallet_account_id,
        order_id,
        entry_type,
        direction,
        amount,
        balance_after_available,
        balance_after_held,
        reference_type,
        memo
      )
      VALUES ($1, $2, 'refund', 'credit', $3, $4, $5, $6, $7)
    `,
    [
      buyerWallet.id,
      params.orderId,
      params.amount,
      nextAvailable,
      nextHeld,
      params.referenceType,
      params.memo
    ]
  );
}

export async function releaseHeldEscrowToProvider(
  client: PoolClient,
  params: {
    orderId: string;
    buyerAgentId: string;
    providerAgentId: string;
    amount: number;
  }
) {
  const buyerWallet = await lockWalletByAgent(client, params.buyerAgentId);
  const providerWallet = await lockWalletByAgent(client, params.providerAgentId);

  const buyerHeldAfter = Number(buyerWallet.held_balance) - params.amount;
  const providerAvailableAfter = Number(providerWallet.available_balance) + params.amount;

  if (buyerHeldAfter < 0) {
    throw new Error("wallet_held_balance_underflow");
  }

  await client.query(
    `
      UPDATE wallet_accounts
      SET held_balance = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [buyerWallet.id, buyerHeldAfter]
  );

  await client.query(
    `
      UPDATE wallet_accounts
      SET available_balance = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [providerWallet.id, providerAvailableAfter]
  );

  await client.query(
    `
      INSERT INTO wallet_ledger_entries (
        wallet_account_id, order_id, entry_type, direction, amount,
        balance_after_available, balance_after_held, reference_type, memo
      )
      VALUES
        ($1, $2, 'release', 'debit', $3, $4, $5, 'order', 'escrow_release'),
        ($6, $2, 'settlement', 'credit', $3, $7, $8, 'order', 'provider_settlement')
    `,
    [
      buyerWallet.id,
      params.orderId,
      params.amount,
      Number(buyerWallet.available_balance),
      buyerHeldAfter,
      providerWallet.id,
      providerAvailableAfter,
      Number(providerWallet.held_balance)
    ]
  );
}
