// Moving an artifact to another space, from its page (premium plan T1). The destinations are the
// spaces where the user may publish: the personal space and workspaces where they are an editor
// or admin. Taking an artifact out of a workspace needs an admin of it, and an artifact with a
// custom domain does not move, so both are said before anything is chosen. A workspace's region
// is fixed (decision 0005): only spaces in the artifact's own region are offered, and an EU
// artifact with no other EU space to go to says so. The dialog says what
// moves and what stays, and the API checks everything again (room in the destination, an open
// upload, the roles).
import { type ArtifactSummary, DEFAULT_REGION } from "@portifact/contracts";
import { maxLifeDeadline } from "@portifact/domain";
import { Button, Callout, ConfirmDialog, Panel, Select } from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, CircleAlert, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { ROLE_LABELS, spaceCan, spaceRegion, useWorkspaces, WORKSPACES_QUERY } from "../space.tsx";
import { artifactQuery } from "./artifact-detail.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { domainQuery } from "./custom-domain.tsx";
import { USAGE_QUERY } from "./usage.tsx";

/** The personal space in the destination select; workspace slugs never take this value. */
const PERSONAL = "personal";

const TRANSFER_ERRORS: Partial<Record<string, MessageId>> = {
  quota_exceeded: "transfer.error.quota_exceeded",
  version_conflict: "transfer.error.version_conflict",
  invalid_input: "transfer.error.invalid_input",
  forbidden: "transfer.error.forbidden",
  artifact_archived: "transfer.error.artifact_archived",
  not_found: "transfer.error.not_found",
};

export function TransferArtifact({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const workspaces = useWorkspaces();
  const domains = useQuery({
    queryKey: domainQuery(artifact.id),
    queryFn: () => api.artifactDomains(artifact.id),
  });
  const [choice, setChoice] = useState("");
  const [confirming, setConfirming] = useState(false);

  const items = workspaces.data?.items ?? [];
  const source = artifact.owner;
  const sourceRole =
    source.kind === "personal" ? "admin" : items.find((w) => w.slug === source.slug)?.role;
  const sourceName = source.kind === "personal" ? t("space.personal") : source.name;
  // Out of a workspace only with an admin of it; in a personal space the user is its admin.
  const mayLeave = sourceRole !== undefined && spaceCan({ role: sourceRole }, "transfer_out");
  // An artifact never moves between regions; a personal space is always in the default one.
  const sourceRegion =
    source.kind === "personal"
      ? DEFAULT_REGION
      : spaceRegion(items.find((w) => w.slug === source.slug) ?? {});
  const destinations = [
    ...(source.kind === "personal" || sourceRegion !== DEFAULT_REGION
      ? []
      : [{ value: PERSONAL, label: t("space.personal") }]),
    ...items
      .filter(
        (w) =>
          spaceCan(w, "transfer") &&
          spaceRegion(w) === sourceRegion &&
          !(source.kind === "workspace" && source.slug === w.slug),
      )
      .map((w) => ({ value: w.slug, label: `${w.name} (${t(ROLE_LABELS[w.role])})` })),
  ];
  const hasDomain = (domains.data?.domains.length ?? 0) > 0;
  const selected = destinations.find((d) => d.value === choice) ?? destinations[0];
  const destinationName =
    selected?.value === PERSONAL
      ? t("space.personal")
      : (items.find((w) => w.slug === selected?.value)?.name ?? "");
  // The target's maximum life of artifacts (decision 0023): a move starts a new life there, so
  // the person moving it learns by when it would be archived before confirming.
  const destinationPolicy =
    selected?.value === PERSONAL
      ? undefined
      : items.find((w) => w.slug === selected?.value)?.policy;
  const maxLife =
    artifact.state === "active" && destinationPolicy?.artifactMaxDays
      ? {
          days: destinationPolicy.artifactMaxDays,
          by: maxLifeDeadline(
            {
              days: destinationPolicy.artifactMaxDays,
              from: destinationPolicy.artifactMaxDaysFrom ?? 0,
            },
            Date.now(),
          ),
        }
      : null;

  const move = useMutation({
    mutationFn: (to: string) => api.transferArtifact(artifact.id, to === PERSONAL ? null : to),
    onSuccess: async (moved) => {
      setConfirming(false);
      queryClient.setQueryData(artifactQuery(artifact.id), moved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY }),
        queryClient.invalidateQueries({ queryKey: USAGE_QUERY }),
        queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY }),
      ]);
      announce(t("transfer.done", { name: artifact.name, space: destinationName }));
      // The shell follows the artifact to its new space.
      await navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: artifact.id },
        search: { workspace: moved.owner.kind === "workspace" ? moved.owner.slug : undefined },
      });
    },
    onError: () => setConfirming(false),
  });

  let body: ReactNode;
  if (!mayLeave) {
    body = (
      <Callout title={t("transfer.blocked")} icon={<Info className="size-5" />}>
        {t("transfer.notAdmin", { workspace: sourceName })}
      </Callout>
    );
  } else if (hasDomain) {
    body = (
      <Callout title={t("transfer.blocked")} icon={<Info className="size-5" />}>
        {t("transfer.domain")}
      </Callout>
    );
  } else if (workspaces.isSuccess && destinations.length === 0) {
    body = (
      <p className="text-sm text-text-muted">
        {t(sourceRegion === DEFAULT_REGION ? "transfer.none" : "transfer.noneInRegion")}
      </p>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <Select
            label={t("transfer.destination")}
            value={selected?.value ?? ""}
            options={destinations}
            disabled={!workspaces.isSuccess || move.isPending}
            onChange={setChoice}
          />
        </div>
        <Button
          icon={<ArrowRightLeft className="size-4" />}
          disabled={selected === undefined || move.isPending}
          busy={move.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("transfer.move")}
        </Button>
      </div>
    );
  }

  const own = move.error instanceof ApiFailure ? TRANSFER_ERRORS[move.error.code] : undefined;
  return (
    <Panel
      headingLevel={3}
      title={t("transfer.title")}
      description={t("transfer.description", { space: sourceName })}
    >
      <div className="flex flex-col gap-4">
        {move.isError ? (
          <Callout
            tone="error"
            title={t("transfer.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {own ? t(own, { space: destinationName }) : errorMessage(t, move.error)}
          </Callout>
        ) : null}
        {body}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("transfer.confirm.title", { name: artifact.name, space: destinationName })}
        confirmLabel={t("transfer.confirm.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<ArrowRightLeft className="size-4" />}
        busy={move.isPending}
        onConfirm={() => (selected ? move.mutate(selected.value) : undefined)}
        onCancel={() => setConfirming(false)}
      >
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>{t("transfer.confirm.stays")}</li>
          <li>{t("transfer.confirm.changes", { space: destinationName })}</li>
          <li>{t("transfer.confirm.plan", { space: destinationName })}</li>
          <li>{t("transfer.confirm.blocks", { space: destinationName })}</li>
          {artifact.accessMode === "workspace" || artifact.accessMode === "domain" ? (
            <li>{t("transfer.confirm.accessReset")}</li>
          ) : null}
          {maxLife ? (
            <li>
              {t("transfer.confirm.maxLife", {
                space: destinationName,
                days: maxLife.days,
                date: formatDate(new Date(maxLife.by).toISOString()),
              })}
            </li>
          ) : null}
        </ul>
      </ConfirmDialog>
    </Panel>
  );
}
