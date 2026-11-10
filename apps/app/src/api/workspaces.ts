// Workspaces at /api/v1 (premium plan T1). Reading the caller's own workspaces and role takes
// `artifacts:read` from a bearer token or the dashboard session, so the CLI and MCP show where
// artifacts live; it names no other person. The member list (every member's email), managing
// members and invitations, and accepting or declining an invitation answer only the dashboard's
// session, like the other account endpoints: they are account-level data and actions, and a
// membership widens who can read and manage an owner's artifacts, so no OAuth scope reaches them
// and an agent can never read the members or add or remove people (decision 0003 keeps
// account-level credentials out of scopes, except the CLI's narrow `credentials:manage`). The
// services decide every role.
import {
  ERROR_STATUS,
  type ErrorCode,
  IncomingInvitationList,
  InvitationCreate,
  InvitationId,
  InvitationList,
  InvitationLookup,
  InvitationTokenInput,
  InvitationView,
  MemberRoleUpdate,
  ServiceTokenCreate,
  ServiceTokenCreated,
  ServiceTokenId,
  ServiceTokenList,
  WORKSPACE_DOMAINS,
  WORKSPACE_GROUPS,
  WorkspaceDomainCreate,
  WorkspaceDomainId,
  WorkspaceDomainList,
  WorkspaceDomainView,
  WorkspaceGroupCreate,
  WorkspaceGroupDetail,
  WorkspaceGroupId,
  WorkspaceGroupList,
  WorkspaceGroupMemberAdd,
  WorkspaceGroupRename,
  WorkspaceGroupView,
  WorkspaceList,
  WorkspaceMemberList,
  WorkspaceMemberView,
  WorkspacePolicyPreviewInput,
  WorkspacePolicyUpdate,
  WorkspacePolicyView,
  WorkspaceSlug,
  WorkspaceView,
} from "@portifact/contracts";
import { domainRecord } from "@portifact/domain";
import { invitationEmail } from "@portifact/emails";
import {
  acceptInvitation,
  addGroupMember,
  addWorkspaceDomain,
  changeMemberRole,
  createServiceToken,
  createWorkspaceGroup,
  declineInvitation,
  deleteWorkspaceGroup,
  type EmailDomainDeps,
  type GroupList,
  type GroupMemberRow,
  type GroupRow,
  getWorkspaceGroup,
  getWorkspacePolicy,
  type InvitationKey,
  type InvitationRow,
  type InvitationSender,
  inviteMember,
  leaveWorkspace,
  listIncomingInvitations,
  listInvitations,
  listMembers,
  listServiceTokens,
  listUserWorkspaces,
  listWorkspaceDomains,
  listWorkspaceGroups,
  lookupInvitation,
  type MemberRow,
  type PolicyState,
  previewWorkspacePolicy,
  removeGroupMember,
  removeMember,
  removeWorkspaceDomain,
  renameWorkspaceGroup,
  revokeInvitation,
  revokeServiceToken,
  setWorkspacePolicy,
  type UserWorkspace,
  verifyWorkspaceDomain,
  type WorkspaceDomainRow,
} from "@portifact/services";
import { type Context, Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import type { EmailSender } from "../auth/email.ts";
import type { Env } from "../env.ts";
import { regionsOf } from "../regions.ts";
import { fromAppOrigin, hasSessionCookie, type SessionLookup } from "./access.ts";
import { type Guarded, iso, readJson } from "./http.ts";

type WorkspaceContext = Context<{ Bindings: Env }>;

function error(c: WorkspaceContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}

export function workspaceView(row: UserWorkspace): WorkspaceView {
  return WorkspaceView.parse({
    slug: row.slug,
    name: row.name,
    role: row.role,
    region: row.region,
    createdAt: iso(row.createdAt),
    policy: row.policy,
  });
}

function policyView(state: PolicyState): WorkspacePolicyView {
  return WorkspacePolicyView.parse(state);
}

export function workspaceListView(rows: UserWorkspace[]): WorkspaceList {
  return WorkspaceList.parse({ items: rows.map(workspaceView) });
}

function memberView(row: MemberRow, userId: string): WorkspaceMemberView {
  return WorkspaceMemberView.parse({
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    joinedAt: iso(row.joinedAt),
    you: row.userId === userId,
  });
}

/** A domain as admins see it: the record to publish, never another workspace's anything. */
export function domainView(row: WorkspaceDomainRow): WorkspaceDomainView {
  return WorkspaceDomainView.parse({
    id: row.id,
    domain: row.domain,
    unicode: row.display,
    state: row.state,
    record: domainRecord(row.domain, row.token),
    createdAt: iso(row.createdAt),
    verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
    checkedAt: row.checkedAt === null ? null : iso(row.checkedAt),
    expiresAt: row.state === "pending" ? iso(row.expiresAt) : null,
    failedChecks: row.failedChecks,
    problem: row.problem,
  });
}

/** The deployment's own hosts, which no workspace can verify as an email domain. */
function ownHosts(env: Env): string[] {
  return [new URL(env.APP_ORIGIN).hostname, env.CONTENT_DOMAIN];
}

function invitationView(row: InvitationRow): InvitationView {
  return InvitationView.parse({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  });
}

/**
 * Where the invitation email's link leads: the dashboard's invitation page with the token in the
 * fragment, which browsers never send, so it reaches no request line, log or `Referer`; the page
 * reads it once and removes it from the address bar.
 */
export function invitationUrl(appOrigin: string, token: string): string {
  return `${appOrigin}/invitations#${new URLSearchParams({ token })}`;
}

/** Sends invitation emails through the same sender as sign-in codes. */
export function invitationSender(
  env: Pick<Env, "APP_ORIGIN">,
  email: EmailSender,
): InvitationSender {
  return {
    async send(message) {
      await email.send({
        to: message.to,
        ...invitationEmail({
          email: message.to,
          inviterName: message.inviterName,
          workspaceName: message.workspaceName,
          role: message.role,
          acceptUrl: invitationUrl(env.APP_ORIGIN, message.token),
          expiresAt: message.expiresAt,
          locale: message.locale ?? undefined,
        }),
      });
    },
  };
}

export function groupView(row: GroupRow): WorkspaceGroupView {
  return WorkspaceGroupView.parse({
    id: row.id,
    name: row.name,
    members: row.members,
    createdAt: iso(row.createdAt),
  });
}

/** A workspace's groups: names and counts only, never members (decision 0014). */
export function groupListView(list: GroupList): WorkspaceGroupList {
  return WorkspaceGroupList.parse({
    items: list.groups.map(groupView),
    available: list.available,
    limit: WORKSPACE_GROUPS.perWorkspace,
  });
}

/** The read routes, behind the API's bearer-or-session gate. */
export function workspaceReadRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  now: () => number,
) {
  api.get(
    "/api/v1/workspaces",
    guarded("artifacts:read", async (c, userId) =>
      c.json(workspaceListView(await listUserWorkspaces(regionsOf(c.env).global, userId))),
    ),
  );
  // Group IDs, names and member counts, to use them in artifacts' access: admins and editors,
  // and a service token with `artifacts:share` (the service decides). Never the members.
  api.get(
    "/api/v1/workspaces/:slug/groups",
    guarded("artifacts:read", async (c, userId) => {
      const slug = WorkspaceSlug.safeParse(c.req.param("slug"));
      if (!slug.success) return error(c, "not_found", "Workspace not found.");
      const result = await listWorkspaceGroups(regionsOf(c.env).global, {
        userId,
        slug: slug.data,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(groupListView(result.value));
    }),
  );
}

export interface WorkspaceDeps {
  /** The dashboard session's user; a session without the current terms counts as none. */
  session(env: Env): SessionLookup;
  email(env: Env): EmailSender;
  /** DNS over HTTPS for email domain proofs; null answers `capacity_unavailable`. */
  dns(env: Env): EmailDomainDeps | null;
  now(): number;
}

/** The routes only the dashboard's session reaches. */
export function workspaceRoutes(deps: WorkspaceDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  const sessionOnly =
    (
      handler: (c: WorkspaceContext, userId: string) => Promise<Response>,
      refusal = "Managing members needs a dashboard session.",
    ) =>
    async (c: WorkspaceContext) => {
      c.header("Cache-Control", "no-store");
      const request = c.req.raw;
      if (request.headers.has("authorization")) {
        return error(c, "forbidden", refusal);
      }
      if (!hasSessionCookie(request.headers.get("cookie"))) {
        return error(c, "unauthenticated", "Sign in to manage workspaces.");
      }
      if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
        return error(c, "forbidden", "Cross-origin request refused.");
      }
      const userId = await deps.session(c.env)(request);
      if (!userId) return error(c, "unauthenticated", "Sign in to manage workspaces.");
      return handler(c, userId);
    };

  const slugOf = (c: WorkspaceContext) => {
    const slug = WorkspaceSlug.safeParse(c.req.param("slug"));
    return slug.success ? slug.data : null;
  };
  const global = (c: WorkspaceContext) => regionsOf(c.env).global;

  // Every member's name and email: account-level data, so only the dashboard's session reads it.
  routes.get(
    "/api/v1/workspaces/:slug/members",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await listMembers(global(c), { userId, slug, now: deps.now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        WorkspaceMemberList.parse({
          workspace: workspaceView(result.value.workspace),
          items: result.value.members.map((row) => memberView(row, userId)),
          seats: result.value.seats,
        }),
      );
    }),
  );

  routes.patch(
    "/api/v1/workspaces/:slug/members/:userId",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const body = await readJson(c, MemberRoleUpdate);
      if (!body.ok) return body.response;
      const result = await changeMemberRole(global(c), {
        userId,
        slug,
        memberId: c.req.param("userId") as string,
        role: body.value.role,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(memberView(result.value, userId));
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/members/:userId",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await removeMember(global(c), {
        userId,
        slug,
        memberId: c.req.param("userId") as string,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  // Service tokens (decision 0011): only admins, only from the dashboard session, so no bearer
  // token (a service token included) can mint, list or revoke them.
  const tokensOnly = (handler: (c: WorkspaceContext, userId: string) => Promise<Response>) =>
    sessionOnly(handler, "Service tokens are managed from the dashboard.");

  routes.get(
    "/api/v1/workspaces/:slug/service-tokens",
    tokensOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await listServiceTokens(global(c), { userId, slug, now: deps.now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(ServiceTokenList.parse(result.value));
    }),
  );

  // No idempotency key: a stored replay would keep the secret (decision 0011).
  routes.post(
    "/api/v1/workspaces/:slug/service-tokens",
    tokensOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const body = await readJson(c, ServiceTokenCreate);
      if (!body.ok) return body.response;
      const result = await createServiceToken(global(c), {
        userId,
        slug,
        body: body.value,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(ServiceTokenCreated.parse(result.value), 201);
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/service-tokens/:tokenId",
    tokensOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const tokenId = ServiceTokenId.safeParse(c.req.param("tokenId"));
      if (!tokenId.success) return error(c, "not_found", "Service token not found.");
      const result = await revokeServiceToken(global(c), {
        userId,
        slug,
        tokenId: tokenId.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  routes.post(
    "/api/v1/workspaces/:slug/leave",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await leaveWorkspace(global(c), { userId, slug, now: deps.now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  routes.get(
    "/api/v1/workspaces/:slug/invitations",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await listInvitations(global(c), { userId, slug, now: deps.now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        InvitationList.parse({
          items: result.value.items.map(invitationView),
          seats: result.value.seats,
        }),
      );
    }),
  );

  routes.post(
    "/api/v1/workspaces/:slug/invitations",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const body = await readJson(c, InvitationCreate);
      if (!body.ok) return body.response;
      const result = await inviteMember(
        global(c),
        { userId, slug, email: body.value.email, role: body.value.role, now: deps.now() },
        invitationSender(c.env, deps.email(c.env)),
      );
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(invitationView(result.value), 201);
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/invitations/:invitationId",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      const invitationId = InvitationId.safeParse(c.req.param("invitationId"));
      if (!slug || !invitationId.success) return error(c, "not_found", "Invitation not found.");
      const result = await revokeInvitation(global(c), {
        userId,
        slug,
        invitationId: invitationId.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  routes.get(
    "/api/v1/account/invitations",
    sessionOnly(async (c, userId) => {
      const rows = await listIncomingInvitations(global(c), { userId, now: deps.now() });
      return c.json(
        IncomingInvitationList.parse({
          items: rows.map((row) => ({ ...row, expiresAt: iso(row.expiresAt) })),
        }),
      );
    }),
  );

  const answer = (
    c: WorkspaceContext,
    userId: string,
    key: InvitationKey,
    decision: "accept" | "decline",
  ) =>
    (async () => {
      const input = { userId, key, now: deps.now() };
      if (decision === "decline") {
        const result = await declineInvitation(global(c), input);
        return result.ok ? c.body(null, 204) : error(c, result.code, result.message);
      }
      const result = await acceptInvitation(global(c), input);
      return result.ok
        ? c.json(workspaceView(result.value))
        : error(c, result.code, result.message);
    })();

  // The invitation page: what the link's token names, for the signed-in account. POST keeps the
  // token in the body, out of request lines and logs.
  routes.post(
    "/api/v1/invitations/lookup",
    sessionOnly(async (c, userId) => {
      const body = await readJson(c, InvitationTokenInput);
      if (!body.ok) return body.response;
      const result = await lookupInvitation(global(c), {
        userId,
        token: body.value.token,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      const standing = result.value;
      return c.json(
        InvitationLookup.parse(
          standing.status === "invited"
            ? {
                status: "invited",
                invitation: {
                  ...standing.invitation,
                  expiresAt: iso(standing.invitation.expiresAt),
                },
              }
            : standing,
        ),
      );
    }),
  );

  // Verified email domains (decision 0010): admins only, through the dashboard's session only,
  // like the members they widen.
  routes.get(
    "/api/v1/workspaces/:slug/domains",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const result = await listWorkspaceDomains(global(c), { userId, slug, now: deps.now() });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        WorkspaceDomainList.parse({
          items: result.value.domains.map(domainView),
          available: result.value.available,
          limit: WORKSPACE_DOMAINS.perWorkspace,
        }),
      );
    }),
  );

  routes.post(
    "/api/v1/workspaces/:slug/domains",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const body = await readJson(c, WorkspaceDomainCreate);
      if (!body.ok) return body.response;
      const result = await addWorkspaceDomain(global(c), {
        userId,
        slug,
        domain: body.value.domain,
        now: deps.now(),
        ownHosts: ownHosts(c.env),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(domainView(result.value), 201);
    }),
  );

  routes.post(
    "/api/v1/workspaces/:slug/domains/:domainId/verify",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      const id = WorkspaceDomainId.safeParse(c.req.param("domainId"));
      if (!slug) return error(c, "not_found", "Workspace not found.");
      if (!id.success) return error(c, "not_found", "Domain not found.");
      const dns = deps.dns(c.env);
      if (!dns) return error(c, "capacity_unavailable", "DNS checks are unavailable right now.");
      const result = await verifyWorkspaceDomain(global(c), dns, {
        userId,
        slug,
        domainId: id.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(domainView(result.value));
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/domains/:domainId",
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      const id = WorkspaceDomainId.safeParse(c.req.param("domainId"));
      if (!slug) return error(c, "not_found", "Workspace not found.");
      if (!id.success) return error(c, "not_found", "Domain not found.");
      const result = await removeWorkspaceDomain(global(c), {
        userId,
        slug,
        domainId: id.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json({ id: id.data, removed: true });
    }),
  );

  // Groups (decision 0014): admins manage them through the dashboard session only, like the
  // members they hold. Listing names and counts is the read route above.
  const detailView = (detail: { group: GroupRow; members: GroupMemberRow[] }) =>
    WorkspaceGroupDetail.parse({
      group: groupView(detail.group),
      items: detail.members.map((row) => ({ ...row, addedAt: iso(row.addedAt) })),
      limit: WORKSPACE_GROUPS.membersPerGroup,
    });
  /** Answers a service result: the error's status and body, or `done` with the value. */
  const reply = <T>(
    c: WorkspaceContext,
    result: { ok: true; value: T } | { ok: false; code: ErrorCode; message: string },
    done: (value: T) => Response,
  ) => (result.ok ? done(result.value) : error(c, result.code, result.message));
  /**
   * A group route: the session check, then the slug and (unless `list`) the group ID from the
   * path, each answering like a missing one when malformed.
   */
  const groupRoute = (
    handler: (
      c: WorkspaceContext,
      ids: { userId: string; slug: string; groupId: string },
    ) => Promise<Response>,
    list = false,
  ) =>
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      const groupId = list ? "" : WorkspaceGroupId.safeParse(c.req.param("groupId")).data;
      if (groupId === undefined) return error(c, "not_found", "Group not found.");
      return handler(c, { userId, slug, groupId });
    }, "Groups are managed from the dashboard.");

  routes.post(
    "/api/v1/workspaces/:slug/groups",
    groupRoute(async (c, { userId, slug }) => {
      const body = await readJson(c, WorkspaceGroupCreate);
      if (!body.ok) return body.response;
      const result = await createWorkspaceGroup(global(c), {
        userId,
        slug,
        name: body.value.name,
        now: deps.now(),
      });
      return reply(c, result, (group) => c.json(groupView(group), 201));
    }, true),
  );

  routes.get(
    "/api/v1/workspaces/:slug/groups/:groupId",
    groupRoute(async (c, ids) =>
      reply(c, await getWorkspaceGroup(global(c), ids), (detail) => c.json(detailView(detail))),
    ),
  );

  routes.patch(
    "/api/v1/workspaces/:slug/groups/:groupId",
    groupRoute(async (c, ids) => {
      const body = await readJson(c, WorkspaceGroupRename);
      if (!body.ok) return body.response;
      const result = await renameWorkspaceGroup(global(c), {
        ...ids,
        name: body.value.name,
        now: deps.now(),
      });
      return reply(c, result, (group) => c.json(groupView(group)));
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/groups/:groupId",
    groupRoute(async (c, ids) =>
      reply(c, await deleteWorkspaceGroup(global(c), { ...ids, now: deps.now() }), () =>
        c.body(null, 204),
      ),
    ),
  );

  routes.post(
    "/api/v1/workspaces/:slug/groups/:groupId/members",
    groupRoute(async (c, ids) => {
      const body = await readJson(c, WorkspaceGroupMemberAdd);
      if (!body.ok) return body.response;
      const input = { ...ids, memberId: body.value.userId, now: deps.now() };
      const added = await addGroupMember(global(c), input);
      if (!added.ok) return error(c, added.code, added.message);
      return reply(c, await getWorkspaceGroup(global(c), input), (detail) =>
        c.json(detailView(detail), 201),
      );
    }),
  );

  routes.delete(
    "/api/v1/workspaces/:slug/groups/:groupId/members/:userId",
    groupRoute(async (c, ids) => {
      const result = await removeGroupMember(global(c), {
        ...ids,
        memberId: c.req.param("userId") as string,
        now: deps.now(),
      });
      return reply(c, result, () => c.body(null, 204));
    }),
  );

  // Policies (decision 0015): every member reads them; only admins preview and change them, and
  // only from the dashboard's session, so no token (a service token included) can lift one.
  const policyRoute = (
    handler: (c: WorkspaceContext, ids: { userId: string; slug: string }) => Promise<Response>,
  ) =>
    sessionOnly(async (c, userId) => {
      const slug = slugOf(c);
      if (!slug) return error(c, "not_found", "Workspace not found.");
      return handler(c, { userId, slug });
    }, "Workspace policies are managed from the dashboard.");

  routes.get(
    "/api/v1/workspaces/:slug/policies",
    policyRoute(async (c, ids) =>
      reply(c, await getWorkspacePolicy(global(c), { ...ids, now: deps.now() }), (state) =>
        c.json(policyView(state)),
      ),
    ),
  );

  routes.post(
    "/api/v1/workspaces/:slug/policies/preview",
    policyRoute(async (c, ids) => {
      const body = await readJson(c, WorkspacePolicyPreviewInput);
      if (!body.ok) return body.response;
      const result = await previewWorkspacePolicy(regionsOf(c.env), {
        ...ids,
        policy: body.value.policy,
        now: deps.now(),
      });
      return reply(c, result, (impact) => c.json(impact));
    }),
  );

  routes.put(
    "/api/v1/workspaces/:slug/policies",
    policyRoute(async (c, ids) => {
      const body = await readJson(c, WorkspacePolicyUpdate);
      if (!body.ok) return body.response;
      const result = await setWorkspacePolicy(regionsOf(c.env), {
        ...ids,
        policy: body.value.policy,
        revision: body.value.revision,
        confirmed: body.value.confirmed,
        now: deps.now(),
      });
      return reply(c, result, (state) => c.json(policyView(state)));
    }),
  );

  for (const decision of ["accept", "decline"] as const) {
    // From the email's link: the token names the invitation.
    routes.post(
      `/api/v1/invitations/${decision}`,
      sessionOnly(async (c, userId) => {
        const body = await readJson(c, InvitationTokenInput);
        if (!body.ok) return body.response;
        return answer(c, userId, { token: body.value.token }, decision);
      }),
    );
    // From the invitee's own list.
    routes.post(
      `/api/v1/account/invitations/:invitationId/${decision}`,
      sessionOnly(async (c, userId) => {
        const id = InvitationId.safeParse(c.req.param("invitationId"));
        if (!id.success) return error(c, "not_found", "Invitation not found.");
        return answer(c, userId, { invitationId: id.data }, decision);
      }),
    );
  }

  return routes;
}
