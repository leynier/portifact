// What a person's OAuth token may still do while its account has not accepted the current terms
// (docs/legal.md, "API and MCP clients"), route by route and tool by tool. A new /api/v1 route
// that is not a GET, or a new MCP tool outside the read scopes, fails here until it is classified,
// like the plan gates' GATED tables:
// - `open`: only removes or ends something, runs without the current terms;
// - `narrowing`: runs, and its service refuses any change that does not only narrow;
// - `refused`: creates, publishes, widens, invites or sends, so it waits for the acceptance;
// - `ungated`: a person's token reaches it and it never asks (revoking the account's own tokens);
// - `no_person_token`: a person's OAuth token never reaches it (the dashboard session, a service,
//   SCIM or federation credential, or no credential at all).
import {
  ACCOUNT_SESSION_OPERATIONS,
  accountSessionUsableWithoutCurrentTerms,
  TERMS_EXEMPT_SCOPES,
  TERMS_OPEN_OPERATIONS,
} from "@portifact/domain";
import { describe, expect, it } from "vitest";
import { accountRoutes } from "../src/api/account.ts";
import {
  ACCOUNT_ROUTE_OPERATIONS,
  API_TERMS_OPERATIONS,
  apiTermsOperation,
} from "../src/api/terms-operations.ts";
import { createAppHost } from "../src/app-host.ts";
import { TOOL_SCOPES } from "../src/mcp/tools.ts";

type Class = "open" | "narrowing" | "refused" | "ungated" | "no_person_token";

