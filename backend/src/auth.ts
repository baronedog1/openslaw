import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { query } from "./db.js";
import { generateOwnerSessionToken, hashApiKey } from "./utils.js";

export type AuthenticatedAgent = {
  id: string;
  user_id: string;
  user_role: "owner" | "admin";
  agent_name: string;
  slug: string;
  description: string;
  status: string;
  budget_policy_json: Record<string, unknown> | null;
  identity_verification_status: string;
  login_method: string;
};

export type AgentAuthLookup = AuthenticatedAgent;

export type AuthenticatedOwner = {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "admin";
  status: string;
  email_verified_at: string | null;
  last_web_login_at: string | null;
  web_login_method: "email_magic_link" | "claim_activation" | null;
  membership_tier: "standard" | "member_large_attachment_1gb";
  membership_starts_at: string | null;
  membership_expires_at: string | null;
  membership_note: string;
};

export async function findAgentByBearerToken(
  authorization: string | undefined
): Promise<AuthenticatedAgent | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const apiKeyHash = hashApiKey(token);

  const result = await query<AuthenticatedAgent>(
    `
      SELECT aa.id, aa.user_id, u.role AS user_role, aa.agent_name, aa.slug, aa.description,
             aa.status, aa.budget_policy_json, aa.identity_verification_status, aa.login_method
      FROM agent_accounts aa
      JOIN users u ON u.id = aa.user_id
      WHERE api_key_hash = $1
      LIMIT 1
    `,
    [apiKeyHash]
  );

  return result.rows[0] ?? null;
}

export async function authenticateAgent(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedAgent | null> {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing_bearer_token" });
    return null;
  }
  const agent = await findAgentByBearerToken(authorization);

  if (!agent) {
    reply.code(401).send({ error: "invalid_api_key" });
    return null;
  }

  if (agent.status !== "active") {
    reply.code(403).send({ error: "agent_not_active" });
    return null;
  }

  await query(
    `
      UPDATE agent_accounts
      SET last_login_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `,
    [agent.id]
  );

  return agent;
}

export async function findOwnerByBearerToken(
  authorization: string | undefined
): Promise<AuthenticatedOwner | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const tokenHash = hashApiKey(token);

  const result = await query<AuthenticatedOwner>(
    `
      SELECT id,
             email,
             display_name,
             role,
             status,
             email_verified_at,
             last_web_login_at,
             web_login_method,
             membership_tier,
             membership_starts_at,
             membership_expires_at,
             membership_note
      FROM users
      WHERE web_session_token_hash = $1
        AND (web_session_token_expires_at IS NULL OR web_session_token_expires_at > NOW())
      LIMIT 1
    `,
    [tokenHash]
  );

  return result.rows[0] ?? null;
}

export async function authenticateOwner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedOwner | null> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing_bearer_token" });
    return null;
  }

  const owner = await findOwnerByBearerToken(authorization);
  if (!owner) {
    reply.code(401).send({ error: "invalid_owner_session" });
    return null;
  }

  if (owner.status !== "active") {
    reply.code(403).send({ error: "owner_not_active" });
    return null;
  }

  return owner;
}

export async function issueOwnerSession(
  client: PoolClient,
  userId: string,
  loginMethod: "email_magic_link" | "claim_activation"
) {
  const sessionToken = generateOwnerSessionToken();
  const sessionTokenHash = hashApiKey(sessionToken);
  const expiresAt = new Date(
    Date.now() + config.ownerSessionTtlHours * 60 * 60 * 1000
  ).toISOString();

  await client.query(
    `
      UPDATE users
      SET web_session_token_hash = $2,
          web_session_token_expires_at = $3::timestamptz,
          last_web_login_at = NOW(),
          web_login_method = $4,
          updated_at = NOW()
      WHERE id = $1
    `,
    [userId, sessionTokenHash, expiresAt, loginMethod]
  );

  return {
    session_token: sessionToken,
    expires_at: expiresAt
  };
}

export async function requireAdminAgent(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedAgent | null> {
  const agent = await authenticateAgent(request, reply);
  if (!agent) {
    return null;
  }

  if (agent.user_role !== "admin") {
    reply.code(403).send({ error: "admin_forbidden" });
    return null;
  }

  return agent;
}
