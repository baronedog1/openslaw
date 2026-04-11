import path from "node:path";
import OSS from "ali-oss";
import { config } from "../config.js";
import type { ArtifactRole } from "./deliveryArtifacts.js";

const DANGEROUS_MIME_TYPES = new Set([
  "application/javascript",
  "application/x-bat",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-msdownload",
  "application/x-ms-installer",
  "application/x-sh",
  "image/svg+xml",
  "text/html",
  "text/javascript"
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".dmg",
  ".exe",
  ".hta",
  ".html",
  ".js",
  ".mjs",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
  ".svg"
]);

export type PlatformManagedObjectHead = {
  sizeBytes: number | null;
  mimeType: string | null;
  etag: string | null;
};

let cachedPublicClient: any = null;
let cachedInternalClient: any = null;

function ensurePlatformManagedDeliveryConfigured() {
  if (
    !config.deliveryArtifacts.platformManagedEnabled ||
    !config.deliveryArtifacts.oss.endpoint ||
    !config.deliveryArtifacts.oss.bucket ||
    !config.deliveryArtifacts.oss.accessKeyId ||
    !config.deliveryArtifacts.oss.accessKeySecret
  ) {
    throw new Error("platform_managed_delivery_not_configured");
  }
}

function buildClient(endpoint: string): any {
  const bucket = config.deliveryArtifacts.oss.bucket!;
  const accessKeyId = config.deliveryArtifacts.oss.accessKeyId!;
  const accessKeySecret = config.deliveryArtifacts.oss.accessKeySecret!;
  return new OSS({
    endpoint,
    bucket,
    accessKeyId,
    accessKeySecret,
    secure: endpoint.startsWith("https://")
  });
}

function publicClient(): any {
  if (cachedPublicClient) {
    return cachedPublicClient;
  }

  ensurePlatformManagedDeliveryConfigured();
  const endpoint = config.deliveryArtifacts.oss.endpoint!;
  cachedPublicClient = buildClient(endpoint);

  return cachedPublicClient;
}

function internalClient(): any {
  if (cachedInternalClient) {
    return cachedInternalClient;
  }

  ensurePlatformManagedDeliveryConfigured();
  const endpoint =
    config.deliveryArtifacts.oss.internalEndpoint ?? config.deliveryArtifacts.oss.endpoint!;
  cachedInternalClient = buildClient(endpoint);

  return cachedInternalClient;
}

export function isPlatformManagedDeliveryEnabled(): boolean {
  return config.deliveryArtifacts.platformManagedEnabled;
}

export function sanitizeArtifactFileName(fileName: string): string {
  const base = path.posix.basename(fileName.replace(/\\/g, "/")).trim();
  const normalized = (base || "artifact.bin")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "artifact.bin";
}

export function assertPlatformManagedArtifactAllowed(params: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  maxSizeBytes?: number;
}) {
  ensurePlatformManagedDeliveryConfigured();
  const maxSizeBytes = params.maxSizeBytes ?? config.deliveryArtifacts.maxManagedArtifactBytes;

  if (params.sizeBytes <= 0) {
    throw new Error("platform_managed_artifact_size_invalid");
  }

  if (params.sizeBytes > maxSizeBytes) {
    const error = new Error("platform_managed_artifact_too_large") as Error & {
      max_size_bytes?: number;
    };
    error.max_size_bytes = maxSizeBytes;
    throw error;
  }

  const normalizedMimeType = params.mimeType.trim().toLowerCase();
  const extension = path.extname(params.fileName).toLowerCase();
  if (DANGEROUS_MIME_TYPES.has(normalizedMimeType) || DANGEROUS_EXTENSIONS.has(extension)) {
    throw new Error("platform_managed_artifact_type_not_allowed");
  }
}

export function buildPlatformManagedArtifactObjectKey(params: {
  orderId: string;
  artifactRole: ArtifactRole;
  artifactId: string;
  fileName: string;
}) {
  const safeFileName = sanitizeArtifactFileName(params.fileName);
  const roleDirectory = params.artifactRole === "buyer_input" ? "buyer_inputs" : "provider_outputs";
  return [
    config.deliveryArtifacts.prefix,
    params.orderId,
    roleDirectory,
    params.artifactId,
    safeFileName
  ].join("/");
}

export function buildPlatformManagedArtifactDownloadPath(params: {
  orderId: string;
  artifactId: string;
}) {
  const pathName = `/agent/orders/${params.orderId}/artifacts/${params.artifactId}/download`;
  return config.publicApiBaseUrl ? `${config.publicApiBaseUrl}${pathName}` : `/api/v1${pathName}`;
}

export function createPlatformManagedUploadUrl(params: {
  objectKey: string;
  mimeType: string;
}) {
  ensurePlatformManagedDeliveryConfigured();
  const expiresAt = new Date(
    Date.now() + config.deliveryArtifacts.signedUploadExpiresSeconds * 1000
  ).toISOString();
  const uploadUrl = publicClient().signatureUrl(params.objectKey, {
    expires: config.deliveryArtifacts.signedUploadExpiresSeconds,
    method: "PUT",
    "Content-Type": params.mimeType
  });

  return {
    method: "PUT" as const,
    upload_url: uploadUrl,
    expires_at: expiresAt,
    headers: {
      "Content-Type": params.mimeType
    }
  };
}

export async function headPlatformManagedObject(objectKey: string): Promise<PlatformManagedObjectHead> {
  ensurePlatformManagedDeliveryConfigured();
  const result = await internalClient().head(objectKey);

  return {
    sizeBytes:
      typeof result.res?.headers?.["content-length"] === "string"
        ? Number(result.res.headers["content-length"])
        : null,
    mimeType:
      typeof result.res?.headers?.["content-type"] === "string"
        ? result.res.headers["content-type"]
        : null,
    etag:
      typeof result.res?.headers?.etag === "string" ? result.res.headers.etag : null
  };
}

export async function getPlatformManagedObjectStream(objectKey: string) {
  ensurePlatformManagedDeliveryConfigured();
  const result = await internalClient().getStream(objectKey);
  return {
    stream: result.stream,
    sizeBytes:
      typeof result.res?.headers?.["content-length"] === "string"
        ? Number(result.res.headers["content-length"])
        : null,
    mimeType:
      typeof result.res?.headers?.["content-type"] === "string"
        ? result.res.headers["content-type"]
        : null
  };
}

export async function deletePlatformManagedObject(objectKey: string) {
  ensurePlatformManagedDeliveryConfigured();
  return internalClient().delete(objectKey);
}

export function platformManagedBucketName(): string {
  ensurePlatformManagedDeliveryConfigured();
  return config.deliveryArtifacts.oss.bucket!;
}
