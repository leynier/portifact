// D1 schema for Portifact's product data (plan section 14). Identity and OAuth tables live in
// auth-schema.ts and are re-exported here, so drizzle-kit sees one schema.
// Timestamps are integer milliseconds since the epoch (UTC).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sessions, users } from "./auth-schema.ts";

/** Regions and roles, as in @portifact/contracts (packages/db does not depend on it). */
export const REGIONS = ["default", "eu"] as const;
export const WORKSPACE_ROLES = ["admin", "editor", "member"] as const;

/** Categories of the Acceptable Use Policy, for reports and suspensions (contracts: AbuseReason). */
export const ABUSE_REASONS = [
  "phishing",
  "malware",
  "sexual_content",
  "child_safety",
  "copyright",
  "impersonation",
  "harassment",
  "private_information",
  "spam",
  "other",
] as const;

/** Edit suggestions (decision 0027), as in @portifact/contracts. */
export const SUGGESTION_THREAD_KINDS = ["comment", "suggestion"] as const;
export const SUGGESTION_STATES = [
  "pending",
  "applying",
  "accepted",
  "rejected",
  "withdrawn",
  "outdated",
] as const;
/** Why an acceptance or draft publish ended without completing (the recovery table). */
export const ACCEPTANCE_END_REASONS = [
  "failed",
  "version_conflict",
  "quota_exceeded",
  "capacity_unavailable",
  "plan_changed",
  "revoked",
] as const;
export const CHANGE_ITEM_STATES = ["open", "applied", "dismissed", "closed_by_version"] as const;
/** Open change-list items an artifact holds at most (the acceptance claim reserves room). */
export const CHANGE_ITEMS_OPEN_MAX = 1_000;

const timestamp = (name: string) => integer(name, { mode: "number" });
const createdAt = () => timestamp("created_at").notNull().default(sql`(unixepoch() * 1000)`);

export const artifacts = sqliteTable(
  "artifacts",
  {
    /** 10-character base32 ID; also the `<id>.portifact.dev` hostname label. Never reused. */
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    type: text("type", { enum: ["site", "markdown", "text"] }).notNull(),
    name: text("name").notNull(),
    state: text("state", {
      enum: ["draft", "active", "archived", "suspended", "purging", "deleted"],
    })
      .notNull()
      .default("draft"),
    /** `workspace` and `domain` only on workspace artifacts (decision 0010); no CHECK, contracts decide. */
    accessMode: text("access_mode", {
      enum: ["public", "authenticated", "restricted", "workspace", "domain"],
    })
      .notNull()
      .default("restricted"),
    /** Bumped on every access change; read sessions carry it so revocation applies quickly. */
    policyGeneration: integer("policy_generation").notNull().default(1),
    annotations: text("annotations", { enum: ["off", "open", "locked"] })
      .notNull()
      .default("off"),
    indexable: integer("indexable", { mode: "boolean" }).notNull().default(false),
    embeddable: integer("embeddable", { mode: "boolean" }).notNull().default(false),
    /**
     * The Portifact bar: top-level visits to the artifact's pages open in the viewer on the app
     * (bar, artifact in a frame, comments sidebar). Off, they get the artifact itself.
     */
    bar: integer("bar", { mode: "boolean" }).notNull().default(true),
    currentVersionId: text("current_version_id"),
    /** Bumped on every lifecycle transition so stale maintenance jobs cannot act. */
    lifecycleGeneration: integer("lifecycle_generation").notNull().default(1),
    expiresAt: timestamp("expires_at"),
    /**
     * The expiry the owner was last emailed about (plan section 10, expiry notices) and when. A
     * publish or renewal sets a new `expires_at`, so the notice is due again only for the new one.
     */
    expiryNoticeFor: timestamp("expiry_notice_for"),
    expiryNoticeAt: timestamp("expiry_notice_at"),
    archivedAt: timestamp("archived_at"),
    purgeAt: timestamp("purge_at"),
    /**
     * Why an operator suspended the artifact, shown to its owner; null unless `suspended`. The
     * history, the state to go back to and the operator's notes are in `suspensions`.
     */
    suspensionReason: text("suspension_reason", { enum: ABUSE_REASONS }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    /**
     * Who sees the annotation threads (plan section 8, "Permisos"): `owner` shows each reader
     * only the threads they or the owner started; `everyone` shows every thread to every
     * reader. The owner always sees everything. Readers on the list can override it.
     */
    commentVisibility: text("comment_visibility", { enum: ["owner", "everyone"] })
      .notNull()
      .default("owner"),
    /**
     * Pinned (premium plan P2, feature `pin`): the artifact stays active with no `expires_at`
     * until it is unpinned. Only an active or suspended artifact is pinned; archiving clears it.
     * Kept last because `ALTER TABLE ADD COLUMN` appends it.
     */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /**
     * The artifact's active custom hostname (premium plan P7, decision 0006), or null. The
     * authority for serving on a custom host: the content Worker serves a custom host only when
     * this column holds it, attaching sets it last and detaching clears it first. On the artifact,
     * not on a version, so a rollback keeps it. Kept last because `ALTER TABLE ADD COLUMN`
     * appends it.
     */
    customHost: text("custom_host"),
    /**
     * The stable publish key (decision 0011): unique per owner while the artifact exists, so a
     * deleted or purging artifact releases it at once. Kept last because `ALTER TABLE ADD COLUMN`
     * appends it.
     */
    externalKey: text("external_key"),
    /**
     * Who created it: a user or a service token (decision 0011), for a token's `own`
     * restriction. Null for artifacts created before the column. No foreign key.
     */
    createdBy: text("created_by"),
    /**
     * When the artifact's current life started other than by a publish (decision 0023): its last
     * restore from the archive or its move into another space. With its current version's
     * `committed_at`, where a workspace's maximum life counts from. Null until then. Kept last
     * because `ALTER TABLE ADD COLUMN` appends it.
     */
    lifeStartedAt: timestamp("life_started_at"),
    /**
     * The expiry the artifact's plan gave it before its workspace's maximum life brought it
     * forward (decision 0023); null while the maximum did not. What the policy gives back when it
     * is lengthened, shortened or removed, so no cap outlives the rule that set it.
     */
    uncappedExpiresAt: timestamp("uncapped_expires_at"),
  },
  (t) => [
    index("artifacts_owner_state_idx").on(t.ownerId, t.state),
    uniqueIndex("artifacts_owner_key_idx")
      .on(t.ownerId, t.externalKey)
      .where(sql`${t.externalKey} is not null and ${t.state} not in ('purging', 'deleted')`),
    uniqueIndex("artifacts_custom_host_idx")
      .on(t.customHost)
      .where(sql`${t.customHost} is not null`),
    // The scan that unpins the artifacts of owners whose plan no longer includes `pin`.
    index("artifacts_pinned_owner_idx").on(t.ownerId).where(sql`${t.pinned} = 1`),
    // The sweep that gives back caps no rule asks for any more (decision 0023): owners with one.
    index("artifacts_capped_owner_idx")
      .on(t.ownerId)
      .where(sql`${t.uncappedExpiresAt} is not null`),
    index("artifacts_state_expires_idx").on(t.state, t.expiresAt),
    index("artifacts_state_purge_idx").on(t.state, t.purgeAt),
    check("artifacts_id_format", sql`length(${t.id}) = 10`),
    check("artifacts_name_length", sql`length(${t.name}) between 1 and 200`),
  ],
);

/**
 * Email addresses allowed to read a `restricted` artifact, with their exception to who sees the
 * comments.
 */
export const artifactReaders = sqliteTable(
  "artifact_readers",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: createdAt(),
    /**
     * This reader's exception to the artifact's `comment_visibility`: `all` threads or only
     * their `own` and the owner's. Null inherits the artifact's setting. It applies to whoever
     * signs in with this verified address, in every access mode.
     */
    commentVisibility: text("comment_visibility", { enum: ["all", "own"] }),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.email] }),
    index("artifact_readers_email_idx").on(t.email),
    check("artifact_readers_email_lower", sql`${t.email} = lower(${t.email})`),
  ],
);

/**
 * Groups of the owning workspace a `restricted` artifact lists (decision 0014), with their
 * exception to who sees the comments. Regional, with the artifact; the group is global, so there
 * is no foreign key to it: a row whose group is gone grants nothing (reading checks the global
 * membership) and the maintenance scan removes it, oldest `checked_at` first.
 */
export const artifactGroups = sqliteTable(
  "artifact_groups",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull(),
    /** Like `artifact_readers.comment_visibility`; null inherits the artifact's setting. */
    commentVisibility: text("comment_visibility", { enum: ["all", "own"] }),
    createdAt: timestamp("created_at").notNull(),
    /** When the scan last found the group alive; null until the first scan. */
    checkedAt: timestamp("checked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.groupId] }),
    index("artifact_groups_group_idx").on(t.groupId),
    index("artifact_groups_checked_idx").on(t.checkedAt),
  ],
);

/**
 * One-use codes that carry a sign-in from app.portifact.com to an artifact origin. Only the
 * SHA-256 of the code and of the origin's transaction nonce are stored. Redeeming sets
 * `used_at` and the read session it created, in the same guarded update.
 */
export const readHandoffs = sqliteTable(
  "read_handoffs",
  {
    codeHash: text("code_hash").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    stateHash: text("state_hash").notNull(),
    /**
     * The app.portifact.com session that asked for the code. Users and sessions are global and
     * this row is regional (decision 0005), so there is no foreign key: redeeming checks that the
     * session is still live in the global database, so a signed-out session redeems nothing.
     */
    authSessionId: text("auth_session_id").notNull(),
    /** Policy generation the access check passed against; the read session starts from it. */
    policyGeneration: integer("policy_generation").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    sessionId: text("session_id"),
    createdAt: createdAt(),
    /**
     * The exact hostname the code was sent to: the artifact's `.dev` host or its active custom
     * host (decision 0006). Redemption is conditioned on the request's host; null (codes issued
     * before this column) counts as the `.dev` host. Kept last because `ALTER TABLE` appends it.
     */
    host: text("host"),
  },
  (t) => [
    index("read_handoffs_expires_idx").on(t.expiresAt),
    index("read_handoffs_auth_session_idx").on(t.authSessionId),
  ],
);

/** Read sessions per artifact and user, behind the `__Host-pf_read` cookie of one origin. */
export const readSessions = sqliteTable(
  "read_sessions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /**
     * The app.portifact.com session the reader signed in with. Claims are renewed only while it
     * exists and has not expired, so signing out of the app ends the read session too.
     */
    authSessionId: text("auth_session_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("read_sessions_expires_idx").on(t.expiresAt),
    index("read_sessions_user_idx").on(t.userId),
    index("read_sessions_artifact_idx").on(t.artifactId),
    index("read_sessions_auth_session_idx").on(t.authSessionId),
  ],
);

/**
 * Share links (premium plan P4, decision 0008): a link that lets anyone who holds it read one
 * artifact without an account. Only the SHA-256 of its token is stored; the password, when there
 * is one, as a PBKDF2 hash with its salt and iteration count. Revoked links stay until the
 * artifact is purged: their label names old access log entries, and `exportTombstones` exports
 * their revocation so a restore cannot bring them back.
 */
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull(),
    expiresAt: timestamp("expires_at"),
    passwordHash: text("password_hash"),
    passwordSalt: text("password_salt"),
    passwordIterations: integer("password_iterations"),
    /**
     * The user who created it; no foreign key (the table is regional). Account deletion clears it
     * (`advanceAccountDeletion`), so a deleted account's ID does not stay on links of artifacts it
     * did not own.
     */
    createdBy: text("created_by"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at"),
    /** Start of the UTC day the link was last opened. */
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    uniqueIndex("share_links_token_idx").on(t.tokenHash),
    index("share_links_artifact_idx").on(t.artifactId, t.createdAt),
    check(
      "share_links_password_complete",
      sql`(${t.passwordHash} is null) = (${t.passwordSalt} is null) and (${t.passwordHash} is null) = (${t.passwordIterations} is null)`,
    ),
  ],
);

/**
 * One-use codes that carry a share link's visitor from the app's entry page to the artifact
 * origin's `/__portifact/link`. Only the SHA-256 of the code is stored.
 */
export const shareHandoffs = sqliteTable(
  "share_handoffs",
  {
    codeHash: text("code_hash").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    sessionId: text("session_id"),
    createdAt: createdAt(),
    /**
     * The exact hostname the code was sent to: the artifact's `.dev` host or its active custom
     * host (decision 0006). Redemption is conditioned on the request's host; null (codes issued
     * before this column) counts as the `.dev` host. Kept last because `ALTER TABLE` appends it.
     */
    host: text("host"),
  },
  (t) => [index("share_handoffs_expires_idx").on(t.expiresAt)],
);

/**
 * Link sessions behind the `__Host-pf_link` cookie of one artifact origin. They end with the
 * link (revocation or expiry), never with a Better Auth session, and name no one.
 */
export const shareSessions = sqliteTable(
  "share_sessions",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("share_sessions_expires_idx").on(t.expiresAt),
    index("share_sessions_link_idx").on(t.linkId),
  ],
);

/**
 * One-use codes that open review mode (plan section 4, "Modo revisión"): issued by the viewer's
 * API call on app.portifact.com and redeemed by the viewer's iframe on the artifact origin. Only
 * the SHA-256 of the code is stored. The code pins one version.
 */
export const reviewHandoffs = sqliteTable(
  "review_handoffs",
  {
    codeHash: text("code_hash").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /**
     * The app.portifact.com session that asked for the code. No foreign key (decision 0005):
     * redeeming checks the session in the global database.
     */
    authSessionId: text("auth_session_id").notNull(),
    policyGeneration: integer("policy_generation").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    sessionId: text("session_id"),
    createdAt: createdAt(),
    /**
     * Where the code may be redeemed: `frame` in the viewer's iframe (partitioned cookie) or
     * `tab` in a top-level review tab (first-party cookie, shorter session).
     */
    kind: text("kind", { enum: ["frame", "tab"] })
      .notNull()
      .default("frame"),
    /**
     * The exact hostname the code was sent to: the artifact's `.dev` host or its active custom
     * host (decision 0006). Redemption is conditioned on the request's host; null (codes issued
     * before this column) counts as the `.dev` host. Kept last because `ALTER TABLE` appends it.
     */
    host: text("host"),
  },
  (t) => [
    index("review_handoffs_expires_idx").on(t.expiresAt),
    index("review_handoffs_auth_session_idx").on(t.authSessionId),
  ],
);

