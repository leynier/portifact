// Crash schedules across D1, R2 and the documents object (decision 0026, delivery 4, obligation
// 9). Each multi-system operation runs once cleanly to fix its steps (every D1 write, R2 write,
// lifecycle command and the job's acknowledgement, which is the outbox row's delete), then once
// per step with a failure injected before the step takes effect and once after it, followed by
// clean retries as the queue would deliver them. After the retries the state must be exactly the
// clean run's: nothing applied twice, nothing lost, no D1 repair ahead of the object.
//
// One test per crash point keeps each small (CI's runner is about twenty times slower than a
// workstation and every test must finish in 30 seconds).

import type { JournalEntry } from "@portifact/contracts/artifact-data";
import { schema } from "@portifact/db";
import { inventoryKey, journalKey } from "@portifact/domain/artifact-data";
import {
  cleanJournalPage,
  dataFenceStatements,
  deleteArtifactData,
  JOURNAL_CLAIM_STALE_MS,
  JOURNAL_CLEANUP_CURSOR,
  markJournalErased,
  placeLegalHold,
  pruneJournalEntries,
  queueDataReconcile,
  reconcileObject,
  registerDataObject,
  releaseLegalHold,
  retireJournalEntry,
  scheduleAuthorErasures,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { value } from "../../../packages/services/test/fixtures.ts";
import {
  artifactId,
  artifactRow,
  bucketOf,
  Crash,
  claimJournal,
  controlOf,
  D1_NOW,
  DATA_NOW,
  dataRowOf,
  db,
  documentsOf,
  drain,
  handles,
  InjectedCrash,
  inside,
  jobsOf,
  journalOf,
  reviewedOf,
  visitorId,
  withData,
} from "./lifecycle.ts";

interface Operation<S> {
  /** The steps of a clean run, in order (pinned: a new step must be added here deliberately). */
  steps: string[];
  setup(): Promise<S>;
  act(crash: Crash, state: S): Promise<unknown>;
  /** The clean retries after a crash. */
  settle(state: S): Promise<unknown>;
  observe(state: S): Promise<unknown>;
}

function injected(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) if (e instanceof InjectedCrash) return true;
  return false;
}

function schedule<S>(name: string, operation: Operation<S>) {
  describe(name, () => {
    it("has the pinned steps when nothing fails", async () => {
      const state = await operation.setup();
      const crash = new Crash();
      await operation.act(crash, state);
      expect(crash.steps).toEqual(operation.steps);
    });
    const points = operation.steps.flatMap((label, index) =>
      (["before", "after"] as const).map((when) => ({ at: index + 1, label, when })),
    );
    it.each(points)(
      "ends as the clean run after a crash $when step $at ($label)",
      async ({ at, when }) => {
        const reference = await operation.setup();
        await operation.act(new Crash(), reference);
        await operation.settle(reference);
        const expected = await operation.observe(reference);

        const state = await operation.setup();
        const thrown = await operation.act(new Crash(at, when), state).then(
          () => null,
          (error: unknown) => error,
        );
        // Drizzle wraps a failed query's error; the injected crash is in its causes.
        expect(injected(thrown)).toBe(true);
        await operation.settle(state);
        expect(await operation.observe(state)).toEqual(expected);
      },
    );
  });
}

const inventoryRetired = async (id: string) => {
  const found = await bucketOf().get(inventoryKey(id));
  return found === null
    ? null
    : (((await found.json()) as { retiredAt?: number }).retiredAt ?? null);
};

schedule("a purge's whole erase (data_erase)", {
  // The erase ID kept in the row, prepare, commit, the inventory retired, the acknowledgement.
  steps: ["d1:run", "object:lifecycleErase", "object:lifecycleErase", "r2:put", "d1:run"],
  async setup() {
    const { id } = await withData({ state: "purging", documents: 2, visitors: [visitorId()] });
    await deleteArtifactData(db(), bucketOf(), id, D1_NOW);
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  async observe(id) {
    const control = await controlOf(id);
    return {
      documents: await documentsOf(id),
      generation: control?.generation,
      erasing: control?.erasing,
      lastErase: control?.lastErase?.outcome,
      retired: await inventoryRetired(id),
      jobs: (await jobsOf(db(), ["data_erase"], id)).length,
    };
  },
});

schedule("a hold's fence (data_fence)", {
  steps: ["object:lifecycleFence", "d1:run"],
  async setup() {
    const { id } = await withData({ state: "suspended" });
    value(
      await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW }),
    );
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  async observe(id) {
    const control = await controlOf(id);
    return {
      held: control?.hold !== null,
      epoch: control?.epoch,
      fenced: control?.fencedEpoch,
      d1: (await dataRowOf(id))?.epoch,
      jobs: (await jobsOf(db(), ["data_fence"], id)).length,
    };
  },
});

