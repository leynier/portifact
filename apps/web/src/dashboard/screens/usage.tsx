// Account usage in the dashboard (plan sections 6 "Uso" and 12): the main quotas, this month's
// traffic, and what blocks the account now. When the traffic quota is used up, every artifact of
// the account answers 429, and the dashboard says so on the artifact list and the account page.
import type { AccountUsageView, UsageBlock } from "@portifact/contracts";
import { buttonClasses, Callout, DetailList } from "@portifact/ui";
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

  return (
    <>
      {traffic ? (
        <div className="mb-4">
          <TrafficNotice block={traffic} />
        </div>
      ) : null}
      <DetailList
        items={[
          { term: t("usage.activeArtifacts"), detail: count(usage.activeArtifacts) },
          {
            term: t("usage.storage"),
            detail: meter(
              formatBytes(usage.storage.used + usage.storage.reserved),
              formatBytes(usage.storage.limit),
            ),
          },
          { term: t("usage.publishes"), detail: count(usage.publishesLast24h) },
          { term: t("usage.trafficRequests"), detail: count(usage.trafficThisMonth.requests) },
          { term: t("usage.trafficBytes"), detail: bytes(usage.trafficThisMonth.bytes) },
          {
            term: t("usage.trafficResets"),
            detail: formatDate(usage.trafficThisMonth.resetsAt, true),
          },
        ]}
      />
      {others.length > 0 ? (
        <>
          <h3 className="mt-4 text-base font-semibold">{t("usage.blocks")}</h3>
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
