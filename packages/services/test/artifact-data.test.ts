// The artifact data jobs' every branch (decision 0026, delivery 4), against the in-memory
// reference object behind the lifecycle interface: the same decisions the real object calls, so
// these tests cover the services' ordering and answers here, in the services package. The same
// jobs against the real Durable Object, with the crash schedules and the restore drill, are in
// apps/data/test.
import { env } from "cloudflare:test";
import type { DataEnvelope } from "@portifact/contracts/artifact-data";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  formatReviewed,
  INVENTORY_PREFIX,
  inventoryEntry,
  inventoryKey,
  journalKey,
  LIFECYCLE_LIMITS,
  reviewedState,
} from "@portifact/domain/artifact-data";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_CHUNKS_PER_RUN,
  type DataObjectRpc,
  type DataObjects,
  eraseReason,
  lifecycleId,
  listDataFindings,
  pruneJournalCursors,
  queueDataExport,
  queueDataReconcile,
  queueDataResolve,
  reconcileObject,
  recordStorageReport,
  registerDataObject,
  retireJournalEntry,
  scheduleAuthorErasures,
  wakeDataJobs,
} from "../src/artifact-data.ts";
import { runJob } from "../src/outbox.ts";
import { db, NOW } from "./fixtures.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}
const visitorId = () => `v_${crypto.randomUUID().replaceAll("-", "")}`;
const CONTEXT = { now: NOW, limits: LIFECYCLE_LIMITS };

/** The reference objects behind the lifecycle interface, one per artifact. */
function memoryObjects(createsObjects = false) {
  const objects = new Map<string, MemoryObject>();
  const of = (id: string) => {
    let found = objects.get(id);
    if (!found) {
      found = new MemoryObject(id);
      objects.set(id, found);
    }
    return found;
  };
  const data: DataObjects = {
    region: "default",
    createsObjects,
    object(id): DataObjectRpc {
      const memory = of(id);
      return {
        lifecycleControl: async () => memory.durable.control,
        // The reference's answers may also be replays; the lifecycle commands never are.
        lifecycleFence: async (envelope, fence, now) => memory.fence(envelope, fence, now) as never,
        lifecycleErase: async (step, envelope, eraseId, reason, now) => {
          const required: DataEnvelope = { ...envelope, requiredErase: reason };
          if (step === "prepare") return memory.prepareErase(required, eraseId, now) as never;
          if (step === "commit") return memory.commitErase(required, eraseId, now) as never;
          return memory.cancelErase(required, eraseId, now) as never;
        },
        lifecycleEraseAuthor: async (envelope, visitor, opId, now) =>
          memory.eraseAuthorChunk({ ...envelope, opId }, visitor, 500, {
            now,
            limits: LIFECYCLE_LIMITS,
          }),
        lifecycleQuarantine: async (envelope, reason, now) =>
          memory.quarantine(envelope, reason, now) as never,
        lifecycleResolve: async (envelope, request, now) =>
          memory.resolveReviewed(envelope, request, now) as never,
        lifecycleExport: async (envelope, after, now) =>
          memory.exportPage(
            envelope,
            { kind: "owner", actor: "operator" },
            after,
            500,
            { now, limits: LIFECYCLE_LIMITS },
            true,
          ) as never,
      };
    },
  };
  return { data, of };
}

function envelope(id: string, ownerId: string, numbers = { generation: 0, epoch: 0 }) {
  return { artifactId: id, region: "default", ownerId, ...numbers };
}

/** An artifact with a registered object holding `documents` of the owner's and the visitors'. */
async function seeded(
  memory: ReturnType<typeof memoryObjects>,
  options: {
    state?: "active" | "suspended" | "purging";
    documents?: number;
    visitors?: string[];
  } = {},
) {
  const id = artifactId();
  const ownerId = `u_${crypto.randomUUID()}`;
  await db()
    .insert(schema.artifacts)
    .values({ id, ownerId, type: "site", name: "Plan", state: options.state ?? "active" });
  await registerDataObject(db(), env.ARTIFACTS, "default", id, NOW);
  const object = memory.of(id);
  const op = () => ({ ...envelope(id, ownerId), opId: lifecycleId(NOW) });
  object.declare(op(), { kind: "owner" }, { name: "notes", mode: "shared" }, CONTEXT);
  for (let n = 0; n < (options.documents ?? 1); n += 1) {
    object.create(op(), { kind: "owner" }, "notes", { n }, CONTEXT);
  }
  for (const visitor of options.visitors ?? []) {
    object.create(op(), { kind: "visitor", author: visitor, canWrite: true }, "notes", {}, CONTEXT);
  }
  return { id, ownerId, object };
}

