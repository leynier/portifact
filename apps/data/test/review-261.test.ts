// The reproductions of the independent review of pull request #261 (decision 0026, delivery 4,
// second half), each named after its finding: B1 to B5 and S1 to S4, plus the RPC surface's
// negative control. They failed on the reviewed head e4e6b5ba; each passes with its fix. B2 and
// B4 follow the maintainer's decisions on them: a resolution is tied to the state the operator
// reviewed, and a purge with D1's proof of permanent deletion erases whatever generation the
// object is at, while one without it keeps its obligation.
import { env, runInDurableObject } from "cloudflare:test";
import { schema } from "@portifact/db";
import {
  controlEnvelope,
  inventoryEntry,
  inventoryKey,
  journalKey,
  LIFECYCLE_LIMITS,
  reviewedState,
} from "@portifact/domain/artifact-data";
import {
  type DataObjectRpc,
  deleteArtifactData,
  lifecycleId,
  placeLegalHold,
  queueDataResolve,
  reconcileObject,
  releaseLegalHold,
  runJob,
  scheduleAuthorErasures,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { ArtifactDocuments, storeFor } from "../src/documents.ts";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  dataRowOf,
  db,
  documentsOf,
  drain,
  inside,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  reviewedOf,
  stubOf,
  withData,
} from "./lifecycle.ts";

async function one(id: string, topic: string) {
  const [row] = await jobsOf(db(), [topic], id);
  if (!row) throw new Error("no job");
  return runJob(db(), bucketOf(), { id: row.id, topic: row.topic }, NOW, { data: objectsFor() });
}
async function quarantine(id: string, reason: "owner" | "hold" = "owner") {
  const c = await controlOf(id);
  if (!c) throw new Error("empty");
  return stubOf(id).lifecycleQuarantine(controlEnvelope(c), reason, NOW);
}

it("B1: a re-applied D1 hold cannot be erased through mismatch quarantine", async () => {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  // A restore lost the undelivered fence. The exported hold was re-applied in D1.
  await db().delete(schema.outbox).where(eq(schema.outbox.subject, id));
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW)).toBe(
    "quarantine:hold",
  );
  await queueDataResolve(db(), id, "erase", await reviewedOf(id), NOW);
  await one(id, "data_resolve");
  expect(await documentsOf(id)).toBe(1);
  // Adopting instead keeps the hold D1 has: the object holds durably once the quarantine is gone.
  await queueDataResolve(db(), id, "adopt", await reviewedOf(id), NOW);
  await one(id, "data_resolve");
  const control = await controlOf(id);
  expect(control?.quarantine).toBeNull();
  expect(control?.hold).not.toBeNull();
});

it("B2: a delayed resolution is tied to the quarantine reviewed by the operator", async () => {
  const { id } = await withData();
  await quarantine(id);
  const q1 = reviewedState((await controlOf(id))!)!;
  await queueDataResolve(db(), id, "erase", q1, NOW);
  // Q1 is resolved another way meanwhile, and the object is quarantined again as Q2.
  const c = (await controlOf(id))!;
  const adopted = await (stubOf(id) as unknown as DataObjectRpc).lifecycleResolve(
    controlEnvelope(c),
    { id: lifecycleId(NOW), decision: "adopt", expected: q1, hold: null },
    NOW,
  );
  expect(adopted.ok).toBe(true);
  await stubOf(id).lifecycleQuarantine(
    controlEnvelope((await controlOf(id))!),
    "generation",
    NOW + 1,
  );
  await one(id, "data_resolve");
  expect(await documentsOf(id)).toBe(1);
  expect((await controlOf(id))?.quarantine?.reason).toBe("generation");
});

it("S1: obsolete fences terminate when a purge overtakes them", async () => {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
  await db().update(schema.artifacts).set({ state: "purging" }).where(eq(schema.artifacts.id, id));
  await deleteArtifactData(db(), bucketOf(), id, D1_NOW + 2);
  expect(await one(id, "data_erase")).toBe("done");
  await drain({ subject: id, rounds: 2 });
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
});

it("S4: reconciliation checks directory and inventory region before raising D1", async () => {
  const { id } = await withData();
  // Existing objects must not be silently accepted under a mismatched inventory region.
  const result = await reconcileObject(db(), objectsFor(), inventoryEntry(id, "eu", NOW), NOW);
  expect(result).toMatch(/quarantine|operator/);
});

