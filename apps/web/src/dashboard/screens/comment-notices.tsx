// The caller's comment notices for one artifact (docs/security.md, "Comment notices"): a checkbox
// that mutes or unmutes the email digests of new comments on it, saved as soon as it changes,
// shown in the viewer's comments and in the artifact's comment settings. When the owner's plan has
// no comment notices, the artifact's settings say which plan includes them; there is no checkout
// yet, so nothing else is offered. Muting is personal: it never changes what anyone else gets.
import { lowestPlanWith, PLAN_LABELS } from "@portifact/contracts";
import { Callout, Checkbox } from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { errorMessage } from "./artifact-list.tsx";

export const commentNoticesQuery = (artifactId: string) => ["comment-notices", artifactId] as const;

export function CommentNoticeToggle({
  artifactId,
  explainPlan,
}: {
  artifactId: string;
  /** Says which plan includes comment notices when the owner's has none. */
  explainPlan: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const state = useQuery({
    queryKey: commentNoticesQuery(artifactId),
    queryFn: () => api.commentNoticeMute(artifactId),
    staleTime: 60_000,
  });
  const change = useMutation({
    mutationFn: (muted: boolean) => api.setCommentNoticeMute(artifactId, muted),
    onSuccess: (next) => {
      queryClient.setQueryData(commentNoticesQuery(artifactId), next);
      announce(t(next.muted ? "commentNotices.muted" : "commentNotices.unmuted"));
    },
  });

  // A preference, not something to read: while it loads or if it fails, nothing is shown.
  if (!state.data) return null;
  if (!state.data.available) {
    return explainPlan ? (
      <p className="text-sm text-text-muted">
        {t("commentNotices.planRequired", { plan: PLAN_LABELS[lowestPlanWith("commentNotices")] })}
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        label={t("commentNotices.label")}
        description={t("commentNotices.hint")}
        checked={!state.data.muted}
        disabled={change.isPending}
        onChange={(event) => change.mutate(!event.currentTarget.checked)}
      />
      {change.isError ? (
        <Callout
          tone="error"
          title={t("commentNotices.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, change.error)}
        </Callout>
      ) : null}
    </div>
  );
}
