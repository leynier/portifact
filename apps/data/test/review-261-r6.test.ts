// The sixth review of PR #261 (at cc38e93e): R6-1 through the real services (an account
// deletion's author erasure under a hold D1 has open, in the ordinary interval before that hold's
// fence lands), the same for a purge's whole erase, the controls without a hold, and the
// discriminators R6-3 asked for: what may count as the open hold's waiting fence.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  advanceAccountDeletion,
  type DataObjects,
  deleteArtifactData,
  placeLegalHold,
  releaseLegalHold,
  requestAccountDeletion,
  runDataFence,
  runJob,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { session, user, value } from "../../../packages/services/test/fixtures.ts";
import {
  bucketOf,
  claimJournal,
  controlOf,
  D1_NOW,
  db,
  documentsOf,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  visitorId,
  withData,
} from "./lifecycle.ts";

const DAY = 86_400_000;
const run = (job: Pick<JobMessage, "id" | "topic">, now = NOW) =>
  runJob(db(), bucketOf(), job, now, { data: objectsFor() });
const place = (artifactId: string, now = D1_NOW) =>
  placeLegalHold(db(), { artifactId, ground: "Court order", releaseAt: null, now });
async function control(id: string) {
  const found = await controlOf(id);
  if (found === null) throw new Error("no control record");
  return found;
}
async function fences(id: string, now = NOW) {
  for (let round = 0; round < 8; round += 1) {
    const due = await jobsOf(db(), ["data_fence"], id);
    if (due.length === 0) return;
    for (const job of due) await run(job, now);
  }
}

/**
 * R6-1's start: a visitor's document and their journal entry; H1 delivered; H1 released; H2
 * placed with its fence waiting; the old release delivered, so the object is free while D1 holds
 * H2 (the ordinary interval before H2's fence lands). Then the visitor's account is deleted.
 */
async function authorUnderOpenHold(withHold: boolean) {
  const author = await user("R6 author");
  const visitor = visitorId();
  const { id } = await withData({ state: "suspended", visitors: [visitor] });
  await claimJournal(author.id, id, visitor);
  let h2: string | null = null;
  if (withHold) {
    value(await place(id));
    await fences(id);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    const [release] = await jobsOf(db(), ["data_fence"], id);
    h2 = value(await place(id, D1_NOW + 2)).hold.id;
    if (release === undefined) throw new Error("no release");
    await run(release);
    expect((await control(id)).hold, "the object is free while D1 holds H2").toBeNull();
  }
  value(
    await requestAccountDeletion(regionsFromEnv(env), {
      userId: author.id,
      sessionId: await session(author.id, NOW),
      confirmEmail: author.email,
      now: NOW,
    }),
  );
  await advanceAccountDeletion(regionsFromEnv(env), author.id, NOW);
  const [erasure] = await jobsOf(db(), ["data_author_erasure"], id);
  if (erasure === undefined) throw new Error("no erasure job");
  return { id, visitor, h2, erasure };
}