schedule("a stale release and its corrective (data_fence, third review)", {
  // The stale release's refusal, the corrective's one batch, the stale job's acknowledgement, then
  // the corrective's fence and its acknowledgement. A crash after the batch and before the
  // acknowledgement delivers the stale job again, which writes no second corrective.
  steps: ["object:lifecycleFence", "d1:batch", "d1:run", "object:lifecycleFence", "d1:run"],
  async setup() {
    const { id } = await withData({ state: "suspended" });
    value(
      await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW }),
    );
    await drain({ subject: id });
    // A restore rewound D1's epoch under the object's; the release is then stale.
    await db()
      .update(schema.artifactData)
      .set({ epoch: 0 })
      .where(eq(schema.artifactData.artifactId, id));
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  async observe(id) {
    const control = await controlOf(id);
    return {
      held: control?.hold !== null,
      epoch: control?.epoch,
      fenced: control?.fencedEpoch,
      d1: (await dataRowOf(id))?.epoch,
      jobs: (await jobsOf(db(), ["data_fence"], id)).length,
    };
  },
});

schedule("an obsolete release at delivery and its corrective (data_fence, fourth review)", {
  // The release reaches no object (D1 holds again), the convergence's one batch writes a corrective
  // hold, the release's acknowledgement; then the corrective's fence and its acknowledgement.
  steps: ["d1:batch", "d1:run", "object:lifecycleFence", "d1:run"],
  async setup() {
    const { id } = await withData({ state: "suspended" });
    for (const at of [D1_NOW, D1_NOW + 2]) {
      value(
        await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: at }),
      );
      if (at === D1_NOW) await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    }
    // A restore lost both holds' fences: only H1's release is queued, while D1 holds H2.
    const jobs = await jobsOf(db(), ["data_fence"], id);
    for (const job of jobs) {
      if ((job.payload as { fence: { kind: string } }).fence.kind === "hold") {
        await db().delete(schema.outbox).where(eq(schema.outbox.id, job.id));
      }
    }
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  async observe(id) {
    const control = await controlOf(id);
    return {
      held: control?.hold !== null,
      epoch: control?.epoch,
      d1: (await dataRowOf(id))?.epoch,
      jobs: (await jobsOf(db(), ["data_fence"], id)).length,
    };
  },
});

interface Author {
  id: string;
  userId: string;
  visitor: string;
}

const authorState = async (state: Author) => ({
  mine: await documentsOf(state.id, state.visitor),
  all: await documentsOf(state.id),
  journal: (await journalOf(state.userId, state.id))?.retiredAt ?? null,
  erased: (await journalOf(state.userId, state.id))?.erasedAt ?? null,
  barrier: await inside(state.id, (object) =>
    object.store.inspect("pf_barriers").map((row) => row.complete),
  ),
  jobs: (await jobsOf(db(), ["data_author_erasure"], state.id)).length,
});

schedule("an account's erasure in an artifact (data_author_erasure)", {
  // The retirement, the erasure, the storage report, the completion recorded in the journal
  // (`erasedAt`, what lets the cleanup delete the entry later), the acknowledgement.
  steps: ["r2:put", "object:lifecycleEraseAuthor", "d1:run", "r2:put", "d1:run"],
  async setup() {
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    const { id } = await withData({ visitors: [visitor, visitorId()] });
    await claimJournal(userId, id, visitor);
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_author_erasure",
        payload: { userId, visitorId: visitor },
        availableAt: DATA_NOW,
        subject: id,
      });
    return { id, userId, visitor };
  },
  act: (crash, state) => drain({ subject: state.id, crash }),
  settle: (state) => drain({ subject: state.id }),
  observe: authorState,
});

interface OwnErasure {
  id: string;
  visitor: string;
}

const ERASURE_WRITE = "e".repeat(32);

// The counts on the row are what the job saw: after a crash between a chunk and its D1 write the
// retry finds those documents already gone, so only the state and the documents are compared.
const ownErasureState = async (state: OwnErasure) => ({
  mine: await documentsOf(state.id, state.visitor),
  all: await documentsOf(state.id),
  barrier: await inside(state.id, (object) => object.store.inspect("pf_barriers").length),
  row: (
    await db()
      .select({ state: schema.dataOwnErasures.state })
      .from(schema.dataOwnErasures)
      .where(eq(schema.dataOwnErasures.artifactId, state.id))
  )[0]?.state,
  jobs: (await jobsOf(db(), ["data_own_erasure"], state.id)).length,
});

