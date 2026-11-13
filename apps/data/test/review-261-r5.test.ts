// The fifth review of PR #261 (at 46d6bddd): R5-A in its three variants (one through the real
// services, with no restore and no hand-written fence) and R5-G, each a failing test before its
// fix, with the review's passing controls. R5-A is an ordinary sequence the round-four release
// check broke: a release discarded because a later hold was open left the object holding the old
// hold, so the transfer behind it and the later hold waited forever.
import type { JobMessage } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { controlEnvelope, inventoryEntry } from "@portifact/domain/artifact-data";
import {
  type DataObjects,
  dataFenceStatements,
  lifecycleId,
  placeLegalHold,
  reconcileObject,
  reinstateArtifact,
  releaseLegalHold,
  runJob,
  suspendArtifact,
  transferArtifact,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { grantPlan, user, value } from "../../../packages/services/test/fixtures.ts";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  db,
  documentsOf,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  withData,
} from "./lifecycle.ts";

const deliver = (job: Pick<JobMessage, "id" | "topic">, data = objectsFor(), now = NOW) =>
  runJob(db(), bucketOf(), job, now, { data });
async function place(id: string, n = 0) {
  return placeLegalHold(db(), {
    artifactId: id,
    ground: "Order",
    releaseAt: null,
    now: D1_NOW + n,
  });
}
const release = (id: string, n = 1) => releaseLegalHold(db(), { artifactId: id, now: D1_NOW + n });
/** Delivers fence jobs, those the deliveries write included, for a bounded number of rounds. */
async function fences(id: string) {
  for (let round = 0; round < 8; round += 1) {
    const due = await jobsOf(db(), ["data_fence"], id);
    if (due.length === 0) return;
    for (const job of due) await deliver(job, objectsFor(), NOW + round * 120_000);
  }
}
/** A D1 transfer as `transferArtifact` writes it (the review's helper). */
async function transfer(id: string, to: string) {
  await db().update(schema.artifacts).set({ state: "archived" }).where(eq(schema.artifacts.id, id));
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
const findings = (id: string) =>
  db().select().from(schema.dataFindings).where(eq(schema.dataFindings.artifactId, id));
const open = (id: string) =>
  db()
    .select()
    .from(schema.legalHolds)
    .where(
      sql`${schema.legalHolds.artifactId} = ${id} and ${schema.legalHolds.releasedAt} is null`,
    );
async function control(id: string) {
  const found = await controlOf(id);
  if (found === null) throw new Error("no control record");
  return found;
}
/** Objects that run `act` once, right before the first fence reaches an object. */
function beforeFence(act: () => Promise<void>): DataObjects {
  const real = objectsFor();
  let fired = false;
  return {
    ...real,
    object(artifactId) {
      const stub = real.object(artifactId);
      return new Proxy(stub, {
        get(target, prop) {
          if (prop === "lifecycleFence") {
            return async (...args: Parameters<typeof stub.lifecycleFence>) => {
              if (!fired) {
                fired = true;
                await act();
              }
              return stub.lifecycleFence(...args);
            };
          }
          return Reflect.get(target, prop);
        },
      });
    },
  };
}
const workspaceId = () => `ws_${crypto.randomUUID().replaceAll("-", "")}`;

it("R5-A: a new hold after a transfer does not strand the transfer behind the old hold", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id); // H1 acknowledged under A.
  await release(id); // H1's release waits in the outbox.
  const next = workspaceId();
  await transfer(id, next); // D1 holds nothing: A to B is allowed.
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended" })
    .where(eq(schema.artifacts.id, id));
  await place(id, 2); // H2 under B before any of the three jobs runs.
  await fences(id);
  expect(await documentsOf(id)).toBe(1);
  expect(await open(id)).toHaveLength(1);
  expect(await jobsOf(db(), ["data_fence"], id), "no permanent held-transfer wait").toEqual([]);
  // As before round four: the old release, the transfer, then H2, in order.
  expect((await control(id)).ownerId).toBe(next);
  expect((await control(id)).hold?.transition).toBe((await open(id))[0]?.id);
  expect(await findings(id)).toEqual([]);
});

