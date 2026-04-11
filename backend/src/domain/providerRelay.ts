import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { normalizeBuyerContextPack } from "./buyerContextPacks.js";
import { buildLocalOrderBundleDescriptor } from "./deliveryArtifacts.js";
import { buildOrderNotificationHints } from "./orderNotifications.js";
import { flushRuntimeRelayQueue } from "./runtimeRelay.js";
import { query, withTransaction } from "../db.js";

export type ProviderRelayEventType =
  | "order_assigned"
  | "order_revision_requested"
  | "order_disputed"
  | "order_completed"
  | "order_cancelled"
  | "order_expired"
  | "order_dispute_resolved";

function buildWorkspaceManifestUrl(orderId: string) {
  const pathName = `/agent/orders/${orderId}/workspace/manifest`;
  return config.publicApiBaseUrl ? `${config.publicApiBaseUrl}${pathName}` : `/api/v1${pathName}`;
}

function extractTaskTitleCandidate(order: {
  listing_title?: string | null;
  demand_title?: string | null;
  input_payload_json?: Record<string, unknown>;
  order_no: string;
}) {
  const inputPayload =
    order.input_payload_json && typeof order.input_payload_json === "object"
      ? order.input_payload_json
      : {};

  const candidates = [
    order.demand_title,
    order.listing_title,
    typeof inputPayload.title === "string" ? inputPayload.title : null,
    typeof inputPayload.task === "string" ? inputPayload.task : null,
    typeof inputPayload.summary === "string" ? inputPayload.summary : null,
    order.order_no
  ];

  return candidates.find((item) => typeof item === "string" && item.trim().length > 0) ?? "order";
}

