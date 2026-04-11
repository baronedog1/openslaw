import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdminAgent } from "../auth.js";
import { refreshListingMetrics } from "../domain/listingMetrics.js";
import { updateOrderTransportSessionStatus } from "../domain/orderLifecycle.js";
import { queueProviderRelayEvent } from "../domain/providerRelay.js";
import { refundHeldEscrow, releaseHeldEscrowToProvider } from "../domain/orderSettlement.js";
import { refreshValidatedConcurrency } from "../domain/runtimeProfiles.js";
import { withTransaction } from "../db.js";
import { json } from "../utils.js";

const resolveDisputeSchema = z.object({
  resolution: z.enum(["release_to_provider", "refund_to_buyer"]),
  resolution_note: z.string().min(1),
  evidence: z.record(z.any()).default({})
});

export async function registerAdminOrderRoutes(app: FastifyInstance) {
  app.post("/api/v1/admin/orders/:orderId/resolve", async (request, reply) => {
    const admin = await requireAdminAgent(request, reply);
    if (!admin) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = resolveDisputeSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        buyer_agent_id: string;
        provider_agent_id: string;
        service_listing_id: string | null;
        final_amount: number;
        status: string;
        escrow_status: string;
      }>(
        `
          SELECT id, buyer_agent_id, provider_agent_id, service_listing_id, final_amount, status, escrow_status
          FROM orders
          WHERE id = $1
          FOR UPDATE
        `,
        [params.orderId]
      );

      const order = orderResult.rows[0];
      if (!order) {
        throw new Error("order_not_found");
      }

      if (order.status !== "disputed" || order.escrow_status !== "held") {
        throw new Error("order_not_disputed");
      }

      const amount = Number(order.final_amount);

      if (body.resolution === "release_to_provider") {
        await releaseHeldEscrowToProvider(client, {
          orderId: order.id,
          buyerAgentId: order.buyer_agent_id,
          providerAgentId: order.provider_agent_id,
          amount
        });

        await client.query(
          `
            UPDATE orders
            SET status = 'completed',
                escrow_status = 'released',
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `,
          [order.id]
        );

        await client.query(
          `
            INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
            VALUES
              ($1, 'dispute_resolved', 'admin', $2, $3::jsonb),
              ($1, 'settlement_released', 'system', NULL, $4::jsonb)
          `,
          [
            order.id,
            admin.id,
            json({
              resolution: body.resolution,
              resolution_note: body.resolution_note,
              evidence: body.evidence
            }),
            json({ amount, resolution: body.resolution })
          ]
        );

        await updateOrderTransportSessionStatus(client, order.id, "completed");
      } else {
        await refundHeldEscrow(client, {
          orderId: order.id,
          buyerAgentId: order.buyer_agent_id,
          amount,
          referenceType: "order",
          memo: "dispute_refund"
        });

        await client.query(
          `
            UPDATE orders
            SET status = 'cancelled',
                escrow_status = 'refunded',
                cancelled_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `,
          [order.id]
        );

        await client.query(
          `
            INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
            VALUES
              ($1, 'dispute_resolved', 'admin', $2, $3::jsonb),
              ($1, 'refund_issued', 'system', NULL, $4::jsonb)
          `,
          [
            order.id,
            admin.id,
            json({
              resolution: body.resolution,
              resolution_note: body.resolution_note,
              evidence: body.evidence
            }),
            json({ amount, resolution: body.resolution })
          ]
        );

        await updateOrderTransportSessionStatus(client, order.id, "cancelled");
      }

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }

      await refreshValidatedConcurrency(client, order.provider_agent_id);

      return {
        status: body.resolution === "release_to_provider" ? "completed" : "cancelled",
        resolution: body.resolution
      };
    }).catch((error: Error) => {
      if (["admin_forbidden", "order_not_found", "order_not_disputed"].includes(error.message)) {
        reply.code(
          error.message === "order_not_found"
            ? 404
            : error.message === "admin_forbidden"
              ? 403
              : 409
        ).send({ error: error.message });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    void queueProviderRelayEvent({
      orderId: params.orderId,
      eventType: "order_dispute_resolved"
    }).catch((error) => {
      app.log.warn(error, "provider relay queue failed after dispute resolution");
    });

    return result;
  });
}
