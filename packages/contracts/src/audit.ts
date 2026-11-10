// The audit log (premium plan T10, feature `audit`): an append-only record, per owner, of the
// changes that matter for accountability. This is the one catalog of event kinds and their
// details, so the API, MCP, the CLI and the dashboard render the same thing. Details are small,
// structured and strict: counts, enums, booleans, version numbers, hosts and email domains,
// never free text, comment text, artifact content, tokens, secrets, URLs or full addresses.
import { z } from "zod";
import { APPROVALS } from "./approval-reviews.ts";
import { AccessMode, CommentVisibility } from "./core.ts";
import { WORKSPACE_GROUPS, WorkspaceGroupId } from "./groups.ts";
import { LIMITS } from "./limits.ts";
import { PlanName } from "./plans.ts";
import {
  DefaultAccessPolicy,
  POLICY_FIELDS,
  PublicAccessPolicy,
  ShareLinkPolicy,
  WORKSPACE_POLICIES,
} from "./policies.ts";
import { SCIM } from "./scim.ts";
import { SERVICE_TOKENS, ServiceTokenScope } from "./service-tokens.ts";
import { WebhookEventType, WebhookFormat } from "./webhooks.ts";
import { OwnerView, WorkspaceRole } from "./workspaces.ts";

/** Safety caps of the audit log; how long events are kept is the plan's `auditRetentionDays`. */
export const AUDIT_LIMITS = {
  /** Events one page returns at most. */
  pageSize: 100,
  /** Email domains one access change lists at most; the counts always cover every address. */
  readerDomains: 10,
  /** Kinds one query can filter on at once. */
  kindsPerQuery: 10,
  /** Rows the retention scan deletes per statement. */
  pruneBatch: 1000,
  /**
   * Statements one run spends on each kind of owner: 50,000 rows per database every 15 minutes,
   * so the scan keeps up with an owner writing an event several times a second for the whole
   * retention.
   */
  pruneRounds: 50,
} as const;

/**
 * Bounds of one export request (premium plan E3, feature `auditExport`). A request reads at most
 * `rowsPerDatabase` events from each of the owner's two databases (so at most twice that in one
 * body), in pages of `pageSize` per database, and holds at most two pages and one presented
 * chunk in memory. Larger exports resume with the cursor the response names in
 * `AUDIT_EXPORT_CURSOR_HEADER`. Starting an export (a request without a cursor) is limited per
 * owner and per person.
 */
export const AUDIT_EXPORT = {
  rowsPerDatabase: 5_000,
  pageSize: 500,
  perOwner: { max: 30, windowSeconds: 3_600 },
  perActor: { max: 10, windowSeconds: 3_600 },
  /**
   * Resumed parts an owner may read in the window: a cursor is easy to make up, so parts are
   * bounded too. 600 parts are six million rows an hour, far more than 30 real exports need.
   */
  partsPerOwner: { max: 600, windowSeconds: 3_600 },
} as const;

/** The response header that carries the cursor of the next part of an export, when there is one. */
export const AUDIT_EXPORT_CURSOR_HEADER = "Portifact-Next-Cursor";

export const AUDIT_EXPORT_FORMATS = ["csv", "jsonl"] as const;
export const AuditExportFormat = z.enum(AUDIT_EXPORT_FORMATS);
export type AuditExportFormat = z.infer<typeof AuditExportFormat>;

/** The fixed columns of the CSV export, in order. */
export const AUDIT_CSV_COLUMNS = [
  "id",
  "at",
  "kind",
  "actor_type",
  "actor_id",
  "actor_name",
  "target_type",
  "target_id",
  "artifact_id",
  "artifact_name",
  "detail",
] as const;

export const EMAIL_DOMAIN_REMOVAL_REASONS = ["removed", "record_missing", "claimed"] as const;
export type EmailDomainRemovalReason = (typeof EMAIL_DOMAIN_REMOVAL_REASONS)[number];

const count = z.number().int().min(0).max(LIMITS.readersPerArtifact);
const version = z.number().int().min(1);
/** An email address's domain or a host name: lowercase DNS characters only. */
const DnsName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "Invalid domain");
const empty = z.strictObject({});
const groupCount = z.number().int().min(0).max(WORKSPACE_GROUPS.perArtifact);
const enforceCount = z.number().int().min(0).max(10_000);
const approvalCount = z.number().int().min(0).max(APPROVALS.reviewersPerRequest);