/**
 * Review sessions behind the partitioned `__Host-pf_review` cookie of one artifact origin: one
 * user reading one pinned version inside the viewer. They end with the app session that opened
 * them, like read sessions.
 */
export const reviewSessions = sqliteTable(
  "review_sessions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** No foreign key (decision 0005): renewing checks the session in the global database. */
    authSessionId: text("auth_session_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("review_sessions_expires_idx").on(t.expiresAt),
    index("review_sessions_user_idx").on(t.userId),
    index("review_sessions_artifact_idx").on(t.artifactId),
    index("review_sessions_auth_session_idx").on(t.authSessionId),
  ],
);

/** Immutable published versions. */
export const versions = sqliteTable(
  "versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    authorId: text("author_id").notNull(),
    state: text("state", { enum: ["uploading", "ready", "committed", "expired"] })
      .notNull()
      .default("uploading"),
    entrypoint: text("entrypoint").notNull(),
    publishedBytes: integer("published_bytes").notNull(),
    sourceBytes: integer("source_bytes").notNull().default(0),
    /** `RENDERER_VERSION` of the stored rendering of a document; null for sites. */
    rendererVersion: text("renderer_version"),
    committedAt: timestamp("committed_at"),
    /**
     * When the version stopped being current (a publish or rollback replaced it); null while it
     * is current or never committed. How long a previous version is kept is decided from this
     * and the owner's plan when it is read or pruned (`previousVersionRetained` in
     * packages/domain), so a plan change applies to versions already replaced.
     */
    supersededAt: timestamp("superseded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("versions_artifact_number_idx").on(t.artifactId, t.number),
    // Previous versions only, for the pruning scan.
    index("versions_superseded_idx").on(t.supersededAt).where(sql`${t.supersededAt} is not null`),
    // An artifact's committed versions, counted for every row of the artifact list; without it
    // the planner may walk every committed version through `versions_state_expires_idx`.
    index("versions_artifact_state_idx").on(t.artifactId, t.state),
    check("versions_bytes_nonnegative", sql`${t.publishedBytes} >= 0 and ${t.sourceBytes} >= 0`),
  ],
);

/**
 * Declared git origin of a version's private sources (plan section 6, "Fuentes desde git"): the
 * commit, branch and credential-free remote, and whether the sources had uncommitted changes.
 * Owner-only, like the sources. A rollback copies the row to its new version.
 */
export const sourceOrigins = sqliteTable(
  "source_origins",
  {
    versionId: text("version_id")
      .primaryKey()
      .references(() => versions.id, { onDelete: "cascade" }),
    commit: text("commit"),
    branch: text("branch"),
    remote: text("remote"),
    dirty: integer("dirty", { mode: "boolean" }).notNull(),
  },
  (t) => [
    check(
      "source_origins_commit_format",
      sql`${t.commit} is null or length(${t.commit}) in (40, 64)`,
    ),
    check("source_origins_branch_length", sql`${t.branch} is null or length(${t.branch}) <= 255`),
    check("source_origins_remote_length", sql`${t.remote} is null or length(${t.remote}) <= 2048`),
  ],
);

/** Content-addressed objects stored in R2, deduplicated per account. */
export const objects = sqliteTable(
  "objects",
  {
    ownerId: text("owner_id").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    state: text("state", { enum: ["pending", "verified", "purging"] })
      .notNull()
      .default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.sha256] }),
    // Not unique: a transferred artifact's objects get rows for the new owner that point at the
    // same R2 key (packages/services/src/transfer.ts). A key is deleted only once no row has it.
    index("objects_r2_key_idx").on(t.r2Key),
    check("objects_sha256_format", sql`length(${t.sha256}) = 64`),
  ],
);

/**
 * Manifest entries: which object backs each path of a version. `published` and `source` come
 * from the client. A document version also gets `rendered` (the HTML page served at the root)
 * and, for Markdown, `block_map` (the block ids and source positions anchors refer to), both at
 * the entrypoint's path and written by the server when it renders the version.
 */
export const versionFiles = sqliteTable(
  "version_files",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["published", "source", "rendered", "block_map"] }).notNull(),
    path: text("path").notNull(),
    ownerId: text("owner_id").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.kind, t.path] }),
    index("version_files_object_idx").on(t.ownerId, t.sha256),
  ],
);

export const uploadSessions = sqliteTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    versionId: text("version_id").notNull(),
    /** Version the publish was based on; commit fails with a conflict if it changed. */
    baseVersionId: text("base_version_id"),
    state: text("state", {
      enum: ["uploading", "verifying", "ready", "committed", "failed", "aborted", "expired"],
    })
      .notNull()
      .default("uploading"),
    reservedSlots: integer("reserved_slots").notNull().default(0),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    reservedFiles: integer("reserved_files").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("upload_sessions_owner_state_idx").on(t.ownerId, t.state),
    index("upload_sessions_state_expires_idx").on(t.state, t.expiresAt),
  ],
);

/**
 * R2 multipart uploads of an upload session, one per object over the multipart threshold (plan
 * section 9). `upload_id` is R2's; the client puts each part straight to R2 through presigned
 * URLs and reports its ETag into `multipart_parts`. A closed session leaves an
 * `abort_multipart` job that aborts what was not completed and deletes these rows.
 */
export const multipartUploads = sqliteTable(
  "multipart_uploads",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    ownerId: text("owner_id").notNull(),
    r2Key: text("r2_key").notNull(),
    uploadId: text("upload_id").notNull(),
    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.sha256] }),
    check("multipart_uploads_plan", sql`${t.partSize} > 0 and ${t.partCount} > 0`),
  ],
);

/** Parts of a multipart upload the client reported as stored, with the ETag R2 answered. */
export const multipartParts = sqliteTable(
  "multipart_parts",
  {
    sessionId: text("session_id").notNull(),
    sha256: text("sha256").notNull(),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.sha256, t.partNumber] }),
    foreignKey({
      columns: [t.sessionId, t.sha256],
      foreignColumns: [multipartUploads.sessionId, multipartUploads.sha256],
    }).onDelete("cascade"),
  ],
);

/** Per-account counters kept in the same transactions as the work they admit. */
export const accountUsage = sqliteTable(
  "account_usage",
  {
    ownerId: text("owner_id").primaryKey(),
    activeArtifacts: integer("active_artifacts").notNull().default(0),
    storedBytes: integer("stored_bytes").notNull().default(0),
    reservedBytes: integer("reserved_bytes").notNull().default(0),
    openUploads: integer("open_uploads").notNull().default(0),
    newObjectsThisMonth: integer("new_objects_this_month").notNull().default(0),
    monthStartedAt: timestamp("month_started_at").notNull(),
    updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    /**
     * The account's limits, compared by the CHECK constraints below. The defaults are the free
     * plan (LIMITS.activeArtifacts and LIMITS.accountBytes in contracts; a test fails if they
     * drift). SQLite cannot alter a CHECK, so a plan changes these columns instead.
     */
    activeLimit: integer("active_limit").notNull().default(50),
    bytesLimit: integer("bytes_limit").notNull().default(2_500_000_000),
  },
  (t) => [
    check(
      "account_usage_nonnegative",
      sql`${t.activeArtifacts} >= 0 and ${t.storedBytes} >= 0 and ${t.reservedBytes} >= 0 and ${t.openUploads} >= 0`,
    ),
    check("account_usage_limits_nonnegative", sql`${t.activeLimit} >= 0 and ${t.bytesLimit} >= 0`),
    check("account_usage_active_limit", sql`${t.activeArtifacts} <= ${t.activeLimit}`),
    check(
      "account_usage_bytes_limit",
      sql`${t.storedBytes} + ${t.reservedBytes} <= ${t.bytesLimit}`,
    ),
  ],
);

/** Rolling-window events (publishes, new files and bytes) for the 24-hour limits. */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id").notNull(),
    kind: text("kind", { enum: ["publish", "new_files", "new_bytes"] }).notNull(),
    amount: integer("amount").notNull(),
    at: timestamp("at").notNull(),
  },
  (t) => [
    index("usage_events_owner_kind_at_idx").on(t.ownerId, t.kind, t.at),
    // Pruned once no 24-hour window can count them (`pruneUploadHistory`).
    index("usage_events_at_idx").on(t.at),
  ],
);

/**
 * Traffic each account's artifacts served per cycle (plan section 14): requests and body bytes
 * from the content Worker, added in batches. `cycle_start` is the start of the UTC calendar month.
 * Rows of past cycles are pruned by the maintenance job and an account's rows go with its
 * deletion.
 */
export const trafficCounters = sqliteTable(
  "traffic_counters",
  {
    ownerId: text("owner_id").notNull(),
    cycleStart: timestamp("cycle_start").notNull(),
    requests: integer("requests").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.cycleStart] }),
    check("traffic_counters_nonnegative", sql`${t.requests} >= 0 and ${t.bytes} >= 0`),
    index("traffic_counters_cycle_idx").on(t.cycleStart),
  ],
);

/** Idempotency: the stored result of a mutation, returned again when it is retried. */
export const operations = sqliteTable(
  "operations",
  {
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    result: text("result", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.actorId, t.idempotencyKey] })],
);

/** Follow-up jobs of the transactional outbox (packages/services/src/outbox.ts). */
export const OUTBOX_TOPICS = [
  "purge_artifact",
  "account_deletion",
  "delete_objects",
  "abort_multipart",
  "erase_access_events",
  "expiry_notice",
  "comment_notice",
  "owner_retention",
  "webhook_delivery",
  "delete_custom_hostname",
  "workspace_deletion",
  "access_history_move",
  "domain_notice",
  "search_index",
  "review_notice",
  "workspace_policy",
  "directory_notice",
  "thread_issue",
  "plan_region",
  "audit_stream",
  "retention_notice",
  "plan_grace_notice",
  "comment_retention_notice",
  "comment_tombstones",
  "moderation_notice",
  "report_outcome",
  "legal_hold_release",
  "suggestion_accept",
  "draft_publish",
  "suggestion_carry",
  "change_list_check",
  "data_fence",
  "data_erase",
  "data_author_erasure",
  "data_reconcile",
  "data_resolve",
  "data_export",
  "data_audit",
  "data_reset",
] as const;

/**
 * Transactional outbox: a job written in the same D1 batch as the state change that needs it.
 * The scheduled run relays pending rows to the `portifact-jobs` queue and the consumer deletes a
 * row once its job is done. `subject` is the artifact, account or owner the job is about, and
 * `generation` the artifact's lifecycle generation a purge was claimed with, so a stale job never
 * acts on an artifact that changed since. `payload` holds the job's data as JSON.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topic: text("topic", { enum: OUTBOX_TOPICS }).notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    availableAt: timestamp("available_at").notNull(),
    dispatchedAt: timestamp("dispatched_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    subject: text("subject"),
    generation: integer("generation"),
  },
  (t) => [
    index("outbox_pending_idx").on(t.dispatchedAt, t.availableAt),
    index("outbox_subject_idx").on(t.topic, t.subject),
  ],
);

/** Where each paginated maintenance scan resumes, and when its current pass started. */
export const maintenanceCursors = sqliteTable("maintenance_cursors", {
  name: text("name").primaryKey(),
  cursor: text("cursor").notNull().default(""),
  passStartedAt: timestamp("pass_started_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * What the storage reconciliation found and nothing deleted: `missing` (a verified object row
 * whose R2 object is gone), `size_mismatch` (the R2 object has another size) and `orphan` (an R2
 * object no row references). The operator reviews them with `operator storage-report`.
 */
export const storageFindings = sqliteTable(
  "storage_findings",
  {
    kind: text("kind", { enum: ["missing", "size_mismatch", "orphan"] }).notNull(),
    r2Key: text("r2_key").notNull(),
    detail: text("detail"),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.r2Key] })],
);

export const lifecycleEvents = sqliteTable(
  "lifecycle_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artifactId: text("artifact_id").notNull(),
    actorId: text("actor_id"),
    channel: text("channel", { enum: ["web", "cli", "mcp", "system"] }).notNull(),
    event: text("event").notNull(),
    details: text("details", { mode: "json" }),
    at: timestamp("at").notNull(),
  },
  (t) => [
    index("lifecycle_events_artifact_at_idx").on(t.artifactId, t.at),
    // The history of purged artifacts, oldest first, for its retention (`pruneGoneHistory`).
    index("lifecycle_events_purged_at_idx")
      .on(t.at, t.artifactId)
      .where(sql`${t.event} = 'purged'`),
    // An account's actions, forgotten when it is deleted (`eraseAccountTraces`).
    index("lifecycle_events_actor_idx").on(t.actorId).where(sql`${t.actorId} is not null`),
  ],
);

/**
 * Purged artifact IDs, deleted accounts and deleted workspaces: never reused, never restored from
 * backups.
 */
