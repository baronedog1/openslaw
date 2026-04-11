import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";
import {
  buyerContextPackHasMissingStructuredMaterials,
  extractLatestBuyerContextPack,
  normalizeBuyerContextPack,
  type BuyerContextPack
} from "./buyerContextPacks.js";
import { serializeDeliveryArtifact, type DeliveryArtifactRow } from "./deliveryArtifacts.js";
import { buildBuyerAuthorizationSummary } from "./orderLifecycle.js";
import { decorateOrderWithTurnSummary } from "./orderTurns.js";
import { reviewBands, settlementActions, type ReviewBand, type SettlementAction } from "./reviews.js";

export const reviewStructuredAssessmentSchema = z.object({
  goal_alignment: z.enum(["meets", "partially_meets", "misses"]),
  input_completeness: z.enum(["sufficient", "partially_sufficient", "insufficient"]),
  delivery_completeness: z.enum(["complete", "partial", "incomplete"]),
  usability: z.enum(["ready_to_use", "needs_minor_follow_up", "not_ready"]),
  revision_recommended: z.boolean().default(false),
  notes: z.string().default("")
});

export type ReviewStructuredAssessment = z.infer<typeof reviewStructuredAssessmentSchema>;

type Queryable = {
  query: <T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<QueryResult<T>>;
};

type ReviewSnapshotOrderRow = {
  id: string;
  order_no: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  service_listing_id: string | null;
  demand_post_id: string | null;
  demand_proposal_id: string | null;
  source_kind: string;
  quoted_amount: number;
  final_amount: number;
  currency_code: string;
  input_payload_json: unknown;
  expected_output_schema_json: unknown;
  budget_confirmation_snapshot_json: unknown;
  execution_scope_snapshot_json: unknown;
  status: string;
  escrow_status: string;
  placed_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
  listing_title: string | null;
  demand_title: string | null;
};

type ReviewSnapshotEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: unknown;
  created_at: string;
};

type PersistedReviewRow = {
  id: string;
  order_id: string;
  reviewer_agent_id: string;
  provider_agent_id: string;
  review_band: ReviewBand;
  settlement_action: SettlementAction;
  commentary: string;
  evidence_json: unknown;
};

type ReviewSnapshotRow = {
  id: string;
  order_id: string;
  review_event_id: string;
  review_id: string | null;
  review_version: number;
  order_status_at_review: string;
  reviewer_agent_id: string;
  provider_agent_id: string;
  review_band: ReviewBand;
  settlement_action: SettlementAction;
  commentary: string;
  structured_assessment_json: unknown;
  review_evidence_json: unknown;
  order_snapshot_json: unknown;
  buyer_context_pack_json: unknown;
  buyer_input_artifacts_json: unknown;
  provider_delivery_json: unknown;
  superseded_provider_deliveries_json: unknown;
  evidence_refs_json: unknown;
  transaction_visibility_json: unknown;
  created_at: string;
  updated_at: string;
};

type ReviewEventPayload = {
  review_band: ReviewBand;
  settlement_action: SettlementAction;
  commentary: string;
  evidence: Record<string, unknown>;
  structured_assessment: ReviewStructuredAssessment | null;
};

type DeliveryEventPayload = {
  delivery_summary: string;
  artifacts: Array<{
    type: string;
    delivery_mode?: string;
    url?: string;
    content?: Record<string, unknown>;
    summary?: string;
    platform_artifact_id?: string;
  }>;
};