it("R5-A real services: no held-transfer deadlock without a restore or a written fence", async () => {
  const owner = await user("R5 owner");
  const { id } = await withData({ ownerId: owner.id });
  const target = workspaceId();
  const slug = `r5${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await db()
    .global.insert(schema.workspaces)
    .values({ id: target, slug, name: "R5", createdBy: owner.id, updatedAt: D1_NOW });
  await db()
    .global.insert(schema.workspaceMembers)
    .values({ workspaceId: target, userId: owner.id, role: "admin", updatedAt: D1_NOW });
  await grantPlan(target, "team", { seats: 5 });
  value(
    await suspendArtifact(db(), {
      artifactId: id,
      reason: "other",
      note: "First order",
      now: D1_NOW,
    }),
  );
  value(await place(id));
  await fences(id);
  expect(await release(id)).toEqual({ released: true });
  value(await reinstateArtifact(db(), { artifactId: id, now: D1_NOW + 2 }));
  value(
    await transferArtifact(db(), bucketOf(), {
      artifactId: id,
      userId: owner.id,
      workspace: slug,
      now: D1_NOW + 3,
    }),
  );
  value(
    await suspendArtifact(db(), {
      artifactId: id,
      reason: "other",
      note: "Second order",
      now: D1_NOW + 4,
    }),
  );
  value(await place(id, 5));
  await fences(id);
  expect(await documentsOf(id)).toBe(1);
  expect(await jobsOf(db(), ["data_fence"], id), "release, transfer and new hold all land").toEqual(
    [],
  );
  expect((await control(id)).ownerId).toBe(target);
  expect((await control(id)).hold).not.toBeNull();
});

it("R5-A release variant: releasing H2 as well leaves the object free under B", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await release(id);
  const next = workspaceId();
  await transfer(id, next);
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended" })
    .where(eq(schema.artifacts.id, id));
  await place(id, 2);
  // The old release is delivered while H2 is open.
  const [oldRelease] = await jobsOf(db(), ["data_fence"], id);
  if (oldRelease === undefined) throw new Error("no job");
  await deliver(oldRelease);
  await release(id, 3);
  await fences(id);
  expect(await open(id)).toEqual([]);
  expect((await control(id)).hold, "every D1 hold is released, and so is the object").toBeNull();
  expect((await control(id)).ownerId).toBe(next);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
});

it("R5-B: a new hold placed and released inside a release's delivery window converges free", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await release(id);
  const [job] = await jobsOf(db(), ["data_fence"], id);
  if (job === undefined) throw new Error("no job");
  await deliver(
    job,
    beforeFence(async () => {
      await place(id, 2);
      await release(id, 3);
      for (const other of (await jobsOf(db(), ["data_fence"], id)).filter((j) => j.id !== job.id)) {
        await deliver(other);
      }
    }),
  );
  await fences(id);
  expect(await open(id)).toEqual([]);
  expect((await control(id)).hold).toBeNull();
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
});

it("R5-C: a hold released inside its own delivery window converges free", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  const [job] = await jobsOf(db(), ["data_fence"], id);
  if (job === undefined) throw new Error("no job");
  await deliver(
    job,
    beforeFence(async () => {
      await release(id);
      for (const other of (await jobsOf(db(), ["data_fence"], id)).filter((j) => j.id !== job.id)) {
        await deliver(other);
      }
    }),
  );
  await fences(id);
  expect((await control(id)).hold).toBeNull();
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
});

it("R5-D: another artifact's open hold does not keep this artifact's release back", async () => {
  const left = await withData({ state: "suspended" });
  const right = await withData({ state: "suspended" });
  await place(left.id);
  await place(right.id);
  await fences(left.id);
  await fences(right.id);
  await release(left.id);
  await fences(left.id);
  expect((await control(left.id)).hold).toBeNull();
  expect((await control(right.id)).hold).not.toBeNull();
  expect(await open(right.id)).toHaveLength(1);
});

it("R5-F: a hold D1 holds still cancels a prepared erase through the job", async () => {
  const { id } = await withData({ state: "suspended" });
  const before = await control(id);
  const prepared = await objectsFor()
    .object(id)
    .lifecycleErase("prepare", controlEnvelope(before), lifecycleId(NOW), "purge", NOW);
  expect(prepared.ok).toBe(true);
  await place(id);
  await fences(id);
  expect((await control(id)).lastErase?.outcome).toBe("cancelled");
  expect((await control(id)).hold).not.toBeNull();
  expect(await documentsOf(id)).toBe(1);
});

it("R5-H: an ordinary hold, release and transfer converges without a later hold", async () => {
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await release(id);
  const target = workspaceId();
  await transfer(id, target);
  await fences(id);
  expect((await control(id)).ownerId).toBe(target);
  expect((await control(id)).hold).toBeNull();
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
});

it("R5 restore variant: a re-opened hold with no fence ends the held transfer with a finding", async () => {
  // Item 2: the object holds H1; D1 released it and queued the transfer; a restore brought H2 back
  // open through `applyLegalHolds` without any fence. The old release is obsolete (H2 open, no fence
  // of H2 waiting), so the transfer the object refuses as held has no release to wait on: it ends,
  // and the job records the owner finding. The object keeps its hold, and nothing waits.
  const { id } = await withData({ state: "suspended" });
  await place(id);
  await fences(id);
  await release(id);
  const next = workspaceId();
  await transfer(id, next);
  // As `applyLegalHolds` re-opens an exported hold: the row, and no fence.
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended" })
    .where(eq(schema.artifacts.id, id));
  await db()
    .insert(schema.legalHolds)
    .values({
      id: `hold_${crypto.randomUUID().replaceAll("-", "")}`,
      artifactId: id,
      ownerId: next,
      reason: "other",
      ground: "Order",
    });
  await fences(id);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect((await control(id)).hold).not.toBeNull();
  expect(await documentsOf(id)).toBe(1);
  expect((await findings(id)).map((row) => [row.action, row.reason])).toEqual([
    ["refused", "owner"],
  ]);
});

describe("the ordinary sequences end as before round four, in every delivery order", () => {
  type Step = "place" | "release" | "transfer";
  const permutations = (items: number[]): number[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((first, index) =>
          permutations(items.filter((_, other) => other !== index)).map((rest) => [first, ...rest]),
        );
  const sequences: { name: string; first: boolean; steps: Step[] }[] = [
    {
      name: "a hold then its release (placed and released before any delivery)",
      first: false,
      steps: ["place", "release"],
    },
    {
      name: "a hold, its release, a transfer",
      first: false,
      steps: ["place", "release", "transfer"],
    },
    {
      name: "a hold, its release, a transfer, a hold",
      first: false,
      steps: ["place", "release", "transfer", "place"],
    },
    {
      name: "a hold, its release, a transfer, a hold and its release",
      first: false,
      steps: ["place", "release", "transfer", "place", "release"],
    },
    {
      name: "R5-A: the first hold delivered, its release, a transfer, a hold",
      first: true,
      steps: ["place", "release", "transfer", "place"],
    },
    {
      name: "R5-A: the first hold delivered, its release, a transfer, a hold and its release",
      first: true,
      steps: ["place", "release", "transfer", "place", "release"],
    },
  ];
  for (const sequence of sequences) {
    const queued = sequence.steps.length - (sequence.first ? 1 : 0);
    const all = permutations(Array.from({ length: queued }, (_, n) => n));
    describe(`${sequence.name} (${all.length} orders)`, () => {
      for (let start = 0; start < all.length; start += 3) {
        it(`orders ${start + 1} to ${Math.min(start + 3, all.length)}`, async () => {
          for (const order of all.slice(start, start + 3)) {
            const { id, ownerId } = await withData({ state: "suspended" });
            let owner = ownerId;
            for (const [index, step] of sequence.steps.entries()) {
              if (step === "place") {
                await db()
                  .update(schema.artifacts)
                  .set({ state: "suspended" })
                  .where(eq(schema.artifacts.id, id));
                value(await place(id, index * 2));
              }
              if (step === "release") await release(id, index * 2 + 1);
              if (step === "transfer") {
                owner = workspaceId();
                await transfer(id, owner);
              }
              if (index === 0 && sequence.first) await fences(id);
            }
            const jobs = await jobsOf(db(), ["data_fence"], id);
            for (let round = 0; round < 5; round += 1) {
              for (const index of order) {
                const job = jobs[index];
                if (job) await deliver(job, objectsFor(), NOW + round * 120_000);
              }
            }
            await fences(id);
            const label = `order ${order.join(",")}`;
            expect(await jobsOf(db(), ["data_fence"], id), label).toEqual([]);
            const held = (await open(id))[0]?.id ?? null;
            expect((await control(id)).hold?.transition ?? null, label).toBe(held);
            expect((await control(id)).ownerId, label).toBe(owner);
            expect(await findings(id), label).toEqual([]);
            expect(await documentsOf(id), label).toBe(1);
          }
        });
      }
    });
  }
});
