// A model check of the artifact data lifecycle around holds and quarantines (decision 0026): short
// sets of messages delivered in every order against the real object and the real services, in
// families chosen so each order stays cheap (`FAMILIES`; the first four described here).
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
// - Author erasure (sixth review): an account deletion's erasure job anywhere among a release and a
//   new hold, with or without a transfer, fences delivered one at a time (60 and 140 orders).
//
// Left out: orders D1 itself refuses (those constraints), the identical orders of the two
// delivery rounds, every interleaving inside one message (the crash schedules and the race tests
// pin those boundaries) and the export.
//
// After each message: the payload is unchanged while D1 has an open hold or the object holds, a
// resolution changes only
// the quarantine it reviewed, and D1's epoch never decreases except at the rewind. At quiescence
// (every message delivered, the queue drained, reconciliation run and the operator answering any
// quarantine but an owner disagreement, which needs a repair outside the model): no data job is
// left but an erasing job D1's open hold keeps, and D1 and the object agree by level (D1 has an open hold exactly when the object holds
// one) and on owner, or a finding exists for the operator.
import { env } from "cloudflare:test";
import type { ReviewedQuarantine } from "@portifact/contracts/artifact-data";
import { InventoryEntry } from "@portifact/contracts/artifact-data";
import { regionsFromEnv, schema } from "@portifact/db";
import { controlEnvelope, inventoryKey, reviewedState } from "@portifact/domain/artifact-data";
import {
  advanceAccountDeletion,
  applyLegalHolds,
  type DataObjectRpc,
  dataFenceStatements,
  deleteArtifactData,
  exportLegalHolds,
  placeLegalHold,
  queueDataResolve,
  reconcileObject,
  releaseLegalHold,
  requestAccountDeletion,
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
  DATA_NOW,
  dataRowOf,
  db,
  documentsOf,
  drain,
  jobsOf,
  objectsFor,
  stubOf,
  visitorId,
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
  | "transfer2"
  | "transfer3"
  | "holdRelease"
  | "mark"
  | "restore"
  | "deliver"
  | "deliverOne"
  | "author";

/** D1's rows about the artifact at a point: the restore message brings them back. */
interface Snapshot {
  artifact: { ownerId: string; state: (typeof schema.artifacts.$inferSelect)["state"] } | null;
  outbox: (typeof schema.outbox.$inferSelect)[];
  holds: (typeof schema.legalHolds.$inferSelect)[];
  data: { generation: number; epoch: number } | null;
}

interface State {
  id: string;
  holdFence: number;
  releaseFences: number[];
  resolves: Record<"adopt" | "erase", number>;
  reviewed: ReviewedQuarantine | null;
  /** The release delivers its own fences (no `releaseFence` message in the family). */
  releaseDelivers: boolean;
  /** The owners the transfers go to, in order (the third goes back to the first). */
  owners: string[];
  mark: Snapshot | null;
  /** The visitor whose account the `author` message deletes (its document and journal entry). */
  author?: { id: string; email: string; visitor: string };
}

interface Family {
  name: string;
  messages: Message[];
  /** Pairs [a, b]: a comes before b (what D1 itself allows). */
  before: [Message, Message][];
  /** Orders per test, so each test stays near half a second locally. */
  slice: number;
  /**
   * Ordinary operation (no restore, no rewind): it must end in agreement with no finding, as it did
   * before the lifecycle's repairs, never with an owner disagreement a finding explains.
   */
  ordinary?: boolean;
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
async function transferInD1(id: string, toOwner?: string) {
  const handle = db();
  const [artifact] = await handle
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, id));
  const to = toOwner ?? `u_to_${crypto.randomUUID()}`;
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
  return {
    id,
    holdFence,
    releaseFences: [],
    resolves,
    reviewed,
    releaseDelivers,
    owners: [],
    mark: null,
  };
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
    owners: [
      `ws_${crypto.randomUUID().replaceAll("-", "")}`,
      `ws_${crypto.randomUUID().replaceAll("-", "")}`,
    ],
    mark: null,
  };
}

/** H1 placed in D1, its fence queued: the start of the ordinary sequences (no rewind). */
async function pendingHoldSetup(): Promise<State> {
  const { id } = await withData({ state: "suspended" });
  await place(id, D1_NOW);
  return {
    id,
    holdFence: 0,
    releaseFences: [],
    resolves: { adopt: 0, erase: 0 },
    reviewed: null,
    releaseDelivers: false,
    owners: [`ws_${crypto.randomUUID().replaceAll("-", "")}`],
    mark: null,
  };
}

