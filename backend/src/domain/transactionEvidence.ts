import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { extractLatestBuyerContextPack, type BuyerContextPack } from "./buyerContextPacks.js";
import {
  computeObjectiveDeliveryScore,
  computeReliabilityConfidence
} from "./reliabilityRanking.js";

type Queryable = {
  query: <T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<QueryResult<T>>;
};

type VisibilityScope =
  | "private_audit_only"
  | "platform_index_only"
  | "agent_search_preview"
  | "public_verified_case";

type VisibilityGrantRow = {
  actor_role: "buyer_agent" | "provider_agent";
  allow_platform_index: boolean;
  allow_agent_search_preview: boolean;
  allow_public_case_preview: boolean;
  note: string;
  granted_by_agent_id: string;
  created_at: string;
  updated_at: string;
};

type OrderEventRow = {
  event_type?: string;
  payload_json?: unknown;
};

type DeliveryArtifactRow = {
  id: string;
  artifact_role: string;
  artifact_type: string;
  status: string;
  summary_text: string;
};

type TransactionSnapshotOrderRow = {
  id: string;
  service_listing_id: string | null;
  buyer_agent_id: string;
  provider_agent_id: string;
  final_amount: number;
  currency_code: string;
  input_payload_json: unknown;
  expected_output_schema_json: unknown;
  status: string;
  accepted_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  placed_at: string;
  listing_title: string | null;
  listing_summary: string | null;
  category: string | null;
  tags_json: unknown;
  delivery_eta_minutes: number | null;
};

type ReviewRow = {
  id: string;
  review_band: "positive" | "neutral" | "negative";
  settlement_action: "accept_close" | "request_revision" | "open_dispute";
  commentary: string;
  evidence_json: unknown;
};

type SnapshotVisibilitySummary = {
  effective_visibility_scope: VisibilityScope;
  allow_in_agent_search: boolean;
  allow_in_public_showcase: boolean;
  buyer_grant: VisibilityGrantRow | null;
  provider_grant: VisibilityGrantRow | null;
};

export const transactionVisibilityGrantableStatuses = new Set([
  "delivered",
  "revision_requested",
  "completed",
  "disputed"
]);

type VisibilityGrantInput = {
  orderId: string;
  grantedByAgentId: string;
  actorRole: "buyer_agent" | "provider_agent";
  allowPlatformIndex: boolean;
  allowAgentSearchPreview: boolean;
  allowPublicCasePreview: boolean;
  note?: string;
};

type ProviderReputationProfileRow = {
  provider_agent_id: string;
  completed_order_count: number;
  disputed_order_count: number;
  positive_review_count: number;
  neutral_review_count: number;
  negative_review_count: number;
  accept_close_count: number;
  revision_requested_count: number;
  dispute_open_count: number;
  on_time_delivery_rate: number;
  accept_close_rate: number;
  revision_rate: number;
  dispute_rate: number;
  agent_search_case_count: number;
  public_case_count: number;
  objective_delivery_score: number;
  reliability_confidence: number;
  evidence_backed_positive_rate: number;
  input_insufficient_rate: number;
  median_accept_latency_seconds: number;
  median_delivery_latency_seconds: number;
  last_completed_order_at: string | null;
  last_refreshed_at: string;
  created_at: string;
  updated_at: string;
};

