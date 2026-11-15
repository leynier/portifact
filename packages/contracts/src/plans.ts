// Plans and what they grant (premium plan section 3, "F1 Planes y derechos por dueño", and
// section 8): every owner has one plan, and the plan decides its product limits and features. An
// owner without a plan row is on `free`, whose values are exactly the constants in limits.ts.
// Safety caps that are not product tiers (readers per artifact, body sizes, multipart, files per
// version, rate windows) stay constants there. The effective values for one owner come from
// `entitlements` in @portifact/domain.
import { z } from "zod";
import { ArtifactDataLimits } from "./artifact-data.ts";
import { ACCESS_LOG, ANNOTATION_LIMITS, LIMITS, TRAFFIC_LIMITS } from "./limits.ts";

export const PLAN_NAMES = ["free", "pro", "team", "enterprise"] as const;
export const PlanName = z.enum(PLAN_NAMES);
export type PlanName = z.infer<typeof PlanName>;

/** Paid features, in the order of the premium plan: Pro's eight, then Team's six, then Enterprise's. */
export const PLAN_FEATURES = [
  "pin",
  "versionDiff",
  "shareLinks",
  "commentNotices",
  "webhooks",
  "customDomains",
  "analytics",
  "branding",
  "workspaces",
  "serviceTokens",
  "reviews",
  "integrations",
  "contentSearch",
  "audit",
  "sso",
  "scim",
  "auditExport",
  "policies",
  "euResidency",
] as const;
export const PlanFeature = z.enum(PLAN_FEATURES);
export type PlanFeature = z.infer<typeof PlanFeature>;

const count = z.number().int().min(0);

/**
 * How long audit events are kept (premium plan T10): 90 days. Events are written for every owner
 * and reading them needs `audit` (Team and above), so the value is the same on every plan: a plan
 * that lapses or is lowered never shortens what was already kept. Enterprise changes it through
 * overrides.
 */
export const AUDIT_RETENTION_DAYS = 90;

/**
 * The bounds of an `auditRetentionDays` override (premium plan E3): at least 30 days, at most
 * seven years (7 × 365 days plus two leap days). Only the operator sets it, with `set-plan`.
 */
export const AUDIT_RETENTION_BOUNDS = { minDays: 30, maxDays: 2_557 } as const;

/**
 * The most any retention limit may be (decision 0022): seven years for every length of time
 * (the audit retention bound), 84 months for archives and 10,000 previous versions. Overrides
 * are held to them, so a grace that holds a previous plan's values is always within them, and a
 * stored grace slot above them is not valid. Above every plan's own value.
 */
export const RETENTION_LIMIT_MAX = {
  archiveMonths: 84,
  retainedPreviousVersions: 10_000,
  previousVersionRetentionDays: AUDIT_RETENTION_BOUNDS.maxDays,
  accessLogRetentionDays: AUDIT_RETENTION_BOUNDS.maxDays,
  auditRetentionDays: AUDIT_RETENTION_BOUNDS.maxDays,
} as const;

/**
 * The limits a plan sets. Sizes are decimal bytes. `bytesPerMonth` is the traffic served, an
 * abuse cap. `accessLogRetentionDays` is how long the access log and the analytics view counters
 * are kept, `auditRetentionDays` how long audit events are. Version retention is enforced by version
 * reads and `pruneVersions`, using the count and age limits and any active grace; `customDomains`
 * caps the custom domains an owner may attach.
 */