async function job(
  topic: (typeof schema.OUTBOX_TOPICS)[number],
  subject: string,
  payload: unknown,
) {
  const [row] = await db()
    .insert(schema.outbox)
    .values({ topic, payload, availableAt: NOW, subject })
    .returning();
  if (!row) throw new Error("no row");
  return row;
}

const run = (
  row: { id: number; topic: (typeof schema.OUTBOX_TOPICS)[number] },
  data: DataObjects | null,
  now = NOW,
) => runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic }, now, { data });

async function rowOf(id: number) {
  const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.id, id));
  return row ?? null;
}

const documents = (object: MemoryObject, author?: string) =>
  [...object.durable.documents.values()].filter(
    (doc) => author === undefined || doc.author === author,
  ).length;

describe("every data job needs the binding", () => {
  it("throws without it, so the row stays for a Worker that has it", async () => {
    for (const topic of [
      "data_fence",
      "data_erase",
      "data_author_erasure",
      "data_reconcile",
      "data_resolve",
      "data_export",
    ] as const) {
      const row = await job(topic, artifactId(), {});
      await expect(run(row, null)).rejects.toThrow(`${topic} needs the artifact data binding`);
      expect(await rowOf(row.id)).not.toBeNull();
    }
  });
});

describe("data_fence", () => {
  const hold = { kind: "hold", transition: "hold_svc" } as const;

  it("ends without binding an object while artifact data is off", async () => {
    const memory = memoryObjects();
    const row = await job("data_fence", artifactId(), {
      ownerId: "u_x",
      generation: 0,
      epoch: 1,
      fence: hold,
    });
    expect(await run(row, memory.data)).toBe("done");
    expect(memory.of(row.subject ?? "").durable.control).toBeNull();
  });

  it("binds an empty object when artifact data is on, so the hold precedes any data", async () => {
    const memory = memoryObjects(true);
    const row = await job("data_fence", artifactId(), {
      ownerId: "u_x",
      generation: 0,
      epoch: 1,
      fence: hold,
    });
    expect(await run(row, memory.data)).toBe("done");
    expect(memory.of(row.subject ?? "").durable.control?.hold).not.toBeNull();
  });

  it("applies a fence, retries one that must wait, and ends one the object is past", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    // A transfer to another owner of a held object waits for the release.
    object.fence(envelope(id, ownerId, { generation: 0, epoch: 1 }), hold, NOW);
    const transfer = await job("data_fence", id, {
      ownerId,
      generation: 0,
      epoch: 2,
      fence: { kind: "transfer", transition: "transfer_svc", toOwner: "u_new" },
    });
    expect(await run(transfer, memory.data)).toBe("pending");
    const old = await job("data_fence", id, {
      ownerId,
      generation: 0,
      epoch: 1,
      fence: { kind: "hold", transition: "hold_old" },
    });
    expect(await run(old, memory.data)).toBe("stale");
    const same = await job("data_fence", id, { ownerId, generation: 0, epoch: 7, fence: hold });
    expect(await run(same, memory.data)).toBe("stale");
    const release = await job("data_fence", id, {
      ownerId,
      generation: 0,
      epoch: 3,
      fence: { kind: "release", transition: "release_svc" },
    });
    expect(await run(release, memory.data)).toBe("done");
    expect(object.durable.control?.hold).toBeNull();
  });
});

