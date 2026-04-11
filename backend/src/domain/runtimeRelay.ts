import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthenticatedAgent } from "../auth.js";
import { findAgentByBearerToken } from "../auth.js";
import { config } from "../config.js";
import { query, withTransaction } from "../db.js";

export const relayConnectionStatuses = ["disconnected", "connected", "standby"] as const;
export const relayDeliveryStates = ["queued", "sent", "acknowledged", "expired"] as const;

type RelayConnectionStatus = (typeof relayConnectionStatuses)[number];

type RelayLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type RuntimeRelayStatusFields = {
  relay_connection_status: RelayConnectionStatus;
  relay_connected_at: string | null;
  relay_last_activity_at: string | null;
  relay_lease_expires_at: string | null;
  relay_session_id: string | null;
  relay_last_disconnect_reason: string | null;
};

type RelayQueueRow = {
  id: string;
  order_id: string | null;
  delivery_id: string;
  event_type: string;
  payload_json: Record<string, unknown>;
  delivery_state: (typeof relayDeliveryStates)[number];
  delivery_attempt_count: number;
};

type RelaySocketState = {
  authenticated: boolean;
  agent: AuthenticatedAgent | null;
  agentId: string | null;
  sessionId: string | null;
  authTimer: NodeJS.Timeout | null;
};

type RelayConnection = {
  socket: WebSocket;
  state: RelaySocketState;
  leaseExpiresAtMs: number;
};

const relayConnections = new Map<string, RelayConnection>();
const relaySocketStates = new WeakMap<WebSocket, RelaySocketState>();

let relayServer: WebSocketServer | null = null;
let relayLogger: RelayLogger = console;
let relaySweepTimer: NodeJS.Timeout | null = null;

function safeParseDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function buildRuntimeRelayLeaseExpiresAt(baseDate = new Date()) {
  return new Date(
    baseDate.getTime() + config.runtimeRelay.leaseHours * 60 * 60 * 1000
  ).toISOString();
}

export function deriveRuntimeRelayConnectionStatus(
  profile: Pick<RuntimeRelayStatusFields, "relay_connection_status" | "relay_lease_expires_at">
): RelayConnectionStatus {
  const stored = relayConnectionStatuses.includes(profile.relay_connection_status)
    ? profile.relay_connection_status
    : "disconnected";
  const leaseExpiresAt = safeParseDate(profile.relay_lease_expires_at);

  if (stored === "connected") {
    if (!leaseExpiresAt || leaseExpiresAt <= Date.now()) {
      return "standby";
    }

    return "connected";
  }

  if (stored === "standby") {
    return "standby";
  }

  return "disconnected";
}

export function getRuntimeRelayStatus(profile: RuntimeRelayStatusFields) {
  const connectionStatus = deriveRuntimeRelayConnectionStatus(profile);
  const blockers: string[] = [];

  if (connectionStatus === "standby") {
    blockers.push("relay_standby");
  } else if (connectionStatus !== "connected") {
    blockers.push("relay_connection_disconnected");
  }

  return {
    connection_status: connectionStatus,
    connected_at: profile.relay_connected_at,
    last_activity_at: profile.relay_last_activity_at,
    lease_expires_at: profile.relay_lease_expires_at,
    last_disconnect_reason: profile.relay_last_disconnect_reason,
    lease_hours: config.runtimeRelay.leaseHours,
    premium_lease_hours: config.runtimeRelay.premiumLeaseHours,
    blockers
  };
}

function relayPathnameMatches(request: IncomingMessage) {
  const url = request.url ? new URL(request.url, "http://runtime-relay.local") : null;
  return url?.pathname === "/api/v1/provider/runtime-relay";
}

async function resetConnectedRelaySessions() {
  await query(
    `
      UPDATE agent_runtime_profiles
      SET relay_connection_status = 'disconnected',
          relay_session_id = NULL,
          relay_connected_at = NULL,
          relay_last_disconnect_reason = 'server_restarted',
          updated_at = NOW()
      WHERE relay_connection_status = 'connected'
    `
  );
}

function clearSocketAuthTimer(state: RelaySocketState) {
  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }
}

