// The owner document API of artifact data under /api/v1/artifacts/:id/data (decision 0026,
// delivery 5): describe, declare collections, build indexes, read, query, count, create, replace,
// delete (one or up to 100), and export pages. Reads take `data:read`, changes `data:write`; a
// service token holds them only when its admin granted them. Each route is a thin adapter over
// the services in packages/services/src/artifact-data-owner.ts, which the MCP tools and the CLI
// share. Changes take an Idempotency-Key, which also names the operation in the object.
import {
  DataBulkCreate,
  DataBulkRemove,
  DataBulkReplace,
  DataCollectionDeclare,
  DataCountParams,
  DataDocumentBody,
  DataQueryParams,
  type DataQueryParams as DataQueryParamsType,
  dataCountOf,
  dataQueryOf,
  type ErrorCode,
  IdempotencyKey,
  MAX_DOCUMENT_BYTES,
  parseExportCursor,
} from "@portifact/contracts";
import type { RegionHandles } from "@portifact/db";
import {
  buildDataIndexes,
  countArtifactData,
  createDataDocument,
  createDataDocuments,
  dataNamespaces,
  declareDataCollection,
  deleteDataDocument,
  deleteDataDocuments,
  describeArtifactData,
  exportArtifactData,
  getDataDocument,
  type OwnerDataDeps,
  queryArtifactData,
  replaceDataDocument,
  replaceDataDocuments,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { artifactRegion, bucketOf } from "../regions.ts";
import { type ApiContext, error, failure, type Guarded, readJson } from "./http.ts";

/** The largest body a data change may send: a bulk write of 100 documents at the plan's size. */
export const DATA_BODY_MAX = 8 * 1024 * 1024;
const DOCUMENT_BODY_MAX = MAX_DOCUMENT_BYTES + 1024;

/** What the owner side's services need in the artifact's region. */
export function ownerDataDeps(env: Env, handles: RegionHandles): OwnerDataDeps {
  return {
    objects: dataNamespaces(env, handles.region),
    bucket: bucketOf(handles),
    enabled: env.ARTIFACT_DATA_ENABLED === "true",
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

function answer<T>(c: ApiContext, result: Result<T>, status: 200 | 201 = 200) {
  if (!result.ok) return error(c, result.code, result.message);
  return c.json(result.value as object, status);
}

/**
 * A change: it needs an Idempotency-Key, which names its operation in the documents object
 * (decision 0026, delivery 5). Nothing here stores an answer: the service authorizes every
 * request, a retry included, and the object answers a retry from its own record, so a retry is
 * never answered from a stored body or to someone who lost access.
 */
async function change(
  c: ApiContext,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  if (!IdempotencyKey.safeParse(c.req.header("idempotency-key")).success) {
    return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
  }
  const { status, body } = await run();
  return c.json(body as object, status as 200);
}

/** A change's answer: the body, or the error. */
function stored<T>(result: Result<T>, status = 200) {
  return result.ok ? { status, body: result.value } : failure(result.code, result.message);
}

function queryParams(c: ApiContext): DataQueryParamsType | null {
  const parsed = DataQueryParams.safeParse(
    Object.fromEntries(
      Object.entries({
        equalsField: c.req.query("equalsField"),
        equalsValue: c.req.query("equalsValue"),
        createdOp: c.req.query("createdOp"),
        createdValue: c.req.query("createdValue"),
        order: c.req.query("order"),
        limit: c.req.query("limit"),
        after: c.req.query("after"),
      }).filter(([, value]) => value !== undefined),
    ),
  );
  return parsed.success ? parsed.data : null;
}

export function dataRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  const base = "/api/v1/artifacts/:artifactId/data";
  const at = async (c: ApiContext) => {
    const artifactId = c.req.param("artifactId") as string;
    const region = await artifactRegion(c.env, artifactId);
    return { artifactId, region, deps: ownerDataDeps(c.env, region) };
  };
  // `change` refused a request without a valid key before any handler reads it.
  const key = (c: ApiContext) => c.req.header("idempotency-key") as string;

  api.get(
    base,
    guarded("data:read", async (c, userId) => {
      const { artifactId, region, deps } = await at(c);
      return answer(
        c,
        await describeArtifactData(region.db, deps, { userId, artifactId, now: now() }),
      );
    }),
  );

  api.post(
    `${base}/collections`,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataCollectionDeclare);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await declareDataCollection(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            declaration: body.value,
          }),
          201,
        ),
      );
    }),
  );

  api.post(
    `${base}/indexes/build`,
    guarded("data:write", async (c, userId) => {
      const { artifactId, region, deps } = await at(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await buildDataIndexes(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
          }),
        ),
      );
    }),
  );

  api.get(
    `${base}/count`,
    guarded("data:read", async (c, userId) => {
      const params = DataCountParams.safeParse(
        Object.fromEntries(
          Object.entries({
            collection: c.req.query("collection"),
            by: c.req.query("by"),
            equalsField: c.req.query("equalsField"),
            equalsValue: c.req.query("equalsValue"),
          }).filter(([, value]) => value !== undefined),
        ),
      );
      if (!params.success) return error(c, "invalid_input", "Invalid count: name a collection.");
      const { artifactId, region, deps } = await at(c);
      return answer(
        c,
        await countArtifactData(region.db, deps, {
          userId,
          artifactId,
          now: now(),
          count: dataCountOf(params.data),
        }),
      );
    }),
  );

  api.get(
    `${base}/export`,
    guarded("data:read", async (c, userId) => {
      const after = parseExportCursor(c.req.query("after"));
      if (after === undefined) return error(c, "invalid_input", "Invalid export cursor.");
      const { artifactId, region, deps } = await at(c);
      return answer(
        c,
        await exportArtifactData(region.db, deps, { userId, artifactId, now: now(), after }),
      );
    }),
  );

  const documents = `${base}/collections/:collection/documents`;
  const collectionOf = (c: ApiContext) => c.req.param("collection") as string;

  api.get(
    documents,
    guarded("data:read", async (c, userId) => {
      const params = queryParams(c);
      if (params === null) return error(c, "invalid_input", "Invalid query.");
      let query: ReturnType<typeof dataQueryOf>;
      try {
        query = dataQueryOf(collectionOf(c), params);
      } catch {
        return error(c, "invalid_input", "Invalid query.");
      }
      const { artifactId, region, deps } = await at(c);
      return answer(
        c,
        await queryArtifactData(region.db, deps, { userId, artifactId, now: now(), query }),
      );
    }),
  );

  api.post(
    documents,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataDocumentBody, DOCUMENT_BODY_MAX);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await createDataDocument(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            body: body.value,
          }),
          201,
        ),
      );
    }),
  );

  api.post(
    `${documents}/bulk`,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataBulkCreate, DATA_BODY_MAX);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await createDataDocuments(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            documents: body.value.documents,
          }),
          201,
        ),
      );
    }),
  );

  api.put(
    `${documents}/bulk`,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataBulkReplace, DATA_BODY_MAX);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await replaceDataDocuments(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            documents: body.value.documents,
          }),
        ),
      );
    }),
  );

  api.post(
    `${documents}/bulk-delete`,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataBulkRemove);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await deleteDataDocuments(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            ids: body.value.ids,
          }),
        ),
      );
    }),
  );

  const document = `${documents}/:documentId`;
  const documentOf = (c: ApiContext) => c.req.param("documentId") as string;

  api.get(
    document,
    guarded("data:read", async (c, userId) => {
      const { artifactId, region, deps } = await at(c);
      return answer(
        c,
        await getDataDocument(region.db, deps, {
          userId,
          artifactId,
          now: now(),
          collection: collectionOf(c),
          id: documentOf(c),
        }),
      );
    }),
  );

  api.put(
    document,
    guarded("data:write", async (c, userId) => {
      const body = await readJson(c, DataDocumentBody, DOCUMENT_BODY_MAX);
      if (!body.ok) return body.response;
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const id = documentOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await replaceDataDocument(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            id,
            body: body.value,
          }),
        ),
      );
    }),
  );

  api.delete(
    document,
    guarded("data:write", async (c, userId) => {
      const { artifactId, region, deps } = await at(c);
      const collection = collectionOf(c);
      const id = documentOf(c);
      const at0 = now();
      return change(c, async () =>
        stored(
          await deleteDataDocument(region.db, deps, {
            userId,
            artifactId,
            now: at0,
            idempotencyKey: key(c),
            collection,
            id,
          }),
        ),
      );
    }),
  );
}
