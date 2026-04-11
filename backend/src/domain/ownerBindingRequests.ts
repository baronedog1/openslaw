import type { PoolClient } from "pg";
import { config } from "../config.js";
import { buildOwnerClaimToken, hashApiKey, parseOwnerClaimToken } from "../utils.js";

export const ownerBindingFlowKinds = ["new_registration", "existing_email_resolution"] as const;
export type OwnerBindingFlowKind = (typeof ownerBindingFlowKinds)[number];

export const ownerBindingActions = [
  "confirm_bind",
  "merge_rebind",
  "reset_rebind",
  "use_another_email"
] as const;
export type OwnerBindingAction = (typeof ownerBindingActions)[number];

export const ownerBindingPendingStatuses = ["pending", "activated", "cancelled"] as const;
export type OwnerBindingResolutionStatus = (typeof ownerBindingPendingStatuses)[number];

export type OwnerBindingRequestRow = {
  id: string;
  owner_email: string;
  owner_display_name: string;
  requested_agent_name: string;
  requested_agent_slug: string;
  requested_agent_description: string;
  requested_budget_policy_json: Record<string, unknown> | null;
  pending_api_key_hash: string;
  target_user_id: string | null;
  target_agent_id: string | null;
  flow_kind: OwnerBindingFlowKind;
  resolution_status: OwnerBindingResolutionStatus;
  claim_token_hash: string | null;
  claim_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function ownerBindingOptions(flowKind: OwnerBindingFlowKind) {
  return flowKind === "new_registration"
    ? (["confirm_bind"] as const)
    : (["merge_rebind", "reset_rebind", "use_another_email"] as const);
}

function isFuture(value: string | null) {
  return Boolean(value) && new Date(value as string).getTime() > Date.now();
}

export async function getPendingOwnerBindingRequestByEmail(
  client: PoolClient,
  ownerEmail: string,
  forUpdate = false
) {
  const result = await client.query<OwnerBindingRequestRow>(
    `
      SELECT id,
             owner_email,
             owner_display_name,
             requested_agent_name,
             requested_agent_slug,
             requested_agent_description,
             requested_budget_policy_json,
             pending_api_key_hash,
             target_user_id,
             target_agent_id,
             flow_kind,
             resolution_status,
             claim_token_hash,
             claim_token_expires_at,
             created_at,
             updated_at
      FROM owner_binding_requests
      WHERE owner_email = $1
        AND resolution_status = 'pending'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [ownerEmail]
  );

  return result.rows[0] ?? null;
}

export async function upsertOwnerBindingRequest(
  client: PoolClient,
  input: {
    ownerEmail: string;
    ownerDisplayName: string;
    requestedAgentName: string;
    requestedAgentSlug: string;
    requestedAgentDescription: string;
    requestedBudgetPolicy: Record<string, unknown>;
    pendingApiKeyHash: string;
    targetUserId: string | null;
    targetAgentId: string | null;
    flowKind: OwnerBindingFlowKind;
  }
) {
  const existing = await getPendingOwnerBindingRequestByEmail(client, input.ownerEmail, true);
  const reusedExistingLink =
    existing?.claim_token_hash &&
    existing.claim_token_expires_at &&
    isFuture(existing.claim_token_expires_at);
  const claimExpiresAt =
    reusedExistingLink && existing?.claim_token_expires_at
      ? existing.claim_token_expires_at
      : new Date(Date.now() + config.ownerClaimTtlHours * 60 * 60 * 1000).toISOString();

  if (existing) {
    const claimToken = buildOwnerClaimToken(existing.id, input.ownerEmail, claimExpiresAt);
    const claimTokenHash = hashApiKey(claimToken);
    const updated = await client.query<OwnerBindingRequestRow>(
      `
        UPDATE owner_binding_requests
        SET owner_display_name = $2,
            requested_agent_name = $3,
            requested_agent_slug = $4,
            requested_agent_description = $5,
            requested_budget_policy_json = $6::jsonb,
            pending_api_key_hash = $7,
            target_user_id = $8,
            target_agent_id = $9,
            flow_kind = $10,
            claim_token_hash = $11,
            claim_token_expires_at = $12::timestamptz,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id,
                  owner_email,
                  owner_display_name,
                  requested_agent_name,
                  requested_agent_slug,
                  requested_agent_description,
                  requested_budget_policy_json,
                  pending_api_key_hash,
                  target_user_id,
                  target_agent_id,
                  flow_kind,
                  resolution_status,
                  claim_token_hash,
                  claim_token_expires_at,
                  created_at,
                  updated_at
      `,
      [
        existing.id,
        input.ownerDisplayName,
        input.requestedAgentName,
        input.requestedAgentSlug,
        input.requestedAgentDescription,
        JSON.stringify(input.requestedBudgetPolicy ?? {}),
        input.pendingApiKeyHash,
        input.targetUserId,
        input.targetAgentId,
        input.flowKind,
        claimTokenHash,
        claimExpiresAt
      ]
    );

    return {
      request: updated.rows[0],
      claimToken,
      claimExpiresAt,
      reusedExistingLink: Boolean(reusedExistingLink)
    };
  }

  const inserted = await client.query<OwnerBindingRequestRow>(
    `
      INSERT INTO owner_binding_requests (
        owner_email,
        owner_display_name,
        requested_agent_name,
        requested_agent_slug,
        requested_agent_description,
        requested_budget_policy_json,
        pending_api_key_hash,
        target_user_id,
        target_agent_id,
        flow_kind,
        resolution_status
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, 'pending')
      RETURNING id,
                owner_email,
                owner_display_name,
                requested_agent_name,
                requested_agent_slug,
                requested_agent_description,
                requested_budget_policy_json,
                pending_api_key_hash,
                target_user_id,
                target_agent_id,
                flow_kind,
                resolution_status,
                claim_token_hash,
                claim_token_expires_at,
                created_at,
                updated_at
    `,
    [
      input.ownerEmail,
      input.ownerDisplayName,
      input.requestedAgentName,
      input.requestedAgentSlug,
      input.requestedAgentDescription,
      JSON.stringify(input.requestedBudgetPolicy ?? {}),
      input.pendingApiKeyHash,
      input.targetUserId,
      input.targetAgentId,
      input.flowKind
    ]
  );

  const request = inserted.rows[0];
  const claimToken = buildOwnerClaimToken(request.id, input.ownerEmail, claimExpiresAt);
  const claimTokenHash = hashApiKey(claimToken);
  const updated = await client.query<OwnerBindingRequestRow>(
    `
      UPDATE owner_binding_requests
      SET claim_token_hash = $2,
          claim_token_expires_at = $3::timestamptz,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id,
                owner_email,
                owner_display_name,
                requested_agent_name,
                requested_agent_slug,
                requested_agent_description,
                requested_budget_policy_json,
                pending_api_key_hash,
                target_user_id,
                target_agent_id,
                flow_kind,
                resolution_status,
                claim_token_hash,
                claim_token_expires_at,
                created_at,
                updated_at
    `,
    [request.id, claimTokenHash, claimExpiresAt]
  );

  return {
    request: updated.rows[0],
    claimToken,
    claimExpiresAt,
    reusedExistingLink: false
  };
}

export async function resolveOwnerBindingRequestFromClaimToken(
  client: PoolClient,
  input: {
    claimToken: string;
    email: string;
    forUpdate?: boolean;
  }
) {
  const parsedToken = parseOwnerClaimToken(input.claimToken);
  if (!parsedToken) {
    return {
      error: "claim_token_invalid" as const
    };
  }

  const normalizedEmail = input.email.toLowerCase();
  if (parsedToken.email !== normalizedEmail) {
    return {
      error: "claim_email_mismatch" as const
    };
  }

  const claimResult = await client.query<OwnerBindingRequestRow>(
    `
      SELECT id,
             owner_email,
             owner_display_name,
             requested_agent_name,
             requested_agent_slug,
             requested_agent_description,
             requested_budget_policy_json,
             pending_api_key_hash,
             target_user_id,
             target_agent_id,
             flow_kind,
             resolution_status,
             claim_token_hash,
             claim_token_expires_at,
             created_at,
             updated_at
      FROM owner_binding_requests
      WHERE id = $1
        AND owner_email = $2
      LIMIT 1
      ${input.forUpdate ? "FOR UPDATE" : ""}
    `,
    [parsedToken.subject_id, normalizedEmail]
  );

  const request = claimResult.rows[0];
  if (!request) {
    return {
      error: "claim_not_found" as const
    };
  }

  if (request.resolution_status === "activated") {
    return {
      error: "claim_already_activated" as const
    };
  }

  if (request.resolution_status === "cancelled") {
    return {
      error: "claim_cancelled" as const
    };
  }

  const claimTokenHash = hashApiKey(input.claimToken);
  const claimExpiresAtMs = request.claim_token_expires_at
    ? new Date(request.claim_token_expires_at).getTime()
    : Number.NaN;
  const tokenExpiresAtMs = new Date(parsedToken.expires_at).getTime();

  if (
    !request.claim_token_hash ||
    request.claim_token_hash !== claimTokenHash ||
    Number.isNaN(claimExpiresAtMs) ||
    Number.isNaN(tokenExpiresAtMs) ||
    claimExpiresAtMs !== tokenExpiresAtMs
  ) {
    return {
      error: "claim_token_invalid" as const
    };
  }

  if (claimExpiresAtMs < Date.now() || tokenExpiresAtMs < Date.now()) {
    return {
      error: "claim_expired" as const
    };
  }

  return {
    request,
    parsedToken
  };
}
