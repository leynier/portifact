// Test support for the dashboard: an in-memory /api/v1 and session endpoint behind the real
// API client, and a renderer with memory history. Only used by tests.
import {
  type AccessPolicyView,
  AccessUpdate,
  type ArtifactSummary,
  type BrowserSession,
  type ConnectedApp,
  type ErrorCode,
  LIMITS,
} from "@portifact/contracts";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { dashboardApi } from "./api.ts";
import { DashboardApp } from "./app.tsx";
import { createI18n } from "./i18n/i18n.ts";
import { createQueryClient } from "./query-client.ts";
import { createDashboardRouter } from "./router.tsx";

export const NOW = "2026-11-08T12:00:00.000Z";

export function artifact(id: string, overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id,
    name: `Artifact ${id}`,
    type: "site",
    state: "active",
    accessMode: "restricted",
    annotations: "off",
    currentVersionId: `v-${id}`,
    url: `https://${id}.portifact.dev/`,
    expiresAt: "2026-12-08T12:00:00.000Z",
    archivedAt: null,
    purgeAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Failure {
  status: number;
  code?: ErrorCode;
  /** Throw like a network failure instead of answering. */
  network?: boolean;
}

export function connectedApp(
  clientId: string,
  overrides: Partial<ConnectedApp> = {},
): ConnectedApp {
  return {
    clientId,
    name: "Portifact CLI",
    firstParty: true,
    resources: ["api"],
    scopes: ["artifacts:read", "offline_access"],
    approvedAt: "2026-11-01T12:00:00.000Z",
    lastIssuedAt: "2026-11-08T11:00:00.000Z",
    expiresAt: "2026-12-01T12:00:00.000Z",
    ...overrides,
  };
}

export function browserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    current: false,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    createdAt: "2026-11-01T12:00:00.000Z",
    lastActiveAt: "2026-11-08T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    ...overrides,
  };
}

export interface FakeServer {
  artifacts: ArtifactSummary[];
  email: string | null;
  /** When the account was created; null leaves it out of the session. */
  createdAt: string | null;
  /** Access policies by artifact ID; missing ones start from the artifact's mode. */
  access: Record<string, AccessPolicyView>;
  /** Linked providers, as /list-accounts answers them. */
  providers: { providerId: string; createdAt: string }[];
  sessions: BrowserSession[];
  apps: ConnectedApp[];
  /** JSON bodies of requests that sent one, in order. */
  bodies: unknown[];
  pageSize: number;
  requests: { method: string; path: string }[];
  /** The next `times` requests matching `method path` (path without query) fail. */
  fail(method: string, path: string, failure: Failure, times?: number): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** How many times the artifact list was requested. */
  listRequests(): number;
}

export function fakeServer(artifacts: ArtifactSummary[] = []): FakeServer {
  const failures: { key: string; failure: Failure; times: number }[] = [];
  const server: FakeServer = {
    artifacts,
    email: "ada@example.test",
    createdAt: "2026-09-01T12:00:00.000Z",
    access: {},
    providers: [],
    sessions: [browserSession({ current: true })],
    apps: [],
    bodies: [],
    pageSize: 50,
    requests: [],
    fail(method, path, failure, times = 1) {
      failures.push({ key: `${method} ${path}`, failure, times });
    },
    listRequests: () =>
      server.requests.filter(
        (r) => r.method === "GET" && /^\/api\/v1\/artifacts(\?|$)/.test(r.path),
      ).length,
    async fetch(input, init = {}) {
      const method = init.method ?? "GET";
      const url = new URL(input, "https://app.portifact.com");
      server.requests.push({ method, path: `${url.pathname}${url.search}` });
      if (typeof init.body === "string") server.bodies.push(JSON.parse(init.body));
      const failure = failures.find((f) => f.key === `${method} ${url.pathname}` && f.times > 0);
      if (failure) {
        failure.times -= 1;
        if (failure.failure.network) throw new TypeError("Failed to fetch");
        return Response.json(
          failure.failure.code ? { error: { code: failure.failure.code, message: "x" } } : {},
          { status: failure.failure.status },
        );
      }
      return route(server, method, url);
    },
  };
  return server;
}

