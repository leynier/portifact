import type { ArtifactSummary } from "@portifact/contracts";
import {
  Button,
  backLinkClasses,
  buttonClasses,
  Callout,
  ConfirmDialog,
  CopyField,
  DetailList,
  LoadingState,
  PageHeader,
  Panel,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  CircleAlert,
  ExternalLink,
  FilePen,
  History,
  MessageSquareText,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure, type LifecycleAction } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { AccessBadge, offeredActions, StateBadge } from "../presentation.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { AccessLog } from "./access-log.tsx";
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
      <Link to="/" className={backLinkClasses}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("detail.back")}
      </Link>
    </p>
  );

  if (artifact.isPending) {
    return (
      <>
        {back}
        <LoadingState label={t("detail.loading")} skeleton={3} />
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

  const servable = artifact.state === "active";
  const editable = artifact.state === "active" || artifact.state === "draft";

  return (
    <>
      <PageHeader
        title={artifact.name}
        meta={
          <>
            <StateBadge state={artifact.state} />
            <AccessBadge mode={artifact.accessMode} />
          </>
        }
        actions={
          <>
            {editable ? (
              <Link
                to="/artifacts/$artifactId/publish"
                params={{ artifactId: artifact.id }}
                className={buttonClasses()}
              >
                <Upload aria-hidden="true" className="size-4" />
                {t("content.publishVersion")}
              </Link>
            ) : null}
            {servable ? (
              <Link
                to="/review/$artifactId"
                params={{ artifactId: artifact.id }}
                className={buttonClasses({ intent: "primary" })}
              >
                <MessageSquareText aria-hidden="true" className="size-4" />
                {t("review.open")}
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mb-8">
        <CopyField
          label={t("detail.link")}
          value={artifact.url}
          href={artifact.url}
          copyLabel={t("detail.copyLink")}
          copiedLabel={t("copy.copied")}
          onCopied={() => announce(t("detail.linkCopied"))}
          onCopyFailed={() => announce(t("copy.failed"))}
          actions={
            servable ? (
              <a
                href={artifact.url}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClasses({ intent: "ghost" })}
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                {t("detail.open")}
              </a>
            ) : null
          }
        />
      </div>

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

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <AccessSettings artifact={artifact} />
          <AccessLog artifact={artifact} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel title={t("detail.facts")}>
            <DetailList
              layout="stacked"
              framed={false}
              items={[
                { term: t("detail.type"), detail: t(`type.${artifact.type}`) },
                { term: t("detail.state"), detail: <StateBadge state={artifact.state} /> },
                { term: t("detail.access"), detail: t(`access.${artifact.accessMode}`) },
                { term: t("detail.created"), detail: formatDate(artifact.createdAt, true) },
                { term: t("detail.updated"), detail: formatDate(artifact.updatedAt, true) },
                { term: t("detail.expires"), detail: optional(artifact.expiresAt) },
                ...(artifact.archivedAt
                  ? [
                      {
                        term: t("detail.archived"),
                        detail: formatDate(artifact.archivedAt, true),
                      },
                      { term: t("detail.purge"), detail: optional(artifact.purgeAt) },
                    ]
                  : []),
              ]}
            />
          </Panel>

          <Panel title={t("content.title")} description={t("detail.versions.body")}>
            <div className="flex flex-col items-start gap-2">
              <Link
                to="/artifacts/$artifactId/history"
                params={{ artifactId: artifact.id }}
                className={buttonClasses()}
              >
                <History aria-hidden="true" className="size-4" />
                {t("content.history")}
              </Link>
              {artifact.type !== "site" && servable ? (
                <Link
                  to="/artifacts/$artifactId/edit"
                  params={{ artifactId: artifact.id }}
                  className={buttonClasses()}
                >
                  <FilePen aria-hidden="true" className="size-4" />
                  {t("content.edit")}
                </Link>
              ) : null}
            </div>
          </Panel>

          <Panel
            title={t("detail.comments.title")}
            description={servable ? t("detail.comments.body") : t("detail.comments.unavailable")}
          >
            <p className="text-sm">{t(`list.annotations.${artifact.annotations}`)}</p>
          </Panel>

          <Panel title={t("detail.actions")} description={t("detail.lifecycleHint")}>
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
              <div className="flex flex-wrap gap-2">
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
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title={t("detail.confirmDelete.title", { name: artifact.name })}
        confirmLabel={t("detail.confirmDelete.confirm")}
        cancelLabel={t("detail.confirmDelete.cancel")}
        confirmIcon={ACTION_ICONS.delete}
        tone="danger"
        busy={action.isPending}
        onConfirm={() => action.mutate("delete")}
        onCancel={() => setConfirmingDelete(false)}
      >
        {t("detail.confirmDelete.body")}
      </ConfirmDialog>
    </>
  );
}
