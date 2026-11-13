// The fourth review of PR #261 (at 361ecf7f): R4-A and R4-B as failing tests before their fixes,
// the mirror of R4-A the maintainer asked for, and the race at the new delivery-time check in both
// orders. Both blockers are what a fence job did at delivery after a restore: a queued release sent
// while D1 holds again (R4-1), and fences under a missing owner waiting on each other (R4-2).
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { inventoryEntry } from "@portifact/domain/artifact-data";
import {
  applyLegalHolds,
  type DataObjects,
  dataFenceStatements,
  exportLegalHolds,
  placeLegalHold,
  reconcileObject,
  releaseLegalHold,
  runJob,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  dataRowOf,
  db,
  documentsOf,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  withData,
} from "./lifecycle.ts";

const deliver = (job: Pick<JobMessage, "id" | "topic">, now = NOW, data = objectsFor()) =>
  runJob(db(), bucketOf(), job, now, { data });
async function place(id: string, n = 0) {
  const placed = await placeLegalHold(db(), {
    artifactId: id,
    ground: "Order",
    releaseAt: null,
    now: D1_NOW + n,
  });
  if (!placed.ok) throw new Error("hold placement refused");
  return placed.value.hold.id;
}
const release = (id: string, n = 1) => releaseLegalHold(db(), { artifactId: id, now: D1_NOW + n });
/** Delivers fence jobs, those the deliveries write included, for a bounded number of rounds. */
async function fences(id: string, rounds = 8) {
  for (let round = 0; round < rounds; round += 1) {
    const due = await jobsOf(db(), ["data_fence"], id);
    if (due.length === 0) return;
    for (const job of due) await deliver(job, NOW + round * 120_000);
  }
}
async function rewind(id: string, epoch = 0) {
  await db()
    .update(schema.artifactData)
    .set({ epoch })
    .where(eq(schema.artifactData.artifactId, id));
}
async function openHolds(id: string) {
  const h = schema.legalHolds;
  return (
    await db()
      .select({ id: h.id })
      .from(h)
      .where(sql`${h.artifactId} = ${id} and ${h.releasedAt} is null`)
  ).map((row) => row.id);
}
const findings = (id: string) =>
  db().select().from(schema.dataFindings).where(eq(schema.dataFindings.artifactId, id));
/** A D1 transfer as `transferArtifact` writes it: the fence under the old owner, then the move. */
async function transfer(id: string, to: string) {
  const [artifact] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  const [raise, job] = dataFenceStatements(db(), {
    which: sql`d.artifact_id = ${id}`,
    fence: sql`json_object('kind', 'transfer', 'transition', ${`transfer_${crypto.randomUUID().replaceAll("-", "")}`}, 'toOwner', ${to})`,
    owner: sql`${artifact?.ownerId ?? ""}`,
    now: D1_NOW + 50,
  });
  if (raise === undefined || job === undefined) throw new Error("no statements");
  await db().batch([
    raise,
    job,
    db().update(schema.artifacts).set({ ownerId: to }).where(eq(schema.artifacts.id, id)),
  ]);
}

it("R4-A: a queued corrective release cannot lose a hold re-applied after a second restore", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await rewind(id);
  await release(id);
  const [stale] = await jobsOf(db(), ["data_fence"], id);
  if (stale === undefined) throw new Error("no job");
  await deliver(stale);
  const [corrective] = await jobsOf(db(), ["data_fence"], id);
  if (corrective === undefined) throw new Error("no corrective");
  expect(corrective.payload).toHaveProperty("claim");
  const at = await dataRowOf(id);
  // The restore point: H1 released in D1, held in the object, its corrective durable.
  const h2 = await place(id, 2);
  const lines = (await exportLegalHolds(regionsFromEnv(env))).filter(
    (line) => line.legalHold.artifactId === id,
  );
  // D1 restored to the point; the object and R2 are not rewound. Then the runbook re-applies holds.
  await db().delete(schema.legalHoldIdentities).where(eq(schema.legalHoldIdentities.holdId, h2));
  await db().delete(schema.legalHolds).where(eq(schema.legalHolds.id, h2));
  await db()
    .delete(schema.outbox)
    .where(sql`${schema.outbox.subject} = ${id} and ${schema.outbox.id} > ${corrective.id}`);
  await rewind(id, at?.epoch ?? 0);
  expect((await applyLegalHolds(regionsFromEnv(env), lines, NOW)).restored).toBe(1);
  // The runbook's reconciliation, before the queued corrective: both sides hold.
  expect(await reconcileObject(db(), objectsFor(), inventoryEntry(id, "default", NOW), NOW)).toBe(
    "none",
  );
  await fences(id);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect(await openHolds(id)).toEqual([h2]);
  expect((await controlOf(id))?.hold, "D1 holds H2: the object must stay held").not.toBeNull();
  expect(await documentsOf(id)).toBe(1);
});