describe("R6-1: an erasing job asks D1 for its hold at delivery", () => {
  it("keeps an author erasure while D1 holds, then finishes it after the release", async () => {
    const { id, visitor, h2, erasure } = await authorUnderOpenHold(true);
    expect(await run(erasure)).toBe("kept");
    // H2 lands on the whole payload.
    await fences(id);
    expect((await control(id)).hold?.transition).toBe(h2);
    expect(await documentsOf(id, visitor), "a D1-open hold keeps the author's payload").toBe(1);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toHaveLength(1);
    // Released and acknowledged: the release wakes the job, which erases.
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 3 });
    await fences(id);
    for (const job of await jobsOf(db(), ["data_author_erasure"], id)) await run(job, NOW + 1);
    expect(await documentsOf(id, visitor)).toBe(0);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toEqual([]);
  });

  it("erases at once without a hold (control)", async () => {
    const { id, visitor, erasure } = await authorUnderOpenHold(false);
    expect(await run(erasure)).toBe("done");
    expect(await documentsOf(id, visitor)).toBe(0);
  });

  /**
   * A purge's job queued, and D1 holding the artifact again: the projection a restore leaves when
   * `applyLegalHolds` re-opens an exported hold whose fence the object never saw.
   */
  async function purgeUnderHold(withHold: boolean) {
    const { id, ownerId } = await withData({ state: "suspended", documents: 2 });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, id));
    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
    const [erase] = await jobsOf(db(), ["data_erase"], id);
    if (erase === undefined || artifact === undefined) throw new Error("no erase job");
    const hold = `hold_${crypto.randomUUID().replaceAll("-", "")}`;
    if (withHold) {
      // D1 brought back to a point where the artifact is suspended and held, the job still queued.
      const tombstone = sql`${schema.tombstones.kind} = 'artifact' and ${schema.tombstones.id} = ${id}`;
      await db().global.delete(schema.tombstones).where(tombstone);
      await db()
        .insert(schema.artifacts)
        .values({ ...artifact, state: "suspended" });
      await db()
        .insert(schema.legalHolds)
        .values({ id: hold, artifactId: id, ownerId, reason: "other", ground: "Order" });
    }
    return { id, erase, hold };
  }

  it("keeps a purge's whole erase while D1 holds, and erases after the release", async () => {
    const { id, erase, hold } = await purgeUnderHold(true);
    expect(await run(erase)).toBe("kept");
    expect(await documentsOf(id)).toBe(2);
    expect(await jobsOf(db(), ["data_erase"], id)).toHaveLength(1);
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: D1_NOW + 2 })
      .where(eq(schema.legalHolds.id, hold));
    for (const job of await jobsOf(db(), ["data_erase"], id)) await run(job, NOW + DAY);
    expect(await documentsOf(id)).toBe(0);
    expect(await jobsOf(db(), ["data_erase"], id)).toEqual([]);
  });

  it("asks again between the prepare and the commit", async () => {
    const { id, ownerId } = await withData({ state: "suspended", documents: 2 });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, id));
    const [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
    const [erase] = await jobsOf(db(), ["data_erase"], id);
    if (erase === undefined || artifact === undefined) throw new Error("no erase job");
    const hold = `hold_${crypto.randomUUID().replaceAll("-", "")}`;
    const real = objectsFor();
    // A restore re-opens a hold right after the object prepared the erase.
    const restoring: DataObjects = {
      ...real,
      object(artifactId) {
        const stub = real.object(artifactId);
        return new Proxy(stub, {
          get(target, prop) {
            if (prop !== "lifecycleErase") return Reflect.get(target, prop);
            return async (...args: Parameters<typeof stub.lifecycleErase>) => {
              const answer = await stub.lifecycleErase(...args);
              if (args[0] === "prepare") {
                const tombstone = sql`${schema.tombstones.kind} = 'artifact' and ${schema.tombstones.id} = ${id}`;
                await db().global.delete(schema.tombstones).where(tombstone);
                await db()
                  .insert(schema.artifacts)
                  .values({ ...artifact, state: "suspended" });
                await db()
                  .insert(schema.legalHolds)
                  .values({ id: hold, artifactId: id, ownerId, reason: "other", ground: "Order" });
              }
              return answer;
            };
          },
        });
      },
    };
    expect(await runJob(db(), bucketOf(), erase, NOW, { data: restoring })).toBe("kept");
    expect(await documentsOf(id)).toBe(2);
    expect((await control(id)).erasing, "prepared, never committed").not.toBeNull();
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: D1_NOW + 2 })
      .where(eq(schema.legalHolds.id, hold));
    for (const job of await jobsOf(db(), ["data_erase"], id)) await run(job, NOW + DAY);
    expect(await documentsOf(id)).toBe(0);
  });

  it("erases at once without a hold (control)", async () => {
    const { id, erase } = await purgeUnderHold(false);
    expect(await run(erase)).toBe("done");
    expect(await documentsOf(id)).toBe(0);
  });
});

describe("R6-3: only the open hold's own fence, above the object's epoch, sends a release", () => {
  for (const decoy of [
    "of another hold",
    "of another artifact",
    "of the open hold at the object's epoch",
    "of the open hold below it",
  ] as const) {
    it(`a waiting fence ${decoy} does not`, async () => {
      const { id, ownerId } = await withData({ state: "suspended" });
      value(await place(id));
      await fences(id);
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
      const [release] = await jobsOf(db(), ["data_fence"], id);
      if (release === undefined) throw new Error("no release");
      const h2 = value(await place(id, D1_NOW + 2)).hold.id;
      // A restore left H2 open with no fence of its own; only the decoy waits.
      for (const job of await jobsOf(db(), ["data_fence"], id)) {
        if (job.id !== release.id)
          await db().delete(schema.outbox).where(eq(schema.outbox.id, job.id));
      }
      const before = await control(id);
      const other = decoy === "of another artifact" ? await withData({ state: "suspended" }) : null;
      const epoch =
        decoy === "of the open hold at the object's epoch"
          ? before.epoch
          : decoy === "of the open hold below it"
            ? before.epoch - 1
            : before.epoch + 5;
      await db()
        .insert(schema.outbox)
        .values({
          topic: "data_fence",
          subject: other?.id ?? id,
          availableAt: NOW,
          payload: {
            ownerId,
            generation: 0,
            epoch,
            fence: { kind: "hold", transition: decoy === "of another hold" ? "hold_wrong" : h2 },
          },
        });
      // Killed mutations: the lookup without the hold's name, or without the lower bound.
      expect(await runDataFence(db(), objectsFor(), release, NOW)).toBe("stale");
      expect((await control(id)).hold).toEqual(before.hold);
    });
  }
});