const ROUTES: Record<string, Class> = {
  // Artifacts and publishing.
  "POST /api/v1/publishes": "refused",
  "POST /api/v1/publishes/:uploadId/parts": "refused",
  "POST /api/v1/publishes/:uploadId/commit": "refused",
  "DELETE /api/v1/publishes/:uploadId": "open",
  "POST /api/v1/documents/preview": "refused",
  "DELETE /api/v1/artifacts/:artifactId": "open",
  "POST /api/v1/artifacts/:artifactId/archive": "open",
  "POST /api/v1/artifacts/:artifactId/unpin": "open",
  "POST /api/v1/artifacts/:artifactId/pin": "refused",
  "POST /api/v1/artifacts/:artifactId/renew": "refused",
  "POST /api/v1/artifacts/:artifactId/restore": "refused",
  "POST /api/v1/artifacts/:artifactId/rollback": "refused",
  "POST /api/v1/artifacts/:artifactId/transfer": "refused",
  "PATCH /api/v1/artifacts/:artifactId/access": "narrowing",
  "POST /api/v1/artifacts/:artifactId/share-links": "refused",
  "DELETE /api/v1/artifacts/:artifactId/share-links/:linkId": "open",
  "POST /api/v1/artifacts/:artifactId/domain": "refused",
  "POST /api/v1/domains/:hostname/verify": "refused",
  "DELETE /api/v1/domains/:hostname": "open",
  // Comments and reviews.
  "POST /api/v1/artifacts/:artifactId/annotations/threads": "refused",
  "POST /api/v1/artifacts/:artifactId/annotations/threads/:threadId/messages": "refused",
  "POST /api/v1/artifacts/:artifactId/annotations/threads/:threadId/resolve": "refused",
  "POST /api/v1/artifacts/:artifactId/annotations/threads/:threadId/reopen": "refused",
  "POST /api/v1/artifacts/:artifactId/annotations/threads/:threadId/issue": "refused",
  "PATCH /api/v1/artifacts/:artifactId/annotations/messages/:messageId": "refused",
  "POST /api/v1/artifacts/:artifactId/annotations/messages/:messageId/moderation": "refused",
  "DELETE /api/v1/artifacts/:artifactId/annotations/messages/:messageId": "open",
  "DELETE /api/v1/artifacts/:artifactId/annotations/threads/:threadId": "open",
  "PUT /api/v1/artifacts/:artifactId/annotations/mode": "refused",
  // Artifact data (decision 0026): writes wait for the terms, deletes only remove.
  "POST /api/v1/artifacts/:artifactId/data/collections": "refused",
  "POST /api/v1/artifacts/:artifactId/data/indexes/build": "refused",
  "POST /api/v1/artifacts/:artifactId/data/collections/:collection/documents": "refused",
  "POST /api/v1/artifacts/:artifactId/data/collections/:collection/documents/bulk": "refused",
  "PUT /api/v1/artifacts/:artifactId/data/collections/:collection/documents/bulk": "refused",
  "POST /api/v1/artifacts/:artifactId/data/collections/:collection/documents/bulk-delete": "open",
  "PUT /api/v1/artifacts/:artifactId/data/collections/:collection/documents/:documentId": "refused",
  "DELETE /api/v1/artifacts/:artifactId/data/collections/:collection/documents/:documentId": "open",
  "POST /api/v1/artifacts/:artifactId/review/request": "refused",
  "PATCH /api/v1/artifacts/:artifactId/review/request": "refused",
  "DELETE /api/v1/artifacts/:artifactId/review/request": "open",
  "POST /api/v1/artifacts/:artifactId/review/verdict": "refused",
  // Edit suggestions (decision 0027): marking a change item acts anew; the rest is the viewer's.
  "PATCH /api/v1/artifacts/:artifactId/changes/:itemId": "refused",
  // Channels out of the account (the CLI's credentials:manage token).
  "POST /api/v1/webhooks": "refused",
  "PATCH /api/v1/webhooks/:webhookId": "narrowing",
  "DELETE /api/v1/webhooks/:webhookId": "open",
  "POST /api/v1/webhooks/:webhookId/test": "refused",
  "DELETE /api/v1/tokens/:clientId": "ungated",
  // The dashboard session only.
  "POST /api/v1/artifacts/:artifactId/review": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/review/tab": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/previews": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/suggestions": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/suggestions/:threadId/plan": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/suggestions/:threadId/accept": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/suggestions/:threadId/reject": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/suggestions/:threadId/withdraw": "no_person_token",
  "PUT /api/v1/artifacts/:artifactId/draft": "no_person_token",
  "DELETE /api/v1/artifacts/:artifactId/draft": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/draft/plan": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/draft/publish": "no_person_token",
  "POST /api/v1/artifacts/:artifactId/draft/rebase": "no_person_token",
  "PATCH /api/v1/account/settings": "no_person_token",
  "POST /api/v1/account/delete": "no_person_token",
  "POST /api/v1/account/deletion-code": "no_person_token",
  "POST /api/v1/account/delete-with-code": "no_person_token",
  "POST /api/v1/account/data-grants": "no_person_token",
  "DELETE /api/v1/account/data-grants/:artifactId": "no_person_token",
  "DELETE /api/v1/account/data-grants/:artifactId/documents/:collection/:id": "no_person_token",
  "POST /api/v1/account/data-grants/:artifactId/rights-request": "no_person_token",
  "POST /api/v1/account/sessions/sign-out-others": "no_person_token",
  "DELETE /api/v1/account/apps/:clientId": "no_person_token",
  "PUT /api/v1/account/branding": "no_person_token",
  "DELETE /api/v1/account/branding": "no_person_token",
  "PUT /api/v1/account/branding/logo": "no_person_token",
  "DELETE /api/v1/account/branding/logo": "no_person_token",
  "PUT /api/v1/account/comment-notices/:artifactId": "no_person_token",
  "POST /api/v1/account/invitations/:invitationId/accept": "no_person_token",
  "POST /api/v1/account/invitations/:invitationId/decline": "no_person_token",
  "POST /api/v1/audit/streams": "no_person_token",
  "PATCH /api/v1/audit/streams/:streamId": "no_person_token",
  "DELETE /api/v1/audit/streams/:streamId": "no_person_token",
  "POST /api/v1/audit/streams/:streamId/test": "no_person_token",
  "POST /api/v1/integrations/connections": "no_person_token",
  "PATCH /api/v1/integrations/connections/:connectionId": "no_person_token",
  "POST /api/v1/integrations/connections/:connectionId/test": "no_person_token",
  "DELETE /api/v1/integrations/connections/:connectionId": "no_person_token",
  "POST /api/v1/invitations/accept": "no_person_token",
  "POST /api/v1/invitations/decline": "no_person_token",
  "POST /api/v1/invitations/lookup": "no_person_token",
  "PATCH /api/v1/workspaces/:slug/members/:userId": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/members/:userId": "no_person_token",
  "POST /api/v1/workspaces/:slug/leave": "no_person_token",
  "POST /api/v1/workspaces/:slug/invitations": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/invitations/:invitationId": "no_person_token",
  "POST /api/v1/workspaces/:slug/service-tokens": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/service-tokens/:tokenId": "no_person_token",
  "POST /api/v1/workspaces/:slug/github-trust": "no_person_token",
  "PATCH /api/v1/workspaces/:slug/github-trust/:ruleId": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/github-trust/:ruleId": "no_person_token",
  "PATCH /api/v1/workspaces/:slug/scim": "no_person_token",
  "POST /api/v1/workspaces/:slug/scim/tokens": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/scim/tokens/:tokenId": "no_person_token",
  "POST /api/v1/workspaces/:slug/domains": "no_person_token",
  "POST /api/v1/workspaces/:slug/domains/:domainId/verify": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/domains/:domainId": "no_person_token",
  "PUT /api/v1/workspaces/:slug/sso": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/sso": "no_person_token",
  "POST /api/v1/workspaces/:slug/sso/test": "no_person_token",
  "POST /api/v1/workspaces/:slug/groups": "no_person_token",
  "PATCH /api/v1/workspaces/:slug/groups/:groupId": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/groups/:groupId": "no_person_token",
  "POST /api/v1/workspaces/:slug/groups/:groupId/stop-sync": "no_person_token",
  "POST /api/v1/workspaces/:slug/groups/:groupId/members": "no_person_token",
  "DELETE /api/v1/workspaces/:slug/groups/:groupId/members/:userId": "no_person_token",
  "POST /api/v1/workspaces/:slug/policies/preview": "no_person_token",
  "PUT /api/v1/workspaces/:slug/policies": "no_person_token",
  // Another credential, or none: GitHub's OIDC exchange, the unsubscribe link, abuse reports and
  // a share link's opening.
  "POST /api/v1/github/token": "no_person_token",
  "POST /api/v1/notices/unsubscribe": "no_person_token",
  "POST /api/v1/reports": "no_person_token",
  "POST /api/v1/share/open": "no_person_token",
};

