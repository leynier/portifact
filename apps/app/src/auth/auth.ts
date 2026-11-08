import { cimd } from "@better-auth/cimd";
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { OTP_LIMITS } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "../env.ts";
import {
  ALL_SCOPES,
  AUTH_BASE_PATH,
  type AuthUrls,
  authUrls,
  MCP_BASELINE_SCOPES,
} from "./config.ts";
import type { AuthDeps } from "./deps.ts";
import { signInCodeEmail } from "./email.ts";
import { inProcessIntrospection } from "./introspection.ts";

/** Session cookies are `__Host-pf.<name>`: Secure, Path=/, no Domain (docs/security.md). */
export const COOKIE_PREFIX = "__Host-pf";

/** Error code when a provider account would be created with an unverified email. */
export const EMAIL_NOT_VERIFIED = "email_not_verified";

export function createAuth(env: Env, deps: AuthDeps) {
  const urls = authUrls(env.APP_ORIGIN);
  const provider = oauthProvider({
    loginPage: "/login",
    consentPage: "/consent",
    scopes: [...ALL_SCOPES],
    resources: [
      { identifier: urls.apiResource, name: "Portifact API" },
      { identifier: urls.mcpResource, name: "Portifact MCP" },
    ],
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
    clientRegistrationAllowedScopes: [...ALL_SCOPES],
    clientRegistrationRequirePKCE: true,
    // MCP clients that omit application_type but use loopback callbacks register as native
    // clients; web clients keep the https-only redirect policy.
    clientRegistrationDefaultApplicationType: "infer",
    // A client may only request resources it is linked to (RFC 8707). Every new client is
    // linked to the MCP resource; the CLI client is linked to the API by migration 0002.
    clientRegistrationDefaultResources: [urls.mcpResource],
  });

  return betterAuth({
    appName: "Portifact",
    baseURL: urls.origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createDb(env.DB), {
      provider: "sqlite",
      schema: schema.authSchema,
      usePlural: true,
    }),
    trustedOrigins: [urls.origin],
    telemetry: { enabled: false },
    // Sends are limited per email, IP and globally in D1 by the auth routes. Better Auth's
    // own limiter keeps counters in isolate memory, which Workers do not share.
    rateLimit: { enabled: false },
    advanced: {
      // The prefix comes from cookiePrefix instead, so names are __Host-pf.<name>.
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    session: { expiresIn: 7 * 24 * 3600, updateAge: 24 * 3600 },
    account: {
      // Identities are never merged because an email matches (plan section 5). A provider
      // account whose email belongs to another account is refused, not linked.
      accountLinking: { disableImplicitLinking: true },
      updateAccountOnSignIn: false,
    },
    user: {
      // A provider that does not vouch for the email cannot create an account with it, so a
      // later email code for that address never lands in someone else's account.
      validateUserInfo: ({ user, source }) => {
        if (source.action !== "sign-in" && user.emailVerified !== true) {
          return { error: EMAIL_NOT_VERIFIED };
        }
      },
    },
    databaseHooks: {
      account: {
        create: {
          // Portifact never calls Google or GitHub APIs for the user, so their tokens are not
          // kept.
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null },
          }),
        },
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
      },
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    onAPIError: { errorURL: `${urls.origin}/login` },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_LIMITS.codeTtlSeconds,
        allowedAttempts: OTP_LIMITS.allowedAttempts,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp }) => {
          await deps.email.send(signInCodeEmail(email, otp));
        },
      }),
      provider,
      oauthDeviceAuthorization({
        verificationUri: `${urls.origin}/device`,
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
export type { AuthUrls };
