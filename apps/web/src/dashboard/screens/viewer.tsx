// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08). A visit to
// an artifact's page lands here: a slim bar says it is a Portifact artifact, the page runs
// isolated in a sandboxed iframe on its own origin, with the bridge when the visitor is signed
// in, and the comments sidebar sits beside it. Comments are written, confirmed and posted here,
// through the annotations API, by the signed-in account: in a composer the viewer draws over the
// frame next to the reader's selection, or in the sidebar. Thread bodies, quotes and names are
// untrusted text and are only ever rendered as text. Anonymous visitors of a public artifact see
// the artifact itself in the frame and are asked to sign in to read and add comments.
import {
  BRIDGE_LIMITS,
  type FrameRect,
  placeNear,
  type RefusalReason,
  visibleRect,
} from "@portifact/bridge";
import {
  type AnnotationTarget,
  type AnnotationThreadView,
  type AnnotationVersionFilter,
  type IntegrationChoiceList,
  REVIEW_SESSION,
  type ReviewStart,
  type ReviewTabStart,
  type ViewerInfo,
} from "@portifact/contracts";
import { viewerHash, viewerPath } from "@portifact/domain";
import {
  Avatar,
  Badge,
  BrandMark,
  Button,
  buttonClasses,
  Callout,
  Disclosure,
  Floating,
  FloatingPanel,
  FrameOverlay,
  HostingNotice,
  IconButton,
  IconLink,
  LiveRegion,
  LoadingState,
  Menu,
  type MenuItem,
  ModeSwitch,
  type OverlayPoint,
  type OverlaySize,
  PageHeader,
  Select,
  type SelectOption,
  ThemedImage,
  Toast,
  ViewerShell,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import {
  AppWindow,
  CircleAlert,
  Crosshair,
  Download,
  ExternalLink,
  FilePen,
  Flag,
  Info,
  LayoutGrid,
  Link2,
  LogIn,
  MessageSquare,
  MessageSquarePlus,
  PencilLine,
  RefreshCw,
  Send,
  Settings,
  UserRound,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import symbol from "../../../../../assets/brand/symbol.svg";
import symbolDark from "../../../../../assets/brand/symbol-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { ApiFailure } from "../api.ts";
import { AnnounceContext, useAnnounce, useDashboard, useT } from "../context.tsx";
import { useIssueChoices } from "../review/create-issue.tsx";
import { DataGrantPanel, useDataGrant } from "../review/data-grant.tsx";
import { DraftPanel, useDraft } from "../review/draft.tsx";
import { useHumanCheck } from "../review/human-check.tsx";
import { SUGGEST_OFF, type SuggestOffer, suggestReducer } from "../review/suggest-session.ts";
import { ChangeList, SuggestEditor } from "../review/suggestions.tsx";
import { TextSearchPanel } from "../review/text-search-panel.tsx";
import { ActionError, bodyError, humanRefusal, ThreadCard } from "../review/thread-card.tsx";
import { TargetSummary } from "../review/thread-parts.tsx";
import { type BridgeState, useBridge } from "../review/use-bridge.ts";
import { applyThread, type ThreadsState, threadsQuery, useThreads } from "../review/use-threads.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { ApprovalStatusBadge, useApprovalReview, VerdictPanel } from "./approval-review.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { CommentNoticeToggle } from "./comment-notices.tsx";
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

/** Below this width the inline composer is a bottom sheet instead of a panel by the selection. */
const NARROW_SCREEN = "(max-width: 40rem)";

/** Space between a selection and the controls the viewer draws next to it, in CSS pixels. */
const ANCHOR_GAP = 6;

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
    content = (
      <main id="main" className="flex min-h-dvh flex-col">
        <LoadingState layout="centered" label={t("viewer.loading")} />
      </main>
    );
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

/** Where this browser remembers whether the reader keeps the comments open on wide screens. */
export const SIDEBAR_STORAGE_KEY = "portifact.viewer.comments";

/** The reader's last choice on a wide screen, or null without one or without storage. */
function rememberedSidebar(): boolean | null {
  try {
    const value = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return value === "open" ? true : value === "closed" ? false : null;
  } catch {
    return null;
  }
}

/** Remembers the reader's choice in this browser; without storage it is simply not kept. */
function rememberSidebar(open: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Private windows and blocked storage keep the default.
  }
}

/**
 * Whether the sidebar starts open: on a wide screen, as the reader last left it (open by default);
 * on a narrow one it would cover the artifact, so it starts closed.
 */
function startsOpen(): boolean {
  const wide =
    typeof window.matchMedia === "function" ? window.matchMedia(WIDE_SCREEN).matches : true;
  return wide && (rememberedSidebar() ?? true);
}

interface LayoutProps {
  info: ViewerInfo;
  target: Target;
  /** What the bar's account control is: the dashboard and the account, or signing in. */
  account: { kind: "signed-in" } | { kind: "anonymous"; here: string };
  frame: ReactNode;
  /** The sidebar's content; null shows no sidebar and no toggle. */
  sidebar: ReactNode | null;
  sidebarOpen: boolean;
  onSidebar(open: boolean): void;
  /** Open threads on the current version, shown on the comments toggle. */
  openCount?: number | undefined;
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
  openCount,
}: LayoutProps) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  // The approval review's status (decision 0013), as the API lets this visitor see it.
  const approval = useApprovalReview(info.artifactId, account.kind === "signed-in");
  const signedIn = useQuery({
    queryKey: ACCOUNT_QUERY,
    queryFn: () => api.account(),
    enabled: account.kind === "signed-in",
  });
  const toggle = useRef<HTMLButtonElement>(null);
  const aside = useRef<HTMLElement>(null);
  /** Set when the toggle opened the sidebar where it covers the artifact: focus moves into it. */
  const focusSidebar = useRef(false);
  useEffect(() => {
    if (!sidebarOpen || !focusSidebar.current) return;
    focusSidebar.current = false;
    aside.current?.focus();
  }, [sidebarOpen]);
  const link = pageUrl(info.origin, target);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      announce(t("viewer.copied"));
    } catch {
      // The toast shows the link, so it can still be copied by hand.
      announce(t("viewer.copyFailed", { url: link }));
    }
  };
  // Full page loads: the dashboard gets its own policy, not the viewer's narrow frame-src.
  const settings =
    info.role === "owner"
      ? {
          href: `/artifacts/${encodeURIComponent(info.artifactId)}`,
          label: t("viewer.manage"),
          icon: <Settings className="size-4" />,
        }
      : {
          href: `/report?${new URLSearchParams({ artifact: info.artifactId })}`,
          label: t("review.report"),
          icon: <Flag className="size-4" />,
        };
  const email = signedIn.data?.email ?? "";
  const overflowItems: MenuItem[] = [
    {
      id: "copy",
      label: t("viewer.copyLink"),
      icon: <Link2 className="size-4" />,
      onSelect: () => void copyLink(),
    },
    { id: "settings", ...settings },
    ...(account.kind === "signed-in"
      ? [
          {
            id: "dashboard",
            label: t("viewer.dashboard"),
            href: "/",
            icon: <LayoutGrid className="size-4" />,
          },
          {
            id: "account",
            label: t("viewer.account"),
            href: "/account",
            icon: <UserRound className="size-4" />,
          },
        ]
      : [
          {
            id: "sign-in",
            label: t("viewer.signIn"),
            href: loginUrl(account.here),
            icon: <LogIn className="size-4" />,
          },
        ]),
  ];
  const narrow = () =>
    typeof window.matchMedia === "function" && !window.matchMedia(WIDE_SCREEN).matches;
  return (
    <ViewerShell
      skipLinkLabel={t("viewer.skipLink")}
      brand={
        info.brand ? (
          // The owner's brand (premium plan P9): their text, logo and link, never markup.
          <BrandMark
            name={info.brand.name}
            href={info.brand.link}
            newTabLabel={t("viewer.brandNewTab")}
            accent={info.brand.accentColor}
            logo={
              info.brand.logo
                ? {
                    src: info.brand.logo.url,
                    width: info.brand.logo.width,
                    height: info.brand.logo.height,
                  }
                : null
            }
          />
        ) : (
          <a href="/" aria-label={t("viewer.brand")} className="no-underline">
            <ThemedImage
              src={symbol}
              darkSrc={symbolDark}
              alt=""
              width={32}
              height={32}
              className="size-8"
            />
          </a>
        )
      }
      notice={
        info.brand ? (
          // A brand never hides who hosts the page, where it really lives or how to report it.
          <HostingNotice
            mark={
              <ThemedImage
                src={symbol}
                darkSrc={symbolDark}
                alt=""
                width={16}
                height={16}
                className="size-4"
              />
            }
            poweredBy={t("viewer.hosting.poweredBy")}
            originLabel={t("viewer.hosting.origin")}
            origin={new URL(info.origin).host}
            report={
              info.role === "owner"
                ? undefined
                : {
                    href: `/report?${new URLSearchParams({ artifact: info.artifactId })}`,
                    label: t("review.report"),
                  }
            }
          />
        ) : undefined
      }
      artifact={{
        // The publisher's name for it, as plain text: never styled as a Portifact heading.
        title: info.name,
        details: (
          <>
            <Badge emphasis="quiet">{t("viewer.version", { number: info.versionNumber })}</Badge>
            {approval.data && approval.data.review.status !== "none" ? (
              <ApprovalStatusBadge review={approval.data.review} />
            ) : null}
          </>
        ),
      }}
      actions={
        <>
          <IconButton
            label={t("viewer.copyLink")}
            icon={<Link2 className="size-4" />}
            onClick={() => void copyLink()}
          />
          <IconLink label={settings.label} icon={settings.icon} href={settings.href} />
        </>
      }
      toggle={
        sidebar !== null ? (
          <Button
            ref={toggle}
            size="sm"
            icon={<MessageSquare className="size-4" />}
            aria-pressed={sidebarOpen}
            aria-controls={sidebarOpen ? SIDEBAR_ID : undefined}
            count={
              openCount
                ? { value: openCount, label: t("viewer.comments.open", { count: openCount }) }
                : undefined
            }
            onClick={() => {
              const isNarrow = narrow();
              focusSidebar.current = !sidebarOpen && isNarrow;
              // Only a wide screen's choice is kept: there the sidebar sits beside the artifact.
              if (!isNarrow) rememberSidebar(!sidebarOpen);
              onSidebar(!sidebarOpen);
            }}
          >
            <span className="max-sm:sr-only">{t("viewer.comments")}</span>
          </Button>
        ) : null
      }
      overflow={<Menu label={t("viewer.more")} items={overflowItems} size="sm" />}
      account={
        account.kind === "signed-in" ? (
          <>
            <IconLink
              label={t("viewer.dashboard")}
              icon={<LayoutGrid className="size-4" />}
              href="/"
            />
            <IconLink
              label={t("viewer.account")}
              icon={<Avatar name={email || "?"} />}
              href="/account"
              align="end"
            />
          </>
        ) : (
          <a
            href={loginUrl(account.here)}
            className={buttonClasses({ intent: "primary", size: "sm" })}
          >
            <LogIn aria-hidden="true" className="size-4" />
            {t("viewer.signIn")}
          </a>
        )
      }
      frameLabel={t("viewer.frame.label")}
      frame={frame}
      sidebar={
        sidebar !== null && sidebarOpen
          ? {
              id: SIDEBAR_ID,
              label: t("review.comments.heading"),
              content: sidebar,
              closeLabel: t("viewer.closeComments"),
              ref: aside,
              onClose: () => {
                onSidebar(false);
                setTimeout(() => toggle.current?.focus(), 0);
              },
            }
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
  // With suggestions on, threads say their kind; they load once the review session says so.
  const threads = useThreads(
    info.artifactId,
    version,
    comments && !start.isPending,
    start.data?.suggestions === true,
  );

  if (start.isPending) {
    return (
      <ViewerLayout
        info={info}
        target={target}
        account={{ kind: "signed-in" }}
        frame={<LoadingState layout="centered" label={t("viewer.loading")} />}
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
 * What the reader selected in the frame (text, or an element they picked), which the viewer
 * offers to comment on with a "Comment" control drawn next to it. `rect` and `drawn` only place
 * that control; the frame reports them and the viewer clamps them to the frame.
 */
interface Offer {
  target: AnnotationTarget;
  /** Where the bridge last said it is drawn in the frame, if it said. */
  rect: FrameRect | null;
  /** False once the bridge said it is no longer drawn, such as scrolled out of the frame. */
  drawn: boolean;
}

/**
 * What a new comment points at, chosen in the frame or here. Each draft has its own `id`, so its
 * composer starts fresh and keeps the target it opened with. An inline draft is written in a
 * panel next to the selection, placed by the rectangle it had when the reader opened it.
 */
type Draft = {
  id: number;
  target: AnnotationTarget;
  inline: { rect: FrameRect | null } | null;
} | null;

/** Whether `query` matches now, following changes. */
function useMediaQuery(query: string): boolean {
  const supported = typeof window.matchMedia === "function";
  const [matches, setMatches] = useState(() => supported && window.matchMedia(query).matches);
  useEffect(() => {
    if (!supported) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query, supported]);
  return matches;
}

/**
 * Where the "Comment" control goes: next to the selection's visible part, hidden when none of it
 * is in the frame. A selection reported without a rectangle gets the frame's bottom right corner.
 */
function pillPlacement(offer: Offer, size: OverlaySize, area: OverlaySize): OverlayPoint | null {
  if (!offer.drawn) return null;
  if (!offer.rect) {
    const corner = { x: area.width - size.width - 12, y: area.height - size.height - 12 };
    return corner.x >= 0 && corner.y >= 0 ? corner : null;
  }
  const anchor = visibleRect(offer.rect, area);
  return anchor ? placeNear(anchor, size, area, ANCHOR_GAP) : null;
}

/** The "Suggest edit" control is placed exactly like the "Comment" one. */
const suggestPill = (offer: SuggestOffer): Offer => offer;

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
  const approval = useApprovalReview(info.artifactId, true);
  // The owner side may create issues from threads (decision 0018).
  const issueChoices = useIssueChoices(info.artifactId, info.role === "owner");
  const frame = useRef<HTMLIFrameElement>(null);
  // Artifact data (decision 0026): the page in the frame may ask to save as the visitor.
  const dataGrant = useDataGrant({ artifactId: info.artifactId, origin: info.origin, frame });
  const [sidebarOpen, setSidebarOpen] = useState(startsOpen);
  const [offer, setOfferState] = useState<Offer | null>(null);
  const [draft, setDraftState] = useState<Draft>(null);
  const narrow = useMediaQuery(NARROW_SCREEN);
  // Selection hints go to screen readers only: a toast for every selection would cover the page.
  const [hint, setHint] = useState("");
  // An inline draft that does not fit beside its selection becomes a bottom sheet, for good.
  const [unplaced, setUnplaced] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<ThreadSelection>(NO_SELECTION);
  // Suggest mode (decision 0027): its own state, apart from comments. The frame only offers a
  // selection while the person is choosing, for the current edit epoch.
  const [suggest, dispatchSuggest] = useReducer(suggestReducer, SUGGEST_OFF);
  /** What an edit made in the frame becomes: a suggestion, or (the owner side) a draft change. */
  const [purpose, setPurpose] = useState<"suggest" | "edit">("suggest");
  const items = useRef(new Map<string, HTMLElement>());
  // The page shares the bridge's window and can post what the bridge posts, so these refs, not
  // the page, decide when its selection or element may fill in a comment: an element only
  // while the reader is picking, and nothing while a comment is open.
  const drafting = useRef(false);
  const awaitingPick = useRef(false);
  const draftIds = useRef(0);
  const offered = useRef(false);
  const setOffer = (next: Offer | null) => {
    offered.current = next !== null;
    setOfferState(next);
  };
  const setDraft = (
    next: AnnotationTarget | null,
    inline: { rect: FrameRect | null } | null = null,
  ) => {
    drafting.current = next !== null;
    setUnplaced(false);
    setDraftState(next ? { id: ++draftIds.current, target: next, inline } : null);
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
  const ownerSide = data?.role === "owner";
  // The owner side's private draft (decision 0027), loaded only while suggestions are on.
  const ownerDraft = useDraft(start, start.suggestions === true && ownerSide);

  const bridge = useBridge(
    frame,
    start.origin,
    start.sessionTag,
    {
      // The page can forge any of these: a selection only offers a comment the reader still writes
      // and saves here, and nothing the frame sends counts while a comment is open.
      onSelection(selected, rect, epoch) {
        if (suggest.mode !== "off") {
          if (
            suggest.mode === "choosing" &&
            epoch === suggest.epoch &&
            selected &&
            !suggest.offer
          ) {
            setHint(t("suggest.selection.received"));
          }
          dispatchSuggest({ type: "selection", target: selected, rect, epoch });
          return;
        }
        if (drafting.current) return;
        if (!selected || !canComment) {
          setOffer(null);
          return;
        }
        // Focus stays in the artifact; the "Comment" control follows the frame in the tab order.
        if (!offered.current) setHint(t("review.selection.received"));
        setOffer({ target: selected, rect, drawn: true });
      },
      onElement(picked, rect) {
        if (suggest.mode !== "off") return;
        if (!awaitingPick.current || drafting.current) return;
        stopPicking();
        if (!canComment) return;
        setHint(t("review.element.received"));
        setOffer({ target: picked, rect, drawn: true });
      },
      onSelectionRect(rect) {
        if (suggest.mode !== "off") {
          // Moves only the "Suggest edit" control while choosing; never an open editor.
          dispatchSuggest({ type: "selection-rect", rect });
          return;
        }
        // Only moves the control of what is offered; never a target, and never an open comment.
        if (drafting.current || !offered.current) return;
        setOfferState((current) =>
          current ? { ...current, rect: rect ?? current.rect, drawn: rect !== null } : current,
        );
      },
      onRefused(reason: RefusalReason) {
        announce(refusalMessage(t, reason));
      },
      onPickEnded() {
        stopPicking();
      },
      onPageChange() {
        // A new page, a route change or the session's end: an open edit is gone, unsaved.
        if (suggest.mode === "editing") announce(t("suggest.discarded"));
        dispatchSuggest({ type: "page-change" });
      },
      onStatus() {
        // The page can forge a status: the API says what really holds for comments.
        void threads.refetch();
      },
      onSelect(ids) {
        // Only threads this panel shows count; the hook already dropped IDs never sent to the page.
        const known = ids.filter(
          (id) => numbers.has(id) && shown.some((thread) => thread.id === id),
        );
        if (known.length === 0) {
          setSelection((current) => (current.fromFrame ? NO_SELECTION : current));
          return;
        }
        setSelection({ ids: known, fromFrame: true });
        setSidebarOpen(true);
        const list = known.map((id) => numbers.get(id)).join(", ");
        // A polite announcement, not the toast: a click in the artifact must not cover the threads.
        setHint(
          known.length === 1
            ? t("review.thread.activated", { number: list })
            : t("review.thread.activatedMany", { numbers: list }),
        );
        // Scrolled into view after the sidebar renders; focus stays in the artifact.
        setTimeout(() => {
          const first = known[0];
          const card = first ? items.current.get(first) : undefined;
          card?.scrollIntoView?.({ block: "nearest" });
        }, 0);
      },
    },
    start.suggestions === true,
  );

  // The frame only gets the targets of the threads of the page it shows, never bodies or names.
  const { send, state, page } = bridge;
  const highlighted = shown
    .filter((thread) => thread.current)
    .filter((thread) => thread.target.anchor.kind !== "document")
    .filter((thread) => thread.target.path === page?.path)
    .slice(0, BRIDGE_LIMITS.highlightsMax);
  const highlightKey = JSON.stringify([
    state,
    page?.path,
    selection.ids,
    highlighted.map((thread) => [thread.id, thread.revision]),
  ]);
  // highlightKey summarizes what the effect sends, so it runs only when that changes.
  useEffect(() => {
    if (state !== "connected" || !data || !page) return;
    const ids = new Set(highlighted.map((thread) => thread.id));
    send({
      type: "highlights",
      highlights: highlighted.map((thread) => ({ id: thread.id, target: thread.target })),
      selected: selection.ids.filter((id) => ids.has(id)),
    });
  }, [highlightKey]);
  const hover = (id: string | null) => {
    if (state !== "connected") return;
    send({ type: "hover", id: id && highlighted.some((thread) => thread.id === id) ? id : null });
  };

  const path = page?.path ?? start.entrypoint;

  // Element mode and the offer end wherever the frame stops being a connected bridge.
  useEffect(() => {
    if (state === "connected") return;
    stopPicking();
    setOffer(null);
    dispatchSuggest({ type: "page-change" });
  }, [state]);

  // Suggesting is offered only when the API switched it on, comments are open, and the bridge
  // in the frame announced it can (protocol 3). The page can forge that announcement: it only
  // decides what this screen offers, never what is saved.
  const canSuggest =
    start.suggestions === true &&
    canComment &&
    state === "connected" &&
    bridge.capabilities.includes("edit");
  useEffect(() => {
    if (!canSuggest) dispatchSuggest({ type: "toggle", on: false });
  }, [canSuggest]);
  // The frame learns only the mode and the epoch: never what is typed.
  const suggestKey = `${suggest.mode}:${suggest.epoch}:${state}`;
  // suggestKey summarizes what the effect sends, so it runs only when that changes.
  useEffect(() => {
    if (state !== "connected" || suggest.epoch === 0) return;
    send({
      type: "edit-mode",
      epoch: suggest.epoch,
      active: suggest.mode === "choosing",
      kind: "text",
      hint: t("suggest.hint"),
    });
  }, [suggestKey]);
  const setMode = (mode: "comment" | "suggest" | "edit") => {
    const on = mode !== "comment";
    if (on && suggest.mode !== "off") {
      // Between Suggest and Edit: an open editor ends unsaved, the selection mode stays.
      if (mode === purpose) return;
      setPurpose(mode);
      dispatchSuggest({ type: "cancel" });
      announce(t(mode === "edit" ? "draft.mode.on" : "suggest.mode.on"));
      return;
    }
    if (on === (suggest.mode !== "off")) return;
    if (on) setPurpose(mode);
    if (on) {
      setDraft(null);
      setOffer(null);
      if (picking) {
        stopPicking();
        send({ type: "pick", active: false, hint: t("review.pick.hint") });
      }
    }
    send({ type: "clear-selection" });
    dispatchSuggest({ type: "toggle", on });
    announce(t(!on ? "suggest.mode.off" : mode === "edit" ? "draft.mode.on" : "suggest.mode.on"));
  };
  const closeEditor = (threadId: string | null) => {
    send({ type: "clear-selection" });
    if (threadId) setSelection({ ids: [threadId], fromFrame: false });
    // Back to the artifact the person was in.
    else frame.current?.focus();
  };

  const startGeneral = () => {
    setOffer(null);
    setDraft({ schema: 1, path, anchor: { kind: "document" } });
  };
  const startInline = () => {
    if (!offer) return;
    setDraft(offer.target, { rect: offer.drawn ? offer.rect : null });
    setOffer(null);
  };
  const togglePick = () => {
    const next = !picking;
    awaitingPick.current = next;
    setPicking(next);
    send({ type: "pick", active: next, hint: t("review.pick.hint") });
    if (next) announce(t("review.pick.started"));
  };
  const closeDraft = () => {
    const inline = draft?.inline !== null && draft !== null;
    setDraft(null);
    setOffer(null);
    send({ type: "clear-selection" });
    // The inline composer goes away with focus inside it: back to the artifact the reader was in.
    if (inline) frame.current?.focus();
  };
  const select = (id: string, show: boolean) => {
    setSelection({ ids: [id], fromFrame: false });
    if (show) send({ type: "focus", id });
  };

  // Where the browser keeps no session in the frame, a public artifact is still shown as it is,
  // without review tools; a protected one cannot be, so the frame keeps the notice.
  const plain = state === "unavailable" && info.accessMode === "public";
  const src = plain ? pageUrl(info.origin, target) : withTarget(start.url, target);

  const humanNeeded = data?.humanCheck ?? false;
  const sheet = narrow || unplaced;
  // Drawn by this page over the frame, never inside the artifact's document, and clipped to the
  // frame's box: what the frame reports can move these controls but never out of the frame.
  const suggestOffer = suggest.mode === "choosing" ? suggest.offer : null;
  const suggestLayer = suggestOffer ? (
    <Floating place={(size, area) => pillPlacement(suggestPill(suggestOffer), size, area)}>
      <Button
        intent="floating"
        size="sm"
        icon={<PencilLine className="size-4" />}
        onClick={() => dispatchSuggest({ type: "open", offer: suggestOffer })}
      >
        {t("suggest.selection.action")}
      </Button>
    </Floating>
  ) : suggest.mode === "editing" ? (
    <Floating
      key={`${suggest.epoch}`}
      sheet={sheet}
      place={(size, area) => {
        const anchor = suggest.rect ? visibleRect(suggest.rect, area) : null;
        return anchor ? placeNear(anchor, size, area, ANCHOR_GAP) : null;
      }}
      onPlaced={(placed) => {
        if (!placed) setUnplaced(true);
      }}
    >
      <FloatingPanel label={t("suggest.editor.label")} sheet={sheet}>
        <SuggestEditor
          start={start}
          state={suggest}
          dispatch={dispatchSuggest}
          humanNeeded={humanNeeded}
          onClose={closeEditor}
          draft={purpose === "edit" && ownerSide ? ownerDraft : undefined}
        />
      </FloatingPanel>
    </Floating>
  ) : null;
  const layer = suggestLayer ? (
    suggestLayer
  ) : canComment && (offer || draft?.inline) ? (
    <>
      {offer && !draft ? (
        <Floating place={(size, area) => pillPlacement(offer, size, area)}>
          <Button
            intent="floating"
            size="sm"
            icon={<MessageSquarePlus className="size-4" />}
            onClick={startInline}
          >
            {t("review.selection.comment")}
          </Button>
        </Floating>
      ) : null}
      {draft?.inline ? (
        <Floating
          key={draft.id}
          sheet={sheet}
          place={(size, area) => {
            const rect = draft.inline?.rect;
            const anchor = rect ? visibleRect(rect, area) : null;
            return anchor ? placeNear(anchor, size, area, ANCHOR_GAP) : null;
          }}
          onPlaced={(placed) => {
            if (!placed) setUnplaced(true);
          }}
        >
          <FloatingPanel label={t("review.inline.label")} sheet={sheet}>
            <InlineComposer
              start={start}
              owner={data?.role === "owner"}
              target={draft.target}
              humanNeeded={humanNeeded}
              onDone={(thread) => {
                closeDraft();
                if (thread) setSelection({ ids: [thread.id], fromFrame: false });
              }}
            />
          </FloatingPanel>
        </Floating>
      ) : null}
    </>
  ) : null;

  const frameArea = (
    <>
      <div className="flex flex-col gap-3 p-3 empty:hidden">
        <DataGrantPanel artifactId={info.artifactId} origin={info.origin} grant={dataGrant} />
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
      <FrameOverlay layer={layer}>
        <LiveRegion message={hint} />
        <ArtifactFrame info={info} src={src} frame={frame} onLoad={bridge.onFrameLoad} />
        {state === "connecting" ? (
          <LoadingState layout="cover" label={t("review.frame.connecting")} />
        ) : null}
      </FrameOverlay>
    </>
  );

  const reviewer = approval.data?.role === "reviewer" ? approval.data : null;
  const sidebar =
    !comments && !reviewer ? null : !comments && reviewer ? (
      <VerdictPanel key={reviewer.request?.versionId} view={reviewer} />
    ) : (
      <>
        {reviewer ? <VerdictPanel key={reviewer.request?.versionId} view={reviewer} /> : null}
        <h2 className="text-lg font-semibold">{t("review.comments.heading")}</h2>
        <p className="text-sm text-text-muted">{t("review.comments.untrusted")}</p>
        {data ? <ModeNotice artifactId={start.artifactId} state={data} /> : null}
        {canComment ? (
          <div
            role="toolbar"
            aria-label={t("review.toolbar.label")}
            className="flex flex-wrap gap-2"
          >
            {canSuggest ? (
              <ModeSwitch
                label={t("suggest.mode.label")}
                value={suggest.mode === "off" ? "comment" : purpose}
                onChange={setMode}
                options={[
                  {
                    value: "comment",
                    label: t("suggest.mode.comment"),
                    name: t("suggest.mode.name", { mode: t("suggest.mode.comment") }),
                    icon: <MessageSquare className="size-4" />,
                  },
                  {
                    value: "suggest",
                    label: t("suggest.mode.suggest"),
                    name: t("suggest.mode.name", { mode: t("suggest.mode.suggest") }),
                    icon: <PencilLine className="size-4" />,
                  },
                  // The owner side may also edit directly, into a private draft.
                  ...(ownerSide
                    ? [
                        {
                          value: "edit" as const,
                          label: t("draft.mode.edit"),
                          name: t("suggest.mode.name", { mode: t("draft.mode.edit") }),
                          icon: <FilePen className="size-4" />,
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
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
        {suggest.mode !== "off" ? (
          <TextSearchPanel
            start={start}
            path={path}
            // Reading a site's stored files is the owner side's: reviewers select in the frame.
            available={ownerSide}
            onChoose={(found) => dispatchSuggest({ type: "open-target", target: found })}
          />
        ) : null}
        {canComment && draft && !draft.inline ? (
          <Composer
            key={draft.id}
            start={start}
            owner={data?.role === "owner"}
            target={draft.target}
            humanNeeded={humanNeeded}
            onDone={(thread) => {
              closeDraft();
              if (thread) setSelection({ ids: [thread.id], fromFrame: false });
            }}
          />
        ) : null}
        <ThreadList
          start={start}
          issueChoices={issueChoices}
          artifactName={info.name}
          threads={threads}
          shown={shown}
          filtered={filter.status !== "all" || filter.author !== "all"}
          numbers={numbers}
          selection={selection}
          resolutions={bridge.resolutions}
          path={path}
          located={state === "connected"}
          onSelect={select}
          onHover={hover}
          onClearSelection={() => setSelection(NO_SELECTION)}
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
        {ownerSide && start.suggestions === true ? (
          <>
            <DraftPanel start={start} state={ownerDraft} />
            <ChangeList artifactId={start.artifactId} />
          </>
        ) : null}
        {data ? <CommentNoticeToggle artifactId={start.artifactId} explainPlan={false} /> : null}
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
      openCount={data?.threads.filter((thread) => thread.current && thread.state === "open").length}
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
  // While connecting, the frame is covered by a centered loading state (see the frame area).
  if (state === "connecting") return null;
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

/**
 * Posting a new thread on `target`: the human check when the visitor still needs it, one
 * idempotency key per comment (a new one after a refusal), and the thread applied to the list.
 */
function useCreateThread(
  start: ReviewStart,
  target: AnnotationTarget,
  humanNeeded: boolean,
  onDone: (thread: AnnotationThreadView) => void,
) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const human = useHumanCheck(humanNeeded);
  const post = useMutation({
    mutationFn: (body: string) =>
      human.post((key, token) =>
        api.createThread(
          start.artifactId,
          {
            versionId: start.versionId,
            target,
            body,
            ...(token === undefined ? {} : { turnstileToken: token }),
          },
          key,
        ),
      ),
    onSuccess: async (thread) => {
      if (!thread) return;
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
  const error =
    post.isError && !humanRefusal(post.error) ? <ActionError error={post.error} /> : null;
  return { form, post, human, error };
}

/** Who can read a new thread: every reader sees the owner's threads; a reader's, the owner. */
const visibilityHint = (owner: boolean) =>
  owner ? "review.composer.hint.owner" : "review.composer.hint";

/** The sidebar's composer: general comments on the page the frame shows. */
function Composer({
  start,
  owner,
  target: initialTarget,
  humanNeeded,
  onDone,
}: {
  start: ReviewStart;
  owner: boolean;
  target: AnnotationTarget;
  humanNeeded: boolean;
  onDone(thread: AnnotationThreadView | null): void;
}) {
  const t = useT();
  // Frozen when the composer opens: nothing the frame sends later can retarget the comment.
  const [target] = useState(initialTarget);
  const { form, post, human, error } = useCreateThread(start, target, humanNeeded, onDone);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-strong p-3">
      <TargetSummary target={target} />
      {error}
      <form.AppForm>
        <form.Form label={t("review.composer.label")}>
          <div className="flex flex-col gap-3">
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t("review.composer.body")}
                  description={t(visibilityHint(owner))}
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

/**
 * Enter submits the text area's form and Shift+Enter adds a line, except while an input method
 * is composing text; Escape calls `onEscape`.
 */
function submitOnEnter(onEscape: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
}

/**
 * The composer drawn next to the reader's selection: a text area, Cancel and Save. Enter saves,
 * Shift+Enter adds a line and Escape cancels, from anywhere in it.
 */
function InlineComposer({
  start,
  owner,
  target: initialTarget,
  humanNeeded,
  onDone,
}: {
  start: ReviewStart;
  /** Who can read a new thread differs: every reader sees the owner's threads. */
  owner: boolean;
  target: AnnotationTarget;
  humanNeeded: boolean;
  onDone(thread: AnnotationThreadView | null): void;
}) {
  const t = useT();
  const [target] = useState(initialTarget);
  const { form, post, human, error } = useCreateThread(start, target, humanNeeded, onDone);
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef(() => onDone(null));
  cancel.current = () => onDone(null);
  useEffect(() => {
    // Escape on its buttons too, not only in the text area.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!panel.current?.contains(document.activeElement)) return;
      event.preventDefault();
      cancel.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    // Not `autoFocus`: the panel is placed (and so made visible) only after it mounts, and a
    // hidden field cannot take focus. Once more on the next frame, after a switch to a sheet.
    const focus = () => {
      const box = panel.current?.querySelector("textarea");
      if (box && document.activeElement !== box) box.focus();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={panel} className="flex flex-col gap-3">
      <TargetSummary target={target} compact />
      {error}
      <form.AppForm>
        <form.Form label={t("review.composer.label")}>
          <div className="flex flex-col gap-3">
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t("review.composer.body")}
                  description={`${t(visibilityHint(owner))} ${t("review.inline.hint")}`}
                  rows={3}
                  compact
                  onKeyDown={submitOnEnter(() => onDone(null))}
                />
              )}
            </form.AppField>
            {human.field}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={() => onDone(null)}>
                {t("review.composer.cancel")}
              </Button>
              <form.SubmitButton size="sm" busy={post.isPending}>
                {t("review.inline.submit")}
              </form.SubmitButton>
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

/** The threads the reader selected, and whether a click in the artifact chose them. */
interface ThreadSelection {
  /** Primary first: the innermost or most recent thread at the place clicked. */
  ids: string[];
  fromFrame: boolean;
}

const NO_SELECTION: ThreadSelection = { ids: [], fromFrame: false };

interface ThreadListProps {
  start: ReviewStart;
  /** The owner's connections for issues (decision 0018); undefined offers none. */
  issueChoices?: IntegrationChoiceList | undefined;
  artifactName: string;
  threads: ThreadsQuery;
  /** The threads the filters let through, in creation order. */
  shown: AnnotationThreadView[];
  filtered: boolean;
  numbers: Map<string, number>;
  selection: ThreadSelection;
  resolutions: ReadonlyMap<string, { confidence: string }>;
  path: string;
  located: boolean;
  onSelect(id: string, show: boolean): void;
  onHover(id: string | null): void;
  onClearSelection(): void;
  register(id: string, element: HTMLElement | null): void;
}

function ThreadList({
  start,
  issueChoices,
  artifactName,
  threads,
  shown,
  filtered,
  numbers,
  selection,
  onClearSelection,
  ...rest
}: ThreadListProps) {
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
  const visible = threads.isPlaceholderData ? [] : shown;
  // Several threads chosen by one click in the artifact are shown together, first.
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const group =
    selection.fromFrame && selection.ids.length > 1
      ? selection.ids.flatMap((id) => byId.get(id) ?? [])
      : [];
  const grouped = new Set(group.map((thread) => thread.id));
  const card = (thread: AnnotationThreadView) => (
    <ThreadCard
      key={thread.id}
      artifactId={start.artifactId}
      thread={thread}
      number={numbers.get(thread.id) ?? 0}
      state={data}
      selection={
        selection.ids[0] === thread.id
          ? "primary"
          : selection.ids.includes(thread.id)
            ? "selected"
            : null
      }
      resolution={rest.resolutions.get(thread.id)}
      path={rest.path}
      located={rest.located}
      onSelect={rest.onSelect}
      onHover={rest.onHover}
      register={rest.register}
      issueChoices={issueChoices}
      artifactName={artifactName}
    />
  );
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
      {group.length > 1 ? (
        <section
          aria-labelledby="viewer-selected-threads"
          className="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-2"
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <h3 id="viewer-selected-threads" className="text-sm font-semibold">
              {t("review.group.heading", { count: group.length })}
            </h3>
            <Button intent="link" size="inline" onClick={onClearSelection}>
              {t("review.group.clear")}
            </Button>
          </div>
          <ol className="flex flex-col gap-3">{group.map(card)}</ol>
        </section>
      ) : null}
      <ol className="flex flex-col gap-3">
        {visible.filter((thread) => !grouped.has(thread.id)).map(card)}
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