type TransactionSnapshotPreviewRow = {
  order_id: string;
  snapshot_title: string;
  snapshot_summary: string;
  review_band: string;
  completion_outcome: string;
  agreed_amount: number;
  currency_code: string;
  buyer_input_artifact_count: number;
  provider_output_artifact_count: number;
  input_keys_json: unknown;
  output_keys_json: unknown;
  provider_tags_json: unknown;
  effective_visibility_scope: VisibilityScope;
  allow_in_public_showcase: boolean;
  completed_at: string | null;
};

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function toFloat(value: unknown, fallback = 0) {
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

function toInt(value: unknown, fallback = 0) {
  const parsed = toFloat(value, fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeProviderReputationProfile(row: ProviderReputationProfileRow): ProviderReputationProfileRow {
  return {
    ...row,
    completed_order_count: toInt(row.completed_order_count),
    disputed_order_count: toInt(row.disputed_order_count),
    positive_review_count: toInt(row.positive_review_count),
    neutral_review_count: toInt(row.neutral_review_count),
    negative_review_count: toInt(row.negative_review_count),
    accept_close_count: toInt(row.accept_close_count),
    revision_requested_count: toInt(row.revision_requested_count),
    dispute_open_count: toInt(row.dispute_open_count),
    on_time_delivery_rate: toFloat(row.on_time_delivery_rate),
    accept_close_rate: toFloat(row.accept_close_rate),
    revision_rate: toFloat(row.revision_rate),
    dispute_rate: toFloat(row.dispute_rate),
    agent_search_case_count: toInt(row.agent_search_case_count),
    public_case_count: toInt(row.public_case_count),
    objective_delivery_score: toFloat(row.objective_delivery_score),
    reliability_confidence: toFloat(row.reliability_confidence),
    evidence_backed_positive_rate: toFloat(row.evidence_backed_positive_rate),
    input_insufficient_rate: toFloat(row.input_insufficient_rate),
    median_accept_latency_seconds: toInt(row.median_accept_latency_seconds),
    median_delivery_latency_seconds: toInt(row.median_delivery_latency_seconds)
  };
}

function extractSchemaKeys(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueStrings(
    value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const candidate = (item as Record<string, unknown>).key;
      return typeof candidate === "string" ? [candidate] : [];
    })
  );
}

function collectTextFragments(value: unknown, bucket: string[], depth = 0) {
  if (depth > 3 || bucket.length >= 32) {
    return;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      bucket.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, bucket, depth + 1);
      if (bucket.length >= 32) {
        break;
      }
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      bucket.push(key);
      collectTextFragments(nested, bucket, depth + 1);
      if (bucket.length >= 32) {
        break;
      }
    }
  }
}

function buildSnapshotTitle(params: {
  listingTitle: string;
  buyerContextSummary: string;
  outputKeys: string[];
}) {
  const buyerContextLead = params.buyerContextSummary.split(/[。.!?\n]/)[0]?.trim();
  if (buyerContextLead && buyerContextLead.length > 0) {
    return `${params.listingTitle} · ${buyerContextLead.slice(0, 80)}`;
  }

  if (params.outputKeys.length > 0) {
    return `${params.listingTitle} · ${params.outputKeys.slice(0, 3).join(", ")}`;
  }

  return params.listingTitle;
}

function buildSnapshotSummary(params: {
  buyerContextSummary: string;
  outputKeys: string[];
  reviewBand: string;
  commentary: string;
}) {
  const parts = [
    params.buyerContextSummary,
    params.outputKeys.length > 0 ? `outputs: ${params.outputKeys.join(", ")}` : null,
    params.commentary,
    `review: ${params.reviewBand}`
  ];

  return parts
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(" | ")
    .slice(0, 1200);
}

function deriveVisibilitySummary(grants: VisibilityGrantRow[]): SnapshotVisibilitySummary {
  const buyerGrant = grants.find((item) => item.actor_role === "buyer_agent") ?? null;
  const providerGrant = grants.find((item) => item.actor_role === "provider_agent") ?? null;

  const allowPlatformIndex =
    buyerGrant?.allow_platform_index === true && providerGrant?.allow_platform_index === true;
  const allowAgentSearchPreview =
    allowPlatformIndex &&
    buyerGrant?.allow_agent_search_preview === true &&
    providerGrant?.allow_agent_search_preview === true;
  const allowPublicCasePreview =
    allowAgentSearchPreview &&
    buyerGrant?.allow_public_case_preview === true &&
    providerGrant?.allow_public_case_preview === true;

  const effectiveVisibilityScope: VisibilityScope = allowPublicCasePreview
    ? "public_verified_case"
    : allowAgentSearchPreview
      ? "agent_search_preview"
      : allowPlatformIndex
        ? "platform_index_only"
        : "private_audit_only";

  return {
    effective_visibility_scope: effectiveVisibilityScope,
    allow_in_agent_search: allowAgentSearchPreview,
    allow_in_public_showcase: allowPublicCasePreview,
    buyer_grant: buyerGrant,
    provider_grant: providerGrant
  };
}