/** Every MCP tool outside the read scopes. */
const TOOLS: Record<string, Class> = {
  publish_document: "refused",
  prepare_upload: "refused",
  get_upload_status: "refused",
  commit_upload: "refused",
  renew_artifact: "refused",
  archive_artifact: "open",
  restore_artifact: "refused",
  pin_artifact: "refused",
  unpin_artifact: "open",
  delete_artifact: "open",
  rollback_artifact: "refused",
  transfer_artifact: "refused",
  set_access: "narrowing",
  add_reader: "refused",
  remove_reader: "open",
  add_group: "refused",
  remove_group: "open",
  set_portifact_bar: "refused",
  set_comment_visibility: "narrowing",
  create_share_link: "refused",
  list_share_links: "open",
  revoke_share_link: "open",
  add_custom_domain: "refused",
  verify_custom_domain: "refused",
  remove_custom_domain: "open",
  create_annotation: "refused",
  reply_annotation: "refused",
  edit_annotation: "refused",
  resolve_annotation: "refused",
  reopen_annotation: "refused",
  delete_annotation: "open",
  moderate_annotation: "refused",
  delete_thread: "open",
  set_annotations: "refused",
  create_issue_from_thread: "refused",
  request_review: "refused",
  submit_review: "refused",
  declare_data_collection: "refused",
  build_data_indexes: "refused",
  create_data_document: "refused",
  replace_data_document: "refused",
  delete_data_document: "open",
  create_data_documents: "refused",
  replace_data_documents: "refused",
  delete_data_documents: "open",
  mark_change_item: "refused",
};

const KIND_OF: Record<"read" | "removes" | "narrowing", Class> = {
  read: "open",
  removes: "open",
  narrowing: "narrowing",
};

function liveRoutes(): Set<string> {
  const { app } = createAppHost(() => ({}) as never);
  const routes = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL" || !route.path.startsWith("/api/v1/")) continue;
    routes.add(`${route.method} ${route.path}`);
  }
  return routes;
}

const isRead = (scope: string) => (TERMS_EXEMPT_SCOPES as readonly string[]).includes(scope);

