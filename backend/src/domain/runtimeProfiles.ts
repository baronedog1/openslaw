import type { PoolClient } from "pg";
import { getRuntimeRelayStatus } from "./runtimeRelay.js";

export const runtimeKinds = ["generic", "openclaw"] as const;
export const automationModes = ["manual", "openclaw_auto"] as const;
export const automationSources = ["none", "openclaw_native", "owner_console"] as const;
export const runtimeHealthStatuses = [
  "unknown",
  "healthy",
  "stale",
  "offline",
  "degraded"
] as const;
export const providerRuntimeEventTypes = [
  "order_received",
  "execution_started",
  "waiting_for_inputs",
  "progress_update",
  "owner_notified",
  "blocked_manual_help",
  "delivery_uploaded",
  "execution_failed"
] as const;

export type RuntimeProfile = {
  id: string;
  agent_account_id: string;
  accept_mode: "auto_accept" | "owner_confirm_required";
  claimed_max_concurrency: number;
  validated_max_concurrency: number;
  queue_enabled: boolean;
  current_active_order_count: number;
  supports_parallel_delivery: boolean;
  supports_a2a: boolean;
  a2a_agent_card_url: string | null;
  provider_callback_url: string | null;
  callback_timeout_seconds: number;
  runtime_kind: (typeof runtimeKinds)[number];
  runtime_label: string | null;
  automation_mode: (typeof automationModes)[number];
  automation_source: (typeof automationSources)[number];
  runtime_health_status: (typeof runtimeHealthStatuses)[number];
  heartbeat_ttl_seconds: number;
  last_heartbeat_at: string | null;
  heartbeat_expires_at: string | null;
  relay_connection_status: "disconnected" | "connected" | "standby";
  relay_session_id: string | null;
  relay_connected_at: string | null;
  relay_last_activity_at: string | null;
  relay_lease_expires_at: string | null;
  relay_last_disconnect_reason: string | null;
  runtime_capabilities_json: Record<string, unknown>;
  runtime_authorization_json: Record<string, unknown>;
  notify_target_json: Record<string, unknown>;
  last_runtime_event_at: string | null;
  last_runtime_event_type: string | null;
  last_runtime_event_summary: string | null;
};

export type ProviderOrderIntakeDecision = {
  configured_accept_mode: "auto_accept" | "owner_confirm_required";
  effective_accept_mode: "auto_accept" | "owner_confirm_required";
  auto_accept_ready: boolean;
  manual_accept_allowed: boolean;
  reason: string | null;
  blockers: string[];
};

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function toPositiveInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export function deriveRuntimeHealthStatus(profile: Pick<RuntimeProfile, "runtime_health_status" | "heartbeat_expires_at">) {
  const stored = profile.runtime_health_status;
  if (!profile.heartbeat_expires_at) {
    return stored === "healthy" ? "stale" : stored;
  }

  const expiresAt = new Date(profile.heartbeat_expires_at).getTime();
  if (Number.isNaN(expiresAt)) {
    return stored === "healthy" ? "stale" : stored;
  }

  if (expiresAt <= Date.now()) {
    return stored === "offline" ? "offline" : "stale";
  }

  return stored;
}

export function getOpenClawAutomationBlockers(profile: RuntimeProfile): string[] {
  const blockers: string[] = [];

  if (profile.runtime_kind !== "openclaw") {
    blockers.push("runtime_kind_not_openclaw");
  }

  if (profile.automation_mode !== "openclaw_auto") {
    blockers.push("automation_mode_manual");
  }

  if (profile.automation_source !== "openclaw_native") {
    blockers.push("automation_authorization_missing");
  }

  const healthStatus = deriveRuntimeHealthStatus(profile);
  if (healthStatus !== "healthy") {
    blockers.push(`runtime_${healthStatus}`);
  }

  const capabilities = toObject(profile.runtime_capabilities_json);
  if (!capabilities.local_order_root || typeof capabilities.local_order_root !== "string") {
    blockers.push("local_order_root_missing");
  }

  if (capabilities.can_write_local_order_root !== true) {
    blockers.push("local_order_root_not_writable");
  }

  if (capabilities.supports_workspace_download !== true) {
    blockers.push("workspace_download_unavailable");
  }

  if (capabilities.supports_result_upload !== true) {
    blockers.push("result_upload_unavailable");
  }

  if (capabilities.supports_notifications !== true) {
    blockers.push("notification_delivery_unavailable");
  }

  if (toStringArray(capabilities.notification_channels).length === 0) {
    blockers.push("notification_channels_missing");
  }

  const authorization = toObject(profile.runtime_authorization_json);
  if (authorization.allow_download_inputs !== true) {
    blockers.push("input_download_not_authorized");
  }

  if (authorization.allow_upload_outputs !== true) {
    blockers.push("output_upload_not_authorized");
  }

  if (authorization.fallback_to_manual_on_blocked !== true) {
    blockers.push("manual_fallback_not_authorized");
  }

  return blockers;
}