describe("data_erase", () => {
  it("retires the inventory entry of an object nothing bound, creating nothing", async () => {
    const memory = memoryObjects();
    const id = artifactId();
    const row = await job("data_erase", id, { ownerId: "u_x", generation: 0, epoch: 0 });
    expect(await run(row, memory.data)).toBe("done");
    expect(memory.of(id).durable.control).toBeNull();
    const entry = await env.ARTIFACTS.get(inventoryKey(id));
    expect(((await entry?.json()) as { retiredAt?: number })?.retiredAt).toBe(NOW);
  });

  it("commits a whole erase; a later delivery of a real purge is done again", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory, { documents: 3 });
    const payload = { ownerId, generation: 0, epoch: 0 };
    expect(await run(await job("data_erase", id, payload), memory.data)).toBe("done");
    expect(documents(object)).toBe(0);
    expect(object.durable.control?.generation).toBe(1);
    // D1 proves the permanent deletion: the old job erases the object's own generation.
    await regionsFromEnv(env)
      .global.insert(schema.tombstones)
      .values({ kind: "artifact", id, deletedAt: NOW });
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(await run(await job("data_erase", id, payload), memory.data)).toBe("done");
    expect(object.durable.control?.generation).toBe(2);
  });

  it("keeps a superseded purge, with its entry and a finding, without D1's proof", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory, { documents: 1 });
    const eraseId = lifecycleId(NOW);
    object.prepareErase(envelope(id, ownerId), eraseId, NOW);
    object.commitErase(envelope(id, ownerId), eraseId, NOW);
    const row = await job("data_erase", id, { ownerId, generation: 0, epoch: 0 });
    expect(await run(row, memory.data)).toBe("kept");
    expect((await rowOf(row.id))?.availableAt).toBe(NOW + 86_400_000);
    const entry = (await (await env.ARTIFACTS.get(inventoryKey(id)))?.json()) as {
      retiredAt?: number;
    };
    expect(entry.retiredAt).toBeUndefined();
    expect((await listDataFindings(db(), 1000)).find((f) => f.artifactId === id)?.action).toBe(
      "superseded",
    );
  });

  it("waits a day while held, erasing nothing", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    object.fence(
      envelope(id, ownerId, { generation: 0, epoch: 1 }),
      { kind: "hold", transition: "h1" },
      NOW,
    );
    const row = await job("data_erase", id, { ownerId, generation: 0, epoch: 1 });
    expect(await run(row, memory.data)).toBe("kept");
    expect((await rowOf(row.id))?.availableAt).toBe(NOW + 86_400_000);
    expect(documents(object)).toBe(1);
    await wakeDataJobs(db(), id, NOW + 5);
    expect((await rowOf(row.id))?.availableAt).toBe(NOW + 5);
  });

  it("retries a commit the object refused, and an intent that ended cancelled", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    // Another owner in the envelope: stale, so the job comes back.
    expect(
      await run(
        await job("data_erase", id, { ownerId: "u_other", generation: 0, epoch: 0 }),
        memory.data,
      ),
    ).toBe("pending");
    // A prepared intent the job resumes, cancelled by a racing step between its read and commit.
    const eraseId = lifecycleId(NOW);
    object.prepareErase({ ...envelope(id, ownerId), requiredErase: "purge" }, eraseId, NOW);
    object.cancelErase({ ...envelope(id, ownerId), requiredErase: "purge" }, eraseId, NOW);
    const racing = memoryObjects();
    racing.of(id).durable = object.durable;
    const prepared = racing.data.object(id);
    const view = {
      ...prepared,
      lifecycleControl: async () => ({
        ...(object.durable.control as NonNullable<typeof object.durable.control>),
        erasing: { id: eraseId, generation: 0, epoch: 0 },
      }),
    };
    const data: DataObjects = { ...racing.data, object: () => view };
    expect(await run(await job("data_erase", id, { ownerId, generation: 0, epoch: 0 }), data)).toBe(
      "pending",
    );
  });
});

