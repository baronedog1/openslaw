import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { writeDeliveryArtifactAudit } from "../domain/deliveryArtifactAudit.js";
import { refreshListingMetrics } from "../domain/listingMetrics.js";
import { deletePlatformManagedObject } from "../domain/objectStorage.js";
import { finalizePreAcceptanceExit } from "../domain/orderOperations.js";
import { releaseHeldEscrowToProvider } from "../domain/orderSettlement.js";
import { queueProviderRelayEvent } from "../domain/providerRelay.js";
import { upsertReviewSnapshotsForOrder } from "../domain/reviewSnapshots.js";
import { refreshValidatedConcurrency } from "../domain/runtimeProfiles.js";
import { updateOrderTransportSessionStatus } from "../domain/orderLifecycle.js";
import {
  getOrderTransactionVisibility,
  refreshProviderReputationProfile,
  upsertTransactionSnapshotForOrder
} from "../domain/transactionEvidence.js";
import { query, withTransaction } from "../db.js";

function authenticateSystemRequest(headers: Record<string, unknown>) {
  const token = headers["x-openslaw-system-token"];
  return typeof token === "string" && token === config.systemCronToken;
}

type ArtifactCleanupCandidate = {
  id: string;
  order_id: string;
  object_key: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  status: string;
  created_at: string;
  uploaded_at: string | null;
  purged_at: string | null;
  order_status: string | null;
  completed_at: string | null;
  order_updated_at: string | null;
  cleanup_reason:
    | "large_unfinished_retention_expired"
    | "large_terminal_retention_expired"
    | "stale_uploading"
    | "stale_uploaded"
    | "completed_retention_expired"
    | "disputed_retention_expired";
};

function isOlderThan(timestamp: string | null, maxAgeMs: number) {
  if (!timestamp) {
    return false;
  }

  return Date.now() - new Date(timestamp).getTime() >= maxAgeMs;
}

function isLargePlatformManagedArtifact(sizeBytes: number | null) {
  return typeof sizeBytes === "number" && sizeBytes > config.deliveryArtifacts.maxManagedArtifactBytes;
}

function isTerminalOrderStatus(status: string | null) {
  return ["completed", "disputed", "cancelled", "expired"].includes(status ?? "");
}

function getTerminalRetentionAnchor(candidate: ArtifactCleanupCandidate) {
  if (candidate.order_status === "completed") {
    return candidate.completed_at;
  }

  if (candidate.order_status === "disputed" || candidate.order_status === "cancelled" || candidate.order_status === "expired") {
    return candidate.order_updated_at;
  }

  return null;
}

function artifactCleanupStillDue(candidate: ArtifactCleanupCandidate) {
  if (candidate.purged_at) {
    return false;
  }

  switch (candidate.cleanup_reason) {
    case "large_unfinished_retention_expired":
      if (!isLargePlatformManagedArtifact(candidate.size_bytes)) {
        return false;
      }

      if (candidate.status === "uploading") {
        return isOlderThan(
          candidate.created_at,
          config.deliveryArtifacts.largeArtifactPendingRetentionHours * 60 * 60 * 1000
        );
      }

      if (candidate.status === "uploaded") {
        return isOlderThan(
          candidate.uploaded_at,
          config.deliveryArtifacts.largeArtifactPendingRetentionHours * 60 * 60 * 1000
        );
      }

      return false;
    case "large_terminal_retention_expired":
      return (
        isLargePlatformManagedArtifact(candidate.size_bytes) &&
        isTerminalOrderStatus(candidate.order_status) &&
        isOlderThan(
          getTerminalRetentionAnchor(candidate),
          config.deliveryArtifacts.largeArtifactTerminalRetentionDays * 24 * 60 * 60 * 1000
        )
      );
    case "stale_uploading":
      return (
        candidate.status === "uploading" &&
        isOlderThan(candidate.created_at, config.deliveryArtifacts.staleUploadingTtlHours * 60 * 60 * 1000)
      );
    case "stale_uploaded":
      return (
        candidate.status === "uploaded" &&
        isOlderThan(candidate.uploaded_at, config.deliveryArtifacts.staleUploadedTtlHours * 60 * 60 * 1000)
      );
    case "completed_retention_expired":
      return (
        candidate.order_status === "completed" &&
        isOlderThan(
          candidate.completed_at,
          config.deliveryArtifacts.completedRetentionDays * 24 * 60 * 60 * 1000
        )
      );
    case "disputed_retention_expired":
      return (
        candidate.order_status === "disputed" &&
        isOlderThan(
          candidate.order_updated_at,
          config.deliveryArtifacts.disputedRetentionDays * 24 * 60 * 60 * 1000
        )
      );
  }
}

