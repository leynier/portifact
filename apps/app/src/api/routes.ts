// The publishing and artifact API under /api/v1 (plan sections 6 and 9). Each route checks the
// token for the API resource and one scope, validates input with the shared contracts and calls
// a service; the acting user always comes from the token. Business rules stay in services.
import {
  AccessPolicyView,
  AccessUpdate,
  ArtifactList,
  ArtifactListQuery,
  CommittedPublish,
  type ErrorCode,
  LifecycleResult,
  type OAuthScope,
  PublishRequest,
  type Region,
  TransferRequest,
  UploadedPart,
} from "@portifact/contracts";
import type { RegionalDb, RegionHandles } from "@portifact/db";
import type { MultipartConfig } from "@portifact/domain";
import {
  abortPublish,
  archiveArtifact,
  authenticateServiceToken,
  commitPublish,
  type DomainDeps,
  deleteArtifact,
  getAccess,
  getArtifact,
  type LifecycleOutcome,
  listArtifacts,
  pinArtifact,
  renewArtifact,
  reportUploadedPart,
  restoreArtifact,
  transferArtifact,
  unpinArtifact,
  updateAccess,
  uploadProgress,
} from "@portifact/services";
import { Hono } from "hono";
import { recordServiceToken } from "../auth/credentials.ts";
import type { FetchLike } from "../auth/deps.ts";
import type { Introspect, ProtectedResource } from "../auth/resource.ts";
import type { Env } from "../env.ts";
import { artifactListItem, artifactSummary } from "../mcp/present.ts";
import {
  artifactDb,
  artifactRegion,
  artifactStorage,
  bucketOf,
  ownerOf,
  ownerScope,
  regionsOf,
  uploadRegion,
} from "../regions.ts";
import { authorizeAccountRequest, authorizeApiRequest, type SessionLookup } from "./access.ts";
import { accessLogRoutes } from "./access-log.ts";
import type { AccountSessionLookup } from "./account.ts";
import { annotationRoutes } from "./annotations.ts";
import { approvalReviewRoutes } from "./approval-reviews.ts";
import { auditRoutes } from "./audit.ts";
import { dataRoutes } from "./data.ts";
import { documentRoutes } from "./documents.ts";
import { domainRoutes } from "./domains.ts";
import { feedbackRoutes } from "./feedback.ts";
import {
  type AccountGuarded,
  type ApiContext,
  error,
  type Guarded,
  idempotent,
  iso,
  readJson,
  workspaceParam,
} from "./http.ts";
import { integrationApiRoutes } from "./integrations.ts";
import type { Presigner } from "./presign.ts";
import { searchRoutes } from "./search.ts";
import { shareLinkRoutes } from "./share-links.ts";
import { statsRoutes } from "./stats.ts";
import { suggestionPreviewRoutes } from "./suggestion-previews.ts";
import { suggestionRoutes } from "./suggestions.ts";
import { apiTermsOperation } from "./terms-operations.ts";
import { preparedPublish, prepareUpload } from "./uploads.ts";
import { usageRoutes } from "./usage.ts";
import { versionRoutes } from "./versions.ts";
import { webhookRoutes } from "./webhooks.ts";
import { workspaceReadRoutes } from "./workspaces.ts";

