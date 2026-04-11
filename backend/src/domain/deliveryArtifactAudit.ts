import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { query } from "../db.js";
import { json } from "../utils.js";
import { resolveRequestIp } from "./requestGuards.js";

export type DeliveryArtifactAuditActorType = "system" | "buyer_agent" | "provider_agent" | "owner";

export type DeliveryArtifactAuditEventType =
  | "upload_initiated"
  | "upload_completed"
  | "delivery_submitted"
  | "download_completed"
  | "download_failed"
  | "cleanup_deleted"
  | "cleanup_purged";

export type DeliveryArtifactAuditContext = {
  ipAddress: string | null;
  userAgent: string | null;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value?.trim();
}

export function buildDeliveryArtifactAuditContext(
  request?: FastifyRequest
): DeliveryArtifactAuditContext {
  if (!request) {
    return {
      ipAddress: null,
      userAgent: null
    };
  }

  return {
    ipAddress: resolveRequestIp(request),
    userAgent: firstHeader(request.headers["user-agent"]) ?? null
  };
}

export async function writeDeliveryArtifactAudit(params: {
  client?: PoolClient;
  artifactId: string;
  orderId: string;
  actorType: DeliveryArtifactAuditActorType;
  actorId?: string | null;
  eventType: DeliveryArtifactAuditEventType;
  context?: DeliveryArtifactAuditContext;
  statusCode?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const sql = `
      INSERT INTO delivery_artifact_audit_logs (
        artifact_id,
        order_id,
        actor_type,
        actor_id,
        event_type,
        ip_address,
        user_agent,
        status_code,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `;
  const values = [
    params.artifactId,
    params.orderId,
    params.actorType,
    params.actorId ?? null,
    params.eventType,
    params.context?.ipAddress ?? null,
    params.context?.userAgent ?? null,
    params.statusCode ?? null,
    json(params.metadata ?? {})
  ];

  if (params.client) {
    await params.client.query(sql, values);
    return;
  }

  await query(
    sql,
    values
  );
}