export const tombstones = sqliteTable(
  "tombstones",
  {
    /**
     * `share_link` marks a revoked share link (decision 0008), `webhook` a removed webhook
     * (decision 0009) and `service_token` a revoked service token (decision 0011), so a restore
     * cannot revive them; `workspace` a deleted workspace; `workspace_domain` a removed or lapsed
     * verified email domain by its row ID (decision 0010); `workspace_group` a deleted group and
     * `workspace_group_member` a removed group membership by its row ID (decision 0014);
     * `workspace_sso` a removed single sign-on provider by its row ID (decision 0016);
     * `scim_token` a revoked SCIM token and `scim_user` a directory user the directory deleted,
     * `workspace_invitation` a pending membership the directory withdrew by its row ID and
     * `workspace_member` a membership the directory ended, as `<workspace>:<user>`, which a
     * restore must not bring back if it was created before the tombstone (decision 0017);
     * `audit_stream` a removed audit stream (decision 0019); `github_trust_rule` a removed GitHub
     * trust rule (decision 0024). `comment_thread` and `comment_message` a deleted thread or message,
     * `workspace_member` also an admin's removal and `workspace_member_left` a member leaving,
     * `workspace_invitation` also a revoked or declined invitation, `notice_opt_out` an email
     * preference turned off (`<user>:<preference>`) and `comment_notice_mute` a per-artifact mute
     * (`<artifact>:<user>`), and, written by triggers on the identity tables (migration 0071),
     * `session` an unexpired browser session that ended, `oauth_token` an unexpired OAuth access or
     * refresh token deleted or revoked and `oauth_grant` a consent deleted (an app disconnected):
     * these are pruned after the Time Travel window (`WINDOW_TOMBSTONE_KINDS`,
     * docs/operations.md, "Restoring a backup"). The directory's `workspace_member` and
     * `workspace_invitation` tombstones are pruned with them (decision 0017).
     */
    kind: text("kind", {
      enum: [
        "artifact",
        "account",
        "share_link",
        "workspace",
        "webhook",
        "service_token",
        "workspace_domain",
        "workspace_group",
        "workspace_group_member",
        "workspace_sso",
        "scim_token",
        "scim_user",
        "workspace_invitation",
        "workspace_member",
        "integration_connection",
        "audit_stream",
        "comment_thread",
        "github_trust_rule",
        "comment_message",
        "workspace_member_left",
        "notice_opt_out",
        "comment_notice_mute",
        "session",
        "oauth_token",
        "oauth_grant",
        "data_grant",
      ],
    }).notNull(),
    id: text("id").notNull(),
    deletedAt: timestamp("deleted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    // The prune of restore markers reads each kind oldest first (`pruneGroupTombstones`).
    index("tombstones_kind_deleted_idx").on(t.kind, t.deletedAt),
  ],
);

/**
 * Reports sent through the public report form (`POST /api/v1/reports`). Untrusted text; the
 * operator reads them with the operator tool (docs/operations.md). The reporter's email and name
 * are optional and erased when that address's account is deleted. `address` is the exact address
 * reported, in full; `confirmed` the reporter's statement that the report is accurate, complete
 * and sent in good faith (a full notice). `outcome_notice` records the email that told the
 * reporter the decision: `sent`, `withheld` by the operator, or `undeliverable`.
 */
export const abuseReports = sqliteTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    reporterEmail: text("reporter_email"),
    /**
     * The keyed hash of the reporter's email (the sign-in limits' `keyedHash`), which keys the
     * outcome emails' daily counter; erased with the email.
     */
    reporterEmailKey: text("reporter_email_key"),
    reporterName: text("reporter_name"),
    address: text("address"),
    confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
    locale: text("locale"),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status", { enum: ["open", "actioned", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedAt: timestamp("resolved_at"),
    outcomeNotice: text("outcome_notice", {
      enum: ["pending", "sent", "withheld", "undeliverable"],
    }),
    outcomeNotifiedAt: timestamp("outcome_notified_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("abuse_reports_status_idx").on(t.status, t.createdAt),
    index("abuse_reports_artifact_idx").on(t.artifactId),
  ],
);

/**
 * Operator suspensions of an artifact or a whole account (plan section 13). At most one is open
 * per target; lifting it sets `lifted_at`. An account suspension also suspends each of the
 * account's artifacts with its own row that points at it, so lifting the account reinstates
 * exactly those.
 */
export const suspensions = sqliteTable(
  "suspensions",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["artifact", "account"] }).notNull(),
    /** Artifact ID or user ID. No foreign key: the history outlives what it points at. */
    targetId: text("target_id").notNull(),
    reason: text("reason", { enum: ABUSE_REASONS }).notNull(),
    /** For an artifact, the state it goes back to when reinstated: `active` or `archived`. */
    previousState: text("previous_state", { enum: ["active", "archived"] }),
    reportId: text("report_id"),
    /** The account suspension this artifact suspension belongs to, if any. */
    parentId: text("parent_id"),
    /** The operator's private note. Never shown to the owner. */
    note: text("note"),
    createdAt: createdAt(),
    liftedAt: timestamp("lifted_at"),
    /**
     * When the artifact was purged or the account deleted; null while it exists. The record is
     * deleted `HISTORY_RETENTION_DAYS` after it (`pruneGoneHistory`).
     */
    targetGoneAt: timestamp("target_gone_at"),
  },
  (t) => [
    uniqueIndex("suspensions_open_target_idx")
      .on(t.kind, t.targetId)
      .where(sql`${t.liftedAt} is null`),
    index("suspensions_parent_idx").on(t.parentId),
    index("suspensions_target_gone_idx")
      .on(t.targetGoneAt)
      .where(sql`${t.targetGoneAt} is not null`),
  ],
);

/**
 * The operator's moderation decisions about an artifact, an account or a brand (suspending and
 * reinstating them), with the statement of reasons sent to the people affected (the account of a
 * personal space, or a workspace's admins): the facts and the ground the operator wrote, whether
 * it followed a notice or the operator's own review, and the state of the email. Written in the
 * batch of the change it explains, in the region of what it is about, with the
 * `moderation_notice` job. No foreign keys: the record outlives what it points at.
 */
export const moderationDecisions = sqliteTable(
  "moderation_decisions",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind", { enum: ["artifact", "account", "brand"] }).notNull(),
    targetId: text("target_id").notNull(),
    /** The owner whose people are told: the account, or the workspace. */
    ownerId: text("owner_id").notNull(),
    action: text("action", { enum: ["suspend", "reinstate"] }).notNull(),
    reason: text("reason", { enum: ABUSE_REASONS }),
    suspensionId: text("suspension_id"),
    reportId: text("report_id"),
    source: text("source", { enum: ["notice", "review"] }).notNull(),
    facts: text("facts").notNull(),
    ground: text("ground"),
    /**
     * `pending` until the job sends it; `sent` to at least one person, `no_recipient` when no
     * one could be told (no account, suppressed addresses), `withheld` by the operator where the
     * law requires silence.
     */
    notice: text("notice", { enum: ["pending", "sent", "no_recipient", "withheld"] }).notNull(),
    recipients: integer("recipients").notNull().default(0),
    notifiedAt: timestamp("notified_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("moderation_decisions_target_idx").on(t.targetKind, t.targetId, t.createdAt),
    index("moderation_decisions_suspension_idx").on(t.suspensionId),
  ],
);

/** Each person a statement of reasons was sent to, and when: the operator's proof of sending. */
export const moderationNoticeSends = sqliteTable(
  "moderation_notice_sends",
  {
    decisionId: text("decision_id").notNull(),
    userId: text("user_id").notNull(),
    sentAt: timestamp("sent_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.userId] })],
);

/**
 * Legal holds (docs/operations.md, "Legal holds"): an artifact the operator must preserve for an
 * authority. While a hold is open (`released_at` null) the artifact stays suspended, nothing
 * deletes it, moves it or prunes its versions, and its content is served to nobody, its owner
 * included; triggers back the services (`legal_holds` migration). Set, listed and released only
 * with the operator tool; `export-tombstones` carries every hold across a restore. `owner_email`
 * is the account's address when the hold was set (null for a workspace), kept until release.
 */
export const legalHolds = sqliteTable(
  "legal_holds",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    ownerId: text("owner_id").notNull(),
    ownerEmail: text("owner_email"),
    /** The suspension's category when the hold was set, to suspend again after a restore. */
    reason: text("reason", { enum: ABUSE_REASONS }).notNull(),
    /** The legal ground, written by the operator; never shown to the owner. */
    ground: text("ground").notNull(),
    createdAt: createdAt(),
    /** When the hold is planned to end; the maintenance scan releases it then. */
    releaseAt: timestamp("release_at"),
    releasedAt: timestamp("released_at"),
  },
  (t) => [
    uniqueIndex("legal_holds_open_artifact_idx")
      .on(t.artifactId)
      .where(sql`${t.releasedAt} is null`),
    index("legal_holds_release_idx").on(t.releasedAt, t.releaseAt),
  ],
);

/**
 * Who a legal hold keeps (docs/operations.md, "Legal holds"): the owner account, the account or
 * token that created the artifact and the publisher of each of its committed versions, with the
 * account's email when the hold was set (null for a token or an account already gone). Kept with
 * the hold in the artifact's region, deleted at release, never in an export; a restore captures
 * them again (`applyLegalHolds`).
 */
export const legalHoldIdentities = sqliteTable(
  "legal_hold_identities",
  {
    holdId: text("hold_id").notNull(),
    role: text("role", { enum: ["owner", "creator", "publisher"] }).notNull(),
    /** The version a publisher published; empty for the owner and the creator. */
    versionId: text("version_id").notNull().default(""),
    actorId: text("actor_id").notNull(),
    email: text("email"),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.holdId, t.role, t.versionId, t.actorId] })],
);

/**
 * An artifact's document database (decision 0026): the numbers every envelope to its object
 * carries, and the newest storage report a caller received (`newerReport`). The object is the
 * authority on the data; this row is what D1 knows, raised by fences (`epoch`) and committed
 * erases (`generation`), and reconciled from the object after a restore. A row exists only for an
 * artifact whose object may hold something, and goes with the artifact (its purge writes the
 * `data_erase` job from it in the same batch).
 */
export const artifactData = sqliteTable("artifact_data", {
  artifactId: text("artifact_id")
    .primaryKey()
    .references(() => artifacts.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(0),
  epoch: integer("epoch").notNull().default(0),
  documentsBytes: integer("documents_bytes").notNull().default(0),
  reportGeneration: integer("report_generation").notNull().default(0),
  reportSeq: integer("report_seq").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * The owner side's data operations (decision 0026, delivery 5): one per caller and idempotency
 * key, holding the operation ID the object records the change under (its issue time included),
 * so a retry after a lost answer sends the same ID and the object applies the change once. It
 * holds no body and no answer: a retry is authorized again and answered from the object. Written
 * by one guarded statement on the artifact's owner, state, hold and data numbers, which is the
 * D1 claim every owner-side change makes before it reaches the object; pruned after a day.
 */
export const dataOperations = sqliteTable(
  "data_operations",
  {
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    opId: text("op_id").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.idempotencyKey] }),
    index("data_operations_created_idx").on(t.createdAt),
    index("data_operations_artifact_idx").on(t.artifactId),
  ],
);

/** What the data reconciliation decided about an object, for the operator (`data-findings`). */
export const DATA_FINDING_ACTIONS = [
  "quarantined",
  "raised",
  "resumed_erase",
  "awaiting_operator",
  "identity_mismatch",
  "superseded",
  "adopted",
  "erased",
  "refused",
] as const;

/**
 * Reconciliation's findings after a restore and the operator's resolutions (decision 0026,
 * "Restore"): one row per artifact the walk of the inventory found something to say about. No
 * foreign key: an object without a D1 row is exactly what it reports.
 */