/** The same with a visitor's document and journal entry, for the `author` message. */
async function pendingAuthorSetup(): Promise<State> {
  const visitor = visitorId();
  const { id } = await withData({ state: "suspended", visitors: [visitor] });
  const author = await user("Model author");
  await claimJournal(author.id, id, visitor);
  await place(id, D1_NOW);
  return {
    id,
    holdFence: 0,
    releaseFences: [],
    resolves: { adopt: 0, erase: 0 },
    reviewed: null,
    releaseDelivers: false,
    owners: [`ws_${crypto.randomUUID().replaceAll("-", "")}`],
    mark: null,
    author: { id: author.id, email: author.email, visitor },
  };
}

/** H1 delivered to the object, nothing queued (the restore variant's start, no rewind). */
async function heldSetup(): Promise<State> {
  return { ...(await landedSetup(1, true)), releaseDelivers: false };
}

/** R4-A's start: the object holds H1 at epoch 1 and D1's epoch is rewound under it. */
async function restoreSetup(): Promise<State> {
  const state = { ...(await landedSetup(1, true)), releaseDelivers: false };
  await db()
    .update(schema.artifactData)
    .set({ epoch: 0 })
    .where(eq(schema.artifactData.artifactId, state.id));
  return state;
}

async function snapshot(id: string): Promise<Snapshot> {
  const [row] = await db()
    .select({ generation: schema.artifactData.generation, epoch: schema.artifactData.epoch })
    .from(schema.artifactData)
    .where(eq(schema.artifactData.artifactId, id));
  const [artifact] = await db()
    .select({ ownerId: schema.artifacts.ownerId, state: schema.artifacts.state })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, id));
  return {
    artifact: artifact ?? null,
    outbox: await db().select().from(schema.outbox).where(eq(schema.outbox.subject, id)),
    holds: await db().select().from(schema.legalHolds).where(eq(schema.legalHolds.artifactId, id)),
    data: row ?? null,
  };
}

/**
 * A D1 restore to the marked point, then the runbook: the holds exported just before it are
 * applied again (`applyLegalHolds`) and the object is reconciled. The object and R2 are not rewound.
 */
async function restoreTo(id: string, point: Snapshot) {
  const lines = (await exportLegalHolds(regionsFromEnv(env))).filter(
    (line) => line.legalHold.artifactId === id,
  );
  await db().delete(schema.outbox).where(eq(schema.outbox.subject, id));
  if (point.outbox.length > 0) await db().insert(schema.outbox).values(point.outbox);
  const kept = point.holds.map((hold) => hold.id);
  for (const hold of await db()
    .select({ id: schema.legalHolds.id })
    .from(schema.legalHolds)
    .where(eq(schema.legalHolds.artifactId, id))) {
    if (kept.includes(hold.id)) continue;
    await db()
      .delete(schema.legalHoldIdentities)
      .where(eq(schema.legalHoldIdentities.holdId, hold.id));
    await db().delete(schema.legalHolds).where(eq(schema.legalHolds.id, hold.id));
  }
  // The artifact first: a held artifact's owner cannot change (the hold triggers).
  if (point.artifact !== null) {
    await db().update(schema.artifacts).set(point.artifact).where(eq(schema.artifacts.id, id));
  }
  for (const hold of point.holds) {
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: hold.releasedAt })
      .where(eq(schema.legalHolds.id, hold.id));
  }
  if (point.data !== null) {
    await db()
      .update(schema.artifactData)
      .set(point.data)
      .where(eq(schema.artifactData.artifactId, id));
  }
  await applyLegalHolds(regionsFromEnv(env), lines, DATA_NOW);
  const found = await bucketOf().get(inventoryKey(id));
  if (found !== null) {
    await reconcileObject(db(), objectsFor(), InventoryEntry.parse(await found.json()), DATA_NOW);
  }
}

