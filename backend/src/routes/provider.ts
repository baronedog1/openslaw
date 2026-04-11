import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import {
  buyerContextPackHasMissingStructuredMaterials,
  normalizeBuyerContextPack,
  type BuyerContextPack
} from "../domain/buyerContextPacks.js";
import {
  buildDeliveryArtifactAuditContext,
  writeDeliveryArtifactAudit
} from "../domain/deliveryArtifactAudit.js";
import {
  assertWorkspaceRoleCapacity,
  orderAllowsProviderOutputUpload,
  type DeliveryArtifactRole
} from "../domain/deliveryArtifacts.js";
import { loadOwnerUploadEntitlementByAgent } from "../domain/ownerMemberships.js";
import {
  assertPlatformManagedArtifactAllowed,
  buildPlatformManagedArtifactObjectKey,
  createPlatformManagedUploadUrl,
  headPlatformManagedObject,
  isPlatformManagedDeliveryEnabled,
  platformManagedBucketName,
  sanitizeArtifactFileName
} from "../domain/objectStorage.js";
import { refreshListingMetrics } from "../domain/listingMetrics.js";
import { updateOrderTransportSessionStatus } from "../domain/orderLifecycle.js";
import { finalizePreAcceptanceExit } from "../domain/orderOperations.js";
import {
  claimRuntimeCapacity,
  providerRuntimeEventTypes,
  releaseRuntimeCapacity
} from "../domain/runtimeProfiles.js";
import { touchRelayLeaseActivity } from "../domain/runtimeRelay.js";
import {
  buildOrderTransactionVisibility,
  getOrderTransactionVisibility,
  refreshProviderReputationProfile,
  upsertTransactionSnapshotVisibilityGrant
} from "../domain/transactionEvidence.js";
import { withTransaction } from "../db.js";
import { json } from "../utils.js";

const acceptSchema = z.object({
  message: z.string().default("accepted")
});

const declineSchema = z.object({
  reason: z.string().min(1).default("provider_declined")
});

const deliverArtifactSchema = z
  .object({
    type: z.enum(["text", "file", "url", "bundle"]),
    delivery_mode: z.enum(["provider_managed", "platform_managed"]).default("provider_managed"),
    url: z.string().optional(),
    content: z.record(z.any()).optional(),
    summary: z.string().default(""),
    platform_artifact_id: z.string().uuid().optional()
  })
  .superRefine((value, ctx) => {
    if (value.delivery_mode === "platform_managed" && !value.platform_artifact_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "platform_artifact_id is required for platform_managed artifacts",
        path: ["platform_artifact_id"]
      });
    }

    if (value.delivery_mode === "provider_managed" && value.platform_artifact_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "platform_artifact_id is only allowed for platform_managed artifacts",
        path: ["platform_artifact_id"]
      });
    }
  });

const deliverSchema = z.object({
  delivery_summary: z.string().min(1),
  artifacts: z.array(deliverArtifactSchema),
  transaction_visibility_grant: z.lazy(() => transactionVisibilityGrantSchema).optional()
});

const runtimeEventSchema = z.object({
  event_type: z.enum(providerRuntimeEventTypes),
  message: z.string().min(1),
  details: z.record(z.any()).default({})
}).superRefine((value, context) => {
  if (value.event_type !== "owner_notified") {
    return;
  }

  const notificationReason = value.details.notification_reason;
  const title = value.details.title;
  const body = value.details.body;

  if (typeof notificationReason !== "string" || notificationReason.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["details", "notification_reason"],
      message: "owner_notified requires details.notification_reason"
    });
  }

  if (typeof title !== "string" || title.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["details", "title"],
      message: "owner_notified requires details.title"
    });
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["details", "body"],
      message: "owner_notified requires details.body"
    });
  }
});

const initiatePlatformManagedArtifactSchema = z.object({
  artifact_type: z.enum(["file", "bundle"]).default("file"),
  file_name: z.string().min(1),
  mime_type: z.string().min(1).default("application/octet-stream"),
  size_bytes: z.number().int().positive(),
  summary: z.string().default(""),
  checksum_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional()
});

