// The owner side's erase, its deletion of one author's documents and the daily sweep of audit
// obligations left pending (decision 0026, the follow-up of delivery 5), against the in-memory
// reference object.
import { env } from "cloudflare:test";
import { ARTIFACT_DATA } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createDataDocument,
  createDataDocuments,
  DATA_OWNER_WRITES_PER_MINUTE,
  DATA_RESET_DELAY_MS,
  type DataObjects,
  declareDataCollection,
  deleteAuthorData,
  eraseArtifactData,
  type OwnerDataDeps,
  PENDING_AUDIT_AGE_MS,
  queryArtifactData,
  registerDataObject,
  runDataAudit,
  runDataReset,
  sweepDataAudit,
} from "../src/index.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { ownerRpc } from "./data-owner-rpc.ts";
import { db, NOW, publishSite, user, value } from "./fixtures.ts";

type Rpc = ReturnType<typeof ownerRpc>;

function harness(enabled = true, wrap: (rpc: Rpc) => Rpc = (rpc) => rpc) {
  const memories = new Map<string, MemoryObject>();
  const of = (id: string) => {
    let found = memories.get(id);
    if (!found) {
      found = new MemoryObject(id);
      memories.set(id, found);
    }
    return found;
  };
  const objects: DataObjects = {
    region: "default",
    createsObjects: enabled,
    object: (id) => wrap(ownerRpc(of(id))) as never,
  };
  const deps: OwnerDataDeps = { objects, bucket: env.ARTIFACTS, enabled };
  return { deps, of, objects };
}

const key = () => `key-${crypto.randomUUID()}`;

async function seeded(deps: OwnerDataDeps, documents = 2) {
  const owner = await user("Owner");
  const { artifactId } = await publishSite(owner.id);
  const input = { userId: owner.id, artifactId, now: NOW };
  value(
    await declareDataCollection(db(), deps, {
      ...input,
      idempotencyKey: key(),
      declaration: { name: "votes", mode: "shared", indexed: [] },
    }),
  );
  if (documents > 0) {
    value(
      await createDataDocuments(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        documents: Array.from({ length: documents }, (_, n) => ({ n })),
      }),
    );
  }
  return { owner, artifactId, input };
}

async function jobs(topic: "data_reset" | "data_audit", artifactId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, topic), eq(schema.outbox.subject, artifactId)));
}

async function events(artifactId: string, kind: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.artifactId, artifactId), eq(schema.auditEvents.kind, kind)));
}

async function dataRow(artifactId: string) {
  const [row] = await db()
    .select()
    .from(schema.artifactData)
    .where(eq(schema.artifactData.artifactId, artifactId));
  return row;
}