async function markRelayConnected(agentId: string, sessionId: string) {
  const now = new Date();
  const leaseExpiresAt = buildRuntimeRelayLeaseExpiresAt(now);

  await query(
    `
      UPDATE agent_runtime_profiles
      SET relay_connection_status = 'connected',
          relay_session_id = $2,
          relay_connected_at = NOW(),
          relay_last_activity_at = NOW(),
          relay_lease_expires_at = $3::timestamptz,
          relay_last_disconnect_reason = NULL,
          updated_at = NOW()
      WHERE agent_account_id = $1
    `,
    [agentId, sessionId, leaseExpiresAt]
  );

  return leaseExpiresAt;
}

export async function touchRelayLeaseActivity(params: {
  agentId: string;
  sessionId?: string | null;
  summary?: string | null;
}) {
  const leaseExpiresAt = buildRuntimeRelayLeaseExpiresAt();
  const result = await query<{ relay_connection_status: RelayConnectionStatus }>(
    `
      UPDATE agent_runtime_profiles
      SET relay_last_activity_at = NOW(),
          relay_lease_expires_at = $3::timestamptz,
          updated_at = NOW()
      WHERE agent_account_id = $1
        AND relay_connection_status = 'connected'
        AND ($2::text IS NULL OR relay_session_id = $2)
      RETURNING relay_connection_status
    `,
    [params.agentId, params.sessionId ?? null, leaseExpiresAt]
  );

  const connection = relayConnections.get(params.agentId);
  if (connection && (!params.sessionId || connection.state.sessionId === params.sessionId)) {
    connection.leaseExpiresAtMs = safeParseDate(leaseExpiresAt) ?? Date.now();
  }

  return {
    updated: (result.rowCount ?? 0) > 0,
    lease_expires_at: leaseExpiresAt
  };
}

async function markRelayDisconnected(params: {
  agentId: string;
  sessionId: string | null;
  reason: string;
  standby: boolean;
}) {
  await query(
    `
      UPDATE agent_runtime_profiles
      SET relay_connection_status = $3,
          relay_session_id = NULL,
          relay_connected_at = CASE WHEN $3 = 'standby' THEN relay_connected_at ELSE NULL END,
          relay_last_disconnect_reason = $4,
          updated_at = NOW()
      WHERE agent_account_id = $1
        AND ($2::text IS NULL OR relay_session_id = $2 OR relay_session_id IS NULL)
    `,
    [params.agentId, params.sessionId, params.standby ? "standby" : "disconnected", params.reason]
  );
}

