import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";

const routeDir = dirname(fileURLToPath(import.meta.url));
const repoRootCandidates = Array.from(
  new Set([
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(routeDir, "../../.."),
    resolve(routeDir, "../../../..")
  ])
);

const hostedFiles = [
  { label: "**SKILL.md** (this file)", path: "/skill.md" },
  { label: "**DOCS.md**", path: "/docs.md" },
  { label: "**API-GUIDE.md**", path: "/api-guide.md" },
  { label: "**PLAYBOOK.md**", path: "/playbook.md" },
  { label: "**COMMUNITY**", path: "/community/" },
  { label: "**COMMUNITY SEARCH INDEX**", path: "/community/search-index.json" },
  { label: "**API-CONTRACT-V1.md**", path: "/api-contract-v1.md" },
  { label: "**BUSINESS-PATHS.md**", path: "/business-paths.md" },
  { label: "**NAMING-AND-ENUMS.md**", path: "/naming-and-enums.md" },
  { label: "**OPENAPI-V1.yaml**", path: "/openapi-v1.yaml" },
  { label: "**AUTH.md**", path: "/auth.md" },
  { label: "**DEVELOPERS.md**", path: "/developers.md" },
  { label: "**manual/index.html**", path: "/manual/index.html" },
  { label: "**skill.json**", path: "/skill.json" }
] as const;

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value?.split(",")[0]?.trim();
}

function resolveOrigin(request: FastifyRequest): string {
  if (config.publicWebBaseUrl) {
    return config.publicWebBaseUrl;
  }

  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost ?? request.headers.host ?? `127.0.0.1:${config.ports.web}`;
  const protocol = forwardedProto ?? request.protocol ?? "http";

  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function resolveApiBase(origin: string): string {
  if (config.publicApiBaseUrl) {
    return config.publicApiBaseUrl;
  }

  return `${origin}/api/v1`;
}

function absoluteUrl(origin: string, path: string) {
  return `${origin}${path}`;
}

function skillManifest(origin: string, apiBase: string) {
  return {
    name: "openslaw",
    version: "1.0.0",
    homepage: origin,
    api_base: apiBase,
    files: hostedFiles.map((file) => ({
      path: file.path,
      url: absoluteUrl(origin, file.path)
    }))
  };
}

async function repoTextFileContent(
  relativePath: string,
  hydrate: (content: string) => string
): Promise<string> {
  let lastMissingError: Error | null = null;

  for (const repoRoot of repoRootCandidates) {
    try {
      const content = await readFile(resolve(repoRoot, relativePath), "utf8");
      return hydrate(content);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }

      lastMissingError = err;
    }
  }

  throw (
    lastMissingError ??
    new Error(`public doc file could not be resolved: ${relativePath}`)
  );
}

function hydrateContractContent(content: string, origin: string, apiBase: string): string {
  return content
    .replaceAll("https://your-domain.example/api/v1", apiBase)
    .replaceAll("https://your-domain.example", origin);
}

function hydrateLocalDocContent(content: string, origin: string, apiBase: string): string {
  const relayUrl = `${apiBase.replace(/^http/, "ws")}/provider/runtime-relay`;

  return content
    .replaceAll("{{OPENSLAW_ORIGIN}}", origin)
    .replaceAll("{{OPENSLAW_API_BASE}}", apiBase)
    .replaceAll("{{OPENSLAW_RELAY_URL}}", relayUrl)
    .replaceAll("https://openslaw.example.com", origin)
    .replaceAll("https://api.openslaw.example.com/api/v1", apiBase);
}

function registerLocalDocRoute(
  app: FastifyInstance,
  path: string,
  relativePath: string,
  contentType: string
) {
  app.get(path, async (request, reply) => {
    const origin = resolveOrigin(request);
    const apiBase = resolveApiBase(origin);
    const body = await repoTextFileContent(relativePath, (content) =>
      hydrateLocalDocContent(content, origin, apiBase)
    );

    reply.type(contentType).send(body);
  });
}

function registerContractDocRoute(
  app: FastifyInstance,
  path: string,
  relativePath: string,
  contentType: string
) {
  app.get(path, async (request, reply) => {
    const origin = resolveOrigin(request);
    const apiBase = resolveApiBase(origin);
    const body = await repoTextFileContent(relativePath, (content) =>
      hydrateContractContent(content, origin, apiBase)
    );

    reply.type(contentType).send(body);
  });
}

function isSafeCommunitySlug(value: string) {
  return /^[a-z0-9-]+$/.test(value);
}

export async function registerPublicDocsRoutes(app: FastifyInstance) {
  registerLocalDocRoute(app, "/skill.md", "skills/openslaw/SKILL.md", "text/markdown; charset=utf-8");
  registerLocalDocRoute(app, "/docs.md", "skills/openslaw/DOCS.md", "text/markdown; charset=utf-8");
  registerLocalDocRoute(
    app,
    "/api-guide.md",
    "skills/openslaw/references/api.md",
    "text/markdown; charset=utf-8"
  );
  registerLocalDocRoute(
    app,
    "/playbook.md",
    "skills/openslaw/references/playbook.md",
    "text/markdown; charset=utf-8"
  );
  registerLocalDocRoute(app, "/contracts.md", "skills/openslaw/DOCS.md", "text/markdown; charset=utf-8");
  registerLocalDocRoute(
    app,
    "/developers.md",
    "skills/openslaw/DEVELOPERS.md",
    "text/markdown; charset=utf-8"
  );
  registerLocalDocRoute(app, "/auth.md", "skills/openslaw/AUTH.md", "text/markdown; charset=utf-8");
  registerLocalDocRoute(
    app,
    "/manual/index.html",
    "skills/openslaw/manual/index.html",
    "text/html; charset=utf-8"
  );

  app.get("/community", async (_request, reply) => {
    reply.redirect("/community/");
  });
  registerLocalDocRoute(
    app,
    "/community/",
    "docs/community/site/index.html",
    "text/html; charset=utf-8"
  );
  registerLocalDocRoute(
    app,
    "/community/search-index.json",
    "docs/community/search-index.json",
    "application/json; charset=utf-8"
  );
  app.get("/community/posts/:slug.md", async (request, reply) => {
    const slug = (request.params as { slug?: string }).slug ?? "";
    if (!isSafeCommunitySlug(slug)) {
      reply.code(404).send({ error: "community_post_not_found" });
      return;
    }

    const origin = resolveOrigin(request);
    const apiBase = resolveApiBase(origin);
    const body = await repoTextFileContent(`docs/community/posts/${slug}.md`, (content) =>
      hydrateLocalDocContent(content, origin, apiBase)
    );

    reply.type("text/markdown; charset=utf-8").send(body);
  });

  registerContractDocRoute(
    app,
    "/api-contract-v1.md",
    "docs/contracts/api-contract-v1.md",
    "text/markdown; charset=utf-8"
  );
  registerContractDocRoute(
    app,
    "/business-paths.md",
    "docs/contracts/business-paths.md",
    "text/markdown; charset=utf-8"
  );
  registerContractDocRoute(
    app,
    "/naming-and-enums.md",
    "docs/contracts/naming-and-enums.md",
    "text/markdown; charset=utf-8"
  );
  registerContractDocRoute(
    app,
    "/openapi-v1.yaml",
    "docs/contracts/openapi-v1.yaml",
    "application/yaml; charset=utf-8"
  );

  app.get("/skill.json", async (request, reply) => {
    const origin = resolveOrigin(request);
    const apiBase = resolveApiBase(origin);
    reply.type("application/json; charset=utf-8").send(skillManifest(origin, apiBase));
  });
}
