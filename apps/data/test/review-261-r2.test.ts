import { env, runInDurableObject } from "cloudflare:test";
import { schema } from "@portifact/db";
import {
  controlEnvelope,
  inventoryEntry,
  inventoryKey,
  LIFECYCLE_LIMITS,
  reviewedState,
} from "@portifact/domain/artifact-data";
import type { DataObjectRpc } from "@portifact/services";
import {
  deleteArtifactData,
  lifecycleId,
  placeLegalHold,
  queueDataResolve,
  reconcileObject,
  releaseLegalHold,
  runDataErase,
  runDataFence,
  runJob,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;

import {
  bucketOf,
  controlOf,
  D1_NOW,
  dataRowOf,
  db,
  documentsOf,
  inside,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

async function quarantine(id: string, at = NOW) {
  const c = (await controlOf(id))!;
  expect((await rpc(id).lifecycleQuarantine(controlEnvelope(c), "orphan", at)).ok).toBe(true);
  return reviewedState((await controlOf(id))!)!;
}
async function one(id: string, topic: string, now = NOW) {
  const [row] = await jobsOf(db(), [topic], id);
  if (!row) throw new Error("missing job");
  return runJob(db(), bucketOf(), { id: row.id, topic: row.topic }, now, { data: objectsFor() });
}
async function resolve(
  id: string,
  decision: "adopt" | "erase",
  expected?: NonNullable<ReturnType<typeof reviewedState>>,
) {
  await queueDataResolve(
    db(),
    id,
    decision,
    expected ?? reviewedState((await controlOf(id))!)!,
    NOW,
  );
  return one(id, "data_resolve");
}

it("R1: a review of artifact A cannot authorize erasure of artifact B", async () => {
  const a = await withData({ ownerId: "u_shared" });
  const b = await withData({ ownerId: "u_shared" });
  const reviewedA = await quarantine(a.id);
  await quarantine(b.id);
  await resolve(b.id, "erase", reviewedA);
  expect(await documentsOf(b.id)).toBe(1);
});

it("R2: a new quarantine at the same millisecond is not the reviewed quarantine", async () => {
  const { id } = await withData();
  const q1 = await quarantine(id);
  await queueDataResolve(db(), id, "erase", q1, NOW);
  const c = (await controlOf(id))!;
  expect(
    (
      await rpc(id).lifecycleResolve(
        controlEnvelope(c),
        { id: lifecycleId(NOW), decision: "adopt", expected: q1, hold: null },
        NOW,
      )
    ).ok,
  ).toBe(true);
  await quarantine(id, NOW);
  await one(id, "data_resolve");
  expect(await documentsOf(id)).toBe(1);
});

it("R3: identity mismatch refuses operator resolution too", async () => {
  const { id } = await withData();
  const q = await quarantine(id);
  await bucketOf().put(inventoryKey(id), JSON.stringify(inventoryEntry(id, "eu", NOW)));
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "eu", NOW), NOW)).toBe(
    "operator:inventory_region",
  );
  await resolve(id, "erase", q);
  expect(await documentsOf(id)).toBe(1);
});

it("R4: a cancelled purge intent starts a fresh intent after release", async () => {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
  await db().update(schema.artifacts).set({ state: "purging" }).where(eq(schema.artifacts.id, id));
  await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
  const [row] = await jobsOf(db(), ["data_erase"], id);
  const real = objectsFor();
  // Crash after the job has persisted its ID and the object prepared it.
  const crash = {
    ...real,
    object(artifactId: string) {
      const s = real.object(artifactId);
      return new Proxy(s, {
        get(t, p) {
          if (p === "lifecycleErase")
            return async (...args: Parameters<typeof s.lifecycleErase>) => {
              const result = await s.lifecycleErase(...args);
              if (args[0] === "prepare") throw new Error("crash after prepare");
              return result;
            };
          return Reflect.get(t, p);
        },
      });
    },
  };
  await expect(runDataErase(db(), bucketOf(), crash, row!, NOW)).rejects.toThrow(
    "crash after prepare",
  );
  // The already queued hold/release arrive after prepare and cancel the first intent.
  for (const fence of await jobsOf(db(), ["data_fence"], id))
    await runJob(db(), bucketOf(), { id: fence.id, topic: fence.topic }, NOW, {
      data: objectsFor(),
    });
  // The cancelled ID is terminal: the purge stores a new one (after a short wait) and finishes.
  for (let retry = 0; retry < 3; retry++) {
    if ((await jobsOf(db(), ["data_erase"], id)).length === 0) break;
    await one(id, "data_erase");
  }
  expect(await documentsOf(id)).toBe(0);
  expect(await jobsOf(db(), ["data_erase"], id)).toHaveLength(0);
});

it("R6: adopting a D1 hold cannot rewind epochs and consume its later release", async () => {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW)).toBe(
    "quarantine:hold",
  );
  await resolve(id, "adopt");
  await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
  const fences = await jobsOf(db(), ["data_fence"], id);
  for (const row of fences)
    await runJob(db(), bucketOf(), { id: row.id, topic: row.topic }, NOW, { data: objectsFor() });
  expect((await controlOf(id))?.hold).toBeNull();
});

it("RPC negative control: document command and store are unreachable through the binding", async () => {
  const { id } = await withData();
  type Unreachable = (...args: unknown[]) => Promise<unknown>;
  const stub = stubOf(id) as unknown as { create: Unreachable; store: { create: Unreachable } };
  await expect(stub.create({}, {}, "notes", {}, {})).rejects.toThrow();
  await expect(stub.store.create({}, {}, "notes", {}, {})).rejects.toThrow();
});
