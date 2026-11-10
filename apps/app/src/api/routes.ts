// The publishing and artifact API under /api/v1 (plan sections 6 and 9). Each route checks the
// token for the API resource and one scope, validates input with the shared contracts and calls
// a service; the acting user always comes from the token. Business rules stay in services.
import {
  AccessPolicyView,
  AccessUpdate,
  ArtifactList,
  ArtifactListQuery,
  ArtifactSummary,
  CommittedPublish,
  type ErrorCode,
  LifecycleResult,
  type OAuthScope,
  PublishRequest,
  UploadedPart,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import type { MultipartConfig } from "@portifact/domain";
import {
  type ArtifactRow,
  abortPublish,
  archiveArtifact,
  commitPublish,
  deleteArtifact,
  getAccess,
  getArtifact,
  type LifecycleOutcome,
  listArtifacts,
  renewArtifact,
  reportUploadedPart,
  restoreArtifact,
  updateAccess,
  uploadProgress,
} from "@portifact/services";
import { Hono } from "hono";
import type { FetchLike } from "../auth/deps.ts";
import type { Introspect, ProtectedResource } from "../auth/resource.ts";
import type { Env } from "../env.ts";
import { artifactListItem } from "../mcp/present.ts";
import { artifactDb, defaultDb, personalScope } from "../regions.ts";
import { authorizeApiRequest, type SessionLookup } from "./access.ts";
import { accessLogRoutes } from "./access-log.ts";
import { annotationRoutes } from "./annotations.ts";
import { documentRoutes } from "./documents.ts";
import { type ApiContext, error, type Guarded, idempotent, iso, readJson } from "./http.ts";
import type { Presigner } from "./presign.ts";
import { shareLinkRoutes } from "./share-links.ts";
import { preparedPublish, prepareUpload } from "./uploads.ts";
import { usageRoutes } from "./usage.ts";
import { versionRoutes } from "./versions.ts";

export interface ApiDeps {
  introspect(env: Env): Introspect;
  resource(env: Env): ProtectedResource;
  /** The dashboard's session cookie, accepted from the app origin only (./access.ts). */
  session(env: Env): SessionLookup;
  presigner(env: Env): Presigner;
  /** Turnstile's siteverify transport, for the human check of new comments. */
  siteverify(env: Env): FetchLike;
  now(): number;
  /** Threshold and part size of multipart uploads; undefined for the defaults. */
  multipart?(env: Env): MultipartConfig | undefined;
}

export function apiRoutes(deps: ApiDeps) {
  const api = new Hono<{ Bindings: Env }>();

  api.use("/api/v1/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  /**
   * Runs `handler` for the calling user when the bearer token or the dashboard session allows
   * `scope` at the API. Route patterns guarantee their params, so handlers read them with
   * `as string`.
   */
  const guarded: Guarded = (scope, handler) => async (c: ApiContext) => {
    const decision = await authorizeApiRequest(
      {
        introspect: deps.introspect(c.env),
        resource: deps.resource(c.env),
        session: deps.session(c.env),
      },
      c.req.raw,
      scope,
    );
    return decision.ok ? handler(c, decision.userId) : decision.response;
  };

  api.post(
    "/api/v1/publishes",
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, PublishRequest);
      if (!body.ok) return body.response;
      const db = body.value.artifactId
        ? await artifactDb(c.env, body.value.artifactId)
        : (await personalScope(c.env, userId)).db;
      const now = deps.now();
      return idempotent(c, { userId, operation: "publish.prepare", request: body.value, now }, () =>
        prepareUpload(
          db,
          {
            bucket: c.env.ARTIFACTS,
            presigner: deps.presigner(c.env),
            multipart: deps.multipart?.(c.env),
          },
          userId,
          body.value,
          now,
        ),
      );
    }),
  );

  // Progress of an open upload, with fresh URLs for the objects still to send.
  api.get(
    "/api/v1/publishes/:uploadId",
    guarded("artifacts:write", async (c, userId) => {
      const now = deps.now();
      const result = await uploadProgress(defaultDb(c.env), {
        userId,
        sessionId: c.req.param("uploadId") as string,
        now,
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(await preparedPublish(deps.presigner(c.env), result.value, now));
    }),
  );

  // A part of a multipart object reached storage; its ETag lets the commit assemble the object.
  api.post(
    "/api/v1/publishes/:uploadId/parts",
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, UploadedPart);
      if (!body.ok) return body.response;
      const result = await reportUploadedPart(defaultDb(c.env), {
        userId,
        sessionId: c.req.param("uploadId") as string,
        ...body.value,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  api.post(
    "/api/v1/publishes/:uploadId/commit",
    guarded("artifacts:write", async (c, userId) => {
      const result = await commitPublish(defaultDb(c.env), c.env.ARTIFACTS, {
        userId,
        sessionId: c.req.param("uploadId") as string,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        CommittedPublish.parse({
          artifactId: result.value.artifactId,
          versionId: result.value.versionId,
          versionNumber: result.value.versionNumber,
          url: contentUrl(c.env, result.value.artifactId),
          expiresAt: iso(result.value.expiresAt),
        }),
      );
    }),
  );

  api.delete(
    "/api/v1/publishes/:uploadId",
    guarded("artifacts:write", async (c, userId) => {
      const result = await abortPublish(defaultDb(c.env), {
        userId,
        sessionId: c.req.param("uploadId") as string,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  api.get(
    "/api/v1/artifacts",
    guarded("artifacts:read", async (c, userId) => {
      // An empty parameter means no filter, as an empty search box would send it.
      const param = (name: string) => c.req.query(name) || undefined;
      const query = ArtifactListQuery.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        search: param("search"),
        state: param("state"),
        type: param("type"),
        access: param("access"),
        annotations: param("annotations"),
      });
      if (!query.success) {
        return error(
          c,
          "invalid_input",
          "Invalid cursor, limit, search, state, type, access or annotations.",
        );
      }
      const { cursor, limit, ...filters } = query.data;
      const { actor, db } = await personalScope(c.env, userId);
      const page = await listArtifacts(db, { actor, cursor, limit, filters, now: deps.now() });
      if (!page.ok) return error(c, page.code, page.message);
      return c.json(
        ArtifactList.parse({
          items: page.value.items.map((row) => artifactListItem(c.env, row)),
          nextCursor: page.value.nextCursor,
        }),
      );
    }),
  );

  api.get(
    "/api/v1/artifacts/:artifactId",
    guarded("artifacts:read", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const row = await getArtifact(await artifactDb(c.env, artifactId), { userId, artifactId });
      if (!row.ok) return error(c, row.code, row.message);
      return c.json(summary(c.env, row.value));
    }),
  );

  api.get(
    "/api/v1/artifacts/:artifactId/access",
    guarded("artifacts:read", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await getAccess(await artifactDb(c.env, artifactId), { userId, artifactId });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AccessPolicyView.parse(result.value));
    }),
  );

  // Setting the same change twice leaves the same policy, so no idempotency key is needed.
  api.patch(
    "/api/v1/artifacts/:artifactId/access",
    guarded("artifacts:share", async (c, userId) => {
      const body = await readJson(c, AccessUpdate);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const result = await updateAccess(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        change: body.value,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AccessPolicyView.parse(result.value));
    }),
  );

  const lifecycle = (
    action: (
      db: RegionalDb,
      bucket: R2Bucket,
      input: { userId: string; artifactId: string; now: number },
    ) => Promise<
      { ok: true; value: LifecycleOutcome } | { ok: false; code: ErrorCode; message: string }
    >,
    scope: OAuthScope,
  ) =>
    guarded(scope, async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await action(await artifactDb(c.env, artifactId), c.env.ARTIFACTS, {
        userId,
        artifactId,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        LifecycleResult.parse({
          state: result.value.state,
          expiresAt: result.value.expiresAt === null ? null : iso(result.value.expiresAt),
          purgeAt: result.value.purgeAt === null ? null : iso(result.value.purgeAt),
        }),
      );
    });

  api.post(
    "/api/v1/artifacts/:artifactId/renew",
    lifecycle((db, _b, i) => renewArtifact(db, i), "artifacts:write"),
  );
  api.post(
    "/api/v1/artifacts/:artifactId/archive",
    lifecycle((db, _b, i) => archiveArtifact(db, i), "artifacts:write"),
  );
  api.post(
    "/api/v1/artifacts/:artifactId/restore",
    lifecycle((db, _b, i) => restoreArtifact(db, i), "artifacts:write"),
  );
  api.delete("/api/v1/artifacts/:artifactId", lifecycle(deleteArtifact, "artifacts:delete"));

  api.route("/", annotationRoutes(guarded, deps.now, deps.siteverify));
  versionRoutes(api, guarded, deps);
  documentRoutes(api, guarded, deps.now);
  usageRoutes(api, guarded, deps.now);
  accessLogRoutes(api, guarded, deps.now);
  shareLinkRoutes(api, guarded, deps.now);

  return api;
}

function summary(env: Env, row: ArtifactRow) {
  return ArtifactSummary.parse({
    id: row.id,
    name: row.name,
    type: row.type,
    state: row.state,
    accessMode: row.accessMode,
    annotations: row.annotations,
    currentVersionId: row.currentVersionId,
    url: contentUrl(env, row.id),
    expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
    archivedAt: row.archivedAt === null ? null : iso(row.archivedAt),
    purgeAt: row.purgeAt === null ? null : iso(row.purgeAt),
    ...(row.state === "suspended" && row.suspensionReason
      ? { suspension: { reason: row.suspensionReason } }
      : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export function contentUrl(env: Env, artifactId: string): string {
  return `https://${artifactId}.${env.CONTENT_DOMAIN}/`;
}