/** Why a custom domain stopped serving (every path that detaches one names its reason). */
export const DOMAIN_DETACH_REASONS = [
  "removed",
  "txt_lost",
  "cloudflare_gone",
  "provisioning_timeout",
  "artifact_unavailable",
  "plan_limit",
  "suspended",
  "purged",
  "account_deleted",
  "reconciled",
  "operator",
  "blocked",
  "cname_elsewhere",
] as const;
export const DomainDetachReason = z.enum(DOMAIN_DETACH_REASONS);
export type DomainDetachReason = z.infer<typeof DomainDetachReason>;
const ownerKind = z.enum(["personal", "workspace"]);

/**
 * Every kind and its detail. Each kind has one target type (`AUDIT_TARGETS`). Adding a kind means
 * adding it here, writing it in the batch of its change (`auditEvent` in packages/services) and
 * translating it in every dashboard catalog.
 */
export const AUDIT_DETAILS = {
  "artifact.published": z.strictObject({ version, first: z.boolean() }),
  "artifact.rolled_back": z.strictObject({ version, from: version }),
  "artifact.renewed": empty,
  "artifact.archived": empty,
  "artifact.restored": empty,
  "artifact.deleted": empty,
  "artifact.pinned": empty,
  "artifact.unpinned": empty,
  "artifact.transferred_in": z.strictObject({ from: ownerKind }),
  "artifact.transferred_out": z.strictObject({ to: ownerKind }),
  "access.changed": z.strictObject({
    mode: AccessMode.optional(),
    /** Addresses the change asked to add and remove: counts, never the addresses. */
    readersAdded: count.optional(),
    readersRemoved: count.optional(),
    /** The distinct domains of those addresses, sorted, at most `AUDIT_LIMITS.readerDomains`. */
    readerDomains: z.array(DnsName).max(AUDIT_LIMITS.readerDomains).optional(),
    readerExceptions: count.optional(),
    /** Groups listed and unlisted, and group exceptions set (decision 0014): counts only. */
    groupsAdded: groupCount.optional(),
    groupsRemoved: groupCount.optional(),
    groupExceptions: groupCount.optional(),
    bar: z.boolean().optional(),
    commentVisibility: CommentVisibility.optional(),
    indexable: z.boolean().optional(),
    embeddable: z.boolean().optional(),
    /**
     * Set when a workspace policy made the change (decision 0015), by the system: the policy that
     * did. The other fields say what changed, as for a manual change.
     */
    policy: z.enum(["publicAccess", "readerDomains"]).optional(),
  }),
  "share_link.created": z.strictObject({ password: z.boolean(), expires: z.boolean() }),
  "share_link.revoked": empty,
  /**
   * Approval reviews (decision 0013): counts and settings, never reviewers' addresses or notes.
   * `required` is null for "every reviewer".
   */
  "review.requested": z.strictObject({
    reviewers: approvalCount,
    required: approvalCount.nullable(),
    showStatus: z.boolean(),
  }),
  "review.changed": z.strictObject({
    added: approvalCount.optional(),
    removed: approvalCount.optional(),
    required: approvalCount.nullable().optional(),
    showStatus: z.boolean().optional(),
  }),
  "review.cancelled": empty,
  /** A reviewer's verdict on a version, by its number; never the note. */
  "review.verdict": z.strictObject({ verdict: z.enum(["approve", "changes"]), version }),
  "domain.attached": z.strictObject({ hostname: DnsName }),
  "domain.removed": z.strictObject({ hostname: DnsName, reason: DomainDetachReason }),
  "webhook.created": z.strictObject({
    host: DnsName,
    format: WebhookFormat,
    events: z.array(WebhookEventType),
  }),
  "webhook.changed": z.strictObject({
    enabled: z.boolean().optional(),
    events: z.array(WebhookEventType).optional(),
  }),
  "webhook.removed": empty,
  "brand.changed": z.strictObject({
    fields: z.array(z.enum(["name", "accent", "link", "logo"])).min(1),
  }),
  "brand.removed": z.strictObject({ fields: z.array(z.enum(["logo", "all"])).min(1) }),
  "member.invited": z.strictObject({ role: WorkspaceRole, emailDomain: DnsName }),
  "member.invitation_revoked": empty,
  /** `via` is how they joined: an invitation (absent on older events) or single sign-on. */
  "member.joined": z.strictObject({
    role: WorkspaceRole,
    via: z.enum(["invitation", "sso", "directory"]).optional(),
  }),
  "member.role_changed": z.strictObject({ from: WorkspaceRole, to: WorkspaceRole }),
  "member.removed": z.strictObject({ role: WorkspaceRole }),
  "member.left": z.strictObject({ role: WorkspaceRole }),
  "plan.granted": z.strictObject({
    plan: PlanName,
    seats: z.number().int().min(1),
    validUntil: z.iso.datetime().nullable(),
  }),
  "plan.removed": empty,
  /** A service token (decision 0011): what it may do, never its label, secret or key prefix. */
  "service_token.created": z.strictObject({
    scopes: z.array(ServiceTokenScope).min(1).max(ServiceTokenScope.options.length),
    restriction: z.enum(["none", "own", "key"]),
    days: z.number().int().min(1).max(SERVICE_TOKENS.maxDays),
  }),
  "service_token.revoked": empty,
  /**
   * A workspace's email domain (decision 0010) once it grants access: proved, or gone again by an
   * admin (`removed`), by the daily check finding its record missing (`record_missing`) or by
   * another workspace proving it (`claimed`). A claim never proved records nothing.
   */
  "email_domain.verified": z.strictObject({ domain: DnsName }),
  "email_domain.removed": z.strictObject({
    domain: DnsName,
    reason: z.enum(EMAIL_DOMAIN_REMOVAL_REASONS),
  }),
  /**
   * A workspace's groups (decision 0014). The group is named by its ID only and shown by its
   * current name, never stored: a name is owner-chosen text. A member added to or removed from a
   * group is the target, and the detail names the group.
   */
  /**
   * The workspace's single sign-on provider (decision 0016): the issuer as a host only and how
   * many domains it serves, never the client ID or secret. `changed` names what changed.
   */
  "sso.created": z.strictObject({ issuerHost: DnsName, domains: z.number().int().min(1).max(10) }),
  "sso.changed": z.strictObject({
    fields: z.array(z.enum(["clientId", "clientSecret", "domains"])).min(1),
  }),
  "sso.removed": empty,
  /**
   * SCIM provisioning (decision 0017). A directory's token, created or revoked: its expiry only,
   * never its label or secret. A person the directory provisioned who has no membership yet
   * (they become one when they sign in): the address's domain only, as invitations record.
   * `scim.changed` names the settings that changed.
   */
  "scim_token.created": z.strictObject({ days: z.number().int().min(1).max(SCIM.maxDays) }),
  "scim_token.revoked": empty,
  "member.provisioned": z.strictObject({ role: WorkspaceRole, emailDomain: DnsName }),
  "scim.changed": z.strictObject({
    fields: z.array(z.enum(["invitationEmails"])).min(1),
    invitationEmails: z.boolean().optional(),
  }),
  "group.created": empty,
  "group.renamed": empty,
  "group.deleted": empty,
  "group.member_added": z.strictObject({ group: WorkspaceGroupId }),
  "group.member_removed": z.strictObject({ group: WorkspaceGroupId }),
  /**
   * A workspace's policies changed (decision 0015): which fields and their new values. Reader
   * domains are domains, never addresses.
   */
  "policy.changed": z.strictObject({
    fields: z.array(z.enum(POLICY_FIELDS)).min(1).max(POLICY_FIELDS.length),
    publicAccess: PublicAccessPolicy.optional(),
    defaultAccess: DefaultAccessPolicy.optional(),
    readerDomains: z.array(DnsName).max(WORKSPACE_POLICIES.readerDomains).nullable().optional(),
    shareLinks: ShareLinkPolicy.optional(),
    shareLinkMaxDays: z
      .number()
      .int()
      .min(1)
      .max(WORKSPACE_POLICIES.shareLinkMaxDays)
      .nullable()
      .optional(),
    /** The save accepted changes to existing artifacts (the preview's counts). */
    confirmed: z.boolean(),
  }),
  /**
   * One step of applying a policy to existing artifacts (the `workspace_policy` job or the
   * maintenance scan), by the system: what it changed, as counts.
   */
  "policy.enforced": z.strictObject({
    artifactsNarrowed: enforceCount,
    readersRemoved: enforceCount,
    linksRevoked: enforceCount,
    sessionsEnded: enforceCount,
  }),
  /**
   * An export of the audit log was started (E3): its format, how many kinds it filtered on (0 for
   * every kind) and its date range as ISO dates. Recorded once per export, when it starts, so
   * the number of rows is not known and not stored.
   */
  "audit.exported": z.strictObject({
    format: AuditExportFormat,
    kinds: z.number().int().min(0).max(AUDIT_LIMITS.kindsPerQuery),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  }),
} as const;