const reviewEventTypes = new Set(["review_submitted", "review_auto_closed"]);
const visibleBuyerArtifactStatuses = new Set(["submitted", "accepted"]);
const reviewEventPayloadSchema = z.object({
  review_band: z.enum(reviewBands),
  settlement_action: z.enum(settlementActions),
  commentary: z.string().default(""),
  evidence: z.record(z.any()).default({}),
  evidence_json: z.record(z.any()).optional(),
  structured_assessment: reviewStructuredAssessmentSchema.optional()
});
const deliveryEventPayloadSchema = z.object({
  delivery_summary: z.string().default(""),
  artifacts: z
    .array(
      z.object({
        type: z.string(),
        delivery_mode: z.string().optional(),
        url: z.string().optional(),
        content: z.record(z.any()).optional(),
        summary: z.string().optional(),
        platform_artifact_id: z.string().uuid().optional()
      })
    )
    .default([])
});

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseReviewEventPayload(
  payload: unknown,
  persistedReview: PersistedReviewRow | null,
  isLatestEvent: boolean
): ReviewEventPayload | null {
  const parsed = reviewEventPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return {
      review_band: parsed.data.review_band,
      settlement_action: parsed.data.settlement_action,
      commentary: parsed.data.commentary,
      evidence: parsed.data.evidence_json ?? parsed.data.evidence,
      structured_assessment: parsed.data.structured_assessment ?? null
    };
  }

  const raw = toRecord(payload);
  const reviewBand = raw.review_band;
  const settlementAction = raw.settlement_action;
  if (
    !reviewBands.includes(reviewBand as ReviewBand) ||
    !settlementActions.includes(settlementAction as SettlementAction)
  ) {
    if (!persistedReview || !isLatestEvent) {
      return null;
    }

    return {
      review_band: persistedReview.review_band,
      settlement_action: persistedReview.settlement_action,
      commentary: persistedReview.commentary,
      evidence: toRecord(persistedReview.evidence_json),
      structured_assessment: null
    };
  }

  return {
    review_band: reviewBand as ReviewBand,
    settlement_action: settlementAction as SettlementAction,
    commentary:
      typeof raw.commentary === "string"
        ? raw.commentary
        : isLatestEvent && persistedReview
          ? persistedReview.commentary
          : "",
    evidence:
      typeof raw.evidence === "object" && raw.evidence && !Array.isArray(raw.evidence)
        ? (raw.evidence as Record<string, unknown>)
        : isLatestEvent && persistedReview
          ? toRecord(persistedReview.evidence_json)
          : {},
    structured_assessment: reviewStructuredAssessmentSchema.safeParse(raw.structured_assessment).success
      ? reviewStructuredAssessmentSchema.parse(raw.structured_assessment)
      : null
  };
}

function parseDeliveryEventPayload(payload: unknown): DeliveryEventPayload {
  const parsed = deliveryEventPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const raw = toRecord(payload);
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.filter((item): item is DeliveryEventPayload["artifacts"][number] => {
        return item && typeof item === "object" && !Array.isArray(item);
      })
    : [];

  return {
    delivery_summary: typeof raw.delivery_summary === "string" ? raw.delivery_summary : "",
    artifacts
  };
}

function buildDefaultStructuredAssessment(params: {
  reviewBand: ReviewBand;
  settlementAction: SettlementAction;
  buyerContextPack: BuyerContextPack | null;
  buyerInputArtifacts: DeliveryArtifactRow[];
  currentDeliveryArtifactCount: number;
}) {
  const inputCompleteness = !params.buyerContextPack
    ? "insufficient"
    : buyerContextPackHasMissingStructuredMaterials(params.buyerContextPack)
      ? "insufficient"
      : params.buyerContextPack.withheld_items.length > 0 ||
          (params.buyerContextPack.artifact_ids.length === 0 &&
            params.buyerContextPack.external_context_links.length === 0)
        ? "partially_sufficient"
        : params.buyerInputArtifacts.length > 0 || params.buyerContextPack.external_context_links.length > 0
          ? "sufficient"
          : "partially_sufficient";

  if (params.reviewBand === "positive") {
    return {
      goal_alignment: "meets",
      input_completeness: inputCompleteness === "insufficient" ? "partially_sufficient" : inputCompleteness,
      delivery_completeness: "complete",
      usability: "ready_to_use",
      revision_recommended: false,
      notes: ""
    } satisfies ReviewStructuredAssessment;
  }

  if (params.reviewBand === "neutral") {
    return {
      goal_alignment: "partially_meets",
      input_completeness: inputCompleteness,
      delivery_completeness: params.currentDeliveryArtifactCount > 0 ? "partial" : "incomplete",
      usability: "needs_minor_follow_up",
      revision_recommended: false,
      notes: ""
    } satisfies ReviewStructuredAssessment;
  }

  return {
    goal_alignment: params.settlementAction === "accept_close" ? "partially_meets" : "misses",
    input_completeness: inputCompleteness,
    delivery_completeness:
      params.settlementAction === "accept_close"
        ? params.currentDeliveryArtifactCount > 0
          ? "partial"
          : "incomplete"
        : "incomplete",
    usability: params.settlementAction === "accept_close" ? "needs_minor_follow_up" : "not_ready",
    revision_recommended: params.settlementAction === "request_revision",
    notes: ""
  } satisfies ReviewStructuredAssessment;
}

