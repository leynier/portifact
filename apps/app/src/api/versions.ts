// Version routes under /api/v1/artifacts/:artifactId (plan section 6, "Versiones"): list the
// retained versions, read a manifest, get short-lived download links and roll back. The MCP
// tools build their results with the presenters here, so both return the same bodies.
import {
  ArtifactContent,
  ContentQuery,
  DownloadQuery,
  IdempotencyKey,
  ListQuery,
  RollbackRequest,
  RolledBack,
  VersionDownload,
  VersionList,
  VersionManifest,
  VersionRef,
  VersionSummary,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import {
  type DownloadPlan,
  type FilePage,
  getVersionDownload,
  getVersionManifest,
  hashRequest,
  listVersions,
  type RollbackOutcome,
  readVersionFile,
  rollbackArtifact,
  runIdempotent,
  type StoredResponse,
  type VersionInfo,
  type VersionManifestResult,
  type VersionPage,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { artifactDb } from "../regions.ts";
import { type ApiContext, error, failure, type Guarded as Guard, iso, readJson } from "./http.ts";
import type { Presigner } from "./presign.ts";
import { type ApiDeps, contentUrl } from "./routes.ts";

export function versionSummary(version: VersionInfo): VersionSummary {
  return VersionSummary.parse({
    id: version.id,
    number: version.number,
    current: version.current,
    entrypoint: version.entrypoint,
    publishedBytes: version.publishedBytes,
    sourceBytes: version.sourceBytes,
    publishedFiles: version.publishedFiles,
    sourceFiles: version.sourceFiles,
    rendererVersion: version.rendererVersion,
    committedAt: iso(version.committedAt),
    expiresAt: version.expiresAt === null ? null : iso(version.expiresAt),
    sourceOrigin: version.sourceOrigin,
  });
}

export function versionList(artifactId: string, page: VersionPage): VersionList {
  return VersionList.parse({
    artifactId,
    items: page.items.map(versionSummary),
    nextCursor: page.nextCursor,
  });
}

export function versionManifest(result: VersionManifestResult): VersionManifest {
  return VersionManifest.parse({
    ...versionSummary(result.version),
    artifactId: result.artifactId,
    files: result.files,
  });
}

/** The download plan with a short-lived GET link for each file. */
export async function versionDownload(
  presigner: Presigner,
  plan: DownloadPlan,
  now: number,
): Promise<VersionDownload> {
  return VersionDownload.parse({
    artifactId: plan.artifactId,
    versionId: plan.versionId,
    versionNumber: plan.versionNumber,
    kind: plan.kind,
    entrypoint: plan.entrypoint,
    files: await Promise.all(
      plan.files.map(async (file) => {
        const link = await presigner.presignGet(file.r2Key, now);
        return {
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          contentType: file.contentType,
          method: "GET",
          url: link.url,
          expiresAt: iso(link.expiresAt),
        };
      }),
    ),
  });
}

export function artifactContent(page: FilePage): ArtifactContent {
  return ArtifactContent.parse(page);
}

export function rolledBack(env: Env, outcome: RollbackOutcome): RolledBack {
  return RolledBack.parse({
    artifactId: outcome.artifactId,
    versionId: outcome.versionId,
    versionNumber: outcome.versionNumber,
    url: contentUrl(env, outcome.artifactId),
    expiresAt: outcome.expiresAt === null ? null : iso(outcome.expiresAt),
    fromVersionId: outcome.fromVersionId,
    fromVersionNumber: outcome.fromVersionNumber,
  });
}

/** A rollback as a stored response, so an idempotent retry replays it exactly. */
export async function rollbackResponse(
  db: RegionalDb,
  env: Env,
  input: { userId: string; artifactId: string; request: RollbackRequest; now: number },
): Promise<StoredResponse> {
  const result = await rollbackArtifact(db, {
    userId: input.userId,
    artifactId: input.artifactId,
    versionId: input.request.versionId,
    baseVersionId: input.request.baseVersionId,
    now: input.now,
  });
  if (!result.ok) return failure(result.code, result.message);
  return { status: 200, body: rolledBack(env, result.value) };
}

export function versionRoutes(api: Hono<{ Bindings: Env }>, guarded: Guard, deps: ApiDeps) {
  const versionRef = (c: ApiContext) => VersionRef.safeParse(c.req.param("versionId"));

  api.get(
    "/api/v1/artifacts/:artifactId/versions",
    guarded("artifacts:read", async (c, userId) => {
      const query = ListQuery.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) return error(c, "invalid_input", "Invalid cursor or limit.");
      const artifactId = c.req.param("artifactId") as string;
      const result = await listVersions(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        now: deps.now(),
        cursor: query.data.cursor,
        limit: query.data.limit,
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(versionList(artifactId, result.value));
    }),
  );

  api.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId",
    guarded("artifacts:read", async (c, userId) => {
      const versionId = versionRef(c);
      if (!versionId.success) return error(c, "invalid_input", "Invalid version id.");
      const artifactId = c.req.param("artifactId") as string;
      const result = await getVersionManifest(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        versionId: versionId.data,
        now: deps.now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(versionManifest(result.value));
    }),
  );

  // Links, not bytes: each file is fetched straight from storage, like uploads are sent.
  api.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId/download",
    guarded("artifacts:read", async (c, userId) => {
      const versionId = versionRef(c);
      const query = DownloadQuery.safeParse({
        kind: c.req.query("kind"),
        path: c.req.query("path"),
      });
      if (!versionId.success) return error(c, "invalid_input", "Invalid version id.");
      if (!query.success) return error(c, "invalid_input", "kind must be published or source.");
      const now = deps.now();
      const result = await getVersionDownload(
        await artifactDb(c.env, c.req.param("artifactId") as string),
        {
          userId,
          artifactId: c.req.param("artifactId") as string,
          versionId: versionId.data,
          kind: query.data.kind,
          path: query.data.path,
          now,
        },
      );
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(await versionDownload(deps.presigner(c.env), result.value, now));
    }),
  );

  // One text file of a version, inline and a page at a time; the same files a download allows.
  api.get(
    "/api/v1/artifacts/:artifactId/versions/:versionId/content",
    guarded("artifacts:read", async (c, userId) => {
      const versionId = versionRef(c);
      const query = ContentQuery.safeParse({
        kind: c.req.query("kind"),
        path: c.req.query("path"),
        offset: c.req.query("offset"),
      });
      if (!versionId.success) return error(c, "invalid_input", "Invalid version id.");
      if (!query.success) {
        return error(c, "invalid_input", "kind must be published or source, offset a byte offset.");
      }
      const result = await readVersionFile(
        await artifactDb(c.env, c.req.param("artifactId") as string),
        c.env.ARTIFACTS,
        {
          userId,
          artifactId: c.req.param("artifactId") as string,
          versionId: versionId.data,
          ...query.data,
          now: deps.now(),
        },
      );
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(artifactContent(result.value));
    }),
  );

  api.post(
    "/api/v1/artifacts/:artifactId/rollback",
    guarded("artifacts:write", async (c, userId) => {
      const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
      if (!key.success) {
        return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
      }
      const body = await readJson(c, RollbackRequest);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const db = await artifactDb(c.env, artifactId);
      const now = deps.now();
      const outcome = await runIdempotent(
        db,
        {
          actorId: userId,
          key: key.data,
          operation: "versions.rollback",
          requestHash: await hashRequest({ artifactId, ...body.value }),
          now,
        },
        () => rollbackResponse(db, c.env, { userId, artifactId, request: body.value, now }),
      );
      if (outcome.kind === "mismatch") {
        return error(c, "invalid_input", "This Idempotency-Key was used for a different request.");
      }
      if (outcome.kind === "in_progress") {
        return error(
          c,
          "version_conflict",
          "A request with this Idempotency-Key is still running.",
        );
      }
      return c.json(outcome.response.body, outcome.response.status as 200);
    }),
  );
}