export function getRuntimePushReadiness(profile: RuntimeProfile) {
  const blockers: string[] = [];
  const relayStatus = getRuntimeRelayStatus(profile);
  blockers.push(...relayStatus.blockers);

  const effectiveRuntimeHealthStatus = deriveRuntimeHealthStatus(profile);
  if (effectiveRuntimeHealthStatus !== "healthy") {
    blockers.push(`runtime_${effectiveRuntimeHealthStatus}`);
  }

  return {
    ready: blockers.length === 0,
    blockers,
    effective_runtime_health_status: effectiveRuntimeHealthStatus
  };
}

export function getRuntimeExecutionReadiness(profile: RuntimeProfile) {
  const blockers =
    profile.runtime_kind === "openclaw" || profile.automation_mode === "openclaw_auto"
      ? getOpenClawAutomationBlockers(profile)
      : ["runtime_execution_contract_missing"];

  return {
    ready: blockers.length === 0,
    blockers,
    effective_runtime_health_status: deriveRuntimeHealthStatus(profile)
  };
}

export function getRuntimeAutomationStatus(profile: RuntimeProfile) {
  const push = getRuntimePushReadiness(profile);
  const execution = getRuntimeExecutionReadiness(profile);
  const relayStatus = getRuntimeRelayStatus(profile);
  const fullAutoBlockers: string[] = [];

  if (profile.accept_mode !== "auto_accept") {
    fullAutoBlockers.push("accept_mode_owner_confirm_required");
  }

  fullAutoBlockers.push(...push.blockers, ...execution.blockers);

  return {
    auto_accept_enabled: profile.accept_mode === "auto_accept",
    order_push_ready: push.ready,
    order_push_blockers: push.blockers,
    auto_execution_ready: execution.ready,
    auto_execution_blockers: execution.blockers,
    full_auto_ready: fullAutoBlockers.length === 0,
    full_auto_blockers: fullAutoBlockers,
    effective_runtime_health_status: push.effective_runtime_health_status,
    relay_status: relayStatus
  };
}

export function resolveProviderOrderIntakeDecision(
  profile: RuntimeProfile
): ProviderOrderIntakeDecision {
  if (profile.accept_mode !== "auto_accept") {
    return {
      configured_accept_mode: profile.accept_mode,
      effective_accept_mode: "owner_confirm_required",
      auto_accept_ready: false,
      manual_accept_allowed: true,
      reason: "owner_confirm_required",
      blockers: []
    };
  }

  if (profile.automation_mode === "openclaw_auto" || profile.runtime_kind === "openclaw") {
    const automationStatus = getRuntimeAutomationStatus(profile);
    if (!automationStatus.full_auto_ready) {
      return {
        configured_accept_mode: profile.accept_mode,
        effective_accept_mode: "owner_confirm_required",
        auto_accept_ready: false,
        manual_accept_allowed: profile.queue_enabled,
        reason: automationStatus.full_auto_blockers[0] ?? "openclaw_runtime_not_ready",
        blockers: automationStatus.full_auto_blockers
      };
    }
  }

  if (profile.current_active_order_count >= profile.validated_max_concurrency) {
    const reason = profile.queue_enabled ? "provider_capacity_queued" : "provider_capacity_exceeded";
    return {
      configured_accept_mode: profile.accept_mode,
      effective_accept_mode: "owner_confirm_required",
      auto_accept_ready: false,
      manual_accept_allowed: profile.queue_enabled,
      reason,
      blockers: [reason]
    };
  }

  return {
    configured_accept_mode: profile.accept_mode,
    effective_accept_mode: "auto_accept",
    auto_accept_ready: true,
    manual_accept_allowed: false,
    reason: null,
    blockers: []
  };
}

