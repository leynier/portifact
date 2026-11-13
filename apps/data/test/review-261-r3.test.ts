import type { JobMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { controlEnvelope, inventoryEntry, reviewedState } from "@portifact/domain/artifact-data";
import {
  DATA_ERASE_FRESH_MS,
  type DataObjectRpc,
  deleteArtifactData,
  lifecycleId,
  placeLegalHold,
  queueDataResolve,
  reconcileObject,
  releaseLegalHold,
  runDataErase,
  runJob,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { raceBeforeBatchWith, raceBeforeStatement } from "../../../packages/services/test/race.ts";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  dataRowOf,
  db,
  documentsOf,
  drain,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;
const deliver = (job: Pick<JobMessage, "id" | "topic">, at = NOW, handle = db()) =>
  runJob(handle, bucketOf(), job, at, { data: objectsFor() });

async function place(id: string, time = D1_NOW) {
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: time });
}
async function release(id: string, time = D1_NOW + 1) {
  await releaseLegalHold(db(), { artifactId: id, now: time });
}
/** Delivers fence jobs until none is left, those the deliveries write included (bounded). */
async function fences(id: string) {
  for (let round = 0; round < 6; round += 1) {
    const due = await jobsOf(db(), ["data_fence"], id);
    if (due.length === 0) return;
    for (const job of due) await deliver(job);
  }
}
async function control(id: string) {
  const found = await controlOf(id);
  if (found === null) throw new Error("no control record");
  return found;
}
async function rewind(id: string, epoch = 0) {
  await db()
    .update(schema.artifactData)
    .set({ epoch })
    .where(eq(schema.artifactData.artifactId, id));
}
async function openHoldId(id: string) {
  const [hold] = await db()
    .select({ id: schema.legalHolds.id })
    .from(schema.legalHolds)
    .where(
      sql`${schema.legalHolds.artifactId} = ${id} and ${schema.legalHolds.releasedAt} is null`,
    );
  return hold?.id;
}
/** An object holding a hold D1 knows, with D1's epoch rewound under the object's. */
async function heldThenRewound() {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await rewind(id);
  return id;
}

it("R3-A: a second hold cannot strand the first hold after epochs were rewound", async () => {
  const { id } = await withData({ state: "suspended" });
  for (let i = 0; i < 2; i++) {
    await place(id, D1_NOW + i * 2);
    await fences(id);
    await release(id, D1_NOW + i * 2 + 1);
    await fences(id);
  }
  await place(id, D1_NOW + 4);
  await fences(id);
  const first = (await control(id)).hold;
  expect((await control(id)).epoch).toBe(5);
  // D1 restored behind the object; its current hold remains (the restore seam of the F2 probe).
  await rewind(id);
  await release(id, D1_NOW + 5);
  await place(id, D1_NOW + 6);
  await fences(id); // H1's release and H2's hold both stale at the object's epoch 5.
  expect((await control(id)).hold).toEqual(first); // D1 holds H2: the object stays held.
  await release(id, D1_NOW + 7);
  await fences(id);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect((await control(id)).hold, `stranded ${first?.transition}`).toBeNull();
});