it("B3: account erasure scan progresses past ten pages of already retired entries", async () => {
  const userId = `u_large_${crypto.randomUUID()}`;
  const visitorId = `v_${"a".repeat(24)}`;
  const key = journalKey(userId, "abcdefghij");
  const pageKey = (page: number, n: number) =>
    journalKey(userId, `p${String(page).padStart(2, "0")}_${String(n).padStart(4, "0")}`);
  let foundLast = false;
  let lists = 0;
  // Ten full pages of retired entries, then one live entry: a stand-in listing that resumes after
  // `startAfter`, as R2 does, without writing 10,001 real objects.
  const bucket = {
    async list(options: R2ListOptions) {
      lists += 1;
      const after = options.startAfter;
      const page = after === undefined ? 0 : Number(/\/p(\d+)_/.exec(after)?.[1] ?? 0) + 1;
      if (page === 10) {
        foundLast = true;
        return { objects: [{ key }], truncated: false, delimitedPrefixes: [] };
      }
      return {
        objects: Array.from({ length: 1000 }, (_, n) => ({
          key: pageKey(page, n),
          customMetadata: { retired: "1" },
        })),
        truncated: true,
        delimitedPrefixes: [],
      };
    },
    async get() {
      return { etag: "a", json: async () => ({ visitorId, firstGrantAt: NOW }) };
    },
    async put() {
      return { etag: "b" };
    },
  } as unknown as R2Bucket;
  // The scan keeps its position only while the account's deletion is pending (round 2, F5).
  await db().global.insert(schema.accountDeletions).values({ userId, requestedAt: NOW });
  for (let run = 0; run < 11; run += 1) await scheduleAuthorErasures(db(), bucket, userId, NOW);
  expect(foundLast).toBe(true);
  // One list per run.
  expect(lists).toBe(11);
  expect(await jobsOf(db(), ["data_author_erasure"], "abcdefghij")).toHaveLength(1);
});

async function newerGeneration() {
  const { id, ownerId } = await withData();
  await db()
    .update(schema.artifactData)
    .set({ generation: 1 })
    .where(eq(schema.artifactData.artifactId, id));
  await inside(id, (object) => {
    const base = { artifactId: id, region: "default", ownerId, generation: 0, epoch: 0 };
    const erase = lifecycleId(NOW);
    object.store.prepareErase(base, erase, NOW);
    object.store.commitErase(base, erase, NOW);
    const e = { ...base, generation: 1, opId: lifecycleId(NOW) };
    object.store.declare(
      e,
      { kind: "owner" },
      { name: "newer", mode: "own" },
      { now: NOW, limits: LIFECYCLE_LIMITS },
    );
    object.store.create(
      { ...e, opId: lifecycleId(NOW) },
      { kind: "owner" },
      "newer",
      { keep: true },
      { now: NOW, limits: LIFECYCLE_LIMITS },
    );
  });
  expect(await documentsOf(id)).toBe(1);
  // D1 restore rewinds the data row to before the reset.
  await db()
    .update(schema.artifactData)
    .set({ generation: 0 })
    .where(eq(schema.artifactData.artifactId, id));
  return { id, ownerId };
}

const retiredAtOf = async (id: string) =>
  (await (await bucketOf().get(inventoryKey(id)))!.json<{ retiredAt?: number }>()).retiredAt;

it("B4: a purge D1 proves erases the newer generation, and only then retires the entry", async () => {
  const { id } = await newerGeneration();
  // Tombstones re-apply a purge: D1 proves the permanent deletion.
  await db().update(schema.artifacts).set({ state: "purging" }).where(eq(schema.artifacts.id, id));
  await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
  expect(await one(id, "data_erase")).toBe("done");
  expect(await documentsOf(id)).toBe(0);
  expect(await retiredAtOf(id)).toBe(NOW);
});

it("B4: an old purge without D1's proof keeps the entry, the job and a finding", async () => {
  const { id, ownerId } = await newerGeneration();
  await db()
    .insert(schema.outbox)
    .values({
      topic: "data_erase",
      subject: id,
      payload: { ownerId, generation: 0, epoch: 0 },
      availableAt: NOW,
    });
  expect(await one(id, "data_erase")).toBe("kept");
  expect(await documentsOf(id)).toBe(1);
  expect(await retiredAtOf(id)).toBeUndefined();
  expect(await jobsOf(db(), ["data_erase"], id)).toHaveLength(1);
  const [finding] = await db()
    .select()
    .from(schema.dataFindings)
    .where(eq(schema.dataFindings.artifactId, id));
  expect(finding?.action).toBe("superseded");
});

