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
  WorkspaceList,
  WorkspaceMemberList,
  WorkspaceMemberView,
  WorkspaceSlug,
  WorkspaceView,
} from "@portifact/contracts";
import { invitationEmail } from "@portifact/emails";
import {
  acceptInvitation,
  changeMemberRole,
  declineInvitation,
  type InvitationKey,
  type InvitationRow,
  type InvitationSender,
  inviteMember,
  leaveWorkspace,
  listIncomingInvitations,
  listInvitations,
  listMembers,
  listUserWorkspaces,
  lookupInvitation,
  type MemberRow,
  removeMember,
  revokeInvitation,
  type UserWorkspace,
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
  });
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

/** The read routes, behind the API's bearer-or-session gate. */
export function workspaceReadRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded) {
  api.get(
    "/api/v1/workspaces",
    guarded("artifacts:read", async (c, userId) =>
      c.json(workspaceListView(await listUserWorkspaces(regionsOf(c.env).global, userId))),
    ),
  );
}

export interface WorkspaceDeps {
  /** The dashboard session's user; a session without the current terms counts as none. */
  session(env: Env): SessionLookup;
  email(env: Env): EmailSender;
  now(): number;
}

/** The routes only the dashboard's session reaches. */
export function workspaceRoutes(deps: WorkspaceDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  const sessionOnly =
    (handler: (c: WorkspaceContext, userId: string) => Promise<Response>) =>
    async (c: WorkspaceContext) => {
      c.header("Cache-Control", "no-store");
      const request = c.req.raw;
      if (request.headers.has("authorization")) {
        return error(c, "forbidden", "Managing members needs a dashboard session.");
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
      const result = await leaveWorkspace(global(c), { userId, slug });
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