export function buildOrderTransactionVisibility(
  summary: SnapshotVisibilitySummary,
  orderStatus: string
) {
  const grantable = transactionVisibilityGrantableStatuses.has(orderStatus);
  const pendingActorRoles = grantable
    ? ([
        summary.buyer_grant ? null : "buyer_agent",
        summary.provider_grant ? null : "provider_agent"
      ].filter((item): item is "buyer_agent" | "provider_agent" => item !== null))
    : [];

  const nextRequiredActor: "none" | "buyer_agent" | "provider_agent" | "both" =
    pendingActorRoles.length === 0
      ? "none"
      : pendingActorRoles.length === 2
        ? "both"
        : pendingActorRoles[0];

  return {
    ...summary,
    grantable,
    buyer_grant_pending: pendingActorRoles.includes("buyer_agent"),
    provider_grant_pending: pendingActorRoles.includes("provider_agent"),
    pending_actor_roles: pendingActorRoles,
    next_required_actor: nextRequiredActor
  };
}

async function loadVisibilityGrants(client: Queryable, orderId: string) {
  const result = await client.query<VisibilityGrantRow>(
    `
      SELECT actor_role,
             allow_platform_index,
             allow_agent_search_preview,
             allow_public_case_preview,
             note,
             granted_by_agent_id,
             created_at,
             updated_at
      FROM transaction_snapshot_visibility_grants
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  );

  return result.rows;
}

export async function refreshTransactionSnapshotVisibility(
  client: PoolClient,
  orderId: string
): Promise<SnapshotVisibilitySummary> {
  const grants = await loadVisibilityGrants(client, orderId);
  const summary = deriveVisibilitySummary(grants);

  await client.query(
    `
      UPDATE transaction_snapshots
      SET effective_visibility_scope = $2,
          allow_in_agent_search = $3,
          allow_in_public_showcase = $4,
          visibility_refreshed_at = NOW(),
          updated_at = NOW()
      WHERE order_id = $1
    `,
    [
      orderId,
      summary.effective_visibility_scope,
      summary.allow_in_agent_search,
      summary.allow_in_public_showcase
    ]
  );

  return summary;
}

export async function upsertTransactionSnapshotVisibilityGrant(
  client: PoolClient,
  input: VisibilityGrantInput
): Promise<SnapshotVisibilitySummary> {
  await client.query(
    `
      INSERT INTO transaction_snapshot_visibility_grants (
        order_id,
        granted_by_agent_id,
        actor_role,
        allow_platform_index,
        allow_agent_search_preview,
        allow_public_case_preview,
        note
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (order_id, actor_role)
      DO UPDATE SET
        granted_by_agent_id = EXCLUDED.granted_by_agent_id,
        allow_platform_index = EXCLUDED.allow_platform_index,
        allow_agent_search_preview = EXCLUDED.allow_agent_search_preview,
        allow_public_case_preview = EXCLUDED.allow_public_case_preview,
        note = EXCLUDED.note,
        updated_at = NOW()
    `,
    [
      input.orderId,
      input.grantedByAgentId,
      input.actorRole,
      input.allowPlatformIndex,
      input.allowAgentSearchPreview,
      input.allowPublicCasePreview,
      input.note?.trim() ?? ""
    ]
  );

  return refreshTransactionSnapshotVisibility(client, input.orderId);
}

export async function getTransactionSnapshotVisibilitySummary(
  client: Queryable,
  orderId: string
): Promise<SnapshotVisibilitySummary> {
  const grants = await loadVisibilityGrants(client, orderId);
  const derived = deriveVisibilitySummary(grants);
  const snapshotResult = await client.query<{
    effective_visibility_scope: VisibilityScope;
    allow_in_agent_search: boolean;
    allow_in_public_showcase: boolean;
  }>(
    `
      SELECT effective_visibility_scope, allow_in_agent_search, allow_in_public_showcase
      FROM transaction_snapshots
      WHERE order_id = $1
      LIMIT 1
    `,
    [orderId]
  );

  const snapshot = snapshotResult.rows[0];
  if (!snapshot) {
    return derived;
  }

  return {
    ...derived,
    effective_visibility_scope: snapshot.effective_visibility_scope,
    allow_in_agent_search: snapshot.allow_in_agent_search,
    allow_in_public_showcase: snapshot.allow_in_public_showcase
  };
}

export async function getOrderTransactionVisibility(
  client: Queryable,
  orderId: string,
  orderStatus: string
) {
  const summary = await getTransactionSnapshotVisibilitySummary(client, orderId);
  return buildOrderTransactionVisibility(summary, orderStatus);
}

function buildSearchableText(params: {
  category: string;
  listingTitle: string;
  listingSummary: string;
  buyerContextSummary: string;
  outputKeys: string[];
  providerTags: string[];
  reviewCommentary: string;
  evidenceKeywords: string[];
}) {
  return uniqueStrings([
    params.category,
    params.listingTitle,
    params.listingSummary,
    params.buyerContextSummary,
    ...params.outputKeys,
    ...params.providerTags,
    params.reviewCommentary,
    ...params.evidenceKeywords
  ]).join(" ");
}

function asBuyerContextPack(events: OrderEventRow[]): BuyerContextPack | null {
  return extractLatestBuyerContextPack(events);
}

export async function upsertTransactionSnapshotForOrder(client: PoolClient, orderId: string) {
  const orderResult = await client.query<TransactionSnapshotOrderRow>(
    `
      SELECT o.id,
             o.service_listing_id,
             o.buyer_agent_id,
             o.provider_agent_id,
             o.final_amount,
             o.currency_code,
             o.input_payload_json,
             o.expected_output_schema_json,
             o.status,
             o.accepted_at,
             o.delivered_at,
             o.completed_at,
             o.placed_at,
             sl.title AS listing_title,
             sl.summary AS listing_summary,
             sl.category,
             sl.tags_json,
             sl.delivery_eta_minutes
      FROM orders o
      LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
      WHERE o.id = $1
      LIMIT 1
    `,
    [orderId]
  );

  const order = orderResult.rows[0];
  if (!order || !order.service_listing_id || !order.listing_title || !order.category) {
    return null;
  }

  if (!["completed", "disputed"].includes(order.status)) {
    return null;
  }

  const reviewResult = await client.query<ReviewRow>(
    `
      SELECT id, review_band, settlement_action, commentary, evidence_json
      FROM reviews
      WHERE order_id = $1
      LIMIT 1
    `,
    [orderId]
  );
  const eventsResult = await client.query<OrderEventRow>(
    `
      SELECT event_type, payload_json
      FROM order_events
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  );
  const artifactsResult = await client.query<DeliveryArtifactRow>(
    `
      SELECT id, artifact_role, artifact_type, status, summary_text
      FROM delivery_artifacts
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  );
  const reviewSnapshotResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM review_snapshots
      WHERE order_id = $1
      ORDER BY review_version DESC, created_at DESC
      LIMIT 1
    `,
    [orderId]
  );

  const review = reviewResult.rows[0];
  if (!review) {
    return null;
  }
  const latestReviewSnapshotId = reviewSnapshotResult.rows[0]?.id ?? null;

  const buyerContextPack = asBuyerContextPack(eventsResult.rows);
  const buyerContextSummary = buyerContextPack?.share_summary?.trim() ?? "";
  const buyerArtifacts = artifactsResult.rows.filter(
    (item) => item.artifact_role === "buyer_input" && ["submitted", "accepted"].includes(item.status)
  );
  const providerOutputs = artifactsResult.rows.filter(
    (item) => item.artifact_role === "provider_output" && ["submitted", "accepted"].includes(item.status)
  );
  const outputKeys = extractSchemaKeys(order.expected_output_schema_json);
  const inputKeys = uniqueStrings([
    ...Object.keys(
      order.input_payload_json && typeof order.input_payload_json === "object" && !Array.isArray(order.input_payload_json)
        ? (order.input_payload_json as Record<string, unknown>)
        : {}
    ),
    ...extractSchemaKeys(order.input_payload_json)
  ]);
  const providerTags = normalizeStringArray(order.tags_json);
  const evidenceKeywordsBucket: string[] = [];
  collectTextFragments(review.evidence_json, evidenceKeywordsBucket);
  const evidenceKeywords = uniqueStrings(evidenceKeywordsBucket).slice(0, 16);
  const snapshotTitle = buildSnapshotTitle({
    listingTitle: order.listing_title,
    buyerContextSummary,
    outputKeys
  });
  const snapshotSummary = buildSnapshotSummary({
    buyerContextSummary,
    outputKeys,
    reviewBand: review.review_band,
    commentary: review.commentary
  });

  const deliveryLatencySeconds =
    order.accepted_at && order.delivered_at
      ? Math.max(
          0,
          Math.round(
            (new Date(order.delivered_at).getTime() - new Date(order.accepted_at).getTime()) / 1000
          )
        )
      : 0;

  const searchableText = buildSearchableText({
    category: order.category,
    listingTitle: order.listing_title,
    listingSummary: order.listing_summary ?? "",
    buyerContextSummary,
    outputKeys,
    providerTags,
    reviewCommentary: review.commentary,
    evidenceKeywords
  });

  await client.query(
    `
      INSERT INTO transaction_snapshots (
        order_id,
        service_listing_id,
        buyer_agent_id,
        provider_agent_id,
        review_id,
        review_snapshot_id,
        category,
        review_band,
        settlement_action,
        completion_outcome,
        agreed_amount,
        currency_code,
        listing_title,
        listing_summary,
        snapshot_title,
        snapshot_summary,
        searchable_text,
        provider_tags_json,
        input_keys_json,
        output_keys_json,
        provider_output_types_json,
        buyer_context_summary,
        buyer_context_has_artifacts,
        buyer_context_has_external_links,
        buyer_input_artifact_count,
        provider_output_artifact_count,
        review_commentary,
        evidence_keywords_json,
        delivery_eta_minutes,
        delivery_latency_seconds,
        delivered_at,
        completed_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, $25, $26,
        $27, $28::jsonb, $29, $30, $31, $32, NOW()
      )
      ON CONFLICT (order_id)
      DO UPDATE SET
        service_listing_id = EXCLUDED.service_listing_id,
        buyer_agent_id = EXCLUDED.buyer_agent_id,
        provider_agent_id = EXCLUDED.provider_agent_id,
        review_id = EXCLUDED.review_id,
        review_snapshot_id = EXCLUDED.review_snapshot_id,
        category = EXCLUDED.category,
        review_band = EXCLUDED.review_band,
        settlement_action = EXCLUDED.settlement_action,
        completion_outcome = EXCLUDED.completion_outcome,
        agreed_amount = EXCLUDED.agreed_amount,
        currency_code = EXCLUDED.currency_code,
        listing_title = EXCLUDED.listing_title,
        listing_summary = EXCLUDED.listing_summary,
        snapshot_title = EXCLUDED.snapshot_title,
        snapshot_summary = EXCLUDED.snapshot_summary,
        searchable_text = EXCLUDED.searchable_text,
        provider_tags_json = EXCLUDED.provider_tags_json,
        input_keys_json = EXCLUDED.input_keys_json,
        output_keys_json = EXCLUDED.output_keys_json,
        provider_output_types_json = EXCLUDED.provider_output_types_json,
        buyer_context_summary = EXCLUDED.buyer_context_summary,
        buyer_context_has_artifacts = EXCLUDED.buyer_context_has_artifacts,
        buyer_context_has_external_links = EXCLUDED.buyer_context_has_external_links,
        buyer_input_artifact_count = EXCLUDED.buyer_input_artifact_count,
        provider_output_artifact_count = EXCLUDED.provider_output_artifact_count,
        review_commentary = EXCLUDED.review_commentary,
        evidence_keywords_json = EXCLUDED.evidence_keywords_json,
        delivery_eta_minutes = EXCLUDED.delivery_eta_minutes,
        delivery_latency_seconds = EXCLUDED.delivery_latency_seconds,
        delivered_at = EXCLUDED.delivered_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = NOW()
    `,
    [
      order.id,
      order.service_listing_id,
      order.buyer_agent_id,
      order.provider_agent_id,
      review.id,
      latestReviewSnapshotId,
      order.category,
      review.review_band,
      review.settlement_action,
      order.status,
      order.final_amount,
      order.currency_code,
      order.listing_title,
      order.listing_summary ?? "",
      snapshotTitle,
      snapshotSummary,
      searchableText,
      JSON.stringify(providerTags),
      JSON.stringify(inputKeys),
      JSON.stringify(outputKeys),
      JSON.stringify(uniqueStrings(providerOutputs.map((item) => item.artifact_type))),
      buyerContextSummary,
      buyerContextPack?.artifact_ids?.length ? true : false,
      buyerContextPack?.external_context_links?.length ? true : false,
      buyerArtifacts.length,
      providerOutputs.length,
      review.commentary,
      JSON.stringify(evidenceKeywords),
      order.delivery_eta_minutes ?? 0,
      deliveryLatencySeconds,
      order.delivered_at,
      order.completed_at ?? order.delivered_at
    ]
  );

  return refreshTransactionSnapshotVisibility(client, order.id);
}

export async function refreshProviderReputationProfile(client: PoolClient, providerAgentId: string) {
  await client.query(
    `
      INSERT INTO provider_reputation_profiles (provider_agent_id)
      VALUES ($1)
      ON CONFLICT (provider_agent_id) DO NOTHING
    `,
    [providerAgentId]
  );

  const aggregateResult = await client.query<{
    completed_order_count: number;
    disputed_order_count: number;
    positive_review_count: number;
    neutral_review_count: number;
    negative_review_count: number;
    accept_close_count: number;
    dispute_open_count: number;
    on_time_delivery_rate: number;
    accept_close_rate: number;
    dispute_rate: number;
    median_accept_latency_seconds: number;
    median_delivery_latency_seconds: number;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed_order_count,
        COUNT(*) FILTER (WHERE o.status = 'disputed')::int AS disputed_order_count,
        COUNT(r.id) FILTER (WHERE r.review_band = 'positive')::int AS positive_review_count,
        COUNT(r.id) FILTER (WHERE r.review_band = 'neutral')::int AS neutral_review_count,
        COUNT(r.id) FILTER (WHERE r.review_band = 'negative')::int AS negative_review_count,
        COUNT(r.id) FILTER (WHERE r.settlement_action = 'accept_close')::int AS accept_close_count,
        COUNT(r.id) FILTER (WHERE r.settlement_action = 'open_dispute')::int AS dispute_open_count,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN o.delivered_at IS NOT NULL
                     AND o.accepted_at IS NOT NULL
                     AND sl.delivery_eta_minutes IS NOT NULL
                     AND EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at)) <= sl.delivery_eta_minutes * 60
                  THEN 1.0
                WHEN o.delivered_at IS NOT NULL
                     AND o.accepted_at IS NOT NULL
                     AND sl.delivery_eta_minutes IS NOT NULL
                  THEN 0.0
                ELSE NULL
              END
            )::numeric,
            4
          ),
          0
        )::float8 AS on_time_delivery_rate,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN r.id IS NULL THEN NULL
                WHEN r.settlement_action = 'accept_close' THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::float8 AS accept_close_rate,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN r.id IS NULL THEN NULL
                WHEN r.settlement_action = 'open_dispute' THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::float8 AS dispute_rate,
        COALESCE(
          ROUND(
            (
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (o.accepted_at - o.placed_at))
              )
              FILTER (WHERE o.accepted_at IS NOT NULL)
            )::numeric,
            0
          ),
          0
        )::int AS median_accept_latency_seconds,
        COALESCE(
          ROUND(
            (
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at))
              )
              FILTER (WHERE o.accepted_at IS NOT NULL AND o.delivered_at IS NOT NULL)
            )::numeric,
            0
          ),
          0
        )::int AS median_delivery_latency_seconds
      FROM orders o
      LEFT JOIN reviews r ON r.order_id = o.id
      LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
      WHERE o.provider_agent_id = $1
    `,
    [providerAgentId]
  );

  const revisionResult = await client.query<{ revision_requested_count: number; revision_rate: number }>(
    `
      SELECT
        COUNT(DISTINCT oe.order_id)::int AS revision_requested_count,
        COALESCE(
          ROUND(
            (
              COUNT(DISTINCT oe.order_id)::numeric
              / NULLIF(COUNT(DISTINCT o.id), 0)
            ),
            4
          ),
          0
        )::float8 AS revision_rate
      FROM orders o
      LEFT JOIN order_events oe
        ON oe.order_id = o.id
       AND oe.event_type = 'revision_requested'
      WHERE o.provider_agent_id = $1
        AND o.status IN ('completed', 'disputed')
    `,
    [providerAgentId]
  );

  const caseResult = await client.query<{
    agent_search_case_count: number;
    public_case_count: number;
    last_completed_order_at: string | null;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE allow_in_agent_search)::int AS agent_search_case_count,
        COUNT(*) FILTER (WHERE allow_in_public_showcase)::int AS public_case_count,
        MAX(completed_at) AS last_completed_order_at
      FROM transaction_snapshots
      WHERE provider_agent_id = $1
    `,
    [providerAgentId]
  );

  const evidenceResult = await client.query<{
    evidence_backed_positive_rate: number;
    input_insufficient_rate: number;
  }>(
    `
      SELECT
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN ts.review_band = 'positive' THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::float8 AS evidence_backed_positive_rate,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN rs.structured_assessment_json->>'input_completeness' = 'insufficient' THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::float8 AS input_insufficient_rate
      FROM transaction_snapshots ts
      LEFT JOIN review_snapshots rs ON rs.id = ts.review_snapshot_id
      WHERE ts.provider_agent_id = $1
    `,
    [providerAgentId]
  );

  const aggregate = aggregateResult.rows[0];
  const revision = revisionResult.rows[0];
  const cases = caseResult.rows[0];
  const evidence = evidenceResult.rows[0];
  const completedOrderCount = aggregate?.completed_order_count ?? 0;
  const reliabilityConfidence = computeReliabilityConfidence(completedOrderCount);
  const objectiveDeliveryScore = computeObjectiveDeliveryScore({
    completed_order_count: completedOrderCount,
    on_time_delivery_rate: aggregate?.on_time_delivery_rate ?? 0,
    accept_close_rate: aggregate?.accept_close_rate ?? 0,
    revision_rate: revision?.revision_rate ?? 0,
    dispute_rate: aggregate?.dispute_rate ?? 0,
    evidence_backed_positive_rate: evidence?.evidence_backed_positive_rate ?? 0,
    input_insufficient_rate: evidence?.input_insufficient_rate ?? 0
  });

  await client.query(
    `
      UPDATE provider_reputation_profiles
      SET completed_order_count = $2,
          disputed_order_count = $3,
          positive_review_count = $4,
          neutral_review_count = $5,
          negative_review_count = $6,
          accept_close_count = $7,
          revision_requested_count = $8,
          dispute_open_count = $9,
          on_time_delivery_rate = $10,
          accept_close_rate = $11,
          revision_rate = $12,
          dispute_rate = $13,
          agent_search_case_count = $14,
          public_case_count = $15,
          objective_delivery_score = $16,
          reliability_confidence = $17,
          evidence_backed_positive_rate = $18,
          input_insufficient_rate = $19,
          median_accept_latency_seconds = $20,
          median_delivery_latency_seconds = $21,
          last_completed_order_at = $22,
          last_refreshed_at = NOW(),
          updated_at = NOW()
      WHERE provider_agent_id = $1
    `,
    [
      providerAgentId,
      completedOrderCount,
      aggregate?.disputed_order_count ?? 0,
      aggregate?.positive_review_count ?? 0,
      aggregate?.neutral_review_count ?? 0,
      aggregate?.negative_review_count ?? 0,
      aggregate?.accept_close_count ?? 0,
      revision?.revision_requested_count ?? 0,
      aggregate?.dispute_open_count ?? 0,
      aggregate?.on_time_delivery_rate ?? 0,
      aggregate?.accept_close_rate ?? 0,
      revision?.revision_rate ?? 0,
      aggregate?.dispute_rate ?? 0,
      cases?.agent_search_case_count ?? 0,
      cases?.public_case_count ?? 0,
      objectiveDeliveryScore,
      reliabilityConfidence,
      evidence?.evidence_backed_positive_rate ?? 0,
      evidence?.input_insufficient_rate ?? 0,
      aggregate?.median_accept_latency_seconds ?? 0,
      aggregate?.median_delivery_latency_seconds ?? 0,
      cases?.last_completed_order_at ?? null
    ]
  );
}

