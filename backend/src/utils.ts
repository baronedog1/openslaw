import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function buildAgentSlug(agentName: string): string {
  const base = slugify(agentName) || "agent";
  return `${base}-${randomInt(1000, 9999)}`;
}

export function generateApiKey(): string {
  return `openslaw_${randomBytes(24).toString("hex")}`;
}

export function generateOwnerSessionToken(): string {
  return `openslaw_owner_${randomBytes(24).toString("hex")}`;
}

type SignedOwnerLinkKind = "claim" | "owner_login";

type SignedOwnerLinkPayload = {
  kind: SignedOwnerLinkKind;
  subject_id: string;
  email: string;
  expires_at: string;
};

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signOwnerLinkPayload(encodedPayload: string) {
  return createHmac("sha256", config.ownerLinkMasterKey)
    .update(encodedPayload)
    .digest("base64url");
}

function buildSignedOwnerLinkToken(payload: SignedOwnerLinkPayload) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signOwnerLinkPayload(encodedPayload);
  return `osl1.${encodedPayload}.${signature}`;
}

function parseSignedOwnerLinkToken(
  token: string,
  expectedKind: SignedOwnerLinkKind
): SignedOwnerLinkPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "osl1") {
    return null;
  }

  const encodedPayload = parts[1];
  const providedSignature = parts[2];
  const expectedSignature = signOwnerLinkPayload(encodedPayload);

  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature))
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const candidate = payload as Partial<SignedOwnerLinkPayload>;
  if (
    candidate.kind !== expectedKind ||
    typeof candidate.subject_id !== "string" ||
    candidate.subject_id.trim().length === 0 ||
    typeof candidate.email !== "string" ||
    candidate.email.trim().length === 0 ||
    typeof candidate.expires_at !== "string" ||
    Number.isNaN(new Date(candidate.expires_at).getTime())
  ) {
    return null;
  }

  return {
    kind: candidate.kind,
    subject_id: candidate.subject_id,
    email: candidate.email.toLowerCase(),
    expires_at: candidate.expires_at
  };
}

export function buildOwnerClaimToken(agentId: string, ownerEmail: string, expiresAt: string): string {
  return buildSignedOwnerLinkToken({
    kind: "claim",
    subject_id: agentId,
    email: ownerEmail.toLowerCase(),
    expires_at: expiresAt
  });
}

export function parseOwnerClaimToken(token: string) {
  return parseSignedOwnerLinkToken(token, "claim");
}

export function buildOwnerLoginToken(userId: string, ownerEmail: string, expiresAt: string): string {
  return buildSignedOwnerLinkToken({
    kind: "owner_login",
    subject_id: userId,
    email: ownerEmail.toLowerCase(),
    expires_at: expiresAt
  });
}

export function parseOwnerLoginToken(token: string) {
  return parseSignedOwnerLinkToken(token, "owner_login");
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function generateOrderNo(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `OS${stamp}${randomInt(1000, 9999)}`;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}