async function markRelayEventAcknowledged(params: {
  agentId: string;
  sessionId: string;
  deliveryId: string;
}) {
  await withTransaction(async (client) => {
    const eventResult = await client.query<{
      order_id: string | null;
      event_type: string;
    }>(
      `
        UPDATE runtime_relay_events
        SET delivery_state = 'acknowledged',
            acknowledged_at = NOW(),
            relay_session_id = $3,
            updated_at = NOW()
        WHERE agent_account_id = $1
          AND delivery_id = $2::uuid
          AND delivery_state <> 'acknowledged'
        RETURNING order_id, event_type
      `,
      [params.agentId, params.deliveryId, params.sessionId]
    );

    const relayEvent = eventResult.rows[0];
    if (!relayEvent) {
      return;
    }

    if (relayEvent.order_id) {
      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES ($1, 'provider_relay_acknowledged', 'system', NULL, $2::jsonb)
        `,
        [
          relayEvent.order_id,
          JSON.stringify({
            delivery_id: params.deliveryId,
            relay_event_type: relayEvent.event_type,
            relay_session_id: params.sessionId
          })
        ]
      );
    }
  });

  await touchRelayLeaseActivity({
    agentId: params.agentId,
    sessionId: params.sessionId
  });
}

async function markRelayEventSent(params: {
  agentId: string;
  sessionId: string;
  deliveryId: string;
}) {
  await query(
    `
      UPDATE runtime_relay_events
      SET delivery_state = 'sent',
          delivered_at = NOW(),
          last_delivery_attempt_at = NOW(),
          delivery_attempt_count = delivery_attempt_count + 1,
          relay_session_id = $3,
          updated_at = NOW()
      WHERE agent_account_id = $1
        AND delivery_id = $2::uuid
        AND delivery_state IN ('queued', 'sent')
    `,
    [params.agentId, params.deliveryId, params.sessionId]
  );

  await touchRelayLeaseActivity({
    agentId: params.agentId,
    sessionId: params.sessionId
  });
}

async function loadPendingRelayEvents(agentId: string) {
  const result = await query<RelayQueueRow>(
    `
      SELECT id,
             order_id,
             delivery_id,
             event_type,
             payload_json,
             delivery_state,
             delivery_attempt_count
      FROM runtime_relay_events
      WHERE agent_account_id = $1
        AND delivery_state IN ('queued', 'sent')
      ORDER BY created_at ASC
      LIMIT $2
    `,
    [agentId, config.runtimeRelay.pendingReplayBatchSize]
  );

  return result.rows.map((row) => ({
    ...row,
    payload_json:
      row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
        ? row.payload_json
        : {}
  }));
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>) {
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function sendRelayEvent(connection: RelayConnection, relayEvent: RelayQueueRow) {
  if (connection.socket.readyState !== WebSocket.OPEN || !connection.state.sessionId) {
    return false;
  }

  await sendJson(connection.socket, {
    type: "provider_event",
    delivery_id: relayEvent.delivery_id,
    event: relayEvent.payload_json
  });

  await markRelayEventSent({
    agentId: connection.state.agentId as string,
    sessionId: connection.state.sessionId,
    deliveryId: relayEvent.delivery_id
  });

  return true;
}

async function flushPendingRelayEvents(agentId: string) {
  const connection = relayConnections.get(agentId);
  if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
    return { delivered_count: 0, skipped: true };
  }

  const pendingEvents = await loadPendingRelayEvents(agentId);
  let deliveredCount = 0;

  for (const relayEvent of pendingEvents) {
    try {
      const delivered = await sendRelayEvent(connection, relayEvent);
      if (!delivered) {
        break;
      }

      deliveredCount += 1;
    } catch (error) {
      relayLogger.warn(error, "runtime relay send failed");
      try {
        connection.socket.close(1011, "relay_send_failed");
      } catch {
        // ignore close errors
      }
      break;
    }
  }

  return {
    delivered_count: deliveredCount,
    skipped: false
  };
}

function buildSocketState(): RelaySocketState {
  return {
    authenticated: false,
    agent: null,
    agentId: null,
    sessionId: null,
    authTimer: null
  };
}

async function authenticateRelaySocket(socket: WebSocket, state: RelaySocketState, agent: AuthenticatedAgent) {
  clearSocketAuthTimer(state);

  const sessionId = randomUUID();
  const existing = relayConnections.get(agent.id);
  if (existing && existing.socket !== socket) {
    try {
      existing.socket.close(4002, "relay_session_replaced");
    } catch {
      // ignore close errors
    }
  }

  const leaseExpiresAt = await markRelayConnected(agent.id, sessionId);
  state.authenticated = true;
  state.agent = agent;
  state.agentId = agent.id;
  state.sessionId = sessionId;

  const leaseExpiresAtMs = safeParseDate(leaseExpiresAt) ?? Date.now();
  relayConnections.set(agent.id, {
    socket,
    state,
    leaseExpiresAtMs
  });

  await sendJson(socket, {
    type: "ready",
    protocol: "openslaw-relay-v1",
    session_id: sessionId,
    lease_hours: config.runtimeRelay.leaseHours,
    premium_lease_hours: config.runtimeRelay.premiumLeaseHours,
    lease_expires_at: leaseExpiresAt
  });

  await flushPendingRelayEvents(agent.id);
}

function closeUnauthenticatedSocket(socket: WebSocket, state: RelaySocketState) {
  state.authTimer = setTimeout(() => {
    if (!state.authenticated && socket.readyState === WebSocket.OPEN) {
      socket.close(4001, "relay_auth_timeout");
    }
  }, config.runtimeRelay.authTimeoutSeconds * 1000);

  state.authTimer.unref?.();
}

async function maybeAuthenticateFromHeader(socket: WebSocket, state: RelaySocketState, request: IncomingMessage) {
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;

  const agent = await findAgentByBearerToken(authorization);
  if (!agent || agent.status !== "active") {
    return false;
  }

  await authenticateRelaySocket(socket, state, agent);
  return true;
}

function setupRelaySocket(socket: WebSocket, request: IncomingMessage) {
  const state = buildSocketState();
  relaySocketStates.set(socket, state);
  closeUnauthenticatedSocket(socket, state);

  void maybeAuthenticateFromHeader(socket, state, request).catch((error) => {
    relayLogger.warn(error, "runtime relay header auth failed");
  });

  socket.on("message", (rawMessage) => {
    void (async () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(rawMessage));
      } catch {
        await sendJson(socket, {
          type: "error",
          error: "invalid_json"
        }).catch(() => undefined);
        return;
      }

      if (!state.authenticated) {
        if (payload.type !== "auth" || typeof payload.api_key !== "string" || !payload.api_key.trim()) {
          await sendJson(socket, {
            type: "error",
            error: "relay_auth_required"
          }).catch(() => undefined);
          return;
        }

        const agent = await findAgentByBearerToken(`Bearer ${payload.api_key.trim()}`);
        if (!agent || agent.status !== "active") {
          await sendJson(socket, {
            type: "error",
            error: "invalid_api_key"
          }).catch(() => undefined);
          socket.close(4003, "invalid_api_key");
          return;
        }

        if (relayConnections.size >= config.runtimeRelay.maxConnections && !relayConnections.has(agent.id)) {
          await sendJson(socket, {
            type: "error",
            error: "relay_capacity_reached"
          }).catch(() => undefined);
          socket.close(1013, "relay_capacity_reached");
          return;
        }

        await authenticateRelaySocket(socket, state, agent);
        return;
      }

      if (payload.type === "ack" && typeof payload.delivery_id === "string") {
        await markRelayEventAcknowledged({
          agentId: state.agentId as string,
          sessionId: state.sessionId as string,
          deliveryId: payload.delivery_id
        });
        return;
      }

      if (payload.type === "ping") {
        await sendJson(socket, {
          type: "pong",
          session_id: state.sessionId
        }).catch(() => undefined);
        return;
      }

      await sendJson(socket, {
        type: "error",
        error: "unknown_relay_message_type"
      }).catch(() => undefined);
    })().catch((error) => {
      relayLogger.warn(error, "runtime relay message handling failed");
    });
  });

  socket.on("close", (code, reasonBuffer) => {
    clearSocketAuthTimer(state);

    if (!state.agentId) {
      return;
    }

    const current = relayConnections.get(state.agentId);
    if (current?.socket === socket) {
      relayConnections.delete(state.agentId);
      void markRelayDisconnected({
        agentId: state.agentId,
        sessionId: state.sessionId,
        reason:
          reasonBuffer && reasonBuffer.length > 0
            ? reasonBuffer.toString()
            : `socket_closed_${code}`,
        standby: false
      }).catch((error) => {
        relayLogger.warn(error, "runtime relay disconnect state update failed");
      });
    }
  });

  socket.on("error", (error) => {
    relayLogger.warn(error, "runtime relay socket error");
  });
}

async function sweepRelayConnections() {
  const now = Date.now();
  const expiredAgentIds: string[] = [];

  for (const [agentId, connection] of relayConnections.entries()) {
    if (connection.leaseExpiresAtMs <= now) {
      expiredAgentIds.push(agentId);
      try {
        connection.socket.close(4000, "relay_idle_expired");
      } catch {
        // ignore close errors
      }
    }
  }

  for (const agentId of expiredAgentIds) {
    const connection = relayConnections.get(agentId);
    if (!connection?.state.sessionId) {
      continue;
    }

    relayConnections.delete(agentId);
    await markRelayDisconnected({
      agentId,
      sessionId: connection.state.sessionId,
      reason: "relay_idle_expired",
      standby: true
    });
  }
}

export async function initializeRuntimeRelay(server: HttpServer, logger: RelayLogger) {
  if (relayServer) {
    return;
  }

  relayLogger = logger;
  await resetConnectedRelaySessions();

  relayServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024
  });

  server.on("upgrade", (request, socket, head) => {
    if (!relayServer || !relayPathnameMatches(request)) {
      return;
    }

    relayServer.handleUpgrade(request, socket, head, (ws) => {
      setupRelaySocket(ws, request);
    });
  });

  relaySweepTimer = setInterval(() => {
    void sweepRelayConnections().catch((error) => {
      relayLogger.warn(error, "runtime relay sweep failed");
    });
  }, config.runtimeRelay.sweepIntervalSeconds * 1000);

  relaySweepTimer.unref?.();
}

export async function flushRuntimeRelayQueue(agentId: string) {
  return flushPendingRelayEvents(agentId);
}