describe("eraseReason", () => {
  it("names an account's or a workspace's deletion, pending or done, and a purge otherwise", async () => {
    const global = regionsFromEnv(env).global;
    const user = `u_${crypto.randomUUID()}`;
    expect(await eraseReason(global, user)).toBe("purge");
    await global.insert(schema.accountDeletions).values({ userId: user, requestedAt: NOW });
    expect(await eraseReason(global, user)).toBe("account_deletion");
    const gone = `u_${crypto.randomUUID()}`;
    await global.insert(schema.tombstones).values({ kind: "account", id: gone, deletedAt: NOW });
    expect(await eraseReason(global, gone)).toBe("account_deletion");
    const workspace = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    expect(await eraseReason(global, workspace)).toBe("purge");
    await global
      .insert(schema.tombstones)
      .values({ kind: "workspace", id: workspace, deletedAt: NOW });
    expect(await eraseReason(global, workspace)).toBe("workspace_deletion");
  });
});

describe("data_author_erasure", () => {
  it("retires the entry and ends when the artifact holds no data", async () => {
    const memory = memoryObjects();
    const userId = `u_${crypto.randomUUID()}`;
    const id = artifactId();
    const row = await job("data_author_erasure", id, { userId, visitorId: visitorId() });
    expect(await run(row, memory.data)).toBe("done");
    const entry = (await (await env.ARTIFACTS.get(journalKey(userId, id)))?.json()) as {
      retiredAt?: number;
      visitorId: string | null;
    };
    expect(entry).toEqual({ visitorId: null, firstGrantAt: NOW, retiredAt: NOW });
  });

  it("ends on an object nothing bound while data is off", async () => {
    const memory = memoryObjects();
    const id = artifactId();
    await db().insert(schema.artifacts).values({ id, ownerId: "u_x", type: "site", name: "P" });
    await db().insert(schema.artifactData).values({ artifactId: id, updatedAt: NOW });
    const row = await job("data_author_erasure", id, { userId: "u_y", visitorId: visitorId() });
    expect(await run(row, memory.data)).toBe("done");
    expect(memory.of(id).durable.control).toBeNull();
  });

  it("erases the visitor's documents, keeps going in later runs, and waits while held", async () => {
    const memory = memoryObjects();
    const visitor = visitorId();
    const { id, ownerId, object } = await seeded(memory, { visitors: [visitor, visitor] });
    const userId = `u_${crypto.randomUUID()}`;
    const row = await job("data_author_erasure", id, { userId, visitorId: visitor });
    expect(await run(row, memory.data)).toBe("done");
    expect(documents(object, visitor)).toBe(0);
    expect(documents(object)).toBe(1);

    const held = await seeded(memory, { visitors: [visitor] });
    held.object.fence(
      envelope(held.id, held.ownerId, { generation: 0, epoch: 1 }),
      { kind: "hold", transition: "h2" },
      NOW,
    );
    await db()
      .update(schema.artifactData)
      .set({ epoch: 1 })
      .where(eq(schema.artifactData.artifactId, held.id));
    const waiting = await job("data_author_erasure", held.id, { userId, visitorId: visitor });
    expect(await run(waiting, memory.data)).toBe("kept");
    expect(documents(held.object, visitor)).toBe(1);
    void ownerId;
  });

  it("gives the queue back after its chunks and continues on the next run", async () => {
    const memory = memoryObjects();
    const visitor = visitorId();
    const { id } = await seeded(memory, { visitors: [visitor] });
    const data: DataObjects = {
      ...memory.data,
      object: (artifact) => {
        const real = memory.data.object(artifact);
        return {
          ...real,
          lifecycleEraseAuthor: async (...args) => {
            const answer = await real.lifecycleEraseAuthor(...args);
            return answer.ok && "value" in answer
              ? { ...answer, value: { ...answer.value, more: true } }
              : answer;
          },
        };
      },
    };
    const row = await job("data_author_erasure", id, { userId: "u_z", visitorId: visitor });
    expect(await run(row, data)).toBe("kept");
    expect(AUTHOR_CHUNKS_PER_RUN).toBeGreaterThan(1);
  });
});

