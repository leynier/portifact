// The audit log (premium plan T10, feature `audit`): an append-only record, per owner, of the
// changes that matter for accountability. This is the one catalog of event kinds and their
// details, so the API, MCP, the CLI and the dashboard render the same thing. Details are small,
// structured and strict: counts, enums, booleans, version numbers, hosts and email domains,
// never free text, comment text, artifact content, tokens, secrets, URLs or full addresses.
import { z } from "zod";
import { AccessMode, CommentVisibility } from "./core.ts";
import { LIMITS } from "./limits.ts";
import { PlanName } from "./plans.ts";
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
  pruneBatch: 200,
} as const;

const count = z.number().int().min(0).max(LIMITS.readersPerArtifact);
const version = z.number().int().min(1);
/** An email address's domain or a host name: lowercase DNS characters only. */
const DnsName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "Invalid domain");
const empty = z.strictObject({});

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
    bar: z.boolean().optional(),
    commentVisibility: CommentVisibility.optional(),
    indexable: z.boolean().optional(),
    embeddable: z.boolean().optional(),
  }),
  "share_link.created": z.strictObject({ password: z.boolean(), expires: z.boolean() }),
  "share_link.revoked": empty,
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
  "member.joined": z.strictObject({ role: WorkspaceRole }),
  "member.role_changed": z.strictObject({ from: WorkspaceRole, to: WorkspaceRole }),
  "member.removed": z.strictObject({ role: WorkspaceRole }),
  "member.left": z.strictObject({ role: WorkspaceRole }),
  "plan.granted": z.strictObject({
    plan: PlanName,
    seats: z.number().int().min(1),
    validUntil: z.iso.datetime().nullable(),
  }),
  "plan.removed": empty,
} as const;

export type AuditKind = keyof typeof AUDIT_DETAILS;
export const AUDIT_KINDS = Object.keys(AUDIT_DETAILS) as [AuditKind, ...AuditKind[]];
export const AuditKind = z.enum(AUDIT_KINDS);
export type AuditDetail<K extends AuditKind> = z.infer<(typeof AUDIT_DETAILS)[K]>;

export const AUDIT_TARGET_TYPES = [
  "artifact",
  "share_link",
  "webhook",
  "brand",
  "member",
  "invitation",
  "plan",
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
};

/**
 * Who acted. `user` events keep the account's opaque ID; readers show a current member by name
 * and anyone else as a removed member, never by email. `operator` is Portifact's operator tool
 * (plans), `system` a scheduled job. Service tokens will add their own type (T4).
 */
export const AUDIT_ACTOR_TYPES = ["user", "operator", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AuditActorView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("removed_member"), id: z.string() }),
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
  }),
  /** The artifact the event is about, with its current name; null name once it is gone. */
  artifact: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  /** The kind's detail, as `AUDIT_DETAILS` defines it. */
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEventView = z.infer<typeof AuditEventView>;

export const AuditLogView = z.object({
  owner: OwnerView,
  /** Newest first. */
  events: z.array(AuditEventView),
  nextCursor: z.string().nullable(),
  retentionDays: z.number().int().min(0),
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
    .describe("Only events about this target: an artifact, member, share link or webhook ID."),
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
