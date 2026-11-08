// Account usage in the dashboard (plan sections 6 "Uso" and 12): the main quotas, this month's
// traffic, and what blocks the account now. When the traffic quota is used up, every artifact of
// the account answers 429, and the dashboard says so on the artifact list and the account page.
import type { AccountUsageView, UsageBlock } from "@portifact/contracts";
import { buttonClasses, Callout, DetailList, Meter } from "@portifact/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Gauge } from "lucide-react";
import { useDashboard, useFormatBytes, useFormatDate, useFormatNumber, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";

export const USAGE_QUERY = ["usage"] as const;

export function useUsage() {
  const { api } = useDashboard();
  return useQuery({ queryKey: USAGE_QUERY, queryFn: () => api.usage(), ...refreshOptions });
}

export function trafficBlock(usage: AccountUsageView | undefined): UsageBlock | undefined {
  return usage?.blocks.find((block) => block.reason === "traffic");
}

/** Explains the 429 state, with a link to the usage section when shown elsewhere. */
export function TrafficNotice({ block, link }: { block: UsageBlock; link?: boolean }) {
  const t = useT();
  const formatDate = useFormatDate();
  return (
    <Callout
      title={t("usage.traffic.title")}
      icon={<Gauge className="size-5" />}
      action={
        link ? (
          <Link to="/account" hash="usage" className={buttonClasses({ intent: "secondary" })}>
            {t("usage.traffic.link")}
          </Link>
        ) : undefined
      }
    >
      {t("usage.traffic.body", { date: block.until ? formatDate(block.until, true) : "" })}
    </Callout>
  );
}

/** The usage section of the account page. */
export function UsageDetails({ usage }: { usage: AccountUsageView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatBytes = useFormatBytes();
  const formatNumber = useFormatNumber();
  const traffic = trafficBlock(usage);
  const others = usage.blocks.filter((block) => block.reason !== "traffic");
  const meter = (used: string, limit: string) => t("usage.meter", { used, limit });
  const count = (m: { used: number; limit: number }) =>
    meter(formatNumber(m.used), formatNumber(m.limit));
  const bytes = (m: { used: number; limit: number }) =>
    meter(formatBytes(m.used), formatBytes(m.limit));
  const limits = { nearLimitLabel: t("usage.nearLimit"), atLimitLabel: t("usage.atLimit") };

  return (
    <>
      {traffic ? (
        <div className="mb-4">
          <TrafficNotice block={traffic} />
        </div>
      ) : null}
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        <Meter
          label={t("usage.activeArtifacts")}
          value={usage.activeArtifacts.used}
          max={usage.activeArtifacts.limit}
          valueText={count(usage.activeArtifacts)}
          {...limits}
        />
        <Meter
          label={t("usage.storage")}
          value={usage.storage.used + usage.storage.reserved}
          max={usage.storage.limit}
          valueText={meter(
            formatBytes(usage.storage.used + usage.storage.reserved),
            formatBytes(usage.storage.limit),
          )}
          {...limits}
        />
        <Meter
          label={t("usage.publishes")}
          value={usage.publishesLast24h.used}
          max={usage.publishesLast24h.limit}
          valueText={count(usage.publishesLast24h)}
          {...limits}
        />
        <Meter
          label={t("usage.trafficRequests")}
          value={usage.trafficThisMonth.requests.used}
          max={usage.trafficThisMonth.requests.limit}
          valueText={count(usage.trafficThisMonth.requests)}
          {...limits}
        />
        <Meter
          label={t("usage.trafficBytes")}
          value={usage.trafficThisMonth.bytes.used}
          max={usage.trafficThisMonth.bytes.limit}
          valueText={bytes(usage.trafficThisMonth.bytes)}
          {...limits}
        />
      </div>
      <div className="mt-6 border-t border-border pt-4">
        <DetailList
          layout="stacked"
          framed={false}
          items={[
            {
              term: t("usage.trafficResets"),
              detail: formatDate(usage.trafficThisMonth.resetsAt, true),
            },
          ]}
        />
      </div>
      {others.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-semibold">{t("usage.blocks")}</h3>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {others.map((block) => (
              <li key={block.reason}>
                {block.until
                  ? t("usage.lifts", {
                      message: block.message,
                      date: formatDate(block.until, true),
                    })
                  : block.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
