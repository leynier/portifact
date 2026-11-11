import { getOAuthProviderApi, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";

/**
 * The claim the in-process introspection adds to an active token's payload (decision 0021): when
 * the sign-in it descends from happened, in seconds, from the token row the provider just read
 * (`oauth_access_tokens.auth_time`, set by the trigger of migration 0058 and carried through every
 * refresh). Absent when the row does not say. Never sent over HTTP: the endpoint is SERVER_ONLY.
 */
export const AUTH_TIME_CLAIM = "portifact_auth_time";

/** What the provider's adapter read for the token, captured as it read it: no read is added. */
interface Seen {
  authTime?: unknown;
}

/**
 * The context the provider validates with, whose adapter remembers the token row it reads. A
 * view over the endpoint's context, so nothing else about it changes.
 */
function watching(ctx: GenericEndpointContext, seen: Seen): GenericEndpointContext {
  const adapter = ctx.context.adapter;
  const findOne: typeof adapter.findOne = async (query) => {
    const row = await adapter.findOne<Record<string, unknown>>(query);
    if (query.model === "oauthAccessToken" && row) seen.authTime = row.authTime;
    return row as never;
  };
  const watched = Object.create(adapter, { findOne: { value: findOne } }) as typeof adapter;
  return Object.create(ctx, {
    context: { value: Object.create(ctx.context, { adapter: { value: watched } }) },
  }) as GenericEndpointContext;
}

function seconds(value: unknown): number | undefined {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

// Resource servers (API and MCP) live in the same Worker as the authorization server, so they
// validate opaque access tokens in process instead of calling the HTTP introspection
// endpoint with client credentials. The endpoint is SERVER_ONLY: it is reachable through
// auth.api but never over HTTP. It receives the provider's resolved options, which the
// oauthProvider() plugin exposes as `options`.
export function inProcessIntrospection(providerOptions: OAuthOptions<Scope[]>) {
  return {
    id: "portifact-in-process-introspection",
    // The token row's sign-in time (migration 0058), so the adapter returns it with the row the
    // provider reads; the provider never writes it, the trigger does.
    schema: {
      oauthAccessToken: {
        modelName: "oauthAccessToken",
        fields: { authTime: { type: "date", required: false, input: false } },
      },
    },
    endpoints: {
      introspectBearer: createAuthEndpoint(
        "/portifact/introspect",
        { method: "POST", requireHeaders: true, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const token = bearerToken(ctx.headers.get("authorization"));
          if (!token) {
            throw new APIError("UNAUTHORIZED", { error: "invalid_request" });
          }
          try {
            const seen: Seen = {};
            const provider = getOAuthProviderApi(
              watching(ctx as GenericEndpointContext, seen),
              providerOptions,
            );
            const payload = await provider.validateAccessToken(token);
            const authTime = payload.active === true ? seconds(seen.authTime) : undefined;
            return ctx.json(
              authTime === undefined ? payload : { ...payload, [AUTH_TIME_CLAIM]: authTime },
            );
          } catch {
            // Unknown, malformed or foreign tokens are simply inactive.
            return ctx.json({ active: false });
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

export function bearerToken(header: string | null): string | undefined {
  const match = header?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/);
  return match?.[1];
}