describe("classifying operations for accounts without the current terms", () => {
  it("covers every /api/v1 route that is not a GET, and nothing else", () => {
    const live = [...liveRoutes()].filter((route) => !route.startsWith("GET "));
    expect(
      live.filter((route) => !(route in ROUTES)),
      "unclassified routes",
    ).toEqual([]);
    expect(
      Object.keys(ROUTES).filter((route) => !live.includes(route)),
      "routes that no longer exist",
    ).toEqual([]);
  });

  it("names exactly the open and narrowing routes, as the domain rule classifies them", () => {
    for (const [route, expected] of Object.entries(ROUTES)) {
      const [method = "", path = ""] = route.split(" ");
      const operation = apiTermsOperation(method, path);
      const actual: Class =
        operation === null
          ? expected === "ungated" || expected === "no_person_token"
            ? expected
            : "refused"
          : KIND_OF[TERMS_OPEN_OPERATIONS[operation]];
      expect(actual, route).toBe(expected);
    }
    const live = liveRoutes();
    for (const route of Object.keys(API_TERMS_OPERATIONS))
      expect(live.has(route), route).toBe(true);
  });

  it("covers every MCP tool outside the read scopes, as the domain rule classifies them", () => {
    const writes = [...TOOL_SCOPES].filter(([, scope]) => !isRead(scope)).map(([name]) => name);
    expect(
      writes.filter((name) => !(name in TOOLS)),
      "unclassified tools",
    ).toEqual([]);
    expect(
      Object.keys(TOOLS).filter((name) => !writes.includes(name)),
      "stale tools",
    ).toEqual([]);
    for (const [name, expected] of Object.entries(TOOLS)) {
      const kind = TERMS_OPEN_OPERATIONS[name as keyof typeof TERMS_OPEN_OPERATIONS];
      expect(kind === undefined ? "refused" : KIND_OF[kind], name).toBe(expected);
    }
  });

  it("gives an API route and an MCP tool of the same operation the same class", () => {
    const toolNames = new Set(Object.keys(TOOLS));
    for (const [route, operation] of Object.entries(API_TERMS_OPERATIONS)) {
      const expected = ROUTES[route] ?? "open";
      if (toolNames.has(operation)) expect(TOOLS[operation], route).toBe(expected);
    }
    // Every open operation is reachable somewhere.
    const named = new Set([...Object.values(API_TERMS_OPERATIONS), ...toolNames]);
    for (const operation of Object.keys(TERMS_OPEN_OPERATIONS)) {
      expect(named.has(operation as never), operation).toBe(true);
    }
  });
});

/**
 * Every account route the dashboard session reaches (`accountRoutes`), and whether a session of
 * an account without the current terms may use it: the one rule is
 * `accountSessionUsableWithoutCurrentTerms` over `ACCOUNT_SESSION_OPERATIONS`; a route without a
 * name is refused (fail closed). A new account route fails here until it is named and classified.
 */
const ACCOUNT_ROUTES: Record<string, "open" | "refused"> = {
  "GET /api/v1/account/sessions": "open",
  "POST /api/v1/account/sessions/sign-out-others": "open",
  "GET /api/v1/account/apps": "open",
  "DELETE /api/v1/account/apps/:clientId": "open",
  "GET /api/v1/account/suspension": "open",
  "GET /api/v1/account/settings": "open",
  "PATCH /api/v1/account/settings": "open",
  "GET /api/v1/account/comment-notices/:artifactId": "open",
  "PUT /api/v1/account/comment-notices/:artifactId": "open",
  "GET /api/v1/account/branding": "open",
  "PUT /api/v1/account/branding": "refused",
  "DELETE /api/v1/account/branding": "open",
  "PUT /api/v1/account/branding/logo": "refused",
  "DELETE /api/v1/account/branding/logo": "open",
  "GET /api/v1/account/branding/logo": "open",
  "GET /api/v1/account/export": "open",
  "POST /api/v1/account/delete": "open",
  "POST /api/v1/account/deletion-code": "open",
  "POST /api/v1/account/delete-with-code": "open",
  "GET /api/v1/account/data-grants": "open",
  "GET /api/v1/account/data-grants/:artifactId/control": "open",
  "POST /api/v1/account/data-grants": "refused",
  "DELETE /api/v1/account/data-grants/:artifactId": "open",
  "GET /api/v1/account/data-grants/:artifactId/mine": "open",
  "GET /api/v1/account/data-grants/:artifactId": "open",
  "POST /api/v1/account/data-grants/:artifactId/rights-request": "open",
  "DELETE /api/v1/account/data-grants/:artifactId/documents/:collection/:id": "open",
};

describe("account routes for sessions without the current terms", () => {
  const live = () => {
    const routes = accountRoutes({
      session: () => async () => undefined,
      signOutOthers: () => async () => undefined,
      email: () => ({ send: async () => undefined }),
      now: () => 0,
    });
    return routes.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`);
  };

  it("names every account route as an operation, and nothing else", () => {
    const routes = live();
    expect(routes.filter((route) => !(route in ACCOUNT_ROUTE_OPERATIONS))).toEqual([]);
    expect(Object.keys(ACCOUNT_ROUTE_OPERATIONS).filter((r) => !routes.includes(r))).toEqual([]);
    expect(routes.filter((route) => !(route in ACCOUNT_ROUTES))).toEqual([]);
  });

  it("classifies each named operation in the domain rule", () => {
    for (const [route, operation] of Object.entries(ACCOUNT_ROUTE_OPERATIONS)) {
      expect(Object.hasOwn(ACCOUNT_SESSION_OPERATIONS, operation), route).toBe(true);
      expect(accountSessionUsableWithoutCurrentTerms(operation) ? "open" : "refused", route).toBe(
        ACCOUNT_ROUTES[route],
      );
    }
  });
});
