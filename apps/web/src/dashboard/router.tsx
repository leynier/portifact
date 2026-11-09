// Client routes of the dashboard. The Worker serves the app for exactly these paths
// (DASHBOARD_ROUTES, and VIEWER_ROUTE for the viewer, in apps/app/src/app-host.ts); keep both
// lists in sync.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { AppsScreen } from "./screens/apps.tsx";
import { ArtifactDetailScreen } from "./screens/artifact-detail.tsx";
import { ArtifactListScreen, parseListSearch } from "./screens/artifact-list.tsx";
import { DocumentEditorScreen } from "./screens/document-editor.tsx";
import { HistoryScreen } from "./screens/history.tsx";
import { NotFoundScreen } from "./screens/not-found.tsx";
import { ProfileScreen } from "./screens/profile.tsx";
import { PublishScreen, PublishVersionScreen } from "./screens/publish.tsx";
import { SettingsScreen } from "./screens/settings.tsx";
import { Shell } from "./screens/shell.tsx";
import { UsageScreen } from "./screens/usage.tsx";
import { parseViewerSearch, ViewerScreen } from "./screens/viewer.tsx";

/**
 * Every dashboard screen sits in the shell (navigation and account); the viewer draws its own
 * frame, the Portifact bar, so it fills the screen.
 */
function Frame() {
  const viewer = useMatch({ from: "/view/$artifactId", shouldThrow: false });
  return viewer ? <Outlet /> : <Shell />;
}

/**
 * Where a link to the old single account page lands: its sections moved to Profile, Apps, Usage
 * and Settings, so each anchor goes to the page that holds it now.
 */
export function accountRedirect(hash: string): "/profile" | "/apps" | "/usage" | "/settings" {
  switch (hash.replace(/^#/, "")) {
    case "usage":
      return "/usage";
    case "apps":
      return "/apps";
    case "data":
    case "delete":
    case "defaults":
      return "/settings";
    default:
      return "/profile";
  }
}

export function createDashboardRouter(history?: RouterHistory) {
  const root = createRootRoute({ component: Frame, notFoundComponent: NotFoundScreen });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: ArtifactListScreen,
    validateSearch: parseListSearch,
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/artifacts/$artifactId",
    component: ArtifactDetailScreen,
  });
  const publish = createRoute({
    getParentRoute: () => root,
    path: "/publish",
    component: PublishScreen,
  });
  const publishVersion = createRoute({
    getParentRoute: () => root,
    path: "/artifacts/$artifactId/publish",
    component: PublishVersionScreen,
  });
  const edit = createRoute({
    getParentRoute: () => root,
    path: "/artifacts/$artifactId/edit",
    component: DocumentEditorScreen,
  });
  const versionHistory = createRoute({
    getParentRoute: () => root,
    path: "/artifacts/$artifactId/history",
    component: HistoryScreen,
  });
  const profile = createRoute({
    getParentRoute: () => root,
    path: "/profile",
    component: ProfileScreen,
  });
  const apps = createRoute({
    getParentRoute: () => root,
    path: "/apps",
    component: AppsScreen,
  });
  const usage = createRoute({
    getParentRoute: () => root,
    path: "/usage",
    component: UsageScreen,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: SettingsScreen,
  });
  // The old account page: links and bookmarks to it, with or without an anchor, still work.
  const account = createRoute({
    getParentRoute: () => root,
    path: "/account",
    beforeLoad: ({ location }) => {
      throw redirect({ to: accountRedirect(location.hash), replace: true });
    },
  });
  const viewer = createRoute({
    getParentRoute: () => root,
    path: "/view/$artifactId",
    component: ViewerScreen,
    validateSearch: parseViewerSearch,
  });
  return createRouter({
    routeTree: root.addChildren([
      list,
      publish,
      detail,
      publishVersion,
      edit,
      versionHistory,
      profile,
      apps,
      usage,
      settings,
      account,
      viewer,
    ]),
    ...(history ? { history } : {}),
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}
