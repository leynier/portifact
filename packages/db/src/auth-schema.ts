// Identity and OAuth tables owned by Better Auth (docs/decisions/0001-oauth-server.md).
// apps/app passes these tables to Better Auth's Drizzle adapter with `usePlural: true`, so each
// export name is the Better Auth model name plus "s" and each property is the Better Auth field
// name. Column names follow this repository's snake_case convention.
//
// Better Auth checks at runtime that these tables hold every field it writes, so a Better Auth
// upgrade that adds fields fails loudly until the schema and a migration catch up. Regenerate
// the reference with Better Auth's Drizzle generator when upgrading and diff it against this file.
//
// Array and JSON fields are plain text: Better Auth serializes them itself for SQLite, so a
// Drizzle JSON column would encode them twice. Dates are integer milliseconds, like the rest of
// the schema.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const date = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" });
const touchedAt = () => new Date();

/** Accounts. Ownership of everything else hangs on `id`, never on the email address. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: flag("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: date("created_at").notNull(),
  updatedAt: date("updated_at").notNull().$onUpdate(touchedAt),
  // Portifact fields (user.additionalFields in apps/app/src/auth/auth.ts): the version of the
  // terms the account accepted, with the 18+ confirmation, and when. Null until it accepts.
  termsVersion: text("terms_version"),
  termsAcceptedAt: date("terms_accepted_at"),
});

/** Dashboard sessions on app.portifact.com. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: date("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: date("created_at").notNull(),
    updatedAt: date("updated_at").notNull().$onUpdate(touchedAt),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * How the session signed in (decision 0021, "SSO required"): `code`, `google`, `github` or
     * `sso:<provider ID>`, written by the session hook in the statement that creates the row
     * (`apps/app/src/auth/sign-in-method.ts`). Null for sessions from before it was recorded:
     * "not known", which "SSO required" refuses. Never changed after.
     */
    signInMethod: text("sign_in_method"),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    // The cleanup of expired sessions (`pruneAuthRecords`).
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Sign-in identities: one row per provider account (Google or GitHub), keyed by the provider's
 * stable ID in `accountId`. Provider tokens are not kept.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: date("access_token_expires_at"),
    refreshTokenExpiresAt: date("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: date("created_at").notNull(),
    updatedAt: date("updated_at").notNull().$onUpdate(touchedAt),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

/** Short-lived values: hashed OTP codes and OAuth state. */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull(),
    updatedAt: date("updated_at").notNull().$onUpdate(touchedAt),
  },
  (t) => [
    index("verifications_identifier_idx").on(t.identifier),
    // The cleanup of expired records (`pruneAuthRecords`).
    index("verifications_expires_at_idx").on(t.expiresAt),
  ],
);

/** OAuth clients: the CLI (seeded) and MCP clients from dynamic registration. */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: flag("disabled").default(false),
    skipConsent: flag("skip_consent"),
    enableEndSession: flag("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes"),
    clientCredentialsScopes: text("client_credentials_scopes").default("[]"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: flag("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    requirePKCE: flag("require_pkce"),
    dpopBoundAccessTokens: flag("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
  },
  (t) => [
    index("oauth_clients_user_id_idx").on(t.userId),
    // Registrations made without an account, oldest first, for their cleanup (`pruneAuthRecords`).
    index("oauth_clients_unowned_created_idx")
      .on(t.createdAt)
      .where(sql`${t.userId} is null`),
  ],
);

/** Protected resources (RFC 8707): the API and the MCP endpoint. */
export const oauthResources = sqliteTable("oauth_resources", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes"),
  customClaims: text("custom_claims"),
  dpopBoundAccessTokensRequired: flag("dpop_bound_access_tokens_required").default(false),
  disabled: flag("disabled").default(false),
  createdAt: date("created_at"),
  updatedAt: date("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata"),
});

/** Which resources each client may request tokens for. */
export const oauthClientResources = sqliteTable(
  "oauth_client_resources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: text("metadata"),
    createdAt: date("created_at"),
  },
  (t) => [
    uniqueIndex("oauth_client_resources_client_resource_idx").on(t.clientId, t.resourceId),
    index("oauth_client_resources_resource_idx").on(t.resourceId),
  ],
);