export const dataFindings = sqliteTable("data_findings", {
  artifactId: text("artifact_id").primaryKey(),
  action: text("action", { enum: DATA_FINDING_ACTIONS }).notNull(),
  /** The quarantine's reason, or the refusal's code. */
  reason: text("reason"),
  /**
   * The quarantined state the operator reviews and resolves against (`formatReviewed`), or null
   * when the object is not quarantined.
   */
  state: text("state"),
  firstSeenAt: timestamp("first_seen_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});

/**
 * Grants of artifact data (decision 0026, "The grant"): one person's consent, in one browser, that
 * an artifact's page may know them by `visitor_id` (claimed in the author journal, the same for
 * every grant of the person on the artifact) and their display name and write as them. The
 * content Worker renews its cookie's claims against this row every 60 seconds, so revoking it,
 * signing out of the app session that gave it (`auth_session_id`, global, no foreign key) or
 * losing access ends it within that time. A revocation writes a `data_grant` window tombstone, so
 * a restore never revives it. Rows go 30 days after they ended (`pruneDataGrants`).
 */
export const dataGrants = sqliteTable(
  "data_grants",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The account; no foreign key (users are global). Account deletion deletes the rows. */
    userId: text("user_id").notNull(),
    visitorId: text("visitor_id").notNull(),
    authSessionId: text("auth_session_id").notNull(),
    /** The host the grant was issued for: the `.dev` host or the active custom host. */
    host: text("host").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    /** Set once a code redeemed: a grant whose code never redeemed gives nothing. */
    redeemedAt: timestamp("redeemed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("data_grants_user_artifact_idx").on(t.userId, t.artifactId),
    index("data_grants_artifact_idx").on(t.artifactId),
    index("data_grants_expires_idx").on(t.expiresAt),
    // The prune's other two selections (`pruneDataGrants`), each led by its own time.
    index("data_grants_revoked_idx").on(t.revokedAt).where(sql`${t.revokedAt} is not null`),
    index("data_grants_unredeemed_idx").on(t.createdAt).where(sql`${t.redeemedAt} is null`),
  ],
);

/**
 * One-use codes that carry a grant from the app's control to the artifact origin: only the
 * SHA-256 of the code and of the beginning browser's nonce are stored, bound to the host. The
 * guarded update that sets `used_at` is the redemption.
 */
export const dataGrantCodes = sqliteTable(
  "data_grant_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => dataGrants.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    host: text("host").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("data_grant_codes_expires_idx").on(t.expiresAt),
    index("data_grant_codes_grant_idx").on(t.grantId),
  ],
);

/**
 * Accounts being deleted. The request deletes the user (and with it every session, token and
 * identity) and claims the artifacts for purging at once; the maintenance job then purges the
 * artifacts, erases the account's comments on other people's artifacts in small batches and,
 * when nothing is left, replaces this row with an `account` tombstone.
 */
export const accountDeletions = sqliteTable("account_deletions", {
  userId: text("user_id").primaryKey(),
  requestedAt: timestamp("requested_at").notNull(),
  /**
   * When a run last found it still pending; runs take the least recently tried first, so a
   * deletion that waits (a legal hold on one of its artifacts) never stops the others.
   */
  attemptedAt: timestamp("attempted_at"),
});

/**
 * The account deletion code (docs/security.md, "Identity"): one live code per account, emailed
 * to its address so a person who will not accept new terms can prove they hold the account and
 * delete it without a sign-in. Only a keyed hash of the code is stored. It is bound to the
 * account and to the session that asked for it, and goes with either by cascade; it is spent by
 * the statement that matches it, and a wrong attempt counts. Better Auth never reads this table,
 * so the code can never sign anyone in.
 */
export const accountDeletionCodes = sqliteTable(
  "account_deletion_codes",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("account_deletion_codes_session_idx").on(t.sessionId),
    index("account_deletion_codes_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Annotation threads (plan section 8). A thread points at one immutable version and a target;
 * it never moves when a new version is published. Visitors see only the threads of the
 * artifact's current version; the others are the owner's history. The author always comes
 * from the session or token.
 */
export const annotationThreads = sqliteTable(
  "annotation_threads",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** No foreign key: an expired version is deleted, and its threads keep their quotes. */
    versionId: text("version_id").notNull(),
    /** The artifact's owner, whose annotation quota this thread uses. */
    ownerId: text("owner_id").notNull(),
    /** No foreign key, so deleting an account is never blocked by its comments. */
    authorId: text("author_id").notNull(),
    /** `AnnotationTarget` JSON, validated at the boundary. Untrusted data. */
    target: text("target").notNull(),
    targetBytes: integer("target_bytes").notNull(),
    path: text("path").notNull(),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    /** Messages in the thread, deleted markers included. */
    messageCount: integer("message_count").notNull().default(0),
    /** Bumped on every change to the thread or its messages, for optimistic concurrency. */
    revision: integer("revision").notNull().default(1),
    /** ID of the last `annotation_events` row that changed the thread: the refresh cursor. */
    changeSeq: integer("change_seq").notNull().default(0),
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: text("resolved_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    // Edit suggestions (decision 0027), added with `alter table add column`, so their rules are
    // triggers (`0078_edit_suggestions_triggers.sql`), not CHECK constraints: a comment carries
    // none of them, a suggestion always has a state, its edit never changes once submitted (only
    // a withdrawal clears it) and `edit_bytes` is the edit's UTF-8 size, counted in the owner's
    // annotation bytes like the target.
    kind: text("kind", { enum: SUGGESTION_THREAD_KINDS }).notNull().default("comment"),
    suggestionState: text("suggestion_state", { enum: SUGGESTION_STATES }),
    /** The submitted `Edit` JSON, validated at the boundary. Untrusted data. */
    edit: text("edit"),
    editBytes: integer("edit_bytes").notNull().default(0),
    /**
     * The proof data of each planned operation (`Proof[]` JSON, decision 0027, "Suggestions and
     * new versions"), in UTF-16 units of the stored file; never exported or shown.
     */
    editProofs: text("edit_proofs"),
    /** Bumped on every change of the suggestion, apart from the thread's own `revision`. */
    suggestionRevision: integer("suggestion_revision").notNull().default(0),
    /** The running acceptance (`acceptance_attempts.id`) while `applying`. */
    attemptId: text("attempt_id"),
    /** Why the last attempt ended without accepting, shown when the suggestion is back to pending. */
    attemptReason: text("attempt_reason", { enum: ACCEPTANCE_END_REASONS }),
    /** Who accepted or rejected it; no foreign key, cleared when the account is deleted. */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    /** The version an acceptance produced; null for an acceptance that applied nothing. */
    resultVersionId: text("result_version_id"),
    /** Where a carried suggestion was made: its first version and target, kept on every carry. */
    originVersionId: text("origin_version_id"),
    originTarget: text("origin_target"),
  },
  (t) => [
    index("annotation_threads_artifact_version_state_idx").on(
      t.artifactId,
      t.versionId,
      t.state,
      t.createdAt,
    ),
    index("annotation_threads_artifact_change_idx").on(t.artifactId, t.changeSeq),
    index("annotation_threads_author_idx").on(t.authorId),
    // Who resolved a thread, forgotten when the account is deleted (`eraseAccountTraces`).
    index("annotation_threads_resolved_by_idx")
      .on(t.resolvedBy)
      .where(sql`${t.resolvedBy} is not null`),
    // A space's open feedback: an owner's open threads, newest activity first.
    index("annotation_threads_owner_state_updated_idx").on(t.ownerId, t.state, t.updatedAt, t.id),
    // Undecided suggestions of an artifact, for the carry job a publish writes (decision 0027).
    index("annotation_threads_artifact_suggestion_idx")
      .on(t.artifactId, t.suggestionState)
      .where(sql`${t.kind} = 'suggestion'`),
    // Who decided a suggestion, forgotten when the account is deleted (`eraseAccountTraces`).
    index("annotation_threads_decided_by_idx")
      .on(t.decidedBy)
      .where(sql`${t.decidedBy} is not null`),
    check("annotation_threads_target_bytes", sql`${t.targetBytes} between 1 and 8192`),
    check(
      "annotation_threads_counters",
      sql`${t.messageCount} >= 0 and ${t.messageCount} <= 200 and ${t.revision} >= 1`,
    ),
  ],
);

/** Messages of a thread. Deleting one keeps a marker so replies keep their place. */
export const annotationMessages = sqliteTable(
  "annotation_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => annotationThreads.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    ownerId: text("owner_id").notNull(),
    authorId: text("author_id").notNull(),
    /** Plain text, untrusted. Null once the message is deleted. */
    body: text("body"),
    bodyBytes: integer("body_bytes").notNull(),
    state: text("state", { enum: ["visible", "hidden", "deleted"] })
      .notNull()
      .default("visible"),
    revision: integer("revision").notNull().default(1),
    editedAt: timestamp("edited_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("annotation_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("annotation_messages_author_idx").on(t.authorId),
    check("annotation_messages_body_bytes", sql`${t.bodyBytes} between 0 and 8192`),
    check("annotation_messages_deleted_body", sql`(${t.state} = 'deleted') = (${t.body} is null)`),
  ],
);

/**
 * Every annotation write and moderation action, without bodies. The autoincrement ID orders
 * changes for incremental refresh, deleted threads are reported from here, and recent writes
 * per author and per artifact are counted from here for the rate limits.
 */
export const annotationEvents = sqliteTable(
  "annotation_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** No foreign key: a deleted thread's event stays as its tombstone. */
    threadId: text("thread_id").notNull(),
    messageId: text("message_id"),
    actorId: text("actor_id").notNull(),
    /**
     * Unique per request. A write claims its change by inserting this event under every guard,
     * and the rest of the batch runs only if the event with its `write_id` exists, so a retried
     * or concurrent request cannot apply the same effects twice.
     */
    writeId: text("write_id").notNull(),
    kind: text("kind", {
      enum: [
        "thread_created",
        "message_created",
        "message_edited",
        "message_deleted",
        "message_hidden",
        "message_unhidden",
        "message_removed",
        "thread_resolved",
        "thread_reopened",
        "thread_deleted",
      ],
    }).notNull(),
    at: timestamp("at").notNull(),
  },
  (t) => [
    uniqueIndex("annotation_events_write_idx").on(t.writeId),
    index("annotation_events_artifact_id_idx").on(t.artifactId, t.id),
    index("annotation_events_actor_at_idx").on(t.actorId, t.at),
    index("annotation_events_artifact_at_idx").on(t.artifactId, t.at),
    // Threads a reader with the `own` comment scope sees, by who created them: the refresh of
    // every such reader (the default) looks them up on each poll.
    index("annotation_events_artifact_kind_actor_idx").on(
      t.artifactId,
      t.kind,
      t.actorId,
      t.threadId,
    ),
  ],
);

/**
 * Comment activity waiting for a notice (packages/services/src/comment-notices.ts): one row per
 * recipient and thread, written in the batch of the comment, reply or resolution that caused it,
 * and only when the artifact owner's plan includes comment notices. It holds counts and IDs,
 * never text. The scheduled scan turns a recipient's rows into one `comment_notice` outbox job and
 * deletes them in the same batch. Rows go with their thread and artifact by the foreign keys, and
 * with the recipient's account in the deletion batches (`recipient_id` has no foreign key: users
 * are global, comments regional).
 */
export const commentNotices = sqliteTable(
  "comment_notices",
  {
    recipientId: text("recipient_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => annotationThreads.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** 1 when the thread itself is new. */
    created: integer("created").notNull().default(0),
    replies: integer("replies").notNull().default(0),
    /** 1 when the thread was resolved. */
    resolved: integer("resolved").notNull().default(0),
    /** When the first activity of the row happened; the notice waits for it to settle. */
    firstAt: timestamp("first_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recipientId, t.threadId] }),
    index("comment_notices_recipient_first_idx").on(t.recipientId, t.firstAt),
    index("comment_notices_first_idx").on(t.firstAt),
    check(
      "comment_notices_counts",
      sql`${t.created} in (0, 1) and ${t.resolved} in (0, 1) and ${t.replies} between 0 and 200`,
    ),
  ],
);

/**
 * Approval reviews (premium plan T6, decision 0013; not review mode, which is the commenting
 * session): an admin or editor of the owner asks named people to review the artifact's current
 * version. At most one open request per artifact (partial unique index); a cancelled one stays,
 * with its verdicts, as history. `version_id` is the version under review: publish and rollback
 * move it to the new version in the batch of their switch, so verdicts given on the old one stay
 * its history and the request starts again with none. `announced` is the completed status already
 * told for that version, so a notice goes once. Rows go with their artifact by the foreign key.
 */
export const reviewRequests = sqliteTable(
  "review_requests",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** No foreign key: an expired version is deleted, and its verdicts keep pointing at it. */
    versionId: text("version_id").notNull(),
    /** Approvals that decide it; null means every reviewer. */
    required: integer("required"),
    /** Whether other people who can open the artifact see the overall status. */
    showStatus: integer("show_status", { mode: "boolean" }).notNull().default(false),
    /** Who asked (a user or a service token); no foreign key, cleared by account deletion. */
    requestedBy: text("requested_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    /** Bumped by every change, verdicts included, for optimistic concurrency. */
    revision: integer("revision").notNull().default(1),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason", { enum: ["cancelled", "transferred"] }),
    announced: text("announced", { enum: ["approved", "changes_requested"] }),
    /** When the maintenance scan last re-checked who can still open the artifact. */
    checkedAt: timestamp("checked_at").notNull().default(0),
  },
  (t) => [
    uniqueIndex("review_requests_open_idx").on(t.artifactId).where(sql`${t.cancelledAt} is null`),
    index("review_requests_artifact_idx").on(t.artifactId, t.createdAt),
    index("review_requests_checked_idx").on(t.cancelledAt, t.checkedAt),
    index("review_requests_requested_by_idx").on(t.requestedBy),
    check("review_requests_required", sql`${t.required} is null or ${t.required} between 1 and 10`),
    check(
      "review_requests_cancelled",
      sql`(${t.cancelledAt} is null) = (${t.cancelReason} is null)`,
    ),
  ],
);

/**
 * The people a request names, by email address (lowercase), matched to accounts by verified
 * address like the reader list. `dropped_at` is set while the address can no longer open the
 * artifact (checked when it is added, on every verdict and by the maintenance scan); a dropped
 * reviewer does not count toward the status.
 */
export const reviewReviewers = sqliteTable(
  "review_reviewers",
  {
    requestId: text("request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    addedAt: timestamp("added_at").notNull(),
    droppedAt: timestamp("dropped_at"),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.email] }),
    index("review_reviewers_email_idx").on(t.email),
  ],
);

/**
 * Verdicts, one per reviewer and version: the current one decides the status, earlier ones are
 * history. `author_id` is the account that gave it (no foreign key: users are global); account
 * deletion deletes the account's verdicts. The note is untrusted plain text, never logged.
 */
export const reviewVerdicts = sqliteTable(
  "review_verdicts",
  {
    requestId: text("request_id")
      .notNull()
      .references(() => reviewRequests.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    versionId: text("version_id").notNull(),
    authorId: text("author_id").notNull(),
    verdict: text("verdict", { enum: ["approve", "changes"] }).notNull(),
    note: text("note"),
    noteBytes: integer("note_bytes").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.email, t.versionId] }),
    index("review_verdicts_author_idx").on(t.authorId),
    check("review_verdicts_note_bytes", sql`${t.noteBytes} between 0 and 4096`),
  ],
);

/**
 * Review emails already sent (decision 0013, "Emails"): one row per artifact, version, recipient
 * and kind (`requested` to a reviewer, `completed` to the owner side), claimed before the send
 * and deleted again when the send fails, so each person gets at most one of each per version.
 * Goes with the version and the artifact (foreign keys); `recipient_id` has no foreign key (users
 * are global), so both account deletion batches delete the account's rows.
 */
export const reviewNotices = sqliteTable(
  "review_notices",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id").notNull(),
    kind: text("kind", { enum: ["requested", "completed"] }).notNull(),
    sentAt: timestamp("sent_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.versionId, t.recipientId, t.kind] }),
    index("review_notices_recipient_idx").on(t.recipientId),
    index("review_notices_version_idx").on(t.versionId),
  ],
);

/** Formats a webhook delivers in (decision 0009). */
export const WEBHOOK_FORMATS = ["generic", "slack", "discord"] as const;
/** Why a webhook stopped: an admin, repeated failures, a 410 from the receiver, or a URL that no longer passes. */
export const WEBHOOK_DISABLED_REASONS = [
  "manual",
  "failures",
  "gone",
  "invalid_url",
  "key_unavailable",
  "unavailable",
] as const;

/**
 * Webhooks of an owner (decision 0009, packages/services/src/webhooks.ts): HTTPS destinations
 * that receive events about every artifact of the owner. The URL and the signing secret are
 * sealed with a key derived from `WEBHOOK_KEY` (`key_id` names it); only the host is kept in
 * clear. `events` is a bit set of `WEBHOOK_EVENT_BITS`. `owner_id` has no foreign key (an owner
 * is a user or a workspace): account deletion deletes the rows, and removing one writes a
 * `webhook` tombstone so a restore cannot bring it back.
 */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    host: text("host").notNull(),
    format: text("format", { enum: WEBHOOK_FORMATS }).notNull(),
    events: integer("events").notNull(),
    keyId: text("key_id").notNull(),
    urlBox: text("url_box").notNull(),
    secretBox: text("secret_box"),
    createdAt: createdAt(),
    disabledAt: timestamp("disabled_at"),
    disabledReason: text("disabled_reason", { enum: WEBHOOK_DISABLED_REASONS }),
    /** Failed attempts in a row; reset by a success and by enabling the webhook again. */
    failures: integer("failures").notNull().default(0),
    /** Enabled again after a disable: a few failures disable it again until one success. */
    probation: integer("probation", { mode: "boolean" }).notNull().default(false),
    /** Times it was enabled again on `reenable_day` (a UTC day start). */
    reenables: integer("reenables").notNull().default(0),
    reenableDay: timestamp("reenable_day"),
    /** Who created it (no foreign key: cleared when the account is deleted). */
    createdBy: text("created_by"),
    /** `dashboard`, or the OAuth client that created it (the Portifact CLI). */
    createdVia: text("created_via").notNull(),
  },
  (t) => [
    index("webhooks_owner_idx").on(t.ownerId),
    // Every bit of WEBHOOK_EVENTS (seven types; widened from 31 by `webhook_review_events`).
    check("webhooks_events", sql`${t.events} between 1 and 127`),
    check("webhooks_failures", sql`${t.failures} >= 0`),
  ],
);

