#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);
const defaultOpenClawBase = process.env.OPENCLAW_BASE ?? "/home/ecs-user/openClaw";
const defaultCredentialsRoot = join(homedir(), ".config", "openslaw");

const config = {
  apiBase: process.env.OPENSLAW_API_BASE ?? "https://www.openslaw.com/api/v1",
  openClawBase: defaultOpenClawBase,
  openClawCli:
    process.env.OPENCLAW_CLI ?? "/home/ecs-user/openClaw/bin/openclaw-cli.sh",
  openClawAgentId: process.env.OPENCLAW_AGENT_ID ?? "main",
  apiKeyPath:
    process.env.OPENSLAW_API_KEY_PATH ?? join(defaultCredentialsRoot, "credentials.json"),
  credentialsRefPath:
    process.env.OPENSLAW_CREDENTIALS_REF_PATH ??
    join(defaultOpenClawBase, ".openslaw", "credentials_ref.json"),
  keeperStatePath:
    process.env.OPENSLAW_RELAY_KEEPER_STATE_PATH ??
    "/home/ecs-user/openClaw/state/logs/openslaw-relay-keeper-state.json",
  keeperEventsPath:
    process.env.OPENSLAW_RELAY_KEEPER_EVENTS_PATH ??
    "/home/ecs-user/openClaw/state/logs/openslaw-relay-events.jsonl",
  sessionStorePath:
    process.env.OPENCLAW_SESSION_STORE_PATH ??
    "/home/ecs-user/openClaw/state/agents/main/sessions/sessions.json",
  heartbeatIntervalMs: Number(process.env.OPENSLAW_RELAY_HEARTBEAT_INTERVAL_MS ?? 300000),
  pingIntervalMs: Number(process.env.OPENSLAW_RELAY_PING_INTERVAL_MS ?? 30000),
  reconnectInitialDelayMs: Number(
    process.env.OPENSLAW_RELAY_RECONNECT_INITIAL_DELAY_MS ?? 3000
  ),
  reconnectMaxDelayMs: Number(process.env.OPENSLAW_RELAY_RECONNECT_MAX_DELAY_MS ?? 60000),
  requestTimeoutMs: Number(process.env.OPENSLAW_RELAY_REQUEST_TIMEOUT_MS ?? 15000),
  agentTurnTimeoutSeconds: Number(process.env.OPENSLAW_AGENT_TURN_TIMEOUT_SECONDS ?? 300),
  maxTrackedDeliveries: Number(process.env.OPENSLAW_RELAY_MAX_TRACKED_DELIVERIES ?? 400)
};

let shutdownRequested = false;

class RelayAuthDriftError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "RelayAuthDriftError";
    this.extra = extra;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, message, extra = {}) {
  const payload = {
    ts: nowIso(),
    level,
    message,
    ...extra
  };
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

async function ensureParentDirectory(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function appendJsonLine(filePath, value) {
  await ensureParentDirectory(filePath);
  await appendFile(filePath, `${JSON.stringify(value)}\n`);
}

function expandHomePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return filePath;
  }

  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return join(homedir(), filePath.slice(2));
  }

  return filePath;
}

function resolveCredentialPath(candidatePath) {
  const expanded = expandHomePath(candidatePath);
  if (typeof expanded !== "string" || !expanded.trim()) {
    return null;
  }

  return expanded.startsWith("/") ? expanded : resolve(config.openClawBase, expanded);
}

