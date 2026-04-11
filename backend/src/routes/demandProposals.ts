import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import { config } from "../config.js";
import { executionScopeSchema } from "../domain/executionScope.js";
import {
  assertBuyerAuthorizationReadyForCheckout,
  budgetConfirmationSchema,
  buildBudgetConfirmationSnapshot,
  purchaseAuthorizationContextSchema,
  purchasePlanContextSchema,
  validatePurchasePlanEnvelope
} from "../domain/orderLifecycle.js";
import { decorateOrderWithTurnSummary } from "../domain/orderTurns.js";
import { query, withTransaction } from "../db.js";
import { generateOrderNo, json } from "../utils.js";

const createProposalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  proposed_amount: z.number().int().nonnegative(),
  delivery_eta_minutes: z.number().int().positive(),
  input_requirements: z.record(z.any()).default({}),
  output_commitment: z.array(z.any()).default([]),
  case_examples: z.array(z.any()).default([]),
  execution_scope: executionScopeSchema
});

const acceptProposalSchema = z.object({
  budget_confirmed: z.literal(true),
  budget_confirmation: budgetConfirmationSchema,
  purchase_plan_context: purchasePlanContextSchema.optional(),
  purchase_authorization_context: purchaseAuthorizationContextSchema.optional()
});

export async function registerDemandProposalRoutes(app: FastifyInstance) {
  app.post("/api/v1/provider/demands/:demandId/proposals", async (request, reply) => {
    const provider = await authenticateAgent(request, reply);
    if (!provider) {
      return;
    }

    const params = z.object({ demandId: z.string().uuid() }).parse(request.params);
    const body = createProposalSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const demandResult = await client.query<{
        id: string;
        requester_agent_id: string;
        status: string;
      }>(
        `
          SELECT id, requester_agent_id, status
          FROM demand_posts
          WHERE id = $1
          LIMIT 1
        `,
        [params.demandId]
      );

      const demand = demandResult.rows[0];
      if (!demand) {
        throw new Error("demand_not_found");
      }

      if (demand.status !== "open") {
        throw new Error("demand_not_open");
      }

      if (demand.requester_agent_id === provider.id) {
        throw new Error("provider_cannot_propose_to_self");
      }

      const proposalResult = await client.query(
        `
          INSERT INTO demand_proposals (
            demand_post_id,
            provider_agent_id,
            requester_agent_id,
            title,
            summary,
            proposed_amount,
            delivery_eta_minutes,
            input_requirements_json,
            output_commitment_json,
            case_examples_json,
            execution_scope_json,
            status
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
            'submitted'
          )
          ON CONFLICT (demand_post_id, provider_agent_id)
          DO UPDATE SET
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            proposed_amount = EXCLUDED.proposed_amount,
            delivery_eta_minutes = EXCLUDED.delivery_eta_minutes,
            input_requirements_json = EXCLUDED.input_requirements_json,
            output_commitment_json = EXCLUDED.output_commitment_json,
            case_examples_json = EXCLUDED.case_examples_json,
            execution_scope_json = EXCLUDED.execution_scope_json,
            status = 'submitted',
            accepted_at = NULL,
            rejected_at = NULL,
            updated_at = NOW()
          RETURNING *
        `,
        [
          demand.id,
          provider.id,
          demand.requester_agent_id,
          body.title,
          body.summary,
          body.proposed_amount,
          body.delivery_eta_minutes,
          json(body.input_requirements),
          json(body.output_commitment),
          json(body.case_examples),
          json(body.execution_scope)
        ]
      );

      return proposalResult.rows[0];
    }).catch((error: Error) => {
      if (
        ["demand_not_found", "demand_not_open", "provider_cannot_propose_to_self"].includes(
          error.message
        )
      ) {
        reply.code(error.message === "demand_not_found" ? 404 : 400).send({
          error: error.message
        });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    reply.code(201).send(result);
  });

  app.get("/api/v1/agent/demands/:demandId/proposals", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z.object({ demandId: z.string().uuid() }).parse(request.params);

    const demandResult = await query<{
      id: string;
      requester_agent_id: string;
    }>(
      `
        SELECT id, requester_agent_id
        FROM demand_posts
        WHERE id = $1
        LIMIT 1
      `,
      [params.demandId]
    );

    const demand = demandResult.rows[0];
    if (!demand) {
      reply.code(404).send({ error: "demand_not_found" });
      return;
    }

    if (demand.requester_agent_id !== agent.id) {
      reply.code(403).send({ error: "proposal_list_forbidden" });
      return;
    }

    const result = await query(
      `
        SELECT dp.*, aa.agent_name AS provider_agent_name, aa.slug AS provider_agent_slug
        FROM demand_proposals dp
        JOIN agent_accounts aa ON aa.id = dp.provider_agent_id
        WHERE dp.demand_post_id = $1
        ORDER BY dp.created_at DESC
      `,
      [params.demandId]
    );

    return {
      items: result.rows
    };
  });

  app.post("/api/v1/agent/demand-proposals/:proposalId/accept", async (request, reply) => {
    const buyer = await authenticateAgent(request, reply);
    if (!buyer) {
      return;
    }

    const params = z.object({ proposalId: z.string().uuid() }).parse(request.params);
    const body = acceptProposalSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const proposalResult = await client.query<{
        id: string;
        demand_post_id: string;
        provider_agent_id: string;
        requester_agent_id: string;
        title: string;
        proposed_amount: string;
        delivery_eta_minutes: number;
        input_requirements_json: Record<string, unknown>;
        output_commitment_json: unknown[];
        execution_scope_json: Record<string, unknown>;
        status: string;
      }>(
        `
          SELECT id, demand_post_id, provider_agent_id, requester_agent_id, title,
                 proposed_amount, delivery_eta_minutes, input_requirements_json,
                 output_commitment_json, execution_scope_json, status
          FROM demand_proposals
          WHERE id = $1
          FOR UPDATE
        `,
        [params.proposalId]
      );

      const proposal = proposalResult.rows[0];
      if (!proposal) {
        throw new Error("proposal_not_found");
      }

      if (proposal.requester_agent_id !== buyer.id) {
        throw new Error("proposal_accept_forbidden");
      }

      if (proposal.status !== "submitted") {
        throw new Error("proposal_not_submitted");
      }

      const demandResult = await client.query<{
        id: string;
        requester_agent_id: string;
        status: string;
        input_brief_json: Record<string, unknown>;
      }>(
        `
          SELECT id, requester_agent_id, status, input_brief_json
          FROM demand_posts
          WHERE id = $1
          FOR UPDATE
        `,
        [proposal.demand_post_id]
      );

      const demand = demandResult.rows[0];
      if (!demand) {
        throw new Error("demand_not_found");
      }

      if (demand.requester_agent_id !== buyer.id) {
        throw new Error("proposal_accept_forbidden");
      }

      if (demand.status !== "open") {
        throw new Error("demand_not_open");
      }

      const walletResult = await client.query<{
        id: string;
        available_balance: string;
        held_balance: string;
      }>(
        `
          SELECT id, available_balance, held_balance
          FROM wallet_accounts
          WHERE agent_account_id = $1
          FOR UPDATE
        `,
        [buyer.id]
      );

      const buyerWallet = walletResult.rows[0];
      if (!buyerWallet) {
        throw new Error("wallet_not_found");
      }

      const amount = Number(proposal.proposed_amount);
      const availableBalance = Number(buyerWallet.available_balance);
      const heldBalance = Number(buyerWallet.held_balance);

      if (availableBalance < amount) {
        throw new Error("insufficient_balance");
      }

      const selectedOptionRef = `proposal:${proposal.id}`;

      await validatePurchasePlanEnvelope(client, {
        buyerAgentId: buyer.id,
        providerAgentId: proposal.provider_agent_id,
        selectedOptionRef,
        quotedAmount: amount,
        purchasePlanContext: body.purchase_plan_context ?? null
      });

      const snapshot = buildBudgetConfirmationSnapshot({
        source_kind: "demand_proposal",
        buyer_agent_id: buyer.id,
        provider_agent_id: proposal.provider_agent_id,
        quoted_amount: amount,
        budget_confirmation: body.budget_confirmation,
        demand_post_id: demand.id,
        demand_proposal_id: proposal.id,
        input_summary: demand.input_brief_json ?? {},
        expected_outputs: proposal.output_commitment_json ?? [],
        confirmation_surface: undefined,
        selected_option_ref: selectedOptionRef,
        purchase_plan_context: body.purchase_plan_context ?? null,
        purchase_authorization_context: body.purchase_authorization_context ?? null
      });
      const buyerAuthorization = assertBuyerAuthorizationReadyForCheckout(snapshot);
      const merchantCommitment = snapshot.merchant_commitment as Record<string, unknown>;
      const authorizationScope = snapshot.authorization_scope as Record<string, unknown>;

      const orderNo = generateOrderNo();
      const orderResult = await client.query(
        `
          INSERT INTO orders (
            order_no,
            buyer_agent_id,
            provider_agent_id,
            service_listing_id,
            demand_post_id,
            demand_proposal_id,
            source_kind,
            quoted_amount,
            final_amount,
            input_payload_json,
            expected_output_schema_json,
            budget_confirmation_snapshot_json,
            execution_scope_snapshot_json,
            expires_at,
            status,
            escrow_status
          )
          VALUES (
            $1, $2, $3, NULL, $4, $5, 'demand_proposal',
            $6, $6,
            $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
            NOW() + ($11 * INTERVAL '1 minute'),
            'awaiting_buyer_context',
            'held'
          )
          RETURNING *
        `,
        [
          orderNo,
          buyer.id,
          proposal.provider_agent_id,
          demand.id,
          proposal.id,
          amount,
          json(demand.input_brief_json ?? {}),
          json(proposal.output_commitment_json ?? []),
          json(snapshot),
          json(proposal.execution_scope_json ?? {}),
          config.orderQueueTimeoutMinutes
        ]
      );

      const order = orderResult.rows[0];

      await client.query(
        `
          UPDATE wallet_accounts
          SET available_balance = $2, held_balance = $3, updated_at = NOW()
          WHERE id = $1
        `,
        [buyerWallet.id, availableBalance - amount, heldBalance + amount]
      );

      await client.query(
        `
          INSERT INTO wallet_ledger_entries (
            wallet_account_id,
            order_id,
            entry_type,
            direction,
            amount,
            balance_after_available,
            balance_after_held,
            reference_type,
            memo
          )
          VALUES ($1, $2, 'hold', 'debit', $3, $4, $5, 'demand_proposal', 'proposal_order_hold')
        `,
        [buyerWallet.id, order.id, amount, availableBalance - amount, heldBalance + amount]
      );

      await client.query(
        `
          UPDATE demand_proposals
          SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `,
        [proposal.id]
      );

      await client.query(
        `
          UPDATE demand_proposals
          SET status = 'rejected', rejected_at = NOW(), updated_at = NOW()
          WHERE demand_post_id = $1 AND id <> $2 AND status = 'submitted'
        `,
        [demand.id, proposal.id]
      );

      await client.query(
        `
          UPDATE demand_posts
          SET status = 'matched', matched_order_id = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [demand.id, order.id]
      );

      await client.query(
        `
          INSERT INTO order_events (order_id, event_type, actor_type, actor_id, payload_json)
          VALUES
            ($1, 'proposal_selected', 'buyer_agent', $2, $3::jsonb),
            ($1, 'buyer_confirmed', 'buyer_agent', $2, $4::jsonb),
            ($1, 'owner_authorization_captured', 'buyer_agent', $2, $5::jsonb),
            ($1, 'funds_held', 'system', NULL, $6::jsonb),
            ($1, 'buyer_context_required', 'system', NULL, $7::jsonb)
        `,
        [
          order.id,
          buyer.id,
          json({ proposal_id: proposal.id, demand_id: demand.id }),
          json(body.budget_confirmation),
          json({
            ...buyerAuthorization,
            quote_digest: merchantCommitment.quote_digest ?? null,
            authorization_scope_kind: authorizationScope.scope_kind ?? null,
            per_order_budget_cap:
              (snapshot.authorization_policy as Record<string, unknown>).per_order_budget_cap ?? null
          }),
          json({ amount }),
          json({
            provider_agent_id: proposal.provider_agent_id,
            required_step: "buyer_context_pack",
            note: "Buyer must confirm and submit the formal Buyer Context Pack before the provider can receive or execute the order."
          })
        ]
      );

      return {
        order: decorateOrderWithTurnSummary(
          (await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [order.id])).rows[0]
        ),
        proposal_id: proposal.id,
        demand_id: demand.id
      };
    }).catch((error: Error) => {
      const knownErrors = new Set([
        "proposal_not_found",
        "proposal_accept_forbidden",
        "proposal_not_submitted",
        "demand_not_found",
        "demand_not_open",
        "wallet_not_found",
        "insufficient_balance",
        "provider_out_of_authorized_scope",
        "option_out_of_authorized_scope",
        "plan_per_order_budget_cap_exceeded",
        "plan_total_budget_cap_exceeded",
        "plan_provider_limit_exceeded",
        "owner_authorization_missing",
        "owner_authorization_step_up_required"
      ]);

      if (knownErrors.has(error.message)) {
        const errorWithDetails = error as Error & {
          step_up_reason_codes?: string[];
          buyer_authorization?: unknown;
        };
        reply.code(
          error.message === "proposal_not_found" || error.message === "demand_not_found"
            ? 404
            : error.message === "proposal_accept_forbidden"
              ? 403
              : [
                    "insufficient_balance",
                    "plan_per_order_budget_cap_exceeded",
                    "plan_total_budget_cap_exceeded",
                    "plan_provider_limit_exceeded",
                    "owner_authorization_step_up_required"
                  ].includes(error.message)
                ? 409
                : 400
        ).send({
          error: error.message,
          ...(Array.isArray(errorWithDetails.step_up_reason_codes)
            ? { step_up_reason_codes: errorWithDetails.step_up_reason_codes }
            : {}),
          ...(errorWithDetails.buyer_authorization
            ? { buyer_authorization: errorWithDetails.buyer_authorization }
            : {})
        });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    reply.code(201).send(result);
  });
}
