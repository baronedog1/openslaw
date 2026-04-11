import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { lockRuntimeProfile, maybeAutoAcceptOrder } from "./runtimeProfiles.js";

const DEFAULT_AUTHORIZATION_WINDOW_MINUTES = 30;

export const budgetConfirmationSchema = z.object({
  approved_by_owner: z.literal(true),
  budget: z.number().int().nonnegative(),
  note: z.string().trim().min(1).nullable().optional()
});

export type BudgetConfirmation = {
  approved_by_owner: boolean;
  budget: number;
  note?: string | null;
};

export const purchaseAuthorizationContextSchema = z
  .object({
    authorization_basis: z
      .enum(["per_order_owner_confirmation", "standing_bounded_authorization"])
      .default("per_order_owner_confirmation"),
    owner_confirmation_channel: z
      .enum(["agent_chat", "openclaw_native", "web_mirror"])
      .default("agent_chat"),
    owner_session_ref: z.string().trim().min(1).optional(),
    owner_actor_ref: z.string().trim().min(1).optional(),
    confirmed_at: z.string().datetime({ offset: true }).optional(),
    authorization_expires_at: z.string().datetime({ offset: true }).optional(),
    standing_authorization_ref: z.string().trim().min(1).optional(),
    authorized_quote_digest: z.string().trim().min(1).optional(),
    authorized_merchant_commitment_hash: z.string().trim().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (
      value.authorization_basis === "standing_bounded_authorization" &&
      !value.standing_authorization_ref
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["standing_authorization_ref"],
        message: "standing_authorization_ref is required for standing_bounded_authorization"
      });
    }
  });

export type PurchaseAuthorizationContext = z.infer<typeof purchaseAuthorizationContextSchema>;

export const purchasePlanContextSchema = z
  .object({
    plan_id: z.string().trim().min(1),
    plan_kind: z.enum(["exact_quote", "option_set", "proposal_set", "composed_plan"]).optional(),
    execution_strategy: z
      .enum(["single_order", "bounded_choice", "multi_order_composed"])
      .optional(),
    plan_summary: z.string().trim().min(1).optional(),
    subtask_ref: z.string().trim().min(1).optional(),
    subtask_goal: z.string().trim().min(1).optional(),
    allow_agent_decompose_task: z.boolean().optional(),
    allow_multi_provider_split: z.boolean().optional(),
    allow_agent_select_provider: z.boolean().optional(),
    allow_agent_select_final_option: z.boolean().optional(),
    max_provider_count: z.number().int().positive().optional(),
    per_order_budget_cap: z.number().int().nonnegative().optional(),
    total_budget_cap: z.number().int().nonnegative().optional(),
    remaining_budget_before_order: z.number().int().nonnegative().optional(),
    allowed_option_refs: z.array(z.string().trim().min(1)).optional(),
    allowed_provider_agent_ids: z.array(z.string().uuid()).optional(),
    owner_confirmation_channel: z.enum(["agent_chat", "openclaw_native", "web_mirror"]).optional()
  })
  .strict();

export type PurchasePlanContext = z.infer<typeof purchasePlanContextSchema>;

type SnapshotCandidateOption = {
  option_ref: string;
  provider_agent_id: string;
  listing_id: string | null;
  package_name: string | null;
  demand_post_id: string | null;
  demand_proposal_id: string | null;
  quoted_amount: number;
  currency_code: string;
};

function normalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForDigest(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const normalized = normalizeForDigest((value as Record<string, unknown>)[key]);
        if (normalized !== undefined) {
          accumulator[key] = normalized;
        }
        return accumulator;
      }, {});
  }

  return value;
}

function buildDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForDigest(value)))
    .digest("hex");
}

function buildAuthorizationExpiresAt(confirmedAt: string | null, explicitExpiresAt?: string | null) {
  if (explicitExpiresAt) {
    return explicitExpiresAt;
  }

  const baseTime = confirmedAt ? new Date(confirmedAt) : new Date();
  return new Date(baseTime.getTime() + DEFAULT_AUTHORIZATION_WINDOW_MINUTES * 60 * 1000).toISOString();
}