const FAMILIES: Family[] = [
  {
    name: "a quarantine, with the release's fence as its own message",
    messages: ["holdFence", "release", "releaseFence", "adopt", "erase", "quarantine"],
    before: [["release", "releaseFence"]],
    slice: 1,
    setup: () => quarantineSetup(false),
  },
  {
    name: "a quarantine and a purge after the release",
    messages: ["holdFence", "release", "adopt", "erase", "quarantine", "purge"],
    before: [["release", "purge"]],
    slice: 1,
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
    slice: 2,
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
    slice: 2,
    setup: () => landedSetup(1, false),
  },
  {
    // R4-A's shape: a corrective release written, a point marked, a new hold, then a restore to
    // the point that brings the corrective back while `applyLegalHolds` re-opens the new hold.
    name: "a restore that brings back a queued corrective",
    messages: ["release", "deliver", "mark", "hold", "restore", "deliver"],
    before: [
      ["release", "hold"],
      ["mark", "restore"],
    ],
    slice: 2,
    setup: restoreSetup,
  },
  {
    // R5-A's shape, ordinary operation: H1, its release, a transfer and a new hold, with the
    // deliveries anywhere among them.
    name: "a hold left open after a transfer while an earlier release waits",
    messages: ["deliver", "release", "transfer", "hold", "deliver", "deliver"],
    before: [
      ["release", "transfer"],
      ["transfer", "hold"],
    ],
    slice: 2,
    ordinary: true,
    setup: pendingHoldSetup,
  },
  {
    name: "the same with the new hold released",
    messages: ["deliver", "release", "transfer", "hold", "release2", "deliver", "deliver"],
    before: [
      ["release", "transfer"],
      ["transfer", "hold"],
      ["hold", "release2"],
    ],
    slice: 2,
    ordinary: true,
    setup: pendingHoldSetup,
  },
  {
    // R6-1's shape: an account deletion's author erasure anywhere among H1's release and a new
    // hold, with fences delivered one at a time, so it can run between the old release and the
    // new hold's fence (the object free while D1 holds).
    name: "an author erasure among a release and a new hold, fences one at a time",
    messages: ["deliverOne", "release", "hold", "deliverOne", "deliverOne", "author"],
    before: [["release", "hold"]],
    slice: 2,
    ordinary: true,
    setup: pendingAuthorSetup,
  },
  {
    name: "the same with a transfer before the new hold",
    messages: ["deliverOne", "release", "transfer", "hold", "deliverOne", "deliverOne", "author"],
    before: [
      ["release", "transfer"],
      ["transfer", "hold"],
    ],
    slice: 2,
    ordinary: true,
    setup: pendingAuthorSetup,
  },
  {
    // The restore variant: a point marked anywhere, the new hold, then a restore to the point
    // (`applyLegalHolds` re-opens the new hold without a fence, then reconciliation).
    name: "a restore around a transfer and a new hold",
    messages: ["release", "transfer", "mark", "hold", "restore", "deliver", "deliver"],
    before: [
      ["release", "transfer"],
      ["transfer", "hold"],
      ["mark", "restore"],
    ],
    slice: 2,
    setup: heldSetup,
  },
  {
    name: "two transfers around a D1 rewind",
    messages: ["rewind", "transfer", "holdRelease", "transfer2", "deliver", "deliver"],
    before: [
      ["transfer", "holdRelease"],
      ["holdRelease", "transfer2"],
    ],
    slice: 2,
    setup: () => landedSetup(1, false),
  },
  {
    // R4-B's shape: A to B, a hold and its release under B, B to C, then C back to B.
    name: "three transfers around a D1 rewind",
    messages: ["rewind", "transfer", "holdRelease", "transfer2", "transfer3", "deliver", "deliver"],
    before: [
      ["transfer", "holdRelease"],
      ["holdRelease", "transfer2"],
      ["transfer2", "transfer3"],
    ],
    slice: 1,
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
      return transferInD1(id, state.owners[0]);
    case "transfer2":
      return transferInD1(id, state.owners[1]);
    case "transfer3":
      return transferInD1(id, state.owners[0]);
    case "holdRelease":
      await place(id, D1_NOW + 105);
      await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 106 });
      return;
    case "mark":
      state.mark = await snapshot(id);
      return;
    case "restore":
      if (state.mark !== null) await restoreTo(id, state.mark);
      return;
    case "deliver":
      for (const job of await fenceIds(id)) await runById(job);
      return;
    case "deliverOne": {
      const [oldest] = await fenceIds(id);
      if (oldest !== undefined) await runById(oldest);
      return;
    }
    case "author": {
      const author = state.author;
      if (author === undefined) throw new Error("no author in this family");
      value(
        await requestAccountDeletion(regionsFromEnv(env), {
          userId: author.id,
          sessionId: await session(author.id, DATA_NOW),
          confirmEmail: author.email,
          now: DATA_NOW,
        }),
      );
      await advanceAccountDeletion(regionsFromEnv(env), author.id, DATA_NOW);
      for (const job of await jobsOf(db(), ["data_author_erasure"], id)) await runById(job.id);
      return;
    }
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
    // The payload is kept while D1 has an open hold or the object holds (sixth review).
    if (held) expect(await documentsOf(id), `${step}: held data erased`).toBe(documents);
    // The object is never free while D1 has an open hold whose fence was delivered or made
    // obsolete (R4-A's state), unless the owners disagree (the operator's, with its finding).
    const open = await openHold(id);
    const control = await controlOf(id);
    if (open !== null && control !== null && control.hold === null && !control.quarantine) {
      const [artifact] = await db()
        .select({ ownerId: schema.artifacts.ownerId })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id));
      const waitingHold = (await jobsOf(db(), ["data_fence"], id)).some((job) => {
        const fence = (job.payload as { fence: { kind: string; transition: string } }).fence;
        return fence.kind === "hold" && fence.transition === open;
      });
      if (artifact?.ownerId === control.ownerId) {
        expect(waitingHold, `${step}: D1 holds ${open} and the object is free`).toBe(true);
      }
    }
  };
  const step = async (label: string, act: () => Promise<unknown>, rewound = false) => {
    const before = await controlOf(id);
    const documents = await documentsOf(id);
    const heldInD1 = (await openHold(id)) !== null;
    await act();
    await observe(label, rewound, before?.hold != null || heldInD1, documents);
    return { before, documents };
  };

  for (const message of order) {
    const { before, documents } = await step(
      message,
      () => send(state, message),
      message === "rewind" || message === "restore",
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

  // Quiescence: the queue runs what is left and the operator answers a quarantine with the state
  // it shows now. Reconciliation is not run: an owner disagreement must leave the job's own
  // finding, and every job must end within the bounded drains.
  let now = DATA_NOW + 60_000;
  // Every lifecycle job must end: progress, not only agreement. An erasing job D1's open hold
  // keeps is expected to wait (for the release, outside the model).
  const waiting = async () => {
    const heldInD1 = (await openHold(id)) !== null;
    return (await allWaiting()).filter(
      (job) => !(heldInD1 && (job.topic === "data_author_erasure" || job.topic === "data_erase")),
    );
  };
  const allWaiting = () =>
    jobsOf(
      db(),
      [
        "data_fence",
        "data_erase",
        "data_resolve",
        "data_author_erasure",
        "data_reconcile",
        "data_export",
      ],
      id,
    );
  for (let round = 0; round < 6; round += 1) {
    await step(`drain ${round}`, () => drain({ subject: id, now }));
    const control = await controlOf(id);
    const [owned] = await db()
      .select({ ownerId: schema.artifacts.ownerId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    // An owner quarantine is the operator's once D1 names the object's owner (a transfer that
    // was queued during the reconciliation landed); before, its repair is outside the model.
    const answerable =
      control?.quarantine &&
      (control.quarantine.reason !== "owner" || owned?.ownerId === control.ownerId);
    if (control?.quarantine && answerable) {
      const reviewed = reviewedState(control);
      if (reviewed === null) throw new Error("quarantined without a state");
      const [artifact] = await db()
        .select({ state: schema.artifacts.state })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, id));
      const decision = artifact === undefined || artifact.state === "purging" ? "erase" : "adopt";
      await queueDataResolve(db(), id, decision, reviewed, now);
    } else if ((await waiting()).length === 0) break;
    now += 10 * 60_000;
  }

  expect(await waiting(), "a data job waits forever").toEqual([]);
  if (state.author && (await jobsOf(db(), ["data_author_erasure"], id)).length > 0) {
    expect(await documentsOf(id, state.author.visitor), "a waiting erasure erased").toBe(1);
  }
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
  const ownersDisagree = artifact.ownerId !== control.ownerId;
  if (family.ordinary) expect(finding, "ordinary operation left a finding").toBeUndefined();
  expect(
    agree || (!family.ordinary && ownersDisagree && finding !== undefined),
    `D1 and the object disagree (D1 hold ${await openHold(id)}, object ${control.hold?.transition ?? null}; owner ${artifact.ownerId} and ${control.ownerId}) with no finding`,
  ).toBe(true);
}

for (const family of FAMILIES) {
  const all = orders(family.messages, family.before);
  describe(`every order of ${family.name} (${all.length} orders)`, () => {
    const slice = family.slice;
    for (let start = 0; start < all.length; start += slice) {
      it(`orders ${start + 1} to ${Math.min(start + slice, all.length)}`, async () => {
        for (const order of all.slice(start, start + slice)) {
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
