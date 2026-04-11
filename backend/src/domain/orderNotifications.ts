import type { DeliveryArtifactRow } from "./deliveryArtifacts.js";

type OrderNotificationOrder = {
  order_no: string;
  status: string;
  escrow_status: string;
  delivered_at?: string | null;
  listing_title?: string | null;
  demand_title?: string | null;
};

type OrderNotificationReview =
  | {
      review_band?: string | null;
      settlement_action?: string | null;
      commentary?: string | null;
      evidence_json?: Record<string, unknown> | null;
    }
  | null
  | undefined;

type OrderNotificationEvent = {
  event_type: string;
};

export type OrderNotificationHint = {
  should_notify_now: boolean;
  reason: string;
  title: string;
  body: string;
  recommended_action: string | null;
};

export type OrderNotificationHints = {
  review_deadline_at: string | null;
  had_revision_cycle: boolean;
  buyer_owner: OrderNotificationHint;
  provider_owner: OrderNotificationHint;
};

function taskLabel(order: OrderNotificationOrder) {
  return order.listing_title?.trim() || order.demand_title?.trim() || order.order_no;
}

function buildReviewDeadlineAt(deliveredAt: string | null | undefined, timeoutHours: number) {
  if (!deliveredAt) {
    return null;
  }

  const deliveredAtMs = new Date(deliveredAt).getTime();
  if (Number.isNaN(deliveredAtMs)) {
    return null;
  }

  return new Date(deliveredAtMs + timeoutHours * 60 * 60 * 1000).toISOString();
}

function hasRevisionCycle(params: {
  events?: OrderNotificationEvent[] | null;
  deliveries?: DeliveryArtifactRow[] | null;
}) {
  const eventRevision =
    params.events?.some((event) => event.event_type === "revision_requested") ?? false;
  const deliveryRevision =
    params.deliveries?.some(
      (artifact) => artifact.artifact_role === "provider_output" && artifact.status === "superseded"
    ) ?? false;

  return eventRevision || deliveryRevision;
}

function emptyHint(reason = "none"): OrderNotificationHint {
  return {
    should_notify_now: false,
    reason,
    title: "",
    body: "",
    recommended_action: null
  };
}

