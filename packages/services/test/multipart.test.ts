import { env } from "cloudflare:test";
import { MULTIPART } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import type { MultipartConfig } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { expireUploads } from "../src/maintenance.ts";
import { reportUploadedPart, stagingKey } from "../src/multipart.ts";
import { runJob } from "../src/outbox.ts";
import {
  abortPublish,
  commitPublish,
  type PendingUpload,
  type PrepareInput,
  preparePublish,
  uploadProgress,
} from "../src/publish.ts";

const MiB = 1024 * 1024;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
/** Small enough to test quickly; R2 (and its local emulation) needs parts of at least 5 MiB. */
const CONFIG: MultipartConfig = { thresholdBytes: 6 * MiB, partBytes: 5 * MiB };
const SIZE = 12 * MiB;
const db = () => regionsFromEnv(env).get("default").db;

function bytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 255;
  return out;
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function owner(): string {
  return `u_${crypto.randomUUID()}`;
}

async function input(ownerId: string, data: Uint8Array, extra: Partial<PrepareInput> = {}) {
  return {
    userId: ownerId,
    type: "site" as const,
    name: "Large",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [
      {
        path: "index.html",
        kind: "published" as const,
        sha256: await sha256(new TextEncoder().encode("<p>large</p>")),
        size: 12,
        contentType: "text/html",
      },
      {
        path: "video.bin",
        kind: "published" as const,
        sha256: await sha256(data),
        size: data.length,
        contentType: "application/octet-stream",
      },
    ],
    now: NOW,
    ...extra,
  } satisfies PrepareInput;
}