/**
 * Events waiting for a webhook's next delivery: one row per webhook, artifact (empty for the test
 * event) and type, written in the batch of the write that caused it and coalesced there. Counts,
 * times and IDs only, never text. The delivery job claims rows by subtracting what it sent.
 */
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id").notNull(),
    type: text("type").notNull(),
    count: integer("count").notNull(),
    firstAt: timestamp("first_at").notNull(),
    lastAt: timestamp("last_at").notNull(),
    /** The user who acted, while every write of the row was by one person on the owner side. */
    actorId: text("actor_id"),
    version: integer("version"),
    access: text("access"),
    expiresAt: timestamp("expires_at"),
    /**
     * Review events: the status and counts (`ApprovalSummary`) when the event last happened, as
     * JSON. Never a reviewer's name or address, never a note.
     */
    review: text("review"),
  },
  (t) => [
    primaryKey({ columns: [t.webhookId, t.artifactId, t.type] }),
    index("webhook_events_first_idx").on(t.webhookId, t.firstAt),
  ],
);

/**
 * The delivery log of the last 7 days: one row per attempt (and per daily-cap deferral), with the
 * outcome and the HTTP status, never the body or the response. Pruned by the maintenance run.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    attempt: integer("attempt").notNull(),
    at: timestamp("at").notNull(),
    outcome: text("outcome", { enum: ["delivered", "failed", "skipped"] }).notNull(),
    status: integer("status"),
    error: text("error"),
  },
  (t) => [
    index("webhook_deliveries_webhook_idx").on(t.webhookId, t.at),
    index("webhook_deliveries_owner_idx").on(t.ownerId, t.at),
    index("webhook_deliveries_at_idx").on(t.at),
  ],
);

/** Services an issue integration reaches, as in @portifact/contracts (decision 0018). */
export const INTEGRATION_SERVICES = ["github", "linear", "jira"] as const;
/** Services a connection reaches: the issue trackers and Slack (decision 0025). */
export const CONNECTION_SERVICES = [...INTEGRATION_SERVICES, "slack"] as const;

/**
 * An owner's connections to GitHub Issues, Linear or Jira Cloud (decision 0018,
 * packages/services/src/integrations.ts). The credential an admin pasted is sealed with a key
 * derived from `INTEGRATIONS_KEY` (`key_id` names it) and shown only as `credential_hint`, its
 * last four characters; `identity` is what the service reported the credential acts as.
 * `targets` is the `IntegrationTarget[]` JSON of the allowed repositories or teams. Regional with
 * the owner's other data; `owner_id` has no foreign key (an owner is a user or a workspace), so
 * account and workspace deletion delete the rows, and removing one writes an
 * `integration_connection` tombstone so a restore cannot bring the credential back.
 */
export const integrationConnections = sqliteTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service", { enum: CONNECTION_SERVICES }).notNull(),
    label: text("label").notNull(),
    keyId: text("key_id").notNull(),
    credentialBox: text("credential_box").notNull(),
    credentialHint: text("credential_hint").notNull(),
    identity: text("identity").notNull(),
    targets: text("targets").notNull(),
    /**
     * Set when the service refused the credential or no key opens it: issues stop until fixed.
     * `pending` is a Slack connection started and not completed (decision 0025): it holds no
     * credential (`key_id` and `credential_box` empty, which no key opens) and is deleted after
     * 24 hours; `app_uninstalled` is Slack telling that the app was uninstalled.
     */
    attention: text("attention", {
      enum: [
        "credential_rejected",
        "key_unavailable",
        "site_mismatch",
        "app_uninstalled",
        "pending",
      ],
    }),
    attentionAt: timestamp("attention_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    /** Who connected it (no foreign key: cleared when the account is deleted). */
    createdBy: text("created_by"),
    /**
     * Jira only (decision 0018, "Jira"): the site's name (`acme` for `acme.atlassian.net`), which
     * builds issue links and is never called, and its cloud ID, which names the site on the fixed
     * Atlassian gateway. Both checked against the gateway's `serverInfo`; null for other services.
     */
    site: text("site"),
    cloudId: text("cloud_id"),
    /**
     * Slack only (decision 0025): the Slack workspace's ID (`team_id` from `auth.test`), compared
     * with every event, and the manifest version the connection was completed with.
     */
    externalId: text("external_id"),
    manifestVersion: integer("manifest_version"),
  },
  (t) => [
    index("integration_connections_owner_idx").on(t.ownerId),
    check("integration_connections_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * Issues created from comment threads (decision 0018): the request, which the `thread_issue`
 * outbox job sends, and once created the link the thread shows (service, target, key and URL,
 * nothing else). The title is the person's own words and is cleared once the issue exists; the
 * comment text is never stored here, the job reads it from the thread when it sends. Goes with
 * the thread and the artifact. `requested_by` has no foreign key and is cleared when the account
 * is deleted; `(requested_by, idempotency_key)` makes a retried request the same request.
 */
export const threadIssues = sqliteTable(
  "thread_issues",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => annotationThreads.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    /** No foreign key: a removed connection fails the requests still pending and keeps the links. */
    connectionId: text("connection_id").notNull(),
    service: text("service", { enum: INTEGRATION_SERVICES }).notNull(),
    /** `owner/repo` or a Linear team ID. */
    target: text("target").notNull(),
    /** What the thread shows: the repository, or the team's name. */
    targetName: text("target_name").notNull(),
    requestedBy: text("requested_by"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** The request's claim: the outbox job and nothing else are written only on this row. */
    writeId: text("write_id").notNull(),
    includeLink: integer("include_link", { mode: "boolean" }).notNull(),
    includeName: integer("include_name", { mode: "boolean" }).notNull(),
    includeQuote: integer("include_quote", { mode: "boolean" }).notNull(),
    includeMessage: integer("include_message", { mode: "boolean" }).notNull(),
    title: text("title"),
    state: text("state", { enum: ["pending", "created", "failed"] })
      .notNull()
      .default("pending"),
    failure: text("failure"),
    attempts: integer("attempts").notNull().default(0),
    /** When the attempt in progress started; null between attempts. */
    startedAt: timestamp("started_at"),
    issueKey: text("issue_key"),
    issueUrl: text("issue_url"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    uniqueIndex("thread_issues_request_idx").on(t.requestedBy, t.idempotencyKey),
    uniqueIndex("thread_issues_write_idx").on(t.writeId),
    index("thread_issues_thread_idx").on(t.threadId),
    index("thread_issues_connection_idx").on(t.connectionId, t.state),
    check("thread_issues_attempts", sql`${t.attempts} >= 0`),
  ],
);

/** Artifacts whose comment notices a user turned off. Removed with the artifact, and with the account. */
export const commentNoticeMutes = sqliteTable(
  "comment_notice_mutes",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.userId] }),
    index("comment_notice_mutes_user_idx").on(t.userId),
  ],
);

/**
 * The change list (decision 0027, "The change list"): accepted operations Portifact did not apply,
 * each the canonical envelope the owner side saw and confirmed, for the owner's agent and people.
 * Items are the owner side's work once accepted: they go with the artifact, not with the thread
 * (comment retention clears `thread_id`). `bytes` is the envelope's and the proof's UTF-8 size,
 * counted in the owner's annotation bytes by triggers; envelope and proof never change. At most
 * `CHANGE_ITEMS_OPEN_MAX` are open per artifact: the acceptance claim reserves room for a whole
 * listed set, and a trigger refuses any insert or reopening past it as the database's backstop.
 */
export const changeItems = sqliteTable(
  "change_items",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The artifact's owner, whose annotation bytes the item uses; moved by a transfer. */
    ownerId: text("owner_id").notNull(),
    origin: text("origin", { enum: ["suggestion", "draft"] }).notNull(),
    threadId: text("thread_id").references(() => annotationThreads.id, { onDelete: "set null" }),
    /** The acceptance that listed it; no foreign key, attempts are pruned before items. */
    attemptId: text("attempt_id"),
    /** The version the plan was built on; no foreign key, versions expire and items stay. */
    versionId: text("version_id").notNull(),
    path: text("path").notNull(),
    route: text("route"),
    /** The canonical envelope (`Envelope` JSON), at most 16 KiB. Untrusted reviewer text inside. */
    envelope: text("envelope").notNull(),
    /** The persisted proof data, null when the operation was never located (manual closure only). */
    proof: text("proof"),
    bytes: integer("bytes").notNull(),
    /** Why it was listed (a refusal reason, a lowercase token). */
    reason: text("reason").notNull(),
    state: text("state", { enum: CHANGE_ITEM_STATES }).notNull().default("open"),
    /**
     * The person who accepted it (the envelope's acceptor) and the one who suggested it: account
     * references kept beside the immutable envelope, which holds no names. Shown as their current
     * display names; account erasure clears them, and the envelope then shows "a deleted account".
     * No foreign keys (users are global).
     */
    createdBy: text("created_by"),
    submittedBy: text("submitted_by"),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at"),
    closedBy: text("closed_by"),
    /** The version whose rendered page proved the item, for `closed_by_version`. */
    closedVersionId: text("closed_version_id"),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    index("change_items_artifact_state_idx").on(t.artifactId, t.state, t.createdAt),
    index("change_items_thread_idx").on(t.threadId).where(sql`${t.threadId} is not null`),
    // The retention sweep seeks its cursor on `(closed_at, id)` (decision 0027, migration 0081).
    index("change_items_closed_key_idx").on(t.closedAt, t.id).where(sql`${t.closedAt} is not null`),
    index("change_items_created_by_idx").on(t.createdBy).where(sql`${t.createdBy} is not null`),
    index("change_items_closed_by_idx").on(t.closedBy).where(sql`${t.closedBy} is not null`),
    index("change_items_submitted_by_idx")
      .on(t.submittedBy)
      .where(sql`${t.submittedBy} is not null`),
    check("change_items_origin", sql`${t.origin} in ('suggestion', 'draft')`),
    check(
      "change_items_state",
      sql`${t.state} in ('open', 'applied', 'dismissed', 'closed_by_version')`,
    ),
    check(
      "change_items_bytes",
      sql`${t.bytes} = length(cast(${t.envelope} as blob)) + coalesce(length(cast(${t.proof} as blob)), 0) and length(cast(${t.envelope} as blob)) between 2 and 16384 and coalesce(length(cast(${t.proof} as blob)), 0) <= 16384`,
    ),
    check(
      "change_items_reason",
      sql`length(${t.reason}) between 1 and 64 and ${t.reason} not glob '*[^a-z0-9_]*'`,
    ),
    check("change_items_draft_thread", sql`${t.origin} = 'suggestion' or ${t.threadId} is null`),
    check(
      "change_items_closing",
      sql`case ${t.state}
        when 'open' then ${t.closedAt} is null and ${t.closedBy} is null and ${t.closedVersionId} is null
        when 'closed_by_version' then ${t.closedAt} is not null and ${t.closedBy} is null and ${t.closedVersionId} is not null
        else ${t.closedAt} is not null and ${t.closedVersionId} is null end`,
    ),
    check("change_items_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * The owner side's draft of edits (decision 0027, "The owner's draft"): one per person and
 * artifact, read and changed only by its author, in base coordinates of `base_version_id`. At most
 * 20 per person (a trigger). `attempt_id` is set while a publish of it runs.
 */
export const editDrafts = sqliteTable(
  "edit_drafts",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The author; no foreign key (users are global), deleted with the account. */
    userId: text("user_id").notNull(),
    ownerId: text("owner_id").notNull(),
    baseVersionId: text("base_version_id").notNull(),
    /** The `Edit` JSON of at most 100 operations, validated at the boundary. */
    edit: text("edit").notNull(),
    editBytes: integer("edit_bytes").notNull(),
    revision: integer("revision").notNull().default(1),
    attemptId: text("attempt_id"),
    attemptReason: text("attempt_reason", { enum: ACCEPTANCE_END_REASONS }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    /**
     * A random token of this draft's incarnation, set when the row is created and never reused:
     * a save names it with the revision, so a tab holding a discarded draft never overwrites the
     * one that replaced it, whose revision starts at 1 again (migration 0083).
     */
    incarnation: text("incarnation").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.userId] }),
    index("edit_drafts_user_idx").on(t.userId),
    // Unused drafts only (a publishing one is never due), sought on the full key from a cursor.
    index("edit_drafts_unused_idx")
      .on(t.updatedAt, t.artifactId, t.userId)
      .where(sql`${t.attemptId} is null`),
    check(
      "edit_drafts_bytes",
      sql`${t.editBytes} = length(cast(${t.edit} as blob)) and ${t.editBytes} between 2 and 131072`,
    ),
    check("edit_drafts_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * Patch plans cached by digest for 10 minutes (decision 0027, "Binding and confirmation"), per
 * person: a cached plan is re-verified by its contents before anything uses it. It is a cache:
 * deleting a row only costs a new plan.
 */
export const suggestionPlans = sqliteTable(
  "suggestion_plans",
  {
    userId: text("user_id").notNull(),
    digest: text("digest").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The suggestion it plans, or null for a draft or an unsaved edit. */
    threadId: text("thread_id").references(() => annotationThreads.id, { onDelete: "cascade" }),
    /** The plan JSON, at most 512 KiB. */
    plan: text("plan").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.digest] }),
    index("suggestion_plans_expires_idx").on(t.expiresAt),
    index("suggestion_plans_artifact_idx").on(t.artifactId),
    index("suggestion_plans_thread_idx").on(t.threadId).where(sql`${t.threadId} is not null`),
    check(
      "suggestion_plans_digest",
      sql`length(${t.digest}) = 64 and ${t.digest} not glob '*[^0-9a-f]*'`,
    ),
    check("suggestion_plans_bytes", sql`length(cast(${t.plan} as blob)) <= 524288`),
  ],
);

/**
 * One acceptance of a suggestion or publish of a draft (decision 0027, "Producing the new
 * version"): the route writes it with the outbox job, the job keys the pending version by it, and
 * the scan ends it after 3 deliveries or 30 minutes. Kept 30 days with its claim.
 */
