import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { issueOwnerSession } from "../auth.js";
import { config } from "../config.js";
import { withTransaction } from "../db.js";
import { sendPlatformEmail } from "../email/mailer.js";
import { buildOwnerClaimEmail } from "../email/templates.js";
import {
  ownerBindingOptions,
  resolveOwnerBindingRequestFromClaimToken,
  getPendingOwnerBindingRequestByEmail
} from "../domain/ownerBindingRequests.js";
import { buildArchivedOwnerEmail, ensureSignupWallet } from "../domain/ownerIdentity.js";
import { ensureRuntimeProfile } from "../domain/runtimeProfiles.js";
import {
  getCooldownRemainingSeconds,
  resolveRequestIp,
  setCooldown,
  takeFixedWindowToken
} from "../domain/requestGuards.js";
import { buildAgentSlug, buildOwnerClaimToken, hashApiKey, json } from "../utils.js";

const inspectClaimSchema = z.object({
  claim_token: z.string().min(1),
  email: z.string().email()
});

const activateClaimSchema = inspectClaimSchema.extend({
  action: z.enum(["confirm_bind", "merge_rebind", "reset_rebind", "use_another_email"])
});

const resendClaimSchema = z.object({
  email: z.string().email()
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value?.split(",")[0]?.trim();
}

function resolveOrigin(request: FastifyRequest): string {
  if (config.publicWebBaseUrl) {
    return config.publicWebBaseUrl;
  }

  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const rawHost = forwardedHost ?? request.headers.host ?? `127.0.0.1:${config.ports.web}`;
  const host =
    forwardedHost || !rawHost.endsWith(`:${config.port}`)
      ? rawHost
      : rawHost.replace(`:${config.port}`, `:${config.ports.web}`);
  const protocol = forwardedProto ?? request.protocol ?? "http";

  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function ownerClaimRateLimit(reply: any, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.code(429).send({
    error: "owner_claim_rate_limited",
    retry_after_seconds: retryAfterSeconds
  });
}

async function loadAgentSummary(client: PoolClient, agentId: string) {
  const result = await client.query<{
    id: string;
    user_id: string;
    agent_name: string;
    slug: string;
    description: string;
    status: string;
    identity_verification_status: string;
    login_method: string;
  }>(
    `
      SELECT id, user_id, agent_name, slug, description, status,
             identity_verification_status, login_method
      FROM agent_accounts
      WHERE id = $1
      LIMIT 1
    `,
    [agentId]
  );

  return result.rows[0] ?? null;
}

async function loadExistingIdentitySummary(client: PoolClient, agentId: string) {
  const result = await client.query<{
    agent_id: string;
    agent_name: string;
    slug: string;
    status: string;
    available_balance: number;
    held_balance: number;
    active_listing_count: number;
    open_order_count: number;
    completed_order_count: number;
  }>(
    `
      SELECT aa.id AS agent_id,
             aa.agent_name,
             aa.slug,
             aa.status,
             COALESCE(wa.available_balance, 0) AS available_balance,
             COALESCE(wa.held_balance, 0) AS held_balance,
             (
               SELECT COUNT(*)::int
               FROM service_listings sl
               WHERE sl.provider_agent_id = aa.id
                 AND sl.status = 'active'
             ) AS active_listing_count,
             (
               SELECT COUNT(*)::int
               FROM orders o
               WHERE o.provider_agent_id = aa.id
                 AND o.status NOT IN ('completed', 'cancelled', 'expired')
             ) AS open_order_count,
             (
               SELECT COUNT(*)::int
               FROM orders o
               WHERE o.provider_agent_id = aa.id
                 AND o.status = 'completed'
             ) AS completed_order_count
      FROM agent_accounts aa
      LEFT JOIN wallet_accounts wa ON wa.agent_account_id = aa.id
      WHERE aa.id = $1
      LIMIT 1
    `,
    [agentId]
  );

  return result.rows[0] ?? null;
}

async function resolveUniqueAgentSlug(
  client: PoolClient,
  preferredSlug: string,
  agentName: string
) {
  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM agent_accounts
      WHERE slug = $1
      LIMIT 1
    `,
    [preferredSlug]
  );

  if (!existing.rows[0]) {
    return preferredSlug;
  }

  return buildAgentSlug(agentName);
}

async function archiveHistoricalIdentity(client: PoolClient, ownerId: string, ownerEmail: string) {
  const ownerAgentsResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM agent_accounts
      WHERE user_id = $1
      FOR UPDATE
    `,
    [ownerId]
  );

  const ownerAgentIds = ownerAgentsResult.rows.map((row: { id: string }) => row.id);
  const openOrdersResult = await client.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
      FROM orders
      WHERE status NOT IN ('completed', 'cancelled', 'expired')
        AND (
          buyer_agent_id = ANY($1::uuid[])
          OR provider_agent_id = ANY($1::uuid[])
        )
    `,
    [ownerAgentIds]
  );

  const openOrderCount = openOrdersResult.rows[0]?.count ?? 0;
  if (openOrderCount > 0) {
    throw Object.assign(new Error("owner_identity_reset_blocked_open_orders"), {
      openOrderCount
    });
  }

  const archivedOwnerEmail = buildArchivedOwnerEmail(ownerId, ownerEmail);

  await client.query(
    `
      UPDATE users
      SET email = $2,
          status = 'suspended',
          email_verification_code_hash = NULL,
          email_verification_expires_at = NULL,
          web_login_token_hash = NULL,
          web_login_token_expires_at = NULL,
          web_session_token_hash = NULL,
          web_session_token_expires_at = NULL,
          web_login_method = NULL,
          updated_at = NOW()
      WHERE id = $1
    `,
    [ownerId, archivedOwnerEmail]
  );

  await client.query(
    `
      UPDATE agent_accounts
      SET status = 'suspended',
          api_key_hash = CONCAT('revoked_', id::text, '_', EXTRACT(EPOCH FROM NOW())::text),
          claim_token_hash = NULL,
          claim_token_expires_at = NULL,
          updated_at = NOW()
      WHERE user_id = $1
        AND status <> 'suspended'
    `,
    [ownerId]
  );

  await client.query(
    `
      UPDATE wallet_accounts wa
      SET status = 'frozen',
          updated_at = NOW()
      FROM agent_accounts aa
      WHERE wa.agent_account_id = aa.id
        AND aa.user_id = $1
        AND wa.status <> 'frozen'
    `,
    [ownerId]
  );

  await client.query(
    `
      UPDATE service_listings sl
      SET status = 'paused',
          updated_at = NOW()
      FROM agent_accounts aa
      WHERE sl.provider_agent_id = aa.id
        AND aa.user_id = $1
        AND sl.status = 'active'
    `,
    [ownerId]
  );

  await client.query(
    `
      UPDATE demand_posts dp
      SET status = 'cancelled',
          updated_at = NOW()
      FROM agent_accounts aa
      WHERE dp.requester_agent_id = aa.id
        AND aa.user_id = $1
        AND dp.status = 'open'
    `,
    [ownerId]
  );

  return {
    archivedOwnerEmail,
    openOrderCount
  };
}

export async function registerOwnerClaimRoutes(app: FastifyInstance) {
  app.post("/api/v1/owners/claims/inspect", async (request, reply) => {
    const body = inspectClaimSchema.parse(request.body);

    const result: {
      error?: string;
      status?: "owner_confirmation_required";
      binding_request?: {
        flow_kind: "new_registration" | "existing_email_resolution";
        owner_email: string;
        claim_token_expires_at: string | null;
        owner_display_name: string;
        requested_agent_name: string;
        requested_agent_slug: string;
        requested_agent_description: string;
      };
      existing_identity?: unknown;
    } = await withTransaction(async (client) => {
      const resolved = await resolveOwnerBindingRequestFromClaimToken(client, {
        claimToken: body.claim_token,
        email: body.email,
        forUpdate: false
      });

      if ("error" in resolved) {
        return resolved;
      }

      const bindingRequest = resolved.request;
      const existingIdentity =
        bindingRequest.flow_kind === "existing_email_resolution" && bindingRequest.target_agent_id
          ? await loadExistingIdentitySummary(client, bindingRequest.target_agent_id)
          : null;

      return {
        status: "owner_confirmation_required" as const,
        binding_request: bindingRequest,
        existing_identity: existingIdentity
      };
    });

    if (result.error) {
      if (result.error === "claim_not_found") {
        reply.code(404).send({ error: result.error });
        return;
      }
      if (
        result.error === "claim_already_activated" ||
        result.error === "claim_expired" ||
        result.error === "claim_cancelled"
      ) {
        reply.code(410).send({ error: result.error });
        return;
      }
      reply.code(403).send({ error: result.error });
      return;
    }

    const bindingPreview = result.binding_request!;

    reply.send({
      status: result.status,
      flow_kind: bindingPreview.flow_kind,
      email: bindingPreview.owner_email,
      claim_expires_at: bindingPreview.claim_token_expires_at,
      requested_identity: {
        owner_display_name: bindingPreview.owner_display_name,
        agent_name: bindingPreview.requested_agent_name,
        slug: bindingPreview.requested_agent_slug,
        description: bindingPreview.requested_agent_description
      },
      decision_options: ownerBindingOptions(bindingPreview.flow_kind),
      existing_identity: result.existing_identity,
      owner_message:
        bindingPreview.flow_kind === "new_registration"
          ? "请确认是否把当前 AI Agent 绑定到这个邮箱并激活 OpenSlaw。"
          : "这个邮箱已经绑定过 OpenSlaw。请选择：迁移换绑到当前 AI Agent、清空历史后重新开始，或者改用其他邮箱。"
    });
  });

  app.post("/api/v1/owners/claims/activate", async (request, reply) => {
    const requestIp = resolveRequestIp(request);
    const ipLimit = takeFixedWindowToken({
      scope: "owner_claim_ip",
      key: requestIp,
      max: config.rateLimits.ownerClaimPerIpMax,
      windowMs: config.rateLimits.ownerClaimPerIpWindowSeconds * 1000
    });
    if (!ipLimit.allowed) {
      ownerClaimRateLimit(reply, ipLimit.retryAfterSeconds);
      return;
    }

    const body = activateClaimSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const resolved = await resolveOwnerBindingRequestFromClaimToken(client, {
        claimToken: body.claim_token,
        email: body.email,
        forUpdate: true
      });

      if ("error" in resolved) {
        return resolved;
      }

      const bindingRequest = resolved.request;
      const allowedActions = ownerBindingOptions(bindingRequest.flow_kind);
      if (!allowedActions.some((action) => action === body.action)) {
        return {
          error: "owner_binding_action_invalid" as const
        };
      }

      if (bindingRequest.flow_kind === "new_registration") {
        if (!bindingRequest.target_user_id || !bindingRequest.target_agent_id) {
          return {
            error: "owner_binding_target_missing" as const
          };
        }

        await client.query(
          `
            UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, NOW()),
                email_verification_code_hash = NULL,
                email_verification_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.target_user_id]
        );

        await client.query(
          `
            UPDATE agent_accounts
            SET status = 'active',
                identity_verification_status = 'verified',
                api_key_hash = $2,
                claim_token_hash = NULL,
                claim_token_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.target_agent_id, bindingRequest.pending_api_key_hash]
        );

        await client.query(
          `
            UPDATE owner_binding_requests
            SET resolution_status = 'activated',
                claim_token_hash = NULL,
                claim_token_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.id]
        );

        const session = await issueOwnerSession(client, bindingRequest.target_user_id, "claim_activation");
        const agent = await loadAgentSummary(client, bindingRequest.target_agent_id);

        return {
          status: "active" as const,
          resolution: body.action,
          email: bindingRequest.owner_email,
          email_verified: true,
          owner_session: session,
          agent
        };
      }

      if (body.action === "use_another_email") {
        await client.query(
          `
            UPDATE owner_binding_requests
            SET resolution_status = 'cancelled',
                claim_token_hash = NULL,
                claim_token_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.id]
        );

        return {
          status: "use_another_email_selected" as const,
          resolution: body.action,
          email: bindingRequest.owner_email,
          next_step: {
            action: "register_with_another_email"
          }
        };
      }

      if (!bindingRequest.target_user_id || !bindingRequest.target_agent_id) {
        return {
          error: "owner_binding_target_missing" as const
        };
      }

      if (body.action === "merge_rebind") {
        await client.query(
          `
            UPDATE users
            SET display_name = $2,
                email_verified_at = COALESCE(email_verified_at, NOW()),
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.target_user_id, bindingRequest.owner_display_name]
        );

        await client.query(
          `
            UPDATE agent_accounts
            SET agent_name = $2,
                description = $3,
                api_key_hash = $4,
                budget_policy_json = $5::jsonb,
                status = 'active',
                identity_verification_status = 'verified',
                claim_token_hash = NULL,
                claim_token_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            bindingRequest.target_agent_id,
            bindingRequest.requested_agent_name,
            bindingRequest.requested_agent_description,
            bindingRequest.pending_api_key_hash,
            json(bindingRequest.requested_budget_policy_json ?? {})
          ]
        );

        await client.query(
          `
            UPDATE owner_binding_requests
            SET resolution_status = 'activated',
                claim_token_hash = NULL,
                claim_token_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [bindingRequest.id]
        );

        const session = await issueOwnerSession(client, bindingRequest.target_user_id, "claim_activation");
        const agent = await loadAgentSummary(client, bindingRequest.target_agent_id);

        return {
          status: "active" as const,
          resolution: body.action,
          email: bindingRequest.owner_email,
          email_verified: true,
          owner_session: session,
          agent
        };
      }

      try {
        await archiveHistoricalIdentity(
          client,
          bindingRequest.target_user_id,
          bindingRequest.owner_email
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "owner_identity_reset_blocked_open_orders"
        ) {
          return {
            error: "owner_identity_reset_blocked_open_orders" as const,
            open_order_count:
              typeof (error as unknown as { openOrderCount?: unknown }).openOrderCount === "number"
                ? (error as unknown as { openOrderCount: number }).openOrderCount
                : 0
          };
        }

        throw error;
      }

      const freshUserResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
      }>(
        `
          INSERT INTO users (
            email,
            display_name,
            role,
            status,
            email_verified_at
          )
          VALUES ($1, $2, 'owner', 'active', NOW())
          RETURNING id, email, display_name
        `,
        [bindingRequest.owner_email, bindingRequest.owner_display_name]
      );

      const resolvedSlug = await resolveUniqueAgentSlug(
        client,
        bindingRequest.requested_agent_slug,
        bindingRequest.requested_agent_name
      );

      const freshAgentResult = await client.query<{
        id: string;
        user_id: string;
        agent_name: string;
        slug: string;
        description: string;
        status: string;
        identity_verification_status: string;
        login_method: string;
      }>(
        `
          INSERT INTO agent_accounts (
            user_id,
            agent_name,
            slug,
            description,
            api_key_hash,
            status,
            budget_policy_json,
            claim_token_hash,
            claim_token_expires_at,
            identity_verification_status
          )
          VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, NULL, NULL, 'verified')
          RETURNING id, user_id, agent_name, slug, description, status,
                    identity_verification_status, login_method
        `,
        [
          freshUserResult.rows[0].id,
          bindingRequest.requested_agent_name,
          resolvedSlug,
          bindingRequest.requested_agent_description,
          bindingRequest.pending_api_key_hash,
          json(bindingRequest.requested_budget_policy_json ?? {})
        ]
      );

      const freshAgent = freshAgentResult.rows[0];
      await ensureRuntimeProfile(client, freshAgent.id);
      await ensureSignupWallet(client, freshAgent.id);

      await client.query(
        `
          UPDATE owner_binding_requests
          SET resolution_status = 'activated',
              target_user_id = $2,
              target_agent_id = $3,
              claim_token_hash = NULL,
              claim_token_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [bindingRequest.id, freshUserResult.rows[0].id, freshAgent.id]
      );

      const session = await issueOwnerSession(client, freshUserResult.rows[0].id, "claim_activation");

      return {
        status: "active" as const,
        resolution: body.action,
        email: bindingRequest.owner_email,
        email_verified: true,
        owner_session: session,
        agent: freshAgent
      };
    });

    if ("error" in result) {
      if (result.error === "claim_not_found") {
        reply.code(404).send({ error: result.error });
        return;
      }
      if (result.error === "owner_binding_action_invalid") {
        reply.code(400).send({ error: result.error });
        return;
      }
      if (result.error === "owner_binding_target_missing") {
        reply.code(409).send({ error: result.error });
        return;
      }
      if (result.error === "owner_identity_reset_blocked_open_orders") {
        reply.code(409).send({
          error: result.error,
          open_order_count: result.open_order_count
        });
        return;
      }
      if (
        result.error === "claim_already_activated" ||
        result.error === "claim_expired" ||
        result.error === "claim_cancelled"
      ) {
        reply.code(410).send({ error: result.error });
        return;
      }
      reply.code(403).send({ error: result.error });
      return;
    }

    reply.send(result);
  });

  app.post("/api/v1/owners/claims/resend", async (request, reply) => {
    const requestIp = resolveRequestIp(request);
    const ipLimit = takeFixedWindowToken({
      scope: "owner_claim_ip",
      key: requestIp,
      max: config.rateLimits.ownerClaimPerIpMax,
      windowMs: config.rateLimits.ownerClaimPerIpWindowSeconds * 1000
    });
    if (!ipLimit.allowed) {
      ownerClaimRateLimit(reply, ipLimit.retryAfterSeconds);
      return;
    }

    const body = resendClaimSchema.parse(request.body);
    const normalizedEmail = body.email.toLowerCase();
    const emailCooldownRemaining = getCooldownRemainingSeconds({
      scope: "owner_claim_email",
      key: normalizedEmail
    });
    if (emailCooldownRemaining > 0) {
      reply.header("Retry-After", String(emailCooldownRemaining));
      reply.code(429).send({
        error: "owner_claim_email_cooldown_active",
        retry_after_seconds: emailCooldownRemaining
      });
      return;
    }

    const origin = resolveOrigin(request);

    const resendResult = await withTransaction(async (client) => {
      const pendingRequest = await getPendingOwnerBindingRequestByEmail(client, normalizedEmail, true);
      if (!pendingRequest) {
        return null;
      }

      const reusedExistingLink =
        pendingRequest.claim_token_hash &&
        pendingRequest.claim_token_expires_at &&
        new Date(pendingRequest.claim_token_expires_at).getTime() > Date.now();
      const claimExpiresAt =
        reusedExistingLink && pendingRequest.claim_token_expires_at
          ? pendingRequest.claim_token_expires_at
          : new Date(Date.now() + config.ownerClaimTtlHours * 60 * 60 * 1000).toISOString();
      const claimToken = buildOwnerClaimToken(pendingRequest.id, normalizedEmail, claimExpiresAt);
      const claimTokenHash = hashApiKey(claimToken);
      const updated = await client.query(
        `
          UPDATE owner_binding_requests
          SET claim_token_hash = $2,
              claim_token_expires_at = $3::timestamptz,
              updated_at = NOW()
          WHERE id = $1
          RETURNING requested_agent_name, flow_kind
        `,
        [pendingRequest.id, claimTokenHash, claimExpiresAt]
      );

      return {
        pendingRequest,
        requestedAgentName:
          updated.rows[0]?.requested_agent_name ?? pendingRequest.requested_agent_name,
        flowKind:
          updated.rows[0]?.flow_kind ??
          pendingRequest.flow_kind,
        reusedExistingLink,
        claimExpiresAt,
        claimToken
      };
    });

    setCooldown({
      scope: "owner_claim_email",
      key: normalizedEmail,
      cooldownMs: config.rateLimits.ownerClaimEmailCooldownSeconds * 1000
    });

    if (!resendResult) {
      reply.send({
        status: "claim_email_accepted",
        delivery: {
          status: "skipped",
          reason: "pending_binding_not_found"
        }
      });
      return;
    }

    const claimEmail = buildOwnerClaimEmail({
      origin,
      ownerEmail: normalizedEmail,
      agentName: resendResult.requestedAgentName,
      flowKind: resendResult.flowKind,
      claimToken: resendResult.claimToken,
      expiresAt: resendResult.claimExpiresAt
    });

    try {
      const delivery = await sendPlatformEmail({
        to: normalizedEmail,
        subject: claimEmail.subject,
        text: claimEmail.text,
        html: claimEmail.html
      });

      reply.send({
        status: resendResult.reusedExistingLink ? "claim_link_resent" : "claim_link_refreshed",
        claim_expires_at: resendResult.claimExpiresAt,
        delivery,
        ...(config.email.debugExposeSecrets
          ? {
              debug: {
                claim_url: claimEmail.claim_url,
                claim_token: resendResult.claimToken
              }
            }
          : {})
      });
    } catch (error) {
      request.log.error(error, "owner claim resend delivery failed");
      reply.code(503).send({
        error: "owner_claim_email_delivery_failed"
      });
    }
  });
}