schedule("a person's erasure of what they saved (data_own_erasure)", {
  // The chunk, the storage report, the row marked done, the acknowledgement.
  steps: ["object:lifecycleEraseOwn", "d1:run", "d1:run", "d1:run"],
  async setup() {
    const visitor = visitorId();
    const { id } = await withData({ visitors: [visitor, visitorId()] });
    await db().insert(schema.dataOwnErasures).values({
      artifactId: id,
      visitorId: visitor,
      state: "running",
      writeId: ERASURE_WRITE,
      requestedAt: DATA_NOW,
    });
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_own_erasure",
        payload: { visitorId: visitor, writeId: ERASURE_WRITE },
        availableAt: DATA_NOW,
        subject: id,
      });
    return { id, visitor };
  },
  act: (crash, state) => drain({ subject: state.id, crash }),
  settle: (state) => drain({ subject: state.id }),
  observe: ownErasureState,
});

schedule("an account deletion's journal step (scheduleAuthorErasures)", {
  // The job, the retirement, the scan's cursor.
  steps: ["d1:run", "r2:put", "d1:batch"],
  async setup() {
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    const { id } = await withData({ visitors: [visitor] });
    await claimJournal(userId, id, visitor);
    return { id, userId, visitor };
  },
  async act(crash, state) {
    const { db: handle, bucket } = handles("default", crash);
    return scheduleAuthorErasures(handle, bucket, state.userId, DATA_NOW);
  },
  async settle(state) {
    await scheduleAuthorErasures(db(), bucketOf(), state.userId, DATA_NOW);
    await drain({ subject: state.id });
  },
  observe: authorState,
});

