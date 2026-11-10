// Approval reviews (premium plan T6, decision 0012; not review mode, the commenting session).
// The artifact page's Reviews section lets the owner side ask people to review the current
// version, see each verdict and note, change the request or cancel it; the viewer shows the
// status in the bar and, to a requested reviewer, the two verdict actions with a note. The API
// applies every rule (the plan, roles, who may review, who sees what); this only shows what it
// returns. Names and notes are reviewers' text: rendered as text, never as markup.
import {
  APPROVALS,
  type ApprovalReviewerView,
  type ApprovalReviewView,
  type ApprovalStatus,
  type ApprovalSummary,
  type ApprovalVerdict,
  type ArtifactSummary,
  Email,
  lowestPlanWith,
  PLAN_LABELS,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  LoadingState,
  Panel,
  Select,
  TextArea,
  TextInput,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Info,
  RefreshCw,
  Send,
  ThumbsUp,
  UserMinus,
  UserPlus,
  XCircle,
} from "lucide-react";
import { useId, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { errorMessage } from "./artifact-list.tsx";

type T = ReturnType<typeof useT>;

export const approvalQuery = (artifactId: string) => ["artifact", artifactId, "approval"] as const;

const STATUS_ICON: Record<ApprovalStatus, React.ReactNode> = {
  none: <CircleDashed className="size-3.5" />,
  pending: <Clock className="size-3.5" />,
  changes_requested: <XCircle className="size-3.5" />,
  approved: <CircleCheck className="size-3.5" />,
};

/** The status as a badge: icon, label and weight differ by state, never tone alone. */
export function ApprovalStatusBadge({ review }: { review: ApprovalSummary }) {
  const t = useT();
  return (
    <Badge
      emphasis={
        review.status === "changes_requested"
          ? "strong"
          : review.status === "approved"
            ? "normal"
            : "quiet"
      }
      icon={STATUS_ICON[review.status]}
    >
      {t(`approval.status.${review.status}`)}
    </Badge>
  );
}

function counts(t: T, review: ApprovalSummary): string {
  return t("approval.counts", {
    approvals: review.approvals,
    required: review.required,
    changes: review.changesRequested,
  });
}

function verdictLabel(t: T, verdict: ApprovalVerdict | null): string {
  if (verdict === null) return t("approval.verdict.pending");
  return t(verdict === "approve" ? "approval.verdict.approve" : "approval.verdict.changes");
}

/** Addresses typed one per line or separated by commas, without repeats. */
export function parseReviewers(text: string): string[] | null {
  const parts = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (parts.length === 0 || parts.length > APPROVALS.reviewersPerRequest) return null;
  return parts.every((part) => Email.safeParse(part).success) ? parts : null;
}

function requiredOptions(t: T, reviewers: number) {
  return [
    { value: "all", label: t("approval.required.all") },
    ...Array.from({ length: Math.max(0, reviewers - 1) }, (_, i) => ({
      value: String(i + 1),
      label: t("approval.required.count", { count: i + 1 }),
    })),
  ];
}

/** The artifact page's Reviews section. */
export function ApprovalReviewPanel({
  artifact,
  disabled,
}: {
  artifact: ArtifactSummary;
  disabled: boolean;
}) {
  const t = useT();
  const { api } = useDashboard();
  const review = useQuery({
    queryKey: approvalQuery(artifact.id),
    queryFn: () => api.getReview(artifact.id),
  });

  let body: React.ReactNode;
  if (review.isPending) body = <LoadingState label={t("approval.loading")} />;
  else if (review.isError && !review.data) {
    body = (
      <Callout
        tone="error"
        title={t("approval.loadFailed")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => review.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, review.error)}
      </Callout>
    );
  } else {
    const view = review.data;
    body =
      view.request === null ? (
        view.available ? (
          <RequestForm artifactId={artifact.id} disabled={disabled} />
        ) : (
          <Callout title={t("approval.paidTitle")} icon={<Info className="size-5" />}>
            {t("approval.paid", { plan: PLAN_LABELS[lowestPlanWith("reviews")] })}
          </Callout>
        )
      ) : (
        <OpenRequest view={view} disabled={disabled} />
      );
  }
  return (
    <Panel headingLevel={3} title={t("approval.title")} description={t("approval.description")}>
      {body}
    </Panel>
  );
}

