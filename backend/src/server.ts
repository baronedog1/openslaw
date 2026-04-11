import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAdminOrderRoutes } from "./routes/adminOrders.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerDemandRoutes } from "./routes/demands.js";
import { registerDemandProposalRoutes } from "./routes/demandProposals.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerOwnerClaimRoutes } from "./routes/ownerClaims.js";
import { registerOwnerAuthRoutes } from "./routes/ownerAuth.js";
import { registerOwnerConsoleRoutes } from "./routes/ownerConsole.js";
import { registerPublicDocsRoutes } from "./routes/publicDocs.js";
import { registerProviderRoutes } from "./routes/provider.js";
import { registerRuntimeProfileRoutes } from "./routes/runtimeProfiles.js";
import { registerSystemRoutes } from "./routes/system.js";
import { initializeRuntimeRelay } from "./domain/runtimeRelay.js";

const app = Fastify({
  logger: true
});

function buildInvalidJsonBodyError() {
  return Object.assign(new Error("invalid_json_body"), {
    statusCode: 400
  });
}

app.removeContentTypeParser("application/json");
app.removeContentTypeParser("text/plain");
app.addContentTypeParser(
  /^application\/(.+\+)?json(?:\s*;.*)?$/i,
  { parseAs: "string" },
  (_request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString();
    if (rawBody.trim().length === 0) {
      done(null, {});
      return;
    }

    try {
      done(null, JSON.parse(rawBody));
    } catch {
      done(buildInvalidJsonBodyError(), undefined);
    }
  }
);

app.addContentTypeParser(/^text\/plain(?:\s*;.*)?$/i, { parseAs: "string" }, (_request, body, done) => {
  const rawBody = typeof body === "string" ? body : body.toString();
  if (rawBody.trim().length === 0) {
    done(null, {});
    return;
  }

  done(null, rawBody);
});

app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
  const rawBody = typeof body === "string" ? body : body.toString();
  if (rawBody.trim().length === 0) {
    done(null, {});
    return;
  }

  done(null, rawBody);
});

await app.register(cors, {
  origin: config.corsOrigin
});

await registerHealthRoutes(app);
await registerPublicDocsRoutes(app);
await registerAgentRoutes(app);
await registerOwnerClaimRoutes(app);
await registerOwnerAuthRoutes(app);
await registerOwnerConsoleRoutes(app);
await registerAdminOrderRoutes(app);
await registerCatalogRoutes(app);
await registerDemandRoutes(app);
await registerDemandProposalRoutes(app);
await registerOrderRoutes(app);
await registerProviderRoutes(app);
await registerRuntimeProfileRoutes(app);
await registerSystemRoutes(app);
await initializeRuntimeRelay(app.server, app.log);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof Error && error.name === "ZodError") {
    reply.code(400).send({
      error: "validation_error",
      details: error.message
    });
    return;
  }

  const fastifyError = error as Error & {
    code?: string;
    statusCode?: number;
  };
  if (fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    reply.code(415).send({
      error: "unsupported_media_type",
      details: fastifyError.message
    });
    return;
  }

  if (
    fastifyError.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    fastifyError.message === "invalid_json_body"
  ) {
    reply.code(400).send({
      error: "invalid_request_body",
      details: fastifyError.message
    });
    return;
  }

  if (
    typeof fastifyError.statusCode === "number" &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    reply.code(fastifyError.statusCode).send({
      error: "invalid_request",
      details: fastifyError.message
    });
    return;
  }

  app.log.error(error);
  reply.code(500).send({
    error: "internal_server_error"
  });
});

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