export type AuditKind = keyof typeof AUDIT_DETAILS;
export const AUDIT_KINDS = Object.keys(AUDIT_DETAILS) as [AuditKind, ...AuditKind[]];
export const AuditKind = z.enum(AUDIT_KINDS);
export type AuditDetail<K extends AuditKind> = z.infer<(typeof AUDIT_DETAILS)[K]>;

export const AUDIT_TARGET_TYPES = [
  "artifact",
  "share_link",
  "review",
  "webhook",
  "brand",
  "member",
  "invitation",
  "plan",
  "service_token",
  "email_domain",
  "group",
  "audit_log",
  "sso",
  "policy",
  "scim_token",
  "scim",
] as const;
export const AuditTargetType = z.enum(AUDIT_TARGET_TYPES);
export type AuditTargetType = z.infer<typeof AuditTargetType>;

/** What each kind is about. A share link and a domain also name their artifact. */
export const AUDIT_TARGETS: Readonly<Record<AuditKind, AuditTargetType>> = {
  "artifact.published": "artifact",
  "artifact.rolled_back": "artifact",
  "artifact.renewed": "artifact",
  "artifact.archived": "artifact",
  "artifact.restored": "artifact",
  "artifact.deleted": "artifact",
  "artifact.pinned": "artifact",
  "artifact.unpinned": "artifact",
  "artifact.transferred_in": "artifact",
  "artifact.transferred_out": "artifact",
  "access.changed": "artifact",
  "share_link.created": "share_link",
  "share_link.revoked": "share_link",
  "review.requested": "review",
  "review.changed": "review",
  "review.cancelled": "review",
  "review.verdict": "review",
  "domain.attached": "artifact",
  "domain.removed": "artifact",
  "webhook.created": "webhook",
  "webhook.changed": "webhook",
  "webhook.removed": "webhook",
  "brand.changed": "brand",
  "brand.removed": "brand",
  "member.invited": "invitation",
  "member.invitation_revoked": "invitation",
  "member.joined": "member",
  "member.role_changed": "member",
  "member.removed": "member",
  "member.left": "member",
  "plan.granted": "plan",
  "plan.removed": "plan",
  "service_token.created": "service_token",
  "service_token.revoked": "service_token",
  "email_domain.verified": "email_domain",
  "email_domain.removed": "email_domain",
  "sso.created": "sso",
  "sso.changed": "sso",
  "sso.removed": "sso",
  "scim_token.created": "scim_token",
  "scim_token.revoked": "scim_token",
  "member.provisioned": "invitation",
  "scim.changed": "scim",
  "group.created": "group",
  "group.renamed": "group",
  "group.deleted": "group",
  "group.member_added": "member",
  "group.member_removed": "member",
  "audit.exported": "audit_log",
  "policy.changed": "policy",
  "policy.enforced": "policy",
};