export function getRuntimeChannelDeliverySummary(profile: RuntimeProfile) {
  const capabilities = toObject(profile.runtime_capabilities_json);
  const authorization = toObject(profile.runtime_authorization_json);
  const primaryOwnerChannel =
    typeof capabilities.primary_owner_channel === "string" &&
    capabilities.primary_owner_channel.trim().length > 0
      ? capabilities.primary_owner_channel.trim()
      : null;
  const supportsDirectFileDelivery = capabilities.supports_channel_file_delivery === true;
  const allowDirectFileDelivery = authorization.allow_channel_file_delivery === true;
  const allowLinkFallback = authorization.allow_channel_link_fallback === true;
  const supportedArtifactTypes = toStringArray(capabilities.channel_supported_artifact_types);
  const maxDirectBytes = toPositiveInt(capabilities.channel_max_direct_bytes);
  const blockers: string[] = [];

  if (!primaryOwnerChannel) {
    blockers.push("primary_owner_channel_missing");
  }

  if (!supportsDirectFileDelivery) {
    blockers.push("channel_file_delivery_unavailable");
  }

  if (!allowDirectFileDelivery) {
    blockers.push("channel_file_delivery_not_authorized");
  }

  if (maxDirectBytes <= 0) {
    blockers.push("channel_direct_send_limit_missing");
  }

  if (supportedArtifactTypes.length === 0) {
    blockers.push("channel_supported_artifact_types_missing");
  }

  return {
    ready: blockers.length === 0,
    primary_owner_channel: primaryOwnerChannel,
    supports_direct_file_delivery: supportsDirectFileDelivery,
    allow_direct_file_delivery: allowDirectFileDelivery,
    allow_secure_link_fallback: allowLinkFallback,
    direct_send_max_bytes: maxDirectBytes,
    supported_artifact_types: supportedArtifactTypes,
    blockers
  };
}

export async function ensureRuntimeProfile(client: PoolClient, agentAccountId: string) {
  await client.query(
    `
      INSERT INTO agent_runtime_profiles (agent_account_id)
      VALUES ($1)
      ON CONFLICT (agent_account_id) DO NOTHING
    `,
    [agentAccountId]
  );
}

export async function lockRuntimeProfile(
  client: PoolClient,
  agentAccountId: string
): Promise<RuntimeProfile> {
  await ensureRuntimeProfile(client, agentAccountId);

  const result = await client.query<RuntimeProfile>(
    `
      SELECT id, agent_account_id, accept_mode, claimed_max_concurrency, validated_max_concurrency,
             queue_enabled, current_active_order_count, supports_parallel_delivery,
             supports_a2a, a2a_agent_card_url, provider_callback_url, callback_timeout_seconds,
             runtime_kind, runtime_label, automation_mode, automation_source, runtime_health_status,
             heartbeat_ttl_seconds, last_heartbeat_at, heartbeat_expires_at,
             relay_connection_status, relay_session_id, relay_connected_at,
             relay_last_activity_at, relay_lease_expires_at, relay_last_disconnect_reason,
             runtime_capabilities_json, runtime_authorization_json, notify_target_json,
             last_runtime_event_at, last_runtime_event_type, last_runtime_event_summary
      FROM agent_runtime_profiles
      WHERE agent_account_id = $1
      FOR UPDATE
    `,
    [agentAccountId]
  );

  const row = result.rows[0];
  return {
    ...row,
    runtime_capabilities_json: toObject(row.runtime_capabilities_json),
    runtime_authorization_json: toObject(row.runtime_authorization_json),
    notify_target_json: toObject(row.notify_target_json)
  };
}

export async function claimRuntimeCapacity(
  client: PoolClient,
  agentAccountId: string
): Promise<RuntimeProfile> {
  const profile = await lockRuntimeProfile(client, agentAccountId);

  if (profile.current_active_order_count >= profile.validated_max_concurrency) {
    throw new Error("provider_capacity_exceeded");
  }

  await client.query(
    `
      UPDATE agent_runtime_profiles
      SET current_active_order_count = current_active_order_count + 1,
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [agentAccountId]
  );

  return {
    ...profile,
    current_active_order_count: profile.current_active_order_count + 1
  };
}

export async function releaseRuntimeCapacity(client: PoolClient, agentAccountId: string) {
  await ensureRuntimeProfile(client, agentAccountId);

  await client.query(
    `
      UPDATE agent_runtime_profiles
      SET current_active_order_count = GREATEST(current_active_order_count - 1, 0),
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [agentAccountId]
  );
}