it("S2: invalid RPC input cannot touch storage even on a cold object", async () => {
  const { id } = await withData();
  const answer = await runInDurableObject(stubOf(id), (object, state) => {
    object.store = storeFor(state, object.clients);
    object.store.faults.statement = (query) =>
      query.startsWith("SELECT value FROM pf_meta WHERE key = 'control'");
    return object.lifecycleFence({}, {}, NOW);
  });
  expect(answer).toMatchObject({ ok: false, code: "invalid_input" });
});

it("B5: author erasure stays pending for an orphan that the operator may adopt", async () => {
  const visitor = `v_${"b".repeat(24)}`;
  const { id } = await withData({ visitors: [visitor] });
  // D1 restore before data was registered; the object and its journal are not rewound.
  await db().delete(schema.artifactData).where(eq(schema.artifactData.artifactId, id));
  await bucketOf().put(
    journalKey("u_deleted", id),
    JSON.stringify({ visitorId: visitor, firstGrantAt: NOW, retiredAt: NOW }),
    { customMetadata: { retired: "1" } },
  );
  await db()
    .insert(schema.outbox)
    .values({
      topic: "data_author_erasure",
      subject: id,
      payload: { userId: "u_deleted", visitorId: visitor },
      availableAt: NOW,
    });
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW)).toBe(
    "quarantine:orphan",
  );
  expect(await one(id, "data_author_erasure")).toBe("kept");
  expect(await jobsOf(db(), ["data_author_erasure"], id)).toHaveLength(1);
  await queueDataResolve(db(), id, "adopt", await reviewedOf(id), NOW);
  await one(id, "data_resolve");
  await drain({ subject: id });
  expect(await documentsOf(id, visitor)).toBe(0);
});

it("RPC surface: only the lifecycle methods and the platform's handlers are callable", () => {
  // Methods on the class's prototype are what RPC exposes; instance fields (the store) are not.
  const methods = Object.getOwnPropertyNames(ArtifactDocuments.prototype).sort();
  expect(methods).toEqual(
    [
      "alarm",
      "constructor",
      "lifecycleControl",
      "lifecycleErase",
      "lifecycleEraseAuthor",
      "lifecycleExport",
      "lifecycleFence",
      "lifecycleQuarantine",
      "lifecycleResolve",
      "webSocketClose",
      "webSocketMessage",
    ].sort(),
  );
});

it("S3: racing retirements keep the first inventory retirement time", async () => {
  const { artifactId, artifactRow } = await import("./lifecycle.ts");
  const { registerDataObject, runDataErase } = await import("@portifact/services");
  const id = artifactId();
  await artifactRow(id, "u_owner", { state: "purging" });
  await registerDataObject(db(), bucketOf(), "default", id, NOW);
  await deleteArtifactData(db(), bucketOf(), id, NOW);
  const [row] = await jobsOf(db(), ["data_erase"], id);
  let reads = 0;
  let unlock!: () => void;
  let firstWritten!: () => void;
  const both = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const first = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  const bucket = new Proxy(bucketOf(), {
    get(target, p) {
      if (p === "get")
        return async (key: string) => {
          const found = await target.get(key);
          if (key === inventoryKey(id)) {
            if (++reads === 2) unlock();
            await both;
          }
          return found;
        };
      if (p === "put")
        return async (key: string, value: string, options?: R2PutOptions) => {
          const at = JSON.parse(value).retiredAt;
          if (at === NOW + 1) await first;
          const answer = await target.put(key, value, options);
          if (at === NOW) firstWritten();
          return answer;
        };
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await Promise.all([
    runDataErase(db(), bucket, objectsFor(), row!, NOW),
    runDataErase(db(), bucket, objectsFor(), row!, NOW + 1),
  ]);
  const entry = await (await bucketOf().get(inventoryKey(id)))!.json<{ retiredAt: number }>();
  expect(entry.retiredAt).toBe(NOW);
});