/**
 * Who acted. `user` events keep the account's opaque ID; readers show a current member by name
 * and anyone else as a removed member, never by email. `operator` is Portifact's operator tool
 * (plans), `system` a scheduled job, `token` a workspace's service token (decision 0011), kept
 * by its ID and shown by its current label, or as a revoked token once it is gone. `directory` is
 * a workspace's directory through its SCIM token (decision 0017), kept by the token's ID and shown
 * by its label the same way.
 */
export const AUDIT_ACTOR_TYPES = ["user", "operator", "system", "token", "directory"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AuditActorView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("removed_member"), id: z.string() }),
  /** `label` is null once the token is revoked or expired and removed. */
  z.object({ type: z.literal("service_token"), id: z.string(), label: z.string().nullable() }),
  /** The directory through a SCIM token; `label` is null once the token is revoked. */
  z.object({ type: z.literal("directory"), id: z.string(), label: z.string().nullable() }),
  z.object({ type: z.literal("operator") }),
  z.object({ type: z.literal("system") }),
]);
export type AuditActorView = z.infer<typeof AuditActorView>;

export const AuditEventView = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  kind: AuditKind,
  actor: AuditActorView,
  target: z.object({
    type: AuditTargetType,
    id: z.string().nullable(),
    /** A member target shown like an actor: their name while they are a member. */
    member: AuditActorView.optional(),
    /** A service token target shown like an actor: its label while it exists. */
    serviceToken: AuditActorView.optional(),
    /** A SCIM token target shown like an actor: its label while it exists. */
    scimToken: AuditActorView.optional(),
  }),
  /** The artifact the event is about, with its current name; null name once it is gone. */
  artifact: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  /**
   * The group a group event is about, with its current name; null name once it is deleted.
   * Absent for other kinds.
   */
  group: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
  /** The kind's detail, as `AUDIT_DETAILS` defines it. */
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEventView = z.infer<typeof AuditEventView>;

