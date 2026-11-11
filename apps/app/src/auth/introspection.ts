import { AsyncLocalStorage } from "node:async_hooks";
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
  id?: unknown;
  refreshId?: unknown;
}

/** The token row the call in progress is waiting for; one store per validation. */
const seenByCall = new AsyncLocalStorage<Seen>();

type Adapter = GenericEndpointContext["context"]["adapter"];
const watchedAdapters = new WeakMap<Adapter, Adapter>();
const watchedContexts = new WeakMap<object, GenericEndpointContext["context"]>();

/**
 * The adapter that remembers the access token row the provider reads, one per underlying
 * adapter and never one per call: the provider keys what it does once per instance (seeding its
 * resource rows) on the adapter object, so a fresh adapter per request made it read every
 * resource again on every token check, two D1 reads per bearer request.
 */
function watchedAdapter(adapter: Adapter): Adapter {
  const known = watchedAdapters.get(adapter);
  if (known) return known;
  const findOne: Adapter["findOne"] = async (query) => {
    const row = await adapter.findOne<Record<string, unknown>>(query);
    const seen = seenByCall.getStore();
    if (seen && query.model === "oauthAccessToken" && row) {
      seen.authTime = row.authTime;
      seen.id = row.id;
      seen.refreshId = row.refreshId;
    }
    return row as never;
  };
  const watched = Object.create(adapter, { findOne: { value: findOne } }) as Adapter;
  watchedAdapters.set(adapter, watched);
  return watched;
}

/**
 * The context the provider validates with: a view over the endpoint's context whose adapter is
 * the watched one, so nothing else about it changes. Stable per auth context, like its adapter.
 */
export function watching(ctx: GenericEndpointContext): GenericEndpointContext {
  let context = watchedContexts.get(ctx.context);
  if (!context) {
    context = Object.create(ctx.context, {
      adapter: { value: watchedAdapter(ctx.context.adapter) },
    }) as GenericEndpointContext["context"];
    watchedContexts.set(ctx.context, context);
  }
  return Object.create(ctx, { context: { value: context } }) as GenericEndpointContext;
}

/** Validates a token with the provider and says which token row it read doing so. */
async function validate(
  ctx: GenericEndpointContext,
  providerOptions: OAuthOptions<Scope[]>,
  token: string,
) {
  const seen: Seen = {};
  const provider = getOAuthProviderApi(watching(ctx), providerOptions);
  const payload = await seenByCall.run(seen, () => provider.validateAccessToken(token));
  return { payload, seen };
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
            const { payload, seen } = await validate(
              ctx as GenericEndpointContext,
              providerOptions,
              token,
            );
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
      // The rows of an active access token and of the refresh token it came with, found by the
      // provider's own lookup of the token (decision 0021): the device exchange writes the
      // approving session's sign-in onto exactly these rows. SERVER_ONLY, never over HTTP.
      tokenRecordOf: createAuthEndpoint(
        "/portifact/token-record",
        { method: "POST", requireHeaders: true, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const token = bearerToken(ctx.headers.get("authorization"));
          if (!token) return ctx.json(null);
          try {
            const { payload, seen } = await validate(
              ctx as GenericEndpointContext,
              providerOptions,
              token,
            );
            if (payload.active !== true || typeof seen.id !== "string") return ctx.json(null);
            return ctx.json({
              accessId: seen.id,
              refreshId: typeof seen.refreshId === "string" ? seen.refreshId : null,
            });
          } catch {
            return ctx.json(null);
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
