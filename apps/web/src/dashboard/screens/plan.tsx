// The plan of the current space (`/plan`, premium plan L5): the plan the owner is on with its
// effective limits and features, from the usage endpoint's `plan` block, and every plan for
// comparison from `PLANS`. There is no checkout: a paid plan is requested by email, and only a
// role that could act on it (an admin, the role action `plan`) is offered the request. Features a
// plan has but the product does not offer yet are shown as coming soon (`AVAILABLE_PLAN_FEATURES`).

import { useLingui } from "@lingui/react";
import type { PlanView } from "@portifact/contracts";
import {
  PLAN_LABELS,
  PLAN_NAMES,
  type PlanFeature,
  type PlanName,
  planFeatureAvailable,
} from "@portifact/contracts/plans";
import {
  buttonClasses,
  Callout,
  DetailList,
  PageHeader,
  PlanCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from "@portifact/ui";
import { Link } from "@tanstack/react-router";
import { Clock, Lock } from "lucide-react";
import { useMemo } from "react";
import {
  featureName,
  formatPlanLimit,
  PLAN_LIMIT_ROWS,
  planComparison,
  planRequest,
  planSummary,
} from "../../plans/format.ts";
import { type PlanText, type PlanTextKey, planTextEn } from "../../plans/i18n/en.ts";
import { useFormatDate, useFormatNumber, useT } from "../context.tsx";
import { type Space, spaceCan, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { SpaceBadge } from "./space-parts.tsx";
import { useUsage } from "./usage.tsx";

/** Arguments the plan text fills itself, kept as placeholders when read through Lingui. */
const PLACEHOLDERS = {
  value: "{value}",
  count: "{count}",
  duration: "{duration}",
  plan: "{plan}",
};

/** The plans' text in the dashboard's language, from its catalog, and that language. */
function usePlanText(): { text: PlanText; locale: string } {
  const t = useT();
  const { i18n } = useLingui();
  const locale = i18n.locale;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text changes with the language.
  const text = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(planTextEn) as PlanTextKey[]).map((key) => [key, t(key, PLACEHOLDERS)]),
      ) as PlanText,
    [t, locale],
  );
  return { text, locale };
}

export function PlanScreen() {
  const t = useT();
  useDocumentTitle(t("plan.title"));
  const space = useReadySpace();
  const canSee = spaceCan(space, "usage");
  const usage = useUsage(space.slug, canSee);
  const workspace = space.kind === "workspace" ? space.name : "";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("plan.title")}
        meta={<SpaceBadge owner={space} />}
        description={
          space.kind === "workspace"
            ? t("plan.descriptionWorkspace", { workspace })
            : t("plan.description")
        }
      />
      {canSee ? (
        <Loaded query={usage} loading={t("plan.loading")} error={t("plan.error")}>
          {(view) => (
            <>
              {view.plan.grace ? (
                <PlanGrace grace={view.plan.grace} canRequest={spaceCan(space, "plan")} />
              ) : null}
              <CurrentPlan plan={view.plan} />
            </>
          )}
        </Loaded>
      ) : (
        <Callout title={t("space.notAllowed.title")} icon={<Lock className="size-5" />}>
          {t("plan.hidden", { workspace })}
        </Callout>
      )}
      <AllPlans space={space} current={usage.data?.plan.name} />
    </div>
  );
}

/**
 * A running grace (decision 0022): until when what the previous plan kept is held, what it keeps,
 * the reads still open, and the two ways forward: take the data out, or ask for the plan again.
 */