schedule("registering an object (inventory, then D1)", {
  steps: ["r2:put", "d1:run"],
  async setup() {
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`);
    return id;
  },
  async act(crash, id) {
    const { db: handle, bucket } = handles("default", crash);
    return registerDataObject(handle, bucket, "default", id, DATA_NOW);
  },
  settle: (id) => registerDataObject(db(), bucketOf(), "default", id, DATA_NOW),
  async observe(id) {
    const entry = await bucketOf().get(inventoryKey(id));
    const { artifactId: named, ...rest } =
      entry === null ? { artifactId: null } : await entry.json<{ artifactId: string }>();
    return {
      named: named === id,
      entry: rest,
      row: (await dataRowOf(id))?.generation ?? null,
    };
  },
});

const entryOf = async (id: string) => {
  const found = await bucketOf().get(inventoryKey(id));
  if (found === null) throw new Error("no entry");
  return found.json<{ artifactId: string; region: string; createdAt: number }>();
};

const reconciled = async (id: string) => {
  const control = await controlOf(id);
  const row = await dataRowOf(id);
  const [finding] = await db()
    .select()
    .from(schema.dataFindings)
    .where(eq(schema.dataFindings.artifactId, id));
  return {
    quarantine: control?.quarantine?.reason ?? null,
    objectGeneration: control?.generation,
    erasing: control?.erasing ?? null,
    d1: row === null ? null : { generation: row.generation, epoch: row.epoch },
    finding: finding === undefined ? null : [finding.action, finding.reason],
  };
};

schedule("reconciling an object D1 is behind (raise)", {
  steps: ["d1:run", "d1:run"],
  async setup() {
    const { id, ownerId } = await withData();
    // The object committed an erase whose D1 update a restore rewound.
    await inside(id, (object) => {
      const envelope = { artifactId: id, region: "default", ownerId, generation: 0, epoch: 0 };
      const eraseId = `${DATA_NOW}.reconcileraise`;
      object.store.prepareErase(envelope, eraseId, DATA_NOW);
      object.store.commitErase(envelope, eraseId, DATA_NOW);
    });
    return id;
  },
  async act(crash, id) {
    const { db: handle, objects } = handles("default", crash);
    return reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  async settle(id) {
    const { db: handle, objects } = handles("default");
    await reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  observe: reconciled,
});

schedule("reconciling a prepared erase (resumed under its ID, then D1)", {
  // The commit, the finding, D1 following the object. A run that stops after the commit is
  // finished by the next as a raise, so the finding may say either; the state may not differ.
  steps: ["object:lifecycleErase", "d1:run", "d1:run"],
  async setup() {
    const { id, ownerId } = await withData({ documents: 2 });
    await inside(id, (object) =>
      object.store.prepareErase(
        { artifactId: id, region: "default", ownerId, generation: 0, epoch: 0 },
        `${DATA_NOW}.reconcileresume`,
        DATA_NOW,
      ),
    );
    return id;
  },
  async act(crash, id) {
    const { db: handle, objects } = handles("default", crash);
    return reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  async settle(id) {
    const { db: handle, objects } = handles("default");
    await reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  async observe(id) {
    const { finding, ...rest } = await reconciled(id);
    expect([
      ["resumed_erase", null],
      ["raised", null],
    ]).toContainEqual(finding);
    return rest;
  },
});

schedule("reconciling an object D1 no longer names (quarantine)", {
  // The finding, the quarantine, the finding's reviewed state.
  steps: ["d1:run", "object:lifecycleQuarantine", "d1:run"],
  async setup() {
    const { id } = await withData();
    // A restore rewound the artifact's creation: its rows are gone, the object is not.
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, id));
    return id;
  },
  async act(crash, id) {
    const { db: handle, objects } = handles("default", crash);
    return reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  async settle(id) {
    const { db: handle, objects } = handles("default");
    await reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  observe: reconciled,
});

const ownerFindings = async (id: string) =>
  (
    await db()
      .select({ action: schema.dataFindings.action, reason: schema.dataFindings.reason })
      .from(schema.dataFindings)
      .where(eq(schema.dataFindings.artifactId, id))
  ).map((row) => `${row.action} ${row.reason}`);

schedule("reconciliation clearing the jobs' owner finding (fifth review)", {
  // D1 and the object agree on the owner: the finding read, then its conditioned delete.
  steps: ["d1:run"],
  async setup() {
    const { id } = await withData();
    await db().insert(schema.dataFindings).values({
      artifactId: id,
      action: "refused",
      reason: "owner",
      firstSeenAt: D1_NOW,
      lastSeenAt: D1_NOW,
    });
    return id;
  },
  async act(crash, id) {
    const { db: handle, objects } = handles("default", crash);
    return reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  async settle(id) {
    const { db: handle, objects } = handles("default");
    await reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
  },
  observe: ownerFindings,
});

schedule("a transfer refused as held with no release to wait on (fifth review)", {
  // The refusal, the owner finding (the owners differ and nothing waiting can fix it), the
  // acknowledgement.
  steps: ["object:lifecycleFence", "d1:run", "d1:run"],
  async setup() {
    const { id } = await withData({ state: "suspended" });
    value(
      await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW }),
    );
    await drain({ subject: id });
    // A restore lost the release's fence; D1 released the hold and moved the artifact.
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
    for (const job of await jobsOf(db(), ["data_fence"], id)) {
      await db().delete(schema.outbox).where(eq(schema.outbox.id, job.id));
    }
    const to = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const [raise, job] = dataFenceStatements(db(), {
      which: sql`d.artifact_id = ${id}`,
      fence: sql`json_object('kind', 'transfer', 'transition', 'transfer_held', 'toOwner', ${to})`,
      owner: sql`(select owner_id from artifacts where id = ${id})`,
      now: D1_NOW + 2,
    });
    if (raise === undefined || job === undefined) throw new Error("no statements");
    await db().batch([
      raise,
      job,
      db().update(schema.artifacts).set({ ownerId: to }).where(eq(schema.artifacts.id, id)),
    ]);
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  async observe(id) {
    return {
      held: (await controlOf(id))?.hold !== null,
      jobs: (await jobsOf(db(), ["data_fence"], id)).length,
      findings: await ownerFindings(id),
    };
  },
});

schedule("the operator adopting a quarantined object (data_resolve)", {
  // D1 set to the object's numbers, the resolution, D1 following the object, the waiting jobs
  // woken, the finding, the acknowledgement.
  steps: ["object:lifecycleResolve", "d1:run", "d1:run", "d1:run", "d1:run"],
  async setup() {
    const { id } = await withData();
    // D1 lost the numbers the object raised (a restore), and reconciliation quarantined it.
    await db()
      .update(schema.artifactData)
      .set({ generation: 3 })
      .where(eq(schema.artifactData.artifactId, id));
    const { db: handle, objects } = handles("default");
    await reconcileObject(handle, objects, await entryOf(id), DATA_NOW);
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_resolve",
        payload: {
          decision: "adopt",
          resolutionId: `${DATA_NOW}.resolutionschedule`,
          expected: await reviewedOf(id),
        },
        availableAt: DATA_NOW,
        subject: id,
      });
    return id;
  },
  act: (crash, id) => drain({ subject: id, crash }),
  settle: (id) => drain({ subject: id }),
  observe: reconciled,
});

// The journal cleanup (decision 0026, "Author erasure"): a claim in D1 that holds the entry, the
// R2 delete, and a finalize in D1 that either ends the claim (the deletion) or, when a protection
// committed in between, writes the entry back. A crash leaves a claim the next run finishes once
// it is stale.
const CLEANUP_NOW = DATA_NOW + 40 * 86_400_000;

async function cleanupSetup() {
  // A fresh pass: no position, no claim another schedule left, no reconciliation waiting.
  await db()
    .delete(schema.maintenanceCursors)
    .where(eq(schema.maintenanceCursors.name, JOURNAL_CLEANUP_CURSOR));
  await db().delete(schema.journalDeletions);
  await db().delete(schema.outbox).where(eq(schema.outbox.topic, "data_reconcile"));
  const userId = `u_${crypto.randomUUID()}`;
  const id = artifactId();
  await artifactRow(id, `u_${crypto.randomUUID()}`, { state: "suspended" });
  await claimJournal(userId, id, visitorId());
  await retireJournalEntry(bucketOf(), userId, id, DATA_NOW);
  await markJournalErased(bucketOf(), userId, id, DATA_NOW);
  return { userId, id };
}

const cleanupState = async (state: { userId: string; id: string }) => ({
  journal: (await journalOf(state.userId, state.id))?.visitorId ?? null,
  claims: (
    await db()
      .select()
      .from(schema.journalDeletions)
      .where(eq(schema.journalDeletions.artifactId, state.id))
  ).length,
});

const cleanupRun = (handle: ReturnType<typeof db>, bucket: R2Bucket, now: number) =>
  cleanJournalPage(handle, bucket, now, "default", {
    deleted: 0,
    kept: 0,
    failed: 0,
    paused: false,
  });

schedule("the journal cleanup (pruneJournalEntries)", {
  // The claim, the R2 delete, the finalize.
  steps: ["d1:batch", "r2:delete", "d1:batch"],
  setup: cleanupSetup,
  async act(crash) {
    const { db: handle, bucket } = handles("default", crash);
    return cleanupRun(handle, bucket, CLEANUP_NOW);
  },
  // A later run, once a left claim is stale.
  settle: () => pruneJournalEntries(db(), bucketOf(), CLEANUP_NOW + JOURNAL_CLAIM_STALE_MS),
  observe: cleanupState,
});

/** A step hook that commits `action` at one numbered step instead of failing there. */
class Interject extends Crash {
  constructor(
    at: number,
    when: "before" | "after",
    private readonly action: () => Promise<unknown>,
  ) {
    super(at, when);
  }

  override async step<T>(label: string, run: () => Promise<T>): Promise<T> {
    this.seen += 1;
    this.steps.push(label);
    if (this.seen === this.at && this.when === "before") await this.action();
    const result = await run();
    if (this.seen === this.at && this.when === "after") await this.action();
    return result;
  }
}

describe("the journal cleanup against a protection committed at each step", () => {
  const protections = {
    hold: (id: string) =>
      placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW }),
    reconciliation: () => queueDataReconcile(db(), D1_NOW),
  };
  // The claim (1), the R2 delete (2) and the finalize (3): a protection that commits before the
  // finalize takes effect keeps the mapping; only one committed after it comes after the deletion.
  const points = (["hold", "reconciliation"] as const).flatMap((protection) =>
    [1, 2, 3].flatMap((at) =>
      (["before", "after"] as const).map((when) => ({
        protection,
        at,
        when,
        kept: !(at === 3 && when === "after"),
      })),
    ),
  );
  it.each(points)(
    "a $protection $when step $at keeps the mapping: $kept",
    async ({ protection, at, when, kept }) => {
      const state = await cleanupSetup();
      const interject = new Interject(at, when, () => protections[protection](state.id));
      const { db: handle, bucket } = handles("default", interject);
      await cleanupRun(handle, bucket, CLEANUP_NOW);
      expect(await cleanupState(state)).toEqual({
        journal: kept ? expect.stringMatching(/^v_/) : null,
        claims: 0,
      });
      if (kept) {
        const found = await bucketOf().get(journalKey(state.userId, state.id));
        expect(found?.customMetadata?.retired).toBe("1");
      }
    },
  );
});

describe("what the schedules rest on", () => {
  it("a retired journal entry is never written back as a live one by a retry", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`);
    await claimJournal(userId, id, visitorId());
    await scheduleAuthorErasures(db(), bucketOf(), userId, DATA_NOW);
    await scheduleAuthorErasures(db(), bucketOf(), userId, DATA_NOW + 1);
    const entry = (await (await bucketOf().get(journalKey(userId, id)))?.json()) as JournalEntry;
    expect(entry.retiredAt).toBe(DATA_NOW);
  });
});
