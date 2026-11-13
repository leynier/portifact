// A model check of the artifact data lifecycle around holds and quarantines (decision 0026): short
// sets of messages delivered in every order against the real object and the real services, in
// four families chosen so each order stays cheap.
//
// - Quarantine: a hold's fence, its release and the release's fence, an adopt and an erase of the
//   reviewed quarantine, and a second quarantine (360 orders; the release's fence after the release).
// - Purge: the same with a purge instead of the release's own fence, which the release delivers
//   (360 orders; the purge after the release, since D1 never purges a held artifact).
// - Second hold: an object holding H1 at epoch 5, then a D1 rewind (the restore seam), H1's release, a
//   second hold H2 and its release, and two delivery rounds of whatever fences wait (60 orders;
//   H1's release before H2 before H2's release, as D1 allows one open hold).
// - Transfer: an object at epoch 2 after a hold and its release, then a D1 transfer, a rewind, a hold and its
//   release, and two delivery rounds (60 orders; the transfer before the hold before its release,
//   since D1 never moves a held artifact).
//
// Left out: orders D1 itself refuses (those constraints), the identical orders of the two
// delivery rounds, every interleaving inside one message (the crash schedules and the race tests
// pin those boundaries), account deletion, author erasure and the export.
//
// After each message: the payload is unchanged while the object holds, a resolution changes only
// the quarantine it reviewed, and D1's epoch never decreases except at the rewind. At quiescence
// (every message delivered, the queue drained, reconciliation run and the operator answering any
// quarantine but an owner disagreement, which needs a repair outside the model): no data job is
// left, and D1 and the object agree by level (D1 has an open hold exactly when the object holds
// one) and on owner, or a finding exists for the operator.
import type { ReviewedQuarantine } from "@portifact/contracts/artifact-data";
import { InventoryEntry } from "@portifact/contracts/artifact-data";
import { schema } from "@portifact/db";
import { controlEnvelope, inventoryKey, reviewedState } from "@portifact/domain/artifact-data";
import {
  type DataObjectRpc,
  dataFenceStatements,
  deleteArtifactData,
  placeLegalHold,
  queueDataResolve,
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

type Message =
  | "holdFence"
  | "release"
  | "releaseFence"
  | "adopt"
  | "erase"
  | "quarantine"
  | "purge"
  | "rewind"
  | "hold"
  | "release2"
  | "transfer"
  | "deliver";

interface State {
  id: string;
  holdFence: number;
  releaseFences: number[];
  resolves: Record<"adopt" | "erase", number>;
  reviewed: ReviewedQuarantine | null;
  /** The release delivers its own fences (no `releaseFence` message in the family). */
  releaseDelivers: boolean;
}

interface Family {
  name: string;
  messages: Message[];
  /** Pairs [a, b]: a comes before b (what D1 itself allows). */
  before: [Message, Message][];
  setup(): Promise<State>;
}

/** Every distinct order of `items` (repeated messages give one order each) meeting `before`. */
function orders(items: readonly Message[], before: [Message, Message][]): Message[][] {
  const seen = new Set<string>();
  const out: Message[][] = [];
  const walk = (rest: Message[], prefix: Message[]) => {
    if (rest.length === 0) {
      const key = prefix.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(prefix);
      }
      return;
    }
    rest.forEach((next, index) => {
      const remaining = [...rest.slice(0, index), ...rest.slice(index + 1)];
      // `next` may not come while something that must precede it is still to come.
      if (before.some(([a, b]) => b === next && remaining.includes(a))) return;
      walk(remaining, [...prefix, next]);
    });
  };
  walk([...items], []);
  return out;
}

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;

async function runById(id: number, now = DATA_NOW): Promise<void> {
  const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, id));
  if (row === undefined) return;
  await runJob(db(), bucketOf(), { id: row.id, topic: row.topic }, now, { data: objectsFor() });
}

const fenceIds = async (id: string) =>
  (await jobsOf(db(), ["data_fence"], id)).map((row) => row.id);

async function place(id: string, at: number) {
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: at });
}

async function openHold(id: string) {
  const h = schema.legalHolds;
  const [hold] = await db()
    .select({ id: h.id })
    .from(h)
    .where(sql`${h.artifactId} = ${id} and ${h.releasedAt} is null`);
  return hold?.id ?? null;
}

async function quarantine(id: string): Promise<void> {
  const control = await controlOf(id);
  if (control === null) return;
  await rpc(id).lifecycleQuarantine(controlEnvelope(control), "orphan", DATA_NOW);
}