describe("the journal step of an account deletion", () => {
  it("walks one page of entries per call and asks for more past it", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    // The scan keeps its position only while the account's deletion is pending.
    await regionsFromEnv(env)
      .global.insert(schema.accountDeletions)
      .values({ userId, requestedAt: NOW });
    // Written together: the entries' order does not matter to the listing.
    await Promise.all(
      Array.from({ length: 101 }, (_, n) =>
        env.ARTIFACTS.put(
          journalKey(userId, `a${String(n).padStart(9, "a")}`),
          JSON.stringify({ visitorId: visitorId(), firstGrantAt: NOW }),
        ),
      ),
    );
    const first = await scheduleAuthorErasures(db(), env.ARTIFACTS, userId, NOW);
    expect(first).toEqual({ more: true, scheduled: 100 });
    const second = await scheduleAuthorErasures(db(), env.ARTIFACTS, userId, NOW);
    // The pass retired something, so another from the start must find nothing.
    expect(second).toEqual({ more: true, scheduled: 1 });
    // R2 may answer a listing with metadata in smaller pages; the scan follows them to the end.
    let calls = 0;
    let last = second;
    while (last.more && calls < 5) {
      last = await scheduleAuthorErasures(db(), env.ARTIFACTS, userId, NOW);
      expect(last.scheduled).toBe(0);
      calls += 1;
    }
    expect(last.more).toBe(false);
    // A finished scan leaves no cursor behind.
    const cursors = await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, `data_journal:${userId}`));
    expect(cursors).toEqual([]);
  });

  it("keeps a scan's position only while the deletion is pending, and prunes leftovers", async () => {
    const pending = `u_${crypto.randomUUID()}`;
    const ended = `u_${crypto.randomUUID()}`;
    const global = regionsFromEnv(env).global;
    await global.insert(schema.accountDeletions).values({ userId: pending, requestedAt: NOW });
    const c = schema.maintenanceCursors;
    const listing = {
      objects: [{ key: journalKey(pending, "aaaaaaaaaa"), customMetadata: { retired: "1" } }],
      truncated: true,
      delimitedPrefixes: [],
    };
    const bucket = { list: async () => listing } as unknown as R2Bucket;
    await scheduleAuthorErasures(db(), bucket, pending, NOW);
    // No pending deletion: the position is never written.
    await scheduleAuthorErasures(db(), bucket, ended, NOW);
    const names = async () =>
      (await db().select({ name: c.name }).from(c).where(sql`${c.name} like 'data_journal:%'`)).map(
        (row) => row.name,
      );
    expect(await names()).toContain(`data_journal:${pending}`);
    expect(await names()).not.toContain(`data_journal:${ended}`);
    // A leftover (a late write after the deletion ended) goes with the next maintenance run.
    await db()
      .insert(c)
      .values({ name: `data_journal:${ended}`, cursor: "{}", passStartedAt: NOW, updatedAt: NOW });
    expect(await pruneJournalCursors(db())).toBeGreaterThanOrEqual(1);
    expect(await names()).toContain(`data_journal:${pending}`);
    expect(await names()).not.toContain(`data_journal:${ended}`);
  });

  it("retires an entry a racing claim changed, from what it reads again", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const id = artifactId();
    const first = visitorId();
    await env.ARTIFACTS.put(
      journalKey(userId, id),
      JSON.stringify({ visitorId: first, firstGrantAt: NOW }),
    );
    const bucket = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "put") {
          let raced = false;
          return async (key: string, value: string, options?: R2PutOptions) => {
            if (!raced) {
              raced = true;
              await target.put(key, JSON.stringify({ visitorId: first, firstGrantAt: NOW - 1 }));
            }
            return target.put(key, value, options);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const retired = await retireJournalEntry(bucket, userId, id, NOW);
    expect(retired).toEqual({ visitorId: first, firstGrantAt: NOW - 1, retiredAt: NOW });
  });
});

