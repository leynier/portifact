// The trusted review viewer (plan section 8): the artifact runs isolated in a sandboxed iframe on
// its own origin, with the bridge; comments are written, confirmed and posted here, through the
// annotations API, by the signed-in account. Thread bodies, quotes and names are untrusted text
// and are only ever rendered as text.
import type { RefusalReason } from "@portifact/bridge";
import {
  AnnotationBody,
  type AnnotationMessageView,
  type AnnotationTarget,
  type AnnotationThreadView,
  type ReviewStart,
} from "@portifact/contracts";
import { Badge, Button, Callout, ConfirmDialog, LoadingState, PageHeader } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Crosshair,
  EyeOff,
  Info,
  LocateFixed,
  MapPinOff,
  MessageSquarePlus,
  RefreshCw,
  Reply,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { type BridgeState, useBridge } from "../review/use-bridge.ts";
import {
  applyThread,
  dropThread,
  type ThreadsState,
  threadsQuery,
  useThreads,
} from "../review/use-threads.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";

type T = ReturnType<typeof useT>;

/**
 * Sandbox of the artifact frame: it runs its own scripts on its own origin and may submit its
 * forms and open popups, but never navigates the viewer or reaches it.
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

export function ReviewScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/review/$artifactId" });
  const { api } = useDashboard();
  const [attempt, setAttempt] = useState(0);
  const start = useQuery({
    queryKey: ["review-start", artifactId, attempt],
    queryFn: () => api.startReview(artifactId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const threads = useThreads(artifactId);
  useDocumentTitle(start.data ? t("review.documentTitle", { name: start.data.name }) : undefined);

  const back = (
    <p className="mb-4 text-sm">
      <Link
        to="/artifacts/$artifactId"
        params={{ artifactId }}
        className="inline-flex items-center gap-1"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("review.back")}
      </Link>
    </p>
  );

  if (start.isPending) {
    return (
      <>
        {back}
        <LoadingState label={t("review.loading")} />
      </>
    );
  }
  if (start.isError) {
    const missing = start.error instanceof ApiFailure && start.error.code === "not_found";
    return (
      <>
        {back}
        <PageHeader
          title={missing ? t("review.unavailable.title") : t("review.startFailed.title")}
        />
        {missing ? (
          <p className="text-text-muted">{t("review.unavailable.body")}</p>
        ) : (
          <Callout
            tone="error"
            title={t("review.startFailed.title")}
            icon={<CircleAlert className="size-5" />}
            action={
              <Button icon={<RefreshCw className="size-4" />} onClick={() => start.refetch()}>
                {t("action.retry")}
              </Button>
            }
          >
            {errorMessage(t, start.error)}
          </Callout>
        )}
      </>
    );
  }

  return (
    <>
      {back}
      <ReviewSession
        key={attempt}
        start={start.data}
        threads={threads}
        onRestart={() => {
          setAttempt((n) => n + 1);
          void threads.refetch();
        }}
      />
    </>
  );
}

type ThreadsQuery = ReturnType<typeof useThreads>;

/**
 * What a new comment points at, chosen in the frame or here. Each draft has its own `id`, so its
 * composer starts fresh and keeps the target it opened with.
 */
type Draft = { id: number; target: AnnotationTarget } | null;