/** A transfer in D1 as `transferArtifact` writes it: the fence under the old owner, then the move. */
async function transferInD1(id: string) {
  const handle = db();
  const [artifact] = await handle
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, id));
  const to = `u_to_${crypto.randomUUID()}`;
  const [raise, job] = dataFenceStatements(handle, {
    which: sql`d.artifact_id = ${id}`,
    fence: sql`json_object('kind', 'transfer', 'transition', ${`transfer_${crypto.randomUUID().replaceAll("-", "")}`}, 'toOwner', ${to})`,
    owner: sql`${artifact?.ownerId ?? ""}`,
    now: D1_NOW + 10,
  });
  if (raise === undefined || job === undefined) throw new Error("no fence statements");
  await handle.batch([
    raise,
    job,
    handle.update(schema.artifacts).set({ ownerId: to }).where(eq(schema.artifacts.id, id)),
  ]);
}

/** The quarantined artifact with the operator's adopt and erase of what they reviewed queued. */
async function quarantineSetup(releaseDelivers: boolean): Promise<State> {
  const { id } = await withData({ state: "suspended" });
  await place(id, D1_NOW);
  const [holdFence] = await fenceIds(id);
  await quarantine(id);
  const quarantined = await controlOf(id);
  const reviewed = quarantined === null ? null : reviewedState(quarantined);
  if (reviewed === null || holdFence === undefined) throw new Error("setup");
  const resolves = { adopt: 0, erase: 0 };
  for (const decision of ["adopt", "erase"] as const) {
    const before = (await jobsOf(db(), ["data_resolve"], id)).map((row) => row.id);
    await queueDataResolve(db(), id, decision, reviewed, DATA_NOW);
    const [made] = (await jobsOf(db(), ["data_resolve"], id)).filter(
      (row) => !before.includes(row.id),
    );
    resolves[decision] = made?.id ?? 0;
  }
  return { id, holdFence, releaseFences: [], resolves, reviewed, releaseDelivers };
}

/** An object whose fences have all landed, after `held` holds (the last one left open or not). */
async function landedSetup(holds: number, leaveOpen: boolean): Promise<State> {
  const { id } = await withData({ state: "suspended" });
  for (let n = 0; n < holds; n += 1) {
    await place(id, D1_NOW + n * 2);
    if (!leaveOpen || n < holds - 1) {
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + n * 2 + 1 });
    }
  }
  await drain({ subject: id });
  return {
    id,
    holdFence: 0,
    releaseFences: [],
    resolves: { adopt: 0, erase: 0 },
    reviewed: null,
    releaseDelivers: true,
  };
}

const FAMILIES: Family[] = [
  {
    name: "a quarantine, with the release's fence as its own message",
    messages: ["holdFence", "release", "releaseFence", "adopt", "erase", "quarantine"],
    before: [["release", "releaseFence"]],
    setup: () => quarantineSetup(false),
  },
  {
    name: "a quarantine and a purge after the release",
    messages: ["holdFence", "release", "adopt", "erase", "quarantine", "purge"],
    before: [["release", "purge"]],
    setup: () => quarantineSetup(true),
  },
  {
    name: "a second hold after a D1 rewind",
    messages: ["rewind", "release", "hold", "release2", "deliver", "deliver"],
    before: [
      ["release", "hold"],
      ["hold", "release2"],
    ],
    // The object at epoch 5, so after the rewind each of D1's next three fences is stale (R3-A).
    setup: () => landedSetup(3, true),
  },
  {
    name: "a transfer, a D1 rewind and a hold",
    messages: ["transfer", "rewind", "hold", "release2", "deliver", "deliver"],
    before: [
      ["transfer", "hold"],
      ["hold", "release2"],
    ],
    // The object at epoch 2: after the rewind a stale transfer, then fences under the new owner
    // above the object's epoch (the gap this family found).
    setup: () => landedSetup(1, false),
  },
];

async function send(state: State, message: Message): Promise<void> {
  const { id } = state;
  switch (message) {
    case "holdFence":
      return runById(state.holdFence);
    case "release": {
      const before = await fenceIds(id);
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 101 });
      state.releaseFences = (await fenceIds(id)).filter((job) => !before.includes(job));
      if (state.releaseDelivers) for (const job of state.releaseFences) await runById(job);
      return;
    }
    case "releaseFence":
      for (const job of state.releaseFences) await runById(job);
      return;
    case "adopt":
    case "erase":
      return runById(state.resolves[message]);
    case "quarantine":
      return quarantine(id);
    case "purge":
      // D1 never purges a held artifact: the purge waits for the release (an order constraint).
      if ((await openHold(id)) !== null) return;
      await db()
        .update(schema.artifacts)
        .set({ state: "purging" })
        .where(eq(schema.artifacts.id, id));
      await deleteArtifactData(db(), bucketOf(), id, D1_NOW + 102);
      for (const job of await jobsOf(db(), ["data_erase"], id)) await runById(job.id);
      return;
    case "rewind":
      await db()
        .update(schema.artifactData)
        .set({ epoch: 0 })
        .where(eq(schema.artifactData.artifactId, id));
      return;
    case "hold":
      return place(id, D1_NOW + 103);
    case "release2":
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 104 });
      return;
    case "transfer":
      return transferInD1(id);
    case "deliver":
      for (const job of await fenceIds(id)) await runById(job);
      return;
  }
}

