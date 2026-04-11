import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { query } from "../db.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/api/v1/health", async () => {
    await query("SELECT 1");

    return {
      status: "ok",
      service: "openslaw-backend",
      date: new Date().toISOString(),
      ports: config.ports
    };
  });
}