describe("reconciliation", () => {
  it("walks the inventory, then the journal, re-deriving author erasures and pruning old entries", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    // D1 behind the object: raised.
    const eraseId = lifecycleId(NOW);
    object.prepareErase(envelope(id, ownerId), eraseId, NOW);
    object.commitErase(envelope(id, ownerId), eraseId, NOW);
    const old = artifactId();
    await env.ARTIFACTS.put(
      inventoryKey(old),
      JSON.stringify({ ...inventoryEntry(old, "default", 0), retiredAt: 0 }),
    );
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    await env.ARTIFACTS.put(
      journalKey(userId, id),
      JSON.stringify({ visitorId: visitor, firstGrantAt: NOW, retiredAt: NOW + 39 * 86_400_000 }),
    );
    const stale = `u_${crypto.randomUUID()}`;
    await env.ARTIFACTS.put(
      journalKey(stale, id),
      JSON.stringify({ visitorId: null, firstGrantAt: 0, retiredAt: 0 }),
    );
    await queueDataReconcile(db(), NOW);
    const later = NOW + 40 * 86_400_000;
    for (let round = 0; round < 500; round += 1) {
      const [row] = await db()
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.subject, `reconcile:${NOW}`));
      if (!row) break;
      await run(row, memory.data, later);
    }
    expect(
      (
        await db().select().from(schema.artifactData).where(eq(schema.artifactData.artifactId, id))
      )[0]?.generation,
    ).toBe(1);
    expect(await env.ARTIFACTS.get(inventoryKey(old))).toBeNull();
    expect(await env.ARTIFACTS.get(journalKey(stale, id))).toBeNull();
    const jobs = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, id));
    expect(jobs.map((row) => row.payload)).toContainEqual({ userId, visitorId: visitor });
    expect((await listDataFindings(db(), 1000)).find((f) => f.artifactId === id)?.action).toBe(
      "raised",
    );
    expect(INVENTORY_PREFIX.length).toBeGreaterThan(0);
  });

  it("quarantines an orphan once, leaves a quarantined object to the operator, and ignores a purged one", async () => {
    const memory = memoryObjects();
    const { id, object } = await seeded(memory);
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, id));
    const entry = inventoryEntry(id, "default", NOW);
    expect(await reconcileObject(db(), memory.data, entry, NOW)).toBe("quarantine:orphan");
    expect(await reconcileObject(db(), memory.data, entry, NOW + 1)).toBe("operator");
    const [finding] = (await listDataFindings(db(), 1000)).filter((f) => f.artifactId === id);
    expect([finding?.action, finding?.reason, finding?.lastSeenAt]).toEqual([
      "quarantined",
      "orphan",
      NOW + 1,
    ]);
    expect(object.durable.control?.quarantine?.reason).toBe("orphan");
    const purged = await seeded(memory);
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, purged.id));
    expect(
      await reconcileObject(
        db(),
        memory.data,
        { ...inventoryEntry(purged.id, "default", NOW), retiredAt: NOW },
        NOW,
      ),
    ).toBe("none");
    expect(
      await reconcileObject(db(), memory.data, inventoryEntry(artifactId(), "default", NOW), NOW),
    ).toBe("none");
  });

  it("resumes a prepared erase and records a refused one", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    object.prepareErase(envelope(id, ownerId), lifecycleId(NOW), NOW);
    expect(await reconcileObject(db(), memory.data, inventoryEntry(id, "default", NOW), NOW)).toBe(
      "resume_erase",
    );
    expect(object.durable.control?.generation).toBe(1);
    const refused = await seeded(memory);
    refused.object.prepareErase(envelope(refused.id, refused.ownerId), lifecycleId(NOW), NOW);
    const data: DataObjects = {
      ...memory.data,
      object: (artifact) => ({
        ...memory.data.object(artifact),
        lifecycleErase: async () => ({
          ok: false,
          code: "held",
          message: "held",
          storage: { generation: 0, seq: 0, bytes: 0 },
        }),
      }),
    };
    expect(await reconcileObject(db(), data, inventoryEntry(refused.id, "default", NOW), NOW)).toBe(
      "refused:held",
    );
  });
});