const transactionVisibilityGrantSchema = z
  .object({
    allow_platform_index: z.boolean().default(false),
    allow_agent_search_preview: z.boolean().default(false),
    allow_public_case_preview: z.boolean().default(false),
    note: z.string().default("")
  })
  .superRefine((value, ctx) => {
    if (value.allow_agent_search_preview && !value.allow_platform_index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allow_agent_search_preview"],
        message: "allow_agent_search_preview requires allow_platform_index"
      });
    }

    if (value.allow_public_case_preview && !value.allow_agent_search_preview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allow_public_case_preview"],
        message: "allow_public_case_preview requires allow_agent_search_preview"
      });
    }
  });

type ProviderOwnedOrder = {
  id: string;
  provider_agent_id: string;
  status: string;
  service_listing_id: string | null;
};

const snapshotVisibilityGrantableStatuses = new Set([
  "delivered",
  "revision_requested",
  "completed",
  "disputed"
]);

type PlatformManagedArtifactRow = {
  id: string;
  order_id: string;
  submitted_by_agent_id: string;
  artifact_role: DeliveryArtifactRole;
  artifact_type: string;
  delivery_mode: string;
  storage_provider: string | null;
  object_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  status: string;
  summary_text: string;
};

type BuyerContextArtifactRow = {
  id: string;
  artifact_role: DeliveryArtifactRole;
  status: string;
};