export function buildBudgetConfirmationSnapshot(params: {
  source_kind: "listing" | "demand_proposal";
  buyer_agent_id: string;
  provider_agent_id: string;
  quoted_amount: number;
  currency_code?: string;
  budget_confirmation: BudgetConfirmation;
  listing_id?: string | null;
  package_name?: string | null;
  demand_post_id?: string | null;
  demand_proposal_id?: string | null;
  input_summary?: unknown;
  expected_outputs?: unknown;
  confirmation_surface?: "quote_preview" | "manual_owner_confirmation" | "standing_bounded_authorization";
  confirmed_at?: string | null;
  owner_session_ref?: string | null;
  scope_kind?: "exact_quote" | "option_set" | "proposal_set";
  allow_agent_select_provider?: boolean;
  allow_agent_select_final_option?: boolean;
  allowed_option_refs?: string[] | null;
  allowed_provider_agent_ids?: string[] | null;
  selected_option_ref?: string | null;
  recommended_option_ref?: string | null;
  candidate_options?: SnapshotCandidateOption[];
  decision_summary?: string | null;
  authorization_expires_at?: string | null;
  purchase_plan_context?: PurchasePlanContext | null;
  purchase_authorization_context?: PurchaseAuthorizationContext | null;
}) {
  const purchasePlanContext = params.purchase_plan_context ?? null;
  const purchaseAuthorizationContext = params.purchase_authorization_context ?? null;
  const currencyCode = params.currency_code ?? "LOBSTER_COIN";
  const selectedOptionRef =
    params.selected_option_ref ??
    (params.source_kind === "listing"
      ? `listing:${params.listing_id ?? "unknown"}:${params.package_name ?? "default"}`
      : `proposal:${params.demand_proposal_id ?? "unknown"}`);
  const candidateOptions =
    params.candidate_options ??
    [
      {
        option_ref: selectedOptionRef,
        provider_agent_id: params.provider_agent_id,
        listing_id: params.listing_id ?? null,
        package_name: params.package_name ?? null,
        demand_post_id: params.demand_post_id ?? null,
        demand_proposal_id: params.demand_proposal_id ?? null,
        quoted_amount: params.quoted_amount,
        currency_code: currencyCode
      }
    ];
  const confirmedAt =
    params.confirmed_at ??
    purchaseAuthorizationContext?.confirmed_at ??
    (params.budget_confirmation.approved_by_owner ? new Date().toISOString() : null);
  const authorizationExpiresAt = buildAuthorizationExpiresAt(
    confirmedAt,
    params.authorization_expires_at ??
      purchaseAuthorizationContext?.authorization_expires_at ??
      null
  );
  const scopeKind =
    params.scope_kind ??
    purchasePlanContext?.plan_kind ??
    "exact_quote";
  const executionStrategy =
    purchasePlanContext?.execution_strategy ??
    (scopeKind === "composed_plan" ? "multi_order_composed" : "single_order");
  const paymentImpactingPayload = {
    source_kind: params.source_kind,
    provider_agent_id: params.provider_agent_id,
    listing_id: params.listing_id ?? null,
    package_name: params.package_name ?? null,
    demand_post_id: params.demand_post_id ?? null,
    demand_proposal_id: params.demand_proposal_id ?? null,
    quoted_amount: params.quoted_amount,
    currency_code: currencyCode,
    input_summary: params.input_summary ?? {},
    expected_outputs: params.expected_outputs ?? []
  };
  const quoteDigest = buildDigest(paymentImpactingPayload);
  const planId = purchasePlanContext?.plan_id ?? `plan_${quoteDigest}`;
  const merchantCommitmentHash = buildDigest({
    quote_digest: quoteDigest,
    candidate_options: candidateOptions,
    selected_option_ref: selectedOptionRef
  });
  const budgetFit = params.budget_confirmation.budget >= params.quoted_amount;
  const authorizationExpired = Boolean(
    authorizationExpiresAt && new Date(authorizationExpiresAt).getTime() <= Date.now()
  );
  const quoteDigestChanged = Boolean(
    purchaseAuthorizationContext?.authorized_quote_digest &&
      purchaseAuthorizationContext.authorized_quote_digest !== quoteDigest
  );
  const merchantCommitmentChanged = Boolean(
    purchaseAuthorizationContext?.authorized_merchant_commitment_hash &&
      purchaseAuthorizationContext.authorized_merchant_commitment_hash !== merchantCommitmentHash
  );
  const confirmationBasis =
    purchaseAuthorizationContext?.authorization_basis ?? "per_order_owner_confirmation";
  const stepUpReasons = [
    !budgetFit ? "price_above_cap" : null,
    quoteDigestChanged ? "quote_digest_change" : null,
    merchantCommitmentChanged ? "merchant_commitment_change" : null,
    authorizationExpired ? "authorization_expired" : null
  ].filter((item): item is string => Boolean(item));

  return {
    schema_version: "budget_confirmation_v2",
    confirmation_surface:
      params.confirmation_surface ??
      (confirmationBasis === "standing_bounded_authorization"
        ? "standing_bounded_authorization"
        : params.budget_confirmation.approved_by_owner
          ? "manual_owner_confirmation"
          : "quote_preview"),
    presence_mode: "human_present",
    agent_purchase_plan: {
      plan_id: planId,
      plan_kind:
        purchasePlanContext?.plan_kind ??
        (params.source_kind === "listing" ? "exact_quote" : "proposal_set"),
      execution_strategy: executionStrategy,
      recommended_option_ref: params.recommended_option_ref ?? selectedOptionRef,
      selected_option_ref: selectedOptionRef,
      decision_summary:
        purchasePlanContext?.plan_summary ??
        params.decision_summary ??
        (params.source_kind === "listing"
          ? "Agent selected a concrete listing quote for owner confirmation."
          : "Agent selected a concrete demand proposal for owner confirmation."),
      subtask_ref: purchasePlanContext?.subtask_ref ?? null,
      subtask_goal: purchasePlanContext?.subtask_goal ?? null,
      candidate_options: candidateOptions
    },
    owner_confirmation: {
      approved_by_owner: params.budget_confirmation.approved_by_owner,
      budget: params.budget_confirmation.budget,
      note: params.budget_confirmation.note ?? null,
      confirmed_at: purchaseAuthorizationContext?.confirmed_at ?? confirmedAt,
      owner_session_ref:
        purchaseAuthorizationContext?.owner_session_ref ?? params.owner_session_ref ?? null,
      owner_actor_ref: purchaseAuthorizationContext?.owner_actor_ref ?? null,
      actor_agent_id: params.buyer_agent_id,
      confirmation_basis: confirmationBasis,
      standing_authorization_ref:
        purchaseAuthorizationContext?.standing_authorization_ref ?? null,
      owner_confirmation_channel:
        purchaseAuthorizationContext?.owner_confirmation_channel ??
        purchasePlanContext?.owner_confirmation_channel ??
        "agent_chat"
    },
    merchant_commitment: {
      quote_digest: quoteDigest,
      merchant_commitment_hash: merchantCommitmentHash,
      payment_impacting_fields_complete: true,
      quoted_amount: params.quoted_amount,
      currency_code: currencyCode
    },
    authorization_scope: {
      scope_kind: scopeKind,
      source_kind: params.source_kind,
      listing_id: params.listing_id ?? null,
      package_name: params.package_name ?? null,
      demand_post_id: params.demand_post_id ?? null,
      demand_proposal_id: params.demand_proposal_id ?? null,
      buyer_agent_id: params.buyer_agent_id,
      provider_agent_id: params.provider_agent_id,
      allowed_option_refs: params.allowed_option_refs ?? candidateOptions.map((item) => item.option_ref),
      allowed_provider_agent_ids:
        params.allowed_provider_agent_ids ??
        purchasePlanContext?.allowed_provider_agent_ids ??
        [params.provider_agent_id],
      allow_agent_select_provider:
        params.allow_agent_select_provider ?? purchasePlanContext?.allow_agent_select_provider ?? false,
      allow_agent_select_final_option:
        params.allow_agent_select_final_option ??
        purchasePlanContext?.allow_agent_select_final_option ??
        false,
      allow_agent_decompose_task: purchasePlanContext?.allow_agent_decompose_task ?? false,
      allow_multi_provider_split: purchasePlanContext?.allow_multi_provider_split ?? false,
      max_provider_count: purchasePlanContext?.max_provider_count ?? 1,
      subtask_ref: purchasePlanContext?.subtask_ref ?? null,
      subtask_goal: purchasePlanContext?.subtask_goal ?? null,
      expected_outputs: params.expected_outputs ?? []
    },
    contract: {
      input_summary: params.input_summary ?? {},
      expected_outputs: params.expected_outputs ?? [],
      authorization_expires_at: authorizationExpiresAt,
      refundability_required: true
    },
    authorization_policy: {
      mode: "bounded_checkout_human_present",
      trigger_kind:
        confirmationBasis === "standing_bounded_authorization"
          ? "standing_bounded_authorization"
          : "manual_owner_confirmation",
      reusable: confirmationBasis === "standing_bounded_authorization",
      max_order_count: 1,
      per_order_budget_cap:
        purchasePlanContext?.per_order_budget_cap ?? params.budget_confirmation.budget,
      total_budget_cap:
        purchasePlanContext?.total_budget_cap ?? params.budget_confirmation.budget,
      within_cap_checkout_behavior:
        executionStrategy === "multi_order_composed"
          ? "agent_may_select_and_create_order"
          : "create_order_without_reconfirm",
      over_cap_checkout_behavior: "step_up_required",
      out_of_scope_checkout_behavior: "step_up_required",
      external_payment_behavior: "step_up_required",
      schedule_rule: null,
      condition_rule: null,
      step_up_required_on: [
        "quote_digest_change",
        "provider_change",
        "package_change",
        "price_above_cap",
        "option_out_of_scope",
        "payment_source_change",
        "external_payment_required",
        "authorization_expired"
      ]
    },
    payment_source_policy: {
      primary_source: "lobster_wallet",
      allow_external_payment: false,
      external_payment_requires_owner_confirmation: true
    },
    credential_provider: {
      mode: "platform_internal",
      external_provider_ref: null
    },
    risk_signals: {
      budget_fit: budgetFit,
      plan_execution_strategy: executionStrategy,
      requires_owner_confirmation: !params.budget_confirmation.approved_by_owner,
      step_up_required: stepUpReasons.length > 0,
      step_up_status: stepUpReasons.length > 0 ? "required" : "not_required",
      step_up_reason_codes: stepUpReasons,
      ready_for_order_creation:
        params.budget_confirmation.approved_by_owner && stepUpReasons.length === 0,
      owner_presence_verified: params.budget_confirmation.approved_by_owner
    }
  };
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function buildBuyerAuthorizationSummary(snapshotValue: unknown) {
  const snapshot = toRecord(snapshotValue);
  if (Object.keys(snapshot).length === 0) {
    return null;
  }

  const ownerConfirmation = toRecord(snapshot.owner_confirmation);
  const merchantCommitment = toRecord(snapshot.merchant_commitment);
  const authorizationScope = toRecord(snapshot.authorization_scope);
  const authorizationPolicy = toRecord(snapshot.authorization_policy);
  const paymentSourcePolicy = toRecord(snapshot.payment_source_policy);
  const credentialProvider = toRecord(snapshot.credential_provider);
  const riskSignals = toRecord(snapshot.risk_signals);

  return {
    schema_version: toNullableString(snapshot.schema_version),
    confirmation_surface: toNullableString(snapshot.confirmation_surface),
    presence_mode: toNullableString(snapshot.presence_mode),
    confirmation_basis:
      toNullableString(ownerConfirmation.confirmation_basis) ?? "per_order_owner_confirmation",
    owner_confirmation_channel:
      toNullableString(ownerConfirmation.owner_confirmation_channel) ?? "agent_chat",
    owner_session_ref: toNullableString(ownerConfirmation.owner_session_ref),
    owner_actor_ref: toNullableString(ownerConfirmation.owner_actor_ref),
    standing_authorization_ref: toNullableString(ownerConfirmation.standing_authorization_ref),
    confirmed_at: toNullableString(ownerConfirmation.confirmed_at),
    authorization_expires_at: toNullableString(
      toRecord(snapshot.contract).authorization_expires_at
    ),
    quote_digest: toNullableString(merchantCommitment.quote_digest),
    merchant_commitment_hash: toNullableString(merchantCommitment.merchant_commitment_hash),
    authorization_scope_kind: toNullableString(authorizationScope.scope_kind),
    within_cap_checkout_behavior:
      toNullableString(authorizationPolicy.within_cap_checkout_behavior) ??
      "create_order_without_reconfirm",
    over_cap_checkout_behavior:
      toNullableString(authorizationPolicy.over_cap_checkout_behavior) ?? "step_up_required",
    external_payment_behavior:
      toNullableString(authorizationPolicy.external_payment_behavior) ?? "step_up_required",
    credential_provider_mode:
      toNullableString(credentialProvider.mode) ?? "platform_internal",
    payment_source: toNullableString(paymentSourcePolicy.primary_source) ?? "lobster_wallet",
    step_up_required: toBoolean(riskSignals.step_up_required),
    step_up_status: toNullableString(riskSignals.step_up_status) ?? "not_required",
    step_up_reason_codes: toStringArray(riskSignals.step_up_reason_codes),
    ready_for_order_creation: toBoolean(riskSignals.ready_for_order_creation),
    owner_presence_verified: toBoolean(riskSignals.owner_presence_verified)
  };
}

export function assertBuyerAuthorizationReadyForCheckout(snapshotValue: unknown) {
  const summary = buildBuyerAuthorizationSummary(snapshotValue);
  if (!summary) {
    throw new Error("owner_authorization_missing");
  }

  if (summary.step_up_required || !summary.ready_for_order_creation) {
    throw Object.assign(new Error("owner_authorization_step_up_required"), {
      step_up_reason_codes: summary.step_up_reason_codes,
      buyer_authorization: summary
    });
  }

  return summary;
}

export async function validatePurchasePlanEnvelope(
  client: PoolClient,
  params: {
    buyerAgentId: string;
    providerAgentId: string;
    selectedOptionRef: string;
    quotedAmount: number;
    purchasePlanContext?: PurchasePlanContext | null;
  }
) {
  const purchasePlanContext = params.purchasePlanContext;
  if (!purchasePlanContext) {
    return;
  }

  if (
    purchasePlanContext.allowed_provider_agent_ids &&
    !purchasePlanContext.allowed_provider_agent_ids.includes(params.providerAgentId)
  ) {
    throw new Error("provider_out_of_authorized_scope");
  }

  if (
    purchasePlanContext.allowed_option_refs &&
    !purchasePlanContext.allowed_option_refs.includes(params.selectedOptionRef)
  ) {
    throw new Error("option_out_of_authorized_scope");
  }

  if (
    purchasePlanContext.per_order_budget_cap !== undefined &&
    params.quotedAmount > purchasePlanContext.per_order_budget_cap
  ) {
    throw new Error("plan_per_order_budget_cap_exceeded");
  }

  if (
    purchasePlanContext.total_budget_cap === undefined &&
    purchasePlanContext.max_provider_count === undefined
  ) {
    return;
  }

  const statsResult = await client.query<{
    committed_amount: string;
    provider_ids: string[] | null;
  }>(
    `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN status IN ('cancelled', 'expired') OR escrow_status = 'refunded' THEN 0
              ELSE quoted_amount
            END
          ),
          0
        )::text AS committed_amount,
        ARRAY_REMOVE(
          ARRAY_AGG(
            DISTINCT CASE
              WHEN status IN ('cancelled', 'expired') OR escrow_status = 'refunded' THEN NULL
              ELSE provider_agent_id
            END
          ),
          NULL
        ) AS provider_ids
      FROM orders
      WHERE buyer_agent_id = $1
        AND budget_confirmation_snapshot_json->'agent_purchase_plan'->>'plan_id' = $2
    `,
    [params.buyerAgentId, purchasePlanContext.plan_id]
  );

  const stats = statsResult.rows[0] ?? { committed_amount: "0", provider_ids: [] };
  const committedAmount = Number(stats.committed_amount ?? "0");
  const providerIds = stats.provider_ids ?? [];

  if (
    purchasePlanContext.total_budget_cap !== undefined &&
    committedAmount + params.quotedAmount > purchasePlanContext.total_budget_cap
  ) {
    throw new Error("plan_total_budget_cap_exceeded");
  }

  if (
    purchasePlanContext.max_provider_count !== undefined &&
    !providerIds.includes(params.providerAgentId) &&
    providerIds.length + 1 > purchasePlanContext.max_provider_count
  ) {
    throw new Error("plan_provider_limit_exceeded");
  }
}

export async function upsertOrderTransportSession(
  client: PoolClient,
  params: {
    orderId: string;
    providerAgentId: string;
    remoteStatus: string;
  }
) {
  const profile = await lockRuntimeProfile(client, params.providerAgentId);
  const transportKind =
    profile.supports_a2a && profile.a2a_agent_card_url ? "a2a" : "platform_rest";
  const remoteEndpoint =
    transportKind === "a2a"
      ? profile.a2a_agent_card_url
      : profile.runtime_kind === "openclaw"
        ? `openslaw-runtime-relay://${params.providerAgentId}`
        : null;

  await client.query(
    `
      INSERT INTO order_transport_sessions (
        order_id,
        transport_kind,
        remote_endpoint,
        remote_status,
        last_transport_event_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (order_id)
      DO UPDATE SET
        transport_kind = EXCLUDED.transport_kind,
        remote_endpoint = EXCLUDED.remote_endpoint,
        remote_status = EXCLUDED.remote_status,
        last_transport_event_at = NOW(),
        updated_at = NOW()
    `,
    [
      params.orderId,
      transportKind,
      remoteEndpoint,
      params.remoteStatus
    ]
  );
}

export async function updateOrderTransportSessionStatus(
  client: PoolClient,
  orderId: string,
  remoteStatus: string
) {
  await client.query(
    `
      UPDATE order_transport_sessions
      SET remote_status = $2,
          last_transport_event_at = NOW(),
          updated_at = NOW()
      WHERE order_id = $1
    `,
    [orderId, remoteStatus]
  );
}

export async function routeOrderAfterBuyerContextSubmission(
  client: PoolClient,
  params: {
    orderId: string;
    providerAgentId: string;
    autoAcceptPayload: Record<string, unknown>;
    queuedPayload: Record<string, unknown>;
  }
) {
  const autoAccept = await maybeAutoAcceptOrder(client, {
    orderId: params.orderId,
    providerAgentId: params.providerAgentId,
    payload: params.autoAcceptPayload
  });

  if (autoAccept.accepted) {
    await upsertOrderTransportSession(client, {
      orderId: params.orderId,
      providerAgentId: params.providerAgentId,
      remoteStatus: "accepted"
    });

    return {
      status: "accepted" as const,
      auto_accepted: true,
      reason: null,
      blockers: [] as string[],
      manual_accept_allowed: false
    };
  }

  if (!autoAccept.manual_accept_allowed) {
    return {
      status: null,
      auto_accepted: false,
      reason: autoAccept.reason,
      blockers: autoAccept.blockers,
      manual_accept_allowed: false
    };
  }

  await client.query(
    `
      UPDATE orders
      SET status = 'queued_for_provider',
          updated_at = NOW()
      WHERE id = $1
    `,
    [params.orderId]
  );

  await client.query(
    `
      INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
      VALUES ($1, 'queued_for_provider', 'system', NULL, $2::jsonb)
    `,
    [
      params.orderId,
      JSON.stringify({
        ...params.queuedPayload,
        reason: autoAccept.reason,
        blockers: autoAccept.blockers
      })
    ]
  );

  await upsertOrderTransportSession(client, {
    orderId: params.orderId,
    providerAgentId: params.providerAgentId,
    remoteStatus: "queued"
  });

  return {
    status: "queued_for_provider" as const,
    auto_accepted: false,
    reason: autoAccept.reason,
    blockers: autoAccept.blockers,
    manual_accept_allowed: true
  };
}
