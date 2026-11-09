// A comment thread in the viewer's sidebar: a header with its number, what it points at and its
// state, compact actions (show in the artifact, resolve or reopen, and a menu for the rest), its
// messages with their own menus, and a reply box that opens in place. Quotes, names and bodies
// are untrusted text and are only rendered as text.
import {
  AnnotationBody,
  type AnnotationMessageView,
  type AnnotationThreadView,
  HUMAN_VERIFICATION_REQUIRED,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  IconButton,
  Menu,
  type MenuItem,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eye,
  EyeOff,
  Info,
  LocateFixed,
  MapPinOff,
  Pencil,
  Reply,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { errorMessage } from "../screens/artifact-list.tsx";
import { useHumanCheck } from "./human-check.tsx";
import { MessageContent, TargetSummary } from "./thread-parts.tsx";
import { applyThread, dropThread, type ThreadsState, threadsQuery } from "./use-threads.ts";

type T = ReturnType<typeof useT>;

export function ActionError({ error }: { error: unknown }) {
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
export function bodyError(t: T, value: string) {
  if (AnnotationBody.safeParse(value).success) return undefined;
  const message = value.trim() === "" ? t("review.composer.empty") : t("review.composer.invalid");
  return { fields: { body: message } };
}

/** Whether an error is the API's refusal for the human check, which the check itself explains. */
export const humanRefusal = (error: unknown) =>
  error instanceof ApiFailure && error.code === HUMAN_VERIFICATION_REQUIRED;

/** How a thread is selected: the first selected thread, another selected one, or not at all. */
export type Selection = "primary" | "selected" | null;

export interface ThreadCardProps {
  artifactId: string;
  thread: AnnotationThreadView;
  number: number;
  state: ThreadsState;
  selection: Selection;
  /** Where the page placed the thread's target, when the frame reported it. */
  resolution: { confidence: string } | undefined;
  /** The file the frame shows. */
  path: string;
  /** Whether the frame runs the bridge, so it can show places. */
  located: boolean;
  /** Selects the thread and, when it has a place on the page, shows it there. */
  onSelect(id: string, show: boolean): void;
  /** The reader points at the thread (or stops, with null): its text is outlined in the page. */
  onHover(id: string | null): void;
  register(id: string, element: HTMLElement | null): void;
}

/** Controls inside a card that keep their own clicks: the card only selects on the rest. */
const OWN_CLICKS = "a, button, input, textarea, select, summary, label, form, [role='menu']";

export function ThreadCard({
  artifactId,
  thread,
  number,
  state,
  selection,
  resolution,
  path,
  located,
  onSelect,
  onHover,
  register,
}: ThreadCardProps) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [replying, setReplying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const ref = useCallback(
    (element: HTMLElement | null) => register(thread.id, element),
    [register, thread.id],
  );

  const toggle = useMutation({
    mutationFn: () =>
      api.setThreadState(artifactId, thread.id, thread.state === "open" ? "resolved" : "open"),
    onSuccess: (updated) => {
      applyThread(queryClient, artifactId, updated);
      announce(
        t(
          updated.state === "resolved"
            ? "review.thread.resolvedDone"
            : "review.thread.reopenedDone",
          { number },
        ),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteThread(artifactId, thread.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      dropThread(queryClient, artifactId, thread.id);
      announce(t("review.thread.deletedDone", { number }));
    },
    onError: () => setConfirmingDelete(false),
  });

  const owner = state.role === "owner";
  const writable = state.annotations === "open" && thread.current;
  const canResolve = owner ? state.annotations !== "off" : thread.own && writable;
  const kind = thread.target.anchor.kind;
  const elsewhere = kind !== "document" && thread.target.path !== path;
  const orphaned = !elsewhere && resolution?.confidence === "orphaned";
  const showable =
    located &&
    thread.current &&
    kind !== "document" &&
    !elsewhere &&
    resolution !== undefined &&
    !orphaned;
  const titleId = `thread-${thread.id}-title`;
  const resolved = thread.state === "resolved";
  // Resolved threads rest folded; selecting one, or asking, opens it.
  const folded = resolved && selection === null && !expanded;

  const threadActions: MenuItem[] = owner
    ? [
        {
          id: "delete",
          label: t("review.thread.delete"),
          icon: <Trash2 className="size-4" />,
          onSelect: () => setConfirmingDelete(true),
        },
      ]
    : [];

  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element) || event.target.closest(OWN_CLICKS)) return;
    // Selecting text in a card to copy it is not a click on the card.
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    onSelect(thread.id, showable);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHover(null);
  };
  const stopReplying = () => {
    setReplying(false);
    setTimeout(() => replyButton.current?.focus(), 0);
  };

  return (
    <li>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicking the card is a pointer shortcut; "Show in the artifact" is the keyboard path. */}
      <article
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-current={selection === "primary" ? "true" : undefined}
        data-selected={selection === "selected" ? "" : undefined}
        onClick={onCardClick}
        onPointerEnter={() => onHover(thread.id)}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(thread.id)}
        onBlur={onBlur}
        className={`group/thread flex flex-col rounded-lg border shadow-sm transition-colors duration-150 current-item:border-text current-item:shadow-raised data-selected:border-text ${
          resolved ? "border-dashed border-border-strong bg-surface" : "border-border bg-canvas"
        }`}
      >
        <div className="flex items-start gap-2.5 px-3 pt-3">
          <h3
            id={titleId}
            className={`inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-xs border border-border-strong px-1.5 text-xs font-semibold tabular-nums ${
              selection === "primary" ? "selection-band border-transparent" : ""
            }`}
          >
            <span className="sr-only">{t("review.thread.titlePrefix")}</span>
            {number}
          </h3>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <TargetSummary target={thread.target} compact={selection === null} />
            <div className="flex flex-wrap items-center gap-1.5">
              {resolved ? (
                <Badge emphasis="quiet" icon={<CircleCheck className="size-3.5" />}>
                  {t("review.thread.resolved")}
                </Badge>
              ) : (
                <Badge icon={<CircleDot className="size-3.5" />}>{t("review.thread.open")}</Badge>
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
              {thread.current ? null : (
                <Badge emphasis="quiet">{t("review.thread.otherVersion")}</Badge>
              )}
            </div>
          </div>
          <div className="-mt-0.5 -mr-1 flex shrink-0 items-center">
            {showable ? (
              <IconButton
                size="xs"
                align="end"
                label={t("review.thread.show")}
                icon={<LocateFixed className="size-4" />}
                onClick={() => onSelect(thread.id, true)}
              />
            ) : null}
            {canResolve ? (
              <IconButton
                size="xs"
                align="end"
                label={t(resolved ? "review.thread.reopen" : "review.thread.resolve")}
                icon={
                  resolved ? <RotateCcw className="size-4" /> : <CircleCheck className="size-4" />
                }
                busy={toggle.isPending}
                onClick={() => toggle.mutate()}
              />
            ) : null}
            {threadActions.length > 0 ? (
              <Menu label={t("review.thread.more", { number })} items={threadActions} />
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-3 px-3 pt-3 pb-3">
          {toggle.isError ? <ActionError error={toggle.error} /> : null}
          {remove.isError ? <ActionError error={remove.error} /> : null}
          {resolved && selection === null ? (
            <div>
              <Button
                intent="link"
                size="inline"
                icon={
                  <ChevronDown
                    className={`size-4 motion-safe:transition-transform ${folded ? "" : "rotate-180"}`}
                  />
                }
                aria-expanded={!folded}
                onClick={() => setExpanded((open) => !open)}
              >
                {folded
                  ? t("review.thread.showMessages", { count: thread.messages.length })
                  : t("review.thread.hideMessages")}
              </Button>
            </div>
          ) : null}
          {folded ? null : (
            <ol className="flex flex-col gap-3 border-t border-border pt-3">
              {thread.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  artifactId={artifactId}
                  message={message}
                  owner={owner}
                  writable={writable}
                />
              ))}
            </ol>
          )}
          {writable && !folded ? (
            replying ? (
              <ReplyForm
                artifactId={artifactId}
                threadId={thread.id}
                byOwner={thread.byOwner}
                number={number}
                humanNeeded={state.humanCheck}
                onDone={stopReplying}
              />
            ) : (
              <Button
                ref={replyButton}
                intent="field"
                size="sm"
                icon={<Reply className="size-4" />}
                aria-expanded={false}
                onClick={() => setReplying(true)}
              >
                {t("review.thread.reply")}
              </Button>
            )
          ) : null}
        </div>
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
  writable,
}: {
  artifactId: string;
  message: AnnotationMessageView;
  owner: boolean;
  /** Whether the thread takes changes: comments open and the thread on the current version. */
  writable: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const editable = writable && message.own && message.state === "visible";
  const moderatable = owner && !message.own && message.state !== "deleted";
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
  const stopEditing = () => {
    setEditing(false);
    // Back to the menu that opened the form, after it renders again.
    setTimeout(() => menuButton.current?.focus(), 0);
  };
  if (editing && editable) {
    return (
      <li>
        <EditForm artifactId={artifactId} message={message} onDone={stopEditing} />
      </li>
    );
  }
  const author = message.own
    ? t("review.message.you")
    : (message.author?.name ?? t("review.message.formerAccount"));
  const items: MenuItem[] = [];
  if (editable) {
    items.push({
      id: "edit",
      label: t("review.message.edit"),
      icon: <Pencil className="size-4" />,
      onSelect: () => setEditing(true),
    });
  }
  if (moderatable) {
    const hidden = message.state === "hidden";
    items.push(
      {
        id: "hide",
        label: t(hidden ? "review.message.unhide" : "review.message.hide"),
        icon: hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
        onSelect: () => moderate.mutate(hidden ? "unhide" : "hide"),
      },
      {
        id: "delete",
        label: t("review.message.delete"),
        icon: <Trash2 className="size-4" />,
        onSelect: () => moderate.mutate("delete"),
      },
    );
  }
  return (
    <li className="group/message flex flex-col gap-2">
      <MessageContent
        message={message}
        actions={
          items.length > 0 ? (
            // Shown on hover and focus where there is a pointer, always on touch screens.
            <span
              className={`flex shrink-0 opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 ${
                moderate.isPending ? "opacity-100" : ""
              }`}
            >
              <Menu
                label={t("review.message.more", { author })}
                items={items}
                buttonRef={menuButton}
              />
            </span>
          ) : null
        }
      />
      {moderate.isError ? <ActionError error={moderate.error} /> : null}
    </li>
  );
}

/** Enter keeps adding lines in a reply; Escape cancels it from the text area. */
function cancelOnEscape(onEscape: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onEscape();
  };
}

function ReplyForm({
  artifactId,
  threadId,
  byOwner,
  number,
  humanNeeded,
  onDone,
}: {
  artifactId: string;
  threadId: string;
  /** The owner started the thread, so every reader who sees comments sees the reply. */
  byOwner: boolean;
  number: number;
  humanNeeded: boolean;
  onDone(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const human = useHumanCheck(humanNeeded);
  const reply = useMutation({
    mutationFn: (body: string) =>
      human.post((key, token) => api.reply(artifactId, threadId, body, key, token)),
    onSuccess: (thread) => {
      if (!thread) return;
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
      {reply.isError && !humanRefusal(reply.error) ? <ActionError error={reply.error} /> : null}
      <form.AppForm>
        <form.Form label={t("review.reply.label", { number })}>
          <div className="flex flex-col gap-2">
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t("review.reply.body")}
                  description={byOwner ? t("review.reply.hint.owner") : undefined}
                  rows={3}
                  compact
                  autoFocus
                  onKeyDown={cancelOnEscape(onDone)}
                />
              )}
            </form.AppField>
            {human.field}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={onDone}>
                {t("review.composer.cancel")}
              </Button>
              <form.SubmitButton
                size="sm"
                icon={<Send className="size-4" />}
                busy={reply.isPending}
              >
                {t("review.reply.submit")}
              </form.SubmitButton>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}

/**
 * Editing one of your own messages in place. The edit names the revision it started from, so an
 * edit made elsewhere meanwhile is a conflict, never overwritten: the latest text is loaded and
 * the reader saves again.
 */
function EditForm({
  artifactId,
  message,
  onDone,
}: {
  artifactId: string;
  message: AnnotationMessageView;
  onDone(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  // The revision the reader is editing; it moves only when they see the newer text.
  const revision = useRef(message.revision);
  const edit = useMutation({
    mutationFn: (body: string) =>
      api.editMessage(artifactId, message.id, { body, revision: revision.current }),
    onSuccess: (result) => {
      if ("thread" in result && result.thread === null) {
        // Saved in a thread the reader no longer sees: the owner narrowed who sees comments.
        dropThread(queryClient, artifactId, result.threadId);
        announce(t("review.message.edited.hidden"));
      } else {
        applyThread(queryClient, artifactId, result as AnnotationThreadView);
        announce(t("review.message.edited.done"));
      }
      onDone();
    },
    onError: async (error) => {
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: threadsQuery(artifactId) });
      }
    },
  });
  const conflict = edit.error instanceof ApiFailure && edit.error.code === "version_conflict";
  useEffect(() => {
    // After a conflict, the next save starts from the text the reader now sees.
    if (conflict) revision.current = message.revision;
  }, [conflict, message.revision]);
  const form = useAppForm({
    defaultValues: { body: message.body ?? "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ({ value }) => bodyError(t, value.body) },
    onSubmit: ({ value }) =>
      edit.mutateAsync(value.body).then(
        () => {},
        () => {},
      ),
  });
  return (
    <div className="flex flex-col gap-2">
      {conflict ? (
        <Callout title={t("review.actionFailed.title")} icon={<Info className="size-5" />}>
          {t("review.message.editConflict")}
        </Callout>
      ) : edit.isError ? (
        <ActionError error={edit.error} />
      ) : null}
      <form.AppForm>
        <form.Form label={t("review.message.editLabel")}>
          <div className="flex flex-col gap-2">
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t("review.message.editBody")}
                  rows={3}
                  compact
                  autoFocus
                  onKeyDown={cancelOnEscape(onDone)}
                />
              )}
            </form.AppField>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={onDone}>
                {t("review.composer.cancel")}
              </Button>
              <form.SubmitButton size="sm" busy={edit.isPending}>
                {t("review.message.editSave")}
              </form.SubmitButton>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}
