import { cimd } from "@better-auth/cimd";
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import {
  API_RESOURCE,
  AUTH_BASE_PATH,
  MCP_BASELINE_SCOPES,
  MCP_RESOURCE,
  ORIGIN,
  PORTIFACT_SCOPES,
} from "./config.ts";
import type { AuthDeps } from "./deps.ts";
import { inProcessIntrospection } from "./introspection.ts";

export function createAuth(env: Env, deps: AuthDeps) {
  const provider = oauthProvider({
    loginPage: "/login",
    consentPage: "/consent",
    scopes: [...PORTIFACT_SCOPES, "offline_access"],
    resources: [API_RESOURCE, MCP_RESOURCE],
    // Opaque access tokens are stored in D1, so revocation is immediate and every request is
    // checked against the current grant, session and client state.
    disableJwtPlugin: true,
    grantTypes: ["authorization_code", "refresh_token"],
    accessTokenExpiresIn: 3600,
    // Dynamic client registration stays on for MCP clients that do not use Client ID
    // Metadata Documents. Unauthenticated registration only creates public clients.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: [...MCP_BASELINE_SCOPES],
    clientRegistrationAllowedScopes: [...PORTIFACT_SCOPES, "offline_access"],
    clientRegistrationRequirePKCE: true,
    // MCP clients that omit application_type but use loopback callbacks register as native
    // clients; web clients keep the https-only redirect policy.
    clientRegistrationDefaultApplicationType: "infer",
    // A client may only request resources it is linked to (RFC 8707). Every new client is
    // linked to the MCP resource; the CLI client is also linked to the API when seeded.
    clientRegistrationDefaultResources: [MCP_RESOURCE],
  });

  return betterAuth({
    appName: "Portifact",
    baseURL: ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    // Better Auth detects the D1 binding and uses its D1 dialect. apps/app will pass the
    // Drizzle adapter over the same database instead.
    database: env.DB,
    trustedOrigins: [ORIGIN],
    telemetry: { enabled: false },
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ email, otp }) => deps.sendOtp(email, otp),
      }),
      provider,
      oauthDeviceAuthorization({
        verificationUri: `${ORIGIN}/device`,
        expiresIn: "10m",
        interval: "5s",
      }),
      cimd({
        fetchClientMetadataResource: deps.fetchClientMetadata,
        metadataProfile: "mcp-2026-07-28",
      }),
      inProcessIntrospection(provider.options),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