it("R3-B: an obsolete transfer from another source owner ends after one delivery", async () => {
  const { id, ownerId } = await withData();
  const b = `u_b_${crypto.randomUUID()}`;
  const c = `u_c_${crypto.randomUUID()}`;
  const e = controlEnvelope(await control(id));
  const one = { kind: "transfer" as const, transition: "transfer_one", toOwner: b };
  expect((await rpc(id).lifecycleFence({ ...e, epoch: 1 }, one, NOW)).ok).toBe(true);
  const two = { kind: "transfer" as const, transition: "transfer_two", toOwner: c };
  expect((await rpc(id).lifecycleFence({ ...e, ownerId: b, epoch: 2 }, two, NOW)).ok).toBe(true);
  // D1 restored to after A -> B was queued, before its delivery; the object remains at C.
  await db().update(schema.artifacts).set({ ownerId: b }).where(eq(schema.artifacts.id, id));
  await rewind(id, 1);
  await db()
    .insert(schema.outbox)
    .values({
      topic: "data_fence",
      subject: id,
      payload: { ownerId, generation: 0, epoch: 1, fence: one },
      availableAt: NOW,
    });
  const [job] = await jobsOf(db(), ["data_fence"], id);
  if (job === undefined) throw new Error("no job");
  expect(await deliver(job)).toBe("stale");
  // Gone after one delivery, and never moved ahead of the object's epoch.
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect((await dataRowOf(id))?.epoch).toBe(1);
  // The ownership disagreement is the identity path's: a finding, then the operator's repair.
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW)).toBe(
    "quarantine:owner",
  );
  await db().update(schema.artifacts).set({ ownerId: c }).where(eq(schema.artifacts.id, id));
  const reviewed = reviewedState(await control(id));
  if (reviewed === null) throw new Error("not quarantined");
  await queueDataResolve(db(), id, "adopt", reviewed, NOW);
  await drain({ subject: id });
  expect(await jobsOf(db(), ["data_fence", "data_resolve"], id)).toEqual([]);
  expect((await control(id)).ownerId).toBe(c);
});

it("R3-D: a new hold placed before the corrective's batch is kept", async () => {
  const id = await heldThenRewound();
  await release(id);
  const [stale] = await jobsOf(db(), ["data_fence"], id);
  if (stale === undefined) throw new Error("no job");
  let newHold: string | undefined;
  const raced = raceBeforeBatchWith(/^insert into "outbox"/, async () => {
    await place(id, D1_NOW + 2);
    newHold = await openHoldId(id);
  });
  expect(await deliver(stale, NOW, raced)).toBe("stale");
  expect(newHold).toBeDefined();
  await fences(id);
  expect((await control(id)).hold?.transition).toBe(newHold);
  expect(await documentsOf(id)).toBe(1);
});

it("R3-E: a new hold placed after the corrective's batch is kept", async () => {
  const id = await heldThenRewound();
  await release(id);
  const [stale] = await jobsOf(db(), ["data_fence"], id);
  if (stale === undefined) throw new Error("no job");
  let newHold: string | undefined;
  // After the corrective's batch, before the stale job's acknowledgement.
  const raced = raceBeforeStatement(/^delete from "outbox"/, async () => {
    expect(
      (await jobsOf(db(), ["data_fence"], id)).filter((job) => job.id !== stale.id),
    ).toHaveLength(1);
    await place(id, D1_NOW + 2);
    newHold = await openHoldId(id);
  });
  expect(await deliver(stale, NOW, raced)).toBe("stale");
  expect(newHold).toBeDefined();
  // The corrective release and the new hold, in the order the queue lists them, then reversed.
  await fences(id);
  expect((await control(id)).hold?.transition).toBe(newHold);
  expect(await documentsOf(id)).toBe(1);
});

it("R3-F: a review from another region is refused before accessing an object", async () => {
  const { id } = await withData();
  await rpc(id).lifecycleQuarantine(controlEnvelope(await control(id)), "orphan", NOW);
  const q = reviewedState(await control(id));
  if (q === null) throw new Error("not quarantined");
  await queueDataResolve(db(), id, "erase", { ...q, region: "eu" }, NOW);
  const [job] = await jobsOf(db(), ["data_resolve"], id);
  if (job === undefined) throw new Error("no job");
  await runJob(db(), bucketOf(), job, NOW, {
    data: {
      ...objectsFor(),
      object() {
        throw new Error("object must not be accessed");
      },
    },
  });
  expect(await documentsOf(id)).toBe(1);
});