async function resolveApiKeyPath() {
  if (process.env.OPENSLAW_API_KEY_PATH?.trim()) {
    return resolveCredentialPath(process.env.OPENSLAW_API_KEY_PATH.trim());
  }

  const refPayload = await readJsonFile(config.credentialsRefPath, {});
  if (typeof refPayload.path === "string" && refPayload.path.trim()) {
    const resolvedPath = resolveCredentialPath(refPayload.path.trim());
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return resolveCredentialPath(config.apiKeyPath);
}

function isInvalidApiKeyError(error) {
  return (
    error instanceof RelayAuthDriftError ||
    (error instanceof Error && error.message.includes("invalid_api_key"))
  );
}

async function loadApiCredentials() {
  const credentialPath = await resolveApiKeyPath();
  if (!credentialPath) {
    throw new Error("openslaw_api_key_path_missing");
  }

  const payload = await readJsonFile(credentialPath, {});
  const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";

  if (!apiKey) {
    throw new Error("openslaw_api_key_missing");
  }

  return {
    apiKey,
    credentialPath
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw response
  }

  if (!response.ok) {
    if (response.status === 401 && data && typeof data === "object" && data.error === "invalid_api_key") {
      throw new RelayAuthDriftError("invalid_api_key", {
        method: options.method ?? "GET",
        path
      });
    }

    throw new Error(
      `${options.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function runOpenClawCli(args) {
  const { stdout } = await execFileAsync(config.openClawCli, args, {
    maxBuffer: 8 * 1024 * 1024
  });

  return stdout.trim();
}

function parseTrailingJson(rawOutput) {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const firstBraceIndex = trimmed.indexOf("{");
  if (firstBraceIndex >= 0) {
    const candidate = trimmed.slice(firstBraceIndex);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      return JSON.parse(line);
    } catch {
      // continue
    }
  }

  return null;
}

async function loadSessionStore() {
  return readJsonFile(config.sessionStorePath, {});
}

async function resolveCurrentSessionId() {
  const sessions = await loadSessionStore();
  const entries = Object.values(sessions).filter(
    (value) => value && typeof value === "object" && typeof value.sessionId === "string"
  );

  if (entries.length === 0) {
    return null;
  }

  entries.sort((left, right) => {
    const leftUpdated = typeof left.updatedAt === "number" ? left.updatedAt : 0;
    const rightUpdated = typeof right.updatedAt === "number" ? right.updatedAt : 0;
    return rightUpdated - leftUpdated;
  });

  return entries[0].sessionId;
}

function normalizeMessageTarget(channelKind, target) {
  if (channelKind === "feishu" && !target.startsWith("user:") && !target.startsWith("chat:")) {
    return `user:${target}`;
  }

  return target;
}

function defaultKeeperState() {
  return {
    version: 1,
    relay: {
      connection_status: "disconnected",
      session_id: null,
      lease_expires_at: null,
      last_connect_attempt_at: null,
      last_ready_at: null,
      last_disconnect_reason: null
    },
    deliveries: {}
  };
}

async function loadKeeperState() {
  return readJsonFile(config.keeperStatePath, defaultKeeperState());
}

async function saveKeeperState(state) {
  const deliveryEntries = Object.entries(state.deliveries ?? {});
  if (deliveryEntries.length > config.maxTrackedDeliveries) {
    deliveryEntries.sort((left, right) => {
      const leftUpdated = new Date(left[1]?.updated_at ?? 0).getTime();
      const rightUpdated = new Date(right[1]?.updated_at ?? 0).getTime();
      return rightUpdated - leftUpdated;
    });

    state.deliveries = Object.fromEntries(
      deliveryEntries.slice(0, config.maxTrackedDeliveries)
    );
  }

  await writeJsonFile(config.keeperStatePath, state);
}

async function markDeliveryState(deliveryId, patch) {
  const state = await loadKeeperState();
  const current = state.deliveries[deliveryId] ?? {};
  state.deliveries[deliveryId] = {
    ...current,
    ...patch,
    updated_at: nowIso()
  };
  await saveKeeperState(state);
}

async function sendOwnerNotification(profile, providerOwnerHint, orderId) {
  const notifyTarget = profile?.profile?.notify_target_json ?? profile?.notify_target_json ?? {};
  const channelKind =
    typeof notifyTarget.channel_kind === "string" && notifyTarget.channel_kind.trim()
      ? notifyTarget.channel_kind.trim()
      : "feishu";
  const rawTarget =
    typeof notifyTarget.target === "string" && notifyTarget.target.trim()
      ? notifyTarget.target.trim()
      : "";

  if (!rawTarget) {
    throw new Error("notify_target_missing");
  }

  const target = normalizeMessageTarget(channelKind, rawTarget);
  const message = [
    providerOwnerHint.title,
    "",
    providerOwnerHint.body,
    providerOwnerHint.recommended_action
      ? `建议动作：${providerOwnerHint.recommended_action}`
      : null,
    `订单 ID：${orderId}`
  ]
    .filter(Boolean)
    .join("\n");

  const stdout = await runOpenClawCli([
    "message",
    "send",
    "--channel",
    channelKind,
    "--target",
    target,
    "--message",
    message,
    "--json"
  ]);

  let parsed = null;
  parsed = parseTrailingJson(stdout);
  if (!parsed) {
    parsed = { raw: stdout };
  }

  return {
    channel_kind: channelKind,
    target,
    result: parsed
  };
}

function buildRuntimePrompt(eventEnvelope) {
  const event = eventEnvelope.event ?? {};
  const summary = {
    delivery_id: eventEnvelope.delivery_id,
    event_type: event.event_type,
    order_id: event.order?.id ?? null,
    order_no: event.order?.order_no ?? null,
    order_status: event.order?.status ?? null,
    review_deadline_at: event.review_deadline_at ?? null,
    notification_hint: event.notification_hints?.provider_owner ?? null,
    workspace: {
      manifest_url: event.workspace?.manifest_url ?? null,
      local_bundle: event.workspace?.local_bundle ?? null
    },
    platform_actions: event.platform_actions ?? null,
    review: event.review ?? null
  };

  return [
    "OpenSlaw provider-side platform event received.",
    "Use the hosted OpenSlaw docs on https://www.openslaw.com as the source of truth.",
    "Do not invent extra relay endpoints, and do not ask the owner to paste email links or tokens back into chat.",
    "Keep buyer-side confirmation separate from provider-side execution.",
    "Do not ask the buyer whether the provider should accept the order.",
    "If order_status is accepted, the platform already auto-accepted the provider side.",
    "If order_status is queued_for_provider, only the provider owner may decide whether to accept.",
    "Treat the following platform event as authoritative and continue the formal provider workflow for this order.",
    "",
    JSON.stringify(summary, null, 2),
    "",
    "If this event requires provider action, continue with the same order and keep the OpenSlaw relay connected."
  ].join("\n");
}

async function dispatchEventToOpenClaw(eventEnvelope) {
  const sessionId = await resolveCurrentSessionId();
  const args = ["agent"];

  if (sessionId) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--agent", config.openClawAgentId);
  }

  args.push(
    "--message",
    buildRuntimePrompt(eventEnvelope),
    "--timeout",
    String(config.agentTurnTimeoutSeconds),
    "--thinking",
    "low",
    "--json"
  );

  const stdout = await runOpenClawCli(args);
  return parseTrailingJson(stdout) ?? { raw: stdout };
}

async function sendRuntimeEvent(eventUrl, body) {
  const path = eventUrl.replace(config.apiBase, "");
  const { apiKey } = await loadApiCredentials();
  return request(path, {
    method: "POST",
    token: apiKey,
    body
  });
}

async function handleProviderEvent(context, eventEnvelope) {
  const deliveryId =
    typeof eventEnvelope.delivery_id === "string" ? eventEnvelope.delivery_id : "";
  const event = eventEnvelope.event ?? {};
  const orderId = event.order?.id;

  if (!deliveryId || !orderId) {
    log("warn", "relay event missing delivery_id or order_id", { eventEnvelope });
    return;
  }

  await appendJsonLine(config.keeperEventsPath, {
    ts: nowIso(),
    type: "relay_event_received",
    delivery_id: deliveryId,
    event_type: event.event_type,
    order_id: orderId
  });

  const state = await loadKeeperState();
  const deliveryState = state.deliveries[deliveryId] ?? {};

  if (!deliveryState.acknowledged_at) {
    await context.sendJson({
      type: "ack",
      delivery_id: deliveryId
    });
    await markDeliveryState(deliveryId, {
      delivery_id: deliveryId,
      event_type: event.event_type,
      order_id: orderId,
      acknowledged_at: nowIso()
    });
  }

  const providerOwnerHint = event.notification_hints?.provider_owner ?? null;
  const runtimeEventUrl = event.platform_actions?.provider_runtime_event_url ?? null;

  if (
    providerOwnerHint?.should_notify_now === true &&
    runtimeEventUrl &&
    !deliveryState.owner_notified_at
  ) {
    const notificationResult = await sendOwnerNotification(
      context.profileSnapshot,
      providerOwnerHint,
      orderId
    );

    await sendRuntimeEvent(runtimeEventUrl, {
      event_type: "owner_notified",
      message: providerOwnerHint.title,
      details: {
        notification_reason: providerOwnerHint.reason,
        title: providerOwnerHint.title,
        body: providerOwnerHint.body,
        recommended_action: providerOwnerHint.recommended_action ?? null,
        relay_keeper: true
      }
    });

    await markDeliveryState(deliveryId, {
      owner_notified_at: nowIso(),
      owner_notification_result: notificationResult
    });
  }

  if (!deliveryState.runtime_dispatched_at) {
    const dispatchResult = await dispatchEventToOpenClaw(eventEnvelope);
    await markDeliveryState(deliveryId, {
      runtime_dispatched_at: nowIso(),
      runtime_dispatch_result: dispatchResult
    });
  }
}

async function heartbeat() {
  const { apiKey } = await loadApiCredentials();
  const response = await request("/provider/runtime-profile/openclaw/heartbeat", {
    method: "POST",
    token: apiKey,
    body: {
      runtime_health_status: "healthy",
      summary: "OpenClaw relay keeper online",
      details: {
        relay_keeper: true,
        relay_transport: "websocket",
        local_runtime: "openclaw"
      }
    }
  });

  return response;
}

async function setupRelay(apiKey) {
  return request("/provider/runtime-profile/openclaw/setup", {
    token: apiKey
  });
}

function makeBackoff(attempt) {
  const raw = config.reconnectInitialDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, config.reconnectMaxDelayMs);
}

async function connectRelay(apiKey, setup, profileSnapshot, callbacks = {}) {
  return new Promise((resolve, reject) => {
    let pingTimer = null;
    let settled = false;

    const ws = new WebSocket(setup.relay_url);
    callbacks.onSocket?.(ws);

    const context = {
      apiKey,
      profileSnapshot,
      sendJson(payload) {
        return new Promise((resolveSend, rejectSend) => {
          ws.send(JSON.stringify(payload), (error) => {
            if (error) {
              rejectSend(error);
              return;
            }

            resolveSend();
          });
        });
      }
    };

    function clearTimers() {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    }

    ws.on("open", async () => {
      try {
        const state = await loadKeeperState();
        state.relay.last_connect_attempt_at = nowIso();
        await saveKeeperState(state);

        await context.sendJson({
          type: "auth",
          api_key: apiKey
        });

        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }

          void context.sendJson({ type: "ping" }).catch((error) => {
            log("warn", "relay ping failed", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }, config.pingIntervalMs);

        pingTimer.unref?.();
      } catch (error) {
        clearTimers();
        ws.close();
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });

    ws.on("message", (rawMessage) => {
      void (async () => {
        let payload;
        try {
          payload = JSON.parse(String(rawMessage));
        } catch (error) {
          log("warn", "relay returned invalid json", {
            error: error instanceof Error ? error.message : String(error)
          });
          return;
        }

        if (payload.type === "ready") {
          const state = await loadKeeperState();
          state.relay = {
            connection_status: "connected",
            session_id: payload.session_id ?? null,
            lease_expires_at: payload.lease_expires_at ?? null,
            last_connect_attempt_at: state.relay.last_connect_attempt_at ?? nowIso(),
            last_ready_at: nowIso(),
            last_disconnect_reason: null
          };
          await saveKeeperState(state);

          log("info", "relay ready", {
            session_id: payload.session_id,
            lease_expires_at: payload.lease_expires_at
          });

          return;
        }

        if (payload.type === "pong") {
          return;
        }

        if (payload.type === "provider_event") {
          await handleProviderEvent(context, payload);
          return;
        }

        if (payload.type === "error") {
          if (payload.error === "invalid_api_key") {
            log("error", "relay returned invalid_api_key and will disconnect", payload);
            ws.close(4003, "invalid_api_key");
            return;
          }

          log("warn", "relay returned error payload", payload);
          return;
        }
      })().catch((error) => {
        if (isInvalidApiKeyError(error)) {
          log("error", "relay auth drift detected during event handling", {
            error: error.message
          });
          ws.close(4003, "invalid_api_key");
          return;
        }

        log("error", "relay message handling failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    ws.on("close", async (code, reasonBuffer) => {
      clearTimers();

      const reason =
        reasonBuffer && reasonBuffer.length > 0
          ? reasonBuffer.toString()
          : `socket_closed_${code}`;

      const state = await loadKeeperState();
      state.relay.connection_status = "disconnected";
      state.relay.last_disconnect_reason = reason;
      await saveKeeperState(state);

      log("warn", "relay closed", {
        code,
        reason
      });

      if (!settled) {
        settled = true;
        callbacks.onSocket?.(null);
        resolve();
      }
    });

    ws.on("error", (error) => {
      clearTimers();
      log("error", "relay socket error", {
        error: error instanceof Error ? error.message : String(error)
      });

      if (!settled) {
        settled = true;
        callbacks.onSocket?.(null);
        reject(error);
      }
    });
  });
}

async function mainLoop() {
  let reconnectAttempt = 0;
  let heartbeatTimer = null;
  let activeSocket = null;

  while (!shutdownRequested) {
    let apiKey = "";

    try {
      const credentials = await loadApiCredentials();
      apiKey = credentials.apiKey;
      const setup = await setupRelay(apiKey);
      const profileSnapshot = await heartbeat();

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }

      heartbeatTimer = setInterval(() => {
        void heartbeat()
          .then((profile) => {
            log("info", "relay heartbeat refreshed", {
              runtime_health_status: profile.profile?.runtime_health_status ?? null,
              order_push_ready: profile.profile?.automation_status?.order_push_ready ?? null,
              relay_connection_status:
                profile.profile?.automation_status?.relay_status?.connection_status ?? null
            });
          })
          .catch((error) => {
            if (isInvalidApiKeyError(error)) {
              log("error", "relay heartbeat auth failed; disconnecting until credentials are fixed", {
                error: error.message
              });
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
              if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
                activeSocket.close(4003, "invalid_api_key");
              }
              return;
            }

            log("warn", "relay heartbeat failed", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }, config.heartbeatIntervalMs);

      heartbeatTimer.unref?.();

      await connectRelay(apiKey, setup, profileSnapshot, {
        onSocket(socket) {
          activeSocket = socket;
        }
      });
      reconnectAttempt = 0;
    } catch (error) {
      reconnectAttempt += 1;
      const backoffMs = makeBackoff(reconnectAttempt);

      log("error", "relay keeper loop failed", {
        attempt: reconnectAttempt,
        backoff_ms: backoffMs,
        error: error instanceof Error ? error.message : String(error)
      });

      await sleep(backoffMs);
    }
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
}

process.on("SIGINT", () => {
  shutdownRequested = true;
});

process.on("SIGTERM", () => {
  shutdownRequested = true;
});

process.on("unhandledRejection", (error) => {
  log("error", "unhandled rejection", {
    error: error instanceof Error ? error.message : String(error)
  });
});

process.on("uncaughtException", (error) => {
  log("error", "uncaught exception", {
    error: error instanceof Error ? error.message : String(error)
  });
});

await ensureParentDirectory(config.keeperStatePath);
if (!existsSync(config.keeperStatePath)) {
  await writeJsonFile(config.keeperStatePath, defaultKeeperState());
}

log("info", "starting openclaw relay keeper", {
  api_base: config.apiBase,
  openclaw_base: config.openClawBase
});

await mainLoop();
