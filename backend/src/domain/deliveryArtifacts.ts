import type { PoolClient } from "pg";
import { config } from "../config.js";
import { buildPlatformManagedArtifactDownloadPath } from "./objectStorage.js";
import { slugify } from "../utils.js";

export const artifactRoles = ["buyer_input", "provider_output"] as const;

export type ArtifactRole = (typeof artifactRoles)[number];
export type DeliveryArtifactRole = ArtifactRole;
export type OrderViewerRole = "buyer" | "provider";
export type LocalOrderBundleDescriptor = {
  root_dir: string;
  task_slug: string;
  snapshot_relative_path: string;
  manifest_relative_path: string;
  review_relative_path: string;
  buyer_inputs_dir: string;
  provider_outputs_dir: string;
};
export type WorkspaceManifestItem = ReturnType<typeof serializeDeliveryArtifact> & {
  local_relative_path: string | null;
  source_mode: "download" | "inline_json" | "metadata_only";
  inline_content_json: Record<string, unknown> | null;
};
export type DeliveryBundleDescriptor = {
  status: "not_ready" | "ready";
  preferred_mirror_mode: "direct_artifact" | "zip_bundle" | "secure_link_only";
  direct_send_max_bytes: number;
  total_size_bytes: number;
  artifact_count: number;
  primary_artifact_id: string | null;
  recommended_file_name: string | null;
  runtime_must_build_bundle: boolean;
  blockers: string[];
  explanation: string;
};

export type DeliveryArtifactRow = {
  id: string;
  order_id: string;
  submitted_by_agent_id: string;
  artifact_role: ArtifactRole;
  artifact_type: string;
  delivery_mode: string;
  storage_provider: string | null;
  storage_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  content_json: Record<string, unknown>;
  summary_text: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  uploaded_at: string | null;
  object_key: string | null;
  download_count: number;
  last_downloaded_at: string | null;
  purged_at: string | null;
  purge_reason: string | null;
};

function buildBundleDateStamp(createdAt: string) {
  return new Date(createdAt).toISOString().slice(0, 10).replace(/-/g, "");
}

function deriveTaskSlug(titleCandidate: string | null | undefined) {
  const slug = slugify(titleCandidate ?? "");
  return slug ? slug.slice(0, 40) : "order";
}

function sanitizeLocalBundleFileName(fileName: string) {
  const normalized = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "artifact.bin";
}

function inferFallbackBundleFileName(row: DeliveryArtifactRow) {
  if (row.file_name) {
    return sanitizeLocalBundleFileName(row.file_name);
  }

  if (row.artifact_type === "url") {
    return `artifact-${row.id}.url.txt`;
  }

  if (row.content_json && Object.keys(row.content_json).length > 0) {
    return `artifact-${row.id}.json`;
  }

  return `artifact-${row.id}.bin`;
}

function buildLocalRelativePath(row: DeliveryArtifactRow) {
  const roleDirectory = row.artifact_role === "buyer_input" ? "buyer_inputs" : "provider_outputs";
  return `${roleDirectory}/${row.id}/${inferFallbackBundleFileName(row)}`;
}

function artifactVisibleToCounterparty(status: string) {
  return ["submitted", "accepted", "rejected"].includes(status);
}

export function canViewerAccessArtifact(params: {
  viewerRole: OrderViewerRole;
  artifactRole: ArtifactRole;
  status: string;
}) {
  if (params.viewerRole === "buyer") {
    if (params.artifactRole === "buyer_input") {
      return true;
    }

    return artifactVisibleToCounterparty(params.status);
  }

  if (params.artifactRole === "provider_output") {
    return true;
  }

  return artifactVisibleToCounterparty(params.status);
}

