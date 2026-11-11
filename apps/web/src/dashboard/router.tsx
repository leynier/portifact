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
  retainSearchParams,
  useMatch,
} from "@tanstack/react-router";
import { AppsScreen } from "./screens/apps.tsx";
import { ArtifactDetailScreen } from "./screens/artifact-detail.tsx";
import { ArtifactListScreen, parseListSearch } from "./screens/artifact-list.tsx";
import { AuditScreen } from "./screens/audit.tsx";
import { BrandingScreen } from "./screens/branding.tsx";
import { DocumentEditorScreen } from "./screens/document-editor.tsx";
import { DownloadDataScreen } from "./screens/download-data.tsx";
import { GroupsScreen } from "./screens/groups.tsx";
import { HistoryScreen } from "./screens/history.tsx";
import { IntegrationsScreen } from "./screens/integrations.tsx";
import { InvitationFrame, InvitationScreen } from "./screens/invitations.tsx";
import { MembersScreen } from "./screens/members.tsx";
import { NotFoundScreen } from "./screens/not-found.tsx";
import { PlanScreen } from "./screens/plan.tsx";
import { PoliciesScreen } from "./screens/policies.tsx";
import { ProfileScreen } from "./screens/profile.tsx";
import { PublishScreen, PublishVersionScreen } from "./screens/publish.tsx";
import { ServiceTokensScreen } from "./screens/service-tokens.tsx";
import { SettingsScreen } from "./screens/settings.tsx";
import { Shell } from "./screens/shell.tsx";
import { UsageScreen } from "./screens/usage.tsx";
import { parseViewerSearch, ViewerScreen } from "./screens/viewer.tsx";
import { WebhooksScreen } from "./screens/webhooks.tsx";
import { parseSpaceSearch } from "./space.tsx";

/**
 * Every dashboard screen sits in the shell (navigation and account); the viewer draws its own
 * frame, the Portifact bar, so it fills the screen, and the invitation page has its own frame
 * while signed out.
 */
function Frame() {
  const viewer = useMatch({ from: "/view/$artifactId", shouldThrow: false });
  const invitation = useMatch({ from: "/invitations", shouldThrow: false });
  if (viewer) return <Outlet />;
  if (invitation) return <InvitationFrame />;
  return <Shell />;
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
  // `?workspace=<slug>` names the space on every route and stays on every link (space.tsx).
  const root = createRootRoute({
    component: Frame,
    notFoundComponent: NotFoundScreen,
    validateSearch: parseSpaceSearch,
    search: { middlewares: [retainSearchParams(["workspace"])] },
  });
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
  const plan = createRoute({
    getParentRoute: () => root,
    path: "/plan",
    component: PlanScreen,
  });
  const data = createRoute({
    getParentRoute: () => root,
    path: "/data",
    component: DownloadDataScreen,
  });
  const webhooks = createRoute({
    getParentRoute: () => root,
    path: "/webhooks",
    component: WebhooksScreen,
  });
  const integrations = createRoute({
    getParentRoute: () => root,
    path: "/integrations",
    component: IntegrationsScreen,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: SettingsScreen,
  });
  const branding = createRoute({
    getParentRoute: () => root,
    path: "/branding",
    component: BrandingScreen,
  });
  const audit = createRoute({
    getParentRoute: () => root,
    path: "/audit",
    component: AuditScreen,
  });
  const members = createRoute({
    getParentRoute: () => root,
    path: "/members",
    component: MembersScreen,
  });
  const groups = createRoute({
    getParentRoute: () => root,
    path: "/groups",
    component: GroupsScreen,
  });
  const policies = createRoute({
    getParentRoute: () => root,
    path: "/policies",
    component: PoliciesScreen,
  });
  const serviceTokens = createRoute({
    getParentRoute: () => root,
    path: "/service-tokens",
    component: ServiceTokensScreen,
  });
  const invitations = createRoute({
    getParentRoute: () => root,
    path: "/invitations",
    component: InvitationScreen,
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
      plan,
      data,
      webhooks,
      integrations,
      branding,
      settings,
      members,
      groups,
      policies,
      audit,
      serviceTokens,
      invitations,
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