export async function registerSystemRoutes(app: FastifyInstance) {
  app.post("/api/v1/system/orders/expire-stale", async (request, reply) => {
    if (!authenticateSystemRequest(request.headers as Record<string, unknown>)) {
      reply.code(401).send({ error: "invalid_system_token" });
      return;
    }

    const queryParams = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100)
      })
      .parse(request.query);

    const candidates = await query<{
      id: string;
    }>(
      `
        SELECT id
        FROM orders
        WHERE status IN ('awaiting_buyer_context', 'queued_for_provider')
          AND escrow_status = 'held'
          AND expires_at <= NOW()
        ORDER BY expires_at ASC
        LIMIT $1
      `,
      [queryParams.limit]
    );

    const expiredOrderIds: string[] = [];

    for (const candidate of candidates.rows) {
      const processed = await withTransaction(async (client) => {
        const orderResult = await client.query<{
          id: string;
          buyer_agent_id: string;
          service_listing_id: string | null;
          demand_post_id: string | null;
          demand_proposal_id: string | null;
          final_amount: number;
          status: string;
          escrow_status: string;
          notify_provider: boolean;
        }>(
          `
            SELECT id, buyer_agent_id, service_listing_id, demand_post_id, demand_proposal_id,
                   final_amount, status, escrow_status,
                   status <> 'awaiting_buyer_context' AS notify_provider
            FROM orders
            WHERE id = $1
            FOR UPDATE
          `,
          [candidate.id]
        );

        const order = orderResult.rows[0];
        if (
          !order ||
          !["awaiting_buyer_context", "queued_for_provider"].includes(order.status) ||
          order.escrow_status !== "held"
        ) {
          return false;
        }

        await finalizePreAcceptanceExit(client, {
          orderId: order.id,
          buyerAgentId: order.buyer_agent_id,
          amount: Number(order.final_amount),
          nextStatus: "expired",
          serviceListingId: order.service_listing_id,
          demandPostId: order.demand_post_id,
          demandProposalId: order.demand_proposal_id,
          actorType: "system",
          actorId: null,
          eventType: "order_expired",
          eventPayload: {
            reason:
              order.status === "awaiting_buyer_context"
                ? "buyer_context_submit_timeout"
                : "queue_accept_timeout"
          },
          ledgerMemo: "order_expired_refund"
        });

        return order.notify_provider;
      });

      if (processed !== false) {
        expiredOrderIds.push(candidate.id);
        if (processed) {
          void queueProviderRelayEvent({
            orderId: candidate.id,
            eventType: "order_expired"
          }).catch((error) => {
            app.log.warn(error, "provider relay queue failed after order expiry");
          });
        }
      }
    }

    return {
      expired_count: expiredOrderIds.length,
      order_ids: expiredOrderIds
    };
  });

  app.post("/api/v1/system/orders/auto-close-delivered", async (request, reply) => {
    if (!authenticateSystemRequest(request.headers as Record<string, unknown>)) {
      reply.code(401).send({ error: "invalid_system_token" });
      return;
    }

    const queryParams = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100)
      })
      .parse(request.query);

    const candidates = await query<{ id: string }>(
      `
        SELECT id
        FROM orders
        WHERE status = 'delivered'
          AND escrow_status = 'held'
          AND delivered_at IS NOT NULL
          AND delivered_at <= NOW() - ($1 * INTERVAL '1 hour')
        ORDER BY delivered_at ASC
        LIMIT $2
      `,
      [config.deliveredReviewAutoCloseHours, queryParams.limit]
    );

    const autoClosedOrderIds: string[] = [];

    for (const candidate of candidates.rows) {
      const processed = await withTransaction(async (client) => {
        const orderResult = await client.query<{
          id: string;
          buyer_agent_id: string;
          provider_agent_id: string;
          service_listing_id: string | null;
          final_amount: string;
          status: string;
          escrow_status: string;
          delivered_at: string | null;
        }>(
          `
            SELECT id, buyer_agent_id, provider_agent_id, service_listing_id, final_amount,
                   status, escrow_status, delivered_at
            FROM orders
            WHERE id = $1
            FOR UPDATE
          `,
          [candidate.id]
        );

        const order = orderResult.rows[0];
        if (
          !order ||
          order.status !== "delivered" ||
          order.escrow_status !== "held" ||
          !order.delivered_at ||
          !isOlderThan(order.delivered_at, config.deliveredReviewAutoCloseHours * 60 * 60 * 1000)
        ) {
          return false;
        }

        await client.query(
          `
            INSERT INTO reviews (
              order_id,
              reviewer_agent_id,
              provider_agent_id,
              review_band,
              settlement_action,
              commentary,
              evidence_json
            )
            VALUES ($1, $2, $3, 'neutral', 'accept_close', $4, $5::jsonb)
            ON CONFLICT (order_id)
            DO UPDATE SET
              reviewer_agent_id = EXCLUDED.reviewer_agent_id,
              provider_agent_id = EXCLUDED.provider_agent_id,
              review_band = EXCLUDED.review_band,
              settlement_action = EXCLUDED.settlement_action,
              commentary = EXCLUDED.commentary,
              evidence_json = EXCLUDED.evidence_json,
              updated_at = NOW()
          `,
          [
            order.id,
            order.buyer_agent_id,
            order.provider_agent_id,
            "Auto-closed after 48 hours without buyer review.",
            JSON.stringify({
              auto_closed: true,
              reason: "review_timeout",
              timeout_hours: config.deliveredReviewAutoCloseHours
            })
          ]
        );

        await client.query(
          `
            INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
            VALUES ($1, 'review_auto_closed', 'system', NULL, $2::jsonb)
          `,
          [
            order.id,
            JSON.stringify({
              review_band: "neutral",
              settlement_action: "accept_close",
              timeout_hours: config.deliveredReviewAutoCloseHours
            })
          ]
        );

        await releaseHeldEscrowToProvider(client, {
          orderId: order.id,
          buyerAgentId: order.buyer_agent_id,
          providerAgentId: order.provider_agent_id,
          amount: Number(order.final_amount)
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
            VALUES ($1, 'settlement_released', 'system', NULL, $2::jsonb)
          `,
          [order.id, JSON.stringify({ amount: Number(order.final_amount), reason: "review_timeout_auto_close" })]
        );

        await updateOrderTransportSessionStatus(client, order.id, "completed");
        const transactionVisibility = await getOrderTransactionVisibility(client, order.id, "completed");
        await upsertReviewSnapshotsForOrder(client, {
          orderId: order.id,
          transactionVisibility
        });
        await upsertTransactionSnapshotForOrder(client, order.id);

        if (order.service_listing_id) {
          await refreshListingMetrics(client, order.service_listing_id);
        }

        await refreshProviderReputationProfile(client, order.provider_agent_id);
        await refreshValidatedConcurrency(client, order.provider_agent_id);

        return true;
      });

      if (processed) {
        autoClosedOrderIds.push(candidate.id);
        void queueProviderRelayEvent({
          orderId: candidate.id,
          eventType: "order_completed"
        }).catch((error) => {
          app.log.warn(error, "provider relay queue failed after review timeout auto-close");
        });
      }
    }

    return {
      auto_closed_count: autoClosedOrderIds.length,
      order_ids: autoClosedOrderIds
    };
  });

  app.post("/api/v1/system/artifacts/cleanup-stale", async (request, reply) => {
    if (!authenticateSystemRequest(request.headers as Record<string, unknown>)) {
      reply.code(401).send({ error: "invalid_system_token" });
      return;
    }

    const queryParams = z
      .object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .default(Math.min(100, config.deliveryArtifacts.cleanupBatchLimit))
      })
      .parse(request.query);

    const candidates = await query<ArtifactCleanupCandidate>(
      `
        SELECT
          da.id,
          da.order_id,
          da.object_key,
          da.file_name,
          da.mime_type,
          da.size_bytes,
          da.checksum_sha256,
          da.status,
          da.created_at,
          da.uploaded_at,
          da.purged_at,
          o.status AS order_status,
          o.completed_at,
          o.updated_at AS order_updated_at,
          CASE
            WHEN da.size_bytes > $1
             AND da.status = 'uploading'
             AND da.created_at <= NOW() - ($2 * INTERVAL '1 hour')
              THEN 'large_unfinished_retention_expired'
            WHEN da.size_bytes > $1
             AND da.status = 'uploaded'
             AND da.uploaded_at IS NOT NULL
             AND da.uploaded_at <= NOW() - ($2 * INTERVAL '1 hour')
              THEN 'large_unfinished_retention_expired'
            WHEN da.size_bytes > $1
             AND (
               (o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at <= NOW() - ($3 * INTERVAL '1 day'))
               OR (o.status IN ('disputed', 'cancelled', 'expired') AND o.updated_at <= NOW() - ($3 * INTERVAL '1 day'))
             )
              THEN 'large_terminal_retention_expired'
            WHEN da.status = 'uploading'
             AND da.created_at <= NOW() - ($4 * INTERVAL '1 hour')
              THEN 'stale_uploading'
            WHEN da.status = 'uploaded'
             AND da.uploaded_at IS NOT NULL
             AND da.uploaded_at <= NOW() - ($5 * INTERVAL '1 hour')
              THEN 'stale_uploaded'
            WHEN o.status = 'completed'
             AND o.completed_at IS NOT NULL
             AND o.completed_at <= NOW() - ($6 * INTERVAL '1 day')
              THEN 'completed_retention_expired'
            WHEN o.status = 'disputed'
             AND o.updated_at <= NOW() - ($7 * INTERVAL '1 day')
              THEN 'disputed_retention_expired'
            ELSE NULL
          END AS cleanup_reason
        FROM delivery_artifacts da
        LEFT JOIN orders o ON o.id = da.order_id
        WHERE da.delivery_mode = 'platform_managed'
          AND da.object_key IS NOT NULL
          AND da.purged_at IS NULL
          AND (
            (da.size_bytes > $1 AND da.status = 'uploading' AND da.created_at <= NOW() - ($2 * INTERVAL '1 hour'))
            OR (da.size_bytes > $1 AND da.status = 'uploaded' AND da.uploaded_at IS NOT NULL AND da.uploaded_at <= NOW() - ($2 * INTERVAL '1 hour'))
            OR (
              da.size_bytes > $1
              AND (
                (o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at <= NOW() - ($3 * INTERVAL '1 day'))
                OR (o.status IN ('disputed', 'cancelled', 'expired') AND o.updated_at <= NOW() - ($3 * INTERVAL '1 day'))
              )
            )
            OR (da.status = 'uploading' AND da.created_at <= NOW() - ($4 * INTERVAL '1 hour'))
            OR (da.status = 'uploaded' AND da.uploaded_at IS NOT NULL AND da.uploaded_at <= NOW() - ($5 * INTERVAL '1 hour'))
            OR (o.status = 'completed' AND o.completed_at IS NOT NULL AND o.completed_at <= NOW() - ($6 * INTERVAL '1 day'))
            OR (o.status = 'disputed' AND o.updated_at <= NOW() - ($7 * INTERVAL '1 day'))
          )
        ORDER BY COALESCE(o.completed_at, da.uploaded_at, da.created_at) ASC
        LIMIT $8
      `,
      [
        config.deliveryArtifacts.maxManagedArtifactBytes,
        config.deliveryArtifacts.largeArtifactPendingRetentionHours,
        config.deliveryArtifacts.largeArtifactTerminalRetentionDays,
        config.deliveryArtifacts.staleUploadingTtlHours,
        config.deliveryArtifacts.staleUploadedTtlHours,
        config.deliveryArtifacts.completedRetentionDays,
        config.deliveryArtifacts.disputedRetentionDays,
        Math.min(queryParams.limit, config.deliveryArtifacts.cleanupBatchLimit)
      ]
    );

    const cleanedArtifactIds: string[] = [];
    const cleanupCounts = {
      large_unfinished_retention_expired: 0,
      large_terminal_retention_expired: 0,
      stale_uploading: 0,
      stale_uploaded: 0,
      completed_retention_expired: 0,
      disputed_retention_expired: 0
    };

    for (const candidate of candidates.rows) {
      if (!candidate.cleanup_reason) {
        continue;
      }

      const processed = await withTransaction(async (client) => {
        const artifactResult = await client.query<{
          id: string;
          order_id: string;
          object_key: string;
          file_name: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          checksum_sha256: string | null;
          status: string;
          created_at: string;
          uploaded_at: string | null;
          purged_at: string | null;
        }>(
          `
            SELECT
              da.id,
              da.order_id,
              da.object_key,
              da.file_name,
              da.mime_type,
              da.size_bytes,
              da.checksum_sha256,
              da.status,
              da.created_at,
              da.uploaded_at,
              da.purged_at
            FROM delivery_artifacts da
            WHERE da.id = $1
            FOR UPDATE
          `,
          [candidate.id]
        );

        const lockedArtifact = artifactResult.rows[0];
        if (!lockedArtifact) {
          return false;
        }

        const orderResult = await client.query<{
          status: string | null;
          completed_at: string | null;
          updated_at: string | null;
        }>(
          `
            SELECT status, completed_at, updated_at
            FROM orders
            WHERE id = $1
            LIMIT 1
          `,
          [lockedArtifact.order_id]
        );

        const order = orderResult.rows[0];
        const locked: ArtifactCleanupCandidate = {
          ...lockedArtifact,
          order_status: order?.status ?? null,
          completed_at: order?.completed_at ?? null,
          order_updated_at: order?.updated_at ?? null,
          cleanup_reason: candidate.cleanup_reason
        };
        if (!locked || !artifactCleanupStillDue(locked)) {
          return false;
        }

        try {
          await deletePlatformManagedObject(locked.object_key);
        } catch (error: unknown) {
          const errorName =
            error && typeof error === "object" && "name" in error ? String(error.name) : "";
          if (errorName !== "NoSuchKeyError") {
            app.log.warn(
              { err: error, artifactId: locked.id, objectKey: locked.object_key },
              "platform managed artifact cleanup delete failed"
            );
            return false;
          }
        }

        const metadata = {
          cleanup_reason: candidate.cleanup_reason,
          file_name: locked.file_name,
          mime_type: locked.mime_type,
          size_bytes: locked.size_bytes,
          checksum_sha256: locked.checksum_sha256,
          object_key: locked.object_key
        };

        if (
          candidate.cleanup_reason === "large_unfinished_retention_expired" ||
          candidate.cleanup_reason === "stale_uploading" ||
          candidate.cleanup_reason === "stale_uploaded"
        ) {
          await writeDeliveryArtifactAudit({
            client,
            artifactId: locked.id,
            orderId: locked.order_id,
            actorType: "system",
            eventType: "cleanup_deleted",
            statusCode: 200,
            metadata
          });

          await client.query(`DELETE FROM delivery_artifacts WHERE id = $1`, [locked.id]);
          return true;
        }

        await client.query(
          `
            UPDATE delivery_artifacts
            SET purged_at = NOW(),
                purge_reason = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [locked.id, candidate.cleanup_reason]
        );

        await writeDeliveryArtifactAudit({
          client,
          artifactId: locked.id,
          orderId: locked.order_id,
          actorType: "system",
          eventType: "cleanup_purged",
          statusCode: 200,
          metadata
        });

        return true;
      });

      if (!processed) {
        continue;
      }

      cleanedArtifactIds.push(candidate.id);
      cleanupCounts[candidate.cleanup_reason] += 1;
    }

    return {
      cleaned_count: cleanedArtifactIds.length,
      cleaned_artifact_ids: cleanedArtifactIds,
      cleanup_counts: cleanupCounts
    };
  });
}