export function serializeDeliveryArtifact(row: DeliveryArtifactRow) {
  const access =
    row.delivery_mode === "platform_managed" && row.status !== "uploading" && !row.purged_at
      ? {
          mode: "platform_proxy_download",
          download_url: buildPlatformManagedArtifactDownloadPath({
            orderId: row.order_id,
            artifactId: row.id
          })
        }
      : row.storage_url
        ? {
            mode: "external_url",
            download_url: row.storage_url
          }
        : null;

  return {
    id: row.id,
    order_id: row.order_id,
    submitted_by_agent_id: row.submitted_by_agent_id,
    artifact_role: row.artifact_role,
    artifact_type: row.artifact_type,
    delivery_mode: row.delivery_mode,
    storage_provider: row.storage_provider,
    storage_url: row.delivery_mode === "provider_managed" ? row.storage_url : null,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    checksum_sha256: row.checksum_sha256,
    content_json: row.content_json ?? {},
    summary_text: row.summary_text,
    status: row.status,
    uploaded_at: row.uploaded_at,
    download_count: row.download_count ?? 0,
    last_downloaded_at: row.last_downloaded_at,
    purged_at: row.purged_at,
    purge_reason: row.purge_reason,
    updated_at: row.updated_at,
    created_at: row.created_at,
    access
  };
}

export function buildLocalOrderBundleDescriptor(params: {
  orderId: string;
  createdAt: string;
  titleCandidate?: string | null;
}): LocalOrderBundleDescriptor {
  const dateStamp = buildBundleDateStamp(params.createdAt);
  const taskSlug = deriveTaskSlug(params.titleCandidate);
  return {
    root_dir: `.openslaw/orders/${dateStamp}-${taskSlug}-${params.orderId}/`,
    task_slug: taskSlug,
    snapshot_relative_path: "order_snapshot.json",
    manifest_relative_path: "workspace_manifest.json",
    review_relative_path: "review.md",
    buyer_inputs_dir: "buyer_inputs/",
    provider_outputs_dir: "provider_outputs/"
  };
}

export function buildWorkspaceManifestItems(rows: DeliveryArtifactRow[], viewerRole: OrderViewerRole) {
  return rows
    .filter((row) =>
      canViewerAccessArtifact({
        viewerRole,
        artifactRole: row.artifact_role,
        status: row.status
      })
    )
    .map((row): WorkspaceManifestItem => {
      const serialized = serializeDeliveryArtifact(row);
      const sourceMode =
        serialized.access !== null
          ? "download"
          : row.content_json && Object.keys(row.content_json).length > 0
            ? "inline_json"
            : "metadata_only";

      return {
        ...serialized,
        local_relative_path: buildLocalRelativePath(row),
        source_mode: sourceMode,
        inline_content_json: sourceMode === "inline_json" ? (row.content_json ?? {}) : null
      };
    });
}

function sumVisibleArtifactBytes(items: Array<{ size_bytes: number | null }>) {
  return items.reduce((total, item) => total + (item.size_bytes ?? 0), 0);
}

function buildDeliveryBundleExplanation(params: {
  preferredMirrorMode: DeliveryBundleDescriptor["preferred_mirror_mode"];
  blockers: string[];
}) {
  if (params.blockers.includes("no_provider_outputs")) {
    return "No provider output artifacts are formally visible on this order yet.";
  }

  if (params.preferredMirrorMode === "direct_artifact") {
    return "A single formal provider output artifact can be mirrored directly to a chat channel when the runtime has permission and the current channel supports that file type.";
  }

  if (params.preferredMirrorMode === "zip_bundle") {
    return "Multiple formal provider output artifacts are visible. The runtime should mirror the local order bundle as one package when the resulting bundle still fits the direct-send limit.";
  }

  return "Direct chat mirroring is not recommended for the current provider output set. Use the formal secure link or local order bundle instead.";
}

