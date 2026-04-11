import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateOwner } from "../auth.js";
import { config } from "../config.js";
import { resolveOwnerUploadEntitlement } from "../domain/ownerMemberships.js";
import { decorateOrderWithTurnSummary } from "../domain/orderTurns.js";
import {
  deriveRuntimeHealthStatus,
  getRuntimeAutomationStatus,
  runtimeHealthStatuses
} from "../domain/runtimeProfiles.js";
import { query, withTransaction } from "../db.js";

export async function registerOwnerConsoleRoutes(app: FastifyInstance) {
  app.get("/api/v1/owners/me", async (request, reply) => {
    const owner = await authenticateOwner(request, reply);
    if (!owner) {
      return;
    }

    reply.send({
      owner,
      owner_membership: resolveOwnerUploadEntitlement(owner)
    });
  });

  app.get("/api/v1/owners/dashboard", async (request, reply) => {
    const owner = await authenticateOwner(request, reply);
    if (!owner) {
      return;
    }

    const [agentsResult, walletSummaryResult, ordersResult, demandsResult, listingsResult] =
      await Promise.all([
        query(
          `
            SELECT aa.id,
                   aa.agent_name,
                   aa.slug,
                   aa.description,
                   aa.status,
                   aa.identity_verification_status,
                   aa.login_method,
                   aa.created_at,
                   aa.updated_at,
                   COALESCE(wa.available_balance, 0) AS available_balance,
                   COALESCE(wa.held_balance, 0) AS held_balance,
                   COALESCE(wa.pending_settlement_balance, 0) AS pending_settlement_balance,
                   COALESCE(arp.accept_mode, 'owner_confirm_required') AS accept_mode,
                   COALESCE(arp.claimed_max_concurrency, 1) AS claimed_max_concurrency,
                   COALESCE(arp.validated_max_concurrency, 1) AS validated_max_concurrency,
                   COALESCE(arp.current_active_order_count, 0) AS current_active_order_count,
                   COALESCE(arp.supports_a2a, FALSE) AS supports_a2a,
                   arp.a2a_agent_card_url,
                   arp.provider_callback_url,
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
                   arp.last_runtime_event_at,
                   arp.last_runtime_event_type,
                   arp.last_runtime_event_summary,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.provider_agent_id = aa.id
                       AND o.status IN ('queued_for_provider', 'accepted', 'in_progress', 'revision_requested', 'delivered', 'evaluating', 'disputed')
                   ) AS provider_open_order_count,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.provider_agent_id = aa.id
                       AND o.status IN ('delivered', 'evaluating')
                   ) AS provider_pending_review_count,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.provider_agent_id = aa.id
                       AND o.status = 'completed'
                   ) AS provider_completed_order_count,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.buyer_agent_id = aa.id
                       AND o.status IN ('awaiting_buyer_context', 'queued_for_provider', 'accepted', 'in_progress', 'revision_requested', 'delivered', 'evaluating', 'disputed')
                   ) AS buyer_open_order_count,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.buyer_agent_id = aa.id
                       AND o.status IN ('delivered', 'evaluating')
                   ) AS buyer_pending_review_count,
                   (
                     SELECT COUNT(*)::int
                     FROM orders o
                     WHERE o.buyer_agent_id = aa.id
                       AND o.status = 'completed'
                   ) AS buyer_completed_order_count,
                   (
                     SELECT COUNT(*)::int
                     FROM service_listings sl
                     WHERE sl.provider_agent_id = aa.id
                       AND sl.status = 'active'
                   ) AS active_listing_count,
                   (
                     SELECT COUNT(*)::int
                     FROM demand_posts dp
                     WHERE dp.requester_agent_id = aa.id
                       AND dp.status = 'open'
                   ) AS open_demand_count
            FROM agent_accounts aa
            LEFT JOIN wallet_accounts wa ON wa.agent_account_id = aa.id
            LEFT JOIN agent_runtime_profiles arp ON arp.agent_account_id = aa.id
            WHERE aa.user_id = $1
            ORDER BY aa.created_at DESC
          `,
          [owner.id]
        ),
        query(
          `
            SELECT COALESCE(SUM(wa.available_balance), 0) AS total_available_balance,
                   COALESCE(SUM(wa.held_balance), 0) AS total_held_balance,
                   COALESCE(SUM(wa.pending_settlement_balance), 0) AS total_pending_settlement_balance
            FROM wallet_accounts wa
            JOIN agent_accounts aa ON aa.id = wa.agent_account_id
            WHERE aa.user_id = $1
          `,
          [owner.id]
        ),
        query(
          `
            SELECT o.id,
                   o.order_no,
                   o.source_kind,
                   o.status,
                   o.escrow_status,
                   o.final_amount,
                   o.currency_code,
                   o.created_at,
                   o.accepted_at,
                   o.delivered_at,
                   o.completed_at,
                   CASE
                     WHEN o.status = 'delivered'
                       AND o.escrow_status = 'held'
                       AND o.delivered_at IS NOT NULL
                     THEN o.delivered_at + ($2 * INTERVAL '1 hour')
                     ELSE NULL
                   END AS review_deadline_at,
                   EXISTS (
                     SELECT 1
                     FROM order_events oe
                     WHERE oe.order_id = o.id
                       AND oe.event_type = 'revision_requested'
                   ) AS had_revision_cycle,
                   (
                     SELECT r.commentary
                     FROM reviews r
                     WHERE r.order_id = o.id
                       AND r.settlement_action = 'request_revision'
                     LIMIT 1
                   ) AS latest_revision_commentary,
                   buyer.agent_name AS buyer_agent_name,
                   buyer.id AS buyer_agent_id,
                   provider.agent_name AS provider_agent_name,
                   provider.id AS provider_agent_id,
                   sl.title AS listing_title,
                   dp.title AS demand_title
            FROM orders o
            JOIN agent_accounts buyer ON buyer.id = o.buyer_agent_id
            JOIN agent_accounts provider ON provider.id = o.provider_agent_id
            LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
            LEFT JOIN demand_posts dp ON dp.id = o.demand_post_id
            WHERE buyer.user_id = $1 OR provider.user_id = $1
            ORDER BY o.created_at DESC
            LIMIT 30
          `,
          [owner.id, config.deliveredReviewAutoCloseHours]
        ),
        query(
          `
            SELECT dp.id,
                   dp.title,
                   dp.category,
                   dp.budget_min,
                   dp.budget_max,
                   dp.delivery_eta_minutes,
                   dp.status,
                   dp.created_at,
                   aa.agent_name AS requester_agent_name
            FROM demand_posts dp
            JOIN agent_accounts aa ON aa.id = dp.requester_agent_id
            WHERE aa.user_id = $1
            ORDER BY dp.created_at DESC
            LIMIT 20
          `,
          [owner.id]
        ),
        query(
          `
            SELECT sl.id,
                   sl.title,
                   sl.category,
                   sl.price_min,
                   sl.price_max,
                   sl.delivery_eta_minutes,
                   sl.status,
                   sl.created_at,
                   aa.agent_name AS provider_agent_name
            FROM service_listings sl
            JOIN agent_accounts aa ON aa.id = sl.provider_agent_id
            WHERE aa.user_id = $1
            ORDER BY sl.created_at DESC
            LIMIT 20
          `,
          [owner.id]
        )
      ]);

    const normalizedAgents = agentsResult.rows.map((agent) => {
      const runtimeProfile = {
        runtime_kind:
          typeof agent.runtime_kind === "string" ? agent.runtime_kind : "generic",
        automation_mode:
          typeof agent.automation_mode === "string" ? agent.automation_mode : "manual",
        automation_source:
          typeof agent.automation_source === "string" ? agent.automation_source : "none",
        runtime_health_status:
          typeof agent.runtime_health_status === "string" &&
          runtimeHealthStatuses.includes(
            agent.runtime_health_status as (typeof runtimeHealthStatuses)[number]
          )
            ? agent.runtime_health_status
            : "unknown",
        heartbeat_expires_at:
          typeof agent.heartbeat_expires_at === "string" ? agent.heartbeat_expires_at : null,
        relay_connection_status:
          typeof agent.relay_connection_status === "string" ? agent.relay_connection_status : "disconnected",
        relay_session_id:
          typeof agent.relay_session_id === "string" ? agent.relay_session_id : null,
        relay_connected_at:
          typeof agent.relay_connected_at === "string" ? agent.relay_connected_at : null,
        relay_last_activity_at:
          typeof agent.relay_last_activity_at === "string" ? agent.relay_last_activity_at : null,
        relay_lease_expires_at:
          typeof agent.relay_lease_expires_at === "string" ? agent.relay_lease_expires_at : null,
        relay_last_disconnect_reason:
          typeof agent.relay_last_disconnect_reason === "string"
            ? agent.relay_last_disconnect_reason
            : null,
        provider_callback_url:
          typeof agent.provider_callback_url === "string" ? agent.provider_callback_url : null,
        runtime_capabilities_json:
          agent.runtime_capabilities_json &&
          typeof agent.runtime_capabilities_json === "object" &&
          !Array.isArray(agent.runtime_capabilities_json)
            ? (agent.runtime_capabilities_json as Record<string, unknown>)
            : {},
        runtime_authorization_json:
          agent.runtime_authorization_json &&
          typeof agent.runtime_authorization_json === "object" &&
          !Array.isArray(agent.runtime_authorization_json)
            ? (agent.runtime_authorization_json as Record<string, unknown>)
            : {},
        notify_target_json:
          agent.notify_target_json &&
          typeof agent.notify_target_json === "object" &&
          !Array.isArray(agent.notify_target_json)
            ? (agent.notify_target_json as Record<string, unknown>)
            : {}
      } as unknown as Parameters<typeof getRuntimeAutomationStatus>[0];
      const automationStatus = getRuntimeAutomationStatus(runtimeProfile);

      return {
        ...agent,
        runtime_health_status: deriveRuntimeHealthStatus(
          runtimeProfile as Parameters<typeof deriveRuntimeHealthStatus>[0]
        ),
        automation_status: automationStatus
      };
    });

    reply.send({
      owner,
      owner_membership: resolveOwnerUploadEntitlement(owner),
      wallet_summary: walletSummaryResult.rows[0] ?? {
        total_available_balance: 0,
        total_held_balance: 0,
        total_pending_settlement_balance: 0
      },
      agents: normalizedAgents,
      recent_orders: ordersResult.rows.map((order) => decorateOrderWithTurnSummary(order)),
      recent_demands: demandsResult.rows,
      recent_listings: listingsResult.rows
    });
  });
}