describe("the owner's erase", () => {
  it("erases every document and collection, follows the generation and records it once", async () => {
    const { deps, of } = harness();
    const { owner, artifactId, input } = await seeded(deps);
    const idempotencyKey = key();
    const erased = value(await eraseArtifactData(db(), deps, { ...input, idempotencyKey }));
    expect(erased).toEqual({ erased: true, generation: 1 });
    expect(of(artifactId).durable.documents.size).toBe(0);
    expect((await dataRow(artifactId))?.generation).toBe(1);
    expect(await jobs("data_reset", artifactId)).toEqual([]);
    const recorded = await events(artifactId, "data.erased");
    expect(recorded.map((event) => [event.actorId, event.detail, event.ownerId])).toEqual([
      [owner.id, {}, owner.id],
    ]);
    // A retry with the same key answers the same erase and records nothing new.
    expect(value(await eraseArtifactData(db(), deps, { ...input, idempotencyKey }))).toEqual({
      erased: true,
      generation: 1,
    });
    expect(await events(artifactId, "data.erased")).toHaveLength(1);
    // The owner side writes again under the new generation.
    const doc = await createDataDocument(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      body: {},
    });
    expect(doc).toMatchObject({ ok: false, code: "not_found" });
  });

  it("answers an artifact that never stored data with nothing to erase", async () => {
    const { deps, of } = harness();
    const owner = await user("Owner");
    const { artifactId } = await publishSite(owner.id);
    expect(
      value(
        await eraseArtifactData(db(), deps, {
          userId: owner.id,
          artifactId,
          now: NOW,
          idempotencyKey: key(),
        }),
      ),
    ).toEqual({ erased: true, generation: 0 });
    expect(of(artifactId).durable.control).toBeNull();
  });

  it("erases an archived artifact's data and while artifact data is switched off", async () => {
    const { deps, of } = harness();
    const { artifactId, input } = await seeded(deps);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, artifactId));
    const off = { ...deps, enabled: false };
    expect(value(await eraseArtifactData(db(), off, { ...input, idempotencyKey: key() }))).toEqual({
      erased: true,
      generation: 1,
    });
    expect(of(artifactId).durable.documents.size).toBe(0);
  });

  it("refuses strangers, members and suspended artifacts, and never erases held data", async () => {
    const { deps, of } = harness();
    const { artifactId, input } = await seeded(deps);
    const stranger = await user("Stranger");
    expect(
      await eraseArtifactData(db(), deps, { ...input, userId: stranger.id, idempotencyKey: key() }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await eraseArtifactData(db(), deps, { ...input, idempotencyKey: key() })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    value(await placeLegalHold(db(), { artifactId, ground: "case-1", releaseAt: null, now: NOW }));
    expect(await eraseArtifactData(db(), deps, { ...input, idempotencyKey: key() })).toEqual({
      ok: false,
      code: "forbidden",
      message: HELD_MESSAGE,
    });
    expect(of(artifactId).durable.documents.size).toBe(2);
    expect(await jobs("data_reset", artifactId)).toEqual([]);
  });

  it("keeps a refused erase's claim and job, which then ends erasing nothing, and limits erases a day", async () => {
    const { deps, objects, of } = harness();
    const { artifactId, input } = await seeded(deps, 0);
    // The object starts at most `erase.intentsPerDay` optional erase intents a day.
    let refused: unknown = null;
    for (let n = 0; n < 40 && refused === null; n += 1) {
      const answer = await eraseArtifactData(db(), deps, {
        ...input,
        now: NOW + n,
        idempotencyKey: key(),
      });
      if (!answer.ok) refused = answer;
    }
    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    // The refusal does not prove no other copy of the same key committed: the claim and its job
    // stay, and the job, refused the same way, ends without erasing anything.
    const left = await jobs("data_reset", artifactId);
    expect(left).toHaveLength(1);
    const [job] = left;
    if (!job) throw new Error("no job");
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("stale");
    expect(of(artifactId).durable.control).not.toBeNull();
  });

  it("finishes a reset the request left between its steps, and keeps it while held", async () => {
    let crash = true;
    const { deps, objects, of } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async (envelope, actor, command, limits, now) => {
        if (crash && command.kind === "erase" && command.step === "commit") {
          throw new Error("the Worker went away");
        }
        return rpc.ownerCommand(envelope, actor, command, limits, now);
      },
    }));
    const { artifactId, input } = await seeded(deps);
    await expect(
      eraseArtifactData(db(), deps, { ...input, idempotencyKey: key() }),
    ).rejects.toThrow("went away");
    const [job] = await jobs("data_reset", artifactId);
    if (!job) throw new Error("no job");
    expect(job.availableAt).toBe(NOW + DATA_RESET_DELAY_MS);
    expect(of(artifactId).durable.documents.size).toBe(2);
    crash = false;

    // D1 is asked before the step: a hold keeps the job, and nothing is erased.
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, artifactId));
    value(await placeLegalHold(db(), { artifactId, ground: "case-1", releaseAt: null, now: NOW }));
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("kept");
    expect(of(artifactId).durable.documents.size).toBe(2);
    await db().delete(schema.legalHolds).where(eq(schema.legalHolds.artifactId, artifactId));
    await db()
      .update(schema.artifacts)
      .set({ state: "active" })
      .where(eq(schema.artifacts.id, artifactId));
    // The hold moved D1's epoch: the erase confirmed before it no longer holds and ends, erasing
    // nothing; confirming again is a new erase.
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("stale");
    expect(of(artifactId).durable.documents.size).toBe(2);
    expect(await events(artifactId, "data.erased")).toHaveLength(0);
  });

  it("finishes a reset the request left between its steps, once", async () => {
    let crash = true;
    const { deps, objects, of } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async (envelope, actor, command, limits, now) => {
        if (crash && command.kind === "erase" && command.step === "commit") {
          throw new Error("the Worker went away");
        }
        return rpc.ownerCommand(envelope, actor, command, limits, now);
      },
    }));
    const { artifactId, input } = await seeded(deps);
    await expect(
      eraseArtifactData(db(), deps, { ...input, idempotencyKey: key() }),
    ).rejects.toThrow("went away");
    const [job] = await jobs("data_reset", artifactId);
    if (!job) throw new Error("no job");
    crash = false;
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("done");
    expect(of(artifactId).durable.documents.size).toBe(0);
    expect((await dataRow(artifactId))?.generation).toBe(1);
    expect(await jobs("data_reset", artifactId)).toEqual([]);
    // A repeated delivery answers how the intent ended and records nothing new.
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("done");
    expect(await events(artifactId, "data.erased")).toHaveLength(1);
  });

  it("ends a malformed job, and keeps the row without the binding", async () => {
    const { objects } = harness();
    const row = {
      id: 1,
      topic: "data_reset",
      payload: { nope: 1 },
      availableAt: NOW,
      dispatchedAt: null,
      attempts: 0,
      createdAt: NOW,
      subject: "a1",
      generation: null,
    } as never;
    expect(await runDataReset(db(), objects, row, NOW)).toBe("stale");
    await expect(runDataReset(db(), null, row, NOW)).rejects.toThrow("binding");
  });
});

