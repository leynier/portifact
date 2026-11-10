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
export const REGIONS = ["default"] as const;
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
    accessMode: text("access_mode", { enum: ["public", "authenticated", "restricted"] })
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
  },
  (t) => [
    index("artifacts_owner_state_idx").on(t.ownerId, t.state),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").notNull(),
    /**
     * The app.portifact.com session that asked for the code. Signing out deletes it, which
     * deletes the code and every read session that came from it.
     */
    authSessionId: text("auth_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Policy generation the access check passed against; the read session starts from it. */
    policyGeneration: integer("policy_generation").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    sessionId: text("session_id"),
    createdAt: createdAt(),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The app.portifact.com session the reader signed in with. Claims are renewed only while it
     * exists and has not expired, so signing out of the app ends the read session too.
     */
    authSessionId: text("auth_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The app.portifact.com session that asked for the code; signing out deletes the code. */
    authSessionId: text("auth_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authSessionId: text("auth_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
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
    /** Previous versions expire seven days after they stop being current. */
    expiresAt: timestamp("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("versions_artifact_number_idx").on(t.artifactId, t.number),
    index("versions_state_expires_idx").on(t.state, t.expiresAt),
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
    uniqueIndex("objects_r2_key_idx").on(t.r2Key),
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
  (t) => [index("usage_events_owner_kind_at_idx").on(t.ownerId, t.kind, t.at)],
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
  (t) => [index("lifecycle_events_artifact_at_idx").on(t.artifactId, t.at)],
);

/** Purged artifact IDs and deleted accounts: never reused, never restored from backups. */
export const tombstones = sqliteTable(
  "tombstones",
  {
    kind: text("kind", { enum: ["artifact", "account"] }).notNull(),
    id: text("id").notNull(),
    deletedAt: timestamp("deleted_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.id] })],
);

/**
 * Reports sent through the public report form (`POST /api/v1/reports`). Untrusted text; the
 * operator reads them with the operator tool (docs/operations.md). The reporter's email is
 * optional and erased when that address's account is deleted.
 */
export const abuseReports = sqliteTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    reporterEmail: text("reporter_email"),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status", { enum: ["open", "actioned", "dismissed"] })
      .notNull()
      .default("open"),
    resolvedAt: timestamp("resolved_at"),
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
  },
  (t) => [
    uniqueIndex("suspensions_open_target_idx")
      .on(t.kind, t.targetId)
      .where(sql`${t.liftedAt} is null`),
    index("suspensions_parent_idx").on(t.parentId),
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
});

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
      sql`${t.overrideSteps} is null or ${t.overrideSteps} between 1 and 4`,
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
  },
  (t) => [
    check("owner_plans_plan", sql`${t.plan} in ('free', 'pro', 'team', 'enterprise')`),
    check("owner_plans_seats", sql`${t.seats} >= 1`),
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

export * from "./auth-schema.ts";