function useSaved(artifactId: string) {
  const queryClient = useQueryClient();
  return (view: ApprovalReviewView) => {
    queryClient.setQueryData(approvalQuery(artifactId), view);
    // The artifact and the list carry the review's block.
    void queryClient.invalidateQueries({ queryKey: ["artifact", artifactId], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
  };
}

function RequestForm({ artifactId, disabled }: { artifactId: string; disabled: boolean }) {
  const t = useT();
  const announce = useAnnounce();
  const saved = useSaved(artifactId);
  const { api } = useDashboard();
  const request = useMutation({
    mutationFn: (input: { reviewers: string[]; required: number | null; showStatus: boolean }) =>
      api.requestReview(
        artifactId,
        {
          reviewers: input.reviewers,
          requiredApprovals: input.required,
          showStatus: input.showStatus,
        },
        crypto.randomUUID(),
      ),
    onSuccess: (view) => {
      saved(view);
      announce(t("approval.requested"));
    },
  });
  const form = useAppForm({
    defaultValues: { reviewers: "", required: "all", showStatus: false },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        parseReviewers(value.reviewers) === null
          ? {
              fields: {
                reviewers: t("approval.reviewers.invalid", { max: APPROVALS.reviewersPerRequest }),
              },
            }
          : undefined,
    },
    onSubmit: async ({ value }) => {
      const reviewers = parseReviewers(value.reviewers) ?? [];
      const required = value.required === "all" ? null : Number(value.required);
      await request
        .mutateAsync({
          reviewers,
          required: required !== null && required >= reviewers.length ? null : required,
          showStatus: value.showStatus,
        })
        .catch(() => {});
    },
  });
  return (
    <div className="flex flex-col gap-4">
      {request.isError ? (
        <Callout
          tone="error"
          title={t("approval.requestFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, request.error)}
        </Callout>
      ) : null}
      <form.AppForm>
        <form.Form label={t("approval.request")}>
          <div className="flex max-w-xl flex-col gap-4">
            <form.AppField name="reviewers">
              {(field) => (
                <field.TextAreaField
                  label={t("approval.reviewers")}
                  description={t("approval.reviewers.hint", { max: APPROVALS.reviewersPerRequest })}
                  compact
                  rows={3}
                  autoComplete="off"
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.reviewers}>
              {(typed) => (
                <form.AppField name="required">
                  {(field) => (
                    <field.SelectField
                      label={t("approval.required.label")}
                      options={requiredOptions(t, parseReviewers(typed)?.length ?? 1)}
                      disabled={disabled}
                    />
                  )}
                </form.AppField>
              )}
            </form.Subscribe>
            <form.AppField name="showStatus">
              {(field) => (
                <field.CheckboxField
                  label={t("approval.showStatus.label")}
                  description={t("approval.showStatus.hint")}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <div>
              <form.SubmitButton
                intent="secondary"
                icon={<Send className="size-4" />}
                busy={request.isPending}
                disabled={disabled}
              >
                {t("approval.request")}
              </form.SubmitButton>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}

function reviewerName(t: T, reviewer: ApprovalReviewerView): string {
  return reviewer.name ?? reviewer.email ?? t("approval.someone");
}

function ReviewerList({
  reviewers,
  onRemove,
  disabled,
}: {
  reviewers: readonly ApprovalReviewerView[];
  onRemove?: ((reviewer: ApprovalReviewerView) => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  return (
    <ul
      aria-label={t("approval.list")}
      className="divide-y divide-border rounded-md border border-border"
    >
      {reviewers.map((reviewer) => (
        <li
          key={reviewer.id}
          className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-words">
              {reviewerName(t, reviewer)}
              {reviewer.you ? ` (${t("approval.you")})` : ""}
            </p>
            {reviewer.email && reviewer.name ? (
              <p className="text-sm break-words text-text-muted">{reviewer.email}</p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-muted">
              <Badge
                emphasis={
                  reviewer.verdict === "changes" ? "strong" : reviewer.verdict ? "normal" : "quiet"
                }
                icon={
                  reviewer.verdict === "approve" ? (
                    <CircleCheck className="size-3.5" />
                  ) : reviewer.verdict === "changes" ? (
                    <XCircle className="size-3.5" />
                  ) : (
                    <Clock className="size-3.5" />
                  )
                }
              >
                {verdictLabel(t, reviewer.verdict)}
              </Badge>
              {reviewer.decidedAt
                ? t("approval.decided", { date: formatDate(reviewer.decidedAt, true) })
                : null}
              {reviewer.active ? null : <span>{t("approval.noAccess")}</span>}
              {reviewer.name === null && reviewer.email ? (
                <span>{t("approval.invited")}</span>
              ) : null}
            </p>
            {reviewer.note ? (
              <p className="mt-2 text-sm break-words whitespace-pre-wrap">{reviewer.note}</p>
            ) : null}
          </div>
          {onRemove ? (
            <Button
              intent="ghost"
              size="sm"
              icon={<UserMinus className="size-4" />}
              aria-label={t("approval.removeLabel", { name: reviewerName(t, reviewer) })}
              disabled={disabled || reviewers.length <= 1}
              onClick={() => onRemove(reviewer)}
            >
              {t("approval.remove")}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OpenRequest({ view, disabled }: { view: ApprovalReviewView; disabled: boolean }) {
  const t = useT();
  const announce = useAnnounce();
  const formatDate = useFormatDate();
  const saved = useSaved(view.artifactId);
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | undefined>();
  const request = view.request as NonNullable<ApprovalReviewView["request"]>;
  const manage = view.role === "owner";
  const change = useMutation({
    mutationFn: (input: Parameters<typeof api.changeReview>[1]) =>
      api.changeReview(view.artifactId, input, crypto.randomUUID()),
    onSuccess: (next) => {
      saved(next);
      setAdding("");
      announce(t("approval.changed"));
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelReview(view.artifactId),
    onSuccess: (next) => {
      setConfirming(false);
      saved(next);
      announce(t("approval.cancelled"));
    },
  });
  const locked = disabled || !view.available || change.isPending;
  const failed = change.error ?? cancel.error;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ApprovalStatusBadge review={view.review} />
        <p className="text-sm">{counts(t, view.review)}</p>
      </div>
      {!view.available && manage ? (
        <Callout title={t("approval.paidTitle")} icon={<Info className="size-5" />}>
          {t("approval.lapsed")}
        </Callout>
      ) : null}
      {failed ? (
        <Callout
          tone="error"
          title={t("approval.changeFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, failed)}
        </Callout>
      ) : null}
      <p className="text-sm text-text-muted">{t("approval.untrusted")}</p>
      <ReviewerList
        reviewers={request.reviewers}
        disabled={locked}
        onRemove={
          manage
            ? (reviewer) => {
                if (reviewer.email) change.mutate({ remove: [reviewer.email] });
              }
            : undefined
        }
      />
      {manage ? (
        <div className="flex max-w-xl flex-col gap-4 border-t border-border pt-4">
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = Email.safeParse(adding.trim());
              if (!parsed.success) {
                setAddError(
                  t("approval.reviewers.invalid", { max: APPROVALS.reviewersPerRequest }),
                );
                return;
              }
              setAddError(undefined);
              change.mutate({ add: [parsed.data] });
            }}
          >
            <div className="flex-1">
              <TextInput
                type="email"
                label={t("approval.add.label")}
                value={adding}
                error={addError}
                autoComplete="off"
                disabled={locked || request.reviewers.length >= APPROVALS.reviewersPerRequest}
                onChange={(event) => setAdding(event.currentTarget.value)}
              />
            </div>
            <Button
              type="submit"
              icon={<UserPlus className="size-4" />}
              disabled={locked || request.reviewers.length >= APPROVALS.reviewersPerRequest}
            >
              {t("approval.add")}
            </Button>
          </form>
          <Select
            label={t("approval.required.label")}
            value={request.requiredApprovals === null ? "all" : String(request.requiredApprovals)}
            options={requiredOptions(t, request.reviewers.length)}
            disabled={locked}
            onChange={(value) =>
              change.mutate({ requiredApprovals: value === "all" ? null : Number(value) })
            }
          />
          <Checkbox
            label={t("approval.showStatus.label")}
            description={t("approval.showStatus.hint")}
            checked={request.showStatus}
            disabled={locked}
            onChange={(event) => change.mutate({ showStatus: event.currentTarget.checked })}
          />
          <div>
            <Button
              intent="ghost"
              icon={<XCircle className="size-4" />}
              disabled={disabled || cancel.isPending}
              onClick={() => setConfirming(true)}
            >
              {t("approval.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {manage && request.history.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h4 className="text-sm font-semibold">{t("approval.history")}</h4>
          <ul className="flex flex-col gap-2 text-sm">
            {request.history.map((entry) => (
              <li key={`${entry.reviewer}-${entry.versionId}`} className="break-words">
                {t("approval.history.entry", {
                  name: entry.name ?? t("approval.someone"),
                  verdict: verdictLabel(t, entry.verdict),
                  date: formatDate(entry.decidedAt, true),
                })}
                {entry.note ? (
                  <span className="block whitespace-pre-wrap text-text-muted">{entry.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t("approval.confirm.title")}
        confirmLabel={t("approval.cancel")}
        cancelLabel={t("approval.confirm.keep")}
        confirmIcon={<XCircle className="size-4" />}
        busy={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("approval.confirm.body")}
      </ConfirmDialog>
    </div>
  );
}

/** The review query the viewer shares between the bar's badge and the reviewer's panel. */
export function useApprovalReview(artifactId: string, enabled: boolean) {
  const { api } = useDashboard();
  return useQuery({
    queryKey: approvalQuery(artifactId),
    queryFn: () => api.getReview(artifactId),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** The viewer's panel for a requested reviewer: their verdict, a note and the two actions. */
export function VerdictPanel({ view }: { view: ApprovalReviewView }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const noteId = useId();
  const mine = view.request?.reviewers.find((reviewer) => reviewer.you) ?? null;
  const [note, setNote] = useState(mine?.note ?? "");
  const submit = useMutation({
    mutationFn: (verdict: ApprovalVerdict) =>
      api.submitVerdict(
        view.artifactId,
        {
          verdict,
          ...(note.trim() === "" ? {} : { note }),
          ...(view.request ? { versionId: view.request.versionId } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(approvalQuery(view.artifactId), next);
      announce(t("approval.verdictSaved"));
    },
  });
  if (view.role !== "reviewer" || !view.request) return null;
  const tooLong = [...note].length > APPROVALS.noteMaxCodePoints;
  const stale = submit.error instanceof ApiFailure && submit.error.code === "version_conflict";
  return (
    <section
      aria-labelledby={`${noteId}-title`}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <h2 id={`${noteId}-title`} className="text-base font-semibold">
        {t("approval.yours.title")}
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ApprovalStatusBadge review={view.review} />
        <span>{counts(t, view.review)}</span>
      </div>
      <p className="text-sm">
        {mine?.verdict
          ? t("approval.yours.current", { verdict: verdictLabel(t, mine.verdict) })
          : t("approval.yours.body")}
      </p>
      {submit.isError ? (
        <Callout
          tone="error"
          title={t("approval.verdictFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {stale ? t("approval.newVersion") : errorMessage(t, submit.error)}
        </Callout>
      ) : null}
      <TextArea
        label={t("approval.note.label")}
        description={t("approval.note.hint", { max: APPROVALS.noteMaxCodePoints })}
        compact
        rows={3}
        value={note}
        error={
          tooLong ? t("approval.note.tooLong", { max: APPROVALS.noteMaxCodePoints }) : undefined
        }
        onChange={(event) => setNote(event.currentTarget.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          intent="primary"
          icon={<ThumbsUp className="size-4" />}
          busy={submit.isPending && submit.variables === "approve"}
          disabled={submit.isPending || tooLong}
          onClick={() => submit.mutate("approve")}
        >
          {t("approval.approve")}
        </Button>
        <Button
          size="sm"
          icon={<XCircle className="size-4" />}
          busy={submit.isPending && submit.variables === "changes"}
          disabled={submit.isPending || tooLong}
          onClick={() => submit.mutate("changes")}
        >
          {t("approval.requestChanges")}
        </Button>
      </div>
    </section>
  );
}
