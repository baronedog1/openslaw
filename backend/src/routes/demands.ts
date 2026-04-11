import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import { query, withTransaction } from "../db.js";
import { json } from "../utils.js";

const createDemandSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string()).default([]),
  input_brief: z.record(z.any()).default({}),
  desired_outputs: z.array(z.any()).default([]),
  budget_min: z.number().int().nonnegative(),
  budget_max: z.number().int().nonnegative(),
  delivery_eta_minutes: z.number().int().positive(),
  visibility: z.enum(["public", "unlisted"]).default("public")
});

export async function registerDemandRoutes(app: FastifyInstance) {
  app.post("/api/v1/agent/demands", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const body = createDemandSchema.parse(request.body);

    const result = await withTransaction(async (client) => {
      const insert = await client.query(
        `
          INSERT INTO demand_posts (
            requester_agent_id,
            title,
            summary,
            category,
            tags_json,
            input_brief_json,
            desired_output_json,
            budget_min,
            budget_max,
            delivery_eta_minutes,
            status,
            visibility
          )
          VALUES (
            $1, $2, $3, $4,
            $5::jsonb, $6::jsonb, $7::jsonb,
            $8, $9, $10, 'open', $11
          )
          RETURNING *
        `,
        [
          agent.id,
          body.title,
          body.summary,
          body.category,
          json(body.tags),
          json(body.input_brief),
          json(body.desired_outputs),
          body.budget_min,
          body.budget_max,
          body.delivery_eta_minutes,
          body.visibility
        ]
      );

      return insert.rows[0];
    });

    reply.code(201).send(result);
  });

  app.get("/api/v1/agent/demands", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const filters = z
      .object({
        q: z.string().optional(),
        category: z.string().optional(),
        status: z.enum(["open", "matched", "closed", "cancelled"]).optional()
      })
      .parse(request.query);

    const values: unknown[] = [];
    const where: string[] = ["dp.visibility = 'public'"];

    if (filters.q) {
      values.push(`%${filters.q}%`);
      where.push(`(title ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }

    if (filters.category) {
      values.push(filters.category);
      where.push(`dp.category = $${values.length}`);
    }

    if (filters.status) {
      values.push(filters.status);
      where.push(`dp.status = $${values.length}`);
    }

    const result = await query(
      `
        SELECT dp.id, dp.requester_agent_id, dp.title, dp.summary, dp.category, dp.budget_min,
               dp.budget_max, dp.delivery_eta_minutes, dp.status, dp.visibility, dp.created_at,
               aa.agent_name AS requester_agent_name, aa.slug AS requester_agent_slug
        FROM demand_posts dp
        JOIN agent_accounts aa ON aa.id = dp.requester_agent_id
        WHERE ${where.join(" AND ")}
        ORDER BY dp.created_at DESC
      `,
      values
    );

    return {
      items: result.rows
    };
  });

  app.get("/api/v1/agent/demands/:demandId", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z.object({ demandId: z.string().uuid() }).parse(request.params);

    const result = await query(
      `
        SELECT dp.*, aa.agent_name AS requester_agent_name, aa.slug AS requester_agent_slug
        FROM demand_posts dp
        JOIN agent_accounts aa ON aa.id = dp.requester_agent_id
        WHERE dp.id = $1
        LIMIT 1
      `,
      [params.demandId]
    );

    const demand = result.rows[0];
    if (!demand) {
      reply.code(404).send({ error: "demand_not_found" });
      return;
    }

    return demand;
  });

  app.post("/api/v1/agent/demands/:demandId/close", async (request, reply) => {
    const agent = await authenticateAgent(request, reply);
    if (!agent) {
      return;
    }

    const params = z.object({ demandId: z.string().uuid() }).parse(request.params);

    const result = await withTransaction(async (client) => {
      const demandResult = await client.query<{
        id: string;
        requester_agent_id: string;
      }>(
        `
          SELECT id, requester_agent_id
          FROM demand_posts
          WHERE id = $1
          FOR UPDATE
        `,
        [params.demandId]
      );

      const demand = demandResult.rows[0];
      if (!demand) {
        throw new Error("demand_not_found");
      }

      if (demand.requester_agent_id !== agent.id) {
        throw new Error("demand_forbidden");
      }

      const update = await client.query(
        `
          UPDATE demand_posts
          SET status = 'closed', closed_at = NOW(), updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [demand.id]
      );

      return update.rows[0];
    }).catch((error: Error) => {
      if (["demand_not_found", "demand_forbidden"].includes(error.message)) {
        reply.code(error.message === "demand_not_found" ? 404 : 403).send({
          error: error.message
        });
        return null;
      }

      throw error;
    });

    if (!result) {
      return;
    }

    return result;
  });
}
