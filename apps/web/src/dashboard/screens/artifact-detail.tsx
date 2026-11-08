import type { ArtifactSummary } from "@portifact/contracts";
import {
  Button,
  Callout,
  ConfirmDialog,
  DetailList,
  LoadingState,
  PageHeader,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  CircleAlert,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure, type LifecycleAction } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { offeredActions, StateBadge } from "../presentation.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { AccessSettings } from "./access-settings.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { BackToList } from "./not-found.tsx";

export const artifactQuery = (artifactId: string) => ["artifact", artifactId] as const;

const ACTION_ICONS: Record<LifecycleAction, ReactNode> = {
  renew: <RefreshCw className="size-4" />,
  archive: <Archive className="size-4" />,
  restore: <ArchiveRestore className="size-4" />,
  delete: <Trash2 className="size-4" />,
};

export function ArtifactDetailScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/artifacts/$artifactId" });
  const { api } = useDashboard();
  const artifact = useQuery({
    queryKey: artifactQuery(artifactId),
    queryFn: () => api.getArtifact(artifactId),
    ...refreshOptions,
  });
  useDocumentTitle(
    artifact.data?.name ?? (artifact.isError ? t("detail.notFound.title") : undefined),
  );

  const back = (
    <p className="mb-4 text-sm">
      <Link to="/" className="inline-flex items-center gap-1">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("detail.back")}
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
        {missing ? (
          <>
            <PageHeader title={t("detail.notFound.title")} />
            <p className="mb-6 text-text-muted">{t("detail.notFound.body")}</p>
            <BackToList>{t("detail.back")}</BackToList>
          </>
        ) : (
          <>
            <PageHeader title={t("detail.error.title")} />
            <Callout
              tone="error"
              title={t("detail.error.title")}
              icon={<CircleAlert className="size-5" />}
              action={
                <Button icon={<RefreshCw className="size-4" />} onClick={() => artifact.refetch()}>
                  {t("action.retry")}
                </Button>
              }
            >
              {errorMessage(t, artifact.error)}
            </Callout>
          </>
        )}
      </>
    );
  }

  return (
    <>
      {back}
      <ArtifactDetail artifact={artifact.data} />
    </>
  );
}

function ArtifactDetail({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const action = useMutation({
    mutationFn: (kind: LifecycleAction) => api.lifecycle(artifact.id, kind),
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
        kind === "archive"
          ? t("detail.archivedDone", { date: result.purgeAt ? formatDate(result.purgeAt) : "" })
          : t(kind === "renew" ? "detail.renewed" : "detail.restored", {
              date: result.expiresAt ? formatDate(result.expiresAt) : "",
            }),
      );
    },
    // The error callout is an alert, so it is announced without a separate message.
    onError: () => setConfirmingDelete(false),
  });

  const optional = (iso: string | null) => (iso ? formatDate(iso, true) : t("detail.notSet"));
  const actions = offeredActions(artifact.state);

  return (
    <>
      <PageHeader title={artifact.name} description={<StateBadge state={artifact.state} />} />

      {artifact.suspension ? (
        <div className="mb-8">
          <Callout
            tone="error"
            title={t("detail.suspended.title")}
            icon={<Ban className="size-5" />}
          >
            {t("detail.suspended.body", { reason: t(`reason.${artifact.suspension.reason}`) })}
          </Callout>
        </div>
      ) : null}

      <section aria-labelledby="facts-heading">
        <h2 id="facts-heading" className="mb-3 text-lg font-semibold">
          {t("detail.facts")}
        </h2>
        <DetailList
          items={[
            {
              term: t("detail.url"),
              detail: (
                <a href={artifact.url} className="font-mono break-all">
                  {artifact.url}
                </a>
              ),
            },
            { term: t("detail.type"), detail: t(`type.${artifact.type}`) },
            { term: t("detail.state"), detail: <StateBadge state={artifact.state} /> },
            { term: t("detail.access"), detail: t(`access.${artifact.accessMode}`) },
            { term: t("detail.created"), detail: formatDate(artifact.createdAt, true) },
            { term: t("detail.updated"), detail: formatDate(artifact.updatedAt, true) },
            { term: t("detail.expires"), detail: optional(artifact.expiresAt) },
            ...(artifact.archivedAt
              ? [
                  { term: t("detail.archived"), detail: formatDate(artifact.archivedAt, true) },
                  { term: t("detail.purge"), detail: optional(artifact.purgeAt) },
                ]
              : []),
          ]}
        />
      </section>

      <AccessSettings artifact={artifact} />

      <section aria-labelledby="actions-heading" className="mt-8">
        <h2 id="actions-heading" className="mb-3 text-lg font-semibold">
          {t("detail.actions")}
        </h2>
        {action.isError ? (
          <div className="mb-4">
            <Callout
              tone="error"
              title={t("detail.actionFailed.title")}
              icon={<CircleAlert className="size-5" />}
            >
              {errorMessage(t, action.error)}
            </Callout>
          </div>
        ) : null}
        {actions.length === 0 ? (
          <p className="text-sm text-text-muted">{t("detail.noActions")}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {actions.map((kind) => (
              <Button
                key={kind}
                intent={kind === "renew" || kind === "restore" ? "primary" : "secondary"}
                icon={ACTION_ICONS[kind]}
                busy={action.isPending && action.variables === kind}
                disabled={action.isPending}
                onClick={() =>
                  kind === "delete" ? setConfirmingDelete(true) : action.mutate(kind)
                }
              >
                {t(`detail.${kind}`)}
              </Button>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmingDelete}
        title={t("detail.confirmDelete.title", { name: artifact.name })}
        confirmLabel={t("detail.confirmDelete.confirm")}
        cancelLabel={t("detail.confirmDelete.cancel")}
        confirmIcon={ACTION_ICONS.delete}
        busy={action.isPending}
        onConfirm={() => action.mutate("delete")}
        onCancel={() => setConfirmingDelete(false)}
      >
        {t("detail.confirmDelete.body")}
      </ConfirmDialog>
    </>
  );
}