function ReviewSession({
  start,
  threads,
  onRestart,
}: {
  start: ReviewStart;
  threads: ThreadsQuery;
  onRestart(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const frame = useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = useState<AnnotationTarget | null>(null);
  const [draft, setDraftState] = useState<Draft>(null);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  // The page shares the bridge's window and can post what the bridge posts, so these refs, not
  // the page, decide when its selection or element may fill in a comment: an element only
  // while the reader is picking, and nothing while a comment is open.
  const drafting = useRef(false);
  const awaitingPick = useRef(false);
  const draftIds = useRef(0);
  const setDraft = (target: AnnotationTarget | null) => {
    drafting.current = target !== null;
    setDraftState(target ? { id: ++draftIds.current, target } : null);
  };
  const stopPicking = () => {
    awaitingPick.current = false;
    setPicking(false);
  };

  const numbers = new Map((threads.data?.threads ?? []).map((thread, i) => [thread.id, i + 1]));

  const bridge = useBridge(frame, start.origin, start.sessionTag, {
    onSelection(target) {
      if (drafting.current) return;
      setSelection(target);
      if (target) announce(t("review.selection.received"));
    },
    onElement(target) {
      if (!awaitingPick.current || drafting.current) return;
      stopPicking();
      setDraft(target);
    },
    onRefused(reason: RefusalReason) {
      announce(refusalMessage(t, reason));
    },
    onPickEnded() {
      stopPicking();
    },
    onStatus() {
      // The page can forge a status: the API says what really holds for comments.
      void threads.refetch();
    },
    onActivate(id) {
      setActive(id);
      const number = numbers.get(id);
      if (number !== undefined) announce(t("review.thread.activated", { number }));
      items.current.get(id)?.focus();
    },
  });

  // The frame only gets targets and short labels for the threads of the page it shows.
  const data = threads.data;
  const { send, state, page } = bridge;
  const markerKey = JSON.stringify([
    state,
    page?.path,
    active,
    data?.threads.map((thread) => [thread.id, thread.revision]),
  ]);
  // markerKey summarizes what the effect sends, so it runs only when that changes.
  useEffect(() => {
    if (state !== "connected" || !data || !page) return;
    const markers = data.threads
      .filter((thread) => thread.target.anchor.kind !== "document")
      .filter((thread) => thread.target.path === page.path)
      .slice(0, 200)
      .map((thread) => {
        const number = String(numbers.get(thread.id) ?? 0);
        return {
          id: thread.id,
          label: number,
          name: t("review.marker.name", { number }),
          target: thread.target,
        };
      });
    send({ type: "markers", markers, active });
  }, [markerKey]);

  const outdated = data !== undefined && data.currentVersionId !== start.versionId;
  const mode = data?.annotations;
  const canComment = mode === "open" && !outdated;
  const path = page?.path ?? start.entrypoint;

  // Element mode ends wherever the frame stops being a connected bridge.
  useEffect(() => {
    if (state !== "connected") stopPicking();
  }, [state]);

  const startGeneral = () => setDraft({ schema: 1, path, anchor: { kind: "document" } });
  const togglePick = () => {
    const next = !picking;
    awaitingPick.current = next;
    setPicking(next);
    send({ type: "pick", active: next, hint: t("review.pick.hint") });
    if (next) announce(t("review.pick.started"));
  };
  const closeDraft = () => {
    setDraft(null);
    setSelection(null);
    send({ type: "clear-selection" });
  };
  const show = (id: string) => {
    setActive(id);
    send({ type: "focus", id });
  };

  return (
    <>
      <PageHeader
        title={t("review.title", { name: start.name })}
        description={<span className="font-mono break-all">{start.origin}</span>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <section
          aria-labelledby="review-frame-heading"
          className="flex flex-col gap-4 lg:col-span-2"
        >
          <h2 id="review-frame-heading" className="sr-only">
            {t("review.frame.heading")}
          </h2>
          <BridgeNotice state={state} onRestart={onRestart} />
          {outdated ? (
            <Callout
              title={t("review.newVersion.title")}
              icon={<Info className="size-5" />}
              action={
                <Button icon={<RefreshCw className="size-4" />} onClick={onRestart}>
                  {t("review.newVersion.action")}
                </Button>
              }
            >
              {t("review.newVersion.body")}
            </Callout>
          ) : null}
          <iframe
            ref={frame}
            title={t("review.frame.title", { name: start.name })}
            src={start.url}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            onLoad={bridge.onFrameLoad}
            className="h-screen w-full rounded-md border border-border-strong bg-canvas"
          />
          <p className="text-sm text-text-muted">{t("review.frame.isolated")}</p>
        </section>

        <section aria-labelledby="review-comments-heading" className="flex min-w-0 flex-col gap-4">
          <h2 id="review-comments-heading" className="text-lg font-semibold">
            {t("review.comments.heading")}
          </h2>
          <p className="text-sm text-text-muted">{t("review.comments.untrusted")}</p>
          {data ? <ModeNotice artifactId={start.artifactId} state={data} /> : null}
          {canComment ? (
            <div
              role="toolbar"
              aria-label={t("review.toolbar.label")}
              className="flex flex-wrap gap-2"
            >
              <Button
                size="sm"
                icon={<MessageSquarePlus className="size-4" />}
                onClick={startGeneral}
              >
                {t("review.general")}
              </Button>
              {start.type === "site" && state === "connected" ? (
                <Button
                  size="sm"
                  icon={<Crosshair className="size-4" />}
                  aria-pressed={picking}
                  onClick={togglePick}
                >
                  {t("review.pick")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {canComment && selection && !draft ? (
            <div className="flex flex-col gap-2 rounded-md border border-border-strong p-3">
              <p className="text-sm font-medium">{t("review.selection.label")}</p>
              <TargetSummary target={selection} />
              <div>
                <Button
                  size="sm"
                  intent="primary"
                  icon={<MessageSquarePlus className="size-4" />}
                  onClick={() => setDraft(selection)}
                >
                  {t("review.selection.comment")}
                </Button>
              </div>
            </div>
          ) : null}
          {canComment && draft ? (
            <Composer
              key={draft.id}
              start={start}
              target={draft.target}
              onDone={(thread) => {
                closeDraft();
                if (thread) setActive(thread.id);
              }}
            />
          ) : null}
          <ThreadList
            start={start}
            threads={threads}
            numbers={numbers}
            active={active}
            resolutions={bridge.resolutions}
            path={path}
            located={state === "connected"}
            onShow={show}
            register={(id, element) => {
              if (element) items.current.set(id, element);
              else items.current.delete(id);
            }}
          />
        </section>
      </div>
    </>
  );
}

function refusalMessage(t: T, reason: RefusalReason): string {
  if (reason === "quote_too_long") return t("review.refused.quote_too_long");
  if (reason === "no_selector") return t("review.refused.no_selector");
  return t("review.refused.other");
}

function BridgeNotice({ state, onRestart }: { state: BridgeState; onRestart(): void }) {
  const t = useT();
  if (state === "connecting") {
    return <p className="text-sm text-text-muted">{t("review.frame.connecting")}</p>;
  }
  if (state === "unavailable" || state === "silent") {
    return (
      <Callout title={t(`review.status.${state}.title`)} icon={<Info className="size-5" />}>
        {t(`review.status.${state}.body`)}
      </Callout>
    );
  }
  if (state === "ended" || state === "failed" || state === "foreign" || state === "lost") {
    return (
      <Callout
        title={t(`review.status.${state}.title`)}
        icon={<Info className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={onRestart}>
            {t("review.reload")}
          </Button>
        }
      >
        {t(`review.status.${state}.body`)}
      </Callout>
    );
  }
  return null;
}

function ModeNotice({ artifactId, state }: { artifactId: string; state: ThreadsState }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const turnOn = useMutation({
    mutationFn: () => api.setAnnotationMode(artifactId, "open"),
    onSuccess: async () => {
      announce(t("review.mode.off.turnedOn"));
      await queryClient.invalidateQueries({ queryKey: threadsQuery(artifactId) });
    },
  });
  if (state.annotations === "open") return null;
  if (state.annotations === "locked") {
    return (
      <Callout title={t("review.mode.locked.title")} icon={<Info className="size-5" />}>
        {t("review.mode.locked.body")}
      </Callout>
    );
  }
  if (state.role !== "owner") {
    return (
      <Callout title={t("review.mode.off.visitor.title")} icon={<Info className="size-5" />}>
        {t("review.mode.off.visitor.body")}
      </Callout>
    );
  }
  return (
    <>
      {turnOn.isError ? <ActionError error={turnOn.error} /> : null}
      <Callout
        title={t("review.mode.off.owner.title")}
        icon={<Info className="size-5" />}
        action={
          <Button
            intent="primary"
            icon={<MessageSquarePlus className="size-4" />}
            busy={turnOn.isPending}
            onClick={() => turnOn.mutate()}
          >
            {t("review.mode.off.turnOn")}
          </Button>
        }
      >
        {t("review.mode.off.owner.body")}
      </Callout>
    </>
  );
}

function ActionError({ error }: { error: unknown }) {
  const t = useT();
  return (
    <Callout
      tone="error"
      title={t("review.actionFailed.title")}
      icon={<CircleAlert className="size-5" />}
    >
      {errorMessage(t, error)}
    </Callout>
  );
}

/** The validation of a comment body, with this screen's messages. */
function bodyError(t: T, value: string) {
  if (AnnotationBody.safeParse(value).success) return undefined;
  const message = value.trim() === "" ? t("review.composer.empty") : t("review.composer.invalid");
  return { fields: { body: message } };
}

function Composer({
  start,
  target: initialTarget,
  onDone,
}: {
  start: ReviewStart;
  target: AnnotationTarget;
  onDone(thread: AnnotationThreadView | null): void;
}) {
  const t = useT();
  // Frozen when the composer opens: nothing the frame sends later can retarget the comment.
  const [target] = useState(initialTarget);
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  // One key per comment, so a retried post never creates a second thread.
  const key = useRef(crypto.randomUUID());
  const post = useMutation({
    mutationFn: (body: string) =>
      api.createThread(start.artifactId, { versionId: start.versionId, target, body }, key.current),
    onSuccess: async (thread) => {
      applyThread(queryClient, start.artifactId, thread);
      announce(t("review.composer.posted"));
      onDone(thread);
      await queryClient.invalidateQueries({ queryKey: threadsQuery(start.artifactId) });
    },
  });
  const form = useAppForm({
    defaultValues: { body: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ({ value }) => bodyError(t, value.body) },
    onSubmit: ({ value }) =>
      post.mutateAsync(value.body).then(
        () => {},
        () => {},
      ),
  });
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-strong p-3">
      <TargetSummary target={target} />
      {post.isError ? <ActionError error={post.error} /> : null}
      <form.AppForm>
        <form.Form label={t("review.composer.label")}>
          <div className="flex flex-col gap-3">
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t("review.composer.body")}
                  description={t("review.composer.hint")}
                  autoFocus
                />
              )}
            </form.AppField>
            <div className="flex flex-wrap gap-2">
              <form.SubmitButton icon={<Send className="size-4" />} busy={post.isPending}>
                {t("review.composer.submit")}
              </form.SubmitButton>
              <Button onClick={() => onDone(null)}>{t("review.composer.cancel")}</Button>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}

function TargetSummary({ target }: { target: AnnotationTarget }) {
  const t = useT();
  const { anchor } = target;
  if (anchor.kind === "document") {
    return (
      <p className="text-sm text-text-muted">{t("review.target.general", { path: target.path })}</p>
    );
  }
  if (anchor.kind === "element") {
    return (
      <div className="text-sm">
        <p className="text-text-muted">{t("review.target.element", { tag: anchor.tagName })}</p>
        {anchor.fingerprint ? (
          <blockquote className="mt-1 border-l-2 border-border-strong pl-3 break-words">
            {anchor.fingerprint}
          </blockquote>
        ) : null}
      </div>
    );
  }
  return (
    <figure className="text-sm">
      <figcaption className="sr-only">{t("review.target.quote")}</figcaption>
      <blockquote className="border-l-2 border-border-strong pl-3 break-words">
        {anchor.quote.exact}
      </blockquote>
    </figure>
  );
}

interface ThreadListProps {
  start: ReviewStart;
  threads: ThreadsQuery;
  numbers: Map<string, number>;
  active: string | null;
  resolutions: ReadonlyMap<string, { confidence: string }>;
  path: string;
  located: boolean;
  onShow(id: string): void;
  register(id: string, element: HTMLElement | null): void;
}

function ThreadList({ threads, numbers, ...rest }: ThreadListProps) {
  const t = useT();
  if (threads.isPending) return <LoadingState label={t("review.comments.loading")} />;
  if (threads.isError && !threads.data) {
    return (
      <Callout
        tone="error"
        title={t("review.comments.error.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => threads.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, threads.error)}
      </Callout>
    );
  }
  const data = threads.data;
  if (!data) return null;
  return (
    <>
      {threads.isError ? (
        <p role="status" className="text-sm text-text-muted">
          {t("review.comments.refreshFailed")}
        </p>
      ) : null}
      <p className="text-sm text-text-muted">
        {data.threads.length === 0
          ? t("review.comments.empty")
          : t("review.comments.count", { count: data.threads.length })}
      </p>
      <ol className="flex flex-col gap-4">
        {data.threads.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            number={numbers.get(thread.id) ?? 0}
            state={data}
            {...rest}
          />
        ))}
      </ol>
    </>
  );
}

function ThreadItem({
  start,
  thread,
  number,
  state,
  active,
  resolutions,
  path,
  located,
  onShow,
  register,
}: Omit<ThreadListProps, "threads" | "numbers"> & {
  thread: AnnotationThreadView;
  number: number;
  state: ThreadsState;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [replying, setReplying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ref = useCallback(
    (element: HTMLElement | null) => register(thread.id, element),
    [register, thread.id],
  );

  const toggle = useMutation({
    mutationFn: () =>
      api.setThreadState(
        start.artifactId,
        thread.id,
        thread.state === "open" ? "resolved" : "open",
      ),
    onSuccess: (updated) => {
      applyThread(queryClient, start.artifactId, updated);
      announce(
        t(
          updated.state === "resolved"
            ? "review.thread.resolvedDone"
            : "review.thread.reopenedDone",
          {
            number,
          },
        ),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteThread(start.artifactId, thread.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      dropThread(queryClient, start.artifactId, thread.id);
      announce(t("review.thread.deletedDone", { number }));
    },
    onError: () => setConfirmingDelete(false),
  });

  const owner = state.role === "owner";
  const writable = state.annotations === "open" && thread.current;
  const canResolve = owner ? state.annotations !== "off" : thread.own && writable;
  const resolution = resolutions.get(thread.id);
  const kind = thread.target.anchor.kind;
  const elsewhere = kind !== "document" && thread.target.path !== path;
  const orphaned = !elsewhere && resolution?.confidence === "orphaned";
  const showable =
    located && kind !== "document" && !elsewhere && resolution !== undefined && !orphaned;
  const titleId = `thread-${thread.id}-title`;

  return (
    <li>
      <article
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-current={active === thread.id ? "true" : undefined}
        className="flex flex-col gap-3 rounded-md border border-border p-3 current-item:border-2 current-item:border-text"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={titleId} className="text-base font-semibold">
            {t("review.thread.title", { number })}
          </h3>
          {thread.state === "open" ? (
            <Badge icon={<CircleDot className="size-3.5" />}>{t("review.thread.open")}</Badge>
          ) : (
            <Badge emphasis="quiet" icon={<CircleCheck className="size-3.5" />}>
              {t("review.thread.resolved")}
            </Badge>
          )}
          {orphaned ? (
            <Badge emphasis="strong" icon={<MapPinOff className="size-3.5" />}>
              {t("review.thread.orphaned")}
            </Badge>
          ) : null}
          {elsewhere ? (
            <Badge emphasis="quiet">
              {t("review.thread.otherPage", { path: thread.target.path })}
            </Badge>
          ) : null}
        </div>
        <TargetSummary target={thread.target} />
        <ol className="flex flex-col gap-3">
          {thread.messages.map((message) => (
            <MessageItem
              key={message.id}
              artifactId={start.artifactId}
              message={message}
              owner={owner}
            />
          ))}
        </ol>
        {toggle.isError ? <ActionError error={toggle.error} /> : null}
        {remove.isError ? <ActionError error={remove.error} /> : null}
        <div className="flex flex-wrap gap-2">
          {showable ? (
            <Button
              size="sm"
              icon={<LocateFixed className="size-4" />}
              onClick={() => onShow(thread.id)}
            >
              {t("review.thread.show")}
            </Button>
          ) : null}
          {writable ? (
            <Button
              size="sm"
              icon={<Reply className="size-4" />}
              aria-expanded={replying}
              onClick={() => setReplying((open) => !open)}
            >
              {t("review.thread.reply")}
            </Button>
          ) : null}
          {canResolve ? (
            <Button
              size="sm"
              icon={
                thread.state === "open" ? (
                  <CircleCheck className="size-4" />
                ) : (
                  <RotateCcw className="size-4" />
                )
              }
              busy={toggle.isPending}
              onClick={() => toggle.mutate()}
            >
              {t(thread.state === "open" ? "review.thread.resolve" : "review.thread.reopen")}
            </Button>
          ) : null}
          {owner ? (
            <Button
              size="sm"
              icon={<Trash2 className="size-4" />}
              onClick={() => setConfirmingDelete(true)}
            >
              {t("review.thread.delete")}
            </Button>
          ) : null}
        </div>
        {replying && writable ? (
          <ReplyForm
            artifactId={start.artifactId}
            threadId={thread.id}
            number={number}
            onDone={() => setReplying(false)}
          />
        ) : null}
      </article>
      <ConfirmDialog
        open={confirmingDelete}
        title={t("review.thread.confirmDelete.title", { number })}
        confirmLabel={t("review.thread.confirmDelete.confirm")}
        cancelLabel={t("review.thread.confirmDelete.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmingDelete(false)}
      >
        {t("review.thread.confirmDelete.body")}
      </ConfirmDialog>
    </li>
  );
}

function MessageItem({
  artifactId,
  message,
  owner,
}: {
  artifactId: string;
  message: AnnotationMessageView;
  owner: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const moderate = useMutation({
    mutationFn: (action: "hide" | "unhide" | "delete") =>
      api.moderateMessage(artifactId, message.id, action),
    onSuccess: (result) => {
      if (result.thread) applyThread(queryClient, artifactId, result.thread);
      else dropThread(queryClient, artifactId, result.threadId);
      announce(t("review.message.moderated"));
    },
  });
  const author = message.own
    ? t("review.message.you")
    : (message.author?.name ?? t("review.message.formerAccount"));
  let body: ReactNode;
  if (message.state === "deleted") {
    body = <p className="text-sm text-text-muted italic">{t("review.message.deleted")}</p>;
  } else if (message.body === null) {
    body = <p className="text-sm text-text-muted italic">{t("review.message.hidden")}</p>;
  } else {
    body = <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>;
  }
  return (
    <li className="flex flex-col gap-1">
      <p className="text-sm">
        <span className="font-medium">{author}</span>{" "}
        <span className="text-text-muted">
          <time dateTime={message.createdAt}>{formatDate(message.createdAt, true)}</time>
          {message.editedAt ? ` · ${t("review.message.edited")}` : ""}
        </span>
      </p>
      {message.state === "hidden" && message.body !== null ? (
        <Badge emphasis="quiet" icon={<EyeOff className="size-3.5" />}>
          {t("review.message.hidden")}
        </Badge>
      ) : null}
      {body}
      {moderate.isError ? <ActionError error={moderate.error} /> : null}
      {owner && !message.own && message.state !== "deleted" ? (
        <div className="flex flex-wrap gap-3">
          <Button
            intent="link"
            size="inline"
            busy={moderate.isPending && moderate.variables !== "delete"}
            onClick={() => moderate.mutate(message.state === "hidden" ? "unhide" : "hide")}
          >
            {t(message.state === "hidden" ? "review.message.unhide" : "review.message.hide")}
          </Button>
          <Button
            intent="link"
            size="inline"
            busy={moderate.isPending && moderate.variables === "delete"}
            onClick={() => moderate.mutate("delete")}
          >
            {t("review.message.delete")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ReplyForm({
  artifactId,
  threadId,
  number,
  onDone,
}: {
  artifactId: string;
  threadId: string;
  number: number;
  onDone(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const key = useRef(crypto.randomUUID());
  const reply = useMutation({
    mutationFn: (body: string) => api.reply(artifactId, threadId, body, key.current),
    onSuccess: (thread) => {
      applyThread(queryClient, artifactId, thread);
      announce(t("review.reply.posted"));
      onDone();
    },
  });
  const form = useAppForm({
    defaultValues: { body: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ({ value }) => bodyError(t, value.body) },
    onSubmit: ({ value }) =>
      reply.mutateAsync(value.body).then(
        () => {},
        () => {},
      ),
  });
  return (
    <div className="flex flex-col gap-2">
      {reply.isError ? <ActionError error={reply.error} /> : null}
      <form.AppForm>
        <form.Form label={t("review.reply.label", { number })}>
          <div className="flex flex-col gap-2">
            <form.AppField name="body">
              {(field) => <field.TextAreaField label={t("review.reply.body")} rows={3} autoFocus />}
            </form.AppField>
            <div className="flex flex-wrap gap-2">
              <form.SubmitButton icon={<Send className="size-4" />} busy={reply.isPending}>
                {t("review.reply.submit")}
              </form.SubmitButton>
              <Button onClick={onDone}>{t("review.composer.cancel")}</Button>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}
