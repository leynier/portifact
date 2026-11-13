import { env, runInDurableObject } from "cloudflare:test";
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  controlEnvelope,
  inventoryEntry,
  inventoryKey,
  journalKey,
  reviewedState,
} from "@portifact/domain/artifact-data";
import { lifecycleId, queueDataResolve, runJob, scheduleAuthorErasures } from "@portifact/services";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  bucketOf,
  controlOf,
  db,
  documentsOf,
  inside,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

it("a durable resolution receipt is pruned after the replay window; retry refuses safely", async () => {
  const { id } = await withData();
  const c = (await controlOf(id))!;
  await stubOf(id).lifecycleQuarantine(controlEnvelope(c), "orphan", NOW);
  const q = (await controlOf(id))!;
  const request = {
    id: lifecycleId(NOW),
    decision: "adopt" as const,
    expected: reviewedState(q)!,
    hold: null,
  };
  expect(await stubOf(id).lifecycleResolve(controlEnvelope(q), request, NOW)).toMatchObject({
    ok: true,
    value: { repeated: false },
  });
  expect(await stubOf(id).lifecycleResolve(controlEnvelope(q), request, NOW)).toMatchObject({
    ok: true,
    value: { repeated: true },
  });
  await inside(id, (o) => o.store.alarm(NOW + ARTIFACT_DATA.replayMs + 1));
  expect(await inside(id, (o) => o.store.inspect("pf_ended"))).toEqual([]);
  expect(
    await stubOf(id).lifecycleResolve(
      controlEnvelope((await controlOf(id))!),
      request,
      NOW + ARTIFACT_DATA.replayMs + 2,
    ),
  ).toMatchObject({ ok: false, code: "conflict" });
  expect(await documentsOf(id)).toBe(1);
});

// The scan keeps its position only while the account's deletion is pending (F5), so these tests
// start one.
const deleting = (userId: string) =>
  regionsFromEnv(env).global.insert(schema.accountDeletions).values({ userId, requestedAt: NOW });

it("the journal scan finds a behind-cursor entry on its next pass and removes its cursor", async () => {
  const userId = "u_scan_" + crypto.randomUUID();
  await deleting(userId);
  const keys = Array.from({ length: 10001 }, (_, i) =>
    journalKey(userId, `x${String(i).padStart(9, "0")}`),
  );
  const contents = new Map(
    keys.map((k, i) => [
      k,
      {
        visitorId: `v_${"a".repeat(24)}`,
        firstGrantAt: NOW,
        ...(i < 10000 ? { retiredAt: NOW } : {}),
      },
    ]),
  );
  let lists = 0,
    inserted = false;
  const late = journalKey(userId, "aaaaaaaaaa");
  const bucket = {
    async list(options: R2ListOptions) {
      lists++;
      const all = [...contents.keys()]
        .sort()
        .filter((k) => !options.startAfter || k > options.startAfter);
      const page = all.slice(0, options.limit);
      if (options.startAfter && !inserted) {
        contents.set(late, { visitorId: `v_${"b".repeat(24)}`, firstGrantAt: NOW });
        inserted = true;
      }
      return {
        objects: page.map((key) => ({
          key,
          customMetadata: contents.get(key)?.retiredAt === undefined ? {} : { retired: "1" },
        })),
        truncated: all.length > page.length,
        delimitedPrefixes: [],
      };
    },
    async get(key: string) {
      const v = contents.get(key);
      return v ? { etag: "a", json: async () => ({ ...v }) } : null;
    },
    async put(key: string, value: string) {
      contents.set(key, JSON.parse(value));
      return { etag: "b" };
    },
  } as unknown as R2Bucket;
  let done = false;
  for (let run = 0; run < 40; run++) {
    const before = lists;
    const result = await scheduleAuthorErasures(db(), bucket, userId, NOW + run);
    expect(lists - before).toBe(1);
    if (!result.more) {
      done = true;
      break;
    }
  }
  expect(done).toBe(true);
  expect(contents.get(late)?.retiredAt).toBeDefined();
  expect(await jobsOf(db(), ["data_author_erasure"], "aaaaaaaaaa")).toHaveLength(1);
  expect(
    await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, `data_journal:${userId}`)),
  ).toEqual([]);
});