export interface ApiDeps {
  introspect(env: Env): Introspect;
  resource(env: Env): ProtectedResource;
  /** The dashboard's session cookie, accepted from the app origin only (./access.ts). */
  session(env: Env): SessionLookup;
  /** The presigner of a region's bucket; the default region's without one. */
  presigner(env: Env, region?: Region): Presigner;
  /** Turnstile's siteverify transport, for the human check of new comments. */
  siteverify(env: Env): FetchLike;
  now(): number;
  /** Threshold and part size of multipart uploads; undefined for the defaults. */
  multipart?(env: Env): MultipartConfig | undefined;
  /** Cloudflare's custom hostnames and DNS; null while custom domains are switched off. */
  domains(env: Env): DomainDeps | null;
  /** The dashboard session with its own ID, for the helpers that bind a code to it. */
  accountSession(env: Env): AccountSessionLookup;
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
        serviceToken: async (secret) => {
          const auth = await authenticateServiceToken(regionsOf(c.env).global, secret, deps.now());
          if (auth.ok) recordServiceToken(c.env, auth.tokenId);
          return auth;
        },
      },
      c.req.raw,
      scope,
      apiTermsOperation(c.req.method, c.req.routePath),
    );
    return decision.ok ? handler(c, decision.userId) : decision.response;
  };

  /** The dashboard session or the Portifact CLI's `credentials:manage` token, nothing else. */
  const accountGuarded: AccountGuarded = (handler) => async (c: ApiContext) => {
    const decision = await authorizeAccountRequest(
      {
        introspect: deps.introspect(c.env),
        resource: deps.resource(c.env),
        session: deps.session(c.env),
      },
      c.req.raw,
      apiTermsOperation(c.req.method, c.req.routePath),
    );
    if (!decision.ok) return decision.response;
    c.header("Cache-Control", "no-store");
    return handler(c, { userId: decision.userId, via: decision.via });
  };

  api.post(
    "/api/v1/publishes",
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, PublishRequest);
      if (!body.ok) return body.response;
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      // An update goes to the artifact's own owner; a new artifact to the space the request names.
      let handles: RegionHandles;
      let targetOwnerId: string | undefined;
      if (body.value.artifactId) {
        handles = await artifactRegion(c.env, body.value.artifactId);
      } else {
        const scope = await ownerScope(c.env, userId, workspace.slug);
        if (!scope.ok) return error(c, scope.code, scope.message);
        handles = regionsOf(c.env).get(scope.value.actor.region);
        targetOwnerId = scope.value.actor.ownerId;
      }
      // The upload, its objects and its presigned URLs are the owner's region's (decision 0005).
      const db = handles.db;
      const now = deps.now();
      const request = workspace.slug ? { ...body.value, workspace: workspace.slug } : body.value;
      return idempotent(c, { db, userId, operation: "publish.prepare", request, now }, () =>
        prepareUpload(
          db,
          {
            bucket: bucketOf(handles),
            presigner: deps.presigner(c.env, handles.region),
            multipart: deps.multipart?.(c.env),
          },
          userId,
          body.value,
          now,
          targetOwnerId,
        ),
      );
    }),
  );

  // Progress of an open upload, with fresh URLs for the objects still to send.
  api.get(
    "/api/v1/publishes/:uploadId",
    guarded("artifacts:write", async (c, userId) => {
      const now = deps.now();
      const sessionId = c.req.param("uploadId") as string;
      const handles = await uploadRegion(c.env, sessionId);
      const result = await uploadProgress(handles.db, { userId, sessionId, now });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        await preparedPublish(deps.presigner(c.env, handles.region), result.value, now),
      );
    }),
  );

  // A part of a multipart object reached storage; its ETag lets the commit assemble the object.
  api.post(
    "/api/v1/publishes/:uploadId/parts",
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, UploadedPart);
      if (!body.ok) return body.response;
      const sessionId = c.req.param("uploadId") as string;
      const result = await reportUploadedPart((await uploadRegion(c.env, sessionId)).db, {
        userId,
        sessionId,
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
      const sessionId = c.req.param("uploadId") as string;
      const handles = await uploadRegion(c.env, sessionId);
      const result = await commitPublish(handles.db, bucketOf(handles), {
        userId,
        sessionId,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        CommittedPublish.parse({
          artifactId: result.value.artifactId,
          versionId: result.value.versionId,
          versionNumber: result.value.versionNumber,
          url: contentUrl(c.env, result.value.artifactId),
          expiresAt: result.value.expiresAt === null ? null : iso(result.value.expiresAt),
        }),
      );
    }),
  );

  api.delete(
    "/api/v1/publishes/:uploadId",
    guarded("artifacts:write", async (c, userId) => {
      const sessionId = c.req.param("uploadId") as string;
      const result = await abortPublish((await uploadRegion(c.env, sessionId)).db, {
        userId,
        sessionId,
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
        key: param("key"),
        expiring: param("expiring"),
      });
      if (!query.success) {
        return error(
          c,
          "invalid_input",
          "Invalid cursor, limit, search, state, type, access, annotations, key or expiring.",
        );
      }
      const { cursor, limit, ...filters } = query.data;
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db, owner } = scope.value;
      const page = await listArtifacts(db, { actor, cursor, limit, filters, now: deps.now() });
      if (!page.ok) return error(c, page.code, page.message);
      return c.json(
        ArtifactList.parse({
          items: page.value.items.map((row) => artifactListItem(c.env, row, owner)),
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
      return c.json(artifactSummary(c.env, row.value, await ownerOf(c.env, row.value.ownerId)));
    }),
  );

  // Moves an artifact to the caller's personal space (`workspace: null`) or a workspace; the
  // caller must be an admin or editor on both sides. Repeating a move that happened changes
  // nothing and answers the artifact where it is.
  api.post(
    "/api/v1/artifacts/:artifactId/transfer",
    guarded("artifacts:write", async (c, userId) => {
      const body = await readJson(c, TransferRequest);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const result = await transferArtifact(...(await artifactStorage(c.env, artifactId)), {
        userId,
        artifactId,
        workspace: body.value.workspace,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(
        artifactSummary(c.env, result.value, await ownerOf(c.env, result.value.ownerId)),
      );
    }),
  );

  api.get(
    "/api/v1/artifacts/:artifactId/access",
    guarded("artifacts:read", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await getAccess(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        now: deps.now(),
      });
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
      const result = await action(...(await artifactStorage(c.env, artifactId)), {
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
          pinned: result.value.pinned,
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
  // Pinning is a paid feature (premium plan P2); unpinning always works. Both are idempotent.
  api.post(
    "/api/v1/artifacts/:artifactId/pin",
    lifecycle((db, _b, i) => pinArtifact(db, i), "artifacts:write"),
  );
  api.post(
    "/api/v1/artifacts/:artifactId/unpin",
    lifecycle((db, _b, i) => unpinArtifact(db, i), "artifacts:write"),
  );
  api.delete("/api/v1/artifacts/:artifactId", lifecycle(deleteArtifact, "artifacts:delete"));

  api.route("/", annotationRoutes(guarded, deps.now, deps.siteverify));
  api.route("/", suggestionRoutes(guarded, deps.now, deps.siteverify));
  versionRoutes(api, guarded, deps);
  documentRoutes(api, guarded, deps.now);
  usageRoutes(api, guarded, deps.now);
  accessLogRoutes(api, guarded, deps.now);
  auditRoutes(api, guarded, deps.now);
  workspaceReadRoutes(api, guarded, deps.now);
  shareLinkRoutes(api, guarded, deps.now);
  approvalReviewRoutes(api, guarded, deps.now);
  statsRoutes(api, guarded, deps.now);
  dataRoutes(api, guarded, deps.now);
  suggestionPreviewRoutes(api, guarded, { accountSession: deps.accountSession, now: deps.now });
  searchRoutes(api, guarded, deps.now);
  feedbackRoutes(api, guarded, deps.now);
  webhookRoutes(api, guarded, accountGuarded, deps.now);
  integrationApiRoutes(api, guarded, deps.now);
  domainRoutes(api, guarded, deps.domains, deps.now);

  return api;
}

export function contentUrl(env: Env, artifactId: string): string {
  return `https://${artifactId}.${env.CONTENT_DOMAIN}/`;
}
