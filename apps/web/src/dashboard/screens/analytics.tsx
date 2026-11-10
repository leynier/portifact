// The Analytics section of the artifact page (premium plan P8): page views per UTC day as a
// chart with the same numbers in a table, and the totals of the range. The API decides who may
// read them and whether the owner's plan includes them; for an owner without the feature this
// says what the paid plans add, from the API's own `plan_required` answer, never from the
// signed-in user's plan.
import { type ArtifactStatsView, lowestPlanWith, PLAN_LABELS } from "@portifact/contracts";
import {
  BarChart,
  Button,
  Callout,
  DetailList,
  Disclosure,
  LoadingState,
  Panel,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useDashboard, useFormatDay, useFormatNumber, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { errorMessage } from "./artifact-list.tsx";

const RANGES = ["7", "30", "90", "365"] as const;
type Range = (typeof RANGES)[number];
const DAY_MS = 86_400_000;

export const statsQuery = (artifactId: string, days: Range) =>
  ["artifact", artifactId, "stats", days] as const;

/** The first UTC day of the last `days` days, today included. */
export function rangeStart(days: number, now: number): string {
  const today = now - (now % DAY_MS);
  return new Date(today - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function Analytics({ artifactId }: { artifactId: string }) {
  const t = useT();
  const { api } = useDashboard();
  const [days, setDays] = useState<Range>("30");
  const stats = useQuery({
    queryKey: statsQuery(artifactId, days),
    queryFn: () => api.stats(artifactId, rangeStart(Number(days), Date.now())),
    ...refreshOptions,
  });

  const planRequired = stats.error instanceof ApiFailure && stats.error.code === "plan_required";
  let body: ReactNode;
  if (stats.isPending) {
    body = <LoadingState label={t("analytics.loading")} />;
  } else if (planRequired) {
    body = (
      <p className="text-sm text-text-muted">
        {t("analytics.planRequired", { plan: PLAN_LABELS[lowestPlanWith("analytics")] })}
      </p>
    );
  } else if (stats.isError && !stats.data) {
    body = (
      <Callout
        tone="error"
        title={t("analytics.error.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => stats.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, stats.error)}
      </Callout>
    );
  } else if (stats.data) {
    body = (
      <div className="flex flex-col gap-4">
        <Select<Range>
          label={t("analytics.range.label")}
          value={days}
          options={RANGES.map((value) => ({
            value,
            label: t("analytics.range.days", { count: Number(value) }),
          }))}
          onChange={setDays}
        />
        <StatsBody stats={stats.data} />
      </div>
    );
  }

  return (
    <Panel
      id="analytics"
      headingLevel={3}
      title={t("analytics.title")}
      description={planRequired ? undefined : t("analytics.hint")}
    >
      {body}
    </Panel>
  );
}

function StatsBody({ stats }: { stats: ArtifactStatsView }) {
  const t = useT();
  const formatDay = useFormatDay();
  const formatNumber = useFormatNumber();
  const logged = stats.totals.visitors !== null;
  const busiest = stats.days.reduce(
    (best, day) => (day.views > (best?.views ?? 0) ? day : best),
    undefined as ArtifactStatsView["days"][number] | undefined,
  );
  const describe = (day: ArtifactStatsView["days"][number]) =>
    logged
      ? t("analytics.chart.dayWithVisitors", {
          day: formatDay(day.date, true),
          views: day.views,
          signedIn: day.signedInViews,
          visitors: day.visitors ?? 0,
        })
      : t("analytics.chart.day", {
          day: formatDay(day.date, true),
          views: day.views,
          signedIn: day.signedInViews,
        });
  const summary = busiest
    ? t("analytics.chart.summary", {
        views: stats.totals.views,
        days: stats.days.length,
        busiest: formatDay(busiest.date, true),
        most: busiest.views,
      })
    : t("analytics.chart.summaryEmpty", { days: stats.days.length });

  const totals = [
    { term: t("analytics.total.views"), detail: formatNumber(stats.totals.views) },
    { term: t("analytics.total.signedIn"), detail: formatNumber(stats.totals.signedInViews) },
    {
      term: t("analytics.total.visitors"),
      detail:
        stats.totals.visitors === null
          ? t("analytics.visitors.notKept")
          : formatNumber(stats.totals.visitors),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DetailList items={totals} />
      <BarChart
        label={t("analytics.chart.label")}
        summary={summary}
        keyboardHint={t("analytics.chart.keyboard")}
        data={stats.days.map((day) => ({
          key: day.date,
          label: formatDay(day.date),
          value: day.views,
          description: describe(day),
        }))}
      />
      <Disclosure summary={t("analytics.table.show")}>
        <Table caption={t("analytics.table.caption")} variant="flush">
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("analytics.column.day")}</TableHeaderCell>
              <TableHeaderCell>{t("analytics.column.views")}</TableHeaderCell>
              <TableHeaderCell>{t("analytics.column.signedIn")}</TableHeaderCell>
              {logged ? <TableHeaderCell>{t("analytics.column.visitors")}</TableHeaderCell> : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {stats.days.map((day) => (
              <TableRow key={day.date}>
                <TableCell>
                  <span className="whitespace-nowrap">{formatDay(day.date, true)}</span>
                </TableCell>
                <TableCell>
                  <span className="tabular-nums">{formatNumber(day.views)}</span>
                </TableCell>
                <TableCell>
                  <span className="tabular-nums">{formatNumber(day.signedInViews)}</span>
                </TableCell>
                {logged ? (
                  <TableCell>
                    <span className="tabular-nums">{formatNumber(day.visitors ?? 0)}</span>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Disclosure>
      <p className="text-xs text-text-muted">
        {t("analytics.note", { days: stats.retentionDays })}
      </p>
    </div>
  );
}
