// Version history (plan section 6, "Historial" and "Archivo"): the retained versions with their
// files, downloads of the published files and the sources (checked against the manifest and
// packaged in the browser), rollback after a confirmation, the conversations on earlier versions
// (read-only) and, while the artifact is archived, the purge date with restore and delete.
import type { ArtifactSummary, DownloadKind, VersionSummary } from "@portifact/contracts";
import {
  Badge,
  Button,
  backLinkClasses,
  Callout,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  PageHeader,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Download,
  History,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatBytes, useFormatDate, useT } from "../context.tsx";
import { downloadVersion } from "../publish/download.ts";
import { publishFailureMessage } from "../publish/failures.ts";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { artifactQuery } from "./artifact-detail.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { EarlierConversations } from "./earlier-conversations.tsx";

export const versionsQuery = (artifactId: string) => ["versions", artifactId] as const;

export function HistoryScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/artifacts/$artifactId/history" });
  const { api } = useDashboard();
  const artifact = useQuery({
    queryKey: artifactQuery(artifactId),
    queryFn: () => api.getArtifact(artifactId),
    ...refreshOptions,
  });
  useDocumentTitle(
    artifact.data ? t("history.title", { name: artifact.data.name }) : t("content.history"),
  );
  const back = (
    <p className="mb-4 text-sm">
      <Link to="/artifacts/$artifactId" params={{ artifactId }} className={backLinkClasses}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        {artifact.data?.name ?? t("detail.back")}
      </Link>
    </p>
  );
  if (artifact.isPending) {
    return (
      <>
        {back}
        <LoadingState label={t("detail.loading")} />
      </>
    );
  }
  if (artifact.isError && !artifact.data) {
    const missing = artifact.error instanceof ApiFailure && artifact.error.code === "not_found";
    return (
      <>
        {back}
        <PageHeader title={missing ? t("detail.notFound.title") : t("detail.error.title")} />
        <Callout
          tone="error"
          title={t("detail.error.title")}
          icon={<CircleAlert className="size-5" />}
        >
          {missing ? t("detail.notFound.body") : errorMessage(t, artifact.error)}
        </Callout>
      </>
    );
  }
  return (
    <>
      {back}
      <PageHeader
        title={t("history.title", { name: artifact.data.name })}
        description={t("history.description")}
      />
      {artifact.data.state === "archived" ? <ArchivePanel artifact={artifact.data} /> : null}
      <Versions artifact={artifact.data} />
    </>
  );
}

