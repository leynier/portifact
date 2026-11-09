// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08). A visit to
// an artifact's page lands here: a slim bar says it is a Portifact artifact, the page runs
// isolated in a sandboxed iframe on its own origin, with the bridge when the visitor is signed
// in, and the comments sidebar sits beside it. Comments are written, confirmed and posted here,
// through the annotations API, by the signed-in account. Thread bodies, quotes and names are
// untrusted text and are only ever rendered as text. Anonymous visitors of a public artifact see
// the artifact itself in the frame and are asked to sign in to read and add comments.
import type { RefusalReason } from "@portifact/bridge";
import {
  AnnotationBody,
  type AnnotationMessageView,
  type AnnotationTarget,
  type AnnotationThreadView,
  type AnnotationVersionFilter,
  REVIEW_SESSION,
  type ReviewStart,
  type ReviewTabStart,
  type ViewerInfo,
} from "@portifact/contracts";
import { viewerHash, viewerPath } from "@portifact/domain";
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  ConfirmDialog,
  CopyField,
  Disclosure,
  LoadingState,
  PageHeader,
  Select,
  type SelectOption,
  Toast,
  ViewerShell,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import {
  AppWindow,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Crosshair,
  Download,
  ExternalLink,
  Flag,
  Info,
  LayoutGrid,
  LocateFixed,
  LogIn,
  MapPinOff,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Reply,
  RotateCcw,
  Send,
  Settings,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import symbol from "../../../../../assets/brand/symbol.svg";
import symbolDark from "../../../../../assets/brand/symbol-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { ApiFailure } from "../api.ts";
import { AnnounceContext, useAnnounce, useDashboard, useT } from "../context.tsx";
import { useHumanCheck } from "../review/human-check.tsx";
import { MessageContent, TargetSummary } from "../review/thread-parts.tsx";
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
import { ACCOUNT_QUERY } from "./shell.tsx";

type T = ReturnType<typeof useT>;

/**
 * Sandbox of the artifact frame: it runs its own scripts on its own origin and may submit its
 * forms and open popups, but never navigates the viewer or reaches it.
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** ID of the comments sidebar, which the bar's toggle controls. */
const SIDEBAR_ID = "viewer-comments";

/** The sidebar starts open where it fits beside the artifact. */
const WIDE_SCREEN = "(min-width: 64rem)";

/** The search of `/view/<id>`: the page of the artifact to open, if not its root. */
export interface ViewerSearch {
  path?: string;
}

export function parseViewerSearch(search: Record<string, unknown>): ViewerSearch {
  return typeof search.path === "string" ? { path: search.path } : {};
}

/** The page a viewer link opens, validated: anyone can write the link. */
interface Target {
  /** Path and query on the artifact origin. */
  path: string;
  /** Fragment, passed to the frame only. */
  hash: string;
}

/** The artifact page itself, on its origin: what anonymous visitors see in the frame. */
function pageUrl(origin: string, target: Target): string {
  return `${origin}${target.path}${target.hash}`;
}

/**
 * The artifact on its own origin, without the bar: `/__portifact/raw` sets a short opt-out for
 * this browser and continues to the page, through the usual sign-in for a protected artifact.
 * The bar is not a security boundary, so this is always safe to offer.
 */
function withoutBarUrl(origin: string, target: Target): string {
  const link = new URL("/__portifact/raw", origin);
  if (target.path !== "/") link.searchParams.set("to", target.path);
  return `${link.toString()}${target.hash}`;
}

/** The link to the artifact without the bar, for when the viewer cannot show it with tools. */
function WithoutBarLink({ info, target }: { info: ViewerInfo; target: Target }) {
  const t = useT();
  return (
    <p className="text-sm">
      <a href={withoutBarUrl(info.origin, target)}>{t("viewer.withoutBar")}</a>
    </p>
  );
}

/**
 * A review link (frame or tab) that starts on the target page. The artifact origin checks `to`
 * again; the fragment rides along the redirects to the page.
 */
function withTarget(url: string, target: Target): string {
  const link = new URL(url);
  if (target.path !== "/") link.searchParams.set("to", target.path);
  return `${link.toString()}${target.hash}`;
}

export function ViewerScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/view/$artifactId" });
  const search = useSearch({ from: "/view/$artifactId" });
  const location = useLocation();
  const { api, leave } = useDashboard();
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => setAnnouncement(message), []);
  // Read once: the frame keeps its own place in the artifact from then on.
  const [target] = useState<Target>(() => ({
    path: viewerPath(search.path) ?? "/",
    hash: viewerHash(location.hash ? `#${location.hash}` : ""),
  }));
  const here = `/view/${artifactId}${target.path === "/" ? "" : `?${new URLSearchParams({ path: target.path })}`}`;

  const account = useQuery({ queryKey: ACCOUNT_QUERY, queryFn: () => api.account() });
  const info = useQuery({
    queryKey: ["viewer", artifactId],
    queryFn: () => api.viewerInfo(artifactId),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const missing = info.error instanceof ApiFailure && info.error.code === "not_found";
  // A protected artifact looks missing to anonymous visitors until they sign in.
  const signInFirst = missing && account.data === null;
  useEffect(() => {
    if (signInFirst) leave(loginUrl(here));
  }, [signInFirst, here, leave]);
  useDocumentTitle(info.data?.name ?? (missing ? t("viewer.unavailable.title") : undefined));

  let content: ReactNode;
  if (info.isPending || account.isPending || signInFirst) {
    content = <Standalone>{<LoadingState label={t("viewer.loading")} />}</Standalone>;
  } else if (info.isError) {
    content = (
      <Standalone>
        <PageHeader title={missing ? t("viewer.unavailable.title") : t("viewer.failed.title")} />
        {missing ? (
          <>
            <p className="text-text-muted">{t("viewer.unavailable.body")}</p>
            <p className="mt-4">
              <a href="/">{t("viewer.dashboard")}</a>
            </p>
          </>
        ) : (
          <Callout
            tone="error"
            title={t("viewer.failed.title")}
            icon={<CircleAlert className="size-5" />}
            action={
              <Button icon={<RefreshCw className="size-4" />} onClick={() => info.refetch()}>
                {t("action.retry")}
              </Button>
            }
          >
            {errorMessage(t, info.error)}
          </Callout>
        )}
      </Standalone>
    );
  } else if (info.data.role === "anonymous" || !account.data) {
    content = <AnonymousViewer info={info.data} target={target} here={here} />;
  } else {
    content = <SignedInViewer info={info.data} target={target} />;
  }
  return (
    <AnnounceContext.Provider value={announce}>
      {content}
      <Toast message={announcement} dismissLabel={t("shell.dismiss")} />
    </AnnounceContext.Provider>
  );
}

/** A page of the viewer without the bar: loading, or an artifact that cannot be opened. */
function Standalone({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="mx-auto w-full max-w-2xl px-4 py-12">
      {children}
    </main>
  );
}

/** Whether the sidebar starts open: where the screen is wide enough to show it beside the frame. */
function startsOpen(): boolean {
  return typeof window.matchMedia === "function" ? window.matchMedia(WIDE_SCREEN).matches : true;
}

interface LayoutProps {
  info: ViewerInfo;
  target: Target;
  /** What the bar's account control is: the dashboard, or signing in. */
  account: { kind: "signed-in" } | { kind: "anonymous"; here: string };
  frame: ReactNode;
  /** The sidebar's content; null shows no sidebar and no toggle. */
  sidebar: ReactNode | null;
  sidebarOpen: boolean;
  onSidebar(open: boolean): void;
}

/** The bar, the frame and the sidebar, the same for every visitor. */
function ViewerLayout({
  info,
  target,
  account,
  frame,
  sidebar,
  sidebarOpen,
  onSidebar,
}: LayoutProps) {
  const t = useT();
  const announce = useAnnounce();
  const link = pageUrl(info.origin, target);
  return (
    <ViewerShell
      skipLinkLabel={t("viewer.skipLink")}
      brand={
        <a href="/" aria-label={t("viewer.brand")} className="no-underline">
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={symbolDark} />
            <img src={symbol} alt="" width={32} height={32} className="size-8" />
          </picture>
        </a>
      }
      caption={{
        // The artifact's own link, so its origin is always in sight next to its name.
        link: (
          <CopyField
            compact
            label={t("viewer.link")}
            value={link}
            href={link}
            copyLabel={t("viewer.copyLink")}
            copiedLabel={t("copy.copied")}
            onCopied={() => announce(t("viewer.copied"))}
            onCopyFailed={() => announce(t("copy.failed"))}
          />
        ),
        title: info.name,
        details: (
          <Badge emphasis="quiet">{t("viewer.version", { number: info.versionNumber })}</Badge>
        ),
        notice: t("viewer.userContent"),
      }}
      actions={
        <>
          {info.role === "owner" ? (
            // Full page loads: the dashboard gets its own policy, not the viewer's narrow frame-src.
            <a
              href={`/artifacts/${encodeURIComponent(info.artifactId)}`}
              className={buttonClasses({ intent: "ghost", size: "sm" })}
            >
              <Settings aria-hidden="true" className="size-4" />
              {t("viewer.manage")}
            </a>
          ) : (
            <a
              href={`/report?${new URLSearchParams({ artifact: info.artifactId })}`}
              className={buttonClasses({ intent: "ghost", size: "sm" })}
            >
              <Flag aria-hidden="true" className="size-4" />
              {t("review.report")}
            </a>
          )}
          {sidebar !== null ? (
            <Button
              size="sm"
              icon={<MessageSquare className="size-4" />}
              aria-expanded={sidebarOpen}
              aria-controls={SIDEBAR_ID}
              onClick={() => onSidebar(!sidebarOpen)}
            >
              {t("viewer.comments")}
            </Button>
          ) : null}
          {account.kind === "signed-in" ? (
            <a href="/" className={buttonClasses({ intent: "ghost", size: "sm" })}>
              <LayoutGrid aria-hidden="true" className="size-4" />
              {t("viewer.dashboard")}
            </a>
          ) : (
            <a
              href={loginUrl(account.here)}
              className={buttonClasses({ intent: "primary", size: "sm" })}
            >
              <LogIn aria-hidden="true" className="size-4" />
              {t("viewer.signIn")}
            </a>
          )}
        </>
      }
      frameLabel={t("viewer.frame.label")}
      frame={frame}
      sidebar={
        sidebar !== null && sidebarOpen
          ? { id: SIDEBAR_ID, label: t("review.comments.heading"), content: sidebar }
          : undefined
      }
    />
  );
}

function ArtifactFrame({
  info,
  src,
  frame,
  onLoad,
}: {
  info: ViewerInfo;
  src: string;
  frame?: React.RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
}) {
  const t = useT();
  return (
    <iframe
      ref={frame}
      title={t("viewer.frame.title", { name: info.name })}
      src={src}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className="min-h-0 w-full flex-1 border-0 bg-canvas"
    />
  );
}

/**
 * An anonymous visitor of a public artifact: the artifact itself in the frame, without the
 * bridge (no session names them), and a sidebar that asks them to sign in, which comes back here.
 * Threads are for signed-in readers only (plan section 8, "Permisos").
 */
function AnonymousViewer({
  info,
  target,
  here,
}: {
  info: ViewerInfo;
  target: Target;
  here: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(startsOpen);
  const sidebar =
    info.annotations === "off" ? null : (
      <>
        <h2 className="text-lg font-semibold">{t("review.comments.heading")}</h2>
        <p className="text-sm">{t("viewer.anonymous.body")}</p>
        <div>
          <a href={loginUrl(here)} className={buttonClasses({ intent: "primary", size: "sm" })}>
            <LogIn aria-hidden="true" className="size-4" />
            {t("viewer.anonymous.signIn")}
          </a>
        </div>
      </>
    );
  return (
    <ViewerLayout
      info={info}
      target={target}
      account={{ kind: "anonymous", here }}
      frame={<ArtifactFrame info={info} src={pageUrl(info.origin, target)} />}
      sidebar={sidebar}
      sidebarOpen={open}
      onSidebar={setOpen}
    />
  );
}

/** A signed-in visitor: a review session in the frame, with the bridge, and the comments. */
function SignedInViewer({ info, target }: { info: ViewerInfo; target: Target }) {
  const t = useT();
  const { api } = useDashboard();
  const [attempt, setAttempt] = useState(0);
  // Which version's threads the panel lists; only the owner can pick another one.
  const [version, setVersion] = useState<AnnotationVersionFilter>("current");
  const start = useQuery({
    queryKey: ["review-start", info.artifactId, attempt],
    queryFn: () => api.startReview(info.artifactId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // Readers have no threads while comments are off; the owner keeps the switch to turn them on.
  const comments = info.annotations !== "off" || info.role === "owner";
  const threads = useThreads(info.artifactId, version, comments);

  if (start.isPending) {
    return (
      <ViewerLayout
        info={info}
        target={target}
        account={{ kind: "signed-in" }}
        frame={<LoadingState label={t("viewer.loading")} />}
        sidebar={null}
        sidebarOpen={false}
        onSidebar={() => {}}
      />
    );
  }
  if (start.isError) {
    // Without a review session a public artifact is still shown as it is, without review tools;
    // a protected one cannot be, so only the notice remains.
    return (
      <ViewerLayout
        info={info}
        target={target}
        account={{ kind: "signed-in" }}
        frame={
          <>
            <div className="p-3">
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
              <WithoutBarLink info={info} target={target} />
            </div>
            {info.accessMode === "public" ? (
              <ArtifactFrame info={info} src={pageUrl(info.origin, target)} />
            ) : null}
          </>
        }
        sidebar={null}
        sidebarOpen={false}
        onSidebar={() => {}}
      />
    );
  }
  return (
    <ReviewSession
      key={attempt}
      info={info}
      target={target}
      start={start.data}
      comments={comments}
      threads={threads}
      version={version}
      onVersion={setVersion}
      onRestart={() => {
        setAttempt((n) => n + 1);
        void threads.refetch();
      }}
    />
  );
}

type ThreadsQuery = ReturnType<typeof useThreads>;

/**
 * What a new comment points at, chosen in the frame or here. Each draft has its own `id`, so its
 * composer starts fresh and keeps the target it opened with.
 */
type Draft = { id: number; target: AnnotationTarget } | null;

/** Which threads the panel shows, besides the version: by status and by author. */
interface ThreadFilter {
  status: "all" | "open" | "resolved";
  /** `all`, `own`, `former` (accounts that are gone) or an author's ID. */
  author: string;
}

const ALL_THREADS: ThreadFilter = { status: "all", author: "all" };

function authorKey(thread: AnnotationThreadView): string {
  if (thread.own) return "own";
  return thread.author ? `id:${thread.author.id}` : "former";
}

function matchesFilter(thread: AnnotationThreadView, filter: ThreadFilter): boolean {
  if (filter.status !== "all" && thread.state !== filter.status) return false;
  return filter.author === "all" || authorKey(thread) === filter.author;
}

function ReviewSession({
  info,
  target,
  start,
  comments,
  threads,
  version,
  onVersion,
  onRestart,
}: {
  info: ViewerInfo;
  target: Target;
  start: ReviewStart;
  comments: boolean;
  threads: ThreadsQuery;
  version: AnnotationVersionFilter;
  onVersion(version: AnnotationVersionFilter): void;
  onRestart(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const frame = useRef<HTMLIFrameElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(startsOpen);
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
  const setDraft = (next: AnnotationTarget | null) => {
    drafting.current = next !== null;
    setDraftState(next ? { id: ++draftIds.current, target: next } : null);
  };
  const stopPicking = () => {
    awaitingPick.current = false;
    setPicking(false);
  };

  const [filterState, setFilter] = useState<ThreadFilter>(ALL_THREADS);
  // Numbers follow creation over every thread of the version, so filtering never renumbers.
  const numbers = new Map((threads.data?.threads ?? []).map((thread, i) => [thread.id, i + 1]));
  const authors = authorOptions(t, threads.data?.threads ?? []);
  // An author who has no thread in the chosen version any more stops filtering.
  const filter = authors.some((option) => option.value === filterState.author)
    ? filterState
    : { ...filterState, author: "all" };
  const shown = (threads.data?.threads ?? []).filter((thread) => matchesFilter(thread, filter));

  const data = threads.data;
  const outdated = data !== undefined && data.currentVersionId !== start.versionId;
  const mode = data?.annotations;
  const canComment = mode === "open" && !outdated;

  const bridge = useBridge(frame, start.origin, start.sessionTag, {
    onSelection(selected) {
      if (drafting.current) return;
      setSelection(selected);
      if (selected && canComment) {
        // The offer to comment lives in the sidebar, so it opens; focus stays in the artifact.
        setSidebarOpen(true);
        announce(t("review.selection.received"));
      }
    },
    onElement(picked) {
      if (!awaitingPick.current || drafting.current) return;
      stopPicking();
      setSidebarOpen(true);
      setDraft(picked);
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
      setSidebarOpen(true);
      const number = numbers.get(id);
      if (number !== undefined) announce(t("review.thread.activated", { number }));
      // After the sidebar renders, so the thread exists to take focus.
      setTimeout(() => items.current.get(id)?.focus(), 0);
    },
  });

  // The frame only gets targets and short labels for the threads of the page it shows.
  const { send, state, page } = bridge;
  const markerKey = JSON.stringify([
    state,
    page?.path,
    active,
    shown.map((thread) => [thread.id, thread.revision, thread.current]),
  ]);
  // markerKey summarizes what the effect sends, so it runs only when that changes.
  useEffect(() => {
    if (state !== "connected" || !data || !page) return;
    // Only the version in the frame has places in it, and only threads the filters show.
    const markers = shown
      .filter((thread) => thread.current)
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

  // Where the browser keeps no session in the frame, a public artifact is still shown as it is,
  // without review tools; a protected one cannot be, so the frame keeps the notice.
  const plain = state === "unavailable" && info.accessMode === "public";
  const src = plain ? pageUrl(info.origin, target) : withTarget(start.url, target);

  const frameArea = (
    <>
      <div className="flex flex-col gap-3 p-3 empty:hidden">
        <BridgeNotice state={state} info={info} target={target} onRestart={onRestart} />
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
      </div>
      <ArtifactFrame info={info} src={src} frame={frame} onLoad={bridge.onFrameLoad} />
    </>
  );

  const sidebar = !comments ? null : (
    <>
      <h2 className="text-lg font-semibold">{t("review.comments.heading")}</h2>
      <p className="text-sm text-text-muted">{t("review.comments.untrusted")}</p>
      {data ? <ModeNotice artifactId={start.artifactId} state={data} /> : null}
      {canComment ? (
        <div role="toolbar" aria-label={t("review.toolbar.label")} className="flex flex-wrap gap-2">
          <Button size="sm" icon={<MessageSquarePlus className="size-4" />} onClick={startGeneral}>
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
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-canvas p-4 shadow-sm">
          <p className="text-sm font-medium">
            <span className="selection-band px-1.5">{t("review.selection.label")}</span>
          </p>
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
        shown={shown}
        filtered={filter.status !== "all" || filter.author !== "all"}
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
      {data ? (
        <CommentTools
          start={start}
          role={data.role}
          version={version}
          onVersion={onVersion}
          filter={filter}
          onFilter={setFilter}
          authors={authors}
        />
      ) : null}
    </>
  );

  return (
    <ViewerLayout
      info={info}
      target={target}
      account={{ kind: "signed-in" }}
      frame={frameArea}
      sidebar={sidebar}
      sidebarOpen={sidebarOpen}
      onSidebar={setSidebarOpen}
    />
  );
}

function refusalMessage(t: T, reason: RefusalReason): string {
  if (reason === "quote_too_long") return t("review.refused.quote_too_long");
  if (reason === "no_selector") return t("review.refused.no_selector");
  return t("review.refused.other");
}

function BridgeNotice({
  state,
  info,
  target,
  onRestart,
}: {
  state: BridgeState;
  info: ViewerInfo;
  target: Target;
  onRestart(): void;
}) {
  const artifactId = info.artifactId;
  const t = useT();
  if (state === "connecting") {
    return <p className="text-sm text-text-muted">{t("review.frame.connecting")}</p>;
  }
  if (state === "unavailable" || state === "silent") {
    return (
      <>
        <Callout title={t(`review.status.${state}.title`)} icon={<Info className="size-5" />}>
          {t(`review.status.${state}.body`)}
        </Callout>
        <WithoutBarLink info={info} target={target} />
        <ReviewTabOffer artifactId={artifactId} target={target} />
      </>
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

/** A prepared link is withdrawn 10 seconds before its one-use code expires. */
export const REVIEW_TAB_LINK_MS = (REVIEW_SESSION.handoffTtlSeconds - 10) * 1000;

/**
 * The fallback where the frame cannot run review mode: a link that opens the artifact in a
 * top-level review tab with a short session. The link carries a one-use code, so it is prepared
 * on request and withdrawn before the code expires. It opens without an opener (the artifact
 * cannot reach or navigate this page) and sends only the app's origin as `Referer`, which the
 * artifact origin requires before it redeems a tab code. The tab has no review tools: comments
 * are still written and posted here.
 */
function ReviewTabOffer({ artifactId, target }: { artifactId: string; target: Target }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const [link, setLink] = useState<ReviewTabStart | null>(null);
  const [note, setNote] = useState<"opened" | "expired" | null>(null);
  const anchor = useRef<HTMLAnchorElement>(null);
  const prepare = useMutation({
    mutationFn: () => api.startReviewTab(artifactId),
    onSuccess: (start) => {
      setNote(null);
      setLink(start);
      announce(t("review.tab.ready"));
    },
  });
  useEffect(() => {
    if (!link) return;
    anchor.current?.focus();
    const timer = setTimeout(() => {
      setLink(null);
      setNote("expired");
    }, REVIEW_TAB_LINK_MS);
    return () => clearTimeout(timer);
  }, [link]);
  const opened = () => {
    // After the click's default action: the code is used once, so the link goes away.
    setTimeout(() => {
      setLink(null);
      setNote("opened");
    }, 0);
  };
  return (
    <section
      aria-labelledby="review-tab-heading"
      className="flex flex-col gap-3 rounded-md border border-border-strong p-3"
    >
      <h2 id="review-tab-heading" className="text-base font-semibold">
        {t("review.tab.title")}
      </h2>
      <p className="text-sm">
        {t("review.tab.body", { minutes: REVIEW_SESSION.tabSessionTtlSeconds / 60 })}
      </p>
      {prepare.isError ? <ActionError error={prepare.error} /> : null}
      {note ? (
        <p role="status" className="text-sm text-text-muted">
          {t(note === "opened" ? "review.tab.opened" : "review.tab.expired")}
        </p>
      ) : null}
      <div>
        {link ? (
          <a
            ref={anchor}
            href={withTarget(link.url, target)}
            target="_blank"
            rel="noopener"
            referrerPolicy="origin"
            className={buttonClasses({ intent: "primary", size: "sm" })}
            onClick={opened}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {t("review.tab.open")}
          </a>
        ) : (
          <Button
            size="sm"
            icon={<AppWindow className="size-4" />}
            busy={prepare.isPending}
            onClick={() => prepare.mutate()}
          >
            {t("review.tab.prepare")}
          </Button>
        )}
      </div>
    </section>
  );
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
  // One key per comment, so a retried post never creates a second thread; a post refused for
  // the human check gets a new one with the solved token.
  const human = useHumanCheck();
  const post = useMutation({
    mutationFn: (body: string) =>
      api.createThread(
        start.artifactId,
        {
          versionId: start.versionId,
          target,
          body,
          ...(human.token === undefined ? {} : { turnstileToken: human.token }),
        },
        human.key,
      ),
    onError: (error) => {
      human.failed(error);
    },
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
      human.ready()
        ? post.mutateAsync(value.body).then(
            () => {},
            () => {},
          )
        : undefined,
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
            {human.field}
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

/** "Everyone", then you, each other author once and accounts that are gone, from the threads. */
function authorOptions(t: T, threads: AnnotationThreadView[]): SelectOption[] {
  const options: SelectOption[] = [{ value: "all", label: t("review.filter.author.all") }];
  if (threads.some((thread) => thread.own)) {
    options.push({ value: "own", label: t("review.filter.author.own") });
  }
  const named = new Map<string, string>();
  for (const thread of threads) {
    if (!thread.own && thread.author) named.set(`id:${thread.author.id}`, thread.author.name);
  }
  options.push(
    ...[...named]
      .sort(([, a], [, b]) => a.localeCompare(b))
      .map(([value, label]) => ({ value, label })),
  );
  if (threads.some((thread) => !thread.own && !thread.author)) {
    options.push({ value: "former", label: t("review.filter.author.former") });
  }
  return options;
}

/**
 * Filters for the comments panel and the export. Status and author narrow the threads already
 * loaded; the version (owner only) loads another version's threads, or all of them. The export
 * is the file `portifact annotations export` writes, for the chosen version and status.
 */
function CommentTools({
  start,
  role,
  version,
  onVersion,
  filter,
  onFilter,
  authors,
}: {
  start: ReviewStart;
  role: ThreadsState["role"];
  version: AnnotationVersionFilter;
  onVersion(version: AnnotationVersionFilter): void;
  filter: ThreadFilter;
  onFilter(filter: ThreadFilter): void;
  authors: SelectOption[];
}) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const owner = role === "owner";
  const versions = useQuery({
    queryKey: ["review-versions", start.artifactId],
    queryFn: () => api.listVersions(start.artifactId),
    enabled: owner,
    staleTime: 60_000,
  });
  const exporter = useMutation({
    mutationFn: (format: "json" | "markdown") =>
      api.exportAnnotations(start.artifactId, {
        format,
        version,
        ...(filter.status === "all" ? {} : { state: filter.status }),
      }),
    onSuccess: (file, format) => {
      save(file);
      announce(t(format === "json" ? "review.export.doneJson" : "review.export.doneMarkdown"));
    },
  });
  const versionOptions: SelectOption[] = [
    { value: "current", label: t("review.filter.version.current") },
    { value: "all", label: t("review.filter.version.all") },
    ...(versions.data?.items ?? [])
      .filter((item) => !item.current)
      .map((item) => ({
        value: item.id,
        label: t("review.filter.version.number", { number: item.number }),
      })),
  ];
  return (
    // Collapsed by default: reading and writing comments come first in the sidebar.
    <Disclosure
      summary={
        filter.status === "all" && filter.author === "all" && version === "current"
          ? t("review.filter.heading")
          : t("review.filter.headingActive")
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label={t("review.filter.status")}
          value={filter.status}
          options={[
            { value: "all", label: t("review.filter.status.all") },
            { value: "open", label: t("review.filter.status.open") },
            { value: "resolved", label: t("review.filter.status.resolved") },
          ]}
          onChange={(status) => onFilter({ ...filter, status })}
        />
        <Select
          label={t("review.filter.author")}
          value={filter.author}
          options={authors}
          onChange={(author) => onFilter({ ...filter, author })}
        />
        {owner ? (
          <Select
            label={t("review.filter.version")}
            description={t("review.filter.version.hint")}
            value={version}
            options={versionOptions}
            onChange={onVersion}
          />
        ) : null}
        <p className="text-sm text-text-muted">{t("review.export.hint")}</p>
        {exporter.isError ? <ActionError error={exporter.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Download className="size-4" />}
            busy={exporter.isPending && exporter.variables === "json"}
            onClick={() => exporter.mutate("json")}
          >
            {t("review.export.json")}
          </Button>
          <Button
            size="sm"
            icon={<Download className="size-4" />}
            busy={exporter.isPending && exporter.variables === "markdown"}
            onClick={() => exporter.mutate("markdown")}
          >
            {t("review.export.markdown")}
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}

interface ThreadListProps {
  start: ReviewStart;
  threads: ThreadsQuery;
  /** The threads the filters let through, in creation order. */
  shown: AnnotationThreadView[];
  filtered: boolean;
  numbers: Map<string, number>;
  active: string | null;
  resolutions: ReadonlyMap<string, { confidence: string }>;
  path: string;
  located: boolean;
  onShow(id: string): void;
  register(id: string, element: HTMLElement | null): void;
}

function ThreadList({ threads, shown, filtered, numbers, ...rest }: ThreadListProps) {
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
      <p role="status" className="text-sm text-text-muted">
        {countMessage(t, {
          loading: threads.isPlaceholderData,
          total: data.threads.length,
          shown: shown.length,
          filtered,
        })}
      </p>
      <ol className="flex flex-col gap-4">
        {(threads.isPlaceholderData ? [] : shown).map((thread) => (
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

function countMessage(
  t: T,
  state: { loading: boolean; total: number; shown: number; filtered: boolean },
): string {
  if (state.loading) return t("review.comments.loading");
  if (state.total === 0) return t("review.comments.empty");
  if (!state.filtered) return t("review.comments.count", { count: state.total });
  if (state.shown === 0) return t("review.comments.noMatch");
  return t("review.comments.filteredCount", { shown: state.shown, count: state.total });
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
}: Omit<ThreadListProps, "threads" | "numbers" | "shown" | "filtered"> & {
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
    located &&
    thread.current &&
    kind !== "document" &&
    !elsewhere &&
    resolution !== undefined &&
    !orphaned;
  const titleId = `thread-${thread.id}-title`;

  return (
    <li>
      <article
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-current={active === thread.id ? "true" : undefined}
        className="flex flex-col gap-3 rounded-lg border border-border bg-canvas p-4 shadow-sm current-item:border-text current-item:shadow-raised"
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
          {thread.current ? null : (
            <Badge emphasis="quiet">{t("review.thread.otherVersion")}</Badge>
          )}
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
  return (
    <li className="flex flex-col gap-1">
      <MessageContent message={message} />
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
  const human = useHumanCheck();
  const reply = useMutation({
    mutationFn: (body: string) => api.reply(artifactId, threadId, body, human.key, human.token),
    onError: (error) => {
      human.failed(error);
    },
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
      human.ready()
        ? reply.mutateAsync(value.body).then(
            () => {},
            () => {},
          )
        : undefined,
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
            {human.field}
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