/** One order from a fresh artifact; fails at the first broken invariant. */
async function check(family: Family, order: readonly Message[]): Promise<void> {
  const state = await family.setup();
  const { id } = state;
  let epoch = (await dataRowOf(id))?.epoch ?? 0;
  const observe = async (step: string, rewound: boolean, held: boolean, documents: number) => {
    const row = await dataRowOf(id);
    if (row !== null) {
      if (!rewound)
        expect(row.epoch, `${step}: D1's epoch went back`).toBeGreaterThanOrEqual(epoch);
      epoch = row.epoch;
    }
    // The payload is kept for as long as the object holds, whatever D1 says.
    if (held) expect(await documentsOf(id), `${step}: held data erased`).toBe(documents);
  };
  const step = async (label: string, act: () => Promise<unknown>, rewound = false) => {
    const before = await controlOf(id);
    const documents = await documentsOf(id);
    await act();
    await observe(label, rewound, before?.hold != null, documents);
    return { before, documents };
  };

  for (const message of order) {
    const { before, documents } = await step(
      message,
      () => send(state, message),
      message === "rewind",
    );
    // A resolution changes only the quarantine it reviewed.
    if ((message === "adopt" || message === "erase") && before?.quarantine) {
      if (before.quarantine.incarnation !== state.reviewed?.incarnation) {
        expect((await controlOf(id))?.quarantine, `${message} resolved another`).toEqual(
          before.quarantine,
        );
        expect(await documentsOf(id)).toBe(documents);
      }
    }
  }

  // Quiescence: the queue runs what is left, reconciliation runs, and the operator answers a
  // quarantine with the state it shows now; an owner disagreement stays a finding (its repair is
  // D1's ownership rows, outside the model).
  let now = DATA_NOW + 60_000;
  const waiting = () => jobsOf(db(), ["data_fence", "data_erase", "data_resolve"], id);
  const reconcileNow = async () => {
    const found = await bucketOf().get(inventoryKey(id));
    if (found === null) return "none";
    return reconcileObject(db(), objectsFor(), InventoryEntry.parse(await found.json()), now);
  };
  let ownerFinding = false;
  for (let round = 0; round < 6; round += 1) {
    await step(`drain ${round}`, () => drain({ subject: id, now }));
    await step(`reconcile ${round}`, reconcileNow);
    const control = await controlOf(id);
    if (control?.quarantine) {
      if (control.quarantine.reason === "owner") ownerFinding = true;
      else {
        const reviewed = reviewedState(control);
        if (reviewed === null) throw new Error("quarantined without a state");
        const [artifact] = await db()
          .select({ state: schema.artifacts.state })
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, id));
        const decision = artifact === undefined || artifact.state === "purging" ? "erase" : "adopt";
        await queueDataResolve(db(), id, decision, reviewed, now);
      }
    } else if ((await waiting()).length === 0) break;
    now += 10 * 60_000;
    if (ownerFinding) {
      await step("final drain", () => drain({ subject: id, now }));
      break;
    }
  }

  expect(await waiting(), "a data job waits forever").toEqual([]);
  const control = await controlOf(id);
  const [artifact] = await db()
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, id));
  const [finding] = await db()
    .select({ action: schema.dataFindings.action })
    .from(schema.dataFindings)
    .where(eq(schema.dataFindings.artifactId, id));
  if (control === null || artifact === undefined) {
    // Purged: nothing of the artifact holds.
    expect(control?.hold ?? null).toBeNull();
    return;
  }
  const agree =
    ((await openHold(id)) !== null) === (control.hold !== null) &&
    artifact.ownerId === control.ownerId;
  expect(
    agree || (ownerFinding && finding !== undefined),
    `D1 and the object disagree (D1 hold ${await openHold(id)}, object ${control.hold?.transition ?? null}; owner ${artifact.ownerId} and ${control.ownerId}) with no finding`,
  ).toBe(true);
}

/** Orders per test: each stays near a second locally (CI is about twenty times slower). */
const SLICE = 2;

for (const family of FAMILIES) {
  const all = orders(family.messages, family.before);
  describe(`every order of ${family.name} (${all.length} orders)`, () => {
    for (let start = 0; start < all.length; start += SLICE) {
      it(`orders ${start + 1} to ${Math.min(start + SLICE, all.length)}`, async () => {
        for (const order of all.slice(start, start + SLICE)) {
          try {
            await check(family, order);
          } catch (error) {
            throw new Error(`order ${order.join(", ")}: ${(error as Error).message}`);
          }
        }
      });
    }
  });
}