it("R3-G: the quarantine counter survives a payload erase and recreation of the store", async () => {
  const { id } = await withData();
  await rpc(id).lifecycleQuarantine(controlEnvelope(await control(id)), "orphan", NOW);
  const c = await control(id);
  const q = reviewedState(c);
  if (q === null) throw new Error("not quarantined");
  const resolved = await rpc(id).lifecycleResolve(
    controlEnvelope(c),
    { id: lifecycleId(NOW), decision: "erase", expected: q, hold: null },
    NOW,
  );
  expect(resolved.ok).toBe(true);
  const { storeFor } = await import("../src/documents.ts");
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(stubOf(id), (o, s) => {
    o.store = storeFor(s, o.clients);
  });
  expect((await control(id)).quarantines).toBe(q.incarnation);
  await rpc(id).lifecycleQuarantine(controlEnvelope(await control(id)), "orphan", NOW);
  expect(reviewedState(await control(id))?.incarnation).toBe(q.incarnation + 1);
});

/** A purge whose first intent a hold cancelled, the fresh ID stored and waiting. */
async function cancelledPurge() {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await release(id);
  await db().update(schema.artifacts).set({ state: "purging" }).where(eq(schema.artifacts.id, id));
  await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
  const [row] = await jobsOf(db(), ["data_erase"], id);
  if (row === undefined) throw new Error("no job");
  const real = objectsFor();
  const crash = {
    ...real,
    object(artifactId: string) {
      const s = real.object(artifactId);
      return new Proxy(s, {
        get(t, p) {
          if (p === "lifecycleErase")
            return async (...args: Parameters<typeof s.lifecycleErase>) => {
              const result = await s.lifecycleErase(...args);
              if (args[0] === "prepare") throw new Error("after prepare");
              return result;
            };
          return Reflect.get(t, p);
        },
      });
    },
  };
  await expect(runDataErase(db(), bucketOf(), crash, row, NOW)).rejects.toThrow("after prepare");
  await fences(id);
  const [job] = await jobsOf(db(), ["data_erase"], id);
  if (job === undefined) throw new Error("no job");
  expect(await deliver(job)).toBe("kept");
  const [fresh] = await jobsOf(db(), ["data_erase"], id);
  if (fresh === undefined) throw new Error("no job");
  expect(fresh.payload).not.toEqual(job.payload);
  expect(fresh.availableAt).toBe(NOW + DATA_ERASE_FRESH_MS);
  return { id, job: fresh };
}

it("R3-I: a crash before the fresh prepare keeps its ID, and duplicate purge jobs finish", async () => {
  const { id, job } = await cancelledPurge();
  const real = objectsFor();
  const crash = {
    ...real,
    object(artifactId: string) {
      const s = real.object(artifactId);
      return new Proxy(s, {
        get(t, p) {
          if (p === "lifecycleErase")
            return async (...args: Parameters<typeof s.lifecycleErase>) => {
              if (args[0] === "prepare") throw new Error("before fresh prepare");
              return s.lifecycleErase(...args);
            };
          return Reflect.get(t, p);
        },
      });
    },
  };
  await expect(runDataErase(db(), bucketOf(), crash, job, NOW + 60_000)).rejects.toThrow(
    "before fresh prepare",
  );
  expect((await jobsOf(db(), ["data_erase"], id))[0]?.payload).toEqual(job.payload);
  const [duplicate] = await db()
    .insert(schema.outbox)
    .values({ topic: "data_erase", subject: id, payload: job.payload, availableAt: NOW + 60_000 })
    .returning();
  if (duplicate === undefined) throw new Error("no duplicate");
  await Promise.all([deliver(job, NOW + 60_000), deliver(duplicate, NOW + 60_000)]);
  await drain({ subject: id, now: NOW + 60_001 });
  expect(await documentsOf(id)).toBe(0);
  expect(await jobsOf(db(), ["data_erase"], id)).toEqual([]);
});