export const acceptanceAttempts = sqliteTable(
  "acceptance_attempts",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    origin: text("origin", { enum: ["suggestion", "draft"] }).notNull(),
    threadId: text("thread_id").references(() => annotationThreads.id, { onDelete: "set null" }),
    /** The accepting person (the draft's author for a draft); cleared when the account goes. */
    userId: text("user_id"),
    /** The plan's digest the person confirmed. */
    digest: text("digest").notNull(),
    baseVersionId: text("base_version_id").notNull(),
    /** The pending version the job created for this attempt, once it did. */
    versionId: text("version_id"),
    state: text("state", { enum: ["running", "done", "ended"] })
      .notNull()
      .default("running"),
    reason: text("reason", { enum: ACCEPTANCE_END_REASONS }),
    deliveries: integer("deliveries").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    index("acceptance_attempts_state_updated_idx").on(t.state, t.updatedAt),
    // The scans read only what they return (decision 0027): attempts running too long, running
    // too often, and finished ones past their retention, each by its own index.
    index("acceptance_attempts_running_created_idx")
      .on(t.createdAt)
      .where(sql`${t.state} = 'running'`),
    index("acceptance_attempts_running_deliveries_idx")
      .on(t.deliveries)
      .where(sql`${t.state} = 'running'`),
    index("acceptance_attempts_finished_created_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.state} <> 'running'`),
    index("acceptance_attempts_artifact_idx").on(t.artifactId),
    index("acceptance_attempts_thread_idx").on(t.threadId).where(sql`${t.threadId} is not null`),
    index("acceptance_attempts_user_idx").on(t.userId).where(sql`${t.userId} is not null`),
    check(
      "acceptance_attempts_digest",
      sql`length(${t.digest}) = 64 and ${t.digest} not glob '*[^0-9a-f]*'`,
    ),
    check("acceptance_attempts_reason", sql`(${t.state} = 'ended') = (${t.reason} is not null)`),
    check("acceptance_attempts_deliveries", sql`${t.deliveries} >= 0`),
  ],
);

/**
 * The acceptance claim (decision 0027, "The acceptance claim"): the first statement of the commit
 * batch inserts it, with a token unique to that run, only when the change list has room and the
 * suggestion or draft and the base version are as confirmed; every later statement is conditioned
 * on a claim with that token, so a competing insertion or a duplicate delivery changes nothing.
 */
export const acceptanceClaims = sqliteTable(
  "acceptance_claims",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .references(() => acceptanceAttempts.id, { onDelete: "cascade" }),
    runToken: text("run_token").notNull(),
    artifactId: text("artifact_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("acceptance_claims_created_idx").on(t.createdAt)],
);

/**
 * One-use codes for built previews on `preview.portifact.dev` (decision 0027, "Previews"): only
 * the code's SHA-256 is stored, with who it was minted for, their dashboard session (no foreign
 * key: sessions are global) and the built document's key in the internal cache. Redeemed once by a
 * guarded update; at most 10 open per person (a trigger).
 */
export const previewCodes = sqliteTable(
  "preview_codes",
  {
    codeSha256: text("code_sha256").primaryKey(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => annotationThreads.id, { onDelete: "cascade" }),
    /** The built document in R2, under `previews/`. */
    r2Key: text("r2_key").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at").notNull(),
    redeemedAt: timestamp("redeemed_at"),
  },
  (t) => [
    index("preview_codes_user_idx").on(t.userId, t.expiresAt),
    index("preview_codes_expires_idx").on(t.expiresAt),
    index("preview_codes_artifact_idx").on(t.artifactId),
    check(
      "preview_codes_code",
      sql`length(${t.codeSha256}) = 64 and ${t.codeSha256} not glob '*[^0-9a-f]*'`,
    ),
    check("preview_codes_key", sql`${t.r2Key} like 'previews/%'`),
    check("preview_codes_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Annotation usage per artifact owner: live messages and logical bytes (message bodies plus
 * thread targets). Triggers in `0007_annotation_usage_triggers.sql` keep it exact on every
 * insert, update and delete, cascades included, and the CHECK constraints refuse a write past
 * the limits even when the application misses a race.
 */
export const annotationUsage = sqliteTable(
  "annotation_usage",
  {
    ownerId: text("owner_id").primaryKey(),
    messages: integer("messages").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    /**
     * The owner's limits, compared by the CHECK constraints below. The defaults are the free plan
     * (ANNOTATION_LIMITS.messagesPerOwner and bytesPerOwner in contracts; a test fails if they
     * drift).
     */
    messagesLimit: integer("messages_limit").notNull().default(5000),
    bytesLimit: integer("bytes_limit").notNull().default(50_000_000),
  },
  (t) => [
    check("annotation_usage_nonnegative", sql`${t.messages} >= 0 and ${t.bytes} >= 0`),
    check(
      "annotation_usage_limits_nonnegative",
      sql`${t.messagesLimit} >= 0 and ${t.bytesLimit} >= 0`,
    ),
    check("annotation_usage_messages_limit", sql`${t.messages} <= ${t.messagesLimit}`),
    check("annotation_usage_bytes_limit", sql`${t.bytes} <= ${t.bytesLimit}`),
  ],
);

/** Budget levels and protection actions; the rules that use them live in packages/domain/src/budget.ts. */
export const BUDGET_LEVELS = ["none", "alert25", "alert50", "slow75", "protect100"] as const;

/**
 * The platform's budget state (plan section 12): one row, written by the jobs Worker every run with
 * the cycle's metrics, projected spend and automatic protection, and by the operator tool for an
 * override. Services read it to enforce protection; nothing else writes it.
 */
export const platformBudget = sqliteTable(
  "platform_budget",
  {
    id: text("id").primaryKey().default("global"),
    /** Start of the cycle the metrics belong to (calendar month in UTC). */
    cycleStart: timestamp("cycle_start").notNull(),
    /** Automatic level and actions (a JSON array of protection actions) from the last run. */
    level: text("level", { enum: BUDGET_LEVELS }).notNull().default("none"),
    actions: text("actions").notNull().default("[]"),
    projectedCents: integer("projected_cents").notNull().default(0),
    /** The last measured metrics (JSON) and whether Cloudflare's analytics contributed to them. */
    metrics: text("metrics").notNull(),
    analytics: text("analytics", { enum: ["off", "ok", "failed"] })
      .notNull()
      .default("off"),
    measuredAt: timestamp("measured_at").notNull(),
    /** When the automatic level or actions last changed. */
    levelChangedAt: timestamp("level_changed_at").notNull(),
    /** Operator override: replaces the automatic decision until `override_until` (null: cleared by hand). */
    overrideLevel: text("override_level", { enum: BUDGET_LEVELS }),
    overrideSteps: integer("override_steps"),
    overrideUntil: timestamp("override_until"),
    overrideNote: text("override_note"),
    overrideSetAt: timestamp("override_set_at"),
  },
  (t) => [
    check("platform_budget_single_row", sql`${t.id} = 'global'`),
    check(
      "platform_budget_override_steps",
      sql`${t.overrideSteps} is null or ${t.overrideSteps} between 1 and 5`,
    ),
  ],
);

/**
 * Budget alerts for the operator, at most one per kind and cycle: a spend threshold crossed
 * (`spend_25` ... `spend_100`) or a global admission limit reached (`admission_<metric>`).
 * `notified_at` is set once the alert email went out; without email configured it stays null and
 * the operator tool shows the alert.
 */
export const budgetAlerts = sqliteTable(
  "budget_alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cycleStart: timestamp("cycle_start").notNull(),
    kind: text("kind").notNull(),
    level: text("level", { enum: BUDGET_LEVELS }).notNull(),
    projectedCents: integer("projected_cents").notNull(),
    createdAt: timestamp("created_at").notNull(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => [uniqueIndex("budget_alerts_cycle_kind_idx").on(t.cycleStart, t.kind)],
);

/** Why an address is suppressed (contracts: EmailSuppressionReason). */
export const EMAIL_SUPPRESSION_REASONS = ["hard_bounce", "complaint", "provider"] as const;

/**
 * Addresses Portifact does not send sign-in codes to, because their mail bounced permanently or
 * was reported as spam (packages/services/src/email.ts). Keyed by a SHA-256 of the normalized
 * address, never the address itself; `hint` is a masked form (`a***@example.com`) for the
 * operator. Rows end at `expires_at` and the maintenance job prunes them.
 */
export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    emailHash: text("email_hash").primaryKey(),
    hint: text("hint").notNull(),
    reason: text("reason", { enum: EMAIL_SUPPRESSION_REASONS }).notNull(),
    /** The Email Service event that recorded it, when one did. */
    eventId: text("event_id"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("email_suppressions_expires_idx").on(t.expiresAt)],
);

/**
 * Emails sent per UTC day, the platform's email metric for the budget run and the monthly cap of
 * sign-in codes. Aggregate counts only, nothing about recipients.
 */
export const emailCounters = sqliteTable(
  "email_counters",
  {
    day: timestamp("day").primaryKey(),
    sent: integer("sent").notNull().default(0),
  },
  (t) => [check("email_counters_nonnegative", sql`${t.sent} >= 0`)],
);

/**
 * The owner's defaults for new artifacts (packages/domain/src/account-settings.ts), applied when
 * `preparePublish` creates an artifact; existing artifacts never change. It also holds whether the
 * owner gets expiry notices. A missing row means the
 * built-in defaults, the same as the columns' defaults. Removed with the user by the foreign key.
 */
export const accountSettings = sqliteTable(
  "account_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultAccessMode: text("default_access_mode", {
      enum: ["public", "authenticated", "restricted"],
    })
      .notNull()
      .default("restricted"),
    defaultAnnotations: text("default_annotations", { enum: ["off", "open"] })
      .notNull()
      .default("off"),
    defaultCommentVisibility: text("default_comment_visibility", { enum: ["owner", "everyone"] })
      .notNull()
      .default("owner"),
    defaultBar: integer("default_bar", { mode: "boolean" }).notNull().default(true),
    /** Email the owner before their artifacts expire; on unless they turn it off. */
    expiryNotices: integer("expiry_notices", { mode: "boolean" }).notNull().default(true),
    /** Email digests of new comment activity (packages/domain/src/comment-notices.ts); on by default. */
    commentNotices: integer("comment_notices", { mode: "boolean" }).notNull().default(true),
    /**
     * When `comment_notices` last changed. An unsubscribe link issued before it is refused, so an
     * old link never turns the notices off again after the user turned them back on.
     */
    commentNoticesChangedAt: timestamp("comment_notices_changed_at"),
    // The account's language (a code of LOCALES in @portifact/contracts); null follows the
    // browser. No CHECK: adding a language must not need a migration, and reads drop codes
    // that are no longer listed.
    locale: text("locale"),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check(
      "account_settings_access_mode",
      sql`${t.defaultAccessMode} in ('public', 'authenticated', 'restricted')`,
    ),
    check("account_settings_annotations", sql`${t.defaultAnnotations} in ('off', 'open')`),
    check(
      "account_settings_comment_visibility",
      sql`${t.defaultCommentVisibility} in ('owner', 'everyone')`,
    ),
  ],
);

/**
 * How an account accepted a version of the terms (docs/legal.md, "Acceptance at sign-in"):
 * `sign_up` when choosing a sign-in method created the account, `sign_in` when an existing
 * account chose one below the notice, `review` with "Agree and continue" on the login page's
 * review screen, and `backfill` for the acceptance an account held when the history started,
 * whose action was not recorded.
 */
export const TERMS_ACCEPTANCE_ACTIONS = ["sign_up", "sign_in", "review", "backfill"] as const;

/**
 * Every version of the terms each account accepted, with when and how: the evidence of
 * acceptance, kept for the life of the account (it cascades from `users`). `users.terms_version`
 * and `terms_accepted_at` stay the fast path the sign-in hooks read. A row is written by the
 * statement that records the acceptance: the `terms_acceptances_sign_up` trigger on the insert
 * of the account (migration 0068), or the batch of `recordTermsAcceptance` in
 * `apps/app/src/auth/terms.ts`. One row per version: the first acceptance of it counts.
 */
export const termsAcceptances = sqliteTable(
  "terms_acceptances",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at").notNull(),
    action: text("action", { enum: TERMS_ACCEPTANCE_ACTIONS }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.version] }),
    check(
      "terms_acceptances_action",
      sql`${t.action} in ('sign_up', 'sign_in', 'review', 'backfill')`,
    ),
  ],
);

/** Plan names; their limits and features live in PLANS (@portifact/contracts). */
export const OWNER_PLAN_NAMES = ["free", "pro", "team", "enterprise"] as const;

/**
 * The plan of one owner (premium plan section 3, F1). No row means `free`. `owner_id` has no
 * foreign key because an owner will also be a workspace; account deletion removes the row
 * (`advanceAccountDeletion`). `overrides` is JSON validated by `PlanOverrides` when it is read
 * (`entitlements` in @portifact/domain ignores anything else). No payment columns: an operator,
 * and later a billing webhook, writes this row.
 */
export const ownerPlans = sqliteTable(
  "owner_plans",
  {
    ownerId: text("owner_id").primaryKey(),
    plan: text("plan", { enum: OWNER_PLAN_NAMES }).notNull(),
    seats: integer("seats").notNull().default(1),
    /** When the plan ends and the owner reads as `free`; null when it does not end. */
    validUntil: timestamp("valid_until"),
    overrides: text("overrides", { mode: "json" }),
    /** Who granted the plan (an operator or, later, the billing system). */
    grantedBy: text("granted_by").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    /**
     * The drops still held (decision 0022): a JSON list validated by `GraceSlots` when it is read
     * (`entitlements` in @portifact/domain), null when nothing is held. Written only by
     * `setOwnerPlan`, `removeOwnerPlan`, `applyOwnerPlans` and the grace scan.
     */
    // Plain text, parsed only by `readGrace`: a malformed value must never throw in a reader.
    grace: text("grace"),
    /**
     * Which grace emails each live hold got (decision 0022, third delivery): a JSON list validated
     * by `GraceNoticeMarks` when it is read (`readGraceNotices`), null when none. Written only by
     * the grace notice scan and `applyOwnerPlans`; never touched by the plan's own writes, so it
     * does not move `updated_at`.
     */
    // Plain text, like `grace`: a malformed value reads as no marks and never throws.
    graceNotices: text("grace_notices"),
  },
  (t) => [
    check("owner_plans_plan", sql`${t.plan} in ('free', 'pro', 'team', 'enterprise')`),
    check("owner_plans_seats", sql`${t.seats} >= 1`),
  ],
);

/**
 * The owner's brand on the viewer's bar (premium plan P9, feature `branding`), one row per owner
 * (a user's personal space or a workspace), so no foreign key, like `owner_plans`; account
 * deletion removes it with its logo (`advanceAccountDeletion`). Four validated values and the
 * logo's facts: never markup. The logo's bytes are in R2 at `brands/<owner>/<sha256>` and count in
 * the owner's `account_usage.stored_bytes` while this row names them. `revision` guards changes.
 * The operator suspends a brand (`suspended_at`), which brings back the default bar.
 */