function getIdempotencyKey(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function lockTransportConfig(client: PoolClient, orderId: string) {
  const result = await client.query<{ push_notification_config_json: Record<string, unknown> }>(
    `
      SELECT push_notification_config_json
      FROM order_transport_sessions
      WHERE order_id = $1
      FOR UPDATE
    `,
    [orderId]
  );

  return result.rows[0]?.push_notification_config_json ?? {};
}

async function writeTransportConfig(
  client: PoolClient,
  orderId: string,
  nextConfig: Record<string, unknown>
) {
  await client.query(
    `
      UPDATE order_transport_sessions
      SET push_notification_config_json = $2::jsonb,
          updated_at = NOW()
      WHERE order_id = $1
    `,
    [orderId, JSON.stringify(nextConfig)]
  );
}

async function loadProviderOrderForUpdate(client: PoolClient, orderId: string, providerId: string) {
  const orderResult = await client.query<ProviderOwnedOrder>(
    `
      SELECT id, provider_agent_id, status, service_listing_id
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new Error("order_not_found");
  }

  if (order.provider_agent_id !== providerId) {
    throw new Error("provider_forbidden");
  }

  return order;
}

async function loadPlatformManagedArtifactForUpdate(
  client: PoolClient,
  artifactId: string,
  orderId: string
) {
  const result = await client.query<PlatformManagedArtifactRow>(
    `
      SELECT id, order_id, submitted_by_agent_id, artifact_role, artifact_type, delivery_mode, storage_provider,
             object_key, file_name, mime_type, size_bytes, checksum_sha256, status, summary_text
      FROM delivery_artifacts
      WHERE id = $1 AND order_id = $2
      FOR UPDATE
    `,
    [artifactId, orderId]
  );

  const artifact = result.rows[0];
  if (!artifact || artifact.delivery_mode !== "platform_managed") {
    throw new Error("platform_managed_artifact_not_found");
  }

  return artifact;
}

async function loadLatestBuyerContextPack(client: PoolClient, orderId: string) {
  const result = await client.query<{ payload_json: unknown }>(
    `
      SELECT payload_json
      FROM order_events
      WHERE order_id = $1
        AND event_type = 'buyer_context_submitted'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [orderId]
  );

  return normalizeBuyerContextPack(result.rows[0]?.payload_json ?? null);
}

async function evaluateQueuedOrderBuyerContext(
  client: PoolClient,
  orderId: string
): Promise<
  | { ok: true; pack: BuyerContextPack }
  | {
      ok: false;
      reason: string;
      details: Record<string, unknown>;
    }
> {
  const pack = await loadLatestBuyerContextPack(client, orderId);
  if (!pack) {
    return {
      ok: false,
      reason: "buyer_context_pack_invalid",
      details: {
        reason: "buyer_context_pack_invalid",
        note: "Queued order is missing a valid formal Buyer Context Pack."
      }
    };
  }

  if (buyerContextPackHasMissingStructuredMaterials(pack)) {
    return {
      ok: false,
      reason: "buyer_context_materials_missing",
      details: {
        reason: "buyer_context_materials_missing",
        material_delivery_mode: pack.material_delivery_mode,
        share_summary: pack.share_summary
      }
    };
  }

  if (pack.artifact_ids.length === 0) {
    return {
      ok: true,
      pack
    };
  }

  const artifactResult = await client.query<BuyerContextArtifactRow>(
    `
      SELECT id, artifact_role, status
      FROM delivery_artifacts
      WHERE order_id = $1
        AND id = ANY($2::uuid[])
    `,
    [orderId, pack.artifact_ids]
  );

  const validArtifactIds = new Set(
    artifactResult.rows
      .filter((artifact) => artifact.artifact_role === "buyer_input" && artifact.status === "submitted")
      .map((artifact) => artifact.id)
  );
  const missingArtifactIds = pack.artifact_ids.filter((artifactId) => !validArtifactIds.has(artifactId));
  if (missingArtifactIds.length > 0) {
    return {
      ok: false,
      reason: "buyer_context_artifacts_missing",
      details: {
        reason: "buyer_context_artifacts_missing",
        material_delivery_mode: pack.material_delivery_mode,
        missing_artifact_ids: missingArtifactIds
      }
    };
  }

  return {
    ok: true,
    pack
  };
}

async function reopenOrderForBuyerContext(
  client: PoolClient,
  params: {
    orderId: string;
    providerAgentId: string;
    reopenReason: string;
    details: Record<string, unknown>;
  }
) {
  await client.query(
    `
      UPDATE orders
      SET status = 'awaiting_buyer_context',
          updated_at = NOW()
      WHERE id = $1
    `,
    [params.orderId]
  );

  await client.query(
    `
      DELETE FROM order_transport_sessions
      WHERE order_id = $1
    `,
    [params.orderId]
  );

  await client.query(
    `
      INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
      VALUES ($1, 'buyer_context_required', 'system', NULL, $2::jsonb)
    `,
    [
      params.orderId,
      json({
        provider_agent_id: params.providerAgentId,
        required_step: "buyer_context_pack",
        reason: params.reopenReason,
        note: "Provider intake was returned to the buyer because the queued Buyer Context Pack was not formally complete.",
        reopened_from_status: "queued_for_provider",
        ...params.details
      })
    ]
  );
}

function providerErrorStatus(errorCode: string): number {
  switch (errorCode) {
    case "order_not_found":
    case "platform_managed_artifact_not_found":
      return 404;
    case "provider_forbidden":
    case "platform_managed_artifact_forbidden":
      return 403;
    case "platform_managed_artifact_too_large":
    case "platform_managed_artifact_size_invalid":
    case "platform_managed_artifact_type_not_allowed":
    case "provider_output_workspace_limit_exceeded":
      return 400;
    case "transaction_snapshot_visibility_not_ready":
      return 409;
    default:
      return 409;
  }
}

function sendProviderError(
  reply: Parameters<FastifyInstance["post"]>[1] extends never ? never : any,
  errorCode: string,
  details?: Record<string, unknown>
) {
  reply.code(providerErrorStatus(errorCode)).send({
    error: errorCode,
    ...(details ?? {})
  });
}

function mapRuntimeEventToOrderEventType(
  eventType: (typeof providerRuntimeEventTypes)[number]
): string {
  switch (eventType) {
    case "order_received":
      return "provider_order_received";
    case "execution_started":
      return "provider_execution_started";
    case "waiting_for_inputs":
      return "provider_waiting_for_inputs";
    case "progress_update":
      return "provider_progress_updated";
    case "owner_notified":
      return "provider_owner_notified";
    case "blocked_manual_help":
      return "provider_blocked_manual_help";
    case "delivery_uploaded":
      return "provider_delivery_uploaded";
    case "execution_failed":
      return "provider_execution_failed";
  }
}

function mapRuntimeEventToRemoteStatus(
  eventType: (typeof providerRuntimeEventTypes)[number]
): string | null {
  switch (eventType) {
    case "order_received":
      return "received";
    case "execution_started":
    case "progress_update":
      return "in_progress";
    case "owner_notified":
      return null;
    case "waiting_for_inputs":
    case "blocked_manual_help":
      return "blocked";
    case "delivery_uploaded":
      return "delivered";
    case "execution_failed":
      return "failed";
  }
}

export async function registerProviderRoutes(app: FastifyInstance) {
  app.post("/api/v1/provider/orders/:orderId/runtime-events", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = runtimeEventSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, $2, 'provider_agent', $3, $4::jsonb)
        `,
        [
          order.id,
          mapRuntimeEventToOrderEventType(body.event_type),
          provider.id,
          json({
            message: body.message,
            details: body.details,
            runtime_event_type: body.event_type
          })
        ]
      );

      const remoteStatus = mapRuntimeEventToRemoteStatus(body.event_type);
      if (remoteStatus) {
        await updateOrderTransportSessionStatus(client, order.id, remoteStatus);
      }

      await client.query(
        `
          UPDATE agent_runtime_profiles
          SET last_runtime_event_at = NOW(),
              last_runtime_event_type = $2,
              last_runtime_event_summary = $3,
              updated_at = NOW()
          WHERE agent_account_id = $1
        `,
        [provider.id, body.event_type, body.message]
      );

      return {
        status: "runtime_event_recorded",
        event_type: body.event_type
      };
    }).catch((error: Error) => {
      if (["order_not_found", "provider_forbidden"].includes(error.message)) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    await touchRelayLeaseActivity({
      agentId: provider.id
    });

    return result;
  });

  app.post("/api/v1/provider/orders/:orderId/accept", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = acceptSchema.parse(request.body ?? {});
    const idempotencyKey = getIdempotencyKey(request.headers["idempotency-key"]);

    const result = await withTransaction(async (client) => {
      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);

      const transportConfig = await lockTransportConfig(client, order.id);
      if (
        idempotencyKey &&
        transportConfig.last_accept_idempotency_key === idempotencyKey &&
        order.status === "accepted"
      ) {
        return { status: "accepted", idempotent: true };
      }

      if (order.status !== "queued_for_provider") {
        throw new Error("order_not_queued");
      }

      const buyerContextCheck = await evaluateQueuedOrderBuyerContext(client, order.id);
      if (!buyerContextCheck.ok) {
        await reopenOrderForBuyerContext(client, {
          orderId: order.id,
          providerAgentId: provider.id,
          reopenReason: buyerContextCheck.reason,
          details: buyerContextCheck.details
        });

        if (order.service_listing_id) {
          await refreshListingMetrics(client, order.service_listing_id);
        }

        return {
          status: "awaiting_buyer_context",
          reopened: true as const,
          reason: typeof buyerContextCheck.details.reason === "string" ? buyerContextCheck.details.reason : null,
          material_delivery_mode:
            typeof buyerContextCheck.details.material_delivery_mode === "string"
              ? buyerContextCheck.details.material_delivery_mode
              : null,
          missing_artifact_ids: Array.isArray(buyerContextCheck.details.missing_artifact_ids)
            ? buyerContextCheck.details.missing_artifact_ids
            : []
        };
      }

      await claimRuntimeCapacity(client, provider.id);

      await client.query(
        `
          UPDATE orders
          SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `,
        [order.id]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, 'provider_accepted', 'provider_agent', $2, $3::jsonb)
        `,
        [order.id, provider.id, json(body)]
      );

      await updateOrderTransportSessionStatus(client, order.id, "accepted");

      if (idempotencyKey) {
        await writeTransportConfig(client, order.id, {
          ...transportConfig,
          last_accept_idempotency_key: idempotencyKey,
          last_accept_acknowledged_at: new Date().toISOString()
        });
      }

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }

      return {
        status: "accepted",
        reopened: false as const
      };
    }).catch((error: Error & Record<string, unknown>) => {
      if (
        ["order_not_found", "provider_forbidden", "order_not_queued", "provider_capacity_exceeded"].includes(
          error.message
        )
      ) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    if (result.reopened) {
      sendProviderError(reply, "buyer_context_incomplete", {
        reason: result.reason,
        rerouted_to_status: "awaiting_buyer_context",
        required_step: "buyer_context_pack",
        material_delivery_mode: result.material_delivery_mode,
        missing_artifact_ids: result.missing_artifact_ids
      });
      return;
    }

    return result;
  });

  app.post("/api/v1/provider/orders/:orderId/decline", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = declineSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        buyer_agent_id: string;
        provider_agent_id: string;
        service_listing_id: string | null;
        demand_post_id: string | null;
        demand_proposal_id: string | null;
        final_amount: number;
        status: string;
        escrow_status: string;
      }>(
        `
          SELECT id, buyer_agent_id, provider_agent_id, service_listing_id, demand_post_id,
                 demand_proposal_id, final_amount, status, escrow_status
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

      if (order.provider_agent_id !== provider.id) {
        throw new Error("provider_forbidden");
      }

      if (order.status !== "queued_for_provider" || order.escrow_status !== "held") {
        throw new Error("order_not_cancellable");
      }

      await finalizePreAcceptanceExit(client, {
        orderId: order.id,
        buyerAgentId: order.buyer_agent_id,
        amount: Number(order.final_amount),
        nextStatus: "cancelled",
        serviceListingId: order.service_listing_id,
        demandPostId: order.demand_post_id,
        demandProposalId: order.demand_proposal_id,
        actorType: "provider_agent",
        actorId: provider.id,
        eventType: "provider_declined",
        eventPayload: { reason: body.reason },
        ledgerMemo: "provider_declined_refund"
      });

      return { status: "cancelled" };
    }).catch((error: Error) => {
      if (
        ["order_not_found", "provider_forbidden", "order_not_cancellable"].includes(error.message)
      ) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.post("/api/v1/provider/orders/:orderId/visibility-grants", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = transactionVisibilityGrantSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);
      if (!snapshotVisibilityGrantableStatuses.has(order.status)) {
        throw new Error("transaction_snapshot_visibility_not_ready");
      }

      const visibility = await upsertTransactionSnapshotVisibilityGrant(client, {
        orderId: order.id,
        grantedByAgentId: provider.id,
        actorRole: "provider_agent",
        allowPlatformIndex: body.allow_platform_index,
        allowAgentSearchPreview: body.allow_agent_search_preview,
        allowPublicCasePreview: body.allow_public_case_preview,
        note: body.note
      });

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }
      await refreshProviderReputationProfile(client, provider.id);

      return buildOrderTransactionVisibility(visibility, order.status);
    }).catch((error: Error) => {
      if (["order_not_found", "provider_forbidden", "transaction_snapshot_visibility_not_ready"].includes(error.message)) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return {
      status: "updated",
      visibility: result
    };
  });

  app.post("/api/v1/provider/orders/:orderId/artifacts/platform-managed/initiate", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = initiatePlatformManagedArtifactSchema.parse(request.body ?? {});
    const auditContext = buildDeliveryArtifactAuditContext(request);

    const result = await withTransaction(async (client) => {
      if (!isPlatformManagedDeliveryEnabled()) {
        throw new Error("platform_managed_delivery_not_configured");
      }

      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);
      if (!orderAllowsProviderOutputUpload(order.status)) {
        throw new Error("order_not_deliverable");
      }
      const uploadEntitlement = await loadOwnerUploadEntitlementByAgent(
        client.query.bind(client),
        provider.id
      );

      const safeFileName = sanitizeArtifactFileName(body.file_name);
      const normalizedMimeType = body.mime_type.trim().toLowerCase();
      assertPlatformManagedArtifactAllowed({
        fileName: safeFileName,
        mimeType: normalizedMimeType,
        sizeBytes: body.size_bytes,
        maxSizeBytes: uploadEntitlement.effective_platform_managed_max_bytes
      });
      await assertWorkspaceRoleCapacity(client, {
        orderId: order.id,
        artifactRole: "provider_output",
        incomingSizeBytes: body.size_bytes,
        maxTotalBytes: uploadEntitlement.effective_platform_managed_total_bytes_per_role
      });

      const artifactId = randomUUID();
      const objectKey = buildPlatformManagedArtifactObjectKey({
        orderId: order.id,
        artifactRole: "provider_output",
        artifactId,
        fileName: safeFileName
      });

      await client.query(
        `
          INSERT INTO delivery_artifacts (
            id,
            order_id,
            submitted_by_agent_id,
            artifact_role,
            artifact_type,
            delivery_mode,
            storage_provider,
            bucket_name,
            object_key,
            file_name,
            mime_type,
            size_bytes,
            checksum_sha256,
            content_json,
            summary_text,
            status,
            updated_at
          )
          VALUES (
            $1, $2, $3, 'provider_output', $4, 'platform_managed', 'aliyun_oss',
            $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'uploading', NOW()
          )
        `,
        [
          artifactId,
          order.id,
          provider.id,
          body.artifact_type,
          platformManagedBucketName(),
          objectKey,
          safeFileName,
          normalizedMimeType,
          body.size_bytes,
          body.checksum_sha256 ?? null,
          json({ upload_source: "platform_managed_oss" }),
          body.summary
        ]
      );

      await writeDeliveryArtifactAudit({
        client,
        artifactId,
        orderId: order.id,
        actorType: "provider_agent",
        actorId: provider.id,
        eventType: "upload_initiated",
        context: auditContext,
        statusCode: 201,
        metadata: {
          artifact_type: body.artifact_type,
          delivery_mode: "platform_managed",
          file_name: safeFileName,
          mime_type: normalizedMimeType,
          size_bytes: body.size_bytes,
          checksum_sha256: body.checksum_sha256 ?? null,
          object_key: objectKey,
          upload_membership_tier: uploadEntitlement.membership_tier,
          upload_limit_bytes: uploadEntitlement.effective_platform_managed_max_bytes,
          upload_total_limit_bytes:
            uploadEntitlement.effective_platform_managed_total_bytes_per_role
        }
      });

      return {
        artifact: {
          id: artifactId,
          order_id: order.id,
          artifact_role: "provider_output",
          artifact_type: body.artifact_type,
          delivery_mode: "platform_managed",
          storage_provider: "aliyun_oss",
          file_name: safeFileName,
          mime_type: normalizedMimeType,
          size_bytes: body.size_bytes,
          checksum_sha256: body.checksum_sha256 ?? null,
          summary_text: body.summary,
          status: "uploading"
        },
        upload_entitlement: uploadEntitlement,
        upload: createPlatformManagedUploadUrl({
          objectKey,
          mimeType: normalizedMimeType
        })
      };
    }).catch((error: Error) => {
      const sizeLimitedError = error as unknown as { max_size_bytes?: unknown };
      const limitDetails =
        typeof sizeLimitedError.max_size_bytes === "number"
          ? { max_size_bytes: sizeLimitedError.max_size_bytes }
          : undefined;
      if (
        [
          "order_not_found",
          "provider_forbidden",
          "order_not_deliverable",
          "platform_managed_delivery_not_configured",
          "platform_managed_artifact_too_large",
          "platform_managed_artifact_size_invalid",
          "platform_managed_artifact_type_not_allowed",
          "provider_output_workspace_limit_exceeded"
        ].includes(error.message)
      ) {
        sendProviderError(reply, error.message, limitDetails);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    reply.code(201).send(result);
  });

  app.post("/api/v1/provider/orders/:orderId/artifacts/:artifactId/complete", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z
      .object({
        orderId: z.string().uuid(),
        artifactId: z.string().uuid()
      })
      .parse(request.params);
    const auditContext = buildDeliveryArtifactAuditContext(request);

    const result = await withTransaction(async (client) => {
      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);
      if (!orderAllowsProviderOutputUpload(order.status)) {
        throw new Error("order_not_deliverable");
      }

      const artifact = await loadPlatformManagedArtifactForUpdate(client, params.artifactId, order.id);
      if (artifact.submitted_by_agent_id !== provider.id) {
        throw new Error("platform_managed_artifact_forbidden");
      }
      if (artifact.artifact_role !== "provider_output") {
        throw new Error("platform_managed_artifact_forbidden");
      }

      if (!artifact.object_key) {
        throw new Error("platform_managed_artifact_not_found");
      }

      if (artifact.status === "submitted" || artifact.status === "uploaded") {
        return {
          artifact: {
            id: artifact.id,
            order_id: artifact.order_id,
            artifact_role: artifact.artifact_role,
            artifact_type: artifact.artifact_type,
            delivery_mode: artifact.delivery_mode,
            file_name: artifact.file_name,
            mime_type: artifact.mime_type,
            size_bytes: artifact.size_bytes,
            checksum_sha256: artifact.checksum_sha256,
            summary_text: artifact.summary_text,
            status: artifact.status
          },
          idempotent: true
        };
      }

      let objectHead;
      try {
        objectHead = await headPlatformManagedObject(artifact.object_key);
      } catch (error: unknown) {
        const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        if (errorName === "NoSuchKeyError") {
          throw new Error("platform_managed_artifact_missing_object");
        }
        throw error;
      }

      if (
        artifact.size_bytes !== null &&
        objectHead.sizeBytes !== null &&
        artifact.size_bytes !== objectHead.sizeBytes
      ) {
        throw new Error("platform_managed_artifact_size_mismatch");
      }

      await client.query(
        `
          UPDATE delivery_artifacts
          SET status = 'uploaded',
              uploaded_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [artifact.id]
      );

      await writeDeliveryArtifactAudit({
        client,
        artifactId: artifact.id,
        orderId: artifact.order_id,
        actorType: "provider_agent",
        actorId: provider.id,
        eventType: "upload_completed",
        context: auditContext,
        statusCode: 200,
        metadata: {
          artifact_type: artifact.artifact_type,
          file_name: artifact.file_name,
          mime_type: artifact.mime_type,
          size_bytes: artifact.size_bytes,
          checksum_sha256: artifact.checksum_sha256,
          object_key: artifact.object_key
        }
      });

      return {
        artifact: {
          id: artifact.id,
          order_id: artifact.order_id,
          artifact_role: artifact.artifact_role,
          artifact_type: artifact.artifact_type,
          delivery_mode: artifact.delivery_mode,
          file_name: artifact.file_name,
          mime_type: artifact.mime_type,
          size_bytes: artifact.size_bytes,
          checksum_sha256: artifact.checksum_sha256,
          summary_text: artifact.summary_text,
          status: "uploaded"
        }
      };
    }).catch((error: Error) => {
      if (
        [
          "order_not_found",
          "provider_forbidden",
          "order_not_deliverable",
          "platform_managed_artifact_not_found",
          "platform_managed_artifact_forbidden",
          "platform_managed_artifact_missing_object",
          "platform_managed_artifact_size_mismatch"
        ].includes(error.message)
      ) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.post("/api/v1/provider/orders/:orderId/deliver", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = deliverSchema.parse(request.body);
    const idempotencyKey = getIdempotencyKey(request.headers["idempotency-key"]);
    const auditContext = buildDeliveryArtifactAuditContext(request);

    const result = await withTransaction(async (client) => {
      const order = await loadProviderOrderForUpdate(client, params.orderId, provider.id);
      const submittedArtifactIds: string[] = [];

      const transportConfig = await lockTransportConfig(client, order.id);
      if (
        idempotencyKey &&
        transportConfig.last_deliver_idempotency_key === idempotencyKey &&
        order.status === "delivered"
      ) {
        const transactionVisibility = await getOrderTransactionVisibility(client, order.id, order.status);
        return { status: "delivered", idempotent: true, transaction_visibility: transactionVisibility };
      }

      if (!orderAllowsProviderOutputUpload(order.status)) {
        throw new Error("order_not_deliverable");
      }

      const persistProviderVisibilityGrant = async () => {
        if (!body.transaction_visibility_grant) {
          return;
        }

        await upsertTransactionSnapshotVisibilityGrant(client, {
          orderId: order.id,
          grantedByAgentId: provider.id,
          actorRole: "provider_agent",
          allowPlatformIndex: body.transaction_visibility_grant.allow_platform_index,
          allowAgentSearchPreview: body.transaction_visibility_grant.allow_agent_search_preview,
          allowPublicCasePreview: body.transaction_visibility_grant.allow_public_case_preview,
          note: body.transaction_visibility_grant.note
        });
      };

      const selectedManagedArtifactIds = new Set(
        body.artifacts
          .filter((artifact) => artifact.delivery_mode === "platform_managed")
          .map((artifact) => artifact.platform_artifact_id!)
      );

      await client.query(
        `
          UPDATE delivery_artifacts
          SET status = 'superseded',
              updated_at = NOW()
          WHERE order_id = $1
            AND artifact_role = 'provider_output'
            AND status IN ('uploaded', 'submitted', 'accepted', 'rejected')
            AND (
              cardinality($2::uuid[]) = 0
              OR id <> ALL($2::uuid[])
            )
        `,
        [order.id, Array.from(selectedManagedArtifactIds)]
      );

      for (const artifact of body.artifacts) {
        if (artifact.delivery_mode === "platform_managed") {
          const managedArtifact = await loadPlatformManagedArtifactForUpdate(
            client,
            artifact.platform_artifact_id!,
            order.id
          );

          if (managedArtifact.submitted_by_agent_id !== provider.id) {
            throw new Error("platform_managed_artifact_forbidden");
          }
          if (managedArtifact.artifact_role !== "provider_output") {
            throw new Error("platform_managed_artifact_forbidden");
          }

          if (!["uploaded", "submitted", "accepted"].includes(managedArtifact.status)) {
            throw new Error("platform_managed_artifact_incomplete");
          }

          await client.query(
            `
              UPDATE delivery_artifacts
              SET artifact_role = 'provider_output',
                  artifact_type = $2,
                  content_json = $3::jsonb,
                  summary_text = $4,
                  status = 'submitted',
                  updated_at = NOW()
              WHERE id = $1
            `,
            [
              managedArtifact.id,
              artifact.type,
              json(artifact.content ?? {}),
              artifact.summary || managedArtifact.summary_text
            ]
          );
          submittedArtifactIds.push(managedArtifact.id);
          continue;
        }

        const insertedArtifactResult = await client.query<{ id: string }>(
          `
            INSERT INTO delivery_artifacts (
              order_id,
              submitted_by_agent_id,
              artifact_role,
              artifact_type,
              delivery_mode,
              storage_provider,
              storage_url,
              content_json,
              summary_text,
              status,
              updated_at
            )
            VALUES ($1, $2, 'provider_output', $3, 'provider_managed', $4, $5, $6::jsonb, $7, 'submitted', NOW())
            RETURNING id
          `,
          [
            order.id,
            provider.id,
            artifact.type,
            artifact.url ? "external_url" : null,
            artifact.url ?? null,
            json(artifact.content ?? {}),
            artifact.summary
          ]
        );
        submittedArtifactIds.push(insertedArtifactResult.rows[0].id);
      }

      if (order.status === "revision_requested") {
        await client.query(`DELETE FROM reviews WHERE order_id = $1 AND settlement_action = 'request_revision'`, [
          order.id
        ]);
      }

      await client.query(
        `
          UPDATE orders
          SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `,
        [order.id]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, 'delivery_submitted', 'provider_agent', $2, $3::jsonb)
        `,
        [order.id, provider.id, json({ delivery_summary: body.delivery_summary, artifacts: body.artifacts })]
      );

      await updateOrderTransportSessionStatus(client, order.id, "delivered");
      await persistProviderVisibilityGrant();

      if (idempotencyKey) {
        await writeTransportConfig(client, order.id, {
          ...transportConfig,
          last_deliver_idempotency_key: idempotencyKey,
          last_deliver_acknowledged_at: new Date().toISOString()
        });
      }

      await releaseRuntimeCapacity(client, provider.id);

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }

      for (const artifactId of submittedArtifactIds) {
        await writeDeliveryArtifactAudit({
          client,
          artifactId,
          orderId: order.id,
          actorType: "provider_agent",
          actorId: provider.id,
          eventType: "delivery_submitted",
          context: auditContext,
          statusCode: 200,
          metadata: {
            delivery_summary: body.delivery_summary
          }
        });
      }

      const transactionVisibility = await getOrderTransactionVisibility(client, order.id, "delivered");

      return { status: "delivered", transaction_visibility: transactionVisibility };
    }).catch((error: Error) => {
      if (
        [
          "order_not_found",
          "provider_forbidden",
          "order_not_deliverable",
          "platform_managed_artifact_not_found",
          "platform_managed_artifact_forbidden",
          "platform_managed_artifact_incomplete"
        ].includes(error.message)
      ) {
        sendProviderError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });
}
