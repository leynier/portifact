// Drizzle tables the organization, SSO and SCIM plugins of Better Auth 1.7.18 need, written in
// the conventions of packages/db/src/auth-schema.ts: plural export names (`usePlural: true`),
// Better Auth field names as properties, snake_case columns, dates as integer milliseconds and
// JSON as plain text. The SQL is migrations/9001_workspace_plugins.sql.
//
// The field lists come from Better Auth's own `getAuthTables` for this configuration, and
// schema.test.ts fails if a field the plugins write is missing here.
import { schema } from "@portifact/db";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const date = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" });
const touchedAt = () => new Date();
const { users } = schema.authSchema;

/** packages/db's sessions plus the column the organization plugin adds. */
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
    // Organization plugin: the workspace the browser session acts in. Portifact would not trust
    // it for authorization; the services resolve the role from `members` on every request.
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/** Workspaces. IDs carry the `ws_` prefix so an `owner_id` says which kind of owner it is. */
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: date("created_at").notNull(),
  metadata: text("metadata"),
});

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: date("created_at").notNull(),
  },
  (t) => [
    index("members_organization_id_idx").on(t.organizationId),
    index("members_user_id_idx").on(t.userId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: date("expires_at").notNull(),
    createdAt: date("created_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("invitations_organization_id_idx").on(t.organizationId),
    index("invitations_email_idx").on(t.email),
  ],
);

/** SSO plugin: one row per identity provider, bound to a workspace by `organizationId`. */
export const ssoProviders = sqliteTable("sso_providers", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  domainVerified: flag("domain_verified"),
});

// SCIM plugin. Nine tables in all when managed connections are on; the spike uses code-defined
// connections, which need these seven.

export const scimConnectionBindings = sqliteTable("scim_connection_bindings", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  connectionKey: text("connection_key").notNull().unique(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  createdAt: date("created_at").notNull(),
  decommissionedAt: date("decommissioned_at"),
  decommissionStatus: text("decommission_status").notNull().default("active"),
  decommissionCursorUserId: text("decommission_cursor_user_id"),
  decommissionReconciledUserCount: integer("decommission_reconciled_user_count")
    .notNull()
    .default(0),
  decommissionBatchCount: integer("decommission_batch_count").notNull().default(0),
  decommissionRevision: integer("decommission_revision").notNull().default(0),
  decommissionCompletedAt: date("decommission_completed_at"),
  decommissionLeaseId: text("decommission_lease_id"),
  decommissionLeaseExpiresAt: date("decommission_lease_expires_at"),
});

export const scimIdentityTombstones = sqliteTable("scim_identity_tombstones", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  externalId: text("external_id").notNull(),
  externalIdKey: text("external_id_key").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  profile: text("profile").notNull(),
  deletedAt: date("deleted_at").notNull(),
});

export const scimSubjects = sqliteTable("scim_subjects", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  profileSourceId: text("profile_source_id"),
  revision: integer("revision").notNull(),
  createdAt: date("created_at").notNull(),
  updatedAt: date("updated_at").notNull(),
});

export const scimUsers = sqliteTable("scim_users", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectionUserKey: text("connection_user_key").notNull().unique(),
  userName: text("user_name").notNull(),
  userNameKey: text("user_name_key").notNull().unique(),
  primaryEmail: text("primary_email").notNull(),
  workEmailValueIndex: text("work_email_value_index").notNull(),
  emailValueIndex: text("email_value_index").notNull(),
  displayName: text("display_name").notNull(),
  formattedName: text("formatted_name").notNull(),
  givenName: text("given_name"),
  familyName: text("family_name"),
  serializedEmails: text("serialized_emails").notNull(),
  serializedAttributes: text("serialized_attributes"),
  externalId: text("external_id"),
  externalIdKey: text("external_id_key").unique(),
  active: flag("active").notNull(),
  orderKey: text("order_key").notNull().unique(),
  createdAt: date("created_at").notNull(),
  updatedAt: date("updated_at").notNull(),
});

export const scimProjectionGrants = sqliteTable("scim_projection_grants", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  scimUserId: text("scim_user_id")
    .notNull()
    .references(() => scimUsers.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  sourceValue: text("source_value"),
  role: text("role").notNull(),
  grantKey: text("grant_key").notNull().unique(),
  createdAt: date("created_at").notNull(),
  updatedAt: date("updated_at").notNull(),
});

export const scimGroups = sqliteTable("scim_groups", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  provisioningDomainId: text("provisioning_domain_id").notNull(),
  revision: integer("revision").notNull().default(0),
  displayName: text("display_name").notNull(),
  displayNameKey: text("display_name_key").notNull().unique(),
  externalId: text("external_id"),
  externalIdKey: text("external_id_key").unique(),
  orderKey: text("order_key").notNull().unique(),
  createdAt: date("created_at").notNull(),
  updatedAt: date("updated_at").notNull(),
});

export const scimGroupMembers = sqliteTable("scim_group_members", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  groupId: text("group_id")
    .notNull()
    .references(() => scimGroups.id, { onDelete: "cascade" }),
  scimUserId: text("scim_user_id")
    .notNull()
    .references(() => scimUsers.id, { onDelete: "cascade" }),
  membershipKey: text("membership_key").notNull().unique(),
  createdAt: date("created_at").notNull(),
});

export const workspaceTables = { organizations, members, invitations };

// The alternative design: Portifact-owned tables that Better Auth never sees.

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: date("created_at").notNull(),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "editor", "member"] }).notNull(),
    createdAt: date("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_id_idx").on(t.userId),
  ],
);
export const ssoTables = { ssoProviders };
export const scimTables = {
  scimConnectionBindings,
  scimIdentityTombstones,
  scimSubjects,
  scimUsers,
  scimProjectionGrants,
  scimGroups,
  scimGroupMembers,
};

/** What the spike passes to Better Auth's Drizzle adapter. */
export const spikeAuthSchema = {
  ...schema.authSchema,
  sessions,
  ...workspaceTables,
  ...ssoTables,
  ...scimTables,
};