export const AuditLogView = z.object({
  owner: OwnerView,
  /** Newest first. */
  events: z.array(AuditEventView),
  nextCursor: z.string().nullable(),
  /** How many days events are kept: the owner's plan's `auditRetentionDays`. */
  retentionDays: z.number().int().min(0),
  /** Whether the owner's plan includes exporting the log (`auditExport`). */
  exportable: z.boolean(),
});
export type AuditLogView = z.infer<typeof AuditLogView>;

const cursor = z.string().max(200);
const limit = z.number().int().min(1).max(AUDIT_LIMITS.pageSize);
const kinds = z.array(AuditKind).min(1).max(AUDIT_LIMITS.kindsPerQuery);
const opaqueId = z.string().min(1).max(200);

/** The filters every interface takes; the dates are ISO 8601, `to` exclusive. */
export const AuditFilters = z.object({
  kinds: kinds.optional(),
  actor: opaqueId.optional(),
  target: opaqueId.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type AuditFilters = z.infer<typeof AuditFilters>;

/** Query of `GET /api/v1/audit`: `kind` repeats or is comma separated. */
export const AuditQuery = z.object({
  kind: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : (Array.isArray(value) ? value : [value]).flatMap((one) => one.split(",")).filter(Boolean),
    )
    .pipe(kinds.optional()),
  actor: opaqueId.optional(),
  target: opaqueId.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().pipe(limit).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/**
 * Query of `GET /api/v1/audit/export`: the reader's filters, the format and, to resume a large
 * export, the cursor the previous part named.
 */
export const AuditExportQuery = AuditQuery.omit({ limit: true }).extend({
  format: AuditExportFormat,
});
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

/** Input of the MCP tool get_audit_log. */
export const GetAuditLogInput = z.object({
  workspace: z
    .string()
    .max(40)
    .optional()
    .describe(
      "The workspace slug, as list_workspaces returns it. Omit it for your personal space.",
    ),
  kinds: kinds.optional().describe("Only these event kinds."),
  actor: opaqueId.optional().describe("Only events by this account ID (actor.id of an event)."),
  target: opaqueId
    .optional()
    .describe(
      "Only events about this target: an artifact, member, share link, webhook or group ID.",
    ),
  from: z.iso
    .datetime()
    .optional()
    .describe("Only events at or after this ISO 8601 date and time."),
  to: z.iso.datetime().optional().describe("Only events before this ISO 8601 date and time."),
  cursor: cursor
    .optional()
    .describe("The nextCursor of the previous page. Omit it for the first page."),
  limit: limit.default(50).describe(`How many events to return, 1 to ${AUDIT_LIMITS.pageSize}.`),
});
export type GetAuditLogInput = z.infer<typeof GetAuditLogInput>;