describe("data_resolve", () => {
  const reviewed = (object: MemoryObject) => {
    const state = object.durable.control && reviewedState(object.durable.control);
    if (!state) throw new Error("not quarantined");
    return state;
  };
  const resolve = (
    id: string,
    decision: "adopt" | "erase",
    expected: ReturnType<typeof reviewed>,
  ) => job("data_resolve", id, { decision, resolutionId: lifecycleId(NOW), expected });
  const findingOf = async (id: string) =>
    (await listDataFindings(db(), 1000)).find((f) => f.artifactId === id);

  it("refuses with nothing to resolve, or an owner D1 does not name", async () => {
    const memory = memoryObjects();
    const expected = (id: string) => ({
      artifactId: id,
      region: "default",
      incarnation: 1,
      reason: "owner" as const,
      ownerId: "u_x",
      generation: 0,
      epoch: 0,
    });
    const missing = artifactId();
    expect(await run(await resolve(missing, "adopt", expected(missing)), memory.data)).toBe(
      "stale",
    );
    const { id, object } = await seeded(memory);
    expect(await run(await resolve(id, "adopt", expected(id)), memory.data)).toBe("stale");
    expect((await findingOf(id))?.reason).toBe("stale");
    object.quarantine(envelope(id, "u_x"), "owner", NOW);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: "u_someone_else" })
      .where(eq(schema.artifacts.id, id));
    expect(await run(await resolve(id, "adopt", reviewed(object)), memory.data)).toBe("stale");
    expect(object.durable.control?.quarantine).not.toBeNull();
  });

  it("refuses a state of another artifact or region before reading the object", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    object.quarantine(envelope(id, ownerId), "orphan", NOW);
    const reads = { count: 0 };
    const counted: DataObjects = {
      ...memory.data,
      object: (artifact) => {
        const real = memory.data.object(artifact);
        return {
          ...real,
          lifecycleControl: async () => {
            reads.count += 1;
            return real.lifecycleControl();
          },
        };
      },
    };
    const state = reviewed(object);
    expect(
      await run(await resolve(id, "erase", { ...state, artifactId: artifactId() }), counted),
    ).toBe("stale");
    expect(await run(await resolve(id, "erase", { ...state, region: "eu" }), counted)).toBe(
      "stale",
    );
    expect(reads.count).toBe(0);
    expect((await findingOf(id))?.reason).toBe("forbidden");
    expect(documents(object)).toBe(1);
  });

  it("adopts the reviewed quarantine once, keeping D1's hold, and wakes waiting jobs", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory, { state: "suspended" });
    object.quarantine(envelope(id, ownerId), "hold", NOW);
    await db()
      .insert(schema.legalHolds)
      .values({
        id: `hold_${"b".repeat(32)}`,
        artifactId: id,
        ownerId,
        reason: "other",
        ground: "Order",
        createdAt: NOW,
      });
    const waiting = await job("data_erase", id, { ownerId, generation: 0, epoch: 0 });
    await db()
      .update(schema.outbox)
      .set({ availableAt: NOW + 86_400_000 })
      .where(eq(schema.outbox.id, waiting.id));
    const row = await resolve(id, "adopt", reviewed(object));
    expect(await run(row, memory.data)).toBe("done");
    expect(object.durable.control?.quarantine).toBeNull();
    expect(object.durable.control?.hold?.transition).toBe(`hold_${"b".repeat(32)}`);
    expect((await rowOf(waiting.id))?.availableAt).toBe(NOW);
    expect((await findingOf(id))?.action).toBe("adopted");
    // The same resolution delivered again finishes the same way and changes nothing.
    const again = await job("data_resolve", id, row.payload);
    expect(await run(again, memory.data)).toBe("done");
  });

  it("refuses to erase while D1 holds, whatever the object says", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory, { state: "suspended" });
    object.quarantine(envelope(id, ownerId), "hold", NOW);
    await db()
      .insert(schema.legalHolds)
      .values({
        id: `hold_${"c".repeat(32)}`,
        artifactId: id,
        ownerId,
        reason: "other",
        ground: "Order",
        createdAt: NOW,
      });
    expect(await run(await resolve(id, "erase", reviewed(object)), memory.data)).toBe("stale");
    expect((await findingOf(id))?.reason).toBe("held");
    expect(documents(object)).toBe(1);
  });

  it("erases an orphan and retires its entry; refuses while the object holds", async () => {
    const memory = memoryObjects();
    const { id, ownerId, object } = await seeded(memory);
    object.fence(
      envelope(id, ownerId, { generation: 0, epoch: 1 }),
      { kind: "hold", transition: "h3" },
      NOW,
    );
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, id));
    await reconcileObject(db(), memory.data, inventoryEntry(id, "default", NOW), NOW);
    expect((await findingOf(id))?.state).toBe(formatReviewed(reviewed(object)));
    expect(await run(await resolve(id, "erase", reviewed(object)), memory.data)).toBe("stale");
    expect((await findingOf(id))?.reason).toBe("held");
    object.fence(
      { ...envelope(id, ownerId, { generation: 0, epoch: 2 }) },
      { kind: "release", transition: "r3" },
      NOW,
    );
    await queueDataResolve(db(), id, "erase", reviewed(object), NOW);
    const [row] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.subject, id), eq(schema.outbox.topic, "data_resolve")));
    if (!row) throw new Error("no job");
    expect(await run(row, memory.data)).toBe("done");
    expect(object.durable.control?.generation).toBe(1);
    const entry = (await (await env.ARTIFACTS.get(inventoryKey(id)))?.json()) as {
      retiredAt?: number;
    };
    expect(entry.retiredAt).toBe(NOW);
  });
});