/** Refresh tokens, stored as hashes. */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    expiresAt: date("expires_at"),
    createdAt: date("created_at"),
    revoked: date("revoked"),
    rotatedAt: date("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: date("rotation_replay_expires_at"),
    authTime: date("auth_time"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
    /**
     * How the sign-in this grant descends from happened (decision 0021), as on `sessions`: set by
     * a trigger on insert from the token it rotates (or its session), or by the device exchange
     * from the approving session. Null when not known.
     */
    signInMethod: text("sign_in_method"),
  },
  (t) => [
    index("oauth_refresh_tokens_client_id_idx").on(t.clientId),
    index("oauth_refresh_tokens_session_id_idx").on(t.sessionId),
    index("oauth_refresh_tokens_user_id_idx").on(t.userId),
    // The cleanup of expired tokens (`pruneAuthRecords`).
    index("oauth_refresh_tokens_expires_at_idx").on(t.expiresAt),
    index("oauth_refresh_tokens_authorization_code_id_idx").on(t.authorizationCodeId),
    // The sign-in method trigger's predecessor match (migration 0061, decision 0021): the token a
    // new one rotates, found without scanning the user's whole refresh history.
    index("oauth_refresh_tokens_user_client_rotated_idx").on(t.userId, t.clientId, t.rotatedAt),
  ],
);

/** Opaque access tokens, stored as hashes and checked on every API and MCP request. */
export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
      onDelete: "cascade",
    }),
    expiresAt: date("expires_at"),
    createdAt: date("created_at"),
    revoked: date("revoked"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
    /**
     * When the sign-in this token descends from happened (decision 0021): set by a trigger on
     * insert from the refresh token's `auth_time` (kept through every rotation) or the session's
     * `created_at`, so a refresh never resets it. The introspection plugin declares the field.
     */
    authTime: date("auth_time"),
    /**
     * How the sign-in this token descends from happened (decision 0021): set by a trigger on
     * insert from its refresh token, or its session, like `auth_time`. The introspection plugin
     * declares the field, so the token check reads it with the row.
     */
    signInMethod: text("sign_in_method"),
  },
  (t) => [
    index("oauth_access_tokens_client_id_idx").on(t.clientId),
    index("oauth_access_tokens_session_id_idx").on(t.sessionId),
    index("oauth_access_tokens_user_id_idx").on(t.userId),
    // The cleanup of expired tokens (`pruneAuthRecords`).
    index("oauth_access_tokens_expires_at_idx").on(t.expiresAt),
    index("oauth_access_tokens_authorization_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_tokens_refresh_id_idx").on(t.refreshId),
  ],
);

/** Consent a user gave a client, so the consent page is not shown again for the same scopes. */
export const oauthConsents = sqliteTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    scopes: text("scopes").notNull(),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
  },
  (t) => [
    index("oauth_consents_client_id_idx").on(t.clientId),
    index("oauth_consents_user_id_idx").on(t.userId),
  ],
);

/** Single-use client assertion IDs (private_key_jwt replay protection). */
export const oauthClientAssertions = sqliteTable(
  "oauth_client_assertions",
  {
    id: text("id").primaryKey(),
    expiresAt: date("expires_at").notNull(),
  },
  // The cleanup of expired records (`pruneAuthRecords`).
  (t) => [index("oauth_client_assertions_expires_at_idx").on(t.expiresAt)],
);

/** Device authorization requests (RFC 8628) from the CLI. */
export const deviceCodes = sqliteTable(
  "device_codes",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    expiresAt: date("expires_at").notNull(),
    status: text("status").notNull(),
    lastPolledAt: date("last_polled_at"),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
    resources: text("resources"),
    oauthClientId: text("oauth_client_id"),
    /**
     * When the session that approved the code signed in (its `created_at`), written by the app
     * at approval and copied onto the grant's tokens at the exchange (decision 0021): a device
     * login inherits the approving session's sign-in, as an authorization code does. Never
     * written by Better Auth; null until approved.
     */
    approverSignedInAt: date("approver_signed_in_at"),
    /**
     * How the approving session signed in (`sessions.sign_in_method`), written with
     * `approverSignedInAt` and copied onto the grant's tokens at the exchange (decision 0021).
     * Two approvals by sessions with different methods leave `unknown`, which no method matches.
     */
    approverSignInMethod: text("approver_sign_in_method"),
  },
  (t) => [
    uniqueIndex("device_codes_device_code_idx").on(t.deviceCode),
    uniqueIndex("device_codes_user_code_idx").on(t.userCode),
    // The cleanup of expired records (`pruneAuthRecords`).
    index("device_codes_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Fixed-window counters for rate limits (OTP sends, client registration). One row per key;
 * `hitRateLimit` updates it in a single statement, so concurrent requests cannot both pass.
 */
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: integer("window_start", { mode: "number" }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);

/** The tables Better Auth's Drizzle adapter receives. */
export const authSchema = {
  users,
  sessions,
  accounts,
  verifications,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  oauthClientAssertions,
  deviceCodes,
};
