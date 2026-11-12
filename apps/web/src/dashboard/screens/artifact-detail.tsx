import {
  type ArtifactSummary,
  lowestPlanWith,
  PLAN_LABELS,
  type SuspensionStatement,
} from "@portifact/contracts";
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
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure, type LifecycleAction } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { AccessBadge, offeredActions, PinnedBadge, StateBadge } from "../presentation.tsx";
import { refreshOptions } from "../refresh.ts";
import { useOwnerPolicy } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { AccessLog } from "./access-log.tsx";
import { CommentSettings, SharingSettings } from "./access-settings.tsx";
import { Analytics } from "./analytics.tsx";
import { ApprovalReviewPanel, ApprovalStatusBadge } from "./approval-review.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { BackToList } from "./not-found.tsx";
import { SpaceBadge } from "./space-parts.tsx";
import { TransferArtifact } from "./transfer.tsx";
import { useUsage } from "./usage.tsx";

export const artifactQuery = (artifactId: string) => ["artifact", artifactId] as const;

const ACTION_ICONS: Record<LifecycleAction, ReactNode> = {
  renew: <RefreshCw className="size-4" />,
  archive: <Archive className="size-4" />,
  restore: <ArchiveRestore className="size-4" />,
  delete: <Trash2 className="size-4" />,
  pin: <Pin className="size-4" />,
  unpin: <PinOff className="size-4" />,
};

const DONE: Record<Exclude<LifecycleAction, "delete" | "archive">, MessageId> = {
  renew: "detail.renewed",
  restore: "detail.restored",
  pin: "detail.pinnedDone",
  unpin: "detail.unpinnedDone",
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
  // Pinning is part of the owner's plan; the API decides, this only explains it ahead of time.
  const usage = useUsage(artifact.owner.kind === "workspace" ? artifact.owner.slug : undefined);
  // A workspace's maximum life (decision 0023) rules pinning out; the API refuses it too.
  const maxLife = useOwnerPolicy(artifact.owner)?.artifactMaxDays ?? null;
  const pinOffered =
    maxLife === null && (usage.isError || (usage.data?.plan.features.includes("pin") ?? false));
  const pinUnavailable = usage.data !== undefined && !usage.data.plan.features.includes("pin");

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
          : t(DONE[kind], { date: result.expiresAt ? formatDate(result.expiresAt) : "" }),
      );
    },
    // The error callout is an alert, so it is announced without a separate message.
    onError: () => setConfirmingDelete(false),
  });

  const optional = (iso: string | null) => (iso ? formatDate(iso, true) : t("detail.notSet"));
  const actions = offeredActions(artifact.state);
  // Keeping it online sits with its dates; what takes it offline or away is the danger zone.
  const active = artifact.state === "active";
  const keep: LifecycleAction[] = artifact.pinned
    ? active
      ? ["unpin"]
      : []
    : [
        ...actions.filter((kind) => kind === "renew" || kind === "restore"),
        ...(active && pinOffered ? (["pin"] as const) : []),
      ];
  const keepBody = artifact.pinned
    ? "detail.pinned.body"
    : keep.includes("restore")
      ? "detail.restore.body"
      : "detail.keepOnline.body";
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
    { id: "reviews", label: t("detail.section.reviews") },
    { id: "activity", label: t("detail.section.activity") },
    { id: "space", label: t("detail.section.space") },
    { id: "danger", label: t("detail.section.danger") },
  ];

  return (
    <>
      <PageHeader
        title={artifact.name}
        meta={
          <>
            <SpaceBadge owner={artifact.owner} />
            <StateBadge state={artifact.state} />
            <AccessBadge mode={artifact.accessMode} />
            {artifact.review && artifact.review.status !== "none" ? (
              <ApprovalStatusBadge review={artifact.review} />
            ) : null}
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
            {artifact.suspension.statement ? (
              <SuspensionReasons statement={artifact.suspension.statement} />
            ) : null}
          </Callout>
        </div>
      ) : null}

      <SectionedPage
        label={t("detail.sectionsNav")}
        title={t("sections.title")}
        sections={sections}
      >
        <PageSection id="overview" title={t("detail.section.overview")}>
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Panel
              headingLevel={3}
              title={t("detail.facts")}
              description={keep.length > 0 ? t(keepBody) : undefined}
              actions={keep.length > 0 ? keep.map(actionButton) : undefined}
            >
              <div className="flex flex-col gap-4">
                {failedHere(keep)}
                {active && maxLife !== null ? (
                  <p className="text-sm text-text-muted">
                    {t("detail.maxLife", { days: maxLife })}
                  </p>
                ) : null}
                {active && !artifact.pinned && pinUnavailable && maxLife === null ? (
                  <p className="text-sm text-text-muted">
                    {t("detail.pin.paid", { plan: PLAN_LABELS[lowestPlanWith("pin")] })}
                  </p>
                ) : null}
                <DetailList
                  layout="stacked"
                  framed={false}
                  items={[
                    {
                      term: t("space.label"),
                      detail:
                        artifact.owner.kind === "workspace"
                          ? artifact.owner.name
                          : t("space.personal"),
                    },
                    { term: t("detail.type"), detail: t(`type.${artifact.type}`) },
                    { term: t("detail.state"), detail: <StateBadge state={artifact.state} /> },
                    { term: t("detail.access"), detail: t(`access.${artifact.accessMode}`) },
                    { term: t("detail.created"), detail: formatDate(artifact.createdAt, true) },
                    { term: t("detail.updated"), detail: formatDate(artifact.updatedAt, true) },
                    {
                      term: t("detail.expires"),
                      detail: artifact.pinned ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <PinnedBadge />
                          {t("detail.expiresNever")}
                        </span>
                      ) : (
                        optional(artifact.expiresAt)
                      ),
                    },
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

        <PageSection id="reviews" title={t("detail.section.reviews")}>
          <ApprovalReviewPanel artifact={artifact} disabled={!servable} />
        </PageSection>

        <PageSection id="activity" title={t("detail.section.activity")}>
          <div className="flex flex-col gap-6">
            <Analytics artifactId={artifact.id} />
            <AccessLog artifact={artifact} />
          </div>
        </PageSection>

        <PageSection id="space" title={t("detail.section.space")}>
          <TransferArtifact artifact={artifact} />
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

/**
 * The statement of reasons the operator recorded, next to the category: the operator's text shown
 * as written (React escapes it), one paragraph per line.
 */
function SuspensionReasons({ statement }: { statement: SuspensionStatement }) {
  const t = useT();
  const formatDate = useFormatDate();
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  return (
    <div className="mt-3 space-y-3">
      <p>
        {t(statement.source === "notice" ? "detail.suspended.notice" : "detail.suspended.review", {
          date: formatDate(statement.decidedAt),
        })}
      </p>
      <div>
        <p className="font-medium">{t("detail.suspended.facts")}</p>
        {lines(statement.facts).map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move
          <p key={index} className="mt-1 whitespace-pre-wrap break-words">
            {line}
          </p>
        ))}
      </div>
      <div>
        <p className="font-medium">{t("detail.suspended.ground")}</p>
        {lines(statement.ground).map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move
          <p key={index} className="mt-1 whitespace-pre-wrap break-words">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