function inferOrderStatusAtReview(settlementAction: SettlementAction) {
  if (settlementAction === "request_revision") {
    return "revision_requested";
  }

  if (settlementAction === "open_dispute") {
    return "disputed";
  }

  return "completed";
}

function resolveBuyerInputArtifacts(
  artifacts: DeliveryArtifactRow[],
  buyerContextPack: BuyerContextPack | null,
  reviewCreatedAt: string
) {
  const eligible = artifacts.filter(
    (artifact) =>
      artifact.artifact_role === "buyer_input" &&
      visibleBuyerArtifactStatuses.has(artifact.status) &&
      new Date(artifact.created_at).getTime() <= new Date(reviewCreatedAt).getTime()
  );

  if (!buyerContextPack) {
    return eligible;
  }

  if (buyerContextPack.artifact_ids.length === 0) {
    return eligible;
  }

  const selected = new Set(buyerContextPack.artifact_ids);
  return eligible.filter((artifact) => selected.has(artifact.id));
}

function buildDeliverySnapshotFromEvent(params: {
  event: ReviewSnapshotEventRow;
  artifactMap: Map<string, DeliveryArtifactRow>;
}) {
  const payload = parseDeliveryEventPayload(params.event.payload_json);
  const artifacts = payload.artifacts.map((artifact) => {
    const mappedArtifact = artifact.platform_artifact_id
      ? params.artifactMap.get(artifact.platform_artifact_id) ?? null
      : null;

    return {
      type: artifact.type,
      delivery_mode: artifact.delivery_mode ?? (artifact.platform_artifact_id ? "platform_managed" : "provider_managed"),
      summary: artifact.summary ?? "",
      url: artifact.url ?? null,
      content: artifact.content ?? {},
      platform_artifact_id: artifact.platform_artifact_id ?? null,
      artifact_ref: mappedArtifact ? serializeDeliveryArtifact(mappedArtifact) : null
    };
  });

  return {
    event_id: params.event.id,
    submitted_at: params.event.created_at,
    delivery_summary: payload.delivery_summary,
    artifacts
  };
}

function buildOrderSnapshot(params: {
  order: ReviewSnapshotOrderRow;
  orderStatusAtReview: string;
  reviewVersion: number;
}) {
  const {
    listing_title: _listingTitle,
    demand_title: _demandTitle,
    ...orderPayloadBase
  } = params.order as ReviewSnapshotOrderRow & Record<string, unknown>;

  const decorated = decorateOrderWithTurnSummary({
    ...orderPayloadBase,
    status: params.orderStatusAtReview
  });

  return {
    order: decorated,
    listing_title: params.order.listing_title,
    demand_title: params.order.demand_title,
    buyer_authorization: buildBuyerAuthorizationSummary(params.order.budget_confirmation_snapshot_json),
    review_version: params.reviewVersion,
    captured_order_status: params.orderStatusAtReview
  };
}

