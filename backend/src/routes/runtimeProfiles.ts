import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import { config } from "../config.js";
import {
  automationModes,
  deriveRuntimeHealthStatus,
  ensureRuntimeProfile,
  getRuntimeAutomationStatus,
  getRuntimeChannelDeliverySummary,
  providerRuntimeEventTypes,
  runtimeHealthStatuses,
  runtimeKinds
} from "../domain/runtimeProfiles.js";
import { withTransaction } from "../db.js";

const runtimeProfileSelectSql = `
  SELECT id, agent_account_id, accept_mode, claimed_max_concurrency, validated_max_concurrency,
         queue_enabled, current_active_order_count, supports_parallel_delivery,
         supports_a2a, a2a_agent_card_url, provider_callback_url, callback_timeout_seconds,
         runtime_kind, runtime_label, automation_mode, automation_source, runtime_health_status,
         heartbeat_ttl_seconds, last_heartbeat_at, heartbeat_expires_at,
         relay_connection_status, relay_session_id, relay_connected_at,
         relay_last_activity_at, relay_lease_expires_at, relay_last_disconnect_reason,
         runtime_capabilities_json, runtime_authorization_json, notify_target_json,
         last_runtime_event_at, last_runtime_event_type, last_runtime_event_summary,
         created_at, updated_at
  FROM agent_runtime_profiles
  WHERE agent_account_id = $1
  LIMIT 1
`;

const notificationTargetSchema = z.object({
  channel_kind: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional().default("")
});

const openClawCapabilitiesSchema = z.object({
  local_order_root: z.string().min(1),
  can_write_local_order_root: z.boolean().default(true),
  supports_workspace_download: z.boolean().default(true),
  supports_result_upload: z.boolean().default(true),
  supports_notifications: z.boolean().default(true),
  notification_channels: z.array(z.string().min(1)).default([]),
  primary_owner_channel: z.string().default(""),
  supports_channel_file_delivery: z.boolean().default(false),
  channel_supported_artifact_types: z.array(z.string().min(1)).default([]),
  channel_max_direct_bytes: z.number().int().nonnegative().default(0),
  allowed_skill_keys: z.array(z.string().min(1)).default([]),
  allowed_command_scopes: z.array(z.string().min(1)).default([]),
  can_access_network: z.boolean().default(true)
});

const openClawAuthorizationSchema = z.object({
  mode: z.enum(automationModes),
  allow_download_inputs: z.boolean().default(true),
  allow_upload_outputs: z.boolean().default(true),
  allow_network_access: z.boolean().default(true),
  allow_channel_file_delivery: z.boolean().default(false),
  allow_channel_link_fallback: z.boolean().default(true),
  fallback_to_manual_on_blocked: z.boolean().default(true),
  max_runtime_seconds: z.number().int().positive().default(3600),
  note: z.string().default("")
});

const updateRuntimeProfileSchema = z
  .object({
    accept_mode: z.enum(["auto_accept", "owner_confirm_required"]),
    claimed_max_concurrency: z.number().int().positive(),
    queue_enabled: z.boolean(),
    supports_parallel_delivery: z.boolean(),
    supports_a2a: z.boolean(),
    a2a_agent_card_url: z.string().url().nullable().optional()
  })
  .superRefine((value, context) => {
    if (!value.supports_parallel_delivery && value.claimed_max_concurrency !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimed_max_concurrency"],
        message: "single-thread providers must keep claimed_max_concurrency = 1"
      });
    }

    if (value.supports_a2a && !value.a2a_agent_card_url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["a2a_agent_card_url"],
        message: "supports_a2a requires a2a_agent_card_url"
      });
    }
  });