function ArchivePanel({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const action = useMutation({
    mutationFn: (kind: "restore" | "delete") => api.lifecycle(artifact.id, kind),
    onMutate: () => announce(t("detail.working")),
    onSuccess: async (result, kind) => {
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      if (kind === "delete") {
        setConfirmingDelete(false);
        queryClient.removeQueries({ queryKey: artifactQuery(artifact.id) });
        announce(t("detail.deleted", { name: artifact.name }));
        await navigate({ to: "/" });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: artifactQuery(artifact.id) });
      announce(
        t("detail.restored", { date: result.expiresAt ? formatDate(result.expiresAt) : "" }),
      );
    },
    onError: () => setConfirmingDelete(false),
  });
  return (
    <section
      aria-labelledby="archive-heading"
      className="mb-6 flex flex-col gap-4 rounded-lg border border-border border-l-4 border-l-text bg-canvas p-5 shadow-sm"
    >
      <h2 id="archive-heading" className="flex items-center gap-2 text-base font-semibold">
        <Archive aria-hidden="true" className="size-5" />
        {t("history.archive.title")}
      </h2>
      <p className="text-sm">
        {artifact.purgeAt
          ? t("history.archive.body", { date: formatDate(artifact.purgeAt) })
          : t("history.archive.noDate")}
      </p>
      {action.isError ? (
        <Callout
          tone="error"
          title={t("detail.actionFailed.title")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, action.error)}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          intent="primary"
          icon={<ArchiveRestore className="size-4" />}
          busy={action.isPending && action.variables === "restore"}
          disabled={action.isPending}
          onClick={() => action.mutate("restore")}
        >
          {t("detail.restore")}
        </Button>
        <Button
          icon={<Trash2 className="size-4" />}
          disabled={action.isPending}
          onClick={() => setConfirmingDelete(true)}
        >
          {t("detail.delete")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={t("detail.confirmDelete.title", { name: artifact.name })}
        confirmLabel={t("detail.confirmDelete.confirm")}
        cancelLabel={t("detail.confirmDelete.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={action.isPending}
        onConfirm={() => action.mutate("delete")}
        onCancel={() => setConfirmingDelete(false)}
      >
        {t("detail.confirmDelete.body")}
      </ConfirmDialog>
    </section>
  );
}

function Versions({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatBytes = useFormatBytes();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api, storage, save } = useDashboard();
  const [rollingBack, setRollingBack] = useState<{ version: VersionSummary; key: string } | null>(
    null,
  );

  const versions = useInfiniteQuery({
    queryKey: versionsQuery(artifact.id),
    queryFn: ({ pageParam }) => api.listVersions(artifact.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...refreshOptions,
  });

  const download = useMutation({
    mutationFn: (input: { version: VersionSummary; kind: DownloadKind }) =>
      downloadVersion({
        api,
        transport: storage,
        artifactId: artifact.id,
        versionId: input.version.id,
        kind: input.kind,
        name: artifact.name,
      }),
    onMutate: () => announce(t("history.downloading")),
    onSuccess: (file) => {
      save(file);
      announce(t("history.downloaded", { file: file.fileName }));
    },
  });

  const rollback = useMutation({
    mutationFn: (input: { version: VersionSummary; key: string }) =>
      api.rollback(
        artifact.id,
        { versionId: input.version.id, baseVersionId: artifact.currentVersionId ?? "current" },
        input.key,
      ),
    onMutate: () => announce(t("detail.working")),
    onSuccess: async (result) => {
      setRollingBack(null);
      await queryClient.invalidateQueries({ queryKey: versionsQuery(artifact.id) });
      await queryClient.invalidateQueries({ queryKey: artifactQuery(artifact.id) });
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      announce(
        t("history.rolledBack", {
          from: result.fromVersionNumber,
          number: result.versionNumber,
        }),
      );
    },
    onError: () => setRollingBack(null),
  });

  if (versions.isPending) return <LoadingState label={t("history.loading")} skeleton={3} />;
  if (versions.isError && !versions.data) {
    return (
      <Callout
        tone="error"
        title={t("history.error.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => versions.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, versions.error)}
      </Callout>
    );
  }
  const items = versions.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <EmptyState title={t("history.empty.title")} icon={<History className="size-8" />}>
        <p>{t("history.empty.body")}</p>
      </EmptyState>
    );
  }
  const canRollBack = artifact.state === "active";

  return (
    <div className="flex flex-col gap-4">
      {download.isError ? (
        <Callout
          tone="error"
          title={t("history.downloadFailed.title")}
          icon={<CircleAlert className="size-5" />}
        >
          {publishFailureMessage(t, download.error)}
        </Callout>
      ) : null}
      {rollback.isError ? (
        <Callout
          tone="error"
          title={t("history.actionFailed.title")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, rollback.error)}
        </Callout>
      ) : null}
      {canRollBack ? null : (
        <p className="text-sm text-text-muted">{t("history.rollbackUnavailable")}</p>
      )}
      <Panel title={t("history.versionsTitle")} flush>
        <Table caption={t("history.caption")} variant="flush">
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("history.column.version")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.published")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.files")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.kept")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.actions")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((version) => (
              <TableRow key={version.id}>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2 font-semibold whitespace-nowrap">
                    {t("history.version", { number: version.number })}
                    {version.current ? (
                      <Badge icon={<CircleCheck className="size-3.5" />}>
                        {t("history.current")}
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="whitespace-nowrap tabular-nums">
                    {formatDate(version.committedAt, true)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block">
                    {t("history.files", {
                      count: version.publishedFiles,
                      size: formatBytes(version.publishedBytes),
                    })}
                  </span>
                  {version.sourceFiles > 0 ? (
                    <span className="block text-text-muted">
                      {t("history.sources", {
                        count: version.sourceFiles,
                        size: formatBytes(version.sourceBytes),
                      })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {version.expiresAt
                    ? formatDate(version.expiresAt, true)
                    : t("history.whileCurrent")}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      intent="ghost"
                      size="sm"
                      icon={<Download className="size-4" />}
                      aria-label={t("history.downloadLabel", { number: version.number })}
                      busy={
                        download.isPending &&
                        download.variables.version.id === version.id &&
                        download.variables.kind === "published"
                      }
                      disabled={download.isPending}
                      onClick={() => download.mutate({ version, kind: "published" })}
                    >
                      {t("history.download")}
                    </Button>
                    {version.sourceFiles > 0 ? (
                      <Button
                        intent="ghost"
                        size="sm"
                        icon={<Download className="size-4" />}
                        aria-label={t("history.downloadSourcesLabel", { number: version.number })}
                        busy={
                          download.isPending &&
                          download.variables.version.id === version.id &&
                          download.variables.kind === "source"
                        }
                        disabled={download.isPending}
                        onClick={() => download.mutate({ version, kind: "source" })}
                      >
                        {t("history.downloadSources")}
                      </Button>
                    ) : null}
                    {canRollBack && !version.current ? (
                      <Button
                        size="sm"
                        icon={<Undo2 className="size-4" />}
                        aria-label={t("history.rollbackLabel", { number: version.number })}
                        disabled={rollback.isPending}
                        onClick={() => setRollingBack({ version, key: crypto.randomUUID() })}
                      >
                        {t("history.rollback")}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {versions.hasNextPage ? (
          <div className="border-t border-border px-5 py-4">
            <Button busy={versions.isFetchingNextPage} onClick={() => versions.fetchNextPage()}>
              {t("history.loadMore")}
            </Button>
          </div>
        ) : null}
      </Panel>
      <ConfirmDialog
        open={rollingBack !== null}
        title={t("history.confirmRollback.title", { number: rollingBack?.version.number ?? 0 })}
        confirmLabel={t("history.confirmRollback.confirm")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Undo2 className="size-4" />}
        busy={rollback.isPending}
        onConfirm={() => (rollingBack ? rollback.mutate(rollingBack) : undefined)}
        onCancel={() => setRollingBack(null)}
      >
        {t("history.confirmRollback.body")}
      </ConfirmDialog>
      <EarlierConversations artifactId={artifact.id} versions={items} />
    </div>
  );
}
