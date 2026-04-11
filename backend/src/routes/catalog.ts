import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import { executionScopeSchema } from "../domain/executionScope.js";
import { ensureListingMetrics } from "../domain/listingMetrics.js";
import {
  buildBudgetConfirmationSnapshot,
  buildBuyerAuthorizationSummary,
  purchaseAuthorizationContextSchema,
  purchasePlanContextSchema
} from "../domain/orderLifecycle.js";
import {
  ensureRuntimeProfile,
  resolveProviderOrderIntakeDecision,
  type RuntimeProfile
} from "../domain/runtimeProfiles.js";
import {
  loadAgentSearchCasePreviews,
  loadProviderReputationProfile
} from "../domain/transactionEvidence.js";
import {
  computeCatalogRankingSignals,
  computeObjectiveDeliveryScore,
  computeReliabilityConfidence,
  type CatalogRankingSignals
} from "../domain/reliabilityRanking.js";
import { query, withTransaction } from "../db.js";
import { json } from "../utils.js";

const providerManagedListingStatusSchema = z.enum(["draft", "active", "paused"]);

const listingSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    category: z.string().min(1),
    tags: z.array(z.string()).default([]),
    input_schema: z.array(z.any()).default([]),
    output_schema: z.array(z.any()).default([]),
    service_packages: z.array(z.any()).default([]),
    case_examples: z.array(z.any()).default([]),
    execution_scope: executionScopeSchema,
    price_min: z.number().int().nonnegative(),
    price_max: z.number().int().nonnegative(),
    delivery_eta_minutes: z.number().int().positive(),
    status: providerManagedListingStatusSchema.default("draft")
  })
  .superRefine((value, context) => {
    if (value.price_max < value.price_min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price_max"],
        message: "price_max must be greater than or equal to price_min"
      });
    }
  });

const quotePreviewSchema = z.object({
  listing_id: z.string().uuid(),
  budget: z.number().int().nonnegative(),
  input_payload: z.record(z.any()).default({}),
  package_name: z.string().optional(),
  purchase_plan_context: purchasePlanContextSchema.optional(),
  purchase_authorization_context: purchaseAuthorizationContextSchema.optional()
});

function parseBooleanish(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (["true", "1", "yes"].includes(value.toLowerCase())) {
      return true;
    }

    if (["false", "0", "no"].includes(value.toLowerCase())) {
      return false;
    }
  }

  return value;
}

function parseStringArrayish(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return value;
}

const baseCatalogFilterSchema = z.object({
  q: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional()
});

const catalogFilterSchema = baseCatalogFilterSchema
  .extend({
    min_price: z.coerce.number().int().nonnegative().optional(),
    max_price: z.coerce.number().int().nonnegative().optional(),
    max_delivery_eta_minutes: z.coerce.number().int().positive().optional(),
    supports_a2a: z.preprocess(parseBooleanish, z.boolean().optional()),
    has_verified_cases: z.preprocess(parseBooleanish, z.boolean().optional()),
    accept_mode: z.enum(["auto_accept", "owner_confirm_required"]).optional(),
    required_input_key: z.string().trim().min(1).optional(),
    required_output_key: z.string().trim().min(1).optional(),
    tags_any: z.preprocess(parseStringArrayish, z.array(z.string().trim().min(1)).optional()),
    limit: z.coerce.number().int().min(1).max(20).default(5),
    cursor: z.string().optional()
  })
  .superRefine((value, ctx) => {
    if (
      typeof value.min_price === "number" &&
      typeof value.max_price === "number" &&
      value.max_price < value.min_price
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_price"],
        message: "max_price must be greater than or equal to min_price"
      });
    }
  });

const providerListingQuerySchema = z.object({
  status: providerManagedListingStatusSchema.optional()
});

type CatalogSearchFilters = z.infer<typeof catalogFilterSchema>;

const showcaseQuerySchema = baseCatalogFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(12).default(8)
});

const listingParamsSchema = z.object({
  listingId: z.string().uuid()
});

const listingProjection = `
  SELECT sl.*, aa.agent_name AS provider_agent_name, aa.slug AS provider_agent_slug,
         COALESCE(slm.review_score_avg, 0) AS review_score_avg,
         COALESCE(slm.review_count, 0) AS review_count,
         COALESCE(slm.accept_latency_p50_seconds, 0) AS accept_latency_p50_seconds,
         COALESCE(slm.delivery_latency_p50_seconds, 0) AS delivery_latency_p50_seconds,
         COALESCE(slm.dispute_rate, 0) AS dispute_rate,
         COALESCE(slm.accept_close_rate, 0) AS accept_close_rate,
         COALESCE(slm.on_time_delivery_rate, 0) AS on_time_delivery_rate,
         COALESCE(slm.revision_rate, 0) AS revision_rate,
         COALESCE(slm.verified_case_count, 0) AS verified_case_count,
         COALESCE(slm.public_case_count, 0) AS public_case_count,
         COALESCE(arp.accept_mode, 'owner_confirm_required') AS accept_mode,
         COALESCE(arp.validated_max_concurrency, 1) AS validated_max_concurrency,
         COALESCE(arp.current_active_order_count, 0) AS current_active_order_count,
         COALESCE(arp.supports_a2a, FALSE) AS supports_a2a,
         COALESCE(arp.claimed_max_concurrency, 1) AS claimed_max_concurrency,
         COALESCE(arp.queue_enabled, TRUE) AS queue_enabled,
         COALESCE(arp.supports_parallel_delivery, FALSE) AS supports_parallel_delivery,
         arp.a2a_agent_card_url,
         arp.provider_callback_url,
         COALESCE(arp.callback_timeout_seconds, 30) AS callback_timeout_seconds,
         COALESCE(arp.runtime_kind, 'generic') AS runtime_kind,
         arp.runtime_label,
         COALESCE(arp.automation_mode, 'manual') AS automation_mode,
         COALESCE(arp.automation_source, 'none') AS automation_source,
         COALESCE(arp.runtime_health_status, 'unknown') AS runtime_health_status,
         COALESCE(arp.heartbeat_ttl_seconds, 180) AS heartbeat_ttl_seconds,
         arp.last_heartbeat_at,
         arp.heartbeat_expires_at,
         COALESCE(arp.relay_connection_status, 'disconnected') AS relay_connection_status,
         arp.relay_session_id,
         arp.relay_connected_at,
         arp.relay_last_activity_at,
         arp.relay_lease_expires_at,
         arp.relay_last_disconnect_reason,
         COALESCE(arp.runtime_capabilities_json, '{}'::jsonb) AS runtime_capabilities_json,
         COALESCE(arp.runtime_authorization_json, '{}'::jsonb) AS runtime_authorization_json,
         COALESCE(arp.notify_target_json, '{}'::jsonb) AS notify_target_json,
         (
           SELECT COUNT(*)::int
           FROM orders o
           WHERE o.provider_agent_id = sl.provider_agent_id
             AND o.status = 'queued_for_provider'
         ) AS current_queue_depth
  FROM service_listings sl
  JOIN agent_accounts aa ON aa.id = sl.provider_agent_id
  LEFT JOIN service_listing_metrics slm ON slm.service_listing_id = sl.id
  LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = sl.provider_agent_id
`;

function toObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function toNullableString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toPositiveInt(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function toBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function toNumeric(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch {
    return 0;
  }
}

function buildRuntimeProfileFromListing(row: Record<string, unknown>): RuntimeProfile {
  return {
    id: toNullableString(row.runtime_profile_id) ?? `catalog:${String(row.provider_agent_id ?? "unknown")}`,
    agent_account_id: String(row.provider_agent_id ?? ""),
    accept_mode: row.accept_mode === "auto_accept" ? "auto_accept" : "owner_confirm_required",
    claimed_max_concurrency: toPositiveInt(row.claimed_max_concurrency, 1),
    validated_max_concurrency: toPositiveInt(row.validated_max_concurrency, 1),
    queue_enabled: row.queue_enabled !== false,
    current_active_order_count: toPositiveInt(row.current_active_order_count, 0),
    supports_parallel_delivery: row.supports_parallel_delivery === true,
    supports_a2a: row.supports_a2a === true,
    a2a_agent_card_url: toNullableString(row.a2a_agent_card_url),
    provider_callback_url: toNullableString(row.provider_callback_url),
    callback_timeout_seconds: toPositiveInt(row.callback_timeout_seconds, 30),
    runtime_kind: row.runtime_kind === "openclaw" ? "openclaw" : "generic",
    runtime_label: toNullableString(row.runtime_label),
    automation_mode: row.automation_mode === "openclaw_auto" ? "openclaw_auto" : "manual",
    automation_source:
      row.automation_source === "openclaw_native" || row.automation_source === "owner_console"
        ? row.automation_source
        : "none",
    runtime_health_status:
      row.runtime_health_status === "healthy" ||
      row.runtime_health_status === "stale" ||
      row.runtime_health_status === "offline" ||
      row.runtime_health_status === "degraded"
        ? row.runtime_health_status
        : "unknown",
    heartbeat_ttl_seconds: toPositiveInt(row.heartbeat_ttl_seconds, 180),
    last_heartbeat_at: toNullableString(row.last_heartbeat_at),
    heartbeat_expires_at: toNullableString(row.heartbeat_expires_at),
    relay_connection_status:
      row.relay_connection_status === "connected" || row.relay_connection_status === "standby"
        ? row.relay_connection_status
        : "disconnected",
    relay_session_id: toNullableString(row.relay_session_id),
    relay_connected_at: toNullableString(row.relay_connected_at),
    relay_last_activity_at: toNullableString(row.relay_last_activity_at),
    relay_lease_expires_at: toNullableString(row.relay_lease_expires_at),
    relay_last_disconnect_reason: toNullableString(row.relay_last_disconnect_reason),
    runtime_capabilities_json: toObject(row.runtime_capabilities_json),
    runtime_authorization_json: toObject(row.runtime_authorization_json),
    notify_target_json: toObject(row.notify_target_json),
    last_runtime_event_at: null,
    last_runtime_event_type: null,
    last_runtime_event_summary: null
  };
}

function decorateBuyerFacingListing<T extends Record<string, unknown>>(row: T) {
  const intakeDecision = resolveProviderOrderIntakeDecision(buildRuntimeProfileFromListing(row));
  return {
    ...row,
    configured_accept_mode: row.accept_mode === "auto_accept" ? "auto_accept" : "owner_confirm_required",
    accept_mode: intakeDecision.effective_accept_mode,
    auto_accept_ready: intakeDecision.auto_accept_ready,
    auto_accept_blockers: intakeDecision.blockers,
    accept_mode_reason: intakeDecision.reason
  };
}

function buildProviderReputationSummary(row: Record<string, unknown>) {
  const providerAgentId =
    toNullableString(row.provider_reputation_provider_agent_id) ??
    toNullableString(row.provider_agent_id);
  if (!providerAgentId) {
    return null;
  }

  const completedOrderCount = toPositiveInt(row.provider_reputation_completed_order_count, 0);
  const onTimeDeliveryRate = toNumeric(
    row.provider_reputation_on_time_delivery_rate,
    toNumeric(row.on_time_delivery_rate, 0)
  );
  const acceptCloseRate = toNumeric(
    row.provider_reputation_accept_close_rate,
    toNumeric(row.accept_close_rate, 0)
  );
  const revisionRate = toNumeric(
    row.provider_reputation_revision_rate,
    toNumeric(row.revision_rate, 0)
  );
  const disputeRate = toNumeric(
    row.provider_reputation_dispute_rate,
    toNumeric(row.dispute_rate, 0)
  );
  const evidenceBackedPositiveRate = toNumeric(
    row.provider_reputation_evidence_backed_positive_rate,
    0
  );
  const inputInsufficientRate = toNumeric(
    row.provider_reputation_input_insufficient_rate,
    0
  );
  const reliabilityConfidence = toNumeric(
    row.provider_reputation_reliability_confidence,
    computeReliabilityConfidence(completedOrderCount)
  );
  const objectiveDeliveryScore = toNumeric(
    row.provider_reputation_objective_delivery_score,
    computeObjectiveDeliveryScore({
      completed_order_count: completedOrderCount,
      on_time_delivery_rate: onTimeDeliveryRate,
      accept_close_rate: acceptCloseRate,
      revision_rate: revisionRate,
      dispute_rate: disputeRate,
      evidence_backed_positive_rate: evidenceBackedPositiveRate,
      input_insufficient_rate: inputInsufficientRate
    })
  );

  return {
    provider_agent_id: providerAgentId,
    completed_order_count: completedOrderCount,
    disputed_order_count: toPositiveInt(row.provider_reputation_disputed_order_count, 0),
    positive_review_count: toPositiveInt(row.provider_reputation_positive_review_count, 0),
    neutral_review_count: toPositiveInt(row.provider_reputation_neutral_review_count, 0),
    negative_review_count: toPositiveInt(row.provider_reputation_negative_review_count, 0),
    accept_close_count: toPositiveInt(row.provider_reputation_accept_close_count, 0),
    revision_requested_count: toPositiveInt(row.provider_reputation_revision_requested_count, 0),
    dispute_open_count: toPositiveInt(row.provider_reputation_dispute_open_count, 0),
    on_time_delivery_rate: onTimeDeliveryRate,
    accept_close_rate: acceptCloseRate,
    revision_rate: revisionRate,
    dispute_rate: disputeRate,
    agent_search_case_count: toPositiveInt(row.provider_reputation_agent_search_case_count, 0),
    public_case_count: toPositiveInt(row.provider_reputation_public_case_count, 0),
    objective_delivery_score: objectiveDeliveryScore,
    reliability_confidence: reliabilityConfidence,
    evidence_backed_positive_rate: evidenceBackedPositiveRate,
    input_insufficient_rate: inputInsufficientRate,
    median_accept_latency_seconds: toPositiveInt(
      row.provider_reputation_median_accept_latency_seconds,
      toPositiveInt(row.accept_latency_p50_seconds, 0)
    ),
    median_delivery_latency_seconds: toPositiveInt(
      row.provider_reputation_median_delivery_latency_seconds,
      toPositiveInt(row.delivery_latency_p50_seconds, 0)
    ),
    last_completed_order_at: toNullableString(row.provider_reputation_last_completed_order_at)
  };
}

function buildRankingSignals(row: Record<string, unknown>, filters: CatalogSearchFilters): CatalogRankingSignals {
  const providerReputation = buildProviderReputationSummary(row);
  const completedOrderCount = providerReputation?.completed_order_count ?? 0;
  const objectiveDeliveryScore =
    providerReputation?.objective_delivery_score ??
    computeObjectiveDeliveryScore({
      completed_order_count: completedOrderCount,
      on_time_delivery_rate: toNumeric(row.on_time_delivery_rate, 0),
      accept_close_rate: toNumeric(row.accept_close_rate, 0),
      revision_rate: toNumeric(row.revision_rate, 0),
      dispute_rate: toNumeric(row.dispute_rate, 0),
      evidence_backed_positive_rate: providerReputation?.evidence_backed_positive_rate ?? 0,
      input_insufficient_rate: providerReputation?.input_insufficient_rate ?? 0
    });
  const reliabilityConfidence =
    providerReputation?.reliability_confidence ?? computeReliabilityConfidence(completedOrderCount);

  return computeCatalogRankingSignals({
    filters: {
      q: filters.q ?? null,
      category: filters.category ?? null,
      tags_any: filters.tags_any ?? null,
      required_input_key: filters.required_input_key ?? null,
      required_output_key: filters.required_output_key ?? null,
      min_price: typeof filters.min_price === "number" ? filters.min_price : null,
      max_price: typeof filters.max_price === "number" ? filters.max_price : null
    },
    listing_text_match: toBoolean(row.ranking_listing_text_match),
    matched_snapshot_count: toPositiveInt(row.ranking_matched_snapshot_count, 0),
    verified_case_count: toPositiveInt(row.verified_case_count, 0),
    agent_search_case_count: providerReputation?.agent_search_case_count ?? 0,
    accept_mode: row.accept_mode === "auto_accept" ? "auto_accept" : "owner_confirm_required",
    auto_accept_ready: toBoolean(row.auto_accept_ready),
    current_queue_depth: toPositiveInt(row.current_queue_depth, 0),
    current_active_order_count: toPositiveInt(row.current_active_order_count, 0),
    validated_max_concurrency: toPositiveInt(row.validated_max_concurrency, 1),
    price_min: toPositiveInt(row.price_min, 0),
    price_max: toPositiveInt(row.price_max, 0),
    last_completed_order_at: providerReputation?.last_completed_order_at ?? null,
    created_at: toNullableString(row.created_at),
    objective_delivery_score: objectiveDeliveryScore,
    reliability_confidence: reliabilityConfidence
  });
}

function buildMatchReasons(
  row: Record<string, unknown>,
  providerReputation: ReturnType<typeof buildProviderReputationSummary>,
  rankingSignals: CatalogRankingSignals
) {
  const reasons: string[] = [];

  if (toBoolean(row.ranking_listing_text_match)) {
    reasons.push("listing_text_match");
  }

  if (toPositiveInt(row.ranking_matched_snapshot_count, 0) > 0) {
    reasons.push("historical_snapshot_match");
  }

  if (rankingSignals.historical_evidence_score >= 0.45) {
    reasons.push("evidence_backed_examples");
  }

  if (
    providerReputation &&
    providerReputation.objective_delivery_score >= 0.72 &&
    providerReputation.reliability_confidence >= 0.5
  ) {
    reasons.push("objective_reliability_track_record");
  }

  if (
    providerReputation &&
    providerReputation.accept_close_rate >= 0.8 &&
    providerReputation.reliability_confidence >= 0.25
  ) {
    reasons.push("strong_accept_close_track_record");
  }

  if (
    providerReputation &&
    providerReputation.on_time_delivery_rate >= 0.8 &&
    providerReputation.reliability_confidence >= 0.25
  ) {
    reasons.push("on_time_delivery_track_record");
  }

  if (providerReputation && providerReputation.completed_order_count > 0 && providerReputation.reliability_confidence < 0.5) {
    reasons.push("limited_completed_samples");
  }

  if (toPositiveInt(row.current_queue_depth, 0) === 0) {
    reasons.push("low_queue_depth");
  }

  if (reasons.length === 0) {
    reasons.push("basic_capability_match");
  }

  return reasons;
}

function replyListingManagementError(reply: FastifyReply, error: Error) {
  switch (error.message) {
    case "listing_not_found":
      reply.code(404).send({ error: error.message });
      return true;
    case "listing_manage_forbidden":
      reply.code(403).send({ error: error.message });
      return true;
    case "listing_delete_blocked_by_orders":
    case "listing_banned_locked":
      reply.code(409).send({ error: error.message });
      return true;
    default:
      return false;
  }
}

async function assertProviderListingOwnership(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  listingId: string,
  providerAgentId: string,
  lockRow = false
) {
  const result = await client.query(
    `
      SELECT id, provider_agent_id, status
      FROM service_listings
      WHERE id = $1
      LIMIT 1
      ${lockRow ? "FOR UPDATE" : ""}
    `,
    [listingId]
  );

  const listing = result.rows[0];
  if (!listing) {
    throw new Error("listing_not_found");
  }

  if (listing.provider_agent_id !== providerAgentId) {
    throw new Error("listing_manage_forbidden");
  }

  return listing;
}

async function getListingDetailById(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, listingId: string) {
  const result = await client.query(
    `
      ${listingProjection}
      WHERE sl.id = $1
      LIMIT 1
    `,
    [listingId]
  );

  return result.rows[0] ?? null;
}

export async function registerCatalogRoutes(app: FastifyInstance) {
  app.post("/api/v1/provider/listings", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = listingSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const insert = await client.query(
        `
          INSERT INTO service_listings (
            provider_agent_id,
            title,
            summary,
            category,
            tags_json,
            input_schema_json,
            output_schema_json,
            service_packages_json,
            case_examples_json,
            execution_scope_json,
            price_min,
            price_max,
            delivery_eta_minutes,
            status
          )
          VALUES (
            $1, $2, $3, $4,
            $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
            $11, $12, $13, $14
          )
          RETURNING *
        `,
        [
          agent.id,
          body.title,
          body.summary,
          body.category,
          json(body.tags),
          json(body.input_schema),
          json(body.output_schema),
          json(body.service_packages),
          json(body.case_examples),
          json(body.execution_scope),
          body.price_min,
          body.price_max,
          body.delivery_eta_minutes,
          body.status
        ]
      );

      const listing = insert.rows[0];
      await ensureListingMetrics(client, listing.id);
      await ensureRuntimeProfile(client, agent.id);
      return getListingDetailById(client, listing.id);
    });

    reply.code(201).send(result);
  });

  app.get("/api/v1/provider/listings", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const filters = providerListingQuerySchema.parse(request.query);
    const values: unknown[] = [agent.id];
    const where: string[] = ["sl.provider_agent_id = $1"];

    if (filters.status) {
      values.push(filters.status);
      where.push(`sl.status = $${values.length}`);
    }

    const result = await query(
      `
        ${listingProjection}
        WHERE ${where.join(" AND ")}
        ORDER BY sl.created_at DESC
      `,
      values
    );

    return {
      items: result.rows
    };
  });

  app.get("/api/v1/provider/listings/:listingId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = listingParamsSchema.parse(request.params);

    const result = await query(
      `
        ${listingProjection}
        WHERE sl.id = $1
        LIMIT 1
      `,
      [params.listingId]
    );

    const listing = result.rows[0];
    if (!listing) {
      reply.code(404).send({ error: "listing_not_found" });
      return;
    }

    if (listing.provider_agent_id !== agent.id) {
      reply.code(403).send({ error: "listing_manage_forbidden" });
      return;
    }

    return listing;
  });

  app.put("/api/v1/provider/listings/:listingId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = listingParamsSchema.parse(request.params);
    const body = listingSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const current = await assertProviderListingOwnership(client, params.listingId, agent.id, true);
      if (current.status === "banned") {
        throw new Error("listing_banned_locked");
      }

      await client.query(
        `
          UPDATE service_listings
          SET title = $3,
              summary = $4,
              category = $5,
              tags_json = $6::jsonb,
              input_schema_json = $7::jsonb,
              output_schema_json = $8::jsonb,
              service_packages_json = $9::jsonb,
              case_examples_json = $10::jsonb,
              execution_scope_json = $11::jsonb,
              price_min = $12,
              price_max = $13,
              delivery_eta_minutes = $14,
              status = $15,
              updated_at = NOW()
          WHERE id = $1
            AND provider_agent_id = $2
        `,
        [
          params.listingId,
          agent.id,
          body.title,
          body.summary,
          body.category,
          json(body.tags),
          json(body.input_schema),
          json(body.output_schema),
          json(body.service_packages),
          json(body.case_examples),
          json(body.execution_scope),
          body.price_min,
          body.price_max,
          body.delivery_eta_minutes,
          body.status
        ]
      );

      return getListingDetailById(client, params.listingId);
    }).catch((error: Error) => {
      if (replyListingManagementError(reply, error)) {
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.delete("/api/v1/provider/listings/:listingId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = listingParamsSchema.parse(request.params);

    const result = await withTransaction(async (client) => {
      const current = await assertProviderListingOwnership(client, params.listingId, agent.id, true);
      if (current.status === "banned") {
        throw new Error("listing_banned_locked");
      }

      const orderCountResult = await client.query<{ order_count: number }>(
        `
          SELECT COUNT(*)::int AS order_count
          FROM orders
          WHERE service_listing_id = $1
        `,
        [params.listingId]
      );

      if ((orderCountResult.rows[0]?.order_count ?? 0) > 0) {
        throw new Error("listing_delete_blocked_by_orders");
      }

      await client.query(
        `
          DELETE FROM service_listings
          WHERE id = $1
            AND provider_agent_id = $2
        `,
        [params.listingId, agent.id]
      );

      return {
        status: "deleted",
        listing_id: params.listingId
      };
    }).catch((error: Error) => {
      if (replyListingManagementError(reply, error)) {
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.get("/api/v1/agent/catalog/search", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const filters = catalogFilterSchema.parse(request.query);
    const offset = decodeCursor(filters.cursor);
    const values: unknown[] = ["active", agent.id];
    const where: string[] = ["sl.status = $1", "sl.provider_agent_id <> $2"];
    let searchPatternParamRef: number | null = null;

    if (filters.q) {
      values.push(`%${filters.q}%`);
      searchPatternParamRef = values.length;
      where.push(
        `(
          sl.title ILIKE $${values.length}
          OR sl.summary ILIKE $${values.length}
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(sl.tags_json) AS tag
            WHERE tag ILIKE $${values.length}
          )
          OR EXISTS (
            SELECT 1
            FROM transaction_snapshots ts
            WHERE ts.service_listing_id = sl.id
              AND ts.allow_in_agent_search = TRUE
              AND ts.searchable_text ILIKE $${values.length}
          )
        )`
      );
    }

    if (filters.category) {
      values.push(filters.category);
      where.push(`sl.category = $${values.length}`);
    }

    if (typeof filters.min_price === "number") {
      values.push(filters.min_price);
      where.push(`sl.price_max >= $${values.length}`);
    }

    if (typeof filters.max_price === "number") {
      values.push(filters.max_price);
      where.push(`sl.price_min <= $${values.length}`);
    }

    if (typeof filters.max_delivery_eta_minutes === "number") {
      values.push(filters.max_delivery_eta_minutes);
      where.push(`sl.delivery_eta_minutes <= $${values.length}`);
    }

    if (typeof filters.supports_a2a === "boolean") {
      values.push(filters.supports_a2a);
      where.push(`COALESCE(arp.supports_a2a, FALSE) = $${values.length}`);
    }

    if (typeof filters.has_verified_cases === "boolean") {
      where.push(
        filters.has_verified_cases
          ? "COALESCE(slm.verified_case_count, 0) > 0"
          : "COALESCE(slm.verified_case_count, 0) = 0"
      );
    }

    if (filters.required_input_key) {
      values.push(filters.required_input_key);
      where.push(
        `EXISTS (
          SELECT 1
          FROM jsonb_array_elements(sl.input_schema_json) AS item
          WHERE item->>'key' = $${values.length}
        )`
      );
    }

    if (filters.required_output_key) {
      values.push(filters.required_output_key);
      where.push(
        `EXISTS (
          SELECT 1
          FROM jsonb_array_elements(sl.output_schema_json) AS item
          WHERE item->>'key' = $${values.length}
        )`
      );
    }

    if (filters.tags_any && filters.tags_any.length > 0) {
      values.push(filters.tags_any);
      where.push(
        `EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(sl.tags_json) AS tag
          WHERE tag = ANY($${values.length}::text[])
        )`
      );
    }

    const listingTextMatchSql =
      searchPatternParamRef === null
        ? "FALSE"
        : `
          (
            sl.title ILIKE $${searchPatternParamRef}
            OR sl.summary ILIKE $${searchPatternParamRef}
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(sl.tags_json) AS tag
              WHERE tag ILIKE $${searchPatternParamRef}
            )
          )
        `;
    const matchedSnapshotCountSql =
      searchPatternParamRef === null
        ? "0"
        : `
          (
            SELECT COUNT(*)::int
            FROM transaction_snapshots ts
            WHERE ts.service_listing_id = sl.id
              AND ts.allow_in_agent_search = TRUE
              AND ts.searchable_text ILIKE $${searchPatternParamRef}
          )
        `;
    const snapshotPreviewFilterSql =
      searchPatternParamRef === null ? "" : `AND ts.searchable_text ILIKE $${searchPatternParamRef}`;

    const result = await query(
      `
        SELECT sl.id, sl.provider_agent_id, sl.title, sl.summary, sl.category, sl.price_min, sl.price_max,
               sl.currency_code, sl.delivery_eta_minutes, sl.status, sl.created_at, sl.updated_at,
               sl.execution_scope_json, sl.tags_json, sl.input_schema_json, sl.output_schema_json,
               COALESCE(slm.review_score_avg, 0) AS review_score_avg,
               COALESCE(slm.review_count, 0) AS review_count,
               COALESCE(slm.accept_latency_p50_seconds, 0) AS accept_latency_p50_seconds,
               COALESCE(slm.delivery_latency_p50_seconds, 0) AS delivery_latency_p50_seconds,
               COALESCE(slm.dispute_rate, 0) AS dispute_rate,
               COALESCE(slm.accept_close_rate, 0) AS accept_close_rate,
               COALESCE(slm.on_time_delivery_rate, 0) AS on_time_delivery_rate,
               COALESCE(slm.revision_rate, 0) AS revision_rate,
               COALESCE(slm.verified_case_count, 0) AS verified_case_count,
               COALESCE(slm.public_case_count, 0) AS public_case_count,
               COALESCE(arp.accept_mode, 'owner_confirm_required') AS accept_mode,
               COALESCE(arp.claimed_max_concurrency, 1) AS claimed_max_concurrency,
               COALESCE(arp.validated_max_concurrency, 1) AS validated_max_concurrency,
               COALESCE(arp.queue_enabled, TRUE) AS queue_enabled,
               COALESCE(arp.current_active_order_count, 0) AS current_active_order_count,
               COALESCE(arp.supports_parallel_delivery, FALSE) AS supports_parallel_delivery,
               COALESCE(arp.supports_a2a, FALSE) AS supports_a2a,
               arp.a2a_agent_card_url,
               arp.provider_callback_url,
               COALESCE(arp.callback_timeout_seconds, 30) AS callback_timeout_seconds,
               COALESCE(arp.runtime_kind, 'generic') AS runtime_kind,
               arp.runtime_label,
               COALESCE(arp.automation_mode, 'manual') AS automation_mode,
               COALESCE(arp.automation_source, 'none') AS automation_source,
               COALESCE(arp.runtime_health_status, 'unknown') AS runtime_health_status,
               COALESCE(arp.heartbeat_ttl_seconds, 180) AS heartbeat_ttl_seconds,
               arp.last_heartbeat_at,
               arp.heartbeat_expires_at,
               COALESCE(arp.relay_connection_status, 'disconnected') AS relay_connection_status,
               arp.relay_session_id,
               arp.relay_connected_at,
               arp.relay_last_activity_at,
               arp.relay_lease_expires_at,
               arp.relay_last_disconnect_reason,
               COALESCE(arp.runtime_capabilities_json, '{}'::jsonb) AS runtime_capabilities_json,
               COALESCE(arp.runtime_authorization_json, '{}'::jsonb) AS runtime_authorization_json,
               COALESCE(arp.notify_target_json, '{}'::jsonb) AS notify_target_json,
               prp.provider_agent_id AS provider_reputation_provider_agent_id,
               COALESCE(prp.completed_order_count, 0) AS provider_reputation_completed_order_count,
               COALESCE(prp.disputed_order_count, 0) AS provider_reputation_disputed_order_count,
               COALESCE(prp.positive_review_count, 0) AS provider_reputation_positive_review_count,
               COALESCE(prp.neutral_review_count, 0) AS provider_reputation_neutral_review_count,
               COALESCE(prp.negative_review_count, 0) AS provider_reputation_negative_review_count,
               COALESCE(prp.accept_close_count, 0) AS provider_reputation_accept_close_count,
               COALESCE(prp.revision_requested_count, 0) AS provider_reputation_revision_requested_count,
               COALESCE(prp.dispute_open_count, 0) AS provider_reputation_dispute_open_count,
               COALESCE(prp.on_time_delivery_rate, 0) AS provider_reputation_on_time_delivery_rate,
               COALESCE(prp.accept_close_rate, 0) AS provider_reputation_accept_close_rate,
               COALESCE(prp.revision_rate, 0) AS provider_reputation_revision_rate,
               COALESCE(prp.dispute_rate, 0) AS provider_reputation_dispute_rate,
               COALESCE(prp.agent_search_case_count, 0) AS provider_reputation_agent_search_case_count,
               COALESCE(prp.public_case_count, 0) AS provider_reputation_public_case_count,
               COALESCE(prp.objective_delivery_score, 0) AS provider_reputation_objective_delivery_score,
               COALESCE(prp.reliability_confidence, 0) AS provider_reputation_reliability_confidence,
               COALESCE(prp.evidence_backed_positive_rate, 0) AS provider_reputation_evidence_backed_positive_rate,
               COALESCE(prp.input_insufficient_rate, 0) AS provider_reputation_input_insufficient_rate,
               COALESCE(prp.median_accept_latency_seconds, 0) AS provider_reputation_median_accept_latency_seconds,
               COALESCE(prp.median_delivery_latency_seconds, 0) AS provider_reputation_median_delivery_latency_seconds,
               prp.last_completed_order_at AS provider_reputation_last_completed_order_at,
               ${listingTextMatchSql} AS ranking_listing_text_match,
               ${matchedSnapshotCountSql} AS ranking_matched_snapshot_count,
               (
                 SELECT COALESCE(
                   jsonb_agg(
                     jsonb_build_object(
                       'order_id', ts.order_id,
                       'snapshot_title', ts.snapshot_title,
                       'snapshot_summary', ts.snapshot_summary,
                       'review_band', ts.review_band,
                       'completion_outcome', ts.completion_outcome,
                       'agreed_amount', ts.agreed_amount,
                       'currency_code', ts.currency_code,
                       'buyer_input_artifact_count', ts.buyer_input_artifact_count,
                       'provider_output_artifact_count', ts.provider_output_artifact_count,
                       'input_keys', ts.input_keys_json,
                       'output_keys', ts.output_keys_json,
                       'provider_tags', ts.provider_tags_json,
                       'visibility_scope', ts.effective_visibility_scope,
                       'public_case_preview', ts.allow_in_public_showcase,
                       'completed_at', ts.completed_at
                     )
                     ORDER BY ts.completed_at DESC NULLS LAST, ts.created_at DESC
                   ),
                   '[]'::jsonb
                 )
                 FROM (
                   SELECT *
                   FROM transaction_snapshots ts
                   WHERE ts.service_listing_id = sl.id
                     AND ts.allow_in_agent_search = TRUE
                     ${snapshotPreviewFilterSql}
                   ORDER BY ts.completed_at DESC NULLS LAST, ts.created_at DESC
                   LIMIT 2
                 ) ts
               ) AS matched_snapshot_previews,
               (
                 SELECT COUNT(*)::int
                 FROM orders o
                 WHERE o.provider_agent_id = sl.provider_agent_id
                   AND o.status = 'queued_for_provider'
               ) AS current_queue_depth
        FROM service_listings sl
        LEFT JOIN service_listing_metrics slm ON slm.service_listing_id = sl.id
        LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = sl.provider_agent_id
        LEFT JOIN provider_reputation_profiles prp ON prp.provider_agent_id = sl.provider_agent_id
        WHERE ${where.join(" AND ")}
        ORDER BY sl.created_at DESC, sl.id DESC
      `,
      values
    );

    const decoratedItems = result.rows
      .map((row) => {
        const decorated = decorateBuyerFacingListing(row as Record<string, unknown>) as Record<string, unknown>;
        const providerReputationProfile = buildProviderReputationSummary(decorated);
        const rankingSignals = buildRankingSignals(decorated, filters);
        return {
          ...decorated,
          matched_snapshot_previews: Array.isArray(row.matched_snapshot_previews)
            ? row.matched_snapshot_previews
            : [],
          ranking_signals: rankingSignals,
          match_reasons: buildMatchReasons(decorated, providerReputationProfile, rankingSignals),
          provider_reputation_profile: providerReputationProfile
        };
      })
      .filter((item) => {
        if (!filters.accept_mode) {
          return true;
        }

        return (item as Record<string, unknown>).accept_mode === filters.accept_mode;
      })
      .sort((left, right) => {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const leftSignals = leftRecord.ranking_signals as CatalogRankingSignals | undefined;
        const rightSignals = rightRecord.ranking_signals as CatalogRankingSignals | undefined;
        const byTotalScore = (rightSignals?.total_score ?? 0) - (leftSignals?.total_score ?? 0);
        if (byTotalScore !== 0) {
          return byTotalScore;
        }

        const leftProfile = leftRecord.provider_reputation_profile as ReturnType<typeof buildProviderReputationSummary>;
        const rightProfile = rightRecord.provider_reputation_profile as ReturnType<typeof buildProviderReputationSummary>;
        const byReliability =
          (rightProfile?.objective_delivery_score ?? 0) - (leftProfile?.objective_delivery_score ?? 0);
        if (byReliability !== 0) {
          return byReliability;
        }

        const byReview = toNumeric(rightRecord.review_score_avg, 0) - toNumeric(leftRecord.review_score_avg, 0);
        if (byReview !== 0) {
          return byReview;
        }

        const rightCreatedAt = Date.parse(String(rightRecord.created_at ?? ''));
        const leftCreatedAt = Date.parse(String(leftRecord.created_at ?? ''));
        return (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0) - (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0);
      });

    const pagedItems = decoratedItems.slice(offset, offset + filters.limit + 1);
    const hasMore = pagedItems.length > filters.limit;
    const items = hasMore ? pagedItems.slice(0, filters.limit) : pagedItems;

    return {
      items,
      next_cursor: hasMore ? encodeCursor(offset + filters.limit) : null
    };
  });

  app.get("/api/v1/public/showcase/listings", async (request) => {
    const filters = showcaseQuerySchema.parse(request.query);
    const values: unknown[] = ["active"];
    const where: string[] = ["sl.status = $1"];

    if (filters.q) {
      values.push(`%${filters.q}%`);
      where.push(`(sl.title ILIKE $${values.length} OR sl.summary ILIKE $${values.length})`);
    }

    if (filters.category) {
      values.push(filters.category);
      where.push(`sl.category = $${values.length}`);
    }

    values.push(filters.limit);

    const result = await query(
      `
        SELECT sl.id,
               sl.title,
               sl.summary,
               sl.category,
               sl.price_min,
               sl.price_max,
               sl.currency_code,
               sl.delivery_eta_minutes,
               sl.case_examples_json,
               sl.tags_json,
               sl.created_at,
               aa.agent_name AS provider_agent_name,
               aa.slug AS provider_agent_slug,
               COALESCE(slm.review_score_avg, 0) AS review_score_avg,
               COALESCE(slm.review_count, 0) AS review_count,
               COALESCE(slm.accept_latency_p50_seconds, 0) AS accept_latency_p50_seconds,
               COALESCE(slm.delivery_latency_p50_seconds, 0) AS delivery_latency_p50_seconds,
               COALESCE(arp.accept_mode, 'owner_confirm_required') AS accept_mode,
               COALESCE(arp.claimed_max_concurrency, 1) AS claimed_max_concurrency,
               COALESCE(arp.validated_max_concurrency, 1) AS validated_max_concurrency,
               COALESCE(arp.queue_enabled, TRUE) AS queue_enabled,
               COALESCE(arp.current_active_order_count, 0) AS current_active_order_count,
               COALESCE(arp.supports_parallel_delivery, FALSE) AS supports_parallel_delivery,
               COALESCE(arp.supports_a2a, FALSE) AS supports_a2a,
               arp.a2a_agent_card_url,
               arp.provider_callback_url,
               COALESCE(arp.callback_timeout_seconds, 30) AS callback_timeout_seconds,
               COALESCE(arp.runtime_kind, 'generic') AS runtime_kind,
               arp.runtime_label,
               COALESCE(arp.automation_mode, 'manual') AS automation_mode,
               COALESCE(arp.automation_source, 'none') AS automation_source,
               COALESCE(arp.runtime_health_status, 'unknown') AS runtime_health_status,
               COALESCE(arp.heartbeat_ttl_seconds, 180) AS heartbeat_ttl_seconds,
               arp.last_heartbeat_at,
               arp.heartbeat_expires_at,
               COALESCE(arp.relay_connection_status, 'disconnected') AS relay_connection_status,
               arp.relay_session_id,
               arp.relay_connected_at,
               arp.relay_last_activity_at,
               arp.relay_lease_expires_at,
               arp.relay_last_disconnect_reason,
               COALESCE(arp.runtime_capabilities_json, '{}'::jsonb) AS runtime_capabilities_json,
               COALESCE(arp.runtime_authorization_json, '{}'::jsonb) AS runtime_authorization_json,
               COALESCE(arp.notify_target_json, '{}'::jsonb) AS notify_target_json,
               (
                 SELECT COUNT(*)::int
                 FROM orders o
                 WHERE o.provider_agent_id = sl.provider_agent_id
                   AND o.status = 'queued_for_provider'
               ) AS current_queue_depth
        FROM service_listings sl
        JOIN agent_accounts aa ON aa.id = sl.provider_agent_id
        LEFT JOIN service_listing_metrics slm ON slm.service_listing_id = sl.id
        LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = sl.provider_agent_id
        WHERE ${where.join(" AND ")}
        ORDER BY slm.review_score_avg DESC NULLS LAST, sl.created_at DESC
        LIMIT $${values.length}
      `,
      values
    );

    return {
      items: result.rows.map((row) => decorateBuyerFacingListing(row))
    };
  });

  app.get("/api/v1/agent/catalog/listings/:listingId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = listingParamsSchema.parse(request.params);

    const result = await query(
      `
        ${listingProjection}
        WHERE sl.id = $1
        LIMIT 1
      `,
      [params.listingId]
    );

    const listing = result.rows[0];
    if (!listing) {
      reply.code(404).send({ error: "listing_not_found" });
      return;
    }

    if (listing.status !== "active") {
      reply.code(409).send({ error: "listing_not_active" });
      return;
    }

    const [verifiedCasePreviews, providerReputationProfile] = await Promise.all([
      loadAgentSearchCasePreviews({ query }, params.listingId, 3),
      loadProviderReputationProfile({ query }, String(listing.provider_agent_id))
    ]);

    return {
      ...decorateBuyerFacingListing(listing),
      verified_case_previews: verifiedCasePreviews,
      provider_reputation_profile:
        providerReputationProfile ?? buildProviderReputationSummary(listing as Record<string, unknown>)
    };
  });

  app.post("/api/v1/agent/catalog/quote-preview", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = quotePreviewSchema.parse(request.body);

    const result = await query(
      `
        SELECT sl.id, sl.title, sl.provider_agent_id, sl.price_min, sl.price_max,
               sl.delivery_eta_minutes, sl.output_schema_json, sl.service_packages_json,
               sl.execution_scope_json, sl.status,
               COALESCE(slm.review_score_avg, 0) AS review_score_avg,
               COALESCE(slm.review_count, 0) AS review_count,
               COALESCE(slm.accept_latency_p50_seconds, 0) AS accept_latency_p50_seconds,
               COALESCE(slm.delivery_latency_p50_seconds, 0) AS delivery_latency_p50_seconds,
               COALESCE(arp.accept_mode, 'owner_confirm_required') AS accept_mode,
               COALESCE(arp.claimed_max_concurrency, 1) AS claimed_max_concurrency,
               COALESCE(arp.validated_max_concurrency, 1) AS validated_max_concurrency,
               COALESCE(arp.queue_enabled, TRUE) AS queue_enabled,
               COALESCE(arp.current_active_order_count, 0) AS current_active_order_count,
               COALESCE(arp.supports_parallel_delivery, FALSE) AS supports_parallel_delivery,
               COALESCE(arp.supports_a2a, FALSE) AS supports_a2a,
               arp.a2a_agent_card_url,
               arp.provider_callback_url,
               COALESCE(arp.callback_timeout_seconds, 30) AS callback_timeout_seconds,
               COALESCE(arp.runtime_kind, 'generic') AS runtime_kind,
               arp.runtime_label,
               COALESCE(arp.automation_mode, 'manual') AS automation_mode,
               COALESCE(arp.automation_source, 'none') AS automation_source,
               COALESCE(arp.runtime_health_status, 'unknown') AS runtime_health_status,
               COALESCE(arp.heartbeat_ttl_seconds, 180) AS heartbeat_ttl_seconds,
               arp.last_heartbeat_at,
               arp.heartbeat_expires_at,
               COALESCE(arp.relay_connection_status, 'disconnected') AS relay_connection_status,
               arp.relay_session_id,
               arp.relay_connected_at,
               arp.relay_last_activity_at,
               arp.relay_lease_expires_at,
               arp.relay_last_disconnect_reason,
               COALESCE(arp.runtime_capabilities_json, '{}'::jsonb) AS runtime_capabilities_json,
               COALESCE(arp.runtime_authorization_json, '{}'::jsonb) AS runtime_authorization_json,
               COALESCE(arp.notify_target_json, '{}'::jsonb) AS notify_target_json,
               (
                 SELECT COUNT(*)::int
                 FROM orders o
                 WHERE o.provider_agent_id = sl.provider_agent_id
                   AND o.status = 'queued_for_provider'
               ) AS current_queue_depth
        FROM service_listings sl
        LEFT JOIN service_listing_metrics slm ON slm.service_listing_id = sl.id
        LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = sl.provider_agent_id
        WHERE sl.id = $1
        LIMIT 1
      `,
      [body.listing_id]
    );

    const listing = result.rows[0];
    if (!listing) {
      reply.code(404).send({ error: "listing_not_found" });
      return;
    }

    if (listing.provider_agent_id === agent.id) {
      reply.code(409).send({ error: "buyer_cannot_order_own_listing" });
      return;
    }

    const resolvedListing = decorateBuyerFacingListing(listing as Record<string, unknown>) as Record<
      string,
      unknown
    >;

    if (resolvedListing.status !== "active") {
      reply.code(409).send({ error: "listing_not_active" });
      return;
    }

    const packages = Array.isArray(resolvedListing.service_packages_json)
      ? (resolvedListing.service_packages_json as Array<{ name?: string; price?: number }>)
      : [];
    const matchedPackage =
      packages.find((item: { name?: string; price?: number }) => item?.name === body.package_name) ?? packages[0];

    const quotedAmount = Number(matchedPackage?.price ?? resolvedListing.price_min);
    const confirmationSnapshotPreview = buildBudgetConfirmationSnapshot({
      source_kind: "listing",
      buyer_agent_id: agent.id,
      provider_agent_id: String(resolvedListing.provider_agent_id),
      quoted_amount: quotedAmount,
      budget_confirmation: {
        approved_by_owner:
          body.purchase_authorization_context?.authorization_basis ===
          "standing_bounded_authorization",
        budget: body.budget,
        note: null
      },
      listing_id: String(resolvedListing.id),
      package_name: body.package_name ?? matchedPackage?.name ?? null,
      input_summary: body.input_payload,
      expected_outputs: (resolvedListing.output_schema_json as unknown[]) ?? [],
      purchase_plan_context: body.purchase_plan_context ?? null,
      purchase_authorization_context: body.purchase_authorization_context ?? null
    });
    const merchantCommitment =
      confirmationSnapshotPreview.merchant_commitment as Record<string, unknown>;
    const authorizationPolicy =
      confirmationSnapshotPreview.authorization_policy as Record<string, unknown>;
    const riskSignals = confirmationSnapshotPreview.risk_signals as Record<string, unknown>;
    const authorizationScope =
      confirmationSnapshotPreview.authorization_scope as Record<string, unknown>;
    const buyerAuthorizationPreview = buildBuyerAuthorizationSummary(
      confirmationSnapshotPreview
    );

    return {
      listing_id: resolvedListing.id,
      provider_agent_id: resolvedListing.provider_agent_id,
      title: resolvedListing.title,
      quoted_amount: quotedAmount,
      budget: body.budget,
      budget_fit: body.budget >= quotedAmount,
      selected_package: matchedPackage ?? null,
      delivery_eta_minutes: resolvedListing.delivery_eta_minutes,
      expected_outputs: resolvedListing.output_schema_json,
      review_score_avg: Number(resolvedListing.review_score_avg),
      review_count: Number(resolvedListing.review_count),
      accept_latency_p50_seconds: Number(resolvedListing.accept_latency_p50_seconds),
      delivery_latency_p50_seconds: Number(resolvedListing.delivery_latency_p50_seconds),
      accept_mode: resolvedListing.accept_mode,
      configured_accept_mode: resolvedListing.configured_accept_mode,
      auto_accept_ready: resolvedListing.auto_accept_ready,
      auto_accept_blockers: resolvedListing.auto_accept_blockers,
      accept_mode_reason: resolvedListing.accept_mode_reason,
      validated_max_concurrency: resolvedListing.validated_max_concurrency,
      current_active_order_count: resolvedListing.current_active_order_count,
      current_queue_depth: resolvedListing.current_queue_depth,
      supports_a2a: resolvedListing.supports_a2a,
      quote_digest: merchantCommitment.quote_digest ?? null,
      merchant_commitment_hash: merchantCommitment.merchant_commitment_hash ?? null,
      authorization_preview: {
        mode: authorizationPolicy.mode ?? "bounded_checkout_human_present",
        scope_kind: authorizationScope.scope_kind ?? "exact_quote",
        confirmation_basis:
          buyerAuthorizationPreview?.confirmation_basis ?? "per_order_owner_confirmation",
        within_cap_checkout_behavior:
          authorizationPolicy.within_cap_checkout_behavior ?? "create_order_without_reconfirm",
        over_cap_checkout_behavior:
          authorizationPolicy.over_cap_checkout_behavior ?? "step_up_required",
        external_payment_behavior:
          authorizationPolicy.external_payment_behavior ?? "step_up_required",
        budget_fit: riskSignals.budget_fit === true,
        requires_owner_confirmation:
          buyerAuthorizationPreview?.ready_for_order_creation === true ? false : true,
        authorization_expires_at:
          buyerAuthorizationPreview?.authorization_expires_at ?? null,
        credential_provider_mode:
          buyerAuthorizationPreview?.credential_provider_mode ?? "platform_internal",
        ready_for_order_creation:
          buyerAuthorizationPreview?.ready_for_order_creation === true,
        step_up_required: riskSignals.step_up_required === true,
        step_up_reason_codes: Array.isArray(riskSignals.step_up_reason_codes)
          ? riskSignals.step_up_reason_codes
          : []
      },
      execution_scope_preview: resolvedListing.execution_scope_json,
      buyer_authorization_preview: buyerAuthorizationPreview,
      budget_confirmation_snapshot_preview: confirmationSnapshotPreview,
      input_echo: body.input_payload,
      generated_for_agent_id: agent.id
    };
  });
}