export const PlanLimits = z
  .object({
    activeArtifacts: count,
    artifactBytes: count,
    accountBytes: count,
    requestsPerMonth: count,
    bytesPerMonth: count,
    annotationMessages: count,
    annotationBytes: count,
    archiveMonths: count,
    retainedPreviousVersions: count,
    previousVersionRetentionDays: count,
    accessLogRetentionDays: count,
    customDomains: count,
    auditRetentionDays: count,
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimits>;
export type PlanLimit = keyof PlanLimits;

/**
 * Artifact data (decision 0026): how many of an owner's artifacts may hold data and the limits
 * each one gets, sent with every command to its documents object (decision 45). Not a paid
 * feature: every plan has it. Kept out of `PlanLimits` (and so out of `PlanView` and the usage
 * body) because released CLIs parse those strictly. Not per seat and not held by a grace: a lower
 * plan only refuses new work, from the next command.
 */
export const DataPlanLimits = z.strictObject({
  /** Artifacts that may hold data at once. */
  artifacts: count,
  perArtifact: ArtifactDataLimits,
});
export type DataPlanLimits = z.infer<typeof DataPlanLimits>;

export interface PlanDefinition {
  limits: PlanLimits;
  /** Limits given per seat and pooled across the owner: the effective value is limit × seats. */
  perSeat: readonly PlanLimit[];
  features: readonly PlanFeature[];
  data: DataPlanLimits;
}

/**
 * The starting values of artifact data, option B of decision 0026 ("The plan limits"), confirmed
 * by the maintainer as the starting point; delivery 8 fixes the final numbers from staging. Every
 * plan keeps the record's per-author rates, the per-caller read rate and the rights class.
 * Cleanup equals growth and export is 40 times growth, as in the record's arithmetic.
 */
const DATA_RATES = {
  writesPerAuthorPerMinute: 30,
  deletesPerAuthorPerMinute: 60,
  readsPerCallerPerMinute: 300,
  rightsRowsPerDay: 500,
  connectionsPerAuthor: 4,
  connectsPerAuthorPerMinute: 6,
} as const;

const FREE_DATA: DataPlanLimits = {
  artifacts: 1,
  perArtifact: {
    ...DATA_RATES,
    bytesPerArtifact: 5_000_000,
    documentBytes: 16 * 1024,
    documentsPerCollection: 1_000,
    collections: 10,
    indexedFields: 3,
    rowsReadPerDay: 500_000,
    rowsWrittenPerDay: 5_000,
    cleanupRowsPerDay: 5_000,
    exportRowsPerDay: 200_000,
    liveMessagesPerDay: 2_000,
    connectionsPerArtifact: 10,
  },
};

const PRO_DATA: DataPlanLimits = {
  artifacts: 10,
  perArtifact: {
    ...DATA_RATES,
    bytesPerArtifact: 25_000_000,
    documentBytes: 32 * 1024,
    documentsPerCollection: 5_000,
    collections: 20,
    indexedFields: 5,
    rowsReadPerDay: 500_000,
    rowsWrittenPerDay: 2_000,
    cleanupRowsPerDay: 2_000,
    exportRowsPerDay: 80_000,
    liveMessagesPerDay: 5_000,
    connectionsPerArtifact: 10,
  },
};

const TEAM_DATA: DataPlanLimits = {
  artifacts: 50,
  perArtifact: {
    ...DATA_RATES,
    bytesPerArtifact: 50_000_000,
    documentBytes: 64 * 1024,
    documentsPerCollection: 10_000,
    collections: 32,
    indexedFields: 8,
    rowsReadPerDay: 1_000_000,
    rowsWrittenPerDay: 2_000,
    cleanupRowsPerDay: 2_000,
    exportRowsPerDay: 80_000,
    liveMessagesPerDay: 10_000,
    connectionsPerArtifact: 25,
  },
};

const PRO_FEATURES = PLAN_FEATURES.slice(0, 8);
const TEAM_FEATURES = PLAN_FEATURES.slice(0, 14);
const TEAM_PER_SEAT = [
  "accountBytes",
  "requestsPerMonth",
  "annotationMessages",
  "annotationBytes",
] as const satisfies readonly PlanLimit[];

const TEAM_LIMITS: PlanLimits = {
  activeArtifacts: 2_000,
  artifactBytes: 2_000_000_000,
  accountBytes: 30_000_000_000,
  requestsPerMonth: 3_000_000,
  bytesPerMonth: 1_000_000_000_000,
  annotationMessages: 25_000,
  annotationBytes: 100_000_000,
  archiveMonths: 12,
  retainedPreviousVersions: 100,
  previousVersionRetentionDays: 365,
  accessLogRetentionDays: 365,
  customDomains: 5,
  auditRetentionDays: AUDIT_RETENTION_DAYS,
};

export const PLANS: Readonly<Record<PlanName, PlanDefinition>> = {
  free: {
    limits: {
      activeArtifacts: LIMITS.activeArtifacts,
      artifactBytes: LIMITS.artifactBytes,
      accountBytes: LIMITS.accountBytes,
      requestsPerMonth: TRAFFIC_LIMITS.requestsPerMonth,
      bytesPerMonth: TRAFFIC_LIMITS.bytesPerMonth,
      annotationMessages: ANNOTATION_LIMITS.messagesPerOwner,
      annotationBytes: ANNOTATION_LIMITS.bytesPerOwner,
      archiveMonths: LIMITS.archiveMonths,
      retainedPreviousVersions: LIMITS.retainedPreviousVersions,
      previousVersionRetentionDays: LIMITS.previousVersionRetentionDays,
      accessLogRetentionDays: ACCESS_LOG.retentionDays,
      customDomains: 0,
      auditRetentionDays: AUDIT_RETENTION_DAYS,
    },
    perSeat: [],
    features: [],
    data: FREE_DATA,
  },
  pro: {
    limits: {
      activeArtifacts: 500,
      artifactBytes: 2_000_000_000,
      accountBytes: 25_000_000_000,
      requestsPerMonth: 2_000_000,
      bytesPerMonth: 250_000_000_000,
      annotationMessages: 25_000,
      annotationBytes: 100_000_000,
      archiveMonths: 12,
      retainedPreviousVersions: 50,
      previousVersionRetentionDays: 90,
      accessLogRetentionDays: 365,
      customDomains: 1,
      auditRetentionDays: AUDIT_RETENTION_DAYS,
    },
    perSeat: [],
    features: PRO_FEATURES,
    data: PRO_DATA,
  },
  team: { limits: TEAM_LIMITS, perSeat: TEAM_PER_SEAT, features: TEAM_FEATURES, data: TEAM_DATA },
  // Enterprise starts from Team's values (artifact data included, decision 0026 names no other);
  // a contract changes them through overrides.
  enterprise: {
    limits: TEAM_LIMITS,
    perSeat: TEAM_PER_SEAT,
    features: PLAN_FEATURES,
    data: TEAM_DATA,
  },
};

/** Plan names as messages and pages show them. */
export const PLAN_LABELS: Readonly<Record<PlanName, string>> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
};

/**
 * Each paid feature in plain words, as the subject of a sentence ("Pinning artifacts is part of
 * the Pro plan."). The one table every surface builds `plan_required` messages from.
 */
export const PLAN_FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = {
  pin: "Pinning artifacts",
  versionDiff: "Comparing versions",
  shareLinks: "Sharing with links",
  commentNotices: "Getting comment notices by email",
  webhooks: "Sending webhooks",
  customDomains: "Using a custom domain",
  analytics: "Seeing artifact analytics",
  branding: "Branding the Portifact bar",
  workspaces: "Using workspaces",
  serviceTokens: "Using service tokens",
  reviews: "Requesting reviews",
  integrations: "Connecting integrations",
  contentSearch: "Searching artifact contents",
  audit: "Reading the audit log",
  sso: "Signing in with SSO",
  scim: "Provisioning members with SCIM",
  auditExport: "Exporting the audit log",
  policies: "Setting workspace policies",
  euResidency: "Keeping data in the EU",
};

/**
 * The paid features that work in the product today, in the order of PLAN_FEATURES. The pricing
 * section and the dashboard's Plan page show only these as included and every other feature of
 * a plan as coming soon, so neither promises what the product does not do yet. Webhooks and
 * custom domains are built but switched off in production, so they are not here. Add a feature
 * in the same change that turns it on.
 */
export const AVAILABLE_PLAN_FEATURES = [
  "pin",
  "versionDiff",
  "shareLinks",
  "commentNotices",
  "analytics",
  "branding",
  "workspaces",
  "serviceTokens",
  "reviews",
  "contentSearch",
  "audit",
  "auditExport",
  "policies",
] as const satisfies readonly PlanFeature[];

/** Whether a paid feature works in the product today (`AVAILABLE_PLAN_FEATURES`). */
export function planFeatureAvailable(feature: PlanFeature): boolean {
  return (AVAILABLE_PLAN_FEATURES as readonly PlanFeature[]).includes(feature);
}

/** A plan's features split into those that work today and those still on the way. */
export function planFeatureStatus(plan: PlanName): {
  available: PlanFeature[];
  comingSoon: PlanFeature[];
} {
  const features = PLANS[plan].features;
  return {
    available: features.filter(planFeatureAvailable),
    comingSoon: features.filter((feature) => !planFeatureAvailable(feature)),
  };
}

/**
 * The listed price of each plan in US dollars a month, or null when it is agreed per contract.
 * `perSeat` prices are per seat. There is no checkout: paid plans are granted by the operator
 * after a request by email (`planRequestHref`).
 */
export const PLAN_PRICES: Readonly<
  Record<PlanName, { usdPerMonth: number | null; perSeat: boolean }>
> = {
  free: { usdPerMonth: 0, perSeat: false },
  pro: { usdPerMonth: 2, perSeat: false },
  team: { usdPerMonth: 5, perSeat: true },
  enterprise: { usdPerMonth: null, perSeat: false },
};

/** Where requests for a paid plan go. */
export const PLAN_REQUEST_EMAIL = "hello@portifact.com";

/** The `mailto:` link that requests a plan, with a subject naming it. */
export function planRequestHref(plan: PlanName): string {
  const subject = encodeURIComponent(`Portifact ${PLAN_LABELS[plan]} plan request`);
  return `mailto:${PLAN_REQUEST_EMAIL}?subject=${subject}`;
}

/** The cheapest plan that includes a feature, from `PLANS` in the order of `PLAN_NAMES`. */
export function lowestPlanWith(feature: PlanFeature): PlanName {
  // Enterprise grants every feature (a test holds it to that), so the search always finds one.
  return PLAN_NAMES.find((name) => PLANS[name].features.includes(feature)) as PlanName;
}

/** The `plan_required` message for a feature: what it is and the plan that includes it. */
export function planRequiredMessage(feature: PlanFeature): string {
  return `${PLAN_FEATURE_LABELS[feature]} is part of the ${PLAN_LABELS[lowestPlanWith(feature)]} plan.`;
}

/**
 * Changes to one owner's plan (`owner_plans.overrides`), applied after seats: a limit here is the
 * owner's total, not a per-seat value, and a feature set to true or false is added or removed.
 */
export const PlanOverrides = z
  .object({
    // A per-artifact size above the boundaries' file cap could never be used.
    limits: PlanLimits.partial()
      .extend({
        artifactBytes: count.max(LIMITS.fileBytesCap).optional(),
        archiveMonths: count.max(RETENTION_LIMIT_MAX.archiveMonths).optional(),
        retainedPreviousVersions: count
          .max(RETENTION_LIMIT_MAX.retainedPreviousVersions)
          .optional(),
        previousVersionRetentionDays: count
          .max(RETENTION_LIMIT_MAX.previousVersionRetentionDays)
          .optional(),
        accessLogRetentionDays: count.max(RETENTION_LIMIT_MAX.accessLogRetentionDays).optional(),
        auditRetentionDays: z
          .number()
          .int()
          .min(AUDIT_RETENTION_BOUNDS.minDays)
          .max(AUDIT_RETENTION_BOUNDS.maxDays)
          .optional(),
      })
      .strict()
      .optional(),
    features: z.partialRecord(PlanFeature, z.boolean()).optional(),
    /** Artifact data: the count and any per-artifact limit, within the platform's bounds. */
    data: z
      .strictObject({
        artifacts: count.optional(),
        perArtifact: ArtifactDataLimits.partial().optional(),
      })
      .optional(),
  })
  .strict();
export type PlanOverrides = z.infer<typeof PlanOverrides>;

/**
 * How long an owner keeps what its previous plan kept after its entitlements drop (decision 0022):
 * a plan that ends (`valid_until` passes), is removed or is lowered holds the previous plan's
 * retention, and lets the owner read and export what it held, for this many days from the drop.
 * New work follows the plan the owner has now.
 */
export const PLAN_GRACE_DAYS = 60;

/** At most this many drops are held at once; a later one folds the two oldest (decision 0022). */
export const PLAN_GRACE_MAX_SLOTS = 8;

/**
 * The limits that decide what an owner keeps, and how long: those a grace holds from the previous
 * plan (decision 0022). Every other limit (quotas, sizes, seats, traffic, domains) follows the
 * plan the owner has now.
 */
export const GRACE_LIMITS = [
  "archiveMonths",
  "retainedPreviousVersions",
  "previousVersionRetentionDays",
  "accessLogRetentionDays",
  "auditRetentionDays",
] as const satisfies readonly PlanLimit[];
export type GraceLimit = (typeof GRACE_LIMITS)[number];

export const GraceLimits = z.strictObject({
  archiveMonths: count.max(RETENTION_LIMIT_MAX.archiveMonths),
  retainedPreviousVersions: count.max(RETENTION_LIMIT_MAX.retainedPreviousVersions),
  previousVersionRetentionDays: count.max(RETENTION_LIMIT_MAX.previousVersionRetentionDays),
  accessLogRetentionDays: count.max(RETENTION_LIMIT_MAX.accessLogRetentionDays),
  auditRetentionDays: count.max(RETENTION_LIMIT_MAX.auditRetentionDays),
});
export type GraceLimits = z.infer<typeof GraceLimits>;

/**
 * Why a grace started: the operator lowered the plan, removed it, or it reached `valid_until`;
 * `unreadable` when a stored grace could not be read and the operator's next change stored a
 * conservative hold in its place (decision 0022, "Unreadable graces").
 */
export const GRACE_START_REASONS = ["lowered", "removed", "expired", "unreadable"] as const;
export const GraceStartReason = z.enum(GRACE_START_REASONS);
export type GraceStartReason = z.infer<typeof GraceStartReason>;

/**
 * Why a grace ended: a plan that covers it again, the operator, its 60 days passed, or it was
 * folded into a later hold past `PLAN_GRACE_MAX_SLOTS` (which keeps its values longer).
 */
export const GRACE_END_REASONS = ["renewed", "operator", "expired", "folded"] as const;
export const GraceEndReason = z.enum(GRACE_END_REASONS);
export type GraceEndReason = z.infer<typeof GraceEndReason>;

/**
 * One drop held (`owner_plans.grace`, a JSON list of these): what the previous plan kept and the
 * paid features it granted, from the drop (`from`) until `until`. `expiry` is the `valid_until`
 * a natural expiry came from, so the scan that records it does so once.
 */
/** The latest moment a `Date` can hold (milliseconds); a later value cannot be shown. */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** The grace length in milliseconds. */
export const PLAN_GRACE_MS = PLAN_GRACE_DAYS * 86_400_000;

const moment = z.number().int().nonnegative().max(MAX_DATE_MS);

export const GraceSlot = z
  .strictObject({
    plan: PlanName,
    reason: GraceStartReason,
    from: moment,
    until: moment,
    limits: GraceLimits,
    features: z.array(PlanFeature),
    expiry: moment.optional(),
    /** How many holds were folded into this one past `PLAN_GRACE_MAX_SLOTS` (2 or more). */
    folded: z.number().int().min(2).max(10_000).optional(),
  })
  // A hold lasts at most the grace length from its drop: none can be held forever.
  .refine((slot) => slot.from <= slot.until && slot.until - slot.from <= PLAN_GRACE_MS, {
    message: "A grace slot lasts at most the grace length from its drop.",
  });
export type GraceSlot = z.infer<typeof GraceSlot>;

export const GraceSlots = z.array(GraceSlot).max(PLAN_GRACE_MAX_SLOTS);

/**
 * The three emails of a hold (decision 0022, third delivery), from the first to the most urgent:
 * when it starts, when 14 days or less are left, when 3 days or less are left.
 */
export const GRACE_NOTICE_MOMENTS = ["start", "two_weeks", "three_days"] as const;
export const GraceNoticeMoment = z.enum(GRACE_NOTICE_MOMENTS);
export type GraceNoticeMoment = z.infer<typeof GraceNoticeMoment>;

/** Time left at which each later moment is due. */
export const GRACE_NOTICE_LEAD_MS = {
  two_weeks: 14 * 86_400_000,
  three_days: 3 * 86_400_000,
} as const;

/**
 * How many times a job waits for its mark (written right after it, with a separate regional
 * database), a few minutes each, before it counts as the job of a scan that crashed.
 */
export const GRACE_NOTICE_MARK_WAITS = 6;

/** The per-scan token that ties a scheduled email to its mark (decision 0022, "At most once"). */
const claim = z.string().min(1).max(64);

/**
 * The latest email a hold got, identified by its `from` and `until` (a fold keeps both), and the
 * token of the scan that scheduled it: only the job carrying that token sends it.
 */
export const GraceNoticeMark = z.strictObject({
  from: moment,
  until: moment,
  moment: GraceNoticeMoment,
  claim: claim.optional(),
  /**
   * Set instead of an email for a hold whose end lets nothing go (another hold covers it): how
   * many holds were stored when that was decided. The scan skips the hold while the grace still
   * stores that many; any change to the holds makes it decide again.
   */
  covered: z.number().int().min(1).max(PLAN_GRACE_MAX_SLOTS).optional(),
});
export type GraceNoticeMark = z.infer<typeof GraceNoticeMark>;

/** `owner_plans.grace_notices`: one mark per live hold that got an email. */
export const GraceNoticeMarks = z.array(GraceNoticeMark).max(PLAN_GRACE_MAX_SLOTS);
export type GraceNoticeMarks = z.infer<typeof GraceNoticeMarks>;

/**
 * Payload of a `plan_grace_notice` job (its subject is the owner): the hold, its moment and the
 * scan's token, which the owner's mark must still hold when the job sends.
 */
export const GraceNoticePayload = z.strictObject({
  from: moment,
  until: moment,
  moment: GraceNoticeMoment,
  claim,
  /** How many times the job waited for its mark to land (separate regional database). */
  waits: z.number().int().min(1).max(GRACE_NOTICE_MARK_WAITS).optional(),
  /**
   * For a last warning put back after capacity ran out partway: the accounts still to be told
   * (opaque IDs, rechecked against the owner's recipients when it runs). Absent: every recipient.
   */
  recipients: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
});
export type GraceNoticePayload = z.infer<typeof GraceNoticePayload>;

/**
 * A running grace as the usage endpoint, `portifact usage`, `get_usage` and the account export
 * show it: until when, the highest plan held, what it keeps and the paid features whose data the
 * owner can still read and export (only those the plan it has now does not grant).
 */
export const PlanGraceView = z.object({
  until: z.iso.datetime(),
  plan: PlanName,
  limits: GraceLimits,
  features: z.array(PlanFeature),
});
export type PlanGraceView = z.infer<typeof PlanGraceView>;

/**
 * What a running grace will let go, per kind (decision 0022, second delivery): previous versions
 * the plan the owner has now does not keep, access log entries and analytics day counters that
 * expire by then, audit events past the plan's retention, and pinned artifacts that are unpinned.
 */
export const GRACE_FORECAST_KINDS = [
  "versions",
  "accessLog",
  "analytics",
  "auditEvents",
  "pins",
] as const;
export const GraceForecastKind = z.enum(GRACE_FORECAST_KINDS);
export type GraceForecastKind = z.infer<typeof GraceForecastKind>;

/**
 * `GET /api/v1/grace-forecast`: the running grace, or null, and one entry per step in which a
 * kind loses something: how many items and from when (the end of a hold at which the retention in
 * force for that kind drops; a kind can have several, ordered by date). Counts only: no names, no
 * IDs.
 */
export const GraceForecastView = z.object({
  /**
   * The space's owner, opaque (an account's or a workspace's ID): `portifact export` writes it in
   * its folder's marker, so an export of another space is never mixed into the same folder.
   */
  ownerId: z.string().min(1).max(200),
  grace: PlanGraceView.nullable(),
  kinds: z.array(
    z.object({
      kind: GraceForecastKind,
      count: z.number().int().nonnegative(),
      from: z.iso.datetime(),
    }),
  ),
});
export type GraceForecastView = z.infer<typeof GraceForecastView>;

/** How often one person or token may ask for a space's forecast (`rate_limits`, per minute). */
export const GRACE_FORECAST_LIMITS = { perActorPerMinute: 30 } as const;

/**
 * The owner's effective plan as the usage endpoint, `portifact usage`, `get_usage` and the
 * account export show it. An expired plan reads as `free`, with `validUntil` null. During a grace
 * the retention limits are the previous plan's (decision 0022) and `grace` says until when.
 */
export const PlanView = z.object({
  name: PlanName,
  /** When the plan ends and the owner goes back to `free`; null when it does not end. */
  validUntil: z.iso.datetime().nullable(),
  seats: z.number().int().min(1),
  limits: PlanLimits,
  /** Features the plan grants, in the order of PLAN_FEATURES. */
  features: z.array(PlanFeature),
  /** The running grace after a plan dropped, or null; absent from servers before it. */
  grace: PlanGraceView.nullable().optional(),
});
export type PlanView = z.infer<typeof PlanView>;

/**
 * One owner's plan as `export-plans` writes it before a D1 Time Travel restore and `apply-plans`
 * grants it again after (docs/operations.md): the restore rewinds `owner_plans`, and plans are
 * not tombstones, so the operator carries them across.
 */
export const OwnerPlanExport = z.strictObject({
  ownerId: z.string().min(1).max(200),
  plan: PlanName,
  seats: z.number().int().min(1),
  validUntil: z.number().int().nonnegative().nullable(),
  overrides: PlanOverrides.nullable(),
  grantedBy: z.string().min(1).max(200),
  note: z.string().max(500).nullable(),
  /** The drops still held (decision 0022); absent in exports made before graces existed. */
  grace: GraceSlots.nullable().optional(),
  /** The grace emails already sent; absent in exports made before them. */
  graceNotices: GraceNoticeMarks.nullable().optional(),
});
export type OwnerPlanExport = z.infer<typeof OwnerPlanExport>;
