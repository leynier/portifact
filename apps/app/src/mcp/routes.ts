// The remote MCP endpoint, /mcp on app.portifact.com (plan section 6): Streamable HTTP without
// sessions, served by the official SDK for the 2026-07-28 revision, with the stateless 2025-era
// fallback for older clients. Every request passes the same token check as /api/v1, with the
// scope of the tool it calls, before the SDK sees it; MCP has no privileged path.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { LIMITS } from "@portifact/contracts";
import { Hono } from "hono";
import type { Presigner } from "../api/presign.ts";
import { MCP_BASELINE_SCOPES } from "../auth/config.ts";
import type { FetchLike } from "../auth/deps.ts";
import {
  authorizeResourceRequest,
  type Introspect,
  type ProtectedResource,
  protectedResourceMetadataUrl,
} from "../auth/resource.ts";
import type { Env } from "../env.ts";
import { humanCheck } from "../turnstile.ts";
import { createPortifactServer, TOOL_SCOPES } from "./tools.ts";

export interface McpDeps {
  introspect(env: Env): Introspect;
  resource(env: Env): ProtectedResource;
  presigner(env: Env): Presigner;
  /** Turnstile's siteverify transport, for the human check of new comments. */
  siteverify(env: Env): FetchLike;
  now(): number;
}

/**
 * Inline content may grow when JSON-escaped; this leaves room for it and the envelope while
 * refusing anything an inline publish could never need.
 */
export const MAX_REQUEST_BYTES = 4 * LIMITS.inlineMcpBytes;

export function mcpRoutes(deps: McpDeps) {
  const app = new Hono<{ Bindings: Env }>();

  app.all("/mcp", async (c) => {
    const body = c.req.method === "POST" ? await c.req.text() : null;
    const resource = deps.resource(c.env);
    const decision = await authorizeResourceRequest(
      deps.introspect(c.env),
      c.req.raw,
      resource,
      requiredScopes(body),
    );
    if (!decision.ok) return decision.response;

    const { principal } = decision;
    const handler = createMcpHandler(
      () =>
        createPortifactServer({
          env: c.env,
          userId: principal.userId,
          now: deps.now,
          presigner: deps.presigner(c.env),
          humanCheck: humanCheck(c.env, deps.siteverify(c.env), c.req.raw, undefined),
        }),
      { legacy: "stateless", maxRequestBodySize: MAX_REQUEST_BYTES },
    );
    const request = new Request(c.req.raw.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body,
    });
    const response = await handler.fetch(request, {
      authInfo: {
        // The tools never need the raw token, so it does not travel further than the check.
        token: "",
        clientId: principal.clientId,
        scopes: principal.scopes,
        resource: new URL(resource.identifier),
        resourceMetadataUrl: protectedResourceMetadataUrl(resource),
      },
    });
    const headers = new Headers(response.headers);
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  });

  return app;
}

/**
 * The scopes a request needs: the tool's scope for a tool call, as the API route for the same
 * operation requires, and the baseline read scope for anything else (discovery, listing tools).
 * An unparsable body gets the baseline; the SDK then rejects it.
 */
export function requiredScopes(body: string | null): readonly string[] {
  let message: unknown;
  try {
    message = body === null ? null : JSON.parse(body);
  } catch {
    return MCP_BASELINE_SCOPES;
  }
  const scopes = new Set<string>();
  for (const item of Array.isArray(message) ? message : [message]) {
    const name = toolName(item);
    const scope = name === undefined ? undefined : TOOL_SCOPES.get(name);
    if (scope) scopes.add(scope);
  }
  return scopes.size > 0 ? [...scopes] : MCP_BASELINE_SCOPES;
}

function toolName(message: unknown): string | undefined {
  if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params)) {
    return undefined;
  }
  return typeof message.params.name === "string" ? message.params.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