export function buildOrderNotificationHints(params: {
  order: OrderNotificationOrder;
  review?: OrderNotificationReview;
  events?: OrderNotificationEvent[] | null;
  deliveries?: DeliveryArtifactRow[] | null;
  deliveredReviewAutoCloseHours: number;
  callbackEventType?:
    | "order_assigned"
    | "order_revision_requested"
    | "order_disputed"
    | "order_completed"
    | "order_cancelled"
    | "order_expired"
    | "order_dispute_resolved";
}): OrderNotificationHints {
  const label = taskLabel(params.order);
  const reviewDeadlineAt = buildReviewDeadlineAt(
    params.order.delivered_at,
    params.deliveredReviewAutoCloseHours
  );
  const hadRevisionCycle = hasRevisionCycle({
    events: params.events,
    deliveries: params.deliveries
  });

  const hints: OrderNotificationHints = {
    review_deadline_at: reviewDeadlineAt,
    had_revision_cycle: hadRevisionCycle,
    buyer_owner: emptyHint(),
    provider_owner: emptyHint()
  };

  if (params.order.status === "awaiting_buyer_context" && params.order.escrow_status === "held") {
    hints.buyer_owner = {
      should_notify_now: true,
      reason: "buyer_context_required",
      title: `请确认并提交需求材料包：${label}`,
      body: `订单 ${params.order.order_no} 已创建并冻结预算，但供给方还不能开始执行。请先整理本单允许共享给供给方的正式材料包，确认需要打码或保留不分享的内容，再正式提交 Buyer Context Pack。`,
      recommended_action: "submit_buyer_context_pack"
    };

    return hints;
  }

  if (params.callbackEventType === "order_dispute_resolved") {
    const resolvedToProvider =
      params.order.status === "completed" && params.order.escrow_status === "released";
    const commentary =
      typeof params.review?.commentary === "string" && params.review.commentary.trim().length > 0
        ? params.review.commentary.trim()
        : "管理员已完成争议裁决。";

    hints.provider_owner = {
      should_notify_now: true,
      reason: resolvedToProvider ? "dispute_resolved_release" : "dispute_resolved_refund",
      title: resolvedToProvider ? `争议已裁决并放款：${label}` : `争议已裁决并退款：${label}`,
      body: resolvedToProvider
        ? `订单 ${params.order.order_no} 的争议已裁决为放款给供给方。说明：${commentary}`
        : `订单 ${params.order.order_no} 的争议已裁决为退款给买方。说明：${commentary}`,
      recommended_action: "review_resolution"
    };

    return hints;
  }

  if (params.callbackEventType === "order_assigned") {
    if (params.order.status === "accepted") {
      hints.provider_owner = {
        should_notify_now: true,
        reason: "order_assigned_auto_accepted",
        title: `已收到新订单并自动接单：${label}`,
        body: `订单 ${params.order.order_no} 已进入自动执行链路。平台已经完成自动接单，请继续沿用同一订单工作区执行，不要新开并行订单。只有遇到缺素材、超权限或执行失败时才需要主人介入。`,
        recommended_action: "monitor_execution"
      };

      return hints;
    }

    if (params.order.status === "queued_for_provider") {
      hints.provider_owner = {
        should_notify_now: true,
        reason: "order_assigned_manual_accept_required",
        title: `已收到新订单，等待接单：${label}`,
        body: `订单 ${params.order.order_no} 已到达供给方队列，但当前还没有自动接单。请尽快查看并决定是否正式接单。`,
        recommended_action: "accept_order"
      };

      return hints;
    }
  }

  if (params.order.status === "revision_requested") {
    const commentary =
      typeof params.review?.commentary === "string" && params.review.commentary.trim().length > 0
        ? params.review.commentary.trim()
        : "买方认为当前交付与冻结需求仍有差距，请重新提交最新版。";

    hints.provider_owner = {
      should_notify_now: true,
      reason: "revision_requested",
      title: `买方要求返工：${label}`,
      body: `订单 ${params.order.order_no} 已进入待返工。原因：${commentary}。请继续沿用原正式交付接口提交最新版交付，不要新开并行订单。`,
      recommended_action: "resubmit_delivery"
    };

    return hints;
  }

  if (
    params.callbackEventType === "order_disputed" ||
    (params.order.status === "disputed" && params.review?.settlement_action === "open_dispute")
  ) {
    const commentary =
      typeof params.review?.commentary === "string" && params.review.commentary.trim().length > 0
        ? params.review.commentary.trim()
        : "买方已发起争议，请准备说明和相关证据。";

    hints.provider_owner = {
      should_notify_now: true,
      reason: "dispute_opened",
      title: `买方发起争议：${label}`,
      body: `订单 ${params.order.order_no} 已进入争议处理。买方说明：${commentary}。请准备证据与必要说明，等待后续裁决。`,
      recommended_action: "prepare_dispute_response"
    };

    return hints;
  }

  if (
    params.callbackEventType === "order_completed" ||
    (params.order.status === "completed" && params.review?.settlement_action === "accept_close")
  ) {
    const reviewBand =
      typeof params.review?.review_band === "string" ? params.review.review_band : "neutral";
    const commentary =
      typeof params.review?.commentary === "string" && params.review.commentary.trim().length > 0
        ? params.review.commentary.trim()
        : "订单已完成并结算。";
    const evidence =
      params.review?.evidence_json && typeof params.review.evidence_json === "object"
        ? params.review.evidence_json
        : {};
    const autoClosed = evidence.auto_closed === true;

    hints.provider_owner = {
      should_notify_now: true,
      reason: autoClosed ? "review_timeout_auto_closed" : "order_completed_review_received",
      title: autoClosed ? `订单已自动确认收货：${label}` : `订单已评价并完成：${label}`,
      body: autoClosed
        ? `订单 ${params.order.order_no} 在 ${params.deliveredReviewAutoCloseHours} 小时内无人评价，系统已按 neutral 自动确认收货并完成结算。`
        : `订单 ${params.order.order_no} 已完成。评价等级：${reviewBand}。评价说明：${commentary}`,
      recommended_action: "review_completion"
    };

    return hints;
  }

  if (params.callbackEventType === "order_cancelled" && params.order.status === "cancelled") {
    hints.provider_owner = {
      should_notify_now: true,
      reason: "order_cancelled",
      title: `订单已取消：${label}`,
      body: `订单 ${params.order.order_no} 已在接单前取消，托管金额已按规则退回买方。`,
      recommended_action: "review_cancellation"
    };

    return hints;
  }

  if (params.callbackEventType === "order_expired" && params.order.status === "expired") {
    hints.provider_owner = {
      should_notify_now: true,
      reason: "order_expired",
      title: `订单已过期：${label}`,
      body: `订单 ${params.order.order_no} 因长时间未接单已自动过期，托管金额已按规则退回买方。`,
      recommended_action: "review_expiry"
    };

    return hints;
  }

  if (params.order.status === "delivered" && params.order.escrow_status === "held") {
    hints.buyer_owner = {
      should_notify_now: true,
      reason: hadRevisionCycle ? "revision_redelivery_ready_for_review" : "delivery_ready_for_review",
      title: hadRevisionCycle ? `供给方已提交返工版：${label}` : `供给方已提交交付：${label}`,
      body: hadRevisionCycle
        ? `订单 ${params.order.order_no} 已收到最新版交付，请重新复核并给出公允评价。`
        : `订单 ${params.order.order_no} 已收到交付，请尽快复核并给出公允评价。`,
      recommended_action: "review_delivery"
    };

    return hints;
  }

  return hints;
}