export const ownerBrands = sqliteTable(
  "owner_brands",
  {
    ownerId: text("owner_id").primaryKey(),
    name: text("name").notNull(),
    accentColor: text("accent_color"),
    link: text("link"),
    logoSha256: text("logo_sha256"),
    logoType: text("logo_type", { enum: ["image/png", "image/jpeg", "image/webp"] }),
    logoWidth: integer("logo_width"),
    logoHeight: integer("logo_height"),
    logoBytes: integer("logo_bytes"),
    revision: integer("revision").notNull().default(1),
    suspendedAt: timestamp("suspended_at"),
    suspensionReason: text("suspension_reason", { enum: ABUSE_REASONS }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check(
      "owner_brands_accent",
      sql`${t.accentColor} is null or (length(${t.accentColor}) = 7 and ${t.accentColor} glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`,
    ),
    check(
      "owner_brands_logo",
      sql`(${t.logoSha256} is null and ${t.logoType} is null and ${t.logoWidth} is null and ${t.logoHeight} is null and ${t.logoBytes} is null) or (length(${t.logoSha256}) = 64 and ${t.logoType} in ('image/png', 'image/jpeg', 'image/webp') and ${t.logoWidth} > 0 and ${t.logoHeight} > 0 and ${t.logoBytes} between 1 and 100000)`,
    ),
    check(
      "owner_brands_suspension",
      sql`(${t.suspendedAt} is null) = (${t.suspensionReason} is null)`,
    ),
  ],
);

/**
 * Workspaces (premium plan F3, decision 0004): an owner that is not a user. Changed only by
 * packages/services, in D1 batches; Better Auth never sees these tables. The region is fixed at
 * creation (decision 0005): a trigger in 0029_workspaces.sql refuses changing it.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    /** `ws_` and 32 hex characters (contracts: WorkspaceId); never a user or artifact ID. */
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    region: text("region", { enum: REGIONS }).notNull().default("default"),
    /** The user who created it. No foreign key: the workspace outlives its creator's account. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    /**
     * The workspace's policies (decision 0015), validated JSON (contracts: WorkspacePolicy); null
     * is the defaults. Read with the membership, so applying them costs no read.
     */
    policy: text("policy", { mode: "json" }),
    /** Moves with every policy change; a change is conditioned on the revision it read. */
    policyRevision: integer("policy_revision").notNull().default(0),
    /**
     * Whether the policy's "SSO required" is suspended because the workspace's provider cannot
     * sign anyone in (decision 0021): 1 while it cannot, 0 otherwise. Changed only by
     * `ssoSuspensionStatements` in the batch of the write that causes the transition, with its
     * audit event; enforcement never reads it (it decides from the provider itself).
     */
    ssoSuspended: integer("sso_suspended").notNull().default(0),
  },
  (t) => [uniqueIndex("workspaces_slug_idx").on(t.slug)],
);

/**
 * Who belongs to a workspace and with which role (contracts: WORKSPACE_ROLES). A membership
 * goes with its user and with its workspace. External readers listed by email are not members.
 */
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_idx").on(t.userId),
    check("workspace_members_role", sql`${t.role} in ('admin', 'editor', 'member')`),
  ],
);

/**
 * Pending invitations to a workspace (premium plan T1). Only a SHA-256 of the token is stored;
 * the token itself is only in the email. The address is lowercase and the invitation is accepted
 * only by a signed-in account whose verified email is that address. Accepting, declining or
 * revoking deletes the row; one pending invitation per workspace and address, which a new
 * invitation replaces. A pending invitation holds a seat until it expires.
 */
export const workspaceInvitations = sqliteTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The admin who sent it; null once their account is deleted. */
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /**
     * `directory` when the workspace's directory provisioned the address through SCIM (decision
     * 0017): it becomes a membership when the person first signs in with that verified address,
     * without an accept step. Holds a seat like any invitation.
     */
    source: text("source", { enum: ["admin", "directory"] })
      .notNull()
      .default("admin"),
  },
  (t) => [
    uniqueIndex("workspace_invitations_token_idx").on(t.tokenHash),
    // One pending invitation per workspace, address and source: a directory's pending
    // membership sits beside an admin's invitation and never changes it (decision 0017).
    uniqueIndex("workspace_invitations_workspace_email_idx").on(t.workspaceId, t.email, t.source),
    index("workspace_invitations_email_idx").on(t.email),
    check("workspace_invitations_role", sql`${t.role} in ('admin', 'editor', 'member')`),
  ],
);

/**
 * GitHub repositories a workspace trusts to publish through OIDC (decision 0024), bound to
 * GitHub's numeric IDs; `repository` is the name people see and is never compared. Global, next
 * to the workspace's service tokens.
 */
export const githubTrustRules = sqliteTable(
  "github_trust_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    repositoryOwnerId: text("repository_owner_id").notNull(),
    repository: text("repository").notNull(),
    /** Space-separated events from `GITHUB_TRUST_EVENTS`. */
    events: text("events").notNull(),
    ref: text("ref"),
    environment: text("environment"),
    /** Space-separated scopes from `GITHUB_TRUST_SCOPES`. */
    scopes: text("scopes").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [uniqueIndex("github_trust_rules_repository_idx").on(t.workspaceId, t.repositoryId)],
);

/**
 * GitHub ID tokens already exchanged (decision 0024, "Review of the first version"): the SHA-256
 * of the issuer and the token's `jti`, never the raw value, with when the token stops being
 * acceptable. Nothing cascades into it, so changing or removing a rule never forgets a token.
 * `claim` is the exchanging request's own value: its credential is written only when its insert
 * won. Pruned by the maintenance scan once `expires_at` has passed.
 */
export const githubUsedTokens = sqliteTable(
  "github_used_tokens",
  {
    jtiHash: text("jti_hash").primaryKey(),
    claim: text("claim").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("github_used_tokens_expiry_idx").on(t.expiresAt)],
);

/**
 * Service tokens (premium plan T4, decision 0011): a workspace's credential for automation, with
 * a fixed role (never admin) and scopes. Only the SHA-256 of the secret is stored. Revoking
 * deletes the row and writes a `service_token` tombstone; deleting the workspace deletes its
 * tokens. `created_by` has no foreign key: deleting that account clears it.
 */
export const serviceTokens = sqliteTable(
  "service_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    role: text("role", { enum: ["editor"] }).notNull(),
    /** Space-separated scopes from `SERVICE_TOKEN_SCOPES`. */
    scopes: text("scopes").notNull(),
    restriction: text("restriction", { enum: ["none", "own", "key"] })
      .notNull()
      .default("none"),
    keyPrefix: text("key_prefix"),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Written at most once an hour (decision 0011, "Last used"). */
    lastUsedAt: timestamp("last_used_at"),
    /**
     * The GitHub trust rule a credential was issued for (decision 0024); null for an admin's
     * token. Removing the rule removes its credentials.
     */
    trustRuleId: text("trust_rule_id").references(() => githubTrustRules.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("service_tokens_hash_idx").on(t.tokenHash),
    index("service_tokens_workspace_idx").on(t.workspaceId),
    index("service_tokens_rule_idx").on(t.trustRuleId, t.expiresAt),
    check("service_tokens_role", sql`${t.role} = 'editor'`),
    check(
      "service_tokens_restriction",
      sql`(${t.restriction} = 'key') = (${t.keyPrefix} is not null)`,
    ),
  ],
);

/**
 * SCIM tokens (premium plan E2, decision 0017): the credential a workspace's directory uses at
 * `/scim/v2`, and nothing else. Separate from service tokens so no actor resolution can ever give
 * one a role on artifacts. Only the SHA-256 of the secret is stored. Revoking deletes the row and
 * writes a `scim_token` tombstone; deleting the workspace deletes its tokens. `created_by` has no
 * foreign key: deleting that account clears it.
 */
