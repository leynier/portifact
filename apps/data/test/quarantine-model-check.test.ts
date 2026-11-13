// A model check of the messages around a quarantine (second review of PR 261): a legal hold and its
// release, a quarantine, an operator's adopt and erase of what they reviewed, a second quarantine
// and a purge, delivered in every order against the real object and the real services. Two
// families keep each order cheap: one delivers the release's fence as its own message (so an adopt
// can land between a release and its fence, the review's F2), the other adds the purge (which needs
// the release first, and delivers the release's fence with it). After every order: held data is never erased, a resolution only ever applies to the quarantine it reviewed,
// D1's epoch never decreases, a hold released in D1 ends released in the object, and nothing waits
// forever (every job ends once the operator answers whatever quarantine is left).

import { schema } from "@portifact/db";
import { controlEnvelope, reviewedState } from "@portifact/domain/artifact-data";
import {
  type DataObjectRpc,
  deleteArtifactData,
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
  documentsOf,
  drain,
  jobsOf,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

const MESSAGES = [
  "holdFence",
  "release",
  "releaseFence",
  "adopt",
  "erase",
  "quarantine",
  "purge",
] as const;
type Message = (typeof MESSAGES)[number];

function permutations(items: readonly Message[]): Message[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((first, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      first,
      ...rest,
    ]),
  );
}

/** Orders where what needs the release (its fence, the purge) comes after it. */
function orders(items: readonly Message[]): Message[][] {
  return permutations(items).filter((order) => {
    const release = order.indexOf("release");
    return order.every(
      (message, index) => (message !== "releaseFence" && message !== "purge") || index > release,
    );
  });
}

const FAMILIES = [
  {
    name: "the release's fence as its own message",
    orders: orders(["holdFence", "release", "releaseFence", "adopt", "erase", "quarantine"]),
  },
  {
    name: "a purge after the release",
    orders: orders(["holdFence", "release", "adopt", "erase", "quarantine", "purge"]),
  },
];
/** Small enough that a slice stays well inside the per-test limit on a slow runner. */
const SLICE = 4;
const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;

async function runById(id: number, now: number): Promise<void> {
  const [row] = (await db().select().from(schema.outbox).where(eq(schema.outbox.id, id))).filter(
    Boolean,
  );
  if (row === undefined) return;
  await runJob(db(), bucketOf(), { id: row.id, topic: row.topic }, now, { data: objectsFor() });
}

async function newJobs(topic: string, subject: string, before: readonly number[]) {
  return (await jobsOf(db(), [topic], subject))
    .map((row) => row.id)
    .filter((id) => !before.includes(id));
}

async function quarantine(id: string): Promise<void> {
  const control = await controlOf(id);
  if (control === null) return;
  await rpc(id).lifecycleQuarantine(controlEnvelope(control), "orphan", DATA_NOW);
}

/** One order from a fresh artifact; fails at the first broken invariant. */
async function check(order: readonly Message[]): Promise<void> {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  const [holdFence] = await newJobs("data_fence", id, []);
  await quarantine(id);
  const quarantined = await controlOf(id);
  const reviewed = quarantined === null ? null : reviewedState(quarantined);
  if (reviewed === null || holdFence === undefined) throw new Error("setup");
  const resolves: Record<"adopt" | "erase", number> = { adopt: 0, erase: 0 };
  for (const decision of ["adopt", "erase"] as const) {
    const before = (await jobsOf(db(), ["data_resolve"], id)).map((row) => row.id);
    await queueDataResolve(db(), id, decision, reviewed, DATA_NOW);
    resolves[decision] = (await newJobs("data_resolve", id, before))[0] ?? 0;
  }

  let released = false;
  let epoch = (await dataRowOf(id))?.epoch ?? 0;
  const observe = async (step: string) => {
    const row = await dataRowOf(id);
    if (row !== null) {
      expect(row.epoch, `${step}: D1's epoch went back`).toBeGreaterThanOrEqual(epoch);
      epoch = row.epoch;
    }
    if (!released) expect(await documentsOf(id), `${step}: held data erased`).toBe(1);
  };

  const fenceApart = order.includes("releaseFence");
  let releaseFences: number[] = [];
  for (const message of order) {
    if (message === "holdFence") await runById(holdFence, DATA_NOW);
    if (message === "release") {
      const before = (await jobsOf(db(), ["data_fence"], id)).map((row) => row.id);
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
      released = true;
      releaseFences = await newJobs("data_fence", id, before);
    }
    if (message === "releaseFence" || (message === "release" && !fenceApart)) {
      for (const job of releaseFences) await runById(job, DATA_NOW);
    }
    if (message === "adopt" || message === "erase") {
      const before = await controlOf(id);
      const documents = await documentsOf(id);
      await runById(resolves[message], DATA_NOW);
      // Only the reviewed quarantine (incarnation 1) may be resolved; any other stays as it was.
      if (before?.quarantine && before.quarantine.incarnation !== reviewed.incarnation) {
        expect((await controlOf(id))?.quarantine, `${message} resolved another quarantine`).toEqual(
          before.quarantine,
        );
        expect(await documentsOf(id)).toBe(documents);
      }
    }
    if (message === "quarantine") await quarantine(id);
    if (message === "purge" && released) {
      await db()
        .update(schema.artifacts)
        .set({ state: "purging" })
        .where(eq(schema.artifacts.id, id));
      await deleteArtifactData(db(), bucketOf(), id, D1_NOW + 2);
      for (const job of await jobsOf(db(), ["data_erase"], id)) await runById(job.id, DATA_NOW);
    }
    await observe(message);
  }

  // Every message is delivered: the queue keeps running what is left, and the operator answers a
  // quarantine still standing with the state it shows now, as the runbook says.
  let now = DATA_NOW + 60_000;
  const waiting = () => jobsOf(db(), ["data_fence", "data_erase", "data_resolve"], id);
  for (let round = 0; round < 5; round += 1) {
    await drain({ subject: id, now });
    await observe(`drain ${round}`);
    const control = await controlOf(id);
    if (!control?.quarantine && (await waiting()).length === 0) break;
    if (control?.quarantine) {
      const state = reviewedState(control);
      if (state === null) throw new Error("quarantined without a state");
      const [artifact] = await db()
        .select({ state: schema.artifacts.state })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id));
      await queueDataResolve(
        db(),
        id,
        artifact?.state === "purging" || artifact === undefined ? "erase" : "adopt",
        state,
        now,
      );
    }
    now += 10 * 60_000;
  }
  expect(
    (await controlOf(id))?.hold ?? null,
    "released in D1, still held in the object",
  ).toBeNull();
  expect(await waiting(), "a job waits forever").toEqual([]);
}

for (const family of FAMILIES) {
  describe(`every order around a quarantine, ${family.name} (${family.orders.length} orders)`, () => {
    for (let start = 0; start < family.orders.length; start += SLICE) {
      it(`orders ${start + 1} to ${Math.min(start + SLICE, family.orders.length)}`, async () => {
        for (const order of family.orders.slice(start, start + SLICE)) {
          try {
            await check(order);
          } catch (error) {
            throw new Error(`order ${order.join(", ")}: ${(error as Error).message}`);
          }
        }
      });
    }
  });
}