it("R3-J: a held object keeps its payload through two purge jobs, then erases after release", async () => {
  const { id, job } = await cancelledPurge();
  const c = await control(id);
  const e = { ...controlEnvelope(c), epoch: c.epoch + 1 };
  const held = await rpc(id).lifecycleFence(
    e,
    { kind: "hold", transition: "hold_after_cancel" },
    NOW,
  );
  expect(held.ok).toBe(true);
  const [duplicate] = await db()
    .insert(schema.outbox)
    .values({ topic: "data_erase", subject: id, payload: job.payload, availableAt: NOW + 60_000 })
    .returning();
  if (duplicate === undefined) throw new Error("no duplicate");
  await Promise.all([deliver(job, NOW + 60_000), deliver(duplicate, NOW + 60_000)]);
  expect(await documentsOf(id)).toBe(1);
  expect((await jobsOf(db(), ["data_erase"], id)).length).toBe(2);
  const released = await rpc(id).lifecycleFence(
    { ...e, epoch: e.epoch + 1 },
    { kind: "release", transition: "hold_after_cancel:release" },
    NOW + 60_001,
  );
  expect(released.ok).toBe(true);
  await drain({ subject: id, now: NOW + 86_500_001 });
  expect(await documentsOf(id)).toBe(0);
});

it("R3-K: reconciliation keeps a concurrent allocation and concurrent reconciliations converge", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await release(id);
  await fences(id);
  await rewind(id);
  const raced = raceBeforeStatement(/^update "artifact_data"/, async () => {
    await place(id, D1_NOW + 2);
  });
  await reconcileObject(raced, objectsFor(), inventoryEntry(id, "default", NOW), NOW);
  expect((await dataRowOf(id))?.epoch).toBe(1);
  await fences(id);
  await Promise.all([
    reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW),
    reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW),
  ]);
  expect((await dataRowOf(id))?.epoch).toBeGreaterThanOrEqual(1);
  expect((await control(id)).hold).not.toBeNull();
});

it("R3-L: the corrective's epoch claim and its outbox row land together or not at all", async () => {
  const id = await heldThenRewound();
  await release(id);
  const [stale] = await jobsOf(db(), ["data_fence"], id);
  if (stale === undefined) throw new Error("no job");
  const crashed = raceBeforeBatchWith(/^insert into "outbox"/, async () => {
    throw new Error("crash at the corrective's batch");
  });
  await expect(deliver(stale, NOW, crashed)).rejects.toThrow();
  // Nothing of it: D1's epoch is the release's, and the stale job is still there to retry.
  expect((await dataRowOf(id))?.epoch).toBe(1);
  expect((await jobsOf(db(), ["data_fence"], id)).map((job) => job.id)).toEqual([stale.id]);
  expect(await deliver(stale)).toBe("stale");
  const [corrective] = await jobsOf(db(), ["data_fence"], id);
  expect((corrective?.payload as { epoch: number } | undefined)?.epoch).toBe(
    (await dataRowOf(id))?.epoch,
  );
  await fences(id);
  expect((await control(id)).hold).toBeNull();
});

it("two convergence runs racing write one corrective", async () => {
  const id = await heldThenRewound();
  await release(id);
  const [stale] = await jobsOf(db(), ["data_fence"], id);
  if (stale === undefined) throw new Error("no job");
  const [duplicate] = await db()
    .insert(schema.outbox)
    .values({ topic: "data_fence", subject: id, payload: stale.payload, availableAt: NOW })
    .returning();
  if (duplicate === undefined) throw new Error("no duplicate");
  await Promise.all([
    deliver(stale),
    deliver(duplicate),
    reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW),
  ]);
  const left = await jobsOf(db(), ["data_fence"], id);
  expect(left).toHaveLength(1);
  expect((left[0]?.payload as { epoch: number } | undefined)?.epoch).toBe(
    (await dataRowOf(id))?.epoch,
  );
  await fences(id);
  expect((await control(id)).hold).toBeNull();
});
