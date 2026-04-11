import { config } from "../config.js";

export const ownerMembershipTiers = ["standard", "member_large_attachment_1gb"] as const;

export type OwnerMembershipTier = (typeof ownerMembershipTiers)[number];

export type OwnerUploadEntitlement = {
  membership_tier: OwnerMembershipTier;
  membership_starts_at: string | null;
  membership_expires_at: string | null;
  membership_note: string;
  membership_active: boolean;
  effective_platform_managed_max_bytes: number;
  effective_platform_managed_total_bytes_per_role: number;
  reason:
    | "standard_default"
    | "membership_not_started"
    | "membership_expired"
    | "membership_active";
};

type OwnerMembershipRecord = {
  status?: unknown;
  membership_tier?: unknown;
  membership_starts_at?: unknown;
  membership_expires_at?: unknown;
  membership_note?: unknown;
};

type QueryExecutor = (
  text: string,
  values?: unknown[]
) => Promise<{ rows: Array<Record<string, unknown>> }>;

function toNullableString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveOwnerUploadEntitlement(
  record: OwnerMembershipRecord
): OwnerUploadEntitlement {
  const membershipTier =
    record.membership_tier === "member_large_attachment_1gb"
      ? "member_large_attachment_1gb"
      : "standard";
  const membershipStartsAt = toNullableString(record.membership_starts_at);
  const membershipExpiresAt = toNullableString(record.membership_expires_at);
  const membershipNote = toNullableString(record.membership_note) ?? "";
  const now = Date.now();
  const startsAtMs = membershipStartsAt ? Date.parse(membershipStartsAt) : null;
  const expiresAtMs = membershipExpiresAt ? Date.parse(membershipExpiresAt) : null;
  const ownerActive = record.status === undefined || record.status === "active";

  let membershipActive = false;
  let reason: OwnerUploadEntitlement["reason"] = "standard_default";

  if (ownerActive && membershipTier === "member_large_attachment_1gb") {
    if (startsAtMs !== null && Number.isFinite(startsAtMs) && startsAtMs > now) {
      reason = "membership_not_started";
    } else if (expiresAtMs !== null && Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
      reason = "membership_expired";
    } else {
      membershipActive = true;
      reason = "membership_active";
    }
  }

  return {
    membership_tier: membershipTier,
    membership_starts_at: membershipStartsAt,
    membership_expires_at: membershipExpiresAt,
    membership_note: membershipNote,
    membership_active: membershipActive,
    effective_platform_managed_max_bytes: membershipActive
      ? config.deliveryArtifacts.memberMaxManagedArtifactBytes
      : config.deliveryArtifacts.maxManagedArtifactBytes,
    effective_platform_managed_total_bytes_per_role: membershipActive
      ? config.deliveryArtifacts.memberMaxManagedArtifactTotalBytesPerRole
      : config.deliveryArtifacts.maxManagedArtifactTotalBytesPerRole,
    reason
  };
}

export async function loadOwnerUploadEntitlementByAgent(
  queryExecutor: QueryExecutor,
  agentId: string
) {
  const result = await queryExecutor(
    `
      SELECT u.id AS owner_user_id,
             u.status,
             u.membership_tier,
             u.membership_starts_at,
             u.membership_expires_at,
             u.membership_note
      FROM agent_accounts aa
      JOIN users u ON u.id = aa.user_id
      WHERE aa.id = $1
      LIMIT 1
    `,
    [agentId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("owner_membership_agent_not_found");
  }

  return {
    owner_user_id: String(row.owner_user_id),
    ...resolveOwnerUploadEntitlement(row)
  };
}

export function buildWorkspaceUploadLimits(params: {
  buyer: OwnerUploadEntitlement;
  provider: OwnerUploadEntitlement;
}) {
  return {
    buyer_input_max_size_bytes: params.buyer.effective_platform_managed_total_bytes_per_role,
    provider_output_max_size_bytes: params.provider.effective_platform_managed_total_bytes_per_role
  };
}
