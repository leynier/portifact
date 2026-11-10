// Better Auth configured like apps/app/src/auth/auth.ts (Drizzle over D1, email OTP, the same
// account linking and the real terms and human-check hooks), plus the organization, SSO and
// SCIM plugins under test. OAuth provider and CIMD are left out: they do not interact with
// these plugins beyond sharing the session table, which decision 0001 already covers.
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { createDb } from "@portifact/db";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { humanHooks } from "../../../apps/app/src/auth/human.ts";
import { termsHooks } from "../../../apps/app/src/auth/terms.ts";
import {
  AUTH_BASE_PATH,
  COOKIE_PREFIX,
  EMAIL_NOT_VERIFIED,
  ORIGIN,
  SSO_EMAIL_OUTSIDE_DOMAIN,
  WORKSPACE_ID_PREFIX,
} from "./config.ts";
import { ac, roles } from "./roles.ts";
import { spikeAuthSchema, ssoProviders } from "./schema.ts";
import { linkByVerifiedEmail, reconcileScimMember } from "./scim-projection.ts";
import { addMember } from "./workspaces.ts";

export { AUTH_BASE_PATH, ORIGIN } from "./config.ts";

/**
 * How Better Auth's Drizzle adapter reports transactions to the plugins:
 * - `none`: as apps/app does today (D1 has no interactive transactions).
 * - `drizzle`: Drizzle's `db.transaction`, which sends BEGIN to D1.
 * - `sequential`: a fake that runs the callback without a transaction, only to reach the SCIM
 *   endpoints in the spike. It gives no atomicity; never use it in production.
 */
export type TransactionMode = "none" | "drizzle" | "sequential";

export interface SpikeAuthOptions {
  transactions?: TransactionMode;
  /** Add the SCIM plugin, with one static connection per entry (connection ID = workspace ID). */
  scimConnections?: { workspaceId: string; token: string }[];
  /** Only to show what happens without it: Portifact's rule pinning SSO emails to the domain. */
  ssoDomainRule?: boolean;
  /**
   * Stands in for the hooks that must run when a session ends (oauth-provider's back-channel
   * logout, and Portifact's revocation of tokens bound to the session).
   */
  onSessionDeleted?: (session: { id: string; userId: string }) => void;
  /** Link a provisioned user to the existing account with the same verified email. */
  scimLinkByVerifiedEmail?: boolean;
  /** Let SCIM-created accounts past the verified-email rule, to reach the terms hook. */
  trustScimEmails?: boolean;
  /**
   * `plugin`: the organization plugin owns workspaces. `own`: no organization plugin; SSO adds
   * members to Portifact's own `workspace_members` through `provisionUser`.
   */
  workspaces?: "plugin" | "own";
}

export interface AuthDeps {
  sendOtp: (email: string, otp: string) => Promise<void>;
}

