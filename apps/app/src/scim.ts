// SCIM 2.0 for a workspace's directory (premium plan E2, decision 0017): the protocol endpoints
// at `/scim/v2` on the app host, a thin adapter over packages/services. Reachable only with
// `SCIM_ENABLED="true"`; otherwise every path answers 404. Only a SCIM token (`pfsc_`)
// authenticates here: cookies are never read, and a service token or an OAuth token is refused
// like an unknown one. The token names the workspace, so one base URL serves every workspace and
// a resource ID of another workspace answers 404.
import { SCIM, SCIM_BASE_PATH, ScimUserId, WorkspaceGroupId } from "@portifact/contracts";
import {
  excludesMembers,
  parseScimFilter,
  parseScimGroup,
  parseScimGroupFilter,
  parseScimUser,
  type ScimError,
  type ScimGroupRecord,
  type ScimResult,
  scimErrorBody,
  scimGroupResource,
  scimListResponse,
  scimPage,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
  scimUserResource,
} from "@portifact/domain";
import {
  authenticateScimToken,
  createScimGroup,
  createScimUser,
  deleteScimGroup,
  deleteScimUser,
  getScimGroup,
  getScimUser,
  hitScimAuthFailure,
  hitScimRateLimit,
  type InvitationSender,
  listScimGroups,
  listScimUsers,
  patchScimGroup,
  patchScimUser,
  replaceScimGroup,
  replaceScimUser,
  type ScimCaller,
  type ScimWrite,
} from "@portifact/services";
import { type Context, Hono } from "hono";
import { authUrls } from "./auth/config.ts";
import type { Env } from "./env.ts";
import { regionsOf } from "./regions.ts";

/** Whether the app Worker offers SCIM: exactly `"true"`, set only after the release checks. */
export function scimEnabled(env: Pick<Env, "SCIM_ENABLED">): boolean {
  return env.SCIM_ENABLED === "true";
}

/** What an admin pastes into the directory as its base (Okta) or tenant (Entra) URL. */
export function scimBaseUrl(env: Pick<Env, "APP_ORIGIN">): string {
  return `${authUrls(env.APP_ORIGIN).origin}${SCIM_BASE_PATH}`;
}

export interface ScimRouteDeps {
  /** Ends every session of an account through Better Auth, so its hooks run. */
  endSessions(env: Env): (userId: string) => Promise<void>;
  /** Sends the invitation email when the workspace turned it on. */
  invitations(env: Env): InvitationSender;
  now(): number;
}

type ScimEnv = { Bindings: Env; Variables: { caller: ScimCaller } };
type ScimContext = Context<ScimEnv>;

const CONTENT_TYPE = "application/scim+json; charset=utf-8";

function reply(c: ScimContext, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return c.body(JSON.stringify(body), status as 200, {
    "Content-Type": CONTENT_TYPE,
    "Cache-Control": "no-store",
    ...headers,
  });
}

function refuse(c: ScimContext, error: ScimError, headers: Record<string, string> = {}) {
  return reply(c, scimErrorBody(error), error.status, headers);
}

const UNAUTHENTICATED: ScimError = {
  status: 401,
  detail: "Send a valid SCIM token as a bearer token.",
};

/**
 * Reads a JSON body of at most `SCIM.maxBodyBytes`. Directories send `application/scim+json`
 * (RFC 7644, section 3.1) and some send `application/json`; both are read.
 */
async function readBody(c: ScimContext): Promise<ScimResult<unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/(scim\+)?json\b/i.test(type.trim())) {
    return {
      ok: false,
      error: { status: 400, scimType: "invalidSyntax", detail: "Send application/scim+json." },
    };
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  const tooLarge: ScimError = {
    status: 413,
    detail: `The body can be at most ${SCIM.maxBodyBytes} bytes.`,
  };
  if (declared > SCIM.maxBodyBytes) return { ok: false, error: tooLarge };
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > SCIM.maxBodyBytes)
    return { ok: false, error: tooLarge };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      error: { status: 400, scimType: "invalidSyntax", detail: "The body is not valid JSON." },
    };
  }
}

