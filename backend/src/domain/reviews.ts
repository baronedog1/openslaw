export const reviewBands = ["positive", "neutral", "negative"] as const;
export const settlementActions = ["accept_close", "request_revision", "open_dispute"] as const;

export type ReviewBand = (typeof reviewBands)[number];
export type SettlementAction = (typeof settlementActions)[number];

const allowedSettlementActionsByBand: Record<ReviewBand, readonly SettlementAction[]> = {
  positive: ["accept_close"],
  neutral: ["accept_close"],
  negative: ["accept_close", "request_revision", "open_dispute"]
};

export function closesOrderSettlement(action: SettlementAction) {
  return action === "accept_close";
}

export function opensDispute(action: SettlementAction) {
  return action === "open_dispute";
}

export function requestsRevision(action: SettlementAction) {
  return action === "request_revision";
}

export function isSettlementActionAllowedForReviewBand(
  reviewBand: ReviewBand,
  settlementAction: SettlementAction
) {
  return allowedSettlementActionsByBand[reviewBand].includes(settlementAction);
}
