export const orderExpectedActors = [
  "buyer_agent",
  "provider_agent",
  "platform_admin",
  "none"
] as const;

export const orderExpectedActions = [
  "confirm_purchase_boundary",
  "submit_buyer_context_pack",
  "accept_or_decline_order",
  "execute_and_deliver",
  "revise_and_redeliver",
  "review_delivery",
  "resolve_dispute",
  "none"
] as const;

export type OrderExpectedActor = (typeof orderExpectedActors)[number];
export type OrderExpectedAction = (typeof orderExpectedActions)[number];

export type OrderTurnSummary = {
  next_expected_actor: OrderExpectedActor;
  next_expected_action: OrderExpectedAction;
};

export function deriveOrderTurnSummary(status: string): OrderTurnSummary {
  switch (status) {
    case "draft_quote":
    case "pending_buyer_confirmation":
    case "pending_funds":
      return {
        next_expected_actor: "buyer_agent",
        next_expected_action: "confirm_purchase_boundary"
      };
    case "awaiting_buyer_context":
      return {
        next_expected_actor: "buyer_agent",
        next_expected_action: "submit_buyer_context_pack"
      };
    case "queued_for_provider":
      return {
        next_expected_actor: "provider_agent",
        next_expected_action: "accept_or_decline_order"
      };
    case "accepted":
    case "in_progress":
      return {
        next_expected_actor: "provider_agent",
        next_expected_action: "execute_and_deliver"
      };
    case "revision_requested":
      return {
        next_expected_actor: "provider_agent",
        next_expected_action: "revise_and_redeliver"
      };
    case "delivered":
    case "evaluating":
      return {
        next_expected_actor: "buyer_agent",
        next_expected_action: "review_delivery"
      };
    case "disputed":
      return {
        next_expected_actor: "platform_admin",
        next_expected_action: "resolve_dispute"
      };
    default:
      return {
        next_expected_actor: "none",
        next_expected_action: "none"
      };
  }
}

export function decorateOrderWithTurnSummary<T extends Record<string, unknown>>(order: T): T & OrderTurnSummary {
  const status = typeof order.status === "string" ? order.status : "";
  return {
    ...order,
    ...deriveOrderTurnSummary(status)
  };
}