export function buildDeliveryBundleDescriptor(
  artifacts: Array<ReturnType<typeof serializeDeliveryArtifact>>
): DeliveryBundleDescriptor {
  const directSendMaxBytes = config.deliveryArtifacts.maxManagedArtifactTotalBytesPerRole;
  const artifactCount = artifacts.length;
  const totalSizeBytes = sumVisibleArtifactBytes(artifacts);
  const primaryArtifact = artifacts[0] ?? null;
  const blockers: string[] = [];

  if (artifactCount === 0) {
    blockers.push("no_provider_outputs");
    return {
      status: "not_ready",
      preferred_mirror_mode: "secure_link_only",
      direct_send_max_bytes: directSendMaxBytes,
      total_size_bytes: 0,
      artifact_count: 0,
      primary_artifact_id: null,
      recommended_file_name: null,
      runtime_must_build_bundle: false,
      blockers,
      explanation: buildDeliveryBundleExplanation({
        preferredMirrorMode: "secure_link_only",
        blockers
      })
    };
  }

  const hasExternalLinkOnlyArtifact = artifacts.some(
    (artifact) =>
      artifact.artifact_type === "url" ||
      artifact.delivery_mode === "provider_managed" ||
      artifact.access?.mode === "external_url"
  );
  const hasMetadataOnlyArtifact = artifacts.some(
    (artifact) => artifact.artifact_type === "text" || artifact.access === null
  );
  const exceedsDirectSendLimit = totalSizeBytes > directSendMaxBytes;

  if (hasExternalLinkOnlyArtifact) {
    blockers.push("provider_managed_link_only");
  }

  if (hasMetadataOnlyArtifact) {
    blockers.push("artifact_not_direct_downloadable");
  }

  if (exceedsDirectSendLimit) {
    blockers.push("bundle_exceeds_direct_send_limit");
  }

  const singleDownloadableArtifact =
    artifactCount === 1 &&
    !hasExternalLinkOnlyArtifact &&
    !hasMetadataOnlyArtifact &&
    !exceedsDirectSendLimit;

  if (singleDownloadableArtifact) {
    return {
      status: "ready",
      preferred_mirror_mode: "direct_artifact",
      direct_send_max_bytes: directSendMaxBytes,
      total_size_bytes: totalSizeBytes,
      artifact_count: artifactCount,
      primary_artifact_id: primaryArtifact?.id ?? null,
      recommended_file_name: primaryArtifact?.file_name ?? null,
      runtime_must_build_bundle: false,
      blockers: [],
      explanation: buildDeliveryBundleExplanation({
        preferredMirrorMode: "direct_artifact",
        blockers: []
      })
    };
  }

  const canRecommendZipBundle =
    artifactCount > 1 && !hasExternalLinkOnlyArtifact && !hasMetadataOnlyArtifact && !exceedsDirectSendLimit;

  if (canRecommendZipBundle) {
    return {
      status: "ready",
      preferred_mirror_mode: "zip_bundle",
      direct_send_max_bytes: directSendMaxBytes,
      total_size_bytes: totalSizeBytes,
      artifact_count: artifactCount,
      primary_artifact_id: primaryArtifact?.id ?? null,
      recommended_file_name: "openslaw-delivery-bundle.zip",
      runtime_must_build_bundle: true,
      blockers: [],
      explanation: buildDeliveryBundleExplanation({
        preferredMirrorMode: "zip_bundle",
        blockers: []
      })
    };
  }

  return {
    status: "ready",
    preferred_mirror_mode: "secure_link_only",
    direct_send_max_bytes: directSendMaxBytes,
    total_size_bytes: totalSizeBytes,
    artifact_count: artifactCount,
    primary_artifact_id: primaryArtifact?.id ?? null,
    recommended_file_name: primaryArtifact?.file_name ?? null,
    runtime_must_build_bundle: false,
    blockers,
    explanation: buildDeliveryBundleExplanation({
      preferredMirrorMode: "secure_link_only",
      blockers
    })
  };
}

