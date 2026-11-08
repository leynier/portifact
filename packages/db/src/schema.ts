// D1 schema for Portifact's product data (plan section 14). Identity and OAuth tables live in
// auth-schema.ts and are re-exported here, so drizzle-kit sees one schema.
// Timestamps are integer milliseconds since the epoch (UTC).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sessions, users } from "./auth-schema.ts";

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
    currentVersionId: text("current_version_id"),
    /** Bumped on every lifecycle transition so stale maintenance jobs cannot act. */
    lifecycleGeneration: integer("lifecycle_generation").notNull().default(1),
    expiresAt: timestamp("expires_at"),
    archivedAt: timestamp("archived_at"),
    purgeAt: timestamp("purge_at"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("artifacts_owner_state_idx").on(t.ownerId, t.state),
    index("artifacts_state_expires_idx").on(t.state, t.expiresAt),
    index("artifacts_state_purge_idx").on(t.state, t.purgeAt),
    check("artifacts_id_format", sql`length(${t.id}) = 10`),
    check("artifacts_name_length", sql`length(${t.name}) between 1 and 200`),
  ],
);

/** Email addresses allowed to read a `restricted` artifact. */
export const artifactReaders = sqliteTable(
  "artifact_readers",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: createdAt(),
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
    rendererVersion: text("renderer_version"),
    committedAt: timestamp("committed_at"),
    /** Previous versions expire seven days after they stop being current. */
    expiresAt: timestamp("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("versions_artifact_number_idx").on(t.artifactId, t.number),
    index("versions_state_expires_idx").on(t.state, t.expiresAt),
    check("versions_bytes_nonnegative", sql`${t.publishedBytes} >= 0 and ${t.sourceBytes} >= 0`),
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

/** Manifest entries: which object backs each path of a version. */
export const versionFiles = sqliteTable(
  "version_files",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["published", "source"] }).notNull(),
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
  },
  (t) => [
    check(
      "account_usage_nonnegative",
      sql`${t.activeArtifacts} >= 0 and ${t.storedBytes} >= 0 and ${t.reservedBytes} >= 0 and ${t.openUploads} >= 0`,
    ),
    check("account_usage_active_limit", sql`${t.activeArtifacts} <= 50`),
    check("account_usage_bytes_limit", sql`${t.storedBytes} + ${t.reservedBytes} <= 2500000000`),
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

/** Transactional outbox for queue jobs (archive, purge, cleanup). */
export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topic: text("topic").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    availableAt: timestamp("available_at").notNull(),
    dispatchedAt: timestamp("dispatched_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending_idx").on(t.dispatchedAt, t.availableAt)],
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
    createdAt: createdAt(),
  },
  (t) => [index("abuse_reports_status_idx").on(t.status, t.createdAt)],
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
  ],
);

/**
 * Annotation usage per artifact owner: live messages and logical bytes (message bodies plus
 * thread targets). Triggers in `0006_annotation_usage_triggers.sql` keep it exact on every
 * insert, update and delete, cascades included, and the CHECK constraints refuse a write past
 * the limits even when the application misses a race.
 */
export const annotationUsage = sqliteTable(
  "annotation_usage",
  {
    ownerId: text("owner_id").primaryKey(),
    messages: integer("messages").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
  },
  (t) => [
    check("annotation_usage_nonnegative", sql`${t.messages} >= 0 and ${t.bytes} >= 0`),
    check("annotation_usage_messages_limit", sql`${t.messages} <= 5000`),
    check("annotation_usage_bytes_limit", sql`${t.bytes} <= 50000000`),
  ],
);

export * from "./auth-schema.ts";