describe("data_export", () => {
  it("writes each page under its key and ends after the last one", async () => {
    const memory = memoryObjects();
    const { id } = await seeded(memory, { documents: 2 });
    const key = await queueDataExport(db(), id, NOW);
    const [row] = await db().select().from(schema.outbox).where(eq(schema.outbox.subject, id));
    if (!row) throw new Error("no job");
    expect(await run(row, memory.data)).toBe("done");
    const page = await (await env.ARTIFACTS.get(`${key}/000000.jsonl`))?.text();
    const lines = (page ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ artifact: id, generation: 0, page: 0 });
    // The header and the two documents.
    expect(lines).toHaveLength(3);
  });

  it("follows the cursor across runs, and exports nothing from an empty or refusing object", async () => {
    const memory = memoryObjects();
    const { id } = await seeded(memory);
    const data: DataObjects = {
      ...memory.data,
      object: (artifact) => {
        const real = memory.data.object(artifact);
        let first = true;
        return {
          ...real,
          lifecycleExport: async (...args) => {
            const answer = await real.lifecycleExport(...args);
            if (!answer.ok || !first) return answer;
            first = false;
            return {
              ...answer,
              value: { ...answer.value, next: { collection: "notes", id: "aaaaaaaaaaaaaaaa" } },
            };
          },
        };
      },
    };
    const key = `system/data-exports/${id}.paged`;
    const row = await job("data_export", id, { key, after: null, page: 0 });
    expect(await run(row, data)).toBe("kept");
    expect((await rowOf(row.id))?.payload).toEqual({
      key,
      after: { collection: "notes", id: "aaaaaaaaaaaaaaaa" },
      page: 1,
    });
    expect(
      await run(
        await job("data_export", artifactId(), { key: `${key}2`, after: null, page: 0 }),
        memory.data,
      ),
    ).toBe("done");
    const refusing: DataObjects = {
      ...memory.data,
      object: (artifact) => ({
        ...memory.data.object(artifact),
        lifecycleExport: async () => ({
          ok: false,
          code: "forbidden",
          message: "no",
          storage: { generation: 0, seq: 0, bytes: 0 },
        }),
      }),
    };
    expect(
      await run(await job("data_export", id, { key: `${key}3`, after: null, page: 0 }), refusing),
    ).toBe("stale");
  });
});

describe("storage reports", () => {
  it("keeps only a newer report: a later generation, or the same one at a later sequence", async () => {
    const memory = memoryObjects();
    const { id } = await seeded(memory);
    const bytesOf = async () =>
      (
        await db().select().from(schema.artifactData).where(eq(schema.artifactData.artifactId, id))
      )[0]?.documentsBytes;
    await recordStorageReport(db(), id, { generation: 1, seq: 5, bytes: 100 }, NOW);
    await recordStorageReport(db(), id, { generation: 1, seq: 4, bytes: 50 }, NOW);
    await recordStorageReport(db(), id, { generation: 0, seq: 9, bytes: 40 }, NOW);
    expect(await bytesOf()).toBe(100);
    await recordStorageReport(db(), id, { generation: 1, seq: 6, bytes: 70 }, NOW);
    expect(await bytesOf()).toBe(70);
    await recordStorageReport(db(), id, { generation: 2, seq: 1, bytes: 10 }, NOW);
    expect(await bytesOf()).toBe(10);
  });
});
