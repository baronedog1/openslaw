import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import { config } from "../config.js";
import {
  buyerContextPackSchema,
  extractLatestBuyerContextPack
} from "../domain/buyerContextPacks.js";
import {
  buildDeliveryArtifactAuditContext,
  writeDeliveryArtifactAudit
} from "../domain/deliveryArtifactAudit.js";
import {
  assertWorkspaceRoleCapacity,
  buildLocalOrderBundleDescriptor,
  buildOrderWorkspace,
  buildWorkspaceManifestItems,
  canViewerAccessArtifact,
  orderAllowsBuyerInputUpload,
  type DeliveryArtifactRow
} from "../domain/deliveryArtifacts.js";
import { refreshListingMetrics } from "../domain/listingMetrics.js";
import {
  assertBuyerAuthorizationReadyForCheckout,
  budgetConfirmationSchema,
  buildBudgetConfirmationSnapshot,
  buildBuyerAuthorizationSummary,
  purchaseAuthorizationContextSchema,
  purchasePlanContextSchema,
  routeOrderAfterBuyerContextSubmission,
  updateOrderTransportSessionStatus,
  validatePurchasePlanEnvelope
} from "../domain/orderLifecycle.js";
import { buildOrderNotificationHints } from "../domain/orderNotifications.js";
import { decorateOrderWithTurnSummary } from "../domain/orderTurns.js";
import {
  buildWorkspaceUploadLimits,
  loadOwnerUploadEntitlementByAgent
} from "../domain/ownerMemberships.js";
import {
  assertPlatformManagedArtifactAllowed,
  buildPlatformManagedArtifactObjectKey,
  createPlatformManagedUploadUrl,
  getPlatformManagedObjectStream,
  headPlatformManagedObject,
  isPlatformManagedDeliveryEnabled,
  platformManagedBucketName,
  sanitizeArtifactFileName
} from "../domain/objectStorage.js";
import { finalizePreAcceptanceExit } from "../domain/orderOperations.js";
import { queueProviderRelayEvent } from "../domain/providerRelay.js";
import {
  acquireConcurrentSlot,
  resolveRequestIp,
  takeFixedWindowToken
} from "../domain/requestGuards.js";
import { releaseHeldEscrowToProvider } from "../domain/orderSettlement.js";
import {
  isSettlementActionAllowedForReviewBand,
  opensDispute,
  requestsRevision,
  reviewBands,
  settlementActions
} from "../domain/reviews.js";
import {
  loadReviewSnapshots,
  reviewStructuredAssessmentSchema,
  upsertReviewSnapshotsForOrder
} from "../domain/reviewSnapshots.js";
import {
  reclaimRuntimeCapacityForRevision,
  refreshValidatedConcurrency
} from "../domain/runtimeProfiles.js";
import {
  buildOrderTransactionVisibility,
  getOrderTransactionVisibility,
  refreshProviderReputationProfile,
  upsertTransactionSnapshotForOrder,
  upsertTransactionSnapshotVisibilityGrant
} from "../domain/transactionEvidence.js";
import { query, withTransaction } from "../db.js";
import { generateOrderNo, json } from "../utils.js";

const createOrderSchema = z.object({
  listing_id: z.string().uuid(),
  quoted_amount: z.number().int().nonnegative(),
  budget_confirmed: z.literal(true),
  package_name: z.string().optional(),
  input_payload: z.record(z.any()).default({}),
  budget_confirmation: budgetConfirmationSchema,
  purchase_plan_context: purchasePlanContextSchema.optional(),
  purchase_authorization_context: purchaseAuthorizationContextSchema.optional()
});

const reviewSchema = z.object({
  review_band: z.enum(reviewBands),
  settlement_action: z.enum(settlementActions),
  commentary: z.string().min(1),
  evidence: z.record(z.any()).default({}),
  structured_assessment: reviewStructuredAssessmentSchema.optional(),
  transaction_visibility_grant: z.lazy(() => transactionVisibilityGrantSchema).optional()
});

const cancelOrderSchema = z.object({
  reason: z.string().min(1).default("buyer_cancelled")
});

const submitBuyerContextSchema = buyerContextPackSchema;
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

