import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sendPlatformEmail } from "../email/mailer.js";
import { buildOwnerClaimEmail } from "../email/templates.js";
import { config } from "../config.js";
import { findAgentByBearerToken } from "../auth.js";
import {
  type OwnerBindingFlowKind,
  upsertOwnerBindingRequest
} from "../domain/ownerBindingRequests.js";
import { ensureSignupWallet } from "../domain/ownerIdentity.js";
import {
  getCooldownRemainingSeconds,
  resolveRequestIp,
  setCooldown,
  takeFixedWindowToken
} from "../domain/requestGuards.js";
import { ensureRuntimeProfile } from "../domain/runtimeProfiles.js";
import { withTransaction } from "../db.js";
import {
  buildAgentSlug,
  generateApiKey,
  hashApiKey,
  json
} from "../utils.js";

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

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const registerSchema = z.object({
  email: z.string().email(),
  display_name: optionalTrimmedString,
  agent_name: optionalTrimmedString,
  description: z.string().optional(),
  slug: optionalTrimmedString,
  budget_policy: z.record(z.any()).optional(),
  existing_email_mode: z.enum(["prompt_resolution"]).default("prompt_resolution")
});

function deriveOwnerDisplayName(email: string): string {
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) {
    return "OpenSlaw Owner";
  }

  const normalized = localPart.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized || "OpenSlaw Owner";
}

function resolveOwnerDisplayName(
  email: string,
  providedDisplayName: string | undefined,
  existingDisplayName: string | undefined
): string {
  if (providedDisplayName) {
    return providedDisplayName;
  }

  const normalizedExisting = existingDisplayName?.trim();
  if (normalizedExisting) {
    return normalizedExisting;
  }

  return deriveOwnerDisplayName(email);
}

function resolveAgentName(providedAgentName: string | undefined): string {
  return providedAgentName ?? "OpenSlaw Agent";
}

function sendRateLimitResponse(reply: any, errorCode: string, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.code(429).send({
    error: errorCode,
    retry_after_seconds: retryAfterSeconds
  });
}

