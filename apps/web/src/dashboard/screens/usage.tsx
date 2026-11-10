// Account usage in the dashboard (`/usage`, plan sections 6 "Uso" and 12): the plan, every quota with its
// value, limit and share, this month's traffic and its reset, the per-version limits, when a new
// account may publish in public, and what blocks the account now. Traffic is counted per account,
// never per artifact. When the traffic quota is used up, every artifact of the account answers
// 429, and the dashboard says so on the artifact list and here.
import type { AccountUsageView, PlanView, UsageBlock, UsageMeter } from "@portifact/contracts";
import { LIMITS } from "@portifact/contracts";
import { buttonClasses, Callout, DetailList, Meter, PageHeader } from "@portifact/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Clock, Gauge } from "lucide-react";
import type { ReactNode } from "react";
import {
  useDashboard,
  useFormatBytes,
  useFormatDate,
  useFormatNumber,
  useFormatPercent,
  useT,
} from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";

export const USAGE_QUERY = ["usage"] as const;

export function useUsage() {
  const { api } = useDashboard();
  return useQuery({ queryKey: USAGE_QUERY, queryFn: () => api.usage(), ...refreshOptions });
}

export function trafficBlock(usage: AccountUsageView | undefined): UsageBlock | undefined {
  return usage?.blocks.find((block) => block.reason === "traffic");
}

/** Explains the 429 state, with a link to the usage page when shown elsewhere. */
export function TrafficNotice({ block, link }: { block: UsageBlock; link?: boolean }) {
  const t = useT();
  const formatDate = useFormatDate();
  return (
    <Callout
      title={t("usage.traffic.title")}
      icon={<Gauge className="size-5" />}
      action={
        link ? (
          <Link to="/usage" className={buttonClasses({ intent: "secondary" })}>
            {t("usage.traffic.link")}
          </Link>
        ) : undefined
      }
    >
      {t("usage.traffic.body", { date: block.until ? formatDate(block.until, true) : "" })}
    </Callout>
  );
}

export function UsageScreen() {
  const t = useT();
  useDocumentTitle(t("usage.title"));
  const usage = useUsage();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("usage.title")} description={t("usage.description")} />
      <Loaded query={usage} loading={t("usage.loading")} error={t("usage.error")}>
        {(view) => <UsageDetails usage={view} />}
      </Loaded>
    </div>
  );
}

/** Meters side by side: two columns, or three in a panel that spans the page (`wide`). */
function MeterGrid({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className={`grid gap-x-8 gap-y-6 sm:grid-cols-2 ${wide ? "xl:grid-cols-3" : ""}`}>
      {children}
    </div>
  );
}

