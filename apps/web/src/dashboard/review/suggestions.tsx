// Edit suggestions in the viewer (decision 0027, "The viewer"): the editor a reviewer types an
// edit in, the suggestion inside its thread card (its before and after, the plan of what applies,
// the built preview, and accepting, rejecting or withdrawing it) and the owner side's change list.
// Everything a reviewer wrote (the edit, the note, a plan's lines and an envelope's fields) is
// untrusted: it is drawn only as text, through the typed display, and never sent to the frame.
import {
  type AnnotationThreadView,
  CHANGE_ITEM_STATES,
  type ChangeItemView,
  Edit,
  type Plan,
  type PreviewResponse,
  REFUSAL_REASONS,
  type RefusalReason,
  type ReviewStart,
  ShownEnvelope,
  type SuggestionView,
  type TextOperation,
} from "@portifact/contracts";
import { tokens } from "@portifact/domain/suggestion-display";
import {
  Badge,
  Button,
  CodePointList,
  ConfirmDialog,
  Disclosure,
  EditDiff,
  LoadingState,
  PlanLines,
  SuggestionPreview,
  Tabs,
  TextArea,
  TextInput,
  TypedText,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, PencilLine, Undo2, X } from "lucide-react";
import { type Dispatch, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { useHumanCheck } from "./human-check.tsx";
import { editOf, type SuggestAction, type SuggestState } from "./suggest-session.ts";
import { ActionError, bodyError, humanRefusal } from "./thread-card.tsx";
import { applySuggestion, applyThread, threadsQuery } from "./use-threads.ts";

type T = ReturnType<typeof useT>;

/** The suggestion a thread carries, when it was listed with its kind (`?fields=suggestion`). */
export function suggestionOf(thread: AnnotationThreadView): SuggestionView | null {
  const extended = thread as AnnotationThreadView & { kind?: unknown; suggestion?: unknown };
  if (extended.kind !== "suggestion") return null;
  return (extended.suggestion as SuggestionView | null | undefined) ?? null;
}

/** Whether resolving the thread is refused: a suggestion still waiting for its decision. */
export const undecided = (suggestion: SuggestionView | null): boolean =>
  suggestion !== null && (suggestion.state === "pending" || suggestion.state === "applying");

export const changesQuery = (artifactId: string) => ["suggestion-changes", artifactId] as const;

export function useDiffLabels() {
  const t = useT();
  return {
    removed: t("suggest.diff.removed"),
    added: t("suggest.diff.added"),
    character: t("suggest.diff.character"),
    empty: t("suggest.diff.empty"),
  };
}

const isRefusal = (reason: string): reason is RefusalReason =>
  (REFUSAL_REASONS as readonly string[]).includes(reason);

/** A refusal or preview reason in the reader's language; a reason this build does not know too. */
export function reasonMessage(t: T, reason: string): string {
  if (isRefusal(reason)) return t(`suggest.refusal.${reason}`);
  if (reason === "css_too_complex") return t("suggest.preview.cssTooComplex");
  return t("suggest.refusal.unknown");
}

function stateLabel(t: T, state: string): string {
  switch (state) {
    case "pending":
    case "applying":
    case "accepted":
    case "rejected":
    case "withdrawn":
    case "outdated":
      return t(`suggest.state.${state}`);
    default:
      return t("suggest.state.unknown");
  }
}

/**
 * The editor of a text suggestion: the selected text, a one-line field prefilled with it, the
 * change drawn here as it is typed, and the reviewer's note. Enter reviews the exact change Save
 * sends; Escape cancels. Nothing typed here is ever sent to the frame.
 */
export function SuggestEditor({
  start,
  state,
  dispatch,
  humanNeeded,
  onClose,
  draft,
}: {
  start: ReviewStart;
  state: Extract<SuggestState, { mode: "editing" }>;
  dispatch: Dispatch<SuggestAction>;
  humanNeeded: boolean;
  /**
   * The owner side editing directly (Edit mode): Save adds the change to their private draft
   * instead of starting a suggestion, and no note is asked.
   */
  draft?: { add(operation: TextOperation): Promise<boolean> } | undefined;
  /** The editor closed: saved (with the new thread's ID) or cancelled. */
  onClose(threadId: string | null): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const labels = useDiffLabels();
  const human = useHumanCheck(humanNeeded);
  const panel = useRef<HTMLDivElement>(null);
  const [noteError, setNoteError] = useState<string | undefined>();
  const edit = editOf(state);
  const before = state.target.anchor.quote.exact;
  const unchanged = state.after === before;

  const toDraft = useMutation({
    mutationFn: (value: Edit) => {
      const [operation] = value.operations;
      if (!draft || operation?.kind !== "text") return Promise.resolve(false);
      return draft.add(operation);
    },
    onSuccess: (added) => {
      if (!added) return;
      dispatch({ type: "saved" });
      onClose(null);
    },
  });
  const save = useMutation({
    mutationFn: (value: Edit) =>
      human.post((key, token) =>
        api.suggestions.submit(
          start.artifactId,
          {
            versionId: start.versionId,
            edit: value,
            body: state.note,
            ...(token === undefined ? {} : { turnstileToken: token }),
          },
          key,
        ),
      ),
    onSuccess: async (thread) => {
      if (!thread) return;
      applyThread(queryClient, start.artifactId, thread);
      dispatch({ type: "saved" });
      announce(t("suggest.saved"));
      onClose(thread.id);
      // Planned right away (the reviewer's own check): a suggestion never planned cannot be
      // carried to a later version. A refusal here changes nothing for the reviewer.
      await api.suggestions.plan(start.artifactId, thread.id).catch(() => null);
      await queryClient.invalidateQueries({ queryKey: threadsQuery(start.artifactId) });
    },
  });

  useEffect(() => {
    // Placed (and so visible) only after it mounts: focus once more on the next frame.
    const focus = () => {
      const field = panel.current?.querySelector("input");
      if (field && document.activeElement !== field) field.focus();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => {
    dispatch({ type: "cancel" });
    onClose(null);
  };
  const commit = (value: Edit) => (draft ? toDraft.mutate(value) : save.mutate(value));
  const review = () => {
    if (draft) {
      dispatch({ type: "review" });
      return;
    }
    const error = bodyError(t, state.note)?.fields.body;
    setNoteError(error);
    if (!error) dispatch({ type: "review" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (state.reviewing && edit) commit(edit);
      else review();
    }
  };

  const invalid = !unchanged && edit === null ? t("suggest.refusal.invalid_after") : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and Enter work from every control inside
    <div ref={panel} className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <h2 className="text-base font-semibold">
        {state.reviewing
          ? t("suggest.editor.reviewTitle")
          : draft
            ? t("draft.editor.title")
            : t("suggest.editor.title")}
      </h2>
      {/* Which page the edit addresses: two targets can hold the same text. */}
      <p className="text-sm text-text-muted">
        <TypedSentence
          message={(fields) => t("suggest.editor.page", fields)}
          fields={{
            page: state.target.route
              ? `${state.target.path} ${state.target.route}`
              : state.target.path,
          }}
        />
      </p>
      {save.isError && !humanRefusal(save.error) ? <ActionError error={save.error} /> : null}
      {state.reviewing && edit ? (
        <>
          <p className="text-sm text-text-muted">{t("suggest.editor.reviewHint")}</p>
          <EditDiff before={tokens(before)} after={tokens(state.after)} labels={labels} />
          <Disclosure appearance="inline" summary={t("suggest.inspect")}>
            <CodePointList
              label={t("suggest.inspect.after")}
              codePoints={Array.from(state.after, (char) => char.codePointAt(0) as number)}
            />
          </Disclosure>
          {human.field}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => dispatch({ type: "back" })}>{t("suggest.editor.back")}</Button>
            <Button
              intent="primary"
              icon={<Check className="size-4" />}
              busy={save.isPending || toDraft.isPending}
              onClick={() => commit(edit)}
            >
              {draft ? t("draft.add") : t("suggest.editor.save")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <TextInput
            label={t("suggest.editor.after")}
            description={t("suggest.editor.afterHint")}
            value={state.after}
            onChange={(event) => dispatch({ type: "type", after: event.target.value })}
            error={invalid}
            spellCheck
          />
          <EditDiff before={tokens(before)} after={tokens(state.after)} labels={labels} />
          {unchanged ? (
            <p className="text-sm text-text-muted">{t("suggest.editor.unchanged")}</p>
          ) : null}
          {draft ? null : (
            <TextArea
              label={t("suggest.editor.note")}
              description={t("suggest.editor.noteHint")}
              value={state.note}
              onChange={(event) => {
                dispatch({ type: "note", note: event.target.value });
                setNoteError(undefined);
              }}
              error={noteError}
              rows={2}
              compact
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={cancel}>{t("suggest.editor.cancel")}</Button>
            <Button intent="primary" disabled={edit === null} onClick={review}>
              {t("suggest.editor.review")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** What one operation of a saved edit changes, from its untrusted JSON. */
function EditSummary({ edit }: { edit: unknown }) {
  const t = useT();
  const labels = useDiffLabels();
  const parsed = Edit.safeParse(edit);
  if (!parsed.success) return <p className="text-sm">{t("suggest.edit.unknown")}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {parsed.data.operations.map((operation, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: operations keep their order
        <li key={index}>
          {operation.kind === "text" && operation.target.anchor.kind === "text" ? (
            <EditDiff
              before={tokens(operation.target.anchor.quote.exact)}
              after={tokens(operation.after)}
              labels={labels}
            />
          ) : (
            <p className="text-sm">{t("suggest.edit.notText")}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** How many operations apply and are listed, and why the listed ones are. */
export function PlanSummary({ plan }: { plan: Plan }) {
  const t = useT();
  const reasons = [
    ...new Set(plan.listed.map((envelope) => envelope.reason).filter((r) => r !== null)),
  ];
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {t("suggest.plan.summary", { applied: plan.applied.length, listed: plan.listed.length })}
      </p>
      {reasons.length > 0 ? (
        <ul className="list-disc pl-5">
          {reasons.map((reason) => (
            <li key={reason}>{reasonMessage(t, reason)}</li>
          ))}
        </ul>
      ) : null}
      <PlanLines label={t("suggest.plan.lines")} lines={plan.lines} />
    </div>
  );
}

/** A new one-use preview each time the tab is shown: no preview URL is reused. */
function PreviewPanel({ artifactId, plan }: { artifactId: string; plan: Plan }) {
  const t = useT();
  const { api } = useDashboard();
  const preview = useQuery({
    queryKey: ["suggestion-preview", artifactId, plan.digest],
    queryFn: () => api.suggestions.preview(artifactId, plan.digest),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (preview.isPending) return <LoadingState label={t("suggest.preview.loading")} />;
  if (preview.isError) return <ActionError error={preview.error} />;
  return <PreviewView response={preview.data} />;
}

function PreviewView({ response }: { response: PreviewResponse }) {
  const t = useT();
  if (response.state === "unavailable") {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{t("suggest.preview.unavailable")}</p>
        <ul className="list-disc pl-5">
          {response.reasons.map((reason) => (
            <li key={reason}>{reasonMessage(t, reason)}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">{t("suggest.preview.hint")}</p>
      <SuggestionPreview title={t("suggest.preview.title")} url={response.url} />
    </div>
  );
}

/**
 * The suggestion inside its thread card: its state in words, the change, and for a pending one
 * the plan of what applies, its built preview, and the decisions the caller may take.
 */
export function SuggestionBlock({
  artifactId,
  threadId,
  suggestion,
  owner,
  own,
}: {
  artifactId: string;
  threadId: string;
  suggestion: SuggestionView;
  /** The caller is on the owner side: accepts and rejects. */
  owner: boolean;
  /** The caller suggested it: withdraws. */
  own: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState<"accept" | "reject" | "withdraw" | null>(null);
  /** The suggestion's revision when its dialog opened: a decision applies to what was shown. */
  const shownRevision = useRef(suggestion.revision);
  /** One key per opened dialog, so a retry of the same decision is the same request. */
  const decisionKey = useRef("");
  /** Set from the first confirmation until it settles: a second one in the same turn is dropped. */
  const deciding = useRef(false);
  const confirm = (action: "accept" | "reject" | "withdraw") => {
    shownRevision.current = suggestion.revision;
    decisionKey.current = crypto.randomUUID();
    setConfirming(action);
  };
  const once = (run: () => void) => {
    if (deciding.current) return;
    deciding.current = true;
    run();
  };
  const pending = suggestion.state === "pending";

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: threadsQuery(artifactId) }),
      queryClient.invalidateQueries({ queryKey: changesQuery(artifactId) }),
    ]);
  };
  const plan = useMutation({ mutationFn: () => api.suggestions.plan(artifactId, threadId) });
  const accept = useMutation({
    mutationFn: (digest: string) =>
      api.suggestions.accept(artifactId, threadId, { digest }, decisionKey.current),
    onSuccess: async () => {
      setConfirming(null);
      applySuggestion(queryClient, artifactId, threadId, { state: "applying" });
      announce(t("suggest.accept.started"));
      await refresh();
    },
    onError: () => setConfirming(null),
  });
  const decide = useMutation({
    mutationFn: (action: "reject" | "withdraw") =>
      api.suggestions[action](artifactId, threadId, { revision: shownRevision.current }),
    onSuccess: async (view, action) => {
      setConfirming(null);
      applySuggestion(queryClient, artifactId, threadId, view);
      announce(t(action === "reject" ? "suggest.rejected" : "suggest.withdrawn"));
      await refresh();
    },
    onError: () => setConfirming(null),
  });

  const shown = plan.data;
  return (
    <section aria-label={t("suggest.block.label")} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge emphasis="normal" icon={<PencilLine className="size-3.5" />}>
          {t("suggest.badge")}
        </Badge>
        <Badge emphasis={pending ? "strong" : "quiet"}>{stateLabel(t, suggestion.state)}</Badge>
        {suggestion.originVersionId ? <Badge emphasis="quiet">{t("suggest.carried")}</Badge> : null}
      </div>
      {pending && suggestion.attemptReason ? (
        <p className="text-sm">
          {t("suggest.attemptEnded", { reason: attemptMessage(t, suggestion.attemptReason) })}
        </p>
      ) : null}
      {suggestion.edit === null ? (
        <p className="text-sm text-text-muted">{t("suggest.edit.withdrawn")}</p>
      ) : (
        <EditSummary edit={suggestion.edit} />
      )}
      {plan.isError ? <ActionError error={plan.error} /> : null}
      {accept.isError ? <ActionError error={accept.error} /> : null}
      {decide.isError ? <ActionError error={decide.error} /> : null}
      {pending && shown ? (
        <Tabs
          label={t("suggest.tabs.label")}
          tabs={[
            { id: "plan", label: t("suggest.tabs.plan"), panel: <PlanSummary plan={shown} /> },
            {
              id: "preview",
              label: t("suggest.tabs.preview"),
              panel: <PreviewPanel artifactId={artifactId} plan={shown} />,
            },
          ]}
        />
      ) : null}
      {pending ? (
        <div className="flex flex-wrap gap-2">
          {shown ? null : (
            <Button size="sm" busy={plan.isPending} onClick={() => plan.mutate()}>
              {t("suggest.plan.check")}
            </Button>
          )}
          {owner && shown ? (
            <Button
              size="sm"
              intent="primary"
              icon={<CircleCheck className="size-4" />}
              onClick={() => confirm("accept")}
            >
              {t("suggest.accept")}
            </Button>
          ) : null}
          {owner ? (
            <Button
              size="sm"
              intent="danger"
              icon={<X className="size-4" />}
              onClick={() => confirm("reject")}
            >
              {t("suggest.reject")}
            </Button>
          ) : null}
          {own ? (
            <Button
              size="sm"
              intent="danger"
              icon={<Undo2 className="size-4" />}
              onClick={() => confirm("withdraw")}
            >
              {t("suggest.withdraw")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming === "accept" && shown !== undefined}
        title={t("suggest.accept.title")}
        confirmLabel={t("suggest.accept.confirm")}
        cancelLabel={t("suggest.editor.cancel")}
        busy={accept.isPending}
        onConfirm={() =>
          shown &&
          once(() =>
            accept.mutate(shown.digest, {
              onSettled: () => {
                deciding.current = false;
              },
            }),
          )
        }
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
        open={confirming === "reject" || confirming === "withdraw"}
        title={t(confirming === "withdraw" ? "suggest.withdraw.title" : "suggest.reject.title")}
        confirmLabel={t(confirming === "withdraw" ? "suggest.withdraw" : "suggest.reject")}
        cancelLabel={t("suggest.editor.cancel")}
        tone="danger"
        busy={decide.isPending}
        onConfirm={() => {
          const action = confirming;
          if (action === "reject" || action === "withdraw") {
            once(() =>
              decide.mutate(action, {
                onSettled: () => {
                  deciding.current = false;
                },
              }),
            );
          }
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>{t(confirming === "withdraw" ? "suggest.withdraw.body" : "suggest.reject.body")}</p>
      </ConfirmDialog>
    </section>
  );
}

export function attemptMessage(t: T, reason: string): string {
  switch (reason) {
    case "failed":
    case "version_conflict":
    case "quota_exceeded":
    case "capacity_unavailable":
    case "plan_changed":
    case "revoked":
      return t(`suggest.attempt.${reason}`);
    default:
      return t("suggest.attempt.unknown");
  }
}

/** Marks where each untrusted field goes in a translated sentence: private-use characters. */
const FIELD_MARKS = ["\uE000", "\uE001", "\uE002"] as const;

/**
 * A translated sentence around untrusted fields (people's names): the catalog decides the words
 * and their order, and each field is drawn as its own typed, direction-isolated text, so a
 * hidden or bidirectional character in a name never acts on the sentence.
 */
function TypedSentence<K extends string>({
  message,
  fields,
}: {
  message(marks: Record<K, string>): string;
  fields: Record<K, string>;
}) {
  const labels = useDiffLabels();
  const keys = Object.keys(fields) as K[];
  const marks = Object.fromEntries(keys.map((key, i) => [key, FIELD_MARKS[i]])) as Record<
    K,
    string
  >;
  const byMark = new Map(keys.map((key, i) => [FIELD_MARKS[i] as string, fields[key]]));
  const parts = message(marks).split(/([\uE000-\uE002])/u);
  return (
    <>
      {parts.map((part, index) => {
        const value = byMark.get(part);
        return value === undefined ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's parts keep their order
          <span key={index}>{part}</span>
        ) : (
          <TypedText
            // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's parts keep their order
            key={index}
            tokens={tokens(value)}
            characterLabel={labels.character}
            empty={labels.empty}
          />
        );
      })}
    </>
  );
}

/** One change-list item: what the owner side saw and accepted, and its state. */
function ChangeItem({ artifactId, item }: { artifactId: string; item: ChangeItemView }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const labels = useDiffLabels();
  const mark = useMutation({
    mutationFn: (state: "applied" | "dismissed" | "open") =>
      api.suggestions.markChange(
        artifactId,
        item.id,
        { state, baseRevision: item.revision },
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      announce(t("suggest.changes.marked"));
      await queryClient.invalidateQueries({ queryKey: changesQuery(artifactId) });
    },
  });
  const envelope = ShownEnvelope.safeParse(item.envelope);
  const known = (CHANGE_ITEM_STATES as readonly string[]).includes(item.state);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge emphasis={item.state === "open" ? "strong" : "quiet"}>
          {known ? t(`suggest.changes.state.${item.state as "open"}`) : t("suggest.state.unknown")}
        </Badge>
        <span className="text-sm">
          <TypedText
            tokens={tokens(item.path)}
            characterLabel={labels.character}
            empty={labels.empty}
          />
        </span>
      </div>
      {item.reason ? <p className="text-sm">{reasonMessage(t, item.reason)}</p> : null}
      {envelope.success ? (
        <>
          {envelope.data.operation.kind === "text" ? (
            <EditDiff
              before={tokens(envelope.data.operation.before)}
              after={tokens(envelope.data.operation.after)}
              labels={labels}
            />
          ) : (
            <p className="text-sm">{t("suggest.edit.notText")}</p>
          )}
          <p className="text-sm text-text-muted">
            <TypedSentence
              message={(fields) => t("suggest.changes.provenance", fields)}
              fields={{
                submitter: envelope.data.provenance.submittedBy,
                acceptor: envelope.data.provenance.acceptedBy,
              }}
            />
          </p>
          {envelope.data.destinations.length > 0 ? (
            <ul aria-label={t("suggest.changes.links")} className="flex flex-col gap-1 text-sm">
              {envelope.data.destinations.map((link, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order
                <li key={index}>
                  <TypedText
                    tokens={tokens(link.effective)}
                    characterLabel={labels.character}
                    empty={labels.empty}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-sm">{t("suggest.changes.laterFormat")}</p>
      )}
      {mark.isError ? <ActionError error={mark.error} /> : null}
      <div className="flex flex-wrap gap-2">
        {item.state === "open" ? (
          <>
            <Button size="sm" busy={mark.isPending} onClick={() => mark.mutate("applied")}>
              {t("suggest.changes.markApplied")}
            </Button>
            <Button size="sm" busy={mark.isPending} onClick={() => mark.mutate("dismissed")}>
              {t("suggest.changes.dismiss")}
            </Button>
          </>
        ) : (
          <Button size="sm" busy={mark.isPending} onClick={() => mark.mutate("open")}>
            {t("suggest.changes.reopen")}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * The owner side's change list: accepted changes Portifact could not apply, exactly as they were
 * accepted, for a person or their agent to apply in the source. Loaded only once opened.
 */
export function ChangeList({ artifactId }: { artifactId: string }) {
  const t = useT();
  const { api } = useDashboard();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"open" | "all">("open");
  const items = useQuery({
    queryKey: [...changesQuery(artifactId), state],
    queryFn: () => api.suggestions.changes(artifactId, state === "open" ? { state: "open" } : {}),
    enabled: open,
  });
  return (
    <Disclosure summary={t("suggest.changes.heading")} onToggle={setOpen}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">{t("suggest.changes.hint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" aria-pressed={state === "open"} onClick={() => setState("open")}>
            {t("suggest.changes.showOpen")}
          </Button>
          <Button size="sm" aria-pressed={state === "all"} onClick={() => setState("all")}>
            {t("suggest.changes.showAll")}
          </Button>
        </div>
        {items.isPending ? (
          <LoadingState label={t("suggest.changes.loading")} />
        ) : items.isError ? (
          <ActionError error={items.error} />
        ) : items.data.items.length === 0 ? (
          <p className="text-sm">{t("suggest.changes.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {items.data.items.map((item) => (
              <ChangeItem key={item.id} artifactId={artifactId} item={item} />
            ))}
          </ol>
        )}
      </div>
    </Disclosure>
  );
}
