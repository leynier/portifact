// Client routes of the dashboard. The Worker serves the app for exactly these paths
// (DASHBOARD_ROUTES in apps/app/src/app-host.ts); keep both lists in sync.
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { ArtifactDetailScreen } from "./screens/artifact-detail.tsx";
import { ArtifactListScreen } from "./screens/artifact-list.tsx";
import { NotFoundScreen } from "./screens/not-found.tsx";
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
  return createRouter({
    routeTree: root.addChildren([list, detail]),
    ...(history ? { history } : {}),
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}