export type ReviewSnapshotPayload = {
  id: string;
  order_id: string;
  review_event_id: string;
  review_id: string | null;
  review_version: number;
  order_status_at_review: string;
  reviewer_agent_id: string;
  provider_agent_id: string;
  review_band: ReviewBand;
  settlement_action: SettlementAction;
  commentary: string;
  structured_assessment: ReviewStructuredAssessment;
  review_evidence: Record<string, unknown>;
  order_snapshot: Record<string, unknown>;
  buyer_context_pack: Record<string, unknown>;
  buyer_input_artifacts: unknown[];
  provider_delivery: Record<string, unknown>;
  superseded_provider_deliveries: unknown[];
  evidence_refs: Record<string, unknown>;
  transaction_visibility: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function loadReviewSnapshots(client: Queryable, orderId: string): Promise<ReviewSnapshotPayload[]> {
  const result = await client.query<ReviewSnapshotRow>(
    `
      SELECT *
      FROM review_snapshots
      WHERE order_id = $1
      ORDER BY review_version ASC, created_at ASC
    `,
    [orderId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    order_id: row.order_id,
    review_event_id: row.review_event_id,
    review_id: row.review_id,
    review_version: row.review_version,
    order_status_at_review: row.order_status_at_review,
    reviewer_agent_id: row.reviewer_agent_id,
    provider_agent_id: row.provider_agent_id,
    review_band: row.review_band,
    settlement_action: row.settlement_action,
    commentary: row.commentary,
    structured_assessment: reviewStructuredAssessmentSchema.parse(row.structured_assessment_json),
    review_evidence: toRecord(row.review_evidence_json),
    order_snapshot: toRecord(row.order_snapshot_json),
    buyer_context_pack: toRecord(row.buyer_context_pack_json),
    buyer_input_artifacts: Array.isArray(row.buyer_input_artifacts_json)
      ? row.buyer_input_artifacts_json
      : [],
    provider_delivery: toRecord(row.provider_delivery_json),
    superseded_provider_deliveries: Array.isArray(row.superseded_provider_deliveries_json)
      ? row.superseded_provider_deliveries_json
      : [],
    evidence_refs: toRecord(row.evidence_refs_json),
    transaction_visibility: toRecord(row.transaction_visibility_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

export async function loadLatestReviewSnapshot(client: Queryable, orderId: string) {
  const snapshots = await loadReviewSnapshots(client, orderId);
  return snapshots[snapshots.length - 1] ?? null;
}

export async function upsertReviewSnapshotsForOrder(
  client: PoolClient,
  params: {
    orderId: string;
    transactionVisibility?: Record<string, unknown> | null;
  }
) {
  const orderResult = await client.query<ReviewSnapshotOrderRow>(
    `
      SELECT o.*, sl.title AS listing_title, dp.title AS demand_title
      FROM orders o
      LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
      LEFT JOIN demand_posts dp ON dp.id = o.demand_post_id
      WHERE o.id = $1
      LIMIT 1
    `,
    [params.orderId]
  );
  const eventsResult = await client.query<ReviewSnapshotEventRow>(
    `
      SELECT id, event_type, actor_type, actor_id, payload_json, created_at
      FROM order_events
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [params.orderId]
  );
  const artifactsResult = await client.query<DeliveryArtifactRow>(
    `
      SELECT *
      FROM delivery_artifacts
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [params.orderId]
  );
  const persistedReviewResult = await client.query<PersistedReviewRow>(
    `
      SELECT id, order_id, reviewer_agent_id, provider_agent_id, review_band, settlement_action, commentary, evidence_json
      FROM reviews
      WHERE order_id = $1
      LIMIT 1
    `,
    [params.orderId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    return [];
  }

  const events = eventsResult.rows;
  const artifacts = artifactsResult.rows;
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const persistedReview = persistedReviewResult.rows[0] ?? null;
  const reviewEvents = events.filter((event) => reviewEventTypes.has(event.event_type));

  if (reviewEvents.length === 0) {
    await client.query(`DELETE FROM review_snapshots WHERE order_id = $1`, [params.orderId]);
    return [];
  }

  for (const [index, reviewEvent] of reviewEvents.entries()) {
    const isLatestEvent = index === reviewEvents.length - 1;
    const parsedReview = parseReviewEventPayload(reviewEvent.payload_json, persistedReview, isLatestEvent);
    if (!parsedReview) {
      continue;
    }

    const eventsBeforeReview = events.filter(
      (event) => new Date(event.created_at).getTime() <= new Date(reviewEvent.created_at).getTime()
    );
    const deliveryEventsBeforeReview = eventsBeforeReview.filter(
      (event) => event.event_type === "delivery_submitted"
    );
    const latestDeliveryEvent = deliveryEventsBeforeReview[deliveryEventsBeforeReview.length - 1] ?? null;
    const supersededDeliveryEvents = latestDeliveryEvent
      ? deliveryEventsBeforeReview.slice(0, -1)
      : deliveryEventsBeforeReview;
    const buyerContextEvent = [...eventsBeforeReview]
      .reverse()
      .find((event) => event.event_type === "buyer_context_submitted") ?? null;
    const buyerContextPack = extractLatestBuyerContextPack(eventsBeforeReview);
    const buyerInputArtifacts = resolveBuyerInputArtifacts(artifacts, buyerContextPack, reviewEvent.created_at);
    const providerDelivery = latestDeliveryEvent
      ? buildDeliverySnapshotFromEvent({
          event: latestDeliveryEvent,
          artifactMap
        })
      : {
          event_id: null,
          submitted_at: null,
          delivery_summary: "",
          artifacts: []
        };
    const supersededProviderDeliveries = supersededDeliveryEvents.map((event) =>
      buildDeliverySnapshotFromEvent({
        event,
        artifactMap
      })
    );
    const structuredAssessment =
      parsedReview.structured_assessment ??
      buildDefaultStructuredAssessment({
        reviewBand: parsedReview.review_band,
        settlementAction: parsedReview.settlement_action,
        buyerContextPack,
        buyerInputArtifacts,
        currentDeliveryArtifactCount: Array.isArray(providerDelivery.artifacts)
          ? providerDelivery.artifacts.length
          : 0
      });
    const orderStatusAtReview = inferOrderStatusAtReview(parsedReview.settlement_action);
    const reviewId = isLatestEvent ? persistedReview?.id ?? null : null;

    await client.query(
      `
        INSERT INTO review_snapshots (
          order_id,
          review_event_id,
          review_id,
          review_version,
          order_status_at_review,
          reviewer_agent_id,
          provider_agent_id,
          review_band,
          settlement_action,
          commentary,
          structured_assessment_json,
          review_evidence_json,
          order_snapshot_json,
          buyer_context_pack_json,
          buyer_input_artifacts_json,
          provider_delivery_json,
          superseded_provider_deliveries_json,
          evidence_refs_json,
          transaction_visibility_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
          $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb
        )
        ON CONFLICT (order_id, review_version)
        DO UPDATE SET
          review_event_id = EXCLUDED.review_event_id,
          review_id = EXCLUDED.review_id,
          order_status_at_review = EXCLUDED.order_status_at_review,
          reviewer_agent_id = EXCLUDED.reviewer_agent_id,
          provider_agent_id = EXCLUDED.provider_agent_id,
          review_band = EXCLUDED.review_band,
          settlement_action = EXCLUDED.settlement_action,
          commentary = EXCLUDED.commentary,
          structured_assessment_json = EXCLUDED.structured_assessment_json,
          review_evidence_json = EXCLUDED.review_evidence_json,
          order_snapshot_json = EXCLUDED.order_snapshot_json,
          buyer_context_pack_json = EXCLUDED.buyer_context_pack_json,
          buyer_input_artifacts_json = EXCLUDED.buyer_input_artifacts_json,
          provider_delivery_json = EXCLUDED.provider_delivery_json,
          superseded_provider_deliveries_json = EXCLUDED.superseded_provider_deliveries_json,
          evidence_refs_json = EXCLUDED.evidence_refs_json,
          transaction_visibility_json = EXCLUDED.transaction_visibility_json,
          updated_at = NOW()
      `,
      [
        order.id,
        reviewEvent.id,
        reviewId,
        index + 1,
        orderStatusAtReview,
        persistedReview?.reviewer_agent_id ?? order.buyer_agent_id,
        persistedReview?.provider_agent_id ?? order.provider_agent_id,
        parsedReview.review_band,
        parsedReview.settlement_action,
        parsedReview.commentary,
        JSON.stringify(structuredAssessment),
        JSON.stringify(parsedReview.evidence),
        JSON.stringify(
          buildOrderSnapshot({
            order,
            orderStatusAtReview,
            reviewVersion: index + 1
          })
        ),
        JSON.stringify(buyerContextPack ?? {}),
        JSON.stringify(buyerInputArtifacts.map((artifact) => serializeDeliveryArtifact(artifact))),
        JSON.stringify(providerDelivery),
        JSON.stringify(supersededProviderDeliveries),
        JSON.stringify({
          review_event_id: reviewEvent.id,
          review_event_type: reviewEvent.event_type,
          review_recorded_at: reviewEvent.created_at,
          buyer_context_event_id: buyerContextEvent?.id ?? null,
          buyer_context_recorded_at: buyerContextEvent?.created_at ?? null,
          buyer_input_artifact_ids: buyerInputArtifacts.map((artifact) => artifact.id),
          current_delivery_event_id: latestDeliveryEvent?.id ?? null,
          current_delivery_recorded_at: latestDeliveryEvent?.created_at ?? null,
          superseded_delivery_event_ids: supersededDeliveryEvents.map((event) => event.id)
        }),
        JSON.stringify(params.transactionVisibility ?? {})
      ]
    );
  }

  await client.query(
    `
      DELETE FROM review_snapshots
      WHERE order_id = $1
        AND review_version > $2
    `,
    [params.orderId, reviewEvents.length]
  );

  return loadReviewSnapshots(client, params.orderId);
}