function route(server: FakeServer, method: string, url: URL): Response {
  const path = url.pathname;
  if (path === "/api/auth/get-session") {
    return Response.json(
      server.email
        ? { user: { email: server.email, name: "Ada", createdAt: server.createdAt } }
        : null,
    );
  }
  if (path === "/api/auth/list-accounts") {
    return Response.json(server.providers.map((p, i) => ({ id: `acc${i}`, accountId: "1", ...p })));
  }
  if (path === "/api/v1/account/sessions" && method === "GET") {
    return Response.json({ items: server.sessions });
  }
  if (path === "/api/v1/account/sessions/sign-out-others" && method === "POST") {
    const before = server.sessions.length;
    server.sessions = server.sessions.filter((s) => s.current);
    return Response.json({ signedOut: before - server.sessions.length });
  }
  if (path === "/api/v1/account/apps" && method === "GET") {
    return Response.json({ items: server.apps });
  }
  const app = /^\/api\/v1\/account\/apps\/([^/]+)$/.exec(path);
  if (app && method === "DELETE") {
    const clientId = decodeURIComponent(app[1] ?? "");
    if (!server.apps.some((a) => a.clientId === clientId)) {
      return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    }
    server.apps = server.apps.filter((a) => a.clientId !== clientId);
    return Response.json({ clientId, disconnected: true });
  }
  const access = /^\/api\/v1\/artifacts\/([^/]+)\/access$/.exec(path);
  const owned = access && server.artifacts.find((a) => a.id === access[1]);
  if (access) {
    if (!owned)
      return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
    const policy = server.access[owned.id] ?? {
      mode: owned.accessMode,
      readers: [],
      indexable: false,
      embeddable: false,
      policyGeneration: 1,
    };
    server.access[owned.id] = policy;
    if (method === "GET") return Response.json(policy);
    return applyAccess(owned, policy, server.bodies.at(-1));
  }
  if (path === "/api/auth/sign-out" && method === "POST") return Response.json({ success: true });
  if (path === "/api/v1/artifacts" && method === "GET") {
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const items = server.artifacts.slice(start, start + server.pageSize);
    const next = start + server.pageSize;
    return Response.json({
      items,
      nextCursor: next < server.artifacts.length ? String(next) : null,
    });
  }
  const match = /^\/api\/v1\/artifacts\/([^/]+)(?:\/(renew|archive|restore))?$/.exec(path);
  const found = match && server.artifacts.find((a) => a.id === match[1]);
  if (!match || !found) {
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
  }
  if (method === "GET" && !match[2]) return Response.json(found);
  if (method === "DELETE" && !match[2]) {
    server.artifacts = server.artifacts.filter((a) => a !== found);
    return Response.json({ state: "deleted", expiresAt: null, purgeAt: null });
  }
  const action = match[2];
  if (action === "archive") {
    Object.assign(found, {
      state: "archived",
      archivedAt: NOW,
      purgeAt: "2027-05-08T12:00:00.000Z",
    });
  } else {
    Object.assign(found, {
      state: "active",
      archivedAt: null,
      purgeAt: null,
      expiresAt: "2027-01-07T12:00:00.000Z",
    });
  }
  return Response.json({ state: found.state, expiresAt: found.expiresAt, purgeAt: found.purgeAt });
}

/** What PATCH /access does in the Worker, minus the account-age rule. */
function applyAccess(artifact: ArtifactSummary, policy: AccessPolicyView, body: unknown): Response {
  const change = AccessUpdate.safeParse(body);
  if (!change.success) {
    return Response.json({ error: { code: "invalid_input", message: "x" } }, { status: 400 });
  }
  const { mode, indexable, embeddable, addReaders = [], removeReaders = [] } = change.data;
  const readers = new Set(policy.readers.filter((email) => !removeReaders.includes(email)));
  for (const email of addReaders) readers.add(email);
  if (readers.size > LIMITS.readersPerArtifact) {
    return Response.json({ error: { code: "quota_exceeded", message: "x" } }, { status: 429 });
  }
  Object.assign(policy, {
    mode: mode ?? policy.mode,
    indexable: indexable ?? policy.indexable,
    embeddable: embeddable ?? policy.embeddable,
    readers: [...readers].sort(),
    policyGeneration: policy.policyGeneration + 1,
  });
  artifact.accessMode = policy.mode;
  return Response.json(policy);
}

export function renderDashboard(path: string, server: FakeServer) {
  const left: string[] = [];
  const leave = (url: string) => {
    left.push(url);
  };
  const router = createDashboardRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = createQueryClient();
  const view = render(
    <DashboardApp
      env={{
        api: dashboardApi({
          fetch: (input, init) => server.fetch(input, init),
          onUnauthenticated: () => leave("unauthenticated"),
        }),
        leave,
      }}
      i18n={createI18n()}
      queryClient={queryClient}
      router={router}
    />,
  );
  return { ...view, left, router, queryClient };
}