export function scimRoutes(deps: ScimRouteDeps) {
  const routes = new Hono<ScimEnv>();
  const global = (c: ScimContext) => regionsOf(c.env).global;
  const base = (c: ScimContext) => scimBaseUrl(c.env);

  routes.use(`${SCIM_BASE_PATH}/*`, async (c, next) => {
    // Switched off: the paths do not exist.
    if (!scimEnabled(c.env)) {
      return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    }
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    const challenge = { "WWW-Authenticate": 'Bearer realm="SCIM"' };
    const now = deps.now();
    // A failed authentication is counted per IP; past the bound the answer is 429 (decision 0017).
    const failed = async (error: ScimError) => {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      const { limited } = await hitScimAuthFailure(global(c), ip, now);
      if (limited) {
        return refuse(
          c,
          { status: 429, detail: "Too many failed authentications. Retry later." },
          { "Retry-After": String(SCIM.failedAuthPerIp.windowSeconds) },
        );
      }
      return refuse(c, error, challenge);
    };
    if (!match?.[1]) return failed(UNAUTHENTICATED);
    const auth = await authenticateScimToken(global(c), match[1], now);
    if (!auth.ok) {
      if (auth.reason === "plan") return refuse(c, { status: 403, detail: auth.message });
      return failed(
        auth.reason === "expired"
          ? { status: 401, detail: "This SCIM token expired. Create a new one in Portifact." }
          : UNAUTHENTICATED,
      );
    }
    const caller = { tokenId: auth.tokenId, workspaceId: auth.workspaceId };
    if (!(await hitScimRateLimit(global(c), caller, now))) {
      return refuse(
        c,
        { status: 429, detail: "Too many requests. Retry in a minute." },
        {
          "Retry-After": "60",
        },
      );
    }
    c.set("caller", caller);
    await next();
  });

  routes.get(`${SCIM_BASE_PATH}/ServiceProviderConfig`, (c) =>
    reply(c, scimServiceProviderConfig(base(c))),
  );
  routes.get(`${SCIM_BASE_PATH}/ResourceTypes`, (c) => {
    const types = scimResourceTypes(base(c));
    return reply(c, scimListResponse(types, types.length, 1));
  });
  routes.get(`${SCIM_BASE_PATH}/ResourceTypes/:id`, (c) => {
    const found = scimResourceTypes(base(c)).find((type) => type.id === c.req.param("id"));
    return found ? reply(c, found) : refuse(c, { status: 404, detail: "Resource not found." });
  });
  routes.get(`${SCIM_BASE_PATH}/Schemas`, (c) => {
    const schemas = scimSchemas(base(c));
    return reply(c, scimListResponse(schemas, schemas.length, 1));
  });
  routes.get(`${SCIM_BASE_PATH}/Schemas/:id`, (c) => {
    const found = scimSchemas(base(c)).find((schema) => schema.id === c.req.param("id"));
    return found ? reply(c, found) : refuse(c, { status: 404, detail: "Resource not found." });
  });

  const userId = (c: ScimContext) => {
    const id = ScimUserId.safeParse(c.req.param("id"));
    return id.success ? id.data : null;
  };
  const notFound = (c: ScimContext) => refuse(c, { status: 404, detail: "Resource not found." });

  /** The service ends the removed person's sessions; a failure is its 503, and a retry ends them. */
  const answerWrite = (c: ScimContext, result: ScimResult<ScimWrite>, created = false) => {
    if (!result.ok) return refuse(c, result.error);
    const resource = scimUserResource(result.value.user, base(c));
    return created
      ? reply(c, resource, 201, { Location: resource.meta.location })
      : reply(c, resource);
  };
  const writeDeps = (c: ScimContext) => ({
    sender: deps.invitations(c.env),
    endSessions: deps.endSessions(c.env),
  });

  routes.get(`${SCIM_BASE_PATH}/Users`, async (c) => {
    const page = scimPage(c.req.query("startIndex"), c.req.query("count"));
    if (!page.ok) return refuse(c, page.error);
    const rawFilter = c.req.query("filter");
    let filter = null;
    if (rawFilter !== undefined && rawFilter.trim() !== "") {
      const parsed = parseScimFilter(rawFilter);
      if (!parsed.ok) return refuse(c, parsed.error);
      filter = parsed.value;
    }
    const listed = await listScimUsers(global(c), c.get("caller"), { filter, ...page.value });
    return reply(
      c,
      scimListResponse(
        listed.users.map((user) => scimUserResource(user, base(c))),
        listed.total,
        page.value.startIndex,
      ),
    );
  });

  routes.get(`${SCIM_BASE_PATH}/Users/:id`, async (c) => {
    const id = userId(c);
    if (!id) return notFound(c);
    const found = await getScimUser(global(c), c.get("caller"), id);
    return found.ok ? reply(c, scimUserResource(found.value, base(c))) : refuse(c, found.error);
  });

  routes.post(`${SCIM_BASE_PATH}/Users`, async (c) => {
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    const input = parseScimUser(body.value);
    if (!input.ok) return refuse(c, input.error);
    const result = await createScimUser(
      global(c),
      writeDeps(c),
      c.get("caller"),
      input.value,
      deps.now(),
    );
    return answerWrite(c, result, true);
  });

  routes.put(`${SCIM_BASE_PATH}/Users/:id`, async (c) => {
    const id = userId(c);
    if (!id) return notFound(c);
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    const input = parseScimUser(body.value);
    if (!input.ok) return refuse(c, input.error);
    const result = await replaceScimUser(
      global(c),
      writeDeps(c),
      c.get("caller"),
      id,
      input.value,
      deps.now(),
    );
    return answerWrite(c, result);
  });

  routes.patch(`${SCIM_BASE_PATH}/Users/:id`, async (c) => {
    const id = userId(c);
    if (!id) return notFound(c);
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    const result = await patchScimUser(
      global(c),
      writeDeps(c),
      c.get("caller"),
      id,
      body.value,
      deps.now(),
    );
    return answerWrite(c, result);
  });

  routes.delete(`${SCIM_BASE_PATH}/Users/:id`, async (c) => {
    const id = userId(c);
    if (!id) return notFound(c);
    const result = await deleteScimUser(
      global(c),
      c.get("caller"),
      id,
      deps.now(),
      deps.endSessions(c.env),
    );
    if (!result.ok) return refuse(c, result.error);
    return c.body(null, 204, { "Cache-Control": "no-store" });
  });

  // Groups (decision 0017, "Groups and roles"): this workspace's directory-managed groups only.
  const groupId = (c: ScimContext) => {
    const id = WorkspaceGroupId.safeParse(c.req.param("id"));
    return id.success ? id.data : null;
  };
  const groupReply = (c: ScimContext, result: ScimResult<ScimGroupRecord>, status = 200) => {
    if (!result.ok) return refuse(c, result.error);
    const resource = scimGroupResource(result.value, base(c));
    return reply(c, resource, status, status === 201 ? { Location: resource.meta.location } : {});
  };

  routes.get(`${SCIM_BASE_PATH}/Groups`, async (c) => {
    const page = scimPage(c.req.query("startIndex"), c.req.query("count"));
    if (!page.ok) return refuse(c, page.error);
    const rawFilter = c.req.query("filter");
    let filter = null;
    if (rawFilter !== undefined && rawFilter.trim() !== "") {
      const parsed = parseScimGroupFilter(rawFilter);
      if (!parsed.ok) return refuse(c, parsed.error);
      filter = parsed.value;
    }
    const members = !excludesMembers(c.req.query("excludedAttributes"));
    const listed = await listScimGroups(global(c), c.get("caller"), {
      filter,
      ...page.value,
      members,
    });
    return reply(
      c,
      scimListResponse(
        listed.groups.map((group) => scimGroupResource(group, base(c), members)),
        listed.total,
        page.value.startIndex,
      ),
    );
  });

  routes.get(`${SCIM_BASE_PATH}/Groups/:id`, async (c) => {
    const id = groupId(c);
    if (!id) return notFound(c);
    const found = await getScimGroup(global(c), c.get("caller"), id);
    if (!found.ok) return refuse(c, found.error);
    const members = !excludesMembers(c.req.query("excludedAttributes"));
    return reply(c, scimGroupResource(found.value, base(c), members));
  });

  routes.post(`${SCIM_BASE_PATH}/Groups`, async (c) => {
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    const input = parseScimGroup(body.value);
    if (!input.ok) return refuse(c, input.error);
    return groupReply(
      c,
      await createScimGroup(global(c), c.get("caller"), input.value, deps.now()),
      201,
    );
  });

  routes.put(`${SCIM_BASE_PATH}/Groups/:id`, async (c) => {
    const id = groupId(c);
    if (!id) return notFound(c);
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    const input = parseScimGroup(body.value);
    if (!input.ok) return refuse(c, input.error);
    return groupReply(
      c,
      await replaceScimGroup(global(c), c.get("caller"), id, input.value, deps.now()),
    );
  });

  routes.patch(`${SCIM_BASE_PATH}/Groups/:id`, async (c) => {
    const id = groupId(c);
    if (!id) return notFound(c);
    const body = await readBody(c);
    if (!body.ok) return refuse(c, body.error);
    return groupReply(
      c,
      await patchScimGroup(global(c), c.get("caller"), id, body.value, deps.now()),
    );
  });

  routes.delete(`${SCIM_BASE_PATH}/Groups/:id`, async (c) => {
    const id = groupId(c);
    if (!id) return notFound(c);
    const result = await deleteScimGroup(global(c), c.get("caller"), id, deps.now());
    if (!result.ok) return refuse(c, result.error);
    return c.body(null, 204, { "Cache-Control": "no-store" });
  });

  // Bulk, Me and anything else: not served (decision 0017).
  routes.all(`${SCIM_BASE_PATH}/*`, (c) => notFound(c));

  return routes;
}
