// The decisions on the second review of PR 261 that the review's own reproductions (in
// review-261-r2.test.ts, R1 and R2 for F1) do not already state: F2's sequence in both delivery
// orders, and the fence a rewound D1 can no longer apply, which the job takes a new epoch for.

import { schema } from "@portifact/db";
import { controlEnvelope, reviewedState } from "@portifact/domain/artifact-data";
import {
  type DataObjectRpc,
  placeLegalHold,
  queueDataResolve,
  releaseLegalHold,
  runJob,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  DATA_NOW,
  dataRowOf,
  db,
  jobsOf,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;

async function fences(id: string): Promise<number[]> {
  return (await jobsOf(db(), ["data_fence"], id)).map((row) => row.id);
}

async function deliver(id: number): Promise<string> {
  return runJob(db(), bucketOf(), { id, topic: "data_fence" }, DATA_NOW, { data: objectsFor() });
}

describe("F2: a hold released in D1 ends released in the object", () => {
  for (const releaseFirst of [false, true]) {
    it(`hold pending, quarantine, adopt, release, then the ${releaseFirst ? "release's" : "hold's"} fence first`, async () => {
      const { id } = await withData({ state: "suspended" });
      await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
      const [hold] = await fences(id);
      const control = await controlOf(id);
      if (control === null || hold === undefined) throw new Error("setup");
      await rpc(id).lifecycleQuarantine(controlEnvelope(control), "orphan", DATA_NOW);
      const quarantined = await controlOf(id);
      const reviewed = quarantined === null ? null : reviewedState(quarantined);
      if (reviewed === null) throw new Error("setup");
      await queueDataResolve(db(), id, "adopt", reviewed, DATA_NOW);
      const [resolve] = await jobsOf(db(), ["data_resolve"], id);
      await runJob(db(), bucketOf(), { id: resolve?.id ?? 0, topic: "data_resolve" }, DATA_NOW, {
        data: objectsFor(),
      });
      const epochs = [(await dataRowOf(id))?.epoch ?? 0];
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
      const release = (await fences(id)).filter((job) => job !== hold);
      for (const job of releaseFirst ? [...release, hold] : [hold, ...release]) {
        await deliver(job);
        epochs.push((await dataRowOf(id))?.epoch ?? 0);
      }
      expect((await controlOf(id))?.hold).toBeNull();
      expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
      expect(epochs).toEqual([...epochs].sort((a, b) => a - b));
    });
  }

  it("takes a new epoch for a release a rewound D1 numbered at the object's epoch", async () => {
    const { id } = await withData({ state: "suspended" });
    await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
    for (const job of await fences(id)) await deliver(job);
    expect((await controlOf(id))?.hold).not.toBeNull();
    // A restore rewinds D1's epoch under the object's: the release is then numbered at the epoch
    // the object already holds, which it can no longer apply.
    await db()
      .update(schema.artifactData)
      .set({ epoch: 0 })
      .where(eq(schema.artifactData.artifactId, id));
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    const [release] = await fences(id);
    expect(await deliver(release ?? 0)).toBe("done");
    expect((await controlOf(id))?.hold).toBeNull();
    expect((await dataRowOf(id))?.epoch).toBe(2);
    expect(await fences(id)).toEqual([]);
  });

  it("does not take a new epoch for a hold D1 no longer wants", async () => {
    const { id } = await withData({ state: "suspended" });
    await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
    const [hold] = await fences(id);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    for (const job of (await fences(id)).filter((job) => job !== hold)) await deliver(job);
    const epoch = (await dataRowOf(id))?.epoch;
    expect(await deliver(hold ?? 0)).toBe("stale");
    expect((await controlOf(id))?.hold).toBeNull();
    expect((await dataRowOf(id))?.epoch).toBe(epoch);
    expect(await fences(id)).toEqual([]);
  });
});