export const scimTokens = sqliteTable(
  "scim_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Written at most once an hour, like a service token's. */
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    uniqueIndex("scim_tokens_hash_idx").on(t.tokenHash),
    index("scim_tokens_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * The directory's users of a workspace (decision 0017): the SCIM resource the directory created,
 * by an unguessable ID. `email` is the directory's `userName`, lowercase, always in one of the
 * workspace's verified email domains when written. `user_id` links the account once the person
 * is a member through it (at once when an account had the address, or at their first sign-in);
 * the membership itself is in `workspace_members`, the pending one in `workspace_invitations`
 * with `source = 'directory'`. `removed_at` records that an admin removed the person, withdrew
 * the pending membership or the person left by hand: a routine sync does not undo it, only an
 * explicit reactivation or a new provisioning does. Global, next to the memberships; goes with the
 * workspace, and the account link is cleared with the account.
 */
export const scimUsers = sqliteTable(
  "scim_users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    externalId: text("external_id"),
    /** `displayName` and `name` as the directory sent them, JSON; echoed back to it only. */
    names: text("names", { mode: "json" }),
    active: integer("active", { mode: "boolean" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    removedAt: timestamp("removed_at"),
    /**
     * Who made the removal by hand: `admin` (a removed member or a withdrawn pending membership),
     * which an explicit reactivation lifts, or `self` (the person left), which only a new create
     * after a delete lifts.
     */
    removal: text("removal", { enum: ["admin", "self"] }),
    /**
     * Set in the batch that removed the linked account's membership and cleared once its sessions
     * ended, so a retry after a failure ends them, and only for that removal.
     */
    sessionsPending: integer("sessions_pending", { mode: "boolean" }).notNull().default(false),
    /**
     * The role the directory's group mapping last gave the linked account (`editor` or `admin`),
     * null when it gave none: a sync changes a role only for someone it gave one to or gives one
     * to now, so a role an admin set by hand for anyone else is never touched.
     */
    mappedRole: text("mapped_role", { enum: ["editor", "admin"] }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    /**
     * A per-request unique token each write sets in its guarded first statement; the rest of the
     * batch is conditioned on it, so of two concurrent writes only the one that claimed the row
     * applies its effects (AGENTS.md, D1 batches).
     */
    writeId: text("write_id").notNull(),
  },
  (t) => [
    uniqueIndex("scim_users_workspace_email_idx").on(t.workspaceId, t.email),
    index("scim_users_workspace_created_idx").on(t.workspaceId, t.createdAt, t.id),
    index("scim_users_workspace_external_idx").on(t.workspaceId, t.externalId),
    index("scim_users_user_idx").on(t.userId),
  ],
);

/**
 * Groups a workspace's directory manages through SCIM (decision 0017, "Groups and roles"): a row
 * here marks the `workspace_groups` row as directory-managed, so the dashboard does not change it.
 * Goes with the group. `write_id` claims each write, like a directory user's.
 */
export const scimGroups = sqliteTable(
  "scim_groups",
  {
    groupId: text("group_id")
      .primaryKey()
      .references(() => workspaceGroups.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    writeId: text("write_id").notNull(),
  },
  (t) => [index("scim_groups_workspace_external_idx").on(t.workspaceId, t.externalId)],
);

/**
 * Who the directory says is in each of its groups, by directory user: pending people included.
 * `workspace_group_members` holds the members among them who are workspace members; a person who
 * joins later gets their group rows from here in the batch of the join. Goes with the group and
 * with the directory user.
 */
export const scimGroupMembers = sqliteTable(
  "scim_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroups.groupId, { onDelete: "cascade" }),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUsers.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.scimUserId] }),
    index("scim_group_members_user_idx").on(t.scimUserId),
  ],
);

/** A workspace's SCIM settings (decision 0017); no row means the defaults. */
export const workspaceScim = sqliteTable("workspace_scim", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Whether a person provisioned without an account gets the invitation email. Off by default. */
  invitationEmails: integer("invitation_emails", { mode: "boolean" }).notNull().default(false),
  /**
   * The directory-managed groups whose members get `editor` and `admin` (decision 0017, "Groups
   * and roles"); null when unmapped. Cleared in the batch that deletes the group.
   */
  editorGroupId: text("editor_group_id"),
  adminGroupId: text("admin_group_id"),
  /** Moves with every mapping change; a change is conditioned on the revision it read. */
  mappingRevision: integer("mapping_revision").notNull().default(0),
  /** The per-request token of the last mapping write, read back to tell a write from a race. */
  mappingWriteId: text("mapping_write_id"),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Email domains a workspace claims or verified (premium plan T2, decision 0010). Global, like the
 * workspace. A claim is `pending` with a fresh token until the TXT record
 * `_portifact-email.<domain>` holds it; at most one workspace has a domain `verified` (the partial
 * unique index). The token is the value of a public DNS record and is shown again, so it is
 * stored as is; it is never logged or exported. Rows go with the workspace.
 */
export const workspaceDomains = sqliteTable(
  "workspace_domains",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Lowercase A-label. */
    domain: text("domain").notNull(),
    /** The Unicode form the admin typed, when it differs; display only. */
    display: text("display"),
    token: text("token").notNull(),
    state: text("state", { enum: ["pending", "verified"] }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** When a pending claim is dropped. */
    expiresAt: timestamp("expires_at").notNull(),
    verifiedAt: timestamp("verified_at"),
    checkedAt: timestamp("checked_at"),
    failedChecks: integer("failed_checks").notNull().default(0),
    problem: text("problem", { enum: ["txt_missing"] }),
  },
  (t) => [
    uniqueIndex("workspace_domains_workspace_domain_idx").on(t.workspaceId, t.domain),
    uniqueIndex("workspace_domains_verified_idx").on(t.domain).where(sql`${t.state} = 'verified'`),
    index("workspace_domains_state_checked_idx").on(t.state, t.checkedAt),
    check("workspace_domains_state", sql`${t.state} in ('pending', 'verified')`),
  ],
);

/**
 * People an admin removed from a workspace (decision 0016, section 5): while a row stands, signing
 * in through the workspace's single sign-on does not make them a member again. Written in the
 * removal's own global batch, deleted when an admin invites them again; leaving by oneself writes
 * none. Global next to the memberships, so a D1 Time Travel restore rewinds both together. Goes
 * with the workspace and with the account.
 */
export const workspaceRemovals = sqliteTable(
  "workspace_removals",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    removedAt: timestamp("removed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/**
 * A workspace's single sign-on provider with OpenID Connect (premium plan E1, decision 0016).
 * Global, one per workspace, changed only by packages/services. The client secret is sealed with
 * `SSO_KEY` (bound to the workspace and the column) and never returned; `domains` are the
 * workspace's verified email domains it serves, space-separated and sorted, re-read against
 * `workspace_domains` at every sign-in. The ID names the redirect URI and the identities linked
 * through it (`accounts.provider_id` is `sso:<id>`), so it never changes: a new issuer is a new
 * provider. `revision` moves on every change, and a sign-in started before one is refused.
 * Removing it writes a `workspace_sso` tombstone; it goes with the workspace.
 */
export const workspaceSso = sqliteTable(
  "workspace_sso",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretSealed: text("client_secret_sealed").notNull(),
    /** Which `SSO_KEY` sealed the secret. */
    secretKeyId: text("secret_key_id").notNull(),
    domains: text("domains").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [uniqueIndex("workspace_sso_workspace_idx").on(t.workspaceId)],
);

/**
 * Groups of a workspace (premium plan T3, decision 0014): a named set of its members that
 * `restricted` artifacts of the workspace can list. Global, like the workspace and its members.
 * Names are unique in the workspace without regard to ASCII case. Rows go with the workspace;
 * deleting one writes a `workspace_group` tombstone so a restore cannot bring it back.
 */
export const workspaceGroups = sqliteTable(
  "workspace_groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    // The parent key of the memberships' composite foreign key.
    uniqueIndex("workspace_groups_workspace_id_idx").on(t.workspaceId, t.id),
    uniqueIndex("workspace_groups_workspace_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
    check("workspace_groups_name_length", sql`length(${t.name}) between 1 and 80`),
  ],
);

/**
 * Who is in a group. Both composite foreign keys hold a membership to its workspace: the group
 * must be the workspace's, and the person must be a member of it, so leaving or being removed
 * from the workspace (or deleting the account) removes them from its groups by cascade. Each row
 * has its own ID, which a `workspace_group_member` tombstone names when it is removed, so a later
 * membership of the same person survives a restore.
 */
export const workspaceGroupMembers = sqliteTable(
  "workspace_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [workspaceGroups.workspaceId, workspaceGroups.id],
      name: "workspace_group_members_group_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "workspace_group_members_member_fk",
    }).onDelete("cascade"),
    uniqueIndex("workspace_group_members_group_user_idx").on(t.groupId, t.userId),
    index("workspace_group_members_member_idx").on(t.workspaceId, t.userId),
  ],
);

/**
 * Workspaces the operator deleted whose artifacts and data are still being purged
 * (`advanceWorkspaceDeletion`). The `workspaces` row is already gone; this row goes once nothing
 * is left and a `workspace` tombstone replaces it.
 */
export const workspaceDeletions = sqliteTable("workspace_deletions", {
  workspaceId: text("workspace_id").primaryKey(),
  requestedAt: timestamp("requested_at").notNull(),
  /** As `account_deletions.attempted_at`: the least recently tried runs first. */
  attemptedAt: timestamp("attempted_at"),
});

/**
 * The global artifact directory (decision 0005, section 2): which region holds each artifact ID
 * ever handed out. No owner, no name. A row is claimed before the artifact is written in its
 * region and is never updated or deleted (triggers in 0029_workspaces.sql refuse both), so no ID
 * is reused in any region.
 */
export const artifactDirectory = sqliteTable("artifact_directory", {
  id: text("id").primaryKey(),
  region: text("region", { enum: REGIONS }).notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** States of a proven custom domain (decision 0006, "States and transitions"). */
export const CUSTOM_DOMAIN_STATES = ["provisioning", "active", "detaching"] as const;

/**
 * Pending claims of custom hostnames (premium plan P7, decision 0006). Global: a hostname is
 * unique across regions. A claim proves nothing: several owners may hold one for the same name,
 * each with its own token, so a squatter's claim blocks nobody. The token is the value the owner
 * publishes in the public TXT record `_portifact.<hostname>`; it proves control of DNS only by
 * being found there, so it is no secret and is kept to show the record again. No foreign keys:
 * the owner may be a workspace and the artifact lives in its region. Claims never reach
 * Cloudflare; they last a week.
 */
export const domainClaims = sqliteTable(
  "domain_claims",
  {
    hostname: text("hostname").notNull(),
    ownerId: text("owner_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.hostname, t.ownerId] }),
    index("domain_claims_owner_idx").on(t.ownerId),
    index("domain_claims_artifact_idx").on(t.artifactId),
    index("domain_claims_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Custom hostnames that passed the TXT proof (decision 0006). Global, next to the artifact
 * directory: the content Worker caches `hostname -> artifact, region` from active rows as a hint
 * and checks it against `artifacts.custom_host` on every request. `cf_hostname_id` is
 * Cloudflare's custom hostname, Portifact's resource, kept when the name changes hands. A row is
 * deleted only by the `delete_custom_hostname` job after Cloudflare's delete, so a name is free
 * again only then. No foreign keys, like `domain_claims`.
 */
export const customDomains = sqliteTable(
  "custom_domains",
  {
    hostname: text("hostname").primaryKey(),
    ownerId: text("owner_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    region: text("region", { enum: REGIONS }).notNull(),
    state: text("state", { enum: CUSTOM_DOMAIN_STATES }).notNull(),
    /** The token of the claim that proved it, which the TXT record must keep holding. */
    token: text("token").notNull(),
    cfHostnameId: text("cf_hostname_id"),
    verifiedAt: timestamp("verified_at").notNull(),
    checkedAt: timestamp("checked_at").notNull(),
    missedChecks: integer("missed_checks").notNull().default(0),
    /** What the last check found wrong (contracts: CustomDomainProblem), or null. */
    problem: text("problem", {
      enum: ["txt_missing", "certificate_pending", "cloudflare_unavailable", "cname_elsewhere"],
    }),
    /** Why it was detached (domain: DetachReason); null unless `detaching`. */
    detachReason: text("detach_reason"),
    createdAt: createdAt(),
    /**
     * The detach time the owner was emailed about when a plan that ended no longer covers this
     * domain (the downgrade notice); null until then. A renewal makes it irrelevant.
     */
    noticeFor: timestamp("notice_for"),
    /**
     * Daily checks in a row that found the name not pointing at Portifact's target (decision
     * 0006, "Where the name points"); counted apart from the TXT misses, with the same limit.
     */
    missedPointChecks: integer("missed_point_checks").notNull().default(0),
  },
  (t) => [
    index("custom_domains_owner_idx").on(t.ownerId, t.verifiedAt),
    index("custom_domains_artifact_idx").on(t.artifactId),
    index("custom_domains_check_idx").on(t.state, t.checkedAt),
    check("custom_domains_state", sql`${t.state} in ('provisioning', 'active', 'detaching')`),
  ],
);

/**
 * Hostnames the operator refused as custom domains (abuse, impersonation): a name blocks itself
 * and every name under it. Global, changed only by the operator tool; adding, verifying and the
 * daily check consult it.
 */
export const blockedHostnames = sqliteTable("blocked_hostnames", {
  name: text("name").primaryKey(),
  note: text("note"),
  createdAt: createdAt(),
});

export * from "./auth-schema.ts";

/**
 * The audit log (premium plan T10): one row per change that matters for accountability, keyed by
 * the owner it happened to, written by the services in the batch of the change, on the same
 * condition, so a row exists exactly when the change does. Append only: nothing updates a row;
 * the retention scan and the owner's erasure delete them. Every control database has the table
 * (one migration history, decision 0005): an owner's events live in its region, and the changes
 * to global rows (members, invitations, plans) are recorded in the global database, in their own
 * batch. No foreign keys: an event outlives the artifact, member or webhook it names, and goes
 * only with its owner. `actor_id` is an opaque account ID (null for the operator and jobs);
 * `detail` holds the kind's small structured detail (`AUDIT_DETAILS` in contracts), never text a
 * person wrote.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    at: timestamp("at").notNull(),
    kind: text("kind").notNull(),
    actorType: text("actor_type", {
      enum: ["user", "operator", "system", "token", "directory"],
    }).notNull(),
    actorId: text("actor_id"),
    targetId: text("target_id"),
    artifactId: text("artifact_id"),
    detail: text("detail", { mode: "json" }).notNull(),
    /**
     * When the database recorded the row, in milliseconds by the database's own clock
     * (`recordedNow`, set inside the same insert that writes the event), never by a Worker's.
     * Only audit streams read it (decision 0019): it orders and positions a stream, so an event
     * whose `at` is old when it is written still lands after every position already delivered.
     * Never shown or sent; `at` stays the time every reader shows. The constant default is only
     * for the migration that added it (SQLite refuses an expression there); every insert sets it.
     */
    recordedAt: integer("recorded_at").notNull().default(0),
  },
  (t) => [
    index("audit_events_owner_at_idx").on(t.ownerId, t.at, t.id),
    index("audit_events_at_idx").on(t.at),
    index("audit_events_owner_recorded_idx").on(t.ownerId, t.recordedAt, t.id),
  ],
);

/**
 * The database's clock in milliseconds, for `audit_events.recorded_at`: put it at the end of every
 * `insert ... select` into `audit_events` (the column's place in schema order). One expression in
 * the statement the writer already runs, so recording it costs no statement, read or round trip.
 * `julianday('now')` is fixed for the whole statement.
 */
export const recordedNow = sql`cast(round((julianday('now') - 2440587.5) * 86400000) as integer)`;

/**
 * Content search (premium plan T8, decision 0012): which version of an artifact the index holds.
 * One row per indexed artifact, written only by the `search_index` job in one batch with its
 * files, while that version is current and the artifact active. It goes with the artifact (the
 * foreign key), and triggers of the `content_search` migration delete it when the artifact stops
 * being active or changes owner. Deleting it deletes its `search_chunks`, whose trigger deletes
 * their rows of the `search_text` FTS5 table (raw SQL in that migration; Drizzle never sees it).
 */
export const searchArtifacts = sqliteTable(
  "search_artifacts",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    versionId: text("version_id").notNull(),
    /** UTF-8 bytes of the text indexed for this artifact, counted against the owner's cap. */
    textBytes: integer("text_bytes").notNull(),
    /** Some text was over a cap and is not searchable. */
    partial: integer("partial", { mode: "boolean" }).notNull(),
    indexedAt: timestamp("indexed_at").notNull(),
    /**
     * The index of the next file a continuation job reads, while one job's read budget did not
     * cover the version; null once every file was read (`SEARCH_LIMITS.jobReadBytes`).
     */
    nextFile: integer("next_file"),
  },
  (t) => [index("search_artifacts_owner_idx").on(t.ownerId)],
);

/**
 * One chunk of an indexed file's text (about 4,000 characters, `chunkText` in packages/domain), so
 * a snippet is always built from a small row; its `id` is the rowid of its `search_text` row.
 */
export const searchChunks = sqliteTable(
  "search_chunks",
  {
    id: integer("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => searchArtifacts.artifactId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [uniqueIndex("search_chunks_artifact_path_seq_idx").on(t.artifactId, t.path, t.seq)],
);

/** Why an audit stream is not sending (decision 0019, `AuditStreamPauseReason`). */
export const AUDIT_STREAM_PAUSE_REASONS = [
  "manual",
  "plan",
  "failures",
  "invalid_url",
  "key_unavailable",
] as const;

/**
 * Audit streams of an owner (decision 0019, packages/services/src/audit-streams.ts): HTTPS
 * endpoints that receive the owner's audit log as it is written. Regional, next to the owner's
 * webhooks: the job that delivers runs on the owner's region. The URL and the signing secret are
 * sealed with `WEBHOOK_KEY` like a webhook's (`key_id` names the key); only the host is kept in
 * clear. Each database the owner's events live in has its own position, the time and ID of the
 * last event delivered (`regional_at`/`regional_id`, `global_at`/`global_id`); a null time means
 * "from the oldest event still kept". `owner_id` has no foreign key (an owner is a user or a
 * workspace): deleting the owner deletes the rows, and removing one writes an `audit_stream`
 * tombstone so a restore cannot bring the destination back.
 */
export const auditStreams = sqliteTable(
  "audit_streams",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    label: text("label").notNull(),
    host: text("host").notNull(),
    keyId: text("key_id").notNull(),
    urlBox: text("url_box").notNull(),
    secretBox: text("secret_box").notNull(),
    /** The secret a rotation replaced, which also signs until `previous_until`. */
    previousSecretBox: text("previous_secret_box"),
    previousUntil: timestamp("previous_until"),
    state: text("state", { enum: ["active", "paused", "attention"] }).notNull(),
    pausedReason: text("paused_reason", { enum: AUDIT_STREAM_PAUSE_REASONS }),
    pausedAt: timestamp("paused_at"),
    regionalAt: timestamp("regional_at"),
    regionalId: text("regional_id").notNull().default(""),
    globalAt: timestamp("global_at"),
    globalId: text("global_id").notNull().default(""),
    /** Requests failed in a row, since when, and when the next one may go. */
    failures: integer("failures").notNull().default(0),
    failingSince: timestamp("failing_since"),
    nextAttemptAt: timestamp("next_attempt_at"),
    /** The last gap reported to the endpoint: events past retention it never received. */
    gapSource: text("gap_source", { enum: ["regional", "global"] }),
    gapFrom: timestamp("gap_from"),
    gapTo: timestamp("gap_to"),
    /** A test an admin asked for, sent by the next run whatever the state. */
    testRequestedAt: timestamp("test_requested_at"),
    /**
     * Bumped by every change of what the stream is (its URL, secret, key, state or label), by an
     * admin, the platform's pause or the key re-seal; never by delivery. Every admin change is
     * conditioned on the revision it read, and a run writes a position only while the revision
     * is the one it started with, so a batch sent to a destination the admin just left never
     * moves the stream (decision 0019, "Changes during a run").
     */
    revision: integer("revision").notNull().default(0),
    /** Up to where a gap was already reported, per database (recorded time). */
    regionalGapTo: timestamp("regional_gap_to"),
    globalGapTo: timestamp("global_gap_to"),
    /** Every event recorded before this was delivered (the database's clock), for the lag. */
    deliveredThrough: timestamp("delivered_through"),
    createdAt: createdAt(),
    /** Who created it (no foreign key: cleared when the account is deleted). */
    createdBy: text("created_by"),
  },
  (t) => [
    index("audit_streams_owner_idx").on(t.ownerId),
    check("audit_streams_failures", sql`${t.failures} >= 0`),
  ],
);

/**
 * The delivery log of an audit stream for the last 7 days: one row per request (and per daily-cap
 * deferral), with the outcome, the status class and how many events it carried. Never the body,
 * the response or the URL. Pruned by the maintenance scan.
 */
export const auditStreamDeliveries = sqliteTable(
  "audit_stream_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    streamId: text("stream_id")
      .notNull()
      .references(() => auditStreams.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    at: timestamp("at").notNull(),
    outcome: text("outcome", { enum: ["delivered", "failed", "skipped", "test"] }).notNull(),
    source: text("source", { enum: ["regional", "global"] }),
    events: integer("events").notNull().default(0),
    statusClass: text("status_class"),
    error: text("error"),
  },
  (t) => [
    index("audit_stream_deliveries_stream_idx").on(t.streamId, t.at),
    index("audit_stream_deliveries_at_idx").on(t.at),
  ],
);