export function buildOrderWorkspace(
  rows: DeliveryArtifactRow[],
  viewerRole: OrderViewerRole,
  options?: {
    bundleManifestUrl?: string | null;
    localBundle?: LocalOrderBundleDescriptor | null;
    uploadLimits?: {
      buyer_input_max_size_bytes: number;
      provider_output_max_size_bytes: number;
    } | null;
  }
) {
  const visibleRows = rows.filter((row) =>
    canViewerAccessArtifact({
      viewerRole,
      artifactRole: row.artifact_role,
      status: row.status
    })
  );
  const serialized = visibleRows.map(serializeDeliveryArtifact);
  const buyerInputArtifacts = serialized.filter((artifact) => artifact.artifact_role === "buyer_input");
  const providerOutputArtifacts = serialized.filter(
    (artifact) => artifact.artifact_role === "provider_output"
  );
  const deliveryBundle = buildDeliveryBundleDescriptor(providerOutputArtifacts);
  const uploadLimits = options?.uploadLimits ?? {
    buyer_input_max_size_bytes: config.deliveryArtifacts.maxManagedArtifactTotalBytesPerRole,
    provider_output_max_size_bytes: config.deliveryArtifacts.maxManagedArtifactTotalBytesPerRole
  };

  return {
    upload_limits: uploadLimits,
    buyer_input_total_size_bytes: sumVisibleArtifactBytes(buyerInputArtifacts),
    provider_output_total_size_bytes: sumVisibleArtifactBytes(providerOutputArtifacts),
    buyer_input_artifacts: buyerInputArtifacts,
    provider_output_artifacts: providerOutputArtifacts,
    delivery_bundle: deliveryBundle,
    bundle_manifest_url: options?.bundleManifestUrl ?? null,
    local_bundle: options?.localBundle ?? null
  };
}

export async function ensurePlatformManagedArtifactCapacityForRole(
  client: PoolClient,
  params: {
    orderId: string;
    artifactRole: ArtifactRole;
    nextSizeBytes: number;
    maxTotalBytes: number;
  }
) {
  const totalResult = await client.query<{ total_bytes: number }>(
    `
      SELECT COALESCE(SUM(size_bytes), 0)::int AS total_bytes
      FROM delivery_artifacts
      WHERE order_id = $1
        AND artifact_role = $2
        AND delivery_mode = 'platform_managed'
        AND purged_at IS NULL
        AND status <> 'superseded'
    `,
    [params.orderId, params.artifactRole]
  );

  const currentTotal = totalResult.rows[0]?.total_bytes ?? 0;
  if (currentTotal + params.nextSizeBytes > params.maxTotalBytes) {
    const error = new Error("platform_managed_artifact_order_side_size_exceeded") as Error & {
      max_size_bytes?: number;
    };
    error.max_size_bytes = params.maxTotalBytes;
    throw error;
  }

  return currentTotal + params.nextSizeBytes;
}

export async function assertWorkspaceRoleCapacity(
  client: PoolClient,
  params: {
    orderId: string;
    artifactRole: ArtifactRole;
    incomingSizeBytes: number;
    maxTotalBytes: number;
  }
) {
  try {
    return await ensurePlatformManagedArtifactCapacityForRole(client, {
      orderId: params.orderId,
      artifactRole: params.artifactRole,
      nextSizeBytes: params.incomingSizeBytes,
      maxTotalBytes: params.maxTotalBytes
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "platform_managed_artifact_order_side_size_exceeded"
    ) {
      const limitError = new Error(
        params.artifactRole === "buyer_input"
          ? "buyer_input_workspace_limit_exceeded"
          : "provider_output_workspace_limit_exceeded"
      ) as Error & { max_size_bytes?: number };
      const sizeLimitedError = error as unknown as { max_size_bytes?: unknown };
      limitError.max_size_bytes =
        typeof sizeLimitedError.max_size_bytes === "number"
          ? sizeLimitedError.max_size_bytes
          : params.maxTotalBytes;
      throw limitError;
    }

    throw error;
  }
}

export function orderAllowsProviderOutputUpload(orderStatus: string) {
  return ["accepted", "in_progress", "revision_requested"].includes(orderStatus);
}

export function orderAllowsBuyerInputUpload(orderStatus: string) {
  return [
    "awaiting_buyer_context",
    "queued_for_provider",
    "accepted",
    "in_progress",
    "revision_requested"
  ].includes(orderStatus);
}
