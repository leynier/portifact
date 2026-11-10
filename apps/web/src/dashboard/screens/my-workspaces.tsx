// The workspaces section of Settings (premium plan T1): the workspaces the account belongs to,
// with its role in each, a way to open each one and to leave it. The only admin of a workspace
// cannot leave, which the section says next to the workspace instead of offering the button.
import type { WorkspaceView } from "@portifact/contracts";
import { Badge, Button, Callout, ConfirmDialog, LoadingState } from "@portifact/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, LogOut, Mail } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { ROLE_LABELS, useWorkspaces, WORKSPACES_QUERY } from "../space.tsx";
import { Section } from "./account.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { useIncomingInvitations } from "./invitations.tsx";

export function MyWorkspaces() {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const workspaces = useWorkspaces();
  const invitations = useIncomingInvitations().data?.items.length ?? 0;
  const [leaving, setLeaving] = useState<WorkspaceView | null>(null);
  const leave = useMutation({
    mutationFn: (workspace: WorkspaceView) => api.leaveWorkspace(workspace.slug),
    onSuccess: async (_, workspace) => {
      setLeaving(null);
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY });
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      announce(t("members.left", { workspace: workspace.name }));
    },
    onError: () => setLeaving(null),
  });

  let body: ReactNode;
  if (workspaces.isPending) body = <LoadingState label={t("workspaces.loading")} />;
  else if (workspaces.isError) {
    body = (
      <Callout
        tone="error"
        title={t("workspaces.loadFailed")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, workspaces.error)}
      </Callout>
    );
  } else if (workspaces.data.items.length === 0) {
    body = <p className="max-w-3xl text-sm text-text-muted">{t("workspaces.none")}</p>;
  } else {
    body = (
      <ul
        aria-label={t("workspaces.title")}
        className="divide-y divide-border rounded-md border border-border"
      >
        {workspaces.data.items.map((workspace) => (
          <li
            key={workspace.slug}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Link
                to="/"
                search={{ workspace: workspace.slug }}
                className="font-semibold break-all"
              >
                {workspace.name}
              </Link>
              <Badge emphasis="subtle">{t(ROLE_LABELS[workspace.role])}</Badge>
            </div>
            <Button
              intent="ghost"
              size="sm"
              icon={<LogOut className="size-4" />}
              aria-label={t("workspaces.leaveNamed", { workspace: workspace.name })}
              busy={leave.isPending && leave.variables?.slug === workspace.slug}
              onClick={() => setLeaving(workspace)}
            >
              {t("workspaces.leave")}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Section id="workspaces" title={t("workspaces.title")} hint={t("workspaces.description")}>
      <div className="flex flex-col gap-4">
        {leave.isError ? (
          <Callout
            tone="error"
            title={t("members.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, leave.error)}
          </Callout>
        ) : null}
        {body}
        {invitations > 0 ? (
          <p className="flex items-center gap-2 text-sm">
            <Mail aria-hidden="true" className="size-4" />
            <Link to="/invitations">{t("space.invitations", { count: invitations })}</Link>
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={leaving !== null}
        title={t("members.confirmLeave.title", { workspace: leaving?.name ?? "" })}
        confirmLabel={t("members.leave")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<LogOut className="size-4" />}
        tone="danger"
        busy={leave.isPending}
        onConfirm={() => (leaving ? leave.mutate(leaving) : undefined)}
        onCancel={() => setLeaving(null)}
      >
        {t("members.confirmLeave.body")}
      </ConfirmDialog>
    </Section>
  );
}