describe("the erase's bound target", () => {
  it("answers a done erase's retry from its claim, without reaching the object", async () => {
    let calls = 0;
    const { deps, of } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async (envelope, actor, command, limits, now) => {
        calls += 1;
        return rpc.ownerCommand(envelope, actor, command, limits, now);
      },
    }));
    const { artifactId, input } = await seeded(deps);
    const idempotencyKey = key();
    value(await eraseArtifactData(db(), deps, { ...input, idempotencyKey }));
    const before = calls;
    expect(value(await eraseArtifactData(db(), deps, { ...input, idempotencyKey }))).toEqual({
      erased: true,
      generation: 1,
    });
    expect(calls).toBe(before);
    expect(of(artifactId).durable.documents.size).toBe(0);
  });

  it("switched off, erases nothing on an artifact whose object holds no record", async () => {
    const { deps, objects, of } = harness(false);
    const owner = await user("Owner");
    const { artifactId } = await publishSite(owner.id);
    await registerDataObject(db(), env.ARTIFACTS, "default", artifactId, NOW);
    expect(
      value(
        await eraseArtifactData(db(), deps, {
          userId: owner.id,
          artifactId,
          now: NOW,
          idempotencyKey: key(),
        }),
      ),
    ).toEqual({ erased: true, generation: 0 });
    expect(of(artifactId).durable.control).toBeNull();
    const job = {
      id: 1,
      topic: "data_reset",
      payload: {
        ownerId: owner.id,
        generation: 0,
        epoch: 0,
        actor: owner.id,
        eraseId: `${NOW}.abcdefgh`,
      },
      availableAt: NOW,
      dispatchedAt: null,
      attempts: 0,
      createdAt: NOW,
      subject: artifactId,
      generation: null,
    } as never;
    expect(await runDataReset(db(), objects, job, NOW)).toBe("done");
    expect(of(artifactId).durable.control).toBeNull();
  });

  it("ends a job whose target D1 no longer holds, and one the object moved past", async () => {
    let crash = true;
    const { deps, objects, of } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async (envelope, actor, command, limits, now) => {
        if (crash && command.kind === "erase" && command.step === "prepare") {
          throw new Error("the Worker went away");
        }
        return rpc.ownerCommand(envelope, actor, command, limits, now);
      },
    }));
    const { artifactId, input } = await seeded(deps);
    await expect(
      eraseArtifactData(db(), deps, { ...input, idempotencyKey: key() }),
    ).rejects.toThrow("went away");
    const [job] = await jobs("data_reset", artifactId);
    if (!job) throw new Error("no job");
    crash = false;
    // Another erase, confirmed after, finishes first: this one's intent never prepared.
    value(await eraseArtifactData(db(), deps, { ...input, now: NOW + 1, idempotencyKey: key() }));
    value(
      await declareDataCollection(db(), deps, {
        ...input,
        now: NOW + 2,
        idempotencyKey: key(),
        declaration: { name: "later", mode: "shared" },
      }),
    );
    value(
      await createDataDocument(db(), deps, {
        ...input,
        now: NOW + 3,
        idempotencyKey: key(),
        collection: "later",
        body: {},
      }),
    );
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("stale");
    expect(of(artifactId).durable.documents.size).toBe(1);
    expect(await events(artifactId, "data.erased")).toHaveLength(1);
    // A target whose owner D1 no longer names ends the same way, before any object step.
    await db()
      .update(schema.artifacts)
      .set({ ownerId: (await user("Other")).id })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await runDataReset(db(), objects, job, NOW + DATA_RESET_DELAY_MS)).toBe("stale");
    expect(of(artifactId).durable.documents.size).toBe(1);
  });

  it("answers unavailable without the binding, keeping the claim for a retry", async () => {
    const { deps, of } = harness();
    const { artifactId, input } = await seeded(deps);
    expect(
      await eraseArtifactData(
        db(),
        { ...deps, objects: null },
        { ...input, idempotencyKey: key() },
      ),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(of(artifactId).durable.documents.size).toBe(2);
  });
});