it("R4-A mirror: a queued hold fence whose hold a restore left released never holds alone", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  const [holdFence] = await jobsOf(db(), ["data_fence"], id);
  if (holdFence === undefined) throw new Error("no job");
  // The restore brought back the outbox of a point before the release and the hold rows of one
  // after it (the release's own job lost): the hold is released in D1 and its fence still queued.
  await db()
    .update(schema.legalHolds)
    .set({ releasedAt: D1_NOW + 1 })
    .where(eq(schema.legalHolds.artifactId, id));
  await fences(id);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect(await openHolds(id)).toEqual([]);
  expect((await controlOf(id))?.hold ?? null, "D1 holds nothing: the object must not").toBeNull();
});

describe("a hold placed between the delivery-time level read and the object call", () => {
  for (const order of ["the new hold's fence first", "the release first"] as const) {
    it(`keeps the new hold, ${order}`, async () => {
      const { id } = await withData({ state: "suspended" });
      await place(id);
      await fences(id);
      await release(id);
      const [releaseFence] = await jobsOf(db(), ["data_fence"], id);
      if (releaseFence === undefined) throw new Error("no job");
      let fired = false;
      const real = objectsFor();
      const racing: DataObjects = {
        ...real,
        object(artifactId) {
          const stub = real.object(artifactId);
          return new Proxy(stub, {
            get(target, prop) {
              if (prop === "lifecycleFence" && !fired) {
                return async (...args: Parameters<typeof stub.lifecycleFence>) => {
                  fired = true;
                  await place(id, 5);
                  if (order === "the new hold's fence first") {
                    const [newHold] = (await jobsOf(db(), ["data_fence"], id)).filter(
                      (job) => job.id !== releaseFence.id,
                    );
                    if (newHold) await deliver(newHold);
                  }
                  return stub.lifecycleFence(...args);
                };
              }
              return Reflect.get(target, prop);
            },
          });
        },
      };
      await deliver(releaseFence, NOW, racing);
      expect(fired).toBe(true);
      await fences(id);
      expect(await openHolds(id)).toHaveLength(1);
      expect((await controlOf(id))?.hold?.transition).toBe((await openHolds(id))[0]);
      expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
    });
  }
});

/** R4-B's D1 history: the object at A and epoch 2, then a rewind and three transfers. */
async function threeTransfers() {
  const { id, ownerId } = await withData({ state: "suspended" });
  await place(id);
  await release(id);
  await fences(id);
  await rewind(id);
  const b = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const c = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await transfer(id, b); // epoch 1: under the object's epoch 2, it can never apply
  await place(id, 2);
  await release(id, 3); // epochs 2 and 3 under B
  await transfer(id, c); // epoch 4, B -> C
  await transfer(id, b); // epoch 5, C -> B
  return { id, ownerId };
}

it("R4-B: waiting transfers cannot justify each other forever after the first ended stale", async () => {
  const { id, ownerId } = await threeTransfers();
  await fences(id);
  expect((await controlOf(id))?.ownerId).toBe(ownerId);
  expect((await dataRowOf(id))?.epoch).toBe(5);
  expect(await jobsOf(db(), ["data_fence"], id), "no waiting cycle").toEqual([]);
  // The job records the owner disagreement itself; no reconciliation was run.
  expect((await findings(id)).map((row) => [row.action, row.reason])).toEqual([
    ["refused", "owner"],
  ]);
});

describe("R4-B's jobs in every delivery order", () => {
  const permutations = (items: number[]): number[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((first, index) =>
          permutations(items.filter((_, other) => other !== index)).map((rest) => [first, ...rest]),
        );
  // The five fences R4-B queues, delivered one at a time in every order (120 orders), a bounded
  // number of times each: every job ends.
  const all = permutations([0, 1, 2, 3, 4]);
  for (let start = 0; start < all.length; start += 8) {
    it(`orders ${start + 1} to ${Math.min(start + 8, all.length)} end`, async () => {
      for (const order of all.slice(start, start + 8)) {
        const { id } = await threeTransfers();
        const jobs = await jobsOf(db(), ["data_fence"], id);
        for (let round = 0; round < 5; round += 1) {
          for (const index of order) {
            const job = jobs[index];
            if (job) await deliver(job, NOW + round * 120_000);
          }
        }
        expect(await jobsOf(db(), ["data_fence"], id), `order ${order.join(",")}`).toEqual([]);
      }
    });
  }
});