const initiateBuyerInputArtifactSchema = z.object({
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

type OrderAccessRow = {
  id: string;
  order_no: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  service_listing_id?: string | null;
  status: string;
  escrow_status: string;
  delivered_at: string | null;
};

type OrderEventRow = {
  event_type: string;
  payload_json?: unknown;
};

type BuyerContextOrderRow = {
  id: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  service_listing_id: string | null;
  demand_post_id: string | null;
  demand_proposal_id: string | null;
  source_kind: string;
  status: string;
  escrow_status: string;
};

const buyerContextAlreadyRoutedStatuses = new Set([
  "queued_for_provider",
  "accepted",
  "in_progress",
  "revision_requested",
  "delivered",
  "evaluating",
  "completed",
  "disputed",
  "cancelled",
  "expired"
]);

const snapshotVisibilityGrantableStatuses = new Set([
  "delivered",
  "revision_requested",
  "completed",
  "disputed"
]);

function buildBuyerContextSubmitError(params: {
  error: string;
  reason?: string | null;
  blockers?: string[];
}) {
  return Object.assign(new Error(params.error), {
    reason: params.reason ?? null,
    blockers: params.blockers ?? []
  });
}

function buildWorkspaceManifestPath(orderId: string) {
  const pathName = `/agent/orders/${orderId}/workspace/manifest`;
  return config.publicApiBaseUrl ? `${config.publicApiBaseUrl}${pathName}` : `/api/v1${pathName}`;
}

function extractTaskTitleCandidate(order: Record<string, unknown>) {
  const inputPayload =
    order.input_payload_json && typeof order.input_payload_json === "object"
      ? (order.input_payload_json as Record<string, unknown>)
      : {};

  const candidates = [
    typeof order.demand_title === "string" ? order.demand_title : null,
    typeof order.listing_title === "string" ? order.listing_title : null,
    typeof inputPayload.title === "string" ? inputPayload.title : null,
    typeof inputPayload.task === "string" ? inputPayload.task : null,
    typeof inputPayload.summary === "string" ? inputPayload.summary : null,
    typeof order.order_no === "string" ? order.order_no : null
  ];

  return candidates.find((item) => typeof item === "string" && item.trim().length > 0) ?? "order";
}

function buildLocalBundleForOrder(order: Record<string, unknown>) {
  return buildLocalOrderBundleDescriptor({
    orderId: String(order.id),
    createdAt:
      typeof order.created_at === "string" ? order.created_at : new Date().toISOString(),
    titleCandidate: extractTaskTitleCandidate(order)
  });
}

function buildAttachmentContentDisposition(fileName: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function buyerInputErrorStatus(errorCode: string): number {
  switch (errorCode) {
    case "order_not_found":
    case "platform_managed_artifact_not_found":
    case "buyer_input_artifact_not_found":
    case "buyer_context_artifact_not_found":
      return 404;
    case "buyer_input_forbidden":
    case "platform_managed_artifact_forbidden":
      return 403;
    case "buyer_input_order_not_open":
    case "platform_managed_delivery_not_configured":
    case "platform_managed_artifact_too_large":
    case "platform_managed_artifact_size_invalid":
    case "platform_managed_artifact_type_not_allowed":
    case "buyer_input_workspace_limit_exceeded":
    case "buyer_context_materials_missing":
      return 400;
    default:
      return 409;
  }
}

function sendBuyerInputError(
  reply: Parameters<FastifyInstance["post"]>[1] extends never ? never : any,
  errorCode: string,
  details?: Record<string, unknown>
) {
  reply.code(buyerInputErrorStatus(errorCode)).send({
    error: errorCode,
    ...(details ?? {})
  });
}

function buildBuyerContextPackPayload(events: Array<OrderEventRow & Record<string, unknown>>) {
  return extractLatestBuyerContextPack(events);
}

async function loadBuyerOwnedOrderForUpdate(client: PoolClient, orderId: string, buyerId: string) {
  const orderResult = await client.query<OrderAccessRow & { status: string }>(
    `
      SELECT id, buyer_agent_id, provider_agent_id, service_listing_id, status
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

  if (order.buyer_agent_id !== buyerId) {
    throw new Error("buyer_input_forbidden");
  }

  return order;
}

function transactionVisibilityErrorStatus(errorCode: string) {
  switch (errorCode) {
    case "order_not_found":
      return 404;
    case "buyer_input_forbidden":
      return 403;
    case "transaction_snapshot_visibility_not_ready":
      return 409;
    default:
      return 400;
  }
}

async function loadPlatformManagedArtifactForUpdate(
  client: PoolClient,
  artifactId: string,
  orderId: string
) {
  const result = await client.query<DeliveryArtifactRow>(
    `
      SELECT *
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

export async function registerOrderRoutes(app: FastifyInstance) {
  app.get("/api/v1/agent/orders", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const orderStatusGroups = {
      provider_action_required: [
        "queued_for_provider",
        "accepted",
        "in_progress",
        "revision_requested"
      ],
      provider_open: [
        "queued_for_provider",
        "accepted",
        "in_progress",
        "revision_requested",
        "delivered",
        "evaluating",
        "disputed"
      ],
      buyer_action_required: ["awaiting_buyer_context", "delivered", "evaluating"],
      buyer_open: [
        "awaiting_buyer_context",
        "queued_for_provider",
        "accepted",
        "in_progress",
        "revision_requested",
        "delivered",
        "evaluating",
        "disputed"
      ]
    } as const;

    const filters = z
      .object({
        role: z.enum(["buyer", "provider"]),
        status: z.string().optional(),
        status_group: z
          .enum([
            "provider_action_required",
            "provider_open",
            "buyer_action_required",
            "buyer_open"
          ])
          .optional()
      })
      .parse(request.query);

    if (
      (filters.role === "provider" && filters.status_group?.startsWith("buyer_")) ||
      (filters.role === "buyer" && filters.status_group?.startsWith("provider_"))
    ) {
      reply.code(400).send({
        error: "order_status_group_role_mismatch"
      });
      return;
    }

    const values: unknown[] = [agent.id];
    const where: string[] = [
      filters.role === "buyer" ? "buyer_agent_id = $1" : "provider_agent_id = $1"
    ];

    if (filters.status) {
      values.push(filters.status);
      where.push(`status = $${values.length}`);
    }

    if (filters.status_group) {
      values.push(orderStatusGroups[filters.status_group]);
      where.push(`status = ANY($${values.length}::text[])`);
    }

    const orders = await query(
      `
        SELECT *
        FROM orders
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
      `,
      values
    );

    return {
      items: orders.rows.map((order) => decorateOrderWithTurnSummary(order))
    };
  });

  app.post("/api/v1/agent/orders", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const body = createOrderSchema.parse(request.body);

    const created = await withTransaction(async (client) => {
      const listingResult = await client.query<{
        id: string;
        provider_agent_id: string;
        title: string;
        status: string;
        price_min: string;
        price_max: string;
        output_schema_json: unknown[];
        execution_scope_json: Record<string, unknown>;
      }>(
        `
          SELECT id, provider_agent_id, title, status, price_min, price_max, output_schema_json,
                 execution_scope_json
          FROM service_listings
          WHERE id = $1
          LIMIT 1
        `,
        [body.listing_id]
      );

      const listing = listingResult.rows[0];
      if (!listing) {
        throw new Error("listing_not_found");
      }

      if (listing.status !== "active") {
        throw new Error("listing_not_active");
      }

      if (listing.provider_agent_id === buyer.id) {
        throw new Error("buyer_cannot_order_own_listing");
      }

      if (body.quoted_amount < Number(listing.price_min) || body.quoted_amount > Number(listing.price_max)) {
        throw new Error("quoted_amount_out_of_range");
      }

      const walletResult = await client.query<{
        id: string;
        available_balance: string;
        held_balance: string;
      }>(
        `
          SELECT id, available_balance, held_balance
          FROM wallet_accounts
          WHERE agent_account_id = $1
          FOR UPDATE
        `,
        [buyer.id]
      );

      const buyerWallet = walletResult.rows[0];
      if (!buyerWallet) {
        throw new Error("wallet_not_found");
      }

      const availableBalance = Number(buyerWallet.available_balance);
      const heldBalance = Number(buyerWallet.held_balance);

      if (availableBalance < body.quoted_amount) {
        throw new Error("insufficient_balance");
      }

      const selectedOptionRef = `listing:${listing.id}:${body.package_name ?? "default"}`;

      await validatePurchasePlanEnvelope(client, {
        buyerAgentId: buyer.id,
        providerAgentId: listing.provider_agent_id,
        selectedOptionRef,
        quotedAmount: body.quoted_amount,
        purchasePlanContext: body.purchase_plan_context ?? null
      });

      const snapshot = buildBudgetConfirmationSnapshot({
        source_kind: "listing",
        buyer_agent_id: buyer.id,
        provider_agent_id: listing.provider_agent_id,
        quoted_amount: body.quoted_amount,
        budget_confirmation: body.budget_confirmation,
        listing_id: listing.id,
        package_name: body.package_name ?? null,
        input_summary: body.input_payload,
        expected_outputs: listing.output_schema_json,
        confirmation_surface: undefined,
        selected_option_ref: selectedOptionRef,
        purchase_plan_context: body.purchase_plan_context ?? null,
        purchase_authorization_context: body.purchase_authorization_context ?? null
      });
      const buyerAuthorization = assertBuyerAuthorizationReadyForCheckout(snapshot);
      const merchantCommitment = snapshot.merchant_commitment as Record<string, unknown>;
      const authorizationScope = snapshot.authorization_scope as Record<string, unknown>;

      const orderNo = generateOrderNo();
      const orderResult = await client.query(
        `
          INSERT INTO orders (
          order_no,
          buyer_agent_id,
          provider_agent_id,
            service_listing_id,
            quoted_amount,
            final_amount,
            input_payload_json,
            expected_output_schema_json,
            budget_confirmation_snapshot_json,
            execution_scope_snapshot_json,
            expires_at,
            status,
            escrow_status
          )
          VALUES (
            $1, $2, $3, $4, $5, $5,
            $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
            NOW() + ($10 * INTERVAL '1 minute'),
            'awaiting_buyer_context',
            'held'
          )
          RETURNING *
        `,
        [
          orderNo,
          buyer.id,
          listing.provider_agent_id,
          listing.id,
          body.quoted_amount,
          json(body.input_payload),
          json(listing.output_schema_json),
          json(snapshot),
          json(listing.execution_scope_json ?? {}),
          config.orderQueueTimeoutMinutes
        ]
      );

      const order = orderResult.rows[0];

      await client.query(
        `
          UPDATE wallet_accounts
          SET available_balance = $2, held_balance = $3, updated_at = NOW()
          WHERE id = $1
        `,
        [buyerWallet.id, availableBalance - body.quoted_amount, heldBalance + body.quoted_amount]
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
          VALUES ($1, $2, 'hold', 'debit', $3, $4, $5, 'order', 'order_hold')
        `,
        [
          buyerWallet.id,
          order.id,
          body.quoted_amount,
          availableBalance - body.quoted_amount,
          heldBalance + body.quoted_amount
        ]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES
            ($1, 'buyer_confirmed', 'buyer_agent', $2, $3::jsonb),
            ($1, 'owner_authorization_captured', 'buyer_agent', $2, $4::jsonb),
            ($1, 'funds_held', 'system', NULL, $5::jsonb),
            ($1, 'buyer_context_required', 'system', NULL, $6::jsonb)
        `,
        [
          order.id,
          buyer.id,
          json(body.budget_confirmation),
          json({
            ...buyerAuthorization,
            quote_digest: merchantCommitment.quote_digest ?? null,
            authorization_scope_kind: authorizationScope.scope_kind ?? null,
            per_order_budget_cap:
              (snapshot.authorization_policy as Record<string, unknown>).per_order_budget_cap ?? null
          }),
          json({ amount: body.quoted_amount }),
          json({
            provider_agent_id: listing.provider_agent_id,
            required_step: "buyer_context_pack",
            note: "Buyer must confirm and submit the formal Buyer Context Pack before the provider can receive or execute the order."
          })
        ]
      );

      await refreshListingMetrics(client, listing.id);

      const finalOrderResult = await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [order.id]);
      return finalOrderResult.rows[0];
    }).catch((error: Error) => {
      const knownErrors = new Set([
        "listing_not_found",
        "listing_not_active",
        "buyer_cannot_order_own_listing",
        "quoted_amount_out_of_range",
        "wallet_not_found",
        "insufficient_balance",
        "provider_out_of_authorized_scope",
        "option_out_of_authorized_scope",
        "plan_per_order_budget_cap_exceeded",
        "plan_total_budget_cap_exceeded",
        "plan_provider_limit_exceeded",
        "owner_authorization_missing",
        "owner_authorization_step_up_required"
      ]);

      if (knownErrors.has(error.message)) {
        const errorWithDetails = error as Error & {
          step_up_reason_codes?: string[];
          buyer_authorization?: unknown;
        };
        const statusCode = [
          "buyer_cannot_order_own_listing",
          "insufficient_balance",
          "plan_per_order_budget_cap_exceeded",
          "plan_total_budget_cap_exceeded",
          "plan_provider_limit_exceeded",
          "owner_authorization_step_up_required"
        ].includes(error.message)
          ? 409
          : 400;
        reply.code(statusCode).send({
          error: error.message,
          ...(Array.isArray(errorWithDetails.step_up_reason_codes)
            ? { step_up_reason_codes: errorWithDetails.step_up_reason_codes }
            : {}),
          ...(errorWithDetails.buyer_authorization
            ? { buyer_authorization: errorWithDetails.buyer_authorization }
            : {})
        });
        return null;
      }

      throw error;
    });

    if (!created) {
      return;
    }

    reply.code(201).send(decorateOrderWithTurnSummary(created));
  });

  app.post("/api/v1/agent/orders/:orderId/buyer-context/submit", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const parsedBody = submitBuyerContextSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      const hasMissingMaterialsIssue = parsedBody.error.issues.some(
        (issue) =>
          issue.message === "summary_only mode cannot claim files, images, or links without structured references"
      );
      if (hasMissingMaterialsIssue) {
        sendBuyerInputError(reply, "buyer_context_materials_missing");
        return;
      }

      throw parsedBody.error;
    }
    const body = parsedBody.data;

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query<BuyerContextOrderRow>(
        `
          SELECT id, buyer_agent_id, provider_agent_id, service_listing_id, demand_post_id,
                 demand_proposal_id, source_kind, status, escrow_status
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

      if (order.buyer_agent_id !== buyer.id) {
        throw new Error("buyer_input_forbidden");
      }

      if (order.escrow_status !== "held") {
        throw new Error("buyer_context_submit_not_allowed");
      }

      if (order.status !== "awaiting_buyer_context") {
        if (buyerContextAlreadyRoutedStatuses.has(order.status)) {
          const existingContextEvent = await client.query(
            `
              SELECT 1
              FROM order_events
              WHERE order_id = $1 AND event_type = 'buyer_context_submitted'
              LIMIT 1
            `,
            [order.id]
          );

          if (existingContextEvent.rowCount) {
            const finalOrderResult = await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [
              order.id
            ]);

            return {
              order: decorateOrderWithTurnSummary(finalOrderResult.rows[0]),
              idempotent: true
            };
          }
        }

        throw new Error("buyer_context_submit_not_allowed");
      }

      const artifactIds = [...new Set(body.artifact_ids)];
      if (artifactIds.length > 0) {
        const artifactResult = await client.query<DeliveryArtifactRow>(
          `
            SELECT *
            FROM delivery_artifacts
            WHERE order_id = $1
              AND id = ANY($2::uuid[])
            FOR UPDATE
          `,
          [order.id, artifactIds]
        );

        if (artifactResult.rows.length !== artifactIds.length) {
          throw new Error("buyer_context_artifact_not_found");
        }

        for (const artifact of artifactResult.rows) {
          if (
            artifact.artifact_role !== "buyer_input" ||
            artifact.submitted_by_agent_id !== buyer.id ||
            !["uploaded", "submitted"].includes(artifact.status)
          ) {
            throw new Error("buyer_context_artifact_not_found");
          }
        }

        await client.query(
          `
            UPDATE delivery_artifacts
            SET status = 'submitted',
                updated_at = NOW()
            WHERE order_id = $1
              AND id = ANY($2::uuid[])
              AND status = 'uploaded'
          `,
          [order.id, artifactIds]
        );
      }

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, 'buyer_context_submitted', 'buyer_agent', $2, $3::jsonb)
        `,
        [
          order.id,
          buyer.id,
          json({
            owner_confirmed: body.owner_confirmed,
            share_summary: body.share_summary,
            material_delivery_mode: body.material_delivery_mode,
            artifact_ids: artifactIds,
            external_context_links: body.external_context_links,
            withheld_items: body.withheld_items
          })
        ]
      );

      const routed = await routeOrderAfterBuyerContextSubmission(client, {
        orderId: order.id,
        providerAgentId: order.provider_agent_id,
        autoAcceptPayload: {
          source_kind: order.source_kind,
          provider_agent_id: order.provider_agent_id,
          demand_id: order.demand_post_id,
          proposal_id: order.demand_proposal_id
        },
        queuedPayload: {
          provider_agent_id: order.provider_agent_id,
          source_kind: order.source_kind,
          buyer_context_pack: {
            share_summary: body.share_summary,
            material_delivery_mode: body.material_delivery_mode,
            artifact_ids: artifactIds,
            external_context_links: body.external_context_links,
            withheld_items: body.withheld_items
          }
        }
      });

      if (!routed.status) {
        throw buildBuyerContextSubmitError({
          error: "provider_intake_unavailable",
          reason: routed.reason,
          blockers: routed.blockers
        });
      }

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }

      const finalOrderResult = await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [order.id]);
      return {
        order: decorateOrderWithTurnSummary(finalOrderResult.rows[0]),
        idempotent: false
      };
    }).catch((error: Error & { reason?: string | null; blockers?: string[] }) => {
      if (
        [
          "order_not_found",
          "buyer_input_forbidden",
          "buyer_context_submit_not_allowed",
          "buyer_context_artifact_not_found",
          "buyer_context_materials_missing"
        ].includes(error.message)
      ) {
        sendBuyerInputError(reply, error.message);
        return null;
      }

      if (error.message === "provider_intake_unavailable") {
        reply.code(409).send({
          error: error.message,
          reason: error.reason ?? null,
          blockers: error.blockers ?? []
        });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    if (!result.idempotent) {
      void queueProviderRelayEvent({
        orderId: result.order.id,
        eventType: "order_assigned"
      }).catch((error) => {
        app.log.warn(error, "provider relay queue failed after buyer context submit");
      });
    }

    return result;
  });

  app.get("/api/v1/agent/orders/:orderId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const orderResult = await query<OrderAccessRow & Record<string, unknown>>(
      `
        SELECT o.*, sl.title AS listing_title, dp.title AS demand_title
        FROM orders o
        LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
        LEFT JOIN demand_posts dp ON dp.id = o.demand_post_id
        WHERE o.id = $1 AND (o.buyer_agent_id = $2 OR o.provider_agent_id = $2)
        LIMIT 1
      `,
      [params.orderId, agent.id]
    );

    const order = orderResult.rows[0];
    if (!order) {
      reply.code(404).send({ error: "order_not_found" });
      return;
    }

    const viewerRole = order.buyer_agent_id === agent.id ? "buyer" : "provider";
    const bundleManifestUrl = buildWorkspaceManifestPath(params.orderId);
    const localBundle = buildLocalBundleForOrder(order);
    const { listing_title: _listingTitle, demand_title: _demandTitle, ...orderPayloadBase } = order;
    const orderPayload = decorateOrderWithTurnSummary(orderPayloadBase);
    const buyerAuthorization = buildBuyerAuthorizationSummary(
      orderPayloadBase.budget_confirmation_snapshot_json
    );

    const [
      eventsResult,
      deliveriesResult,
      reviewResult,
      transportResult,
      buyerUploadEntitlement,
      providerUploadEntitlement,
      transactionVisibility,
      reviewSnapshots
    ] = await Promise.all([
      query<OrderEventRow & Record<string, unknown>>(
        `SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at ASC`,
        [params.orderId]
      ),
      query<DeliveryArtifactRow>(
        `SELECT * FROM delivery_artifacts WHERE order_id = $1 ORDER BY created_at ASC`,
        [params.orderId]
      ),
      query(`SELECT * FROM reviews WHERE order_id = $1 LIMIT 1`, [params.orderId]),
      query(`SELECT * FROM order_transport_sessions WHERE order_id = $1 LIMIT 1`, [params.orderId]),
      loadOwnerUploadEntitlementByAgent(query, order.buyer_agent_id),
      loadOwnerUploadEntitlementByAgent(query, order.provider_agent_id),
      getOrderTransactionVisibility({ query }, params.orderId, order.status),
      loadReviewSnapshots({ query }, params.orderId)
    ]);
    const review = reviewResult.rows[0] ?? null;
    const reviewSnapshot = reviewSnapshots[reviewSnapshots.length - 1] ?? null;
    const notificationHints = buildOrderNotificationHints({
      order,
      review,
      events: eventsResult.rows,
      deliveries: deliveriesResult.rows,
      deliveredReviewAutoCloseHours: config.deliveredReviewAutoCloseHours
    });

    return {
      order: orderPayload,
      events: eventsResult.rows,
      buyer_context_pack: buildBuyerContextPackPayload(eventsResult.rows),
      workspace: buildOrderWorkspace(deliveriesResult.rows, viewerRole, {
        bundleManifestUrl,
        localBundle,
        uploadLimits: buildWorkspaceUploadLimits({
          buyer: buyerUploadEntitlement,
          provider: providerUploadEntitlement
        })
      }),
      review,
      review_snapshot: reviewSnapshot,
      review_snapshot_history: reviewSnapshots,
      review_deadline_at: notificationHints.review_deadline_at,
      notification_hints: notificationHints,
      transport_session: transportResult.rows[0] ?? null,
      buyer_authorization: buyerAuthorization,
      transaction_visibility: transactionVisibility
    };
  });

  app.get("/api/v1/agent/orders/:orderId/workspace/manifest", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const orderResult = await query<OrderAccessRow & Record<string, unknown>>(
      `
        SELECT o.*, sl.title AS listing_title, dp.title AS demand_title
        FROM orders o
        LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
        LEFT JOIN demand_posts dp ON dp.id = o.demand_post_id
        WHERE o.id = $1 AND (o.buyer_agent_id = $2 OR o.provider_agent_id = $2)
        LIMIT 1
      `,
      [params.orderId, agent.id]
    );

    const order = orderResult.rows[0];
    if (!order) {
      reply.code(404).send({ error: "order_not_found" });
      return;
    }

    const viewerRole = order.buyer_agent_id === agent.id ? "buyer" : "provider";
    const bundleManifestUrl = buildWorkspaceManifestPath(params.orderId);
    const localBundle = buildLocalBundleForOrder(order);
    const { listing_title: _listingTitle, demand_title: _demandTitle, ...orderPayloadBase } = order;
    const orderPayload = decorateOrderWithTurnSummary(orderPayloadBase);
    const buyerAuthorization = buildBuyerAuthorizationSummary(
      orderPayloadBase.budget_confirmation_snapshot_json
    );

    const [
      eventsResult,
      deliveriesResult,
      reviewResult,
      transportResult,
      buyerUploadEntitlement,
      providerUploadEntitlement,
      transactionVisibility,
      reviewSnapshots
    ] = await Promise.all([
      query<OrderEventRow & Record<string, unknown>>(
        `SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at ASC`,
        [params.orderId]
      ),
      query<DeliveryArtifactRow>(
        `SELECT * FROM delivery_artifacts WHERE order_id = $1 ORDER BY created_at ASC`,
        [params.orderId]
      ),
      query(`SELECT * FROM reviews WHERE order_id = $1 LIMIT 1`, [params.orderId]),
      query(`SELECT * FROM order_transport_sessions WHERE order_id = $1 LIMIT 1`, [params.orderId]),
      loadOwnerUploadEntitlementByAgent(query, order.buyer_agent_id),
      loadOwnerUploadEntitlementByAgent(query, order.provider_agent_id),
      getOrderTransactionVisibility({ query }, params.orderId, order.status),
      loadReviewSnapshots({ query }, params.orderId)
    ]);
    const review = reviewResult.rows[0] ?? null;
    const reviewSnapshot = reviewSnapshots[reviewSnapshots.length - 1] ?? null;
    const notificationHints = buildOrderNotificationHints({
      order,
      review,
      events: eventsResult.rows,
      deliveries: deliveriesResult.rows,
      deliveredReviewAutoCloseHours: config.deliveredReviewAutoCloseHours
    });

    const workspace = buildOrderWorkspace(deliveriesResult.rows, viewerRole, {
      bundleManifestUrl,
      localBundle,
      uploadLimits: buildWorkspaceUploadLimits({
        buyer: buyerUploadEntitlement,
        provider: providerUploadEntitlement
      })
    });

    return {
      order_id: order.id,
      generated_at: new Date().toISOString(),
      local_bundle: localBundle,
      workspace,
      review_snapshot: reviewSnapshot,
      review_snapshot_history: reviewSnapshots,
      review_deadline_at: notificationHints.review_deadline_at,
      notification_hints: notificationHints,
      buyer_authorization: buyerAuthorization,
      transaction_visibility: transactionVisibility,
      items: buildWorkspaceManifestItems(deliveriesResult.rows, viewerRole),
      order_snapshot: {
        order: orderPayload,
        events: eventsResult.rows,
        buyer_context_pack: buildBuyerContextPackPayload(eventsResult.rows),
        review,
        review_snapshot: reviewSnapshot,
        review_snapshot_history: reviewSnapshots,
        transport_session: transportResult.rows[0] ?? null,
        buyer_authorization: buyerAuthorization,
        transaction_visibility: transactionVisibility
      }
    };
  });

  app.post("/api/v1/agent/orders/:orderId/visibility-grants", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = transactionVisibilityGrantSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
      const order = await loadBuyerOwnedOrderForUpdate(client, params.orderId, buyer.id);
      if (!snapshotVisibilityGrantableStatuses.has(order.status)) {
        throw new Error("transaction_snapshot_visibility_not_ready");
      }

      const visibility = await upsertTransactionSnapshotVisibilityGrant(client, {
        orderId: order.id,
        grantedByAgentId: buyer.id,
        actorRole: "buyer_agent",
        allowPlatformIndex: body.allow_platform_index,
        allowAgentSearchPreview: body.allow_agent_search_preview,
        allowPublicCasePreview: body.allow_public_case_preview,
        note: body.note
      });

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }
      await refreshProviderReputationProfile(client, order.provider_agent_id);

      return buildOrderTransactionVisibility(visibility, order.status);
    }).catch((error: Error) => {
      if (["order_not_found", "buyer_input_forbidden", "transaction_snapshot_visibility_not_ready"].includes(error.message)) {
        reply.code(transactionVisibilityErrorStatus(error.message)).send({ error: error.message });
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

  app.post("/api/v1/agent/orders/:orderId/inputs/platform-managed/initiate", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = initiateBuyerInputArtifactSchema.parse(request.body ?? {});
    const auditContext = buildDeliveryArtifactAuditContext(request);

    const result = await withTransaction(async (client) => {
      if (!isPlatformManagedDeliveryEnabled()) {
        throw new Error("platform_managed_delivery_not_configured");
      }

      const order = await loadBuyerOwnedOrderForUpdate(client, params.orderId, buyer.id);
      if (!orderAllowsBuyerInputUpload(order.status)) {
        throw new Error("buyer_input_order_not_open");
      }
      const uploadEntitlement = await loadOwnerUploadEntitlementByAgent(
        client.query.bind(client),
        buyer.id
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
        artifactRole: "buyer_input",
        incomingSizeBytes: body.size_bytes,
        maxTotalBytes: uploadEntitlement.effective_platform_managed_total_bytes_per_role
      });

      const nextArtifactId = randomUUID();
      const objectKey = buildPlatformManagedArtifactObjectKey({
        orderId: order.id,
        artifactRole: "buyer_input",
        artifactId: nextArtifactId,
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
            $1, $2, $3, 'buyer_input', $4, 'platform_managed', 'aliyun_oss',
            $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'uploading', NOW()
          )
        `,
        [
          nextArtifactId,
          order.id,
          buyer.id,
          body.artifact_type,
          platformManagedBucketName(),
          objectKey,
          safeFileName,
          normalizedMimeType,
          body.size_bytes,
          body.checksum_sha256 ?? null,
          json({ upload_source: "platform_managed_oss", workspace_side: "buyer_input" }),
          body.summary
        ]
      );

      await writeDeliveryArtifactAudit({
        client,
        artifactId: nextArtifactId,
        orderId: order.id,
        actorType: "buyer_agent",
        actorId: buyer.id,
        eventType: "upload_initiated",
        context: auditContext,
        statusCode: 201,
        metadata: {
          artifact_role: "buyer_input",
          artifact_type: body.artifact_type,
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
          id: nextArtifactId,
          order_id: order.id,
          artifact_role: "buyer_input",
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
          "buyer_input_forbidden",
          "buyer_input_order_not_open",
          "platform_managed_delivery_not_configured",
          "platform_managed_artifact_too_large",
          "platform_managed_artifact_size_invalid",
          "platform_managed_artifact_type_not_allowed",
          "buyer_input_workspace_limit_exceeded"
        ].includes(error.message)
      ) {
        sendBuyerInputError(reply, error.message, limitDetails);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    reply.code(201).send(result);
  });

  app.post("/api/v1/agent/orders/:orderId/inputs/:artifactId/complete", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
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
      const order = await loadBuyerOwnedOrderForUpdate(client, params.orderId, buyer.id);
      if (!orderAllowsBuyerInputUpload(order.status)) {
        throw new Error("buyer_input_order_not_open");
      }

      const artifactResult = await client.query<DeliveryArtifactRow>(
        `
          SELECT *
          FROM delivery_artifacts
          WHERE id = $1 AND order_id = $2
          FOR UPDATE
        `,
        [params.artifactId, order.id]
      );

      const artifact = artifactResult.rows[0];
      if (!artifact || artifact.delivery_mode !== "platform_managed" || artifact.artifact_role !== "buyer_input") {
        throw new Error("buyer_input_artifact_not_found");
      }

      if (artifact.submitted_by_agent_id !== buyer.id) {
        throw new Error("buyer_input_forbidden");
      }

      if (!artifact.object_key) {
        throw new Error("buyer_input_artifact_not_found");
      }

      if (["uploaded", "submitted"].includes(artifact.status)) {
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

      const nextArtifactStatus =
        order.status === "awaiting_buyer_context" ? "uploaded" : "submitted";
      const nextEventType =
        nextArtifactStatus === "uploaded" ? "buyer_input_uploaded" : "buyer_input_submitted";

      await client.query(
        `
          UPDATE delivery_artifacts
          SET status = $2,
              uploaded_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [artifact.id, nextArtifactStatus]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, $2, 'buyer_agent', $3, $4::jsonb)
        `,
        [
          order.id,
          nextEventType,
          buyer.id,
          json({
            artifact_id: artifact.id,
            artifact_role: artifact.artifact_role,
            file_name: artifact.file_name,
            size_bytes: artifact.size_bytes
          })
        ]
      );

      await writeDeliveryArtifactAudit({
        client,
        artifactId: artifact.id,
        orderId: artifact.order_id,
        actorType: "buyer_agent",
        actorId: buyer.id,
        eventType: "upload_completed",
        context: auditContext,
        statusCode: 200,
        metadata: {
          artifact_role: artifact.artifact_role,
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
          status: nextArtifactStatus
        }
      };
    }).catch((error: Error) => {
      if (
        [
          "order_not_found",
          "buyer_input_forbidden",
          "buyer_input_order_not_open",
          "buyer_input_artifact_not_found",
          "platform_managed_artifact_missing_object",
          "platform_managed_artifact_size_mismatch"
        ].includes(error.message)
      ) {
        sendBuyerInputError(reply, error.message);
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.get("/api/v1/agent/orders/:orderId/artifacts/:artifactId/download", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z
      .object({
        orderId: z.string().uuid(),
        artifactId: z.string().uuid()
      })
      .parse(request.params);

    const orderResult = await query<OrderAccessRow>(
      `
        SELECT id, buyer_agent_id, provider_agent_id
        FROM orders
        WHERE id = $1 AND (buyer_agent_id = $2 OR provider_agent_id = $2)
        LIMIT 1
      `,
      [params.orderId, agent.id]
    );

    const order = orderResult.rows[0];
    if (!order) {
      reply.code(404).send({ error: "order_not_found" });
      return;
    }

    const artifactResult = await query<DeliveryArtifactRow>(
      `
        SELECT *
        FROM delivery_artifacts
        WHERE id = $1 AND order_id = $2
        LIMIT 1
      `,
      [params.artifactId, params.orderId]
    );

    const artifact = artifactResult.rows[0];
    if (!artifact) {
      reply.code(404).send({ error: "artifact_not_found" });
      return;
    }

    const auditContext = buildDeliveryArtifactAuditContext(request);

    const viewerRole = order.buyer_agent_id === agent.id ? "buyer" : "provider";
    if (
      !canViewerAccessArtifact({
        viewerRole,
        artifactRole: artifact.artifact_role,
        status: artifact.status
      })
    ) {
      reply.code(404).send({ error: "artifact_not_available" });
      return;
    }

    if (artifact.delivery_mode === "platform_managed") {
      if (!artifact.object_key || !["uploaded", "submitted", "accepted", "rejected"].includes(artifact.status)) {
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 409,
          metadata: {
            reason: "artifact_not_available",
            artifact_status: artifact.status
          }
        });
        reply.code(409).send({ error: "artifact_not_available" });
        return;
      }

      if (artifact.purged_at) {
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 410,
          metadata: {
            reason: "artifact_purged",
            purge_reason: artifact.purge_reason,
            purged_at: artifact.purged_at
          }
        });
        reply.code(410).send({ error: "artifact_no_longer_available" });
        return;
      }

      const downloadRateLimit = takeFixedWindowToken({
        scope: "platform_managed_download_ip_rate",
        key: resolveRequestIp(request),
        max: config.deliveryArtifacts.downloadRateLimitPerIp,
        windowMs: config.deliveryArtifacts.downloadRateLimitWindowSeconds * 1000
      });
      if (!downloadRateLimit.allowed) {
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 429,
          metadata: {
            reason: "download_rate_limited",
            retry_after_seconds: downloadRateLimit.retryAfterSeconds
          }
        });
        reply.header("Retry-After", String(downloadRateLimit.retryAfterSeconds));
        reply.code(429).send({
          error: "platform_managed_download_rate_limited",
          retry_after_seconds: downloadRateLimit.retryAfterSeconds
        });
        return;
      }

      const globalSlot = acquireConcurrentSlot({
        scope: "platform_managed_download_global",
        key: "all",
        max: config.deliveryArtifacts.downloadMaxConcurrent
      });
      if (!globalSlot) {
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 429,
          metadata: {
            reason: "global_capacity_reached"
          }
        });
        reply.code(429).send({ error: "platform_managed_download_capacity_reached" });
        return;
      }

      const agentSlot = acquireConcurrentSlot({
        scope: "platform_managed_download_agent",
        key: agent.id,
        max: config.deliveryArtifacts.downloadMaxConcurrentPerAgent
      });
      if (!agentSlot) {
        globalSlot.release();
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 429,
          metadata: {
            reason: "agent_capacity_reached"
          }
        });
        reply.code(429).send({ error: "platform_managed_download_agent_capacity_reached" });
        return;
      }

      const ipSlot = acquireConcurrentSlot({
        scope: "platform_managed_download_ip",
        key: resolveRequestIp(request),
        max: config.deliveryArtifacts.downloadMaxConcurrentPerIp
      });
      if (!ipSlot) {
        agentSlot.release();
        globalSlot.release();
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 429,
          metadata: {
            reason: "ip_capacity_reached"
          }
        });
        reply.code(429).send({ error: "platform_managed_download_ip_capacity_reached" });
        return;
      }

      try {
        const object = await getPlatformManagedObjectStream(artifact.object_key);

        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("Cache-Control", "private, no-store");
        reply.raw.setHeader(
          "Content-Type",
          artifact.mime_type ?? object.mimeType ?? "application/octet-stream"
        );
        reply.raw.setHeader(
          "Content-Disposition",
          buildAttachmentContentDisposition(artifact.file_name ?? `artifact-${artifact.id}`)
        );

        const contentLength = artifact.size_bytes ?? object.sizeBytes;
        if (contentLength !== null) {
          reply.raw.setHeader("Content-Length", String(contentLength));
        }

        await pipeline(object.stream, reply.raw);
        await query(
          `
            UPDATE delivery_artifacts
            SET download_count = download_count + 1,
                last_downloaded_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `,
          [artifact.id]
        );
        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_completed",
          context: auditContext,
          statusCode: 200,
          metadata: {
            file_name: artifact.file_name,
            mime_type: artifact.mime_type,
            size_bytes: artifact.size_bytes,
            object_key: artifact.object_key
          }
        });
      } catch (error: unknown) {
        const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        if (!reply.raw.headersSent) {
          if (errorName === "NoSuchKeyError") {
            await writeDeliveryArtifactAudit({
              artifactId: artifact.id,
              orderId: artifact.order_id,
              actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
              actorId: agent.id,
              eventType: "download_failed",
              context: auditContext,
              statusCode: 404,
              metadata: {
                reason: "object_missing",
                object_key: artifact.object_key
              }
            });
            reply.code(404).send({ error: "artifact_not_found" });
            return;
          }

          await writeDeliveryArtifactAudit({
            artifactId: artifact.id,
            orderId: artifact.order_id,
            actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
            actorId: agent.id,
            eventType: "download_failed",
            context: auditContext,
            statusCode: 500,
            metadata: {
              reason: "stream_failed_before_headers"
            }
          });
          throw error;
        }

        await writeDeliveryArtifactAudit({
          artifactId: artifact.id,
          orderId: artifact.order_id,
          actorType: viewerRole === "buyer" ? "buyer_agent" : "provider_agent",
          actorId: agent.id,
          eventType: "download_failed",
          context: auditContext,
          statusCode: 499,
          metadata: {
            reason: "stream_failed_after_headers"
          }
        });
        request.log.warn({ err: error, artifactId: artifact.id }, "platform managed artifact stream failed");
      } finally {
        ipSlot.release();
        agentSlot.release();
        globalSlot.release();
      }
      return;
    }

    if (artifact.storage_url) {
      reply.redirect(artifact.storage_url, 302);
      return;
    }

    reply.code(404).send({ error: "artifact_not_available" });
  });

  app.post("/api/v1/agent/orders/:orderId/cancel", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = cancelOrderSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
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
        [params.orderId]
      );

      const order = orderResult.rows[0];
      if (!order) {
        throw new Error("order_not_found");
      }

      if (order.buyer_agent_id !== buyer.id) {
        throw new Error("cancel_forbidden");
      }

      if (
        !["awaiting_buyer_context", "queued_for_provider"].includes(order.status) ||
        order.escrow_status !== "held"
      ) {
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
        actorType: "buyer_agent",
        actorId: buyer.id,
        eventType: "buyer_cancelled",
        eventPayload: { reason: body.reason },
        ledgerMemo: "buyer_cancelled_refund"
      });

      return {
        status: "cancelled",
        notify_provider: order.notify_provider
      };
    }).catch((error: Error) => {
      if (
        ["order_not_found", "cancel_forbidden", "order_not_cancellable"].includes(error.message)
      ) {
        reply.code(
          error.message === "order_not_found"
            ? 404
            : error.message === "cancel_forbidden"
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

    if (result.notify_provider) {
      void queueProviderRelayEvent({
        orderId: params.orderId,
        eventType: "order_cancelled"
      }).catch((error) => {
        app.log.warn(error, "provider relay queue failed after buyer cancel");
      });
    }

    return result;
  });

  app.get("/api/v1/agent/wallet", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const walletResult = await query(
      `
        SELECT wa.*,
               (
                 SELECT COALESCE(JSON_AGG(entry ORDER BY entry.created_at DESC), '[]'::json)
                 FROM (
                   SELECT id, entry_type, direction, amount, balance_after_available,
                          balance_after_held, memo, created_at
                   FROM wallet_ledger_entries
                   WHERE wallet_account_id = wa.id
                   ORDER BY created_at DESC
                   LIMIT 10
                 ) entry
               ) AS recent_entries
        FROM wallet_accounts wa
        WHERE wa.agent_account_id = $1
        LIMIT 1
      `,
      [agent.id]
    );

    const wallet = walletResult.rows[0];
    if (!wallet) {
      reply.code(404).send({ error: "wallet_not_found" });
      return;
    }

    return wallet;
  });

  app.get("/api/v1/agent/wallet/ledger", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const ledgerResult = await query(
      `
        SELECT wle.*
        FROM wallet_ledger_entries wle
        JOIN wallet_accounts wa ON wa.id = wle.wallet_account_id
        WHERE wa.agent_account_id = $1
        ORDER BY wle.created_at DESC
      `,
      [agent.id]
    );

    return {
      items: ledgerResult.rows
    };
  });

  app.post("/api/v1/agent/orders/:orderId/review", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const body = reviewSchema.parse(request.body);

    if (!isSettlementActionAllowedForReviewBand(body.review_band, body.settlement_action)) {
      reply.code(400).send({ error: "review_action_not_allowed_for_band" });
      return;
    }

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        buyer_agent_id: string;
        provider_agent_id: string;
        final_amount: string;
        status: string;
        escrow_status: string;
        service_listing_id: string | null;
      }>(
        `
          SELECT id, buyer_agent_id, provider_agent_id, final_amount, status, escrow_status, service_listing_id
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

      if (order.buyer_agent_id !== buyer.id) {
        throw new Error("review_forbidden");
      }
      if (order.status !== "delivered" || order.escrow_status !== "held") {
        throw new Error("review_not_ready");
      }

      const persistBuyerVisibilityGrant = async () => {
        if (!body.transaction_visibility_grant) {
          return;
        }

        await upsertTransactionSnapshotVisibilityGrant(client, {
          orderId: order.id,
          grantedByAgentId: buyer.id,
          actorRole: "buyer_agent",
          allowPlatformIndex: body.transaction_visibility_grant.allow_platform_index,
          allowAgentSearchPreview: body.transaction_visibility_grant.allow_agent_search_preview,
          allowPublicCasePreview: body.transaction_visibility_grant.allow_public_case_preview,
          note: body.transaction_visibility_grant.note
        });
      };

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
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          ON CONFLICT (order_id)
          DO UPDATE SET
            review_band = EXCLUDED.review_band,
            settlement_action = EXCLUDED.settlement_action,
            commentary = EXCLUDED.commentary,
            evidence_json = EXCLUDED.evidence_json,
            updated_at = NOW()
        `,
        [
          order.id,
          buyer.id,
          order.provider_agent_id,
          body.review_band,
          body.settlement_action,
          body.commentary,
          json(body.evidence)
        ]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, 'review_submitted', 'buyer_agent', $2, $3::jsonb)
        `,
        [order.id, buyer.id, json(body)]
      );

      if (requestsRevision(body.settlement_action)) {
        await client.query(
          `
            UPDATE orders
            SET status = 'revision_requested',
                updated_at = NOW()
            WHERE id = $1
          `,
          [order.id]
        );

        await client.query(
          `
            INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
            VALUES ($1, 'revision_requested', 'buyer_agent', $2, $3::jsonb)
          `,
          [
            order.id,
            buyer.id,
            json({
              review_band: body.review_band,
              settlement_action: body.settlement_action,
              commentary: body.commentary
            })
          ]
        );

        await reclaimRuntimeCapacityForRevision(client, order.provider_agent_id);
        await updateOrderTransportSessionStatus(client, order.id, "blocked");
        await persistBuyerVisibilityGrant();
        const transactionVisibility = await getOrderTransactionVisibility(client, order.id, "revision_requested");
        const reviewSnapshots = await upsertReviewSnapshotsForOrder(client, {
          orderId: order.id,
          transactionVisibility
        });

        return {
          status: "revision_requested",
          review_band: body.review_band,
          settlement_action: body.settlement_action,
          transaction_visibility: transactionVisibility,
          review_snapshot: reviewSnapshots[reviewSnapshots.length - 1] ?? null
        };
      }

      if (opensDispute(body.settlement_action)) {
        await client.query(
          `
            UPDATE orders
            SET status = 'disputed', updated_at = NOW()
            WHERE id = $1
          `,
          [order.id]
        );

        await client.query(
          `
            INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
            VALUES ($1, 'dispute_opened', 'buyer_agent', $2, $3::jsonb)
          `,
          [
            order.id,
            buyer.id,
            json({
              review_band: body.review_band,
              settlement_action: body.settlement_action
            })
          ]
        );

        await updateOrderTransportSessionStatus(client, order.id, "disputed");
        await persistBuyerVisibilityGrant();
        const transactionVisibility = await getOrderTransactionVisibility(client, order.id, "disputed");
        const reviewSnapshots = await upsertReviewSnapshotsForOrder(client, {
          orderId: order.id,
          transactionVisibility
        });

        if (order.service_listing_id) {
          await refreshListingMetrics(client, order.service_listing_id);
        }

        await upsertTransactionSnapshotForOrder(client, order.id);
        if (order.service_listing_id) {
          await refreshListingMetrics(client, order.service_listing_id);
        }
        await refreshProviderReputationProfile(client, order.provider_agent_id);
        await refreshValidatedConcurrency(client, order.provider_agent_id);

        return {
          status: "disputed",
          review_band: body.review_band,
          settlement_action: body.settlement_action,
          transaction_visibility: transactionVisibility,
          review_snapshot: reviewSnapshots[reviewSnapshots.length - 1] ?? null
        };
      }

      const amount = Number(order.final_amount);
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
          VALUES ($1, 'settlement_released', 'system', NULL, $2::jsonb)
        `,
        [order.id, json({ amount })]
      );

      await updateOrderTransportSessionStatus(client, order.id, "completed");
      await persistBuyerVisibilityGrant();
      const transactionVisibility = await getOrderTransactionVisibility(client, order.id, "completed");
      const reviewSnapshots = await upsertReviewSnapshotsForOrder(client, {
        orderId: order.id,
        transactionVisibility
      });

      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }

      await upsertTransactionSnapshotForOrder(client, order.id);
      if (order.service_listing_id) {
        await refreshListingMetrics(client, order.service_listing_id);
      }
      await refreshProviderReputationProfile(client, order.provider_agent_id);
      await refreshValidatedConcurrency(client, order.provider_agent_id);

      return {
        status: "completed",
        review_band: body.review_band,
        settlement_action: body.settlement_action,
        transaction_visibility: transactionVisibility,
        review_snapshot: reviewSnapshots[reviewSnapshots.length - 1] ?? null
      };
    }).catch((error: Error) => {
      if (["order_not_found", "review_forbidden", "review_not_ready"].includes(error.message)) {
        reply
          .code(
            error.message === "order_not_found"
              ? 404
              : error.message === "review_forbidden"
                ? 403
                : 409
          )
          .send({
            error: error.message
          });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    if (result.status === "revision_requested") {
      void queueProviderRelayEvent({
        orderId: params.orderId,
        eventType: "order_revision_requested"
      }).catch((error) => {
        app.log.warn(error, "provider relay queue failed after revision request");
      });
    } else if (result.status === "disputed") {
      void queueProviderRelayEvent({
        orderId: params.orderId,
        eventType: "order_disputed"
      }).catch((error) => {
        app.log.warn(error, "provider relay queue failed after dispute open");
      });
    } else if (result.status === "completed") {
      void queueProviderRelayEvent({
        orderId: params.orderId,
        eventType: "order_completed"
      }).catch((error) => {
        app.log.warn(error, "provider relay queue failed after review completion");
      });
    }

    return result;
  });
}