export function createAuth(env: Env, deps: AuthDeps, options: SpikeAuthOptions = {}) {
  const terms = termsHooks(env.DB, env.BETTER_AUTH_SECRET);
  const human = humanHooks(env.DB, env.BETTER_AUTH_SECRET);
  const mode = options.transactions ?? "none";
  const ownWorkspaces = options.workspaces === "own";
  const db = createDb(env.DB);
  const adapter = drizzleAdapter(mode === "sequential" ? withoutTransactions(db) : db, {
    provider: "sqlite",
    schema: spikeAuthSchema,
    usePlural: true,
    transaction: mode !== "none",
  });

  const plugins = [
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp }) => deps.sendOtp(email, otp),
    }),
    ...(ownWorkspaces
      ? []
      : [
          organization({
            ac,
            roles,
            creatorRole: "admin",
            // Invitation emails would go through packages/emails; the spike only records them.
            sendInvitationEmail: async () => {},
            invitationExpiresIn: 7 * 24 * 3600,
          }),
        ]),
    sso({
      // The IdP's email_verified claim is not trusted: an IdP controlled by a workspace admin
      // could set it for any address. Ownership comes from the provider's verified domain.
      trustEmailVerified: false,
      organizationProvisioning: { defaultRole: "member" },
      // Adds `domainVerified`, which makes a provider trusted for its own email domain. The
      // plugin's verification endpoints stay closed (they need node:dns); Portifact's own DNS
      // check (plan T2) would set the column.
      domainVerification: { enabled: true },
      saml: { requireTimestamps: true, algorithms: { onDeprecated: "reject" } },
      ...(ownWorkspaces
        ? {
            // Runs after the session exists, on every SSO sign-in, so accounts joined through a
            // verified domain become members too. addMember is idempotent.
            provisionUserOnEveryLogin: true,
            provisionUser: async ({ user, provider }) => {
              if (!provider.organizationId) return;
              await addMember(db, {
                workspaceId: provider.organizationId,
                userId: user.id,
                role: "member",
                now: new Date(),
              });
            },
          }
        : {}),
    }),
    ...(options.scimConnections
      ? [
          // The SCIM plugin's declared schema type (an optional table under
          // exactOptionalPropertyTypes) is not assignable to BetterAuthPlugin in 1.7.18.
          scim({
            connections: options.scimConnections.map((c) => ({
              id: c.workspaceId,
              provisioningDomainId: c.workspaceId,
              credentials: [
                { type: "bearer" as const, id: `${c.workspaceId}-token`, token: c.token },
              ],
            })),
            projection: { reconcileUser: reconcileScimMember },
            ...(options.scimLinkByVerifiedEmail
              ? { identity: { resolveUser: linkByVerifiedEmail } }
              : {}),
          }) as unknown as BetterAuthPlugin,
        ]
      : []),
  ];

  const ssoEmailOutsideDomain = async (providerId: string, email: string): Promise<boolean> => {
    const [provider] = await db
      .select({ domain: ssoProviders.domain, verified: ssoProviders.domainVerified })
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, providerId))
      .limit(1);
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    return !provider?.verified || provider.domain.toLowerCase() !== domain;
  };

  return betterAuth({
    appName: "Portifact spike",
    baseURL: ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: adapter,
    trustedOrigins: [ORIGIN],
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      database: {
        generateId: ({ model }) =>
          model === "organization"
            ? `${WORKSPACE_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`
            : crypto.randomUUID(),
      },
    },
    session: { expiresIn: 7 * 24 * 3600, updateAge: 24 * 3600 },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
      updateAccountOnSignIn: false,
    },
    user: {
      additionalFields: {
        termsVersion: { type: "string", required: false, input: false },
        termsAcceptedAt: { type: "date", required: false, input: false },
      },
      validateUserInfo: async ({ user, source }) => {
        const sso = (source.method === "sso-oidc" || source.method === "sso-saml") && source.sso;
        if (sso) {
          // A workspace's IdP speaks only for its own verified domain, on every SSO action, so it
          // can neither create, join nor sign in an account with someone else's address. That
          // check is what proves control of the address here: SAML has no email_verified claim.
          if (
            options.ssoDomainRule !== false &&
            (await ssoEmailOutsideDomain(sso.providerId, user.email ?? ""))
          ) {
            return { error: SSO_EMAIL_OUTSIDE_DOMAIN };
          }
          return;
        }
        if (source.method === "scim" && options.trustScimEmails) return;
        // As apps/app: no account is created with an email nobody vouched for.
        if (source.action !== "sign-in" && user.emailVerified !== true) {
          return { error: EMAIL_NOT_VERIFIED };
        }
      },
    },
    databaseHooks: {
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
        delete: {
          after: async (session) => options.onSessionDeleted?.(session),
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null },
          }),
        },
      },
    },
    plugins,
  });
}

export type SpikeAuth = ReturnType<typeof createAuth>;

/** Drizzle over D1 whose `transaction` just runs the callback: no BEGIN, no atomicity. */
function withoutTransactions<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (run: (tx: T) => unknown) => run(receiver as T);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
