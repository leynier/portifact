import { getOAuthProviderApi, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";

// Resource servers (API and MCP) live in the same Worker as the authorization server, so they
// validate opaque access tokens in process instead of calling the HTTP introspection
// endpoint with client credentials. The endpoint is SERVER_ONLY: it is reachable through
// auth.api but never over HTTP. It receives the provider's resolved options, which the
// oauthProvider() plugin exposes as `options`.
export function inProcessIntrospection(providerOptions: OAuthOptions<Scope[]>) {
  return {
    id: "portifact-in-process-introspection",
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
            const provider = getOAuthProviderApi(ctx, providerOptions);
            return ctx.json(await provider.validateAccessToken(token));
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
