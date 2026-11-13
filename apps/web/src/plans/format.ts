// What the pricing section and the dashboard's Plan page show of each plan, read from `PLANS`
// and formatted with the page's language, so neither can drift from what the product enforces.
// Pure: the landing's build and the dashboard both call it.
import {
  PLAN_LABELS,
  PLAN_NAMES,
  PLAN_PRICES,
  PLANS,
  type PlanFeature,
  type PlanLimit,
  type PlanLimits,
  type PlanName,
  planFeatureStatus,
  planRequestHref,
} from "@portifact/contracts/plans";
import type { PlanText } from "./i18n/en.ts";

/** A row of the comparison: one limit, or the previous versions (a count kept for a time). */
export type PlanLimitRow =
  | "activeArtifacts"
  | "artifactBytes"
  | "accountBytes"
  | "requestsPerMonth"
  | "bytesPerMonth"
  | "archiveMonths"
  | "previousVersions"
  | "accessLogRetentionDays"
  | "annotationMessages";

export const PLAN_LIMIT_ROWS: readonly PlanLimitRow[] = [
  "activeArtifacts",
  "artifactBytes",
  "accountBytes",
  "requestsPerMonth",
  "bytesPerMonth",
  "archiveMonths",
  "previousVersions",
  "accessLogRetentionDays",
  "annotationMessages",
];

/** The limit a row reads its "per seat" flag from. */
const ROW_LIMIT: Readonly<Record<PlanLimitRow, PlanLimit>> = {
  activeArtifacts: "activeArtifacts",
  artifactBytes: "artifactBytes",
  accountBytes: "accountBytes",
  requestsPerMonth: "requestsPerMonth",
  bytesPerMonth: "bytesPerMonth",
  archiveMonths: "archiveMonths",
  previousVersions: "retainedPreviousVersions",
  accessLogRetentionDays: "accessLogRetentionDays",
  annotationMessages: "annotationMessages",
};

/** Replaces each `{name}` of a message with its value. */
export function fill(message: string, values: Readonly<Record<string, string>>): string {
  return message.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

const BYTE_UNITS = [
  { unit: "terabyte", size: 1e12 },
  { unit: "gigabyte", size: 1e9 },
  { unit: "megabyte", size: 1e6 },
  { unit: "kilobyte", size: 1e3 },
] as const;

/** A size in decimal units, like the product's limits: 1 GB is 1,000,000,000 bytes. */
export function formatPlanBytes(bytes: number, locale: string): string {
  const scale = BYTE_UNITS.find((entry) => bytes >= entry.size);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: scale ? scale.unit : "byte",
    unitDisplay: scale ? "short" : "long",
    maximumFractionDigits: 1,
  }).format(scale ? bytes / scale.size : bytes);
}

function formatDuration(value: number, unit: "day" | "month" | "year", locale: string): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/** Days as years when they are whole years (365 days is "1 year"), otherwise as days. */
export function formatPlanDays(days: number, locale: string): string {
  return days > 0 && days % 365 === 0
    ? formatDuration(days / 365, "year", locale)
    : formatDuration(days, "day", locale);
}

/**
 * One limit of a plan as the page shows it. `perSeat` names the limits given per seat; their
 * value is the plan's per-seat value, marked as such.
 */
export function formatPlanLimit(
  row: PlanLimitRow,
  limits: PlanLimits,
  perSeat: readonly PlanLimit[],
  locale: string,
  text: PlanText,
): string {
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  let value: string;
  switch (row) {
    case "artifactBytes":
    case "accountBytes":
    case "bytesPerMonth":
      value = formatPlanBytes(limits[row], locale);
      break;
    case "archiveMonths":
      value = formatDuration(limits.archiveMonths, "month", locale);
      break;
    case "accessLogRetentionDays":
      value = formatPlanDays(limits.accessLogRetentionDays, locale);
      break;
    case "previousVersions":
      value = fill(text["plans.value.versions"], {
        count: count(limits.retainedPreviousVersions),
        duration: formatPlanDays(limits.previousVersionRetentionDays, locale),
      });
      break;
    default:
      value = count(limits[row]);
  }
  return perSeat.includes(ROW_LIMIT[row]) ? fill(text["plans.perSeat"], { value }) : value;
}

/** A plan's price: the amount in US dollars and what it is for, or "Contact us". */
export function formatPlanPrice(
  plan: PlanName,
  locale: string,
  text: PlanText,
): { amount: string; unit: string } {
  const { usdPerMonth, perSeat } = PLAN_PRICES[plan];
  if (usdPerMonth === null) return { amount: text["plans.price.contact"], unit: "" };
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(usdPerMonth);
  return {
    amount,
    unit: perSeat ? text["plans.price.perSeatPerMonth"] : text["plans.price.perMonth"],
  };
}

/** The name of a paid feature in the page's language. */
export function featureName(feature: PlanFeature, text: PlanText): string {
  return text[`plans.feature.${feature}`];
}

/** Everything a plan's card shows, in one language; the caller adds the call to action. */
export interface PlanSummary {
  plan: PlanName;
  name: string;
  summary: string;
  price: { amount: string; unit: string };
  included: string[];
  comingSoon: string[];
}

export function planSummary(plan: PlanName, locale: string, text: PlanText): PlanSummary {
  const { available, comingSoon } = planFeatureStatus(plan);
  return {
    plan,
    name: PLAN_LABELS[plan],
    summary: text[`plans.summary.${plan}`],
    price: formatPlanPrice(plan, locale, text),
    // Free has no paid features: it says what every account can do instead.
    included:
      plan === "free"
        ? [text["plans.includedFree"]]
        : available.map((feature) => featureName(feature, text)),
    comingSoon: comingSoon.map((feature) => featureName(feature, text)),
  };
}

/**
 * A plan's artifact data (decision 0026): how many artifacts may hold data and the size of each.
 * Not a paid feature and not available yet, so its row says it is coming soon.
 */
export function formatPlanData(plan: PlanName, locale: string, text: PlanText): string {
  const { artifacts, perArtifact } = PLANS[plan].data;
  return fill(text["plans.value.artifactData"], {
    count: new Intl.NumberFormat(locale).format(artifacts),
    size: formatPlanBytes(perArtifact.bytesPerArtifact, locale),
  });
}

/** The comparison of every plan's limits: one row per limit, one cell per plan. */
export function planComparison(
  locale: string,
  text: PlanText,
): {
  row: PlanLimitRow | "artifactData";
  label: string;
  cells: { plan: PlanName; value: string }[];
}[] {
  return [
    ...PLAN_LIMIT_ROWS.map((row) => ({
      row,
      label: text[`plans.limit.${row}`],
      cells: PLAN_NAMES.map((plan) => ({
        plan,
        value: formatPlanLimit(row, PLANS[plan].limits, PLANS[plan].perSeat, locale, text),
      })),
    })),
    {
      row: "artifactData" as const,
      label: fill(text["plans.limit.withSoon"], {
        label: text["plans.limit.artifactData"],
        soon: text["plans.comingSoon"],
      }),
      cells: PLAN_NAMES.map((plan) => ({ plan, value: formatPlanData(plan, locale, text) })),
    },
  ];
}

/** The call to action of a paid plan: the request email, named for the plan. */
export function planRequest(
  plan: PlanName,
  text: PlanText,
): {
  href: string;
  label: string;
  accessibleName: string;
} {
  return {
    href: planRequestHref(plan),
    label: text["plans.action.request"],
    accessibleName: fill(text["plans.action.requestLabel"], { plan: PLAN_LABELS[plan] }),
  };
}