/** Prepares a two-file publish whose large file goes in parts, and stores the small one. */
async function prepareLarge(ownerId: string, data: Uint8Array, config = CONFIG) {
  const prepared = await preparePublish(db(), await input(ownerId, data), {
    bucket: env.ARTIFACTS,
    config,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  const small = new TextEncoder().encode("<p>large</p>");
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(small)}`, small, {
    sha256: await sha256(small),
  });
  const large = prepared.value.uploads.find((upload) => upload.multipart);
  if (!large?.multipart) throw new Error("no multipart upload");
  return { prepared: prepared.value, large: large as Required<PendingUpload> };
}

/** Puts part `n` of `data` to storage, as a client does with its presigned URL, and reports it. */
async function sendPart(
  ownerId: string,
  sessionId: string,
  large: Required<PendingUpload>,
  data: Uint8Array,
  partNumber: number,
  report = true,
  /** How the client got the ETag: R2's S3 endpoint sends it quoted, the binding does not. */
  quoted = false,
) {
  const { partSize, key, uploadId } = await currentState(ownerId, sessionId, large.sha256);
  const slice = data.slice((partNumber - 1) * partSize, partNumber * partSize);
  const part = await env.ARTIFACTS.resumeMultipartUpload(key, uploadId).uploadPart(
    partNumber,
    slice,
  );
  if (report) {
    const reported = await reportUploadedPart(db(), {
      userId: ownerId,
      sessionId,
      sha256: large.sha256,
      partNumber,
      etag: quoted ? `"${part.etag}"` : part.etag,
      now: NOW,
    });
    expect(reported).toEqual({ ok: true, value: true });
  }
  return part;
}

async function currentState(ownerId: string, sessionId: string, sha: string) {
  const progress = await uploadProgress(db(), { userId: ownerId, sessionId, now: NOW });
  if (!progress.ok) throw new Error(progress.message);
  const state = progress.value.uploads.find((upload) => upload.sha256 === sha)?.multipart;
  if (!state) throw new Error("no multipart state");
  return state;
}

async function jobsOf(sessionId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "abort_multipart"), eq(schema.outbox.subject, sessionId)));
}

async function runJobs(sessionId: string) {
  for (const job of await jobsOf(sessionId)) {
    await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "abort_multipart" }, NOW);
  }
}

async function usage(ownerId: string) {
  const [row] = await db()
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row;
}

describe("the multipart threshold", () => {
  it("uploads an object of exactly 64 MiB in one request and a larger one in 16 MiB parts", async () => {
    const id = owner();
    const at = (size: number, sha: string) => ({
      path: `f${size}.bin`,
      kind: "published" as const,
      sha256: sha,
      size,
      contentType: "application/octet-stream",
    });
    const prepared = await preparePublish(
      db(),
      {
        userId: id,
        type: "site",
        name: "Boundary",
        entrypoint: `f${MULTIPART.thresholdBytes}.bin`,
        baseVersionId: null,
        files: [
          at(MULTIPART.thresholdBytes, "a".repeat(64)),
          at(MULTIPART.thresholdBytes + 1, "b".repeat(64)),
        ],
        now: NOW,
      },
      { bucket: env.ARTIFACTS },
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const bySha = new Map(prepared.value.uploads.map((upload) => [upload.sha256, upload]));
    expect(bySha.get("a".repeat(64))?.multipart).toBeUndefined();
    expect(bySha.get("b".repeat(64))?.multipart).toMatchObject({
      partSize: 16 * MiB,
      partCount: 5,
      doneParts: [],
      key: stagingKey(id, prepared.value.sessionId, "b".repeat(64)),
    });
    await abortPublish(db(), { userId: id, sessionId: prepared.value.sessionId, now: NOW });
    await runJobs(prepared.value.sessionId);
  });

  it("gives every object one PUT to a client that does not upload in parts", async () => {
    const id = owner();
    const prepared = await preparePublish(db(), await input(id, bytes(SIZE, 1)));
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.value.uploads.every((upload) => !upload.multipart)).toBe(true);
    const rows = await db()
      .select()
      .from(schema.multipartUploads)
      .where(eq(schema.multipartUploads.sessionId, prepared.value.sessionId));
    expect(rows).toEqual([]);
  });
});

describe("a multipart upload", () => {
  it("resumes from the reported parts, then assembles, rehashes and commits the object", async () => {
    const id = owner();
    const data = bytes(SIZE, 2);
    const { prepared, large } = await prepareLarge(id, data);
    expect(large.multipart).toMatchObject({ partSize: 5 * MiB, partCount: 3, doneParts: [] });
    // The reservation counts the large object like any other new bytes.
    expect((await usage(id))?.reservedBytes).toBe(SIZE + 12);

    await sendPart(id, prepared.sessionId, large, data, 1);
    await sendPart(id, prepared.sessionId, large, data, 2);
    // The client stopped here. Progress lists what is done, so it sends only the rest.
    expect((await currentState(id, prepared.sessionId, large.sha256)).doneParts).toEqual([1, 2]);
    // Reporting a part again is harmless.
    await sendPart(id, prepared.sessionId, large, data, 2);
    await sendPart(id, prepared.sessionId, large, data, 3);

    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed.ok).toBe(true);
    const stored = await env.ARTIFACTS.get(large.r2Key);
    expect(stored?.size).toBe(SIZE);
    expect(stored?.checksums.toJSON().sha256).toBeDefined();
    expect(await sha256(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer()))).toBe(
      large.sha256,
    );
    expect(await env.ARTIFACTS.head(large.multipart.key)).toBeNull();
    expect(await usage(id)).toMatchObject({ storedBytes: SIZE + 12, reservedBytes: 0 });

    expect(await jobsOf(prepared.sessionId)).toHaveLength(1);
    await runJobs(prepared.sessionId);
    expect(await jobsOf(prepared.sessionId)).toHaveLength(0);
    const left = await db()
      .select()
      .from(schema.multipartUploads)
      .where(eq(schema.multipartUploads.sessionId, prepared.sessionId));
    expect(left).toEqual([]);
    // The object survives the cleanup of its session's multipart upload.
    expect((await env.ARTIFACTS.head(large.r2Key))?.size).toBe(SIZE);
  });

  it("commits parts whose ETags are quoted, as the S3 endpoint's ETag header sends them", async () => {
    const id = owner();
    const data = bytes(SIZE, 9);
    const { prepared, large } = await prepareLarge(id, data);
    for (const part of [1, 2, 3])
      await sendPart(id, prepared.sessionId, large, data, part, true, true);

    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed).toMatchObject({ ok: true });
    expect((await env.ARTIFACTS.head(large.r2Key))?.size).toBe(SIZE);
    await runJobs(prepared.sessionId);
  });

  it("refuses the commit while parts are missing and keeps the upload open", async () => {
    const id = owner();
    const data = bytes(SIZE, 3);
    const { prepared, large } = await prepareLarge(id, data);
    await sendPart(id, prepared.sessionId, large, data, 1);
    const early = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(early).toMatchObject({ ok: false, code: "upload_incomplete" });
    expect(early.ok ? "" : early.message).toContain("missing parts 2, 3");
    await sendPart(id, prepared.sessionId, large, data, 2);
    await sendPart(id, prepared.sessionId, large, data, 3);
    const late = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(late.ok).toBe(true);
  });

  it("asks for every part again when a reported ETag is wrong", async () => {
    const id = owner();
    const data = bytes(SIZE, 4);
    const { prepared, large } = await prepareLarge(id, data);
    await sendPart(id, prepared.sessionId, large, data, 1);
    await sendPart(id, prepared.sessionId, large, data, 2, false);
    await reportUploadedPart(db(), {
      userId: id,
      sessionId: prepared.sessionId,
      sha256: large.sha256,
      partNumber: 2,
      etag: "not-the-etag",
      now: NOW,
    });
    await sendPart(id, prepared.sessionId, large, data, 3);
    const refused = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, code: "upload_incomplete" });
    expect(refused.ok ? "" : refused.message).toContain("could not be assembled");
    expect((await currentState(id, prepared.sessionId, large.sha256)).doneParts).toEqual([]);

    for (const part of [1, 2, 3]) await sendPart(id, prepared.sessionId, large, data, part);
    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed.ok).toBe(true);
  });

  it("refuses bytes that do not match the SHA-256 and opens a new upload for them", async () => {
    const id = owner();
    const data = bytes(SIZE, 5);
    const { prepared, large } = await prepareLarge(id, data);
    const corrupted = data.slice();
    corrupted[6 * MiB] = (corrupted[6 * MiB] ?? 0) ^ 1;
    for (const part of [1, 2, 3]) await sendPart(id, prepared.sessionId, large, corrupted, part);
    const refused = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, code: "upload_incomplete" });
    expect(refused.ok ? "" : refused.message).toContain("does not match its hash");
    // Nothing reached the object's key, and the wrong assembly is gone.
    expect(await env.ARTIFACTS.head(large.r2Key)).toBeNull();
    expect(await env.ARTIFACTS.head(large.multipart.key)).toBeNull();
    const fresh = await currentState(id, prepared.sessionId, large.sha256);
    expect(fresh.uploadId).not.toBe(large.multipart.uploadId);
    expect(fresh.doneParts).toEqual([]);

    for (const part of [1, 2, 3]) await sendPart(id, prepared.sessionId, large, data, part);
    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed.ok).toBe(true);
  });

  it("refuses an assembled object of the wrong size", async () => {
    const id = owner();
    const data = bytes(SIZE, 6);
    const { prepared, large } = await prepareLarge(id, data);
    await sendPart(id, prepared.sessionId, large, data, 1);
    await sendPart(id, prepared.sessionId, large, data, 2);
    await sendPart(id, prepared.sessionId, large, data.slice(0, 11 * MiB), 3);
    const refused = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(refused.ok ? "" : refused.message).toContain(`expected ${SIZE}`);
  });

  it("finishes a commit retried after the object was already assembled", async () => {
    const id = owner();
    const data = bytes(SIZE, 7);
    const { prepared, large } = await prepareLarge(id, data);
    for (const part of [1, 2, 3]) await sendPart(id, prepared.sessionId, large, data, part);
    // A first attempt assembled and copied the object, then stopped before its batch.
    const parts = await db()
      .select()
      .from(schema.multipartParts)
      .where(eq(schema.multipartParts.sessionId, prepared.sessionId))
      .orderBy(schema.multipartParts.partNumber);
    await env.ARTIFACTS.resumeMultipartUpload(
      large.multipart.key,
      large.multipart.uploadId,
    ).complete(parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
    await env.ARTIFACTS.put(large.r2Key, data, { sha256: large.sha256 });
    await env.ARTIFACTS.delete(large.multipart.key);

    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed.ok).toBe(true);
  });

  it("commits without its own parts when the same bytes were stored meanwhile", async () => {
    const id = owner();
    const data = bytes(SIZE, 8);
    const { prepared, large } = await prepareLarge(id, data);
    await env.ARTIFACTS.put(large.r2Key, data, { sha256: large.sha256 });
    const committed = await commitPublish(db(), env.ARTIFACTS, {
      userId: id,
      sessionId: prepared.sessionId,
      now: NOW,
    });
    expect(committed.ok).toBe(true);
    // The unused upload is aborted by the session's cleanup job.
    await runJobs(prepared.sessionId);
    const rows = await db()
      .select()
      .from(schema.multipartUploads)
      .where(eq(schema.multipartUploads.sessionId, prepared.sessionId));
    expect(rows).toEqual([]);
  });
});

describe("closing a multipart upload", () => {
  it("aborts the R2 upload and deletes its staging copy and rows through the outbox", async () => {
    const id = owner();
    const data = bytes(SIZE, 9);
    const { prepared, large } = await prepareLarge(id, data);
    await sendPart(id, prepared.sessionId, large, data, 1);
    await env.ARTIFACTS.put(large.multipart.key, "partial staging copy");

    expect(
      await abortPublish(db(), { userId: id, sessionId: prepared.sessionId, now: NOW }),
    ).toEqual({ ok: true, value: true });
    expect(await usage(id)).toMatchObject({ reservedBytes: 0, openUploads: 0 });
    expect(await jobsOf(prepared.sessionId)).toHaveLength(1);
    // Aborting again writes no second job.
    await abortPublish(db(), { userId: id, sessionId: prepared.sessionId, now: NOW });
    expect(await jobsOf(prepared.sessionId)).toHaveLength(1);

    await runJobs(prepared.sessionId);
    await expect(
      env.ARTIFACTS.resumeMultipartUpload(large.multipart.key, large.multipart.uploadId).uploadPart(
        2,
        data.slice(0, 5 * MiB),
      ),
    ).rejects.toThrow();
    expect(await env.ARTIFACTS.head(large.multipart.key)).toBeNull();
    const parts = await db()
      .select()
      .from(schema.multipartParts)
      .where(eq(schema.multipartParts.sessionId, prepared.sessionId));
    expect(parts).toEqual([]);
    // A late report finds the upload closed.
    const late = await reportUploadedPart(db(), {
      userId: id,
      sessionId: prepared.sessionId,
      sha256: large.sha256,
      partNumber: 2,
      etag: "e",
      now: NOW,
    });
    expect(late).toMatchObject({ ok: false, code: "upload_incomplete" });
  });

  it("aborts the uploads of an expired session", async () => {
    const id = owner();
    const { prepared } = await prepareLarge(id, bytes(SIZE, 10));
    await expireUploads(db(), NOW + 2 * DAY);
    expect(await jobsOf(prepared.sessionId)).toHaveLength(1);
    await runJobs(prepared.sessionId);
    expect(await jobsOf(prepared.sessionId)).toHaveLength(0);
  });

  it("leaves an open session's uploads alone", async () => {
    const id = owner();
    const { prepared } = await prepareLarge(id, bytes(SIZE, 11));
    await db().insert(schema.outbox).values({
      topic: "abort_multipart",
      payload: {},
      availableAt: NOW,
      createdAt: NOW,
      subject: prepared.sessionId,
    });
    const [job] = await jobsOf(prepared.sessionId);
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job?.id ?? 0, topic: "abort_multipart" }, NOW),
    ).toBe("stale");
    const rows = await db()
      .select()
      .from(schema.multipartUploads)
      .where(eq(schema.multipartUploads.sessionId, prepared.sessionId));
    expect(rows).toHaveLength(1);
  });

  it("aborts the uploads it opened when the prepare transaction fails", async () => {
    const id = owner();
    const data = bytes(SIZE, 12);
    const opened: { key: string; uploadId: string }[] = [];
    const bucket = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "createMultipartUpload") {
          return async (key: string) => {
            const upload = await target.createMultipartUpload(key);
            opened.push({ key, uploadId: upload.uploadId });
            return upload;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // A concurrent change fills the account before the batch, so the reservation's CHECK fails.
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: id, storedBytes: 2_500_000_000 - SIZE - 1_000, monthStartedAt: NOW });
    const racer = regionsFromEnv(env).get("default").db;
    const failing = new Proxy(db(), {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: Parameters<typeof target.batch>[0]) => {
          await racer
            .update(schema.accountUsage)
            .set({ storedBytes: 2_500_000_000 - 1 })
            .where(eq(schema.accountUsage.ownerId, id));
          return target.batch(statements);
        };
      },
    }) as ReturnType<typeof db>;
    const refused = await preparePublish(failing, await input(id, data), {
      bucket,
      config: CONFIG,
    });
    expect(refused).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(opened).toHaveLength(1);
    const [upload] = opened;
    await expect(
      env.ARTIFACTS.resumeMultipartUpload(upload?.key ?? "", upload?.uploadId ?? "").uploadPart(
        1,
        data.slice(0, 5 * MiB),
      ),
    ).rejects.toThrow();
  });
});

describe("reporting a part", () => {
  it("refuses another account, an unknown object, a part outside the plan and a closed upload", async () => {
    const id = owner();
    const data = bytes(SIZE, 13);
    const { prepared, large } = await prepareLarge(id, data);
    const base = {
      userId: id,
      sessionId: prepared.sessionId,
      sha256: large.sha256,
      partNumber: 1,
      etag: "e",
      now: NOW,
    };
    expect(await reportUploadedPart(db(), { ...base, userId: owner() })).toMatchObject({
      code: "not_found",
    });
    expect(await reportUploadedPart(db(), { ...base, sessionId: "upl_missing" })).toMatchObject({
      code: "not_found",
    });
    expect(await reportUploadedPart(db(), { ...base, sha256: "c".repeat(64) })).toMatchObject({
      code: "invalid_input",
    });
    expect(await reportUploadedPart(db(), { ...base, partNumber: 4 })).toMatchObject({
      code: "invalid_input",
    });
    expect(await reportUploadedPart(db(), { ...base, now: NOW + 2 * DAY })).toMatchObject({
      code: "upload_incomplete",
    });
    await abortPublish(db(), { userId: id, sessionId: prepared.sessionId, now: NOW });
    expect(await reportUploadedPart(db(), base)).toMatchObject({ code: "upload_incomplete" });
  });
});
