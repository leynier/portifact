import { Hono } from "hono";
import { type Auth, createAuth } from "./auth.ts";
import { API_RESOURCE, ISSUER, MCP_BASELINE_SCOPES, MCP_RESOURCE } from "./config.ts";
import type { AuthDeps } from "./deps.ts";
import {
  authorizeResourceRequest,
  type Introspect,
  type IntrospectionPayload,
  type ProtectedResource,
} from "./resource.ts";

const API: ProtectedResource = { identifier: API_RESOURCE, challengeScopes: MCP_BASELINE_SCOPES };
const MCP: ProtectedResource = { identifier: MCP_RESOURCE, challengeScopes: MCP_BASELINE_SCOPES };

export function createApp(deps: AuthDeps) {
  // One Better Auth instance per environment object, which is stable per isolate.
  const instances = new WeakMap<Env, Auth>();
  const authFor = (env: Env): Auth => {
    let auth = instances.get(env);
    if (!auth) {
      auth = createAuth(env, deps);
      instances.set(env, auth);
    }
    return auth;
  };

  const introspectFor =
    (env: Env): Introspect =>
    async (token) =>
      (await authFor(env).api.introspectBearer({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })) as IntrospectionPayload;

  const app = new Hono<{ Bindings: Env }>();

  // RFC 9728 protected resource metadata, with the path of each resource inserted.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(resourceMetadata(MCP, "Portifact MCP")),
  );
  app.get("/.well-known/oauth-protected-resource/api/v1", (c) =>
    c.json(resourceMetadata(API, "Portifact API")),
  );

  // RFC 8414 authorization server metadata for the issuer path. Better Auth answers it.
  app.on(["GET", "HEAD"], "/.well-known/oauth-authorization-server/api/auth", (c) =>
    authFor(c.env).handler(c.req.raw),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c.env).handler(c.req.raw));

  // Stand-ins for the real API and MCP handlers: they prove token validation per resource.
  app.get("/api/v1/whoami", async (c) => {
    const decision = await authorizeResourceRequest(introspectFor(c.env), c.req.raw, API, [
      "artifacts:read",
    ]);
    return decision.ok ? c.json(decision.principal) : decision.response;
  });
  app.post("/mcp", async (c) => {
    const decision = await authorizeResourceRequest(introspectFor(c.env), c.req.raw, MCP, [
      "artifacts:read",
    ]);
    return decision.ok ? c.json(decision.principal) : decision.response;
  });
  app.delete("/api/v1/artifacts/:id", async (c) => {
    const decision = await authorizeResourceRequest(introspectFor(c.env), c.req.raw, API, [
      "artifacts:delete",
    ]);
    return decision.ok ? c.body(null, 204) : decision.response;
  });

  return app;
}

function resourceMetadata(resource: ProtectedResource, name: string) {
  return {
    resource: resource.identifier,
    resource_name: name,
    authorization_servers: [ISSUER],
    scopes_supported: [...resource.challengeScopes],
    bearer_methods_supported: ["header"],
  };
}