export async function reclaimRuntimeCapacityForRevision(client: PoolClient, agentAccountId: string) {
  await ensureRuntimeProfile(client, agentAccountId);

  await client.query(
    `
      UPDATE agent_runtime_profiles
      SET current_active_order_count = current_active_order_count + 1,
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [agentAccountId]
  );
}

export async function refreshValidatedConcurrency(
  client: PoolClient,
  agentAccountId: string
): Promise<number> {
  const profile = await lockRuntimeProfile(client, agentAccountId);

  let nextValidated = 1;
  if (profile.supports_parallel_delivery && profile.claimed_max_concurrency > 1) {
    const aggregateResult = await client.query<{
      successful_completed_count: number;
      disputed_or_non_accept_count: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE r.settlement_action = 'accept_close'
              AND r.review_band IN ('positive', 'neutral')
              AND o.completed_at IS NOT NULL
          )::int AS successful_completed_count,
          COUNT(*) FILTER (
            WHERE r.review_band = 'negative'
               OR r.settlement_action IN ('request_revision', 'open_dispute')
               OR o.status = 'disputed'
          )::int AS disputed_or_non_accept_count
        FROM orders o
        JOIN reviews r ON r.order_id = o.id
        WHERE o.provider_agent_id = $1
      `,
      [agentAccountId]
    );

    const successfulCompletedCount = aggregateResult.rows[0]?.successful_completed_count ?? 0;
    const disputedOrNonAcceptCount = aggregateResult.rows[0]?.disputed_or_non_accept_count ?? 0;
    const reviewedCount = successfulCompletedCount + disputedOrNonAcceptCount;
    const failureRate = reviewedCount === 0 ? 0 : disputedOrNonAcceptCount / reviewedCount;

    let stagedTarget = 1;
    if (successfulCompletedCount >= 3 && failureRate <= 0.15) {
      stagedTarget = 2;
    }
    if (successfulCompletedCount >= 8 && failureRate <= 0.12) {
      stagedTarget = 3;
    }
    if (successfulCompletedCount >= 15 && failureRate <= 0.1) {
      stagedTarget = 4;
    }
    if (successfulCompletedCount >= 24 && failureRate <= 0.08) {
      stagedTarget = 5;
    }

    nextValidated = Math.max(1, Math.min(profile.claimed_max_concurrency, stagedTarget));
  }

  await client.query(
    `
      UPDATE agent_runtime_profiles
      SET validated_max_concurrency = $2,
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [agentAccountId, nextValidated]
  );

  return nextValidated;
}

export async function maybeAutoAcceptOrder(
  client: PoolClient,
  params: {
    orderId: string;
    providerAgentId: string;
    payload: Record<string, unknown>;
  }
): Promise<{
  accepted: boolean;
  reason: string | null;
  blockers: string[];
  manual_accept_allowed: boolean;
}> {
  const profile = await lockRuntimeProfile(client, params.providerAgentId);
  const decision = resolveProviderOrderIntakeDecision(profile);

  if (!decision.auto_accept_ready) {
    return {
      accepted: false,
      reason: decision.reason,
      blockers: decision.blockers,
      manual_accept_allowed: decision.manual_accept_allowed
    };
  }

  await client.query(
    `
      UPDATE orders
      SET status = 'accepted',
          accepted_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [params.orderId]
  );

  await client.query(
    `
      UPDATE agent_runtime_profiles
      SET current_active_order_count = current_active_order_count + 1,
          last_runtime_event_at = NOW(),
          last_runtime_event_type = COALESCE(last_runtime_event_type, 'auto_accept'),
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [params.providerAgentId]
  );

  await client.query(
    `
      INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
      VALUES ($1, 'provider_auto_accepted', 'system', NULL, $2::jsonb)
    `,
    [params.orderId, JSON.stringify(params.payload)]
  );

  return {
    accepted: true,
    reason: null,
    blockers: [],
    manual_accept_allowed: false
  };
}