describe("deleting one author's documents", () => {
  it("deletes only that author's documents, in pages, and says when more are left", async () => {
    const { deps, of } = harness();
    const { artifactId, input } = await seeded(deps, 3);
    const removed = value(
      await deleteAuthorData(db(), deps, { ...input, idempotencyKey: key(), author: "owner" }),
    );
    expect(removed).toEqual({ removed: 3, more: false });
    expect(of(artifactId).durable.documents.size).toBe(0);
    expect(
      value(
        await deleteAuthorData(db(), deps, {
          ...input,
          idempotencyKey: key(),
          author: "v_AAAAAAAAAAAAAAAA",
        }),
      ),
    ).toEqual({ removed: 0, more: false });
  });

  it("stops after its pages with more left, and a second call finishes", async () => {
    const { deps } = harness();
    const { input } = await seeded(deps, 0);
    for (let n = 0; n < 6; n += 1) {
      value(
        await createDataDocuments(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          documents: Array.from({ length: 100 }, (_, m) => ({ m })),
        }),
      );
    }
    const first = value(
      await deleteAuthorData(db(), deps, { ...input, idempotencyKey: key(), author: "owner" }),
    );
    expect(first).toEqual({ removed: 500, more: true });
    const second = value(
      await deleteAuthorData(db(), deps, { ...input, idempotencyKey: key(), author: "owner" }),
    );
    expect(second).toEqual({ removed: 100, more: false });
    const left = value(
      await queryArtifactData(db(), deps, { ...input, query: { collection: "votes" } }),
    );
    expect(left.documents).toEqual([]);
  });

  it("refuses a key used for another request, and one past the horizon", async () => {
    const { deps } = harness();
    const { input } = await seeded(deps, 1);
    const idempotencyKey = key();
    value(await deleteAuthorData(db(), deps, { ...input, idempotencyKey, author: "owner" }));
    expect(
      await deleteAuthorData(db(), deps, {
        ...input,
        idempotencyKey,
        author: "v_AAAAAAAAAAAAAAAA",
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await deleteAuthorData(db(), deps, {
        ...input,
        now: NOW + ARTIFACT_DATA.horizonMs + 1,
        idempotencyKey,
        author: "owner",
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses a stranger and answers not_found while artifact data is off", async () => {
    const { deps } = harness();
    const { input } = await seeded(deps, 1);
    const stranger = await user("Stranger");
    expect(
      await deleteAuthorData(db(), deps, {
        ...input,
        userId: stranger.id,
        idempotencyKey: key(),
        author: "owner",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await deleteAuthorData(
        db(),
        { ...deps, enabled: false },
        { ...input, idempotencyKey: key(), author: "owner" },
      ),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("erase and author deletion refusals", () => {
  it("limits erases per artifact and minute, and refuses a key used for another request", async () => {
    const { deps } = harness();
    const { input } = await seeded(deps, 0);
    const later = NOW + 30 * 60_000;
    const shared = key();
    value(
      await deleteAuthorData(db(), deps, {
        ...input,
        now: later,
        idempotencyKey: shared,
        author: "owner",
      }),
    );
    expect(
      await eraseArtifactData(db(), deps, { ...input, now: later, idempotencyKey: shared }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    let refused: unknown = null;
    for (let n = 0; n < DATA_OWNER_WRITES_PER_MINUTE + 1 && refused === null; n += 1) {
      const answer = await eraseArtifactData(db(), deps, {
        ...input,
        now: later + 1,
        idempotencyKey: key(),
      });
      if (!answer.ok && answer.code === "rate_limited") refused = answer;
    }
    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("keeps a job's row when the object cannot answer", async () => {
    const { objects } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async () =>
        ({
          ok: false,
          code: "something_new",
          message: "unavailable",
          storage: { generation: 0, seq: 0, bytes: 0 },
        }) as never,
    }));
    const owner = await user("Owner");
    const { artifactId } = await publishSite(owner.id);
    await registerDataObject(db(), env.ARTIFACTS, "default", artifactId, NOW);
    const job = {
      id: 1,
      topic: "data_reset",
      payload: {
        ownerId: owner.id,
        generation: 0,
        epoch: 0,
        actor: owner.id,
        eraseId: `${NOW}.abcdefgh`,
      },
      availableAt: NOW,
      dispatchedAt: null,
      attempts: 0,
      createdAt: NOW,
      subject: artifactId,
      generation: null,
    } as never;
    await expect(runDataReset(db(), objects, job, NOW)).rejects.toThrow("could not reach");
  });

  it("stops an author deletion the object refuses", async () => {
    const { deps } = harness(true, (rpc) => ({
      ...rpc,
      ownerCommand: async (envelope, actor, command, limits, now) =>
        command.kind === "query"
          ? ({
              ok: false,
              code: "rate_limited",
              message: "slow down",
              storage: { generation: 0, seq: 0, bytes: 0 },
            } as never)
          : rpc.ownerCommand(envelope, actor, command, limits, now),
    }));
    const { input } = await seeded(deps, 1);
    expect(
      await deleteAuthorData(db(), deps, { ...input, idempotencyKey: key(), author: "owner" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("the daily audit sweep", () => {
  it("relays an obligation whose job is gone, once a day, and the relay records it", async () => {
    const { deps, objects } = harness();
    const { artifactId } = await seeded(deps, 1);
    // A restore rewound the jobs: the object still holds both obligations pending.
    await db()
      .delete(schema.outbox)
      .where(and(eq(schema.outbox.topic, "data_audit"), eq(schema.outbox.subject, artifactId)));
    const later = NOW + PENDING_AUDIT_AGE_MS + 1;
    let relayed = 0;
    for (let run = 0; run < 20; run += 1) {
      const swept = await sweepDataAudit(db(), env.ARTIFACTS, objects, later);
      relayed += swept.relayed;
      if (swept.objects === 0 && run > 0) break;
    }
    const relays = await jobs("data_audit", artifactId);
    expect(relays).toHaveLength(2);
    expect(relayed).toBeGreaterThanOrEqual(2);
    // Within the day, nothing runs again.
    expect(await sweepDataAudit(db(), env.ARTIFACTS, objects, later + 1_000)).toEqual({
      objects: 0,
      relayed: 0,
    });
    for (const job of relays) expect(await runDataAudit(db(), objects, job, later)).toBe("done");
    expect(await events(artifactId, "data.documents_created")).toHaveLength(1);
    expect(await events(artifactId, "data.collection_set")).toHaveLength(1);
  });

  it("adds no job while one is waiting, nor for a recent obligation", async () => {
    const { deps, objects } = harness();
    const { artifactId } = await seeded(deps, 1);
    const sweepAll = async (now: number) => {
      for (let run = 0; run < 20; run += 1) {
        const swept = await sweepDataAudit(db(), env.ARTIFACTS, objects, now);
        if (swept.objects === 0 && run > 0) return;
      }
    };
    await sweepAll(NOW + 1_000);
    expect(await jobs("data_audit", artifactId)).toHaveLength(2);
    await sweepAll(NOW + 2 * 86_400_000);
    expect(await jobs("data_audit", artifactId)).toHaveLength(2);
  });

  it("does nothing without the binding", async () => {
    expect(await sweepDataAudit(db(), env.ARTIFACTS, null, NOW)).toEqual({
      objects: 0,
      relayed: 0,
    });
  });
});
