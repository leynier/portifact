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
import { deliverSignInCode } from "./email.ts";
import { humanHooks } from "./human.ts";
import { inProcessIntrospection } from "./introspection.ts";
import { termsHooks } from "./terms.ts";

/** Session cookies are `__Host-pf.<name>`: Secure, Path=/, no Domain (docs/security.md). */
export const COOKIE_PREFIX = "__Host-pf";

/** Error code when a provider account would be created with an unverified email. */
export const EMAIL_NOT_VERIFIED = "email_not_verified";

export function createAuth(env: Env, deps: AuthDeps) {
  const urls = authUrls(env.APP_ORIGIN);
  const terms = termsHooks(env.DB, env.BETTER_AUTH_SECRET);
  const human = humanHooks(env.DB, env.BETTER_AUTH_SECRET);
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
    // linked to the MCP resource; the CLI client is linked to the API by migration 0003.
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
    // Sends are limited per email, IP, globally per day and per month, and never go to a
    // suppressed address, in D1 by the auth routes. Better Auth's
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
      // A Google or GitHub sign-in joins the existing account with the same email, but only
      // when the provider vouches for the email and the account's own email is verified. Every
      // Portifact account has a verified email (codes prove it, and providers that do not vouch
      // for it cannot create one), so control of the address is proven on both sides.
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
      updateAccountOnSignIn: false,
    },
    user: {
      // The terms version the account accepted, with the 18+ confirmation, and when. Only the
      // hooks in terms.ts write them; get-session returns them to the login page.
      additionalFields: {
        termsVersion: { type: "string", required: false, input: false },
        termsAcceptedAt: { type: "date", required: false, input: false },
      },
      // A provider that does not vouch for the email cannot create an account with it, so a
      // later email code for that address never lands in someone else's account.
      validateUserInfo: ({ user, source }) => {
        if (source.action !== "sign-in" && user.emailVerified !== true) {
          return { error: EMAIL_NOT_VERIFIED };
        }
      },
    },
    databaseHooks: {
      // No account is created and no session is issued without the current terms accepted, and
      // no account is created without a solved human check (human.ts). The terms come first, so
      // a refusal for them does not spend the check.
      user: {
        create: {
          before: async (user, ctx) => {
            const accepted = await terms.user.create.before(user, ctx);
            await human.requireForNewUser(ctx);
            return accepted;
          },
        },
      },
      session: {
        create: {
          before: terms.session.create.before,
          after: async (session, ctx) => {
            await terms.session.create.after(session, ctx);
            human.clear(ctx);
          },
        },
      },
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
          await deliverSignInCode(createDb(env.DB), deps.email, {
            email,
            code: otp,
            now: Date.now,
          });
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