it("a late scan cannot recreate its cursor after a concurrent clean completion", async () => {
  const userId = "u_race_" + crypto.randomUUID(),
    name = `data_journal:${userId}`;
  await deleting(userId);
  const key = journalKey(userId, "aaaaaaaaaa");
  let unblock!: () => void, observed!: () => void;
  const gate = new Promise<void>((r) => (unblock = r)),
    started = new Promise<void>((r) => (observed = r));
  const first = {
    objects: [{ key, customMetadata: { retired: "1" } }],
    truncated: true,
    delimitedPrefixes: [],
  };
  const slow = {
    async list() {
      observed();
      await gate;
      return first;
    },
  } as unknown as R2Bucket;
  const fast = {
    async list(options: R2ListOptions) {
      return options.startAfter ? { objects: [], truncated: false, delimitedPrefixes: [] } : first;
    },
  } as unknown as R2Bucket;
  const old = scheduleAuthorErasures(db(), slow, userId, NOW);
  await started;
  expect((await scheduleAuthorErasures(db(), fast, userId, NOW + 1)).more).toBe(true);
  expect((await scheduleAuthorErasures(db(), fast, userId, NOW + 2)).more).toBe(false);
  // The winning account-deletion advancement now finishes; no future run scans this user.
  await regionsFromEnv(env)
    .global.delete(schema.accountDeletions)
    .where(eq(schema.accountDeletions.userId, userId));
  unblock();
  await old;
  expect(
    await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, name)),
  ).toEqual([]);
});

it("erase resolution wakes an orphan author erasure and clears the obligation", async () => {
  const visitorId = `v_${"c".repeat(24)}`;
  const { id } = await withData({ visitors: [visitorId] });
  await db().delete(schema.artifactData).where(eq(schema.artifactData.artifactId, id));
  let c = (await controlOf(id))!;
  await stubOf(id).lifecycleQuarantine(controlEnvelope(c), "orphan", NOW);
  await db()
    .insert(schema.outbox)
    .values({
      topic: "data_author_erasure",
      subject: id,
      payload: { userId: "u_erased", visitorId },
      availableAt: NOW,
    });
  const run = async (topic: string) => {
    const [r] = await jobsOf(db(), [topic], id);
    return runJob(db(), bucketOf(), { id: r!.id, topic: r!.topic }, NOW, { data: objectsFor() });
  };
  expect(await run("data_author_erasure")).toBe("kept");
  c = (await controlOf(id))!;
  await queueDataResolve(db(), id, "erase", reviewedState(c)!, NOW);
  expect(await run("data_resolve")).toBe("done");
  expect((await jobsOf(db(), ["data_author_erasure"], id))[0]?.availableAt).toBe(NOW);
  expect(await run("data_author_erasure")).toBe("done");
  expect(await documentsOf(id, visitorId)).toBe(0);
});

it("invalid RPC performs zero SQL calls, independent of the query spelling", async () => {
  const { storeFor } = await import("../src/documents.ts");
  const { id } = await withData();
  const observed = await runInDurableObject(stubOf(id), (object, state) => {
    let calls = 0;
    const sql = new Proxy(state.storage.sql, {
      get(target, p) {
        if (p === "exec")
          return (...args: Parameters<typeof target.exec>) => {
            calls++;
            return target.exec(...args);
          };
        if (p === "databaseSize") {
          calls++;
          return target.databaseSize;
        }
        return Reflect.get(target, p, target);
      },
    });
    const storage = new Proxy(state.storage, {
      get(target, p) {
        if (p === "sql") return sql;
        const v = Reflect.get(target, p, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const ctx = new Proxy(state, {
      get(target, p) {
        if (p === "storage") return storage;
        const v = Reflect.get(target, p, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    object.store = storeFor(ctx, object.clients);
    calls = 0;
    const answer = object.lifecycleFence({}, {}, NOW);
    return { answer, calls };
  });
  expect(observed.answer).toMatchObject({ ok: false, code: "invalid_input" });
  expect(observed.calls).toBe(0);
});