/** The owner's plan, which sets every limit below; seats and the end only when they apply. */
function PlanSection({ plan }: { plan: PlanView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatNumber = useFormatNumber();
  const items = [{ term: t("usage.plan.name"), detail: t(`usage.plan.${plan.name}`) }];
  if (plan.seats > 1) items.push({ term: t("usage.plan.seats"), detail: formatNumber(plan.seats) });
  if (plan.validUntil !== null) {
    items.push({ term: t("usage.plan.until"), detail: formatDate(plan.validUntil, true) });
  }
  return (
    <Section id="plan" title={t("usage.plan.section")} hint={t("usage.plan.hint")}>
      <DetailList framed={false} items={items} />
    </Section>
  );
}

/** Every quota of the account, grouped by what it limits. */
export function UsageDetails({ usage }: { usage: AccountUsageView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatBytes = useFormatBytes();
  const formatNumber = useFormatNumber();
  const formatPercent = useFormatPercent();
  const traffic = trafficBlock(usage);
  const others = usage.blocks.filter(
    (block) => block.reason !== "traffic" && block.reason !== "account_too_new_for_public",
  );
  const publicFrom = Date.parse(usage.publicAccessFrom);
  const publicSoon = publicFrom > Date.now();

  const meter = (
    label: string,
    m: UsageMeter,
    format: (value: number) => string,
    description: string,
    used = m.used,
  ) => (
    <Meter
      label={label}
      value={used}
      max={m.limit}
      valueText={t("usage.meterPercent", {
        used: format(used),
        limit: format(m.limit),
        percent: formatPercent(m.limit > 0 ? used / m.limit : 0),
      })}
      nearLimitLabel={t("usage.nearLimit")}
      atLimitLabel={t("usage.atLimit")}
      description={description}
    />
  );

  return (
    <>
      {traffic ? <TrafficNotice block={traffic} /> : null}
      {publicSoon ? (
        <Callout title={t("usage.public.title")} icon={<Clock className="size-5" />}>
          {t("usage.public.body", {
            minutes: LIMITS.publicAccessMinAccountAgeMinutes,
            date: formatDate(usage.publicAccessFrom, true),
          })}
        </Callout>
      ) : null}
      {others.length > 0 ? (
        <Callout tone="error" title={t("usage.blocks")} icon={<Gauge className="size-5" />}>
          <ul className="list-disc pl-5">
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
        </Callout>
      ) : null}
      <PlanSection plan={usage.plan} />
      {/* On wide screens traffic sits beside storage and the version limits, and publishing spans
          both columns with room for three meters a row. */}
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="xl:row-span-2">
          <Section id="traffic" title={t("usage.traffic.section")} hint={t("usage.traffic.hint")}>
            <MeterGrid>
              {meter(
                t("usage.trafficRequests"),
                usage.trafficThisMonth.requests,
                formatNumber,
                t("usage.trafficRequests.hint"),
              )}
              {meter(
                t("usage.trafficBytes"),
                usage.trafficThisMonth.bytes,
                formatBytes,
                t("usage.trafficBytes.hint"),
              )}
            </MeterGrid>
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
          </Section>
        </div>
        <Section id="storage" title={t("usage.storage.section")}>
          <MeterGrid>
            {meter(
              t("usage.activeArtifacts"),
              usage.activeArtifacts,
              formatNumber,
              t("usage.activeArtifacts.hint"),
            )}
            {meter(
              t("usage.storage"),
              usage.storage,
              formatBytes,
              t("usage.storage.hint"),
              usage.storage.used + usage.storage.reserved,
            )}
          </MeterGrid>
        </Section>
        <Section id="versions" title={t("usage.versions.section")} hint={t("usage.versions.hint")}>
          <DetailList
            framed={false}
            items={[
              {
                term: t("usage.versions.publishedBytes"),
                detail: formatBytes(usage.versionLimits.publishedBytes),
              },
              {
                term: t("usage.versions.files"),
                detail: formatNumber(usage.versionLimits.files),
              },
              {
                term: t("usage.versions.documentBytes"),
                detail: formatBytes(usage.versionLimits.documentBytes),
              },
            ]}
          />
        </Section>
        <div className="xl:col-span-2">
          <Section
            id="publishing"
            title={t("usage.publishing.section")}
            hint={t("usage.publishing.hint")}
          >
            <MeterGrid wide>
              {meter(
                t("usage.publishes"),
                usage.publishesLast24h,
                formatNumber,
                t("usage.publishes.hint"),
              )}
              {meter(
                t("usage.openUploads"),
                usage.openUploads,
                formatNumber,
                t("usage.openUploads.hint"),
              )}
              {meter(
                t("usage.newFiles"),
                usage.newFilesLast24h,
                formatNumber,
                t("usage.newFiles.hint"),
              )}
              {meter(
                t("usage.newBytes"),
                usage.newBytesLast24h,
                formatBytes,
                t("usage.newBytes.hint"),
              )}
              {meter(
                t("usage.newObjects"),
                usage.newObjectsThisMonth,
                formatNumber,
                t("usage.newObjects.hint", {
                  date: formatDate(usage.newObjectsThisMonth.resetsAt, true),
                }),
              )}
            </MeterGrid>
          </Section>
        </div>
      </div>
    </>
  );
}
