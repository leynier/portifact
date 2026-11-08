import {
  Button,
  buttonClasses,
  Callout,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, Inbox, RefreshCw, Upload } from "lucide-react";
import { ApiFailure } from "../api.ts";
import { useDashboard, useFormatDate, useT } from "../context.tsx";
import { StateBadge } from "../presentation.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";

export const ARTIFACTS_QUERY = ["artifacts"] as const;

export function ArtifactListScreen() {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  useDocumentTitle(t("list.title"));

  const list = useInfiniteQuery({
    queryKey: ARTIFACTS_QUERY,
    queryFn: ({ pageParam }) => api.listArtifacts(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...refreshOptions,
  });

  const header = (
    <PageHeader
      title={t("list.title")}
      description={t("list.description")}
      actions={
        <Link to="/publish" className={buttonClasses({ intent: "primary" })}>
          <Upload aria-hidden="true" className="size-4" />
          {t("list.publish")}
        </Link>
      }
    />
  );

  if (list.isPending) {
    return (
      <>
        {header}
        <LoadingState label={t("list.loading")} />
      </>
    );
  }

  if (list.isError && !list.data) {
    return (
      <>
        {header}
        <Callout
          tone="error"
          title={t("list.error.title")}
          icon={<CircleAlert className="size-5" />}
          action={
            <Button icon={<RefreshCw className="size-4" />} onClick={() => list.refetch()}>
              {t("action.retry")}
            </Button>
          }
        >
          {errorMessage(t, list.error)}
        </Callout>
      </>
    );
  }

  const artifacts = list.data.pages.flatMap((page) => page.items);

  return (
    <>
      {header}
      {list.isRefetchError ? (
        <div className="mb-6">
          <Callout title={t("list.refreshFailed.title")} icon={<CircleAlert className="size-5" />}>
            {t("list.refreshFailed.body")}
          </Callout>
        </div>
      ) : null}
      {artifacts.length === 0 ? (
        <EmptyState title={t("list.empty.title")} icon={<Inbox className="size-8" />}>
          <p>{t("list.empty.body")}</p>
          <p className="mt-3">
            <code className="rounded-xs bg-surface px-2 py-1 font-mono text-text">
              portifact publish ./report.html
            </code>
          </p>
        </EmptyState>
      ) : (
        <>
          <Table caption={t("list.caption")}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("list.column.name")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.type")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.state")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.expires")}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {artifacts.map((artifact) => (
                <TableRow key={artifact.id}>
                  <TableCell>
                    <Link
                      to="/artifacts/$artifactId"
                      params={{ artifactId: artifact.id }}
                      className="font-medium"
                    >
                      {artifact.name}
                    </Link>
                  </TableCell>
                  <TableCell>{t(`type.${artifact.type}`)}</TableCell>
                  <TableCell>
                    <StateBadge state={artifact.state} />
                  </TableCell>
                  <TableCell>
                    {artifact.expiresAt ? formatDate(artifact.expiresAt) : t("list.never")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <p role="status" className="text-sm text-text-muted">
              {list.isFetchingNextPage
                ? t("list.loadingMore")
                : t("list.count", { count: artifacts.length })}
            </p>
            {list.hasNextPage ? (
              <Button busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                {t("list.loadMore")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

/** The message for a failed call, from its documented error code. */
export function errorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  return t(`error.${error instanceof ApiFailure ? error.code : "unexpected"}`);
}