function PlanGrace({
  grace,
  canRequest,
}: {
  grace: NonNullable<PlanView["grace"]>;
  canRequest: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const { text } = usePlanText();
  const request = planRequest(grace.plan, text);
  const features = grace.features.map((feature) => featureName(feature, text));
  return (
    <Callout
      title={t("plan.grace.title", {
        plan: PLAN_LABELS[grace.plan],
        date: formatDate(grace.until, true),
      })}
      icon={<Clock className="size-5" />}
      action={
        canRequest ? (
          <a
            href={request.href}
            aria-label={request.accessibleName}
            className={buttonClasses({ intent: "secondary" })}
          >
            {request.label}
          </a>
        ) : undefined
      }
    >
      <p>
        {t("plan.grace.body", {
          versions: grace.limits.retainedPreviousVersions,
          days: grace.limits.previousVersionRetentionDays,
          log: grace.limits.accessLogRetentionDays,
        })}
      </p>
      {features.length > 0 ? (
        <p className="mt-1">{t("plan.grace.reads", { features: features.join(", ") })}</p>
      ) : null}
      <p className="mt-1">{t("plan.grace.download")}</p>
    </Callout>
  );
}

/** The space's plan as the API applies it: seats and overrides included. */
function CurrentPlan({ plan }: { plan: PlanView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatNumber = useFormatNumber();
  const { text, locale } = usePlanText();
  const items = [{ term: t("usage.plan.name"), detail: PLAN_LABELS[plan.name] }];
  if (plan.seats > 1) items.push({ term: t("usage.plan.seats"), detail: formatNumber(plan.seats) });
  if (plan.validUntil !== null) {
    items.push({ term: t("usage.plan.until"), detail: formatDate(plan.validUntil, true) });
  }
  const features = (soon: boolean) =>
    plan.features
      .filter((feature: PlanFeature) => planFeatureAvailable(feature) !== soon)
      .map((feature) => featureName(feature, text));
  const included = features(false);
  const comingSoon = features(true);
  return (
    <Section id="current" title={text["plans.current"]} hint={t("plan.current.hint")}>
      <div className="flex flex-col gap-6">
        <DetailList framed={false} items={items} />
        {/* The limits are the owner's totals: seats are already counted in. */}
        <Table caption={t("plan.current.limits")} variant="flush" stacked>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{text["plans.table.limit"]}</TableHeaderCell>
              <TableHeaderCell>{PLAN_LABELS[plan.name]}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {PLAN_LIMIT_ROWS.map((row) => (
              <TableRow key={row}>
                <TableRowHeader>{text[`plans.limit.${row}`]}</TableRowHeader>
                <TableCell>{formatPlanLimit(row, plan.limits, [], locale, text)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <FeatureLists
          included={included}
          comingSoon={comingSoon}
          includedLabel={text["plans.included"]}
          comingSoonLabel={text["plans.comingSoon"]}
        />
        <p>
          <Link to="/usage" className="font-semibold">
            {t("plan.current.usageLink")}
          </Link>
        </p>
      </div>
    </Section>
  );
}

function FeatureLists({
  included,
  comingSoon,
  includedLabel,
  comingSoonLabel,
}: {
  included: string[];
  comingSoon: string[];
  includedLabel: string;
  comingSoonLabel: string;
}) {
  if (included.length === 0 && comingSoon.length === 0) return null;
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {[
        { label: includedLabel, items: included },
        { label: comingSoonLabel, items: comingSoon },
      ]
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.label}>
            <h3 className="text-sm font-medium">{group.label}</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

/** Every plan side by side, with the request for a paid one where the role may make it. */
function AllPlans({ space, current }: { space: Space; current: PlanName | undefined }) {
  const t = useT();
  const { text, locale } = usePlanText();
  const canRequest = spaceCan(space, "plan");
  const action = (plan: PlanName) => {
    if (plan === "free" || plan === current || !canRequest) return undefined;
    const request = planRequest(plan, text);
    return (
      <a
        href={request.href}
        aria-label={request.accessibleName}
        className={buttonClasses({ intent: "secondary" })}
      >
        {request.label}
      </a>
    );
  };
  return (
    <Section id="plans" title={t("plan.compare.section")} hint={text["plans.price.note"]}>
      <div className="flex flex-col gap-6">
        {canRequest ? null : (
          <Callout title={t("space.notAllowed.title")} icon={<Lock className="size-5" />}>
            {t("plan.requestNote", { workspace: space.kind === "workspace" ? space.name : "" })}
          </Callout>
        )}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 2xl:grid-cols-4">
          {PLAN_NAMES.map((plan) => {
            const summary = planSummary(plan, locale, text);
            return (
              <PlanCard
                key={plan}
                id={plan}
                name={summary.name}
                summary={summary.summary}
                price={summary.price}
                includedLabel={text["plans.included"]}
                included={summary.included}
                comingSoonLabel={text["plans.comingSoon"]}
                comingSoon={summary.comingSoon}
                currentLabel={plan === current ? text["plans.current"] : undefined}
                action={action(plan)}
              />
            );
          })}
        </div>
        <Table caption={text["plans.table.caption"]} variant="flush">
          <TableHead>
            <TableRow>
              <TableHeaderCell>{text["plans.table.limit"]}</TableHeaderCell>
              {PLAN_NAMES.map((plan) => (
                <TableHeaderCell key={plan}>{PLAN_LABELS[plan]}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {planComparison(locale, text).map(({ row, label, cells }) => (
              <TableRow key={row}>
                <TableRowHeader>{label}</TableRowHeader>
                {cells.map((cell) => (
                  <TableCell key={cell.plan}>{cell.value}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}
