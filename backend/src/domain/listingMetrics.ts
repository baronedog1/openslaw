import type { PoolClient } from "pg";

export async function ensureListingMetrics(client: PoolClient, listingId: string) {
  await client.query(
    `
      INSERT INTO service_listing_metrics (service_listing_id)
      VALUES ($1)
      ON CONFLICT (service_listing_id) DO NOTHING
    `,
    [listingId]
  );
}

export async function refreshListingMetrics(client: PoolClient, listingId: string) {
  await ensureListingMetrics(client, listingId);

  const aggregateResult = await client.query<{
    review_score_avg: string;
    review_count: number;
    accept_latency_p50_seconds: number;
    delivery_latency_p50_seconds: number;
    dispute_rate: string;
    accept_close_rate: string;
    on_time_delivery_rate: string;
  }>(
    `
      SELECT
        COALESCE(
          ROUND(
            AVG(
              CASE r.review_band
                WHEN 'positive' THEN 5.0
                WHEN 'neutral' THEN 3.0
                WHEN 'negative' THEN 1.0
                ELSE NULL
              END
            )::numeric,
            2
          ),
          0
        )::text AS review_score_avg,
        COUNT(r.id)::int AS review_count,
        COALESCE(
          ROUND(
            (
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (o.accepted_at - o.placed_at))
              )
              FILTER (WHERE o.accepted_at IS NOT NULL)
            )::numeric,
            0
          ),
          0
        )::int AS accept_latency_p50_seconds,
        COALESCE(
          ROUND(
            (
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at))
              )
              FILTER (WHERE o.accepted_at IS NOT NULL AND o.delivered_at IS NOT NULL)
            )::numeric,
            0
          ),
          0
        )::int AS delivery_latency_p50_seconds,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN r.settlement_action IN ('request_revision', 'open_dispute') THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::text AS dispute_rate,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN r.id IS NULL THEN NULL
                WHEN r.settlement_action = 'accept_close' THEN 1.0
                ELSE 0.0
              END
            )::numeric,
            4
          ),
          0
        )::text AS accept_close_rate,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN o.delivered_at IS NOT NULL
                     AND o.accepted_at IS NOT NULL
                     AND sl.delivery_eta_minutes IS NOT NULL
                     AND EXTRACT(EPOCH FROM (o.delivered_at - o.accepted_at)) <= sl.delivery_eta_minutes * 60
                  THEN 1.0
                WHEN o.delivered_at IS NOT NULL
                     AND o.accepted_at IS NOT NULL
                     AND sl.delivery_eta_minutes IS NOT NULL
                  THEN 0.0
                ELSE NULL
              END
            )::numeric,
            4
          ),
          0
        )::text AS on_time_delivery_rate
      FROM orders o
      LEFT JOIN reviews r ON r.order_id = o.id
      LEFT JOIN service_listings sl ON sl.id = o.service_listing_id
      WHERE o.service_listing_id = $1
    `,
    [listingId]
  );

  const revisionResult = await client.query<{ revision_rate: string }>(
    `
      SELECT
        COALESCE(
          ROUND(
            (
              COUNT(DISTINCT oe.order_id)::numeric
              / NULLIF(COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN o.id END), 0)
            ),
            4
          ),
          0
        )::text AS revision_rate
      FROM orders o
      LEFT JOIN reviews r ON r.order_id = o.id
      LEFT JOIN order_events oe
        ON oe.order_id = o.id
       AND oe.event_type = 'revision_requested'
      WHERE o.service_listing_id = $1
    `,
    [listingId]
  );

  const visibleCaseResult = await client.query<{
    verified_case_count: number;
    public_case_count: number;
  }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE allow_in_agent_search)::int AS verified_case_count,
        COUNT(*) FILTER (WHERE allow_in_public_showcase)::int AS public_case_count
      FROM transaction_snapshots
      WHERE service_listing_id = $1
    `,
    [listingId]
  );

  const aggregate = aggregateResult.rows[0];
  const revision = revisionResult.rows[0];
  const visibleCases = visibleCaseResult.rows[0];

  await client.query(
    `
      UPDATE service_listing_metrics
      SET review_score_avg = $2,
          review_count = $3,
          accept_latency_p50_seconds = $4,
          delivery_latency_p50_seconds = $5,
          dispute_rate = $6,
          accept_close_rate = $7,
          on_time_delivery_rate = $8,
          revision_rate = $9,
          verified_case_count = $10,
          public_case_count = $11,
          last_refreshed_at = NOW(),
          updated_at = NOW()
      WHERE service_listing_id = $1
    `,
    [
      listingId,
      Number(aggregate.review_score_avg ?? 0),
      aggregate.review_count ?? 0,
      aggregate.accept_latency_p50_seconds ?? 0,
      aggregate.delivery_latency_p50_seconds ?? 0,
      Number(aggregate.dispute_rate ?? 0),
      Number(aggregate.accept_close_rate ?? 0),
      Number(aggregate.on_time_delivery_rate ?? 0),
      Number(revision?.revision_rate ?? 0),
      visibleCases?.verified_case_count ?? 0,
      visibleCases?.public_case_count ?? 0
    ]
  );
}