export async function queueProviderRelayEvent(params: {
  orderId: string;
  eventType: ProviderRelayEventType;
}) {
  const result = await query<{
    id: string;
    order_no: string;
    buyer_agent_id: string;
    provider_agent_id: string;
    source_kind: string;
    status: string;
    escrow_status: string;
    input_payload_json: Record<string, unknown>;
    expected_output_schema_json: unknown[];
    budget_confirmation_snapshot_json: Record<string, unknown>;
    execution_scope_snapshot_json: Record<string, unknown>;
    expires_at: string | null;
    created_at: string;
    transport_kind: string | null;
    remote_status: string | null;
    runtime_kind: string | null;
    runtime_label: string | null;
    automation_mode: string | null;
    automation_source: string | null;
    runtime_health_status: string | null;
    runtime_authorization_json: Record<string, unknown> | null;
    notify_target_json: Record<string, unknown> | null;
    relay_connection_status: string | null;
    review_band: string | null;
    settlement_action: string | null;
    review_commentary: string | null;
    review_evidence_json: Record<string, unknown> | null;
    listing_title: string | null;
    demand_title: string | null;
    buyer_context_payload_json: Record<string, unknown> | null;
  }>(
    `
      SELECT o.id, o.order_no, o.buyer_agent_id, o.provider_agent_id, o.source_kind, o.status,
             o.escrow_status, o.input_payload_json, o.expected_output_schema_json,
             o.budget_confirmation_snapshot_json, o.execution_scope_snapshot_json, o.expires_at,
             o.created_at,
             arp.runtime_kind, arp.runtime_label, arp.automation_mode, arp.automation_source,
             arp.runtime_health_status, arp.runtime_authorization_json, arp.notify_target_json,
             arp.relay_connection_status,
             r.review_band, r.settlement_action, r.commentary AS review_commentary, r.evidence_json AS review_evidence_json,
             ots.transport_kind, ots.remote_status,
             sl.title AS listing_title,
             dp.title AS demand_title,
             buyer_context.payload_json AS buyer_context_payload_json
      FROM orders o
      LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = o.provider_agent_id
      LEFT JOIN reviews r ON r.order_id = o.id
      LEFT JOIN order_transport_sessions ots ON ots.order_id = o.id
      LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
      LEFT JOIN demand_posts dp ON dp.id = o.demand_post_id
      LEFT JOIN LATERAL (
        SELECT payload_json
        FROM order_events
        WHERE order_id = o.id
          AND event_type = 'buyer_context_submitted'
        ORDER BY created_at DESC
        LIMIT 1
      ) buyer_context ON TRUE
      WHERE o.id = $1
      LIMIT 1
    `,
    [params.orderId]
  );

  const order = result.rows[0];
  if (!order) {
    return { skipped: true };
  }

  if (order.runtime_kind !== "openclaw") {
    await query(
      `
        INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
        VALUES ($1, 'provider_relay_skipped', 'system', NULL, $2::jsonb)
      `,
      [
        order.id,
        JSON.stringify({
          requested_event_type: params.eventType,
          reason: "provider_runtime_not_openclaw",
          runtime_kind: order.runtime_kind ?? "missing",
          automation_mode: order.automation_mode,
          relay_connection_status: order.relay_connection_status
        })
      ]
    );

    return {
      skipped: true,
      reason: "provider_runtime_not_openclaw"
    };
  }

  const deliveryId = randomUUID();
  const occurredAt = new Date().toISOString();
  const workspaceManifestUrl = buildWorkspaceManifestUrl(order.id);
  const localBundle = buildLocalOrderBundleDescriptor({
    orderId: order.id,
    createdAt: order.created_at,
    titleCandidate: extractTaskTitleCandidate(order)
  });
  const review = order.review_band
    ? {
        review_band: order.review_band,
        settlement_action: order.settlement_action,
        commentary: order.review_commentary,
        evidence_json:
          order.review_evidence_json && typeof order.review_evidence_json === "object"
            ? order.review_evidence_json
            : {}
      }
    : null;
  const buyerContextPack = normalizeBuyerContextPack(order.buyer_context_payload_json);
  const notificationHints = buildOrderNotificationHints({
    order,
    review,
    callbackEventType: params.eventType,
    deliveredReviewAutoCloseHours: config.deliveredReviewAutoCloseHours
  });
  const apiBase =
    config.publicApiBaseUrl ?? `http://127.0.0.1:${config.port}/api/v1`;

  const payload = {
    event_type: params.eventType,
    delivery_id: deliveryId,
    occurred_at: occurredAt,
    order: {
      id: order.id,
      order_no: order.order_no,
      source_kind: order.source_kind,
      status: order.status,
      escrow_status: order.escrow_status,
      expires_at: order.expires_at,
      input_payload: order.input_payload_json,
      expected_outputs: order.expected_output_schema_json,
      budget_confirmation_snapshot: order.budget_confirmation_snapshot_json,
      execution_scope_snapshot: order.execution_scope_snapshot_json
    },
    transport: {
      transport_kind: order.transport_kind ?? "platform_rest",
      remote_status: order.remote_status ?? "queued",
      transport_channel: "openslaw_runtime_relay"
    },
    runtime: {
      runtime_kind: order.runtime_kind,
      runtime_label: order.runtime_label,
      automation_mode: order.automation_mode,
      automation_source: order.automation_source,
      runtime_health_status: order.runtime_health_status,
      notify_target: order.notify_target_json ?? {},
      authorization: order.runtime_authorization_json ?? {}
    },
    review: review,
    review_deadline_at: notificationHints.review_deadline_at,
    notification_hints: notificationHints,
    workspace: {
      manifest_url: workspaceManifestUrl,
      local_bundle: localBundle,
      buyer_context_pack: buyerContextPack
    },
    platform_actions: {
      order_detail_url: `${apiBase}/agent/orders/${order.id}`,
      workspace_manifest_url: workspaceManifestUrl,
      provider_accept_url: `${apiBase}/provider/orders/${order.id}/accept`,
      provider_runtime_event_url: `${apiBase}/provider/orders/${order.id}/runtime-events`,
      provider_deliver_url: `${apiBase}/provider/orders/${order.id}/deliver`
    }
  };

  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO runtime_relay_events (
          agent_account_id,
          order_id,
          delivery_id,
          event_type,
          payload_json,
          delivery_state
        )
        VALUES ($1, $2, $3::uuid, $4, $5::jsonb, 'queued')
      `,
      [order.provider_agent_id, order.id, deliveryId, params.eventType, JSON.stringify(payload)]
    );

    await client.query(
      `
        INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
        VALUES ($1, 'provider_relay_queued', 'system', NULL, $2::jsonb)
      `,
      [
        order.id,
        JSON.stringify({
          delivery_id: deliveryId,
          relay_event_type: params.eventType
        })
      ]
    );

    await client.query(
      `
        UPDATE order_transport_sessions
        SET push_notification_config_json = COALESCE(push_notification_config_json, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE order_id = $1
      `,
      [
        order.id,
        JSON.stringify({
          transport_channel: "openslaw_runtime_relay",
          last_delivery_id: deliveryId,
          last_event_type: params.eventType,
          last_queued_at: occurredAt
        })
      ]
    );
  });

  await flushRuntimeRelayQueue(order.provider_agent_id);

  return {
    queued: true,
    delivery_id: deliveryId
  };
}
