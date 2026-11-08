// Client routes of the dashboard. The Worker serves the app for exactly these paths
// (DASHBOARD_ROUTES in apps/app/src/app-host.ts); keep both lists in sync.
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { AccountScreen } from "./screens/account.tsx";
import { ArtifactDetailScreen } from "./screens/artifact-detail.tsx";
import { ArtifactListScreen } from "./screens/artifact-list.tsx";
import { DocumentEditorScreen } from "./screens/document-editor.tsx";
import { HistoryScreen } from "./screens/history.tsx";
import { NotFoundScreen } from "./screens/not-found.tsx";
import { PublishScreen, PublishVersionScreen } from "./screens/publish.tsx";
import { ReviewScreen } from "./screens/review.tsx";
import { Shell } from "./screens/shell.tsx";

export function createDashboardRouter(history?: RouterHistory) {
  const root = createRootRoute({ component: Shell, notFoundComponent: NotFoundScreen });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: ArtifactListScreen,
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
  const account = createRoute({
    getParentRoute: () => root,
    path: "/account",
    component: AccountScreen,
  });
  const review = createRoute({
    getParentRoute: () => root,
    path: "/review/$artifactId",
    component: ReviewScreen,
  });
  return createRouter({
    routeTree: root.addChildren([
      list,
      publish,
      detail,
      publishVersion,
      edit,
      versionHistory,
      account,
      review,
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
