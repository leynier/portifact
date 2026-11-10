// Plans and what they grant (premium plan section 3, "F1 Planes y derechos por dueño", and
// section 8): every owner has one plan, and the plan decides its product limits and features. An
// owner without a plan row is on `free`, whose values are exactly the constants in limits.ts.
// Safety caps that are not product tiers (readers per artifact, body sizes, multipart, files per
// version, rate windows) stay constants there. The effective values for one owner come from
// `entitlements` in @portifact/domain.
import { z } from "zod";
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
 * The limits a plan sets. Sizes are decimal bytes. `bytesPerMonth` is the traffic served, an
 * abuse cap. Archive, version, access-log and domain values are carried for later features;
 * nothing applies them yet.
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
  })
  .strict();
export type PlanLimits = z.infer<typeof PlanLimits>;
export type PlanLimit = keyof PlanLimits;

export interface PlanDefinition {
  limits: PlanLimits;
  /** Limits given per seat and pooled across the owner: the effective value is limit × seats. */
  perSeat: readonly PlanLimit[];
  features: readonly PlanFeature[];
}

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
    },
    perSeat: [],
    features: [],
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
    },
    perSeat: [],
    features: PRO_FEATURES,
  },
  team: { limits: TEAM_LIMITS, perSeat: TEAM_PER_SEAT, features: TEAM_FEATURES },
  // Enterprise starts from Team's values; a contract changes them through overrides.
  enterprise: { limits: TEAM_LIMITS, perSeat: TEAM_PER_SEAT, features: PLAN_FEATURES },
};

/**
 * Changes to one owner's plan (`owner_plans.overrides`), applied after seats: a limit here is the
 * owner's total, not a per-seat value, and a feature set to true or false is added or removed.
 */
export const PlanOverrides = z
  .object({
    limits: PlanLimits.partial().strict().optional(),
    features: z.partialRecord(PlanFeature, z.boolean()).optional(),
  })
  .strict();
export type PlanOverrides = z.infer<typeof PlanOverrides>;

/**
 * The owner's effective plan as the usage endpoint, `portifact usage`, `get_usage` and the
 * account export show it. An expired plan reads as `free`, with `validUntil` null.
 */
export const PlanView = z.object({
  name: PlanName,
  /** When the plan ends and the owner goes back to `free`; null when it does not end. */
  validUntil: z.iso.datetime().nullable(),
  seats: z.number().int().min(1),
  limits: PlanLimits,
  /** Features the plan grants, in the order of PLAN_FEATURES. */
  features: z.array(PlanFeature),
});
export type PlanView = z.infer<typeof PlanView>;
