// English text of the plans, shared by the landing's pricing section (built per language by
// src/i18n/site.ts) and the dashboard's Plan page (spread into each dashboard catalog). Messages
// use only plain `{name}` arguments, so the static build and Lingui read them the same way.
// Feature names are `PLAN_FEATURE_LABELS`, the words every `plan_required` message uses.
import { PLAN_FEATURE_LABELS, type PlanFeature } from "@portifact/contracts/plans";

export const planTextEn = {
  "plans.price.perMonth": "per month",
  "plans.price.perSeatPerMonth": "per seat per month",
  "plans.price.contact": "Contact us",
  "plans.price.note":
    "Prices are in US dollars and exclude taxes. There is no checkout yet: paid plans are granted after a request by email.",
  "plans.summary.free": "For personal work and for trying Portifact",
  "plans.summary.pro": "For one person who shares often",
  "plans.summary.team": "For teams that publish together",
  "plans.summary.enterprise": "For organizations that need their own terms",
  "plans.included": "Included",
  "plans.includedFree": "Publishing, access control, versions, comments and review",
  "plans.comingSoon": "Coming soon",
  "plans.action.free": "Sign in to start",
  "plans.action.request": "Request access",
  "plans.action.requestLabel": "Request access to the {plan} plan",
  "plans.current": "Current plan",
  "plans.table.caption": "Limits of each plan",
  "plans.table.limit": "Limit",
  "plans.perSeat": "{value} per seat",
  "plans.limit.activeArtifacts": "Active artifacts",
  "plans.limit.artifactBytes": "Size per artifact",
  "plans.limit.accountBytes": "Storage",
  "plans.limit.requestsPerMonth": "Requests per month",
  "plans.limit.bytesPerMonth": "Data served per month",
  "plans.limit.archiveMonths": "Time in the archive",
  "plans.limit.previousVersions": "Previous versions kept",
  "plans.limit.accessLogRetentionDays": "Access log kept for",
  "plans.limit.annotationMessages": "Comments",
  "plans.value.versions": "{count} for {duration}",
  ...(Object.fromEntries(
    Object.entries(PLAN_FEATURE_LABELS).map(([feature, label]) => [
      `plans.feature.${feature}`,
      label,
    ]),
  ) as Record<`plans.feature.${PlanFeature}`, string>),
};

export type PlanTextKey = keyof typeof planTextEn;

/** The plans' text in one language: every key of the English text, and nothing else. */
export type PlanText = { readonly [key in PlanTextKey]: string };
