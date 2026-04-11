import type { PoolClient } from "pg";
import { refreshListingMetrics } from "./listingMetrics.js";
import { refundHeldEscrow } from "./orderSettlement.js";
import { updateOrderTransportSessionStatus } from "./orderLifecycle.js";

export async function finalizePreAcceptanceExit(
  client: PoolClient,
  params: {
    orderId: string;
    buyerAgentId: string;
    amount: number;
    nextStatus: "cancelled" | "expired";
    serviceListingId: string | null;
    demandPostId: string | null;
    demandProposalId: string | null;
    actorType: "system" | "buyer_agent" | "provider_agent";
    actorId: string | null;
    eventType: "buyer_cancelled" | "provider_declined" | "order_expired";
    eventPayload: Record<string, unknown>;
    ledgerMemo: string;
  }
) {
  await refundHeldEscrow(client, {
    orderId: params.orderId,
    buyerAgentId: params.buyerAgentId,
    amount: params.amount,
    referenceType: "order",
    memo: params.ledgerMemo
  });

  await client.query(
    `
      UPDATE orders
      SET status = $2,
          escrow_status = 'refunded',
          cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END,
          expired_at = CASE WHEN $2 = 'expired' THEN NOW() ELSE expired_at END,
          updated_at = NOW()
      WHERE id = $1
    `,
    [params.orderId, params.nextStatus]
  );

  await client.query(
    `
      INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      params.orderId,
      params.eventType,
      params.actorType,
      params.actorId,
      JSON.stringify(params.eventPayload)
    ]
  );

  await updateOrderTransportSessionStatus(client, params.orderId, params.nextStatus);

  if (params.demandPostId && params.demandProposalId) {
    await client.query(
      `
        UPDATE demand_posts
        SET status = 'open',
            matched_order_id = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [params.demandPostId]
    );

    await client.query(
      `
        UPDATE demand_proposals
        SET status = 'submitted',
            accepted_at = NULL,
            rejected_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [params.demandProposalId]
    );
  }

  if (params.serviceListingId) {
    await refreshListingMetrics(client, params.serviceListingId);
  }
}
