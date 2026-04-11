function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export type ObjectiveReliabilityMetricInput = {
  completed_order_count: number;
  on_time_delivery_rate: number;
  accept_close_rate: number;
  revision_rate: number;
  dispute_rate: number;
  evidence_backed_positive_rate: number;
  input_insufficient_rate: number;
};

export type CatalogRankingFilterInput = {
  q?: string | null;
  category?: string | null;
  tags_any?: string[] | null;
  required_input_key?: string | null;
  required_output_key?: string | null;
  min_price?: number | null;
  max_price?: number | null;
};

export type CatalogRankingInput = {
  filters: CatalogRankingFilterInput;
  listing_text_match: boolean;
  matched_snapshot_count: number;
  verified_case_count: number;
  agent_search_case_count: number;
  accept_mode: "auto_accept" | "owner_confirm_required";
  auto_accept_ready: boolean;
  current_queue_depth: number;
  current_active_order_count: number;
  validated_max_concurrency: number;
  price_min: number;
  price_max: number;
  last_completed_order_at: string | null;
  created_at: string | null;
  objective_delivery_score: number;
  reliability_confidence: number;
};

export type CatalogRankingSignals = {
  total_score: number;
  task_relevance_score: number;
  historical_evidence_score: number;
  reliability_score: number;
  availability_score: number;
  budget_fit_score: number;
  freshness_score: number;
  reliability_confidence: number;
  matched_snapshot_count: number;
  low_sample_adjusted: boolean;
};

const reliabilityConfidenceOrderThreshold = 8;
const neutralReliabilityBaseline = 0.55;

export function computeReliabilityConfidence(completedOrderCount: number) {
  return round4(clamp01(completedOrderCount / reliabilityConfidenceOrderThreshold));
}

export function computeObjectiveDeliveryScore(input: ObjectiveReliabilityMetricInput) {
  const confidence = computeReliabilityConfidence(input.completed_order_count);
  const inputShield = Math.min(clamp01(input.input_insufficient_rate), 0.6) * 0.5;
  const accountableRevisionRate = clamp01(input.revision_rate * (1 - inputShield));
  const accountableDisputeRate = clamp01(input.dispute_rate * (1 - inputShield));
  const rawScore = clamp01(
    input.on_time_delivery_rate * 0.32 +
      input.accept_close_rate * 0.28 +
      input.evidence_backed_positive_rate * 0.2 +
      (1 - accountableRevisionRate) * 0.1 +
      (1 - accountableDisputeRate) * 0.1
  );

  return round4(neutralReliabilityBaseline * (1 - confidence) + rawScore * confidence);
}

function computeTaskRelevanceScore(input: CatalogRankingInput) {
  const components: number[] = [];

  if (input.filters.q && input.filters.q.trim().length > 0) {
    components.push(input.listing_text_match ? 1 : input.matched_snapshot_count > 0 ? 0.65 : 0);
  }

  if (input.filters.category) {
    components.push(1);
  }

  if (input.filters.tags_any && input.filters.tags_any.length > 0) {
    components.push(1);
  }

  if (input.filters.required_input_key) {
    components.push(1);
  }

  if (input.filters.required_output_key) {
    components.push(1);
  }

  return round4(components.length === 0 ? 0.5 : average(components));
}

function computeHistoricalEvidenceScore(input: CatalogRankingInput) {
  const matchedSnapshotCoverage = clamp01(input.matched_snapshot_count / 2);
  const listingEvidenceCoverage = clamp01(input.verified_case_count / 4);
  const providerEvidenceCoverage = clamp01(input.agent_search_case_count / 6);

  return round4(
    matchedSnapshotCoverage * 0.7 + listingEvidenceCoverage * 0.2 + providerEvidenceCoverage * 0.1
  );
}

function computeAvailabilityScore(input: CatalogRankingInput) {
  const queueScore = clamp01(1 - Math.min(input.current_queue_depth, 6) / 6);
  const capacityScore =
    input.validated_max_concurrency > 0
      ? clamp01(
          (input.validated_max_concurrency - input.current_active_order_count) /
            Math.max(input.validated_max_concurrency, 1)
        )
      : 0.5;
  const intakeScore =
    input.accept_mode === "auto_accept"
      ? input.auto_accept_ready
        ? 1
        : 0.7
      : 0.55;

  return round4(queueScore * 0.5 + capacityScore * 0.3 + intakeScore * 0.2);
}

function computeBudgetFitScore(input: CatalogRankingInput) {
  const hasMin = typeof input.filters.min_price === "number";
  const hasMax = typeof input.filters.max_price === "number";

  if (!hasMin && !hasMax) {
    return 0.5;
  }

  let score = 1;

  if (hasMax) {
    score =
      input.price_max <= (input.filters.max_price as number)
        ? score
        : input.price_min <= (input.filters.max_price as number)
          ? Math.min(score, 0.75)
          : 0;
  }

  if (hasMin) {
    score =
      input.price_min >= (input.filters.min_price as number)
        ? score
        : input.price_max >= (input.filters.min_price as number)
          ? Math.min(score, 0.75)
          : 0;
  }

  return round4(clamp01(score));
}

function computeFreshnessScore(referenceAt: string | null) {
  if (!referenceAt) {
    return 0.4;
  }

  const timestamp = Date.parse(referenceAt);
  if (!Number.isFinite(timestamp)) {
    return 0.4;
  }

  const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) {
    return 1;
  }
  if (ageDays <= 30) {
    return 0.85;
  }
  if (ageDays <= 90) {
    return 0.65;
  }
  if (ageDays <= 180) {
    return 0.45;
  }
  return 0.25;
}

export function computeCatalogRankingSignals(input: CatalogRankingInput): CatalogRankingSignals {
  const taskRelevanceScore = computeTaskRelevanceScore(input);
  const historicalEvidenceScore = computeHistoricalEvidenceScore(input);
  const reliabilityScore = round4(clamp01(input.objective_delivery_score));
  const availabilityScore = computeAvailabilityScore(input);
  const budgetFitScore = computeBudgetFitScore(input);
  const freshnessScore = round4(
    computeFreshnessScore(input.last_completed_order_at ?? input.created_at)
  );
  const totalScore = round4(
    taskRelevanceScore * 0.35 +
      historicalEvidenceScore * 0.25 +
      reliabilityScore * 0.15 +
      availabilityScore * 0.1 +
      budgetFitScore * 0.1 +
      freshnessScore * 0.05
  );

  return {
    total_score: totalScore,
    task_relevance_score: taskRelevanceScore,
    historical_evidence_score: historicalEvidenceScore,
    reliability_score: reliabilityScore,
    availability_score: availabilityScore,
    budget_fit_score: budgetFitScore,
    freshness_score: freshnessScore,
    reliability_confidence: round4(clamp01(input.reliability_confidence)),
    matched_snapshot_count: Math.max(0, input.matched_snapshot_count),
    low_sample_adjusted: input.reliability_confidence < 1
  };
}