const openClawAuthorizeSchema = z
  .object({
    runtime_label: z.string().min(1).default("OpenClaw"),
    heartbeat_ttl_seconds: z.number().int().min(30).max(3600).default(180),
    claimed_max_concurrency: z.number().int().positive().default(1),
    supports_parallel_delivery: z.boolean().default(false),
    capabilities: openClawCapabilitiesSchema,
    notification_target: notificationTargetSchema,
    authorization: openClawAuthorizationSchema
  })
  .superRefine((value, context) => {
    if (!value.supports_parallel_delivery && value.claimed_max_concurrency !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimed_max_concurrency"],
        message: "single-thread providers must keep claimed_max_concurrency = 1"
      });
    }

    if (value.authorization.mode === "openclaw_auto") {
      if (!value.capabilities.can_write_local_order_root) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "can_write_local_order_root"],
          message: "openclaw auto mode requires a writable local order root"
        });
      }

      if (!value.capabilities.supports_workspace_download) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "supports_workspace_download"],
          message: "openclaw auto mode requires workspace download support"
        });
      }

      if (!value.capabilities.supports_result_upload) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "supports_result_upload"],
          message: "openclaw auto mode requires result upload support"
        });
      }

      if (!value.capabilities.supports_notifications) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "supports_notifications"],
          message: "openclaw auto mode requires owner notification support"
        });
      }

      if (value.capabilities.notification_channels.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", "notification_channels"],
          message: "openclaw auto mode requires at least one notification channel"
        });
      }

      if (!value.authorization.allow_download_inputs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorization", "allow_download_inputs"],
          message: "openclaw auto mode requires input download authorization"
        });
      }

      if (!value.authorization.allow_upload_outputs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorization", "allow_upload_outputs"],
          message: "openclaw auto mode requires output upload authorization"
        });
      }

      if (!value.authorization.fallback_to_manual_on_blocked) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorization", "fallback_to_manual_on_blocked"],
          message: "openclaw auto mode requires manual fallback authorization"
        });
      }
    }
  });

const openClawHeartbeatSchema = z.object({
  runtime_health_status: z.enum(runtimeHealthStatuses).default("healthy"),
  heartbeat_ttl_seconds: z.number().int().min(30).max(3600).optional(),
  summary: z.string().default("openclaw heartbeat ok"),
  details: z.record(z.any()).default({})
});

function buildRuntimeRelayUrl() {
  if (config.publicApiBaseUrl) {
    const apiUrl = new URL(config.publicApiBaseUrl);
    if (
      apiUrl.protocol === "http:" &&
      apiUrl.port === String(config.ports.web)
    ) {
      return `ws://${apiUrl.hostname}:${config.port}/api/v1/provider/runtime-relay`;
    }

    const relayBase = config.publicApiBaseUrl.replace(/^http/, "ws");
    return `${relayBase}/provider/runtime-relay`;
  }

  return `ws://127.0.0.1:${config.port}/api/v1/provider/runtime-relay`;
}

function buildProfileResponse(profile: Record<string, unknown>) {
  const normalized = {
    ...profile,
    runtime_capabilities_json:
      profile.runtime_capabilities_json &&
      typeof profile.runtime_capabilities_json === "object" &&
      !Array.isArray(profile.runtime_capabilities_json)
        ? profile.runtime_capabilities_json
        : {},
    runtime_authorization_json:
      profile.runtime_authorization_json &&
      typeof profile.runtime_authorization_json === "object" &&
      !Array.isArray(profile.runtime_authorization_json)
        ? profile.runtime_authorization_json
        : {},
    notify_target_json:
      profile.notify_target_json &&
      typeof profile.notify_target_json === "object" &&
      !Array.isArray(profile.notify_target_json)
        ? profile.notify_target_json
        : {}
  };
  const runtimeProfile = normalized as unknown as Parameters<typeof getRuntimeAutomationStatus>[0];
  const healthProfile = normalized as unknown as Parameters<typeof deriveRuntimeHealthStatus>[0];
  const automationStatus = getRuntimeAutomationStatus(runtimeProfile);

  return {
    ...normalized,
    runtime_health_status: deriveRuntimeHealthStatus(healthProfile),
    automation_status: automationStatus,
    channel_delivery_summary: getRuntimeChannelDeliverySummary(runtimeProfile)
  };
}

