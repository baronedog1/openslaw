import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateOwner, issueOwnerSession } from "../auth.js";
import { config } from "../config.js";
import { withTransaction } from "../db.js";
import { sendPlatformEmail } from "../email/mailer.js";
import { buildOwnerLoginEmail } from "../email/templates.js";
import {
  getCooldownRemainingSeconds,
  resolveRequestIp,
  setCooldown,
  takeFixedWindowToken
} from "../domain/requestGuards.js";
import { buildOwnerLoginToken, hashApiKey, parseOwnerLoginToken } from "../utils.js";

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

const requestLoginSchema = z.object({
  email: z.string().email()
});

const exchangeLoginSchema = z.object({
  email: z.string().email(),
  login_token: z.string().min(1)
});

function sendRateLimitResponse(reply: any, errorCode: string, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.code(429).send({
    error: errorCode,
    retry_after_seconds: retryAfterSeconds
  });
}

export async function registerOwnerAuthRoutes(app: FastifyInstance) {
  app.post("/api/v1/owners/auth/request-login-link", async (request, reply) => {
    const body = requestLoginSchema.parse(request.body);
    const requestIp = resolveRequestIp(request);
    const ipLimit = takeFixedWindowToken({
      scope: "owner_login_ip",
      key: requestIp,
      max: config.rateLimits.ownerLoginPerIpMax,
      windowMs: config.rateLimits.ownerLoginPerIpWindowSeconds * 1000
    });
    if (!ipLimit.allowed) {
      sendRateLimitResponse(reply, "owner_login_rate_limited", ipLimit.retryAfterSeconds);
      return;
    }

    const normalizedEmail = body.email.toLowerCase();
    const emailCooldownRemaining = getCooldownRemainingSeconds({
      scope: "owner_login_email",
      key: normalizedEmail
    });
    if (emailCooldownRemaining > 0) {
      sendRateLimitResponse(reply, "owner_login_email_cooldown_active", emailCooldownRemaining);
      return;
    }

    const origin = resolveOrigin(request);

    const owner = await withTransaction(async (client) => {
      const userResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
        status: string;
        email_verified_at: string | null;
        web_login_token_hash: string | null;
        web_login_token_expires_at: string | null;
      }>(
        `
          SELECT id, email, display_name, status, email_verified_at,
                 web_login_token_hash, web_login_token_expires_at
          FROM users
          WHERE email = $1
            AND role = 'owner'
          LIMIT 1
          FOR UPDATE
        `,
        [normalizedEmail]
      );

      const user = userResult.rows[0];
      if (!user) {
        return null;
      }

      if (user.status !== "active") {
        throw new Error("owner_suspended");
      }

      const activeTokenExpiresAt =
        user.web_login_token_hash &&
        user.web_login_token_expires_at &&
        new Date(user.web_login_token_expires_at).getTime() > Date.now()
          ? user.web_login_token_expires_at
          : null;
      const expiresAt =
        activeTokenExpiresAt ??
        new Date(Date.now() + config.ownerLoginLinkTtlMinutes * 60 * 1000).toISOString();
      const loginToken = buildOwnerLoginToken(user.id, user.email, expiresAt);
      const loginTokenHash = hashApiKey(loginToken);

      await client.query(
        `
          UPDATE users
          SET web_login_token_hash = $2,
              web_login_token_expires_at = $3::timestamptz,
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id, loginTokenHash, expiresAt]
      );

      return {
        ...user,
        login_token: loginToken,
        login_expires_at: expiresAt,
        reused_existing_link: activeTokenExpiresAt === expiresAt
      };
    }).catch((error: Error) => {
      if (error.message === "owner_suspended") {
        reply.code(403).send({
          error: error.message
        });
        return null;
      }

      throw error;
    });

    if (reply.sent) {
      return;
    }

    if (!owner) {
      setCooldown({
        scope: "owner_login_email",
        key: normalizedEmail,
        cooldownMs: config.rateLimits.ownerLoginEmailCooldownSeconds * 1000
      });
      reply.send({
        status: "login_link_accepted",
        delivery: {
          status: "skipped",
          reason: "owner_not_found"
        }
      });
      return;
    }

    const emailPayload = buildOwnerLoginEmail({
      origin,
      ownerEmail: owner.email,
      displayName: owner.display_name,
      loginToken: owner.login_token,
      expiresAt: owner.login_expires_at
    });

    try {
      const delivery = await sendPlatformEmail({
        to: owner.email,
        subject: emailPayload.subject,
        text: emailPayload.text,
        html: emailPayload.html
      });

      setCooldown({
        scope: "owner_login_email",
        key: normalizedEmail,
        cooldownMs: config.rateLimits.ownerLoginEmailCooldownSeconds * 1000
      });

      reply.send({
        status: owner.reused_existing_link ? "login_link_resent" : "login_link_sent",
        delivery,
        ...(config.email.debugExposeSecrets
          ? {
              debug: {
                login_url: emailPayload.login_url
              }
            }
          : {})
      });
    } catch (error) {
      request.log.error(error, "owner login email delivery failed");
      setCooldown({
        scope: "owner_login_email",
        key: normalizedEmail,
        cooldownMs: config.rateLimits.ownerLoginEmailCooldownSeconds * 1000
      });
      reply.code(503).send({
        error: "owner_login_email_delivery_failed"
      });
    }
  });

  app.post("/api/v1/owners/auth/exchange-link", async (request, reply) => {
    const body = exchangeLoginSchema.parse(request.body);
    const normalizedEmail = body.email.toLowerCase();
    const parsedToken = parseOwnerLoginToken(body.login_token);

    if (!parsedToken) {
      reply.code(403).send({ error: "owner_login_token_invalid" });
      return;
    }

    if (parsedToken.email !== normalizedEmail) {
      reply.code(403).send({ error: "owner_login_token_invalid" });
      return;
    }

    const loginTokenHash = hashApiKey(body.login_token);

    const result = await withTransaction(async (client) => {
      const userResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        status: string;
        email_verified_at: string | null;
        web_login_token_hash: string | null;
        web_login_token_expires_at: string | null;
      }>(
        `
          SELECT id, email, display_name, role, status, email_verified_at,
                 web_login_token_hash, web_login_token_expires_at
          FROM users
          WHERE id = $1
            AND email = $2
            AND role = 'owner'
          LIMIT 1
          FOR UPDATE
        `,
        [parsedToken.subject_id, normalizedEmail]
      );

      const user = userResult.rows[0];
      if (!user) {
        throw new Error("owner_login_token_invalid");
      }

      if (user.status !== "active") {
        throw new Error("owner_suspended");
      }

      if (loginTokenHash !== user.web_login_token_hash) {
        throw new Error("owner_login_token_invalid");
      }

      const loginExpiresAtMs = user.web_login_token_expires_at
        ? new Date(user.web_login_token_expires_at).getTime()
        : Number.NaN;
      const tokenExpiresAtMs = new Date(parsedToken.expires_at).getTime();

      if (
        !user.web_login_token_expires_at ||
        Number.isNaN(loginExpiresAtMs) ||
        Number.isNaN(tokenExpiresAtMs) ||
        loginExpiresAtMs < Date.now() ||
        tokenExpiresAtMs < Date.now() ||
        loginExpiresAtMs !== tokenExpiresAtMs
      ) {
        throw new Error("owner_login_token_expired");
      }

      await client.query(
        `
          UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id]
      );

      const session = await issueOwnerSession(client, user.id, "email_magic_link");

      await client.query(
        `
          UPDATE users
          SET web_login_token_hash = NULL,
              web_login_token_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id]
      );

      const refreshedUserResult = await client.query<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        status: string;
        email_verified_at: string | null;
        last_web_login_at: string | null;
        web_login_method: "email_magic_link" | "claim_activation" | null;
      }>(
        `
          SELECT id, email, display_name, role, status, email_verified_at, last_web_login_at, web_login_method
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [user.id]
      );

      return {
        owner: refreshedUserResult.rows[0],
        session
      };
    }).catch((error: Error) => {
      if (["owner_login_token_invalid", "owner_login_token_expired", "owner_suspended"].includes(error.message)) {
        reply.code(
          error.message === "owner_login_token_invalid"
            ? 403
            : error.message === "owner_login_token_expired"
              ? 410
              : 403
        ).send({
          error: error.message
        });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    reply.send({
      owner: result.owner,
      session: result.session
    });
  });

  app.post("/api/v1/owners/auth/logout", async (request, reply) => {
    const owner = await authenticateOwner(request, reply);
    if (!owner) {
      return;
    }

    await withTransaction(async (client) => {
      await client.query(
        `
          UPDATE users
          SET web_session_token_hash = NULL,
              web_session_token_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [owner.id]
      );
    });

    reply.send({
      status: "logged_out"
    });
  });
}
