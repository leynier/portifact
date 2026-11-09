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
  PageSection,
  Panel,
  SectionedPage,
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
import { CommentSettings, SharingSettings } from "./access-settings.tsx";
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
  // Keeping it online sits with its dates; what takes it offline or away is the danger zone.
  const keep = actions.filter((kind) => kind === "renew" || kind === "restore");
  const remove = actions.filter((kind) => kind === "archive" || kind === "delete");
  const failed = action.isError ? (
    <Callout
      tone="error"
      title={t("detail.actionFailed.title")}
      icon={<CircleAlert className="size-5" />}
    >
      {errorMessage(t, action.error)}
    </Callout>
  ) : null;
  const failedHere = (kinds: LifecycleAction[]) =>
    action.variables !== undefined && kinds.includes(action.variables) ? failed : null;
  const actionButton = (kind: LifecycleAction) => (
    <Button
      key={kind}
      intent={kind === "renew" || kind === "restore" ? "primary" : "secondary"}
      icon={ACTION_ICONS[kind]}
      busy={action.isPending && action.variables === kind}
      disabled={action.isPending}
      onClick={() => (kind === "delete" ? setConfirmingDelete(true) : action.mutate(kind))}
    >
      {t(`detail.${kind}`)}
    </Button>
  );

  const servable = artifact.state === "active";
  const editable = artifact.state === "active" || artifact.state === "draft";

  const sections = [
    { id: "overview", label: t("detail.section.overview") },
    { id: "sharing", label: t("detail.section.sharing") },
    { id: "comments", label: t("detail.section.comments") },
    { id: "activity", label: t("detail.section.activity") },
    { id: "danger", label: t("detail.section.danger") },
  ];

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
              // A full page load, so the viewer gets its own policy (frames of this artifact only).
              <a
                href={`/view/${encodeURIComponent(artifact.id)}`}
                className={buttonClasses({ intent: "primary" })}
              >
                <MessageSquareText aria-hidden="true" className="size-4" />
                {t("review.open")}
              </a>
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

      <SectionedPage label={t("detail.sectionsNav")} sections={sections}>
        <PageSection id="overview" title={t("detail.section.overview")}>
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Panel
              headingLevel={3}
              title={t("detail.facts")}
              description={
                keep.length > 0
                  ? t(keep.includes("restore") ? "detail.restore.body" : "detail.keepOnline.body")
                  : undefined
              }
              actions={keep.length > 0 ? keep.map(actionButton) : undefined}
            >
              <div className="flex flex-col gap-4">
                {failedHere(keep)}
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
              </div>
            </Panel>

            <Panel
              headingLevel={3}
              title={t("content.title")}
              description={t("detail.versions.body")}
            >
              <div className="flex flex-wrap gap-2">
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
          </div>
        </PageSection>

        <PageSection id="sharing" title={t("detail.section.sharing")}>
          <SharingSettings artifact={artifact} />
        </PageSection>

        <PageSection
          id="comments"
          title={t("detail.section.comments")}
          description={servable ? t("detail.comments.body") : t("detail.comments.unavailable")}
        >
          <CommentSettings artifact={artifact} />
        </PageSection>

        <PageSection id="activity" title={t("detail.section.activity")}>
          <AccessLog artifact={artifact} />
        </PageSection>

        <PageSection
          id="danger"
          title={t("detail.section.danger")}
          description={remove.length > 0 ? t("detail.danger.body") : undefined}
          tone="danger"
        >
          {failedHere(remove)}
          {remove.length === 0 ? (
            <p className="text-sm text-text-muted">{t("detail.noActions")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">{remove.map(actionButton)}</div>
          )}
        </PageSection>
      </SectionedPage>

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
