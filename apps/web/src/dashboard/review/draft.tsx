// The owner's draft in the viewer (decision 0027, "The owner's draft"): edits the owner side makes
// directly, kept private to their author, seen as a plan of what applies and what goes to the
// change list, and published as one version once confirmed by the plan's digest, or discarded.
// The draft's text is the author's own, but it is still drawn through the typed display.
import {
  type DraftEdit,
  DraftEdit as DraftEditSchema,
  type DraftView,
  REFUSAL_REASONS,
  type ReviewStart,
  TextOperation,
} from "@portifact/contracts";
import { tokens } from "@portifact/domain/suggestion-display";
import {
  Badge,
  Button,
  ConfirmDialog,
  EditDiff,
  LoadingState,
  PlanLines,
  Tabs,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { addToDraft, removeFromDraft } from "./draft-edit.ts";
import {
  attemptMessage,
  PlanSummary,
  PreviewPanel,
  reasonMessage,
  useDiffLabels,
} from "./suggestions.tsx";
import { ActionError } from "./thread-card.tsx";

/** Why a change could not be moved: a refusal of the planners, or the relocation's own reason. */
function conflictMessage(t: ReturnType<typeof useT>, reason: string): string {
  return isRefusalReason(reason) ? reasonMessage(t, reason) : t("draft.conflictReason");
}

const isRefusalReason = (reason: string) => (REFUSAL_REASONS as readonly string[]).includes(reason);

export const draftQuery = (artifactId: string) => ["suggestion-draft", artifactId] as const;

/** The draft's edit as the client reads it, or null when it is none the contracts accept. */
const editOf = (draft: DraftView | null): DraftEdit | null => {
  const parsed = DraftEditSchema.safeParse(draft?.edit);
  return parsed.success ? parsed.data : null;
};

export interface DraftState {
  draft: DraftView | null;
  loading: boolean;
  /**
   * Adds an operation (replacing the one on the same text) and saves the whole draft. Answers
   * false and announces why when it is refused.
   */
  add(operation: TextOperation): Promise<boolean>;
  /** The whole draft with `operation` added, or null when it could not take it. */
  editWith(operation: TextOperation): DraftEdit | null;
}

/** The caller's draft on the artifact, and saving it at the revision and incarnation held. */
export function useDraft(
  start: ReviewStart,
  enabled: boolean,
): DraftState & {
  save(edit: DraftEdit | null): Promise<boolean>;
  error: unknown;
} {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const key = draftQuery(start.artifactId);
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: () =>
      api.suggestions.draft(start.artifactId).catch((error: unknown) => {
        if (error instanceof ApiFailure && error.code === "not_found") return null;
        throw error;
      }),
  });
  const draft = query.data ?? null;
  const mutation = useMutation({
    mutationFn: async (edit: DraftEdit | null) => {
      if (edit === null) {
        await api.suggestions.discardDraft(start.artifactId);
        return null;
      }
      return api.suggestions.saveDraft(start.artifactId, {
        baseVersionId: draft?.baseVersionId ?? start.versionId,
        edit,
        baseRevision: draft?.revision ?? null,
        baseIncarnation: draft?.incarnation ?? null,
      });
    },
    onSuccess: (saved) => queryClient.setQueryData(key, saved),
    onError: async (error) => {
      // Saved elsewhere meanwhile (another tab, a discard): show the draft as it is now.
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        announce(t("draft.conflict"));
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  const save = async (edit: DraftEdit | null) => {
    try {
      await mutation.mutateAsync(edit);
      return true;
    } catch {
      return false;
    }
  };
  return {
    draft,
    loading: query.isPending && enabled,
    error: mutation.error ?? query.error,
    save,
    editWith(operation) {
      const next = addToDraft(editOf(draft), operation);
      return next.ok ? next.edit : null;
    },
    async add(operation) {
      if (draft && draft.baseVersionId !== start.versionId) {
        announce(t("draft.refused.stale"));
        return false;
      }
      const next = addToDraft(editOf(draft), operation);
      if (!next.ok) {
        announce(t(`draft.refused.${next.reason}`));
        return false;
      }
      const saved = await save(next.edit);
      if (saved) announce(t("draft.added"));
      return saved;
    },
  };
}

/**
 * The sidebar's panel of the owner's draft: its changes, what applies, publishing and
 * discarding. Shown only to the owner side while suggestions are on.
 */
export function DraftPanel({
  start,
  state,
}: {
  start: ReviewStart;
  state: ReturnType<typeof useDraft>;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const labels = useDiffLabels();
  const [confirming, setConfirming] = useState<"publish" | "discard" | null>(null);
  /** One key per opened dialog, and one request per confirmation. */
  const publishKey = useRef("");
  const deciding = useRef(false);
  const { draft } = state;
  const edit = editOf(draft);
  const stale = draft !== null && draft.baseVersionId !== start.versionId;

  const plan = useMutation({ mutationFn: () => api.suggestions.planDraft(start.artifactId) });
  /** What the last rebase could not carry: shown until the next one, for the author to redo. */
  const [conflicts, setConflicts] = useState<{ operation: unknown; reason: string }[]>([]);
  const rebase = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error("no draft");
      return api.suggestions.rebaseDraft(start.artifactId, {
        baseRevision: draft.revision,
        baseIncarnation: draft.incarnation,
      });
    },
    onSuccess: (rebased) => {
      queryClient.setQueryData(draftQuery(start.artifactId), rebased.draft);
      setConflicts(rebased.conflicts);
      plan.reset();
      announce(
        t("draft.rebased", {
          carried: editOf(rebased.draft)?.operations.length ?? 0,
          left: rebased.conflicts.length,
        }),
      );
    },
    onError: async (error) => {
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: draftQuery(start.artifactId) });
      }
    },
  });
  const publish = useMutation({
    mutationFn: (digest: string) =>
      api.suggestions.publishDraft(start.artifactId, { digest }, publishKey.current),
    onSuccess: async () => {
      setConfirming(null);
      plan.reset();
      announce(t("draft.publishing"));
      await queryClient.invalidateQueries({ queryKey: draftQuery(start.artifactId) });
    },
    onError: () => setConfirming(null),
    onSettled: () => {
      deciding.current = false;
    },
  });

  if (state.loading) return <LoadingState label={t("draft.loading")} />;
  const shown = plan.data;
  return (
    <section aria-labelledby="owner-draft-heading" className="flex flex-col gap-2">
      <h3 id="owner-draft-heading" className="text-base font-semibold">
        {t("draft.heading")}
      </h3>
      {state.error ? <ActionError error={state.error} /> : null}
      {draft === null || edit === null ? (
        <p className="text-sm text-text-muted">{t("draft.empty")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge emphasis="quiet">{t("draft.count", { count: edit.operations.length })}</Badge>
            {draft.publishing ? (
              <Badge emphasis="strong">{t("draft.publishingBadge")}</Badge>
            ) : null}
          </div>
          {stale ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">{t("draft.stale")}</p>
              {rebase.isError ? <ActionError error={rebase.error} /> : null}
              {draft.publishing ? null : (
                <div>
                  <Button size="sm" busy={rebase.isPending} onClick={() => rebase.mutate()}>
                    {t("draft.rebase")}
                  </Button>
                </div>
              )}
            </div>
          ) : null}
          {draft.attemptReason && !draft.publishing ? (
            <p className="text-sm">
              {t("draft.attemptEnded", { reason: attemptMessage(t, draft.attemptReason) })}
            </p>
          ) : null}
          <ol aria-label={t("draft.changes")} className="flex flex-col gap-2">
            {edit.operations.map((operation, index) =>
              operation.kind === "text" && operation.target.anchor.kind === "text" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the draft's operations keep their order
                <li key={index} className="flex flex-col gap-1">
                  <EditDiff
                    before={tokens(operation.target.anchor.quote.exact)}
                    after={tokens(operation.after)}
                    labels={labels}
                  />
                  {draft.publishing ? null : (
                    <div>
                      <Button
                        size="sm"
                        intent="ghost"
                        icon={<X className="size-4" />}
                        aria-label={t("draft.remove", { number: index + 1 })}
                        onClick={() => {
                          plan.reset();
                          void state.save(removeFromDraft(edit, index));
                        }}
                      >
                        {t("draft.removeShort")}
                      </Button>
                    </div>
                  )}
                </li>
              ) : null,
            )}
          </ol>
          {plan.isError ? <ActionError error={plan.error} /> : null}
          {publish.isError ? <ActionError error={publish.error} /> : null}
          {shown && !draft.publishing ? (
            <Tabs
              label={t("draft.tabs")}
              tabs={[
                { id: "plan", label: t("suggest.tabs.plan"), panel: <PlanSummary plan={shown} /> },
                {
                  id: "preview",
                  label: t("suggest.tabs.preview"),
                  panel: (
                    <PreviewPanel
                      artifactId={start.artifactId}
                      request={{ digest: shown.digest }}
                    />
                  ),
                },
              ]}
            />
          ) : null}
          {draft.publishing ? null : (
            <div className="flex flex-wrap gap-2">
              {stale ? null : shown ? (
                <Button
                  size="sm"
                  intent="primary"
                  icon={<Send className="size-4" />}
                  onClick={() => {
                    publishKey.current = crypto.randomUUID();
                    setConfirming("publish");
                  }}
                >
                  {t("draft.publish")}
                </Button>
              ) : (
                <Button size="sm" busy={plan.isPending} onClick={() => plan.mutate()}>
                  {t("suggest.plan.check")}
                </Button>
              )}
              <Button
                size="sm"
                intent="danger"
                icon={<Trash2 className="size-4" />}
                onClick={() => setConfirming("discard")}
              >
                {t("draft.discard")}
              </Button>
            </div>
          )}
        </>
      )}
      {conflicts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("draft.conflicts")}</p>
          <ul aria-label={t("draft.conflicts")} className="flex flex-col gap-2">
            {conflicts.map((conflict, index) => {
              const parsed = TextOperation.safeParse(conflict.operation);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: conflicts keep their order
                <li key={index} className="flex flex-col gap-1 text-sm">
                  {parsed.success && parsed.data.target.anchor.kind === "text" ? (
                    <EditDiff
                      before={tokens(parsed.data.target.anchor.quote.exact)}
                      after={tokens(parsed.data.after)}
                      labels={labels}
                    />
                  ) : null}
                  <span>{conflictMessage(t, conflict.reason)}</span>
                </li>
              );
            })}
          </ul>
          <div>
            <Button size="sm" intent="ghost" onClick={() => setConflicts([])}>
              {t("draft.conflicts.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming === "publish" && shown !== undefined}
        title={t("draft.publish.title")}
        confirmLabel={t("draft.publish.confirm")}
        cancelLabel={t("suggest.editor.cancel")}
        busy={publish.isPending}
        onConfirm={() => {
          if (!shown || deciding.current) return;
          deciding.current = true;
          publish.mutate(shown.digest);
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>
          {t("suggest.accept.body", {
            applied: shown?.applied.length ?? 0,
            listed: shown?.listed.length ?? 0,
          })}
        </p>
        {shown ? <PlanLines label={t("suggest.plan.lines")} lines={shown.lines} /> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "discard"}
        title={t("draft.discard.title")}
        confirmLabel={t("draft.discard")}
        cancelLabel={t("suggest.editor.cancel")}
        tone="danger"
        onConfirm={() => {
          setConfirming(null);
          plan.reset();
          void state.save(null).then((done) => {
            if (done) announce(t("draft.discarded"));
          });
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>{t("draft.discard.body")}</p>
      </ConfirmDialog>
    </section>
  );
}
