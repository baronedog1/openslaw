import dotenv from "dotenv";

dotenv.config();

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }

  return parsed;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) {
    return fallback;
  }

  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean`);
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = env(name);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function trimmedEnv(names: string[]): string | undefined {
  const value = firstEnv(names);
  return value ? value.replace(/\/+$/, "") : undefined;
}

function resolveEmailFrom(): string {
  const direct = env("EMAIL_FROM");
  if (direct) {
    return direct;
  }

  const smtpFrom = env("SMTP_FROM");
  if (!smtpFrom) {
    return "OpenSlaw <noreply@openslaw.local>";
  }

  const fromName = env("SMTP_FROM_NAME") ?? "OpenSlaw";
  return `${fromName} <${smtpFrom}>`;
}

function resolveEmailMode(): "console" | "smtp" {
  const explicit = env("EMAIL_DELIVERY_MODE");
  if (explicit === "console" || explicit === "smtp") {
    return explicit;
  }

  return firstEnv(["SMTP_HOST"]) &&
    firstEnv(["SMTP_USER", "SMTP_USERNAME"]) &&
    firstEnv(["SMTP_PASS", "SMTP_PASSWORD"])
    ? "smtp"
    : "console";
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: numberFromEnv("PORT", 51011),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://openslaw_user:openslaw_dev_2026@127.0.0.1:51012/openslaw_dev",
  corsOrigin: listFromEnv("CORS_ORIGIN", ["http://127.0.0.1:51010", "http://0.0.0.0:51010"]),
  signupGrantAmount: numberFromEnv("SIGNUP_GRANT_AMOUNT", 100),
  orderQueueTimeoutMinutes: numberFromEnv("ORDER_QUEUE_TIMEOUT_MINUTES", 1440),
  deliveredReviewAutoCloseHours: numberFromEnv("DELIVERED_REVIEW_AUTO_CLOSE_HOURS", 48),
  publicWebBaseUrl: trimmedEnv([
    "PUBLIC_WEB_BASE_URL",
    "EMAIL_VERIFY_BASE_URL",
    "EMAIL_VERIFY_BASE_URL_DEV"
  ]),
  publicApiBaseUrl: trimmedEnv(["PUBLIC_API_BASE_URL"]),
  systemCronToken: process.env.SYSTEM_CRON_TOKEN ?? "openslaw_system_cron_dev_2026",
  callbackMasterKey: process.env.CALLBACK_MASTER_KEY ?? "openslaw_callback_master_dev_2026",
  ownerLinkMasterKey:
    process.env.OWNER_LINK_MASTER_KEY ??
    process.env.CALLBACK_MASTER_KEY ??
    "openslaw_owner_link_master_dev_2026",
  ownerClaimTtlHours: numberFromEnv("OWNER_CLAIM_TTL_HOURS", 0.25),
  ownerLoginLinkTtlMinutes: numberFromEnv("OWNER_LOGIN_LINK_TTL_MINUTES", 30),
  ownerSessionTtlHours: numberFromEnv("OWNER_SESSION_TTL_HOURS", 168),
  email: {
    mode: resolveEmailMode(),
    from: resolveEmailFrom(),
    debugExposeSecrets: boolFromEnv("EMAIL_EXPOSE_DEBUG_SECRETS", true),
    smtp: {
      host: firstEnv(["SMTP_HOST"]),
      port: numberFromEnv("SMTP_PORT", 587),
      secure: boolFromEnv("SMTP_SECURE", false),
      user: firstEnv(["SMTP_USER", "SMTP_USERNAME"]),
      pass: firstEnv(["SMTP_PASS", "SMTP_PASSWORD"])
    }
  },
  deliveryArtifacts: {
    platformManagedEnabled: boolFromEnv(
      "PLATFORM_MANAGED_DELIVERY_ENABLED",
      Boolean(
        firstEnv(["OSS_ENDPOINT"]) &&
          firstEnv(["OSS_BUCKET"]) &&
          firstEnv(["OSS_ACCESS_KEY_ID"]) &&
          firstEnv(["OSS_ACCESS_KEY_SECRET"])
      )
    ),
    maxManagedArtifactBytes: numberFromEnv(
      "PLATFORM_MANAGED_ARTIFACT_MAX_BYTES",
      30 * 1024 * 1024
    ),
    maxManagedArtifactTotalBytesPerRole: numberFromEnv(
      "PLATFORM_MANAGED_ARTIFACT_TOTAL_BYTES_PER_ORDER_SIDE",
      30 * 1024 * 1024
    ),
    memberMaxManagedArtifactBytes: numberFromEnv(
      "PLATFORM_MANAGED_ARTIFACT_MEMBER_MAX_BYTES",
      1024 * 1024 * 1024
    ),
    memberMaxManagedArtifactTotalBytesPerRole: numberFromEnv(
      "PLATFORM_MANAGED_ARTIFACT_MEMBER_TOTAL_BYTES_PER_ORDER_SIDE",
      1024 * 1024 * 1024
    ),
    signedUploadExpiresSeconds: numberFromEnv("OSS_SIGNED_UPLOAD_EXPIRES_SECONDS", 900),
    downloadMaxConcurrent: numberFromEnv("PLATFORM_MANAGED_DOWNLOAD_MAX_CONCURRENT", 15),
    downloadMaxConcurrentPerAgent: numberFromEnv(
      "PLATFORM_MANAGED_DOWNLOAD_MAX_CONCURRENT_PER_AGENT",
      4
    ),
    downloadMaxConcurrentPerIp: numberFromEnv("PLATFORM_MANAGED_DOWNLOAD_MAX_CONCURRENT_PER_IP", 6),
    downloadRateLimitPerIp: numberFromEnv("PLATFORM_MANAGED_DOWNLOAD_RATE_LIMIT_PER_IP", 40),
    downloadRateLimitWindowSeconds: numberFromEnv(
      "PLATFORM_MANAGED_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS",
      60
    ),
    largeArtifactPendingRetentionHours: numberFromEnv(
      "PLATFORM_MANAGED_LARGE_ARTIFACT_PENDING_RETENTION_HOURS",
      48
    ),
    largeArtifactTerminalRetentionDays: numberFromEnv(
      "PLATFORM_MANAGED_LARGE_ARTIFACT_TERMINAL_RETENTION_DAYS",
      7
    ),
    staleUploadingTtlHours: numberFromEnv("PLATFORM_MANAGED_STALE_UPLOADING_TTL_HOURS", 24),
    staleUploadedTtlHours: numberFromEnv("PLATFORM_MANAGED_STALE_UPLOADED_TTL_HOURS", 168),
    completedRetentionDays: numberFromEnv("PLATFORM_MANAGED_COMPLETED_RETENTION_DAYS", 90),
    disputedRetentionDays: numberFromEnv("PLATFORM_MANAGED_DISPUTED_RETENTION_DAYS", 180),
    cleanupBatchLimit: numberFromEnv("PLATFORM_MANAGED_CLEANUP_BATCH_LIMIT", 100),
    prefix: (env("OSS_OPENSLAW_DELIVERY_PREFIX") ?? "ai/openslaw/orders")
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
    oss: {
      endpoint: trimmedEnv(["OSS_ENDPOINT"]),
      internalEndpoint: trimmedEnv(["OSS_INTERNAL_ENDPOINT", "OSS_ENDPOINT"]),
      bucket: firstEnv(["OSS_BUCKET"]),
      accessKeyId: firstEnv(["OSS_ACCESS_KEY_ID"]),
      accessKeySecret: firstEnv(["OSS_ACCESS_KEY_SECRET"])
    }
  },
  rateLimits: {
    registerPerIpMax: numberFromEnv("REGISTER_RATE_LIMIT_PER_IP", 3),
    registerPerIpWindowSeconds: numberFromEnv("REGISTER_RATE_LIMIT_WINDOW_SECONDS", 60),
    registerEmailCooldownSeconds: numberFromEnv("REGISTER_EMAIL_COOLDOWN_SECONDS", 60),
    ownerClaimEmailCooldownSeconds: numberFromEnv("OWNER_CLAIM_EMAIL_COOLDOWN_SECONDS", 60),
    ownerLoginPerIpMax: numberFromEnv("OWNER_LOGIN_RATE_LIMIT_PER_IP", 6),
    ownerLoginPerIpWindowSeconds: numberFromEnv("OWNER_LOGIN_RATE_LIMIT_WINDOW_SECONDS", 60),
    ownerLoginEmailCooldownSeconds: numberFromEnv("OWNER_LOGIN_EMAIL_COOLDOWN_SECONDS", 60),
    ownerClaimPerIpMax: numberFromEnv("OWNER_CLAIM_RATE_LIMIT_PER_IP", 10),
    ownerClaimPerIpWindowSeconds: numberFromEnv("OWNER_CLAIM_RATE_LIMIT_WINDOW_SECONDS", 60)
  },
  runtimeRelay: {
    leaseHours: numberFromEnv("RUNTIME_RELAY_LEASE_HOURS", 48),
    premiumLeaseHours: numberFromEnv("RUNTIME_RELAY_PREMIUM_LEASE_HOURS", 480),
    authTimeoutSeconds: numberFromEnv("RUNTIME_RELAY_AUTH_TIMEOUT_SECONDS", 10),
    sweepIntervalSeconds: numberFromEnv("RUNTIME_RELAY_SWEEP_INTERVAL_SECONDS", 60),
    pendingReplayBatchSize: numberFromEnv("RUNTIME_RELAY_PENDING_REPLAY_BATCH_SIZE", 100),
    maxConnections: numberFromEnv("RUNTIME_RELAY_MAX_CONNECTIONS", 1000)
  },
  ports: {
    web: 51010,
    api: 51011,
    postgres: 51012,
    mcpReserved: 51013,
    storageReserved: 51014
  }
};