export async function loadProviderReputationProfile(client: Queryable, providerAgentId: string) {
  const result = await client.query<ProviderReputationProfileRow>(
    `
      SELECT *
      FROM provider_reputation_profiles
      WHERE provider_agent_id = $1
      LIMIT 1
    `,
    [providerAgentId]
  );

  return result.rows[0] ? normalizeProviderReputationProfile(result.rows[0]) : null;
}

export async function loadAgentSearchCasePreviews(
  client: Queryable,
  listingId: string,
  limit: number
) {
  const result = await client.query<TransactionSnapshotPreviewRow>(
    `
      SELECT order_id,
             snapshot_title,
             snapshot_summary,
             review_band,
             completion_outcome,
             agreed_amount,
             currency_code,
             buyer_input_artifact_count,
             provider_output_artifact_count,
             input_keys_json,
             output_keys_json,
             provider_tags_json,
             effective_visibility_scope,
             allow_in_public_showcase,
             completed_at
      FROM transaction_snapshots
      WHERE service_listing_id = $1
        AND allow_in_agent_search = TRUE
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT $2
    `,
    [listingId, limit]
  );

  return result.rows.map((row) => ({
    order_id: row.order_id,
    snapshot_title: row.snapshot_title,
    snapshot_summary: row.snapshot_summary,
    review_band: row.review_band,
    completion_outcome: row.completion_outcome,
    agreed_amount: row.agreed_amount,
    currency_code: row.currency_code,
    buyer_input_artifact_count: row.buyer_input_artifact_count,
    provider_output_artifact_count: row.provider_output_artifact_count,
    input_keys: normalizeStringArray(row.input_keys_json),
    output_keys: normalizeStringArray(row.output_keys_json),
    provider_tags: normalizeStringArray(row.provider_tags_json),
    visibility_scope: row.effective_visibility_scope,
    public_case_preview: row.allow_in_public_showcase,
    completed_at: row.completed_at
  }));
}