export async function registerRuntimeProfileRoutes(app: FastifyInstance) {
  app.get("/api/v1/provider/runtime-profile", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const result = await withTransaction(async (client) => {
      await ensureRuntimeProfile(client, agent.id);
      const profileResult = await client.query(runtimeProfileSelectSql, [agent.id]);
      return buildProfileResponse(profileResult.rows[0] ?? {});
    });

    return result;
  });

  app.put("/api/v1/provider/runtime-profile", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = updateRuntimeProfileSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      await ensureRuntimeProfile(client, agent.id);

      const currentResult = await client.query<{
        validated_max_concurrency: number;
      }>(
        `
          SELECT validated_max_concurrency
          FROM agent_runtime_profiles
          WHERE agent_account_id = $1
          FOR UPDATE
        `,
        [agent.id]
      );

      const current = currentResult.rows[0];
      const claimedMaxConcurrency = body.supports_parallel_delivery
        ? body.claimed_max_concurrency
        : 1;
      const validatedMaxConcurrency = body.supports_parallel_delivery
        ? Math.min(current.validated_max_concurrency, claimedMaxConcurrency)
        : 1;

      await client.query(
        `
          UPDATE agent_runtime_profiles
          SET accept_mode = $2,
              claimed_max_concurrency = $3,
              validated_max_concurrency = $4,
              queue_enabled = $5,
              supports_parallel_delivery = $6,
              supports_a2a = $7,
              a2a_agent_card_url = $8,
              provider_callback_url = NULL,
              automation_mode = CASE
                WHEN $2 = 'owner_confirm_required' THEN 'manual'
                ELSE automation_mode
              END,
              automation_source = CASE
                WHEN $2 = 'owner_confirm_required' AND automation_mode = 'openclaw_auto'
                  THEN 'owner_console'
                ELSE automation_source
              END,
              updated_at = NOW()
          WHERE agent_account_id = $1
        `,
        [
          agent.id,
          body.accept_mode,
          claimedMaxConcurrency,
          validatedMaxConcurrency,
          body.queue_enabled,
          body.supports_parallel_delivery,
          body.supports_a2a,
          body.supports_a2a ? body.a2a_agent_card_url ?? null : null
        ]
      );

      const profileResult = await client.query(runtimeProfileSelectSql, [agent.id]);
      return buildProfileResponse(profileResult.rows[0] ?? {});
    });

    return result;
  });

  app.get("/api/v1/provider/runtime-relay", async (_request, reply) => {
    reply.code(426).send({
      error: "websocket_upgrade_required",
      relay_url: buildRuntimeRelayUrl(),
      relay_protocol: "openslaw-relay-v1"
    });
  });

  app.post("/api/v1/provider/runtime-profile/openclaw/authorize", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = openClawAuthorizeSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      await ensureRuntimeProfile(client, agent.id);

      const currentResult = await client.query<{
        validated_max_concurrency: number;
      }>(
        `
          SELECT validated_max_concurrency
          FROM agent_runtime_profiles
          WHERE agent_account_id = $1
          FOR UPDATE
        `,
        [agent.id]
      );

      const current = currentResult.rows[0];
      const claimedMaxConcurrency = body.supports_parallel_delivery
        ? body.claimed_max_concurrency
        : 1;
      const validatedMaxConcurrency = body.supports_parallel_delivery
        ? Math.min(current.validated_max_concurrency, claimedMaxConcurrency)
        : 1;
      const acceptMode =
        body.authorization.mode === "openclaw_auto" ? "auto_accept" : "owner_confirm_required";
      const now = new Date();
      const heartbeatExpiresAt = new Date(
        now.getTime() + body.heartbeat_ttl_seconds * 1000
      ).toISOString();
      const summary =
        body.authorization.mode === "openclaw_auto"
          ? "openclaw native auto mode enabled"
          : "openclaw manual mode retained";

      await client.query(
        `
          UPDATE agent_runtime_profiles
          SET accept_mode = $2,
              claimed_max_concurrency = $3,
              validated_max_concurrency = $4,
              queue_enabled = TRUE,
              supports_parallel_delivery = $5,
              provider_callback_url = NULL,
              runtime_kind = 'openclaw',
              runtime_label = $6,
              automation_mode = $7,
              automation_source = 'openclaw_native',
              runtime_health_status = 'healthy',
              heartbeat_ttl_seconds = $8,
              last_heartbeat_at = NOW(),
              heartbeat_expires_at = $9::timestamptz,
              relay_connection_status = 'disconnected',
              relay_session_id = NULL,
              relay_connected_at = NULL,
              relay_last_activity_at = NULL,
              relay_lease_expires_at = NULL,
              relay_last_disconnect_reason = 'relay_not_connected',
              runtime_capabilities_json = $10::jsonb,
              runtime_authorization_json = $11::jsonb,
              notify_target_json = $12::jsonb,
              last_runtime_event_at = NOW(),
              last_runtime_event_type = 'openclaw_authorized',
              last_runtime_event_summary = $13,
              updated_at = NOW()
          WHERE agent_account_id = $1
        `,
        [
          agent.id,
          acceptMode,
          claimedMaxConcurrency,
          validatedMaxConcurrency,
          body.supports_parallel_delivery,
          body.runtime_label,
          body.authorization.mode,
          body.heartbeat_ttl_seconds,
          heartbeatExpiresAt,
          JSON.stringify(body.capabilities),
          JSON.stringify(body.authorization),
          JSON.stringify(body.notification_target),
          summary
        ]
      );

      const profileResult = await client.query(runtimeProfileSelectSql, [agent.id]);
      return {
        profile: buildProfileResponse(profileResult.rows[0] ?? {})
      };
    });

    return result;
  });

  app.post("/api/v1/provider/runtime-profile/openclaw/heartbeat", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = openClawHeartbeatSchema.parse(request.body ?? {});

    const result = await withTransaction(async (client) => {
      await ensureRuntimeProfile(client, agent.id);

      const currentResult = await client.query<{
        runtime_kind: (typeof runtimeKinds)[number];
        heartbeat_ttl_seconds: number;
      }>(
        `
          SELECT runtime_kind, heartbeat_ttl_seconds
          FROM agent_runtime_profiles
          WHERE agent_account_id = $1
          FOR UPDATE
        `,
        [agent.id]
      );

      const current = currentResult.rows[0];
      if (current?.runtime_kind !== "openclaw") {
        throw new Error("runtime_not_openclaw");
      }

      const ttlSeconds = body.heartbeat_ttl_seconds ?? current.heartbeat_ttl_seconds;
      const heartbeatExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      await client.query(
        `
          UPDATE agent_runtime_profiles
          SET runtime_health_status = $2,
              heartbeat_ttl_seconds = $3,
              last_heartbeat_at = NOW(),
              heartbeat_expires_at = $4::timestamptz,
              last_runtime_event_at = NOW(),
              last_runtime_event_type = 'openclaw_heartbeat',
              last_runtime_event_summary = $5,
              updated_at = NOW()
          WHERE agent_account_id = $1
        `,
        [agent.id, body.runtime_health_status, ttlSeconds, heartbeatExpiresAt, body.summary]
      );

      const profileResult = await client.query(runtimeProfileSelectSql, [agent.id]);
      return {
        profile: buildProfileResponse(profileResult.rows[0] ?? {}),
        next_heartbeat_due_at: heartbeatExpiresAt
      };
    }).catch((error: Error) => {
      if (error.message === "runtime_not_openclaw") {
        reply.code(409).send({ error: "runtime_not_openclaw" });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });

  app.get("/api/v1/provider/runtime-profile/openclaw/setup", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const apiBase = config.publicApiBaseUrl ?? `http://127.0.0.1:${config.port}/api/v1`;
    return {
      runtime_kind: "openclaw",
      preferred_setup_surface: "openclaw_native",
      requires_extra_download: false,
      authorize_url: `${apiBase}/provider/runtime-profile/openclaw/authorize`,
      heartbeat_url: `${apiBase}/provider/runtime-profile/openclaw/heartbeat`,
      relay_url: buildRuntimeRelayUrl(),
      relay_protocol: "openslaw-relay-v1",
      relay_auth_mode: "first_message_api_key",
      relay_ack_message_type: "ack",
      relay_standby_after_hours: config.runtimeRelay.leaseHours,
      relay_resume_rule:
        "After 48 hours without business activity, the relay enters standby. The next active OpenSlaw use should reconnect the relay and start a fresh 48 hour lease.",
      supported_runtime_events: providerRuntimeEventTypes,
      owner_briefing: {
        intro_message: "检测到你的 OpenClaw 可以接入 OpenSlaw 自动模式。",
        recommended_mode_message:
          "推荐开启默认自动模式。开启后，OpenClaw 会在下一次主动使用 OpenSlaw skill 时连上平台 relay；只要 relay 在 48 小时租约内保持活跃，符合当前商品规则的订单会自动接单、自动开始执行，并在关键节点主动通知你。只有缺少素材、超出授权范围、执行失败或运行时异常时，才需要你回来处理。",
        manual_mode_message: "如果你不想让它自动开工，也可以改成手动模式。",
        closing_note: "平台网站只做状态镜像，不是首次配置入口。"
      },
      runtime_facts_to_explain: [
        {
          key: "local_order_root",
          label: "本地订单目录",
          owner_question: "是否接受 OpenClaw 在这个本地目录里创建和维护订单工作区？",
          required: true
        },
        {
          key: "notification_target",
          label: "主人通知渠道",
          owner_question: "是否接受通过这个通知渠道接收关键节点提醒？",
          required: true
        },
        {
          key: "primary_owner_channel",
          label: "主要聊天前端",
          owner_question: "是否确认当前飞书、WhatsApp 或其他聊天会话就是主要文件回传前端？",
          required: true
        },
        {
          key: "channel_supported_artifact_types",
          label: "聊天可直发的文件类型",
          owner_question: "是否接受当前聊天前端只会直接回传这里列出的文件类型，其余情况会改走安全链接？",
          required: true
        },
        {
          key: "channel_max_direct_bytes",
          label: "聊天直发大小上限",
          owner_question: "是否确认当前聊天前端只会对这个大小以内的交付包尝试直发？",
          required: true
        },
        {
          key: "allowed_skill_keys",
          label: "允许使用的 skills",
          owner_question: "是否确认这次自动执行只会使用这里列出的 skills？",
          required: true
        },
        {
          key: "allowed_command_scopes",
          label: "允许使用的命令范围",
          owner_question: "是否确认自动执行只会在这里列出的命令范围内运行？",
          required: true
        },
        {
          key: "claimed_max_concurrency",
          label: "最大并发数",
          owner_question: "是否接受这个运行时的最大并发数设置？",
          required: true
        }
      ],
      owner_confirmation_items: [
        {
          key: "automation_mode",
          label: "自动模式选择",
          owner_question: "是否按推荐开启默认自动模式，而不是保留手动模式？",
          required: true
        },
        {
          key: "notification_target",
          label: "通知渠道确认",
          owner_question: "是否确认关键节点通知会发到当前配置的主人通知渠道？",
          required: true
        },
        {
          key: "allow_channel_file_delivery",
          label: "聊天文件镜像确认",
          owner_question: "如果聊天前端支持，是否确认把最终交付文件镜像发回当前聊天会话？",
          required: true
        },
        {
          key: "allow_channel_link_fallback",
          label: "聊天链接回退确认",
          owner_question: "如果文件太大、类型不适合或权限不足，是否确认改发安全下载链接而不是只发文字？",
          required: true
        },
        {
          key: "allowed_skill_keys",
          label: "技能范围确认",
          owner_question: "是否确认自动执行只会调用当前列出的技能集合？",
          required: true
        },
        {
          key: "allowed_command_scopes",
          label: "命令范围确认",
          owner_question: "是否确认自动执行只会使用当前列出的命令范围？",
          required: true
        }
      ],
      owner_authorization_items: [
        {
          key: "allow_download_inputs",
          label: "下载买方素材",
          owner_question: "是否授权 OpenClaw 自动下载买方输入和订单工作区内容到本地订单目录？",
          required: true
        },
        {
          key: "allow_upload_outputs",
          label: "上传交付结果",
          owner_question: "是否授权 OpenClaw 自动把最终交付结果上传回 OpenSlaw？",
          required: true
        },
        {
          key: "allow_network_access",
          label: "网络访问",
          owner_question: "是否授权 OpenClaw 为本次自动执行访问所需网络资源？",
          required: true
        },
        {
          key: "allow_channel_file_delivery",
          label: "聊天文件镜像",
          owner_question: "是否授权 OpenClaw 在权限允许时把最终文件直接发回当前聊天前端？",
          required: true
        },
        {
          key: "allow_channel_link_fallback",
          label: "聊天链接回退",
          owner_question: "若聊天前端不能直接承载文件，是否授权 OpenClaw 改发正式安全链接？",
          required: true
        },
        {
          key: "fallback_to_manual_on_blocked",
          label: "失败回退人工接管",
          owner_question: "如果缺素材、超范围或执行失败，是否授权自动回退到人工接管并通知主人？",
          required: true
        }
      ],
      owner_notification_contract: {
        message_source: "relay_event.event.notification_hints.provider_owner",
        reuse_default_message_required: true,
        report_runtime_event_type: "owner_notified",
        event_url_source: "relay_event.event.platform_actions.provider_runtime_event_url",
        required_details_fields: ["notification_reason", "title", "body"]
      },
      owner_mode_choices: {
        recommended_mode: "openclaw_auto",
        choices: [
          {
            mode: "openclaw_auto",
            label: "开启默认自动模式（推荐）",
            description:
              "新订单会自动接单并开始执行；关键节点会主动通知主人；只有缺素材、超范围、失败或异常时才回退人工接管。",
            recommended: true
          },
          {
            mode: "manual",
            label: "改为手动模式",
            description: "订单不会自动开工。主人或运行时需要手动确认后，才会开始执行。",
            recommended: false
          }
        ]
      },
      setup_steps: [
        "Open the OpenClaw native settings page or chat card for OpenSlaw.",
        "State owner_briefing first instead of inventing a separate intro message.",
        "Explain the local facts listed in runtime_facts_to_explain using the real OpenClaw runtime values.",
        "Ask the owner to confirm every item in owner_confirmation_items and owner_authorization_items.",
        "Tell the owner that formal delivery truth stays in the OpenSlaw order workspace and local order bundle, while Feishu or WhatsApp only receives a convenience mirror when permissions and channel capability allow it.",
        "Only let the owner choose between the two formal owner_mode_choices.",
        "Confirm the authorization summary. OpenClaw then calls the authorize endpoint, starts heartbeat reporting, and opens the WebSocket relay with its OpenSlaw API key as the first auth message.",
        "When a relay event says notification_hints.provider_owner.should_notify_now = true, reuse that title/body as the default owner message and report owner_notified through the runtime event endpoint.",
        "If the relay sees no business activity for 48 hours, let it enter standby. The next active OpenSlaw use should reconnect the relay instead of keeping an always-on socket forever.",
        "No extra OpenSlaw-side package download is required beyond the existing OpenClaw runtime and the skills you already keep locally."
      ],
      status_note:
        "Configure this from OpenClaw settings or chat cards first. Owner Console is mirror-only."
    };
  });
}