function readBearerToken(authorization: string | undefined) {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length ? token : null;
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.get("/api/v1/agents/status", async (request, reply) => {
    const bearerToken = readBearerToken(request.headers.authorization);
    if (!bearerToken) {
      reply.code(401).send({ error: "invalid_api_key" });
      return;
    }

    const apiKeyHash = hashApiKey(bearerToken);
    const agent = await findAgentByBearerToken(request.headers.authorization);
    if (!agent) {
      const pendingResult = await withTransaction(async (client) => {
        const requestResult = await client.query<{
          id: string;
          target_agent_id: string | null;
          requested_agent_name: string;
          requested_agent_slug: string;
          flow_kind: OwnerBindingFlowKind;
        }>(
          `
            SELECT id, target_agent_id, requested_agent_name, requested_agent_slug, flow_kind
            FROM owner_binding_requests
            WHERE pending_api_key_hash = $1
              AND resolution_status = 'pending'
            LIMIT 1
          `,
          [apiKeyHash]
        );

        return requestResult.rows[0] ?? null;
      });

      if (!pendingResult) {
        reply.code(401).send({ error: "invalid_api_key" });
        return;
      }

      reply.send({
        agent_id: pendingResult.target_agent_id ?? pendingResult.id,
        agent_name: pendingResult.requested_agent_name,
        slug: pendingResult.requested_agent_slug,
        status: "pending_claim",
        identity_verification_status: "unverified",
        login_method: "api_key",
        registration_flow: pendingResult.flow_kind
      });
      return;
    }

    const pendingBinding = await withTransaction(async (client) => {
      const requestResult = await client.query<{
        flow_kind: OwnerBindingFlowKind;
      }>(
        `
          SELECT flow_kind
          FROM owner_binding_requests
          WHERE pending_api_key_hash = $1
            AND resolution_status = 'pending'
          LIMIT 1
        `,
        [apiKeyHash]
      );

      return requestResult.rows[0] ?? null;
    });

    reply.send({
      agent_id: agent.id,
      agent_name: agent.agent_name,
      slug: agent.slug,
      status: agent.status,
      identity_verification_status: agent.identity_verification_status,
      login_method: agent.login_method,
      registration_flow: pendingBinding?.flow_kind ?? "active_identity"
    });
  });

  app.post("/api/v1/agents/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const requestIp = resolveRequestIp(request);
    const ipLimit = takeFixedWindowToken({
      scope: "agent_register_ip",
      key: requestIp,
      max: config.rateLimits.registerPerIpMax,
      windowMs: config.rateLimits.registerPerIpWindowSeconds * 1000
    });
    if (!ipLimit.allowed) {
      sendRateLimitResponse(reply, "register_rate_limited", ipLimit.retryAfterSeconds);
      return;
    }

    const normalizedEmail = body.email.toLowerCase();
    const emailCooldownRemaining = getCooldownRemainingSeconds({
      scope: "agent_register_email",
      key: normalizedEmail
    });
    if (emailCooldownRemaining > 0) {
      sendRateLimitResponse(reply, "register_email_cooldown_active", emailCooldownRemaining);
      return;
    }

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const origin = resolveOrigin(request);

    const result = await withTransaction(async (client) => {
      const existingUserResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
        email_verified_at: string | null;
      }>(
        `
          SELECT id, email, display_name, email_verified_at
          FROM users
          WHERE email = $1
          LIMIT 1
          FOR UPDATE
        `,
        [normalizedEmail]
      );

      const existingUser = existingUserResult.rows[0];
      const existingAgentsResult = existingUser
        ? await client.query<{
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
              WHERE user_id = $1
              ORDER BY updated_at DESC, created_at DESC
              FOR UPDATE
            `,
            [existingUser.id]
          )
        : { rows: [] as Array<{
            id: string;
            user_id: string;
            agent_name: string;
            slug: string;
            description: string;
            status: string;
            identity_verification_status: string;
            login_method: string;
          }> };

      const existingAgents = existingAgentsResult.rows;
      const pendingAgents = existingAgents.filter((row) => row.status === "pending_claim");
      const historicalAgents = existingAgents.filter((row) => row.status !== "pending_claim");

      const displayName = resolveOwnerDisplayName(
        body.email,
        body.display_name,
        existingUser?.display_name
      );
      const agentName = resolveAgentName(body.agent_name);
      const description = body.description?.trim() ?? "";
      const requestedSlug = body.slug ?? buildAgentSlug(agentName);

      if (existingUser && !historicalAgents.length) {
        await client.query(
          `
            UPDATE users
            SET display_name = $2,
                email_verification_code_hash = NULL,
                email_verification_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `,
          [existingUser.id, displayName]
        );
      }

      let user: {
        id: string;
        email: string;
        display_name: string;
        email_verified_at: string | null;
      };

      if (existingUser && !historicalAgents.length) {
        const userResult = await client.query<{
          id: string;
          email: string;
          display_name: string;
          email_verified_at: string | null;
        }>(
          `
            UPDATE users
            SET display_name = $2,
                email_verification_code_hash = NULL,
                email_verification_expires_at = NULL,
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, email, display_name, email_verified_at
          `,
          [existingUser.id, displayName]
        );
        user = userResult.rows[0];
      } else if (existingUser) {
        user = existingUser;
      } else {
        const userResult = await client.query<{
          id: string;
          email: string;
          display_name: string;
          email_verified_at: string | null;
        }>(
          `
            INSERT INTO users (
              email,
              display_name,
              role,
              status
            )
            VALUES ($1, $2, 'owner', 'active')
            RETURNING id, email, display_name, email_verified_at
          `,
          [normalizedEmail, displayName]
        );
        user = userResult.rows[0];
      }
      let responseAgent: {
        id: string | null;
        user_id: string | null;
        agent_name: string;
        slug: string;
        description: string;
        status: string;
        identity_verification_status: string;
        login_method: string;
      };
      let wallet:
        | {
            id: string;
            available_balance: number;
            held_balance: number;
          }
        | null = null;
      let runtimeProfile: Record<string, unknown> | null = null;
      let flowKind: OwnerBindingFlowKind;
      let targetAgentId: string | null = null;

      if (!historicalAgents.length) {
        const preferredPendingAgent = pendingAgents[0];

        if (pendingAgents.length > 1) {
          await client.query(
            `
              UPDATE agent_accounts
              SET status = 'suspended',
                  claim_token_hash = NULL,
                  claim_token_expires_at = NULL,
                  updated_at = NOW()
              WHERE user_id = $1
                AND status = 'pending_claim'
                AND id <> $2
            `,
            [user.id, preferredPendingAgent.id]
          );
        }

        const agentResult = preferredPendingAgent
          ? await client.query<{
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
                UPDATE agent_accounts
                SET agent_name = $2,
                    slug = $3,
                    description = $4,
                    api_key_hash = $5,
                    budget_policy_json = $6::jsonb,
                    status = 'pending_claim',
                    claim_token_hash = NULL,
                    claim_token_expires_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, agent_name, slug, description, status,
                          identity_verification_status, login_method
              `,
              [
                preferredPendingAgent.id,
                agentName,
                body.slug ? requestedSlug : preferredPendingAgent.slug,
                description,
                apiKeyHash,
                json(body.budget_policy ?? {})
              ]
            )
          : await client.query<{
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
                  claim_token_expires_at
                )
                VALUES ($1, $2, $3, $4, $5, 'pending_claim', $6::jsonb, NULL, NULL)
                RETURNING id, user_id, agent_name, slug, description, status,
                          identity_verification_status, login_method
              `,
              [
                user.id,
                agentName,
                requestedSlug,
                description,
                apiKeyHash,
                json(body.budget_policy ?? {})
              ]
            );

        const pendingAgent = agentResult.rows[0];
        targetAgentId = pendingAgent.id;
        flowKind = "new_registration";

        await ensureRuntimeProfile(client, pendingAgent.id);
        const runtimeProfileResult = await client.query(
          `
            SELECT id, agent_account_id, accept_mode, claimed_max_concurrency, validated_max_concurrency,
                   queue_enabled, current_active_order_count, supports_parallel_delivery,
                   supports_a2a, a2a_agent_card_url, provider_callback_url, callback_timeout_seconds,
                   relay_connection_status, relay_connected_at, relay_last_activity_at,
                   relay_lease_expires_at, relay_last_disconnect_reason
            FROM agent_runtime_profiles
            WHERE agent_account_id = $1
            LIMIT 1
          `,
          [pendingAgent.id]
        );
        runtimeProfile = runtimeProfileResult.rows[0] ?? null;
        wallet = await ensureSignupWallet(client, pendingAgent.id);
        responseAgent = pendingAgent;
      } else {
        const historicalAgent =
          historicalAgents.find((row) => row.status === "active") ?? historicalAgents[0];
        flowKind = "existing_email_resolution";
        targetAgentId = historicalAgent.id;

        const runtimeProfileResult = await client.query(
          `
            SELECT id, agent_account_id, accept_mode, claimed_max_concurrency, validated_max_concurrency,
                   queue_enabled, current_active_order_count, supports_parallel_delivery,
                   supports_a2a, a2a_agent_card_url, provider_callback_url, callback_timeout_seconds,
                   relay_connection_status, relay_connected_at, relay_last_activity_at,
                   relay_lease_expires_at, relay_last_disconnect_reason
            FROM agent_runtime_profiles
            WHERE agent_account_id = $1
            LIMIT 1
          `,
          [historicalAgent.id]
        );
        runtimeProfile = runtimeProfileResult.rows[0] ?? null;
        const walletResult = await client.query<{
          id: string;
          available_balance: number;
          held_balance: number;
        }>(
          `
            SELECT id, available_balance, held_balance
            FROM wallet_accounts
            WHERE agent_account_id = $1
            LIMIT 1
          `,
          [historicalAgent.id]
        );
        wallet = walletResult.rows[0] ?? null;
        responseAgent = {
          id: historicalAgent.id,
          user_id: historicalAgent.user_id,
          agent_name: agentName,
          slug: body.slug ? requestedSlug : historicalAgent.slug,
          description,
          status: "pending_claim",
          identity_verification_status: "unverified",
          login_method: "api_key"
        };
      }

      const bindingRequest = await upsertOwnerBindingRequest(client, {
        ownerEmail: user.email,
        ownerDisplayName: user.display_name,
        requestedAgentName: agentName,
        requestedAgentSlug: responseAgent.slug,
        requestedAgentDescription: description,
        requestedBudgetPolicy: body.budget_policy ?? {},
        pendingApiKeyHash: apiKeyHash,
        targetUserId: user.id,
        targetAgentId,
        flowKind
      });

      return {
        user,
        agent: responseAgent,
        wallet,
        runtime_profile: runtimeProfile,
        binding_request: bindingRequest.request,
        activation: {
          flow_kind: flowKind,
          claim_expires_at: bindingRequest.claimExpiresAt,
          email: user.email,
          decision_options:
            flowKind === "new_registration"
              ? ["confirm_bind"]
              : ["merge_rebind", "reset_rebind", "use_another_email"],
          secrets: {
            claim_token: bindingRequest.claimToken
          }
        }
      };
    });

    setCooldown({
      scope: "agent_register_email",
      key: normalizedEmail,
      cooldownMs: config.rateLimits.registerEmailCooldownSeconds * 1000
    });

    const claimEmail = buildOwnerClaimEmail({
      origin,
      ownerEmail: result.activation.email,
      agentName: result.agent.agent_name,
      flowKind: result.activation.flow_kind,
      claimToken: result.activation.secrets.claim_token,
      expiresAt: result.activation.claim_expires_at
    });

    let emailDelivery:
      | {
          status: "sent";
          mode: "console" | "smtp";
          recipient: string;
          message_id: string;
        }
      | {
          status: "failed";
          mode: "console" | "smtp";
          recipient: string;
          reason: string;
        };

    try {
      const delivery = await sendPlatformEmail({
        to: result.activation.email,
        subject: claimEmail.subject,
        text: claimEmail.text,
        html: claimEmail.html
      });
      emailDelivery = delivery;
    } catch (error) {
      app.log.error(error, "owner claim email delivery failed");
      emailDelivery = {
        status: "failed",
        mode: config.email.mode,
        recipient: result.activation.email,
        reason: "owner_claim_email_delivery_failed"
      };
    }

    reply.code(201).send({
      user: result.user,
      agent: result.agent,
      wallet: {
        id: result.wallet?.id ?? null,
        available_balance: Number(result.wallet?.available_balance ?? 0),
        held_balance: Number(result.wallet?.held_balance ?? 0)
      },
      runtime_profile: result.runtime_profile,
      api_key: apiKey,
      activation: {
        status: "owner_email_confirmation_required",
        flow_kind: result.activation.flow_kind,
        claim_expires_at: result.activation.claim_expires_at,
        email: result.activation.email,
        resolution_required: result.activation.flow_kind === "existing_email_resolution",
        owner_action:
          result.activation.flow_kind === "existing_email_resolution"
            ? "open_email_and_choose_resolution"
            : "open_email_and_confirm_binding",
        decision_options: result.activation.decision_options,
        claim_delivery: emailDelivery,
        ...(config.email.debugExposeSecrets
          ? {
              claim_url: claimEmail.claim_url,
              claim_token: result.activation.secrets.claim_token
            }
          : {})
      }
    });
  });
}
