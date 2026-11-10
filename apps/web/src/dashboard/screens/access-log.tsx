// The access log section of the artifact page (plan sections 6 "Uso y registros", 11 and 13):
// the signed-in visitors who opened the artifact within the owner plan's retention (30 days on
// free, a year on paid plans), newest first. Only the owner side sees it; the API decides what is
// recorded and for how long, and this explains it.
import type { ArtifactSummary } from "@portifact/contracts";
import {
  Button,
  Callout,
  EmptyState,
  LoadingState,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { CircleAlert, Download, Eye, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { type AccessLogFormat, exportAccessLog } from "../access-log-export.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { errorMessage } from "./artifact-list.tsx";

export const accessLogQuery = (artifactId: string) =>
  ["artifact", artifactId, "access-log"] as const;

export function AccessLog({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  const log = useInfiniteQuery({
    queryKey: accessLogQuery(artifact.id),
    queryFn: ({ pageParam }) => api.accessLog(artifact.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...refreshOptions,
  });

  // The owner's retention, from the API; the free plan's 30 days until the first page arrives.
  const days = log.data?.pages[0]?.retentionDays ?? 30;
  let body: ReactNode;
  if (log.isPending) {
    body = <LoadingState label={t("accessLog.loading")} />;
  } else if (log.isError && !log.data) {
    body = (
      <Callout
        tone="error"
        title={t("accessLog.error.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => log.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, log.error)}
      </Callout>
    );
  } else {
    const entries = log.data.pages.flatMap((page) => page.entries);
    body =
      entries.length === 0 ? (
        <EmptyState
          title={t("accessLog.empty.title")}
          icon={<Eye className="size-6" />}
          headingLevel={3}
        >
          {t("accessLog.empty.body", { days })}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          <AccessLogExport artifactId={artifact.id} days={days} />
          <Table caption={t("accessLog.caption")} variant="flush" stacked>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("accessLog.column.opened")}</TableHeaderCell>
                <TableHeaderCell>{t("accessLog.column.visitor")}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={`${entry.openedAt} ${entry.email}`}>
                  <TableCell label={t("accessLog.column.opened")}>
                    <span className="whitespace-nowrap tabular-nums">
                      {formatDate(entry.openedAt, true)}
                    </span>
                  </TableCell>
                  <TableCell label={t("accessLog.column.visitor")}>
                    <span className="break-all">{entry.email}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {log.hasNextPage ? (
            <div className="px-5 pb-5">
              <Button busy={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
                {t("accessLog.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      );
  }

  const listed = Boolean(log.data?.pages.some((page) => page.entries.length > 0));
  return (
    <Panel
      id="access-log"
      headingLevel={3}
      title={t("accessLog.title")}
      description={t("accessLog.hint", { days })}
      flush={listed}
    >
      {body}
    </Panel>
  );
}

/** Downloads the whole log, every page of it, as CSV or JSON. */
function AccessLogExport({ artifactId, days }: { artifactId: string; days: number }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const exporter = useMutation({
    mutationFn: (format: AccessLogFormat) => exportAccessLog(api, artifactId, format),
    onSuccess: (file, format) => {
      save(file);
      announce(t(format === "csv" ? "accessLog.export.doneCsv" : "accessLog.export.doneJson"));
    },
  });
  return (
    <div className="flex flex-col gap-2 px-5 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          busy={exporter.isPending && exporter.variables === "csv"}
          onClick={() => exporter.mutate("csv")}
        >
          {t("accessLog.export.csv")}
        </Button>
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          busy={exporter.isPending && exporter.variables === "json"}
          onClick={() => exporter.mutate("json")}
        >
          {t("accessLog.export.json")}
        </Button>
      </div>
      <p className="text-sm text-text-muted">{t("accessLog.export.hint", { days })}</p>
      {exporter.isError ? (
        <Callout
          tone="error"
          title={t("accessLog.export.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, exporter.error)}
        </Callout>
      ) : null}
    </div>
  );
}
