// The access log section of the artifact page (plan sections 6 "Uso y registros", 11 and 13):
// the signed-in visitors who opened the artifact in the last 30 days, newest first. Only the
// owner sees it; the API decides what is recorded and for how long, and this explains it.
import type { ArtifactSummary } from "@portifact/contracts";
import {
  Button,
  Callout,
  EmptyState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleAlert, Eye, Info, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboard, useFormatDate, useT } from "../context.tsx";
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
          {t("accessLog.empty.body")}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Table caption={t("accessLog.caption")}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("accessLog.column.opened")}</TableHeaderCell>
                <TableHeaderCell>{t("accessLog.column.visitor")}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={`${entry.openedAt} ${entry.email}`}>
                  <TableCell>{formatDate(entry.openedAt, true)}</TableCell>
                  <TableCell>
                    <span className="break-all">{entry.email}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {log.hasNextPage ? (
            <div>
              <Button busy={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
                {t("accessLog.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      );
  }

  return (
    <section aria-labelledby="access-log-heading" className="mt-8">
      <h2 id="access-log-heading" className="mb-3 text-lg font-semibold">
        {t("accessLog.title")}
      </h2>
      <p className="mb-4 flex gap-2 text-sm text-text-muted">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t("accessLog.hint")}</span>
      </p>
      {body}
    </section>
  );
}
