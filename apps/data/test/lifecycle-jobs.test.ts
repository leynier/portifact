// The lifecycle reaching the real documents object (decision 0026, delivery 4, second half): a
// purge (and so an account's or a workspace's deletion) erases the whole data, a hold and its
// release fence the object, a transfer moves it to the new owner, an account deletion erases what
// the account wrote in other people's artifacts, and a held object waits for its release. Every
// change is the real service's batch, every job runs through `runJob`, and every object is the
// real class on SQLite storage.

import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  claimOutcome,
  inventoryKey,
  journalKey,
  LIFECYCLE_LIMITS,
} from "@portifact/domain/artifact-data";
import {
  advanceAccountDeletion,
  dataNamespaces,
  deleteArtifactData,
  lifecycleId,
  placeLegalHold,
  releaseLegalHold,
  runHoldRelease,
  transferArtifact,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { grantPlan, publishSite, user, value } from "../../../packages/services/test/fixtures.ts";
import {
  artifactId,
  artifactRow,
  bucketOf,
  claimJournal,
  controlOf,
  D1_NOW,
  DATA_NOW,
  dataRowOf,
  db,
  documentsOf,
  drain,
  inside,
  jobsOf,
  journalOf,
  visitorId,
  withData,
} from "./lifecycle.ts";

const DAY = 86_400_000;
const CONTEXT = { now: DATA_NOW, limits: LIFECYCLE_LIMITS };

const inventoryOf = async (id: string) => {
  const found = await bucketOf().get(inventoryKey(id));
  return found === null ? null : ((await found.json()) as { retiredAt?: number });
};

const hold = async (id: string) =>
  value(
    await placeLegalHold(db(), {
      artifactId: id,
      ground: "Court order",
      releaseAt: null,
      now: D1_NOW,
    }),
  );

function envelope(id: string, ownerId: string, epoch: number, generation = 0) {
  return {
    artifactId: id,
    region: "default",
    ownerId,
    generation,
    epoch,
    opId: lifecycleId(DATA_NOW),
  };
}

describe("a purge erases the artifact's whole data", () => {
  it("writes the erase job in the purge's batch, commits it and retires the entry", async () => {
    const { id } = await withData({ state: "purging", documents: 3, visitors: [visitorId()] });
    expect(await documentsOf(id)).toBe(4);
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    // The row went with the artifact; the job carries what the envelope needs.
    expect(await dataRowOf(id)).toBeNull();
    const [job] = await jobsOf(db(), ["data_erase"], id);
    expect(job?.payload).toEqual({ ownerId: expect.any(String), generation: 0, epoch: 0 });
    expect(await drain({ subject: id })).toEqual(["data_erase:done"]);
    expect(await documentsOf(id)).toBe(0);
    const control = await controlOf(id);
    expect(control?.generation).toBe(1);
    expect(control?.lastErase).toEqual({ id: expect.any(String), outcome: "committed" });
    expect((await inventoryOf(id))?.retiredAt).toBe(DATA_NOW);
  });

  it("writes no job for an artifact without data", async () => {
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`, { state: "purging" });
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    expect(await jobsOf(db(), ["data_erase"], id)).toEqual([]);
  });

  it("creates no object while artifact data is off", async () => {
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`, { state: "purging" });
    await db().insert(schema.artifactData).values({ artifactId: id, updatedAt: D1_NOW });
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    expect(await drain({ subject: id })).toEqual(["data_erase:done"]);
    expect(await controlOf(id)).toBeNull();
    expect(await inside(id, (object) => object.store.inspect("pf_meta").length)).toBe(0);
  });

  it("binds an empty object when artifact data is on, so a late first write is refused", async () => {
    const id = artifactId();
    const ownerId = `u_${crypto.randomUUID()}`;
    await artifactRow(id, ownerId, { state: "purging" });
    await db().insert(schema.artifactData).values({ artifactId: id, updatedAt: D1_NOW });
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    expect(await drain({ subject: id, createsObjects: true })).toEqual(["data_erase:done"]);
    expect((await controlOf(id))?.generation).toBe(1);
    const late = await inside(id, (object) =>
      object.store.declare(
        envelope(id, ownerId, 0),
        { kind: "owner" },
        { name: "notes", mode: "own" },
        CONTEXT,
      ),
    );
    expect(late.ok || late.code).toBe("stale");
  });

  it("is a required erase: it passes the day's gate that refuses an owner's resets", async () => {
    const { id, ownerId } = await withData({ state: "purging" });
    await inside(id, (object) => {
      const base = { artifactId: id, region: "default", ownerId, generation: 0, epoch: 0 };
      for (let n = 0; n < 20; n += 1) {
        const eraseId = lifecycleId(DATA_NOW);
        expect(object.store.prepareErase(base, eraseId, DATA_NOW).ok).toBe(true);
        expect(object.store.cancelErase(base, eraseId, DATA_NOW).ok).toBe(true);
      }
      const refused = object.store.prepareErase(base, lifecycleId(DATA_NOW), DATA_NOW);
      expect(refused.ok || refused.code).toBe("rate_limited");
    });
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    expect(await drain({ subject: id })).toEqual(["data_erase:done"]);
    expect((await controlOf(id))?.generation).toBe(1);
  });

  it("resumes an erase prepared before a crash under its own ID, past the horizon", async () => {
    const { id, ownerId } = await withData({ state: "purging", documents: 2 });
    const prepared = lifecycleId(DATA_NOW);
    await inside(id, (object) =>
      object.store.prepareErase(
        { ...envelope(id, ownerId, 0), opId: undefined, requiredErase: "purge" },
        prepared,
        DATA_NOW,
      ),
    );
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    // A day and a half later: past the horizon a new intent would need.
    expect(await drain({ subject: id, now: DATA_NOW + 1.5 * DAY })).toEqual(["data_erase:done"]);
    expect((await controlOf(id))?.lastErase).toEqual({ id: prepared, outcome: "committed" });
    expect(await documentsOf(id)).toBe(0);
  });

  it("runs in the EU region with the EU database, bucket and envelopes", async () => {
    const { id } = await withData({ state: "purging", region: "eu" });
    await deleteArtifactData(db("eu"), env.ARTIFACTS_EU, id, D1_NOW);
    expect(await jobsOf(db(), ["data_erase"], id)).toEqual([]);
    expect(await drain({ region: "eu", subject: id })).toEqual(["data_erase:done"]);
    expect((await controlOf(id))?.region).toBe("eu");
    expect((await controlOf(id))?.generation).toBe(1);
    expect(await bucketOf("eu").get(inventoryKey(id))).not.toBeNull();
    expect(await bucketOf("default").get(inventoryKey(id))).toBeNull();
  });
});

describe("holds fence the object", () => {
  it("holds it until the release, and a held object keeps its erase waiting", async () => {
    const { id, ownerId } = await withData({ state: "suspended", visitors: [visitorId()] });
    await hold(id);
    expect((await dataRowOf(id))?.epoch).toBe(1);
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    const held = await controlOf(id);
    expect(held?.hold).not.toBeNull();
    expect(held?.epoch).toBe(1);
    // An owner-side write at D1's numbers is refused by the object itself.
    const write = await inside(id, (object) =>
      object.store.create(envelope(id, ownerId, 1), { kind: "owner" }, "notes", {}, CONTEXT),
    );
    expect(write.ok || write.code).toBe("held");

    // A whole erase reaching a held object (a restore re-applied a purge) waits a day, erasing
    // nothing.
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_erase",
        payload: { ownerId, generation: 0, epoch: 1 },
        availableAt: DATA_NOW,
        subject: id,
      });
    expect(await drain({ subject: id })).toEqual(["data_erase:kept"]);
    expect(await documentsOf(id)).toBe(2);
    const [waiting] = await jobsOf(db(), ["data_erase"], id);
    expect(waiting?.availableAt).toBe(DATA_NOW + DAY);

    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    expect((await dataRowOf(id))?.epoch).toBe(2);
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    expect((await controlOf(id))?.hold).toBeNull();
    // The hold release's job wakes what the hold kept.
    await runHoldRelease(db(), undefined, id, DATA_NOW);
    expect(await drain({ subject: id })).toEqual(["data_erase:done"]);
    expect(await documentsOf(id)).toBe(0);
  });

  it("writes no fence for an artifact without data", async () => {
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`, { state: "suspended" });
    await hold(id);
    expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  });

  it("ends released when the release reaches the object before the hold", async () => {
    const { id } = await withData({ state: "suspended" });
    await hold(id);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    const jobs = await jobsOf(db(), ["data_fence"], id);
    expect(jobs.map((job) => (job.payload as { fence: { kind: string } }).fence.kind)).toEqual([
      "hold",
      "release",
    ]);
    // The queue delivers the release first; then the hold's, which the object is already past.
    await db()
      .update(schema.outbox)
      .set({ availableAt: DATA_NOW + 1 })
      .where(eq(schema.outbox.id, jobs[0]?.id ?? 0));
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    expect(await drain({ subject: id, now: DATA_NOW + 1 })).toEqual(["data_fence:stale"]);
    const control = await controlOf(id);
    expect(control?.hold).toBeNull();
    expect(control?.epoch).toBe(2);
  });

  it("retries a fence while D1 is behind the object, and applies it once D1 caught up", async () => {
    const { id } = await withData({ state: "suspended" });
    await hold(id);
    // D1 read another generation than the object holds (a commit whose D1 update a crash lost
    // is the real case): the object refuses the fence and the job comes back.
    await db()
      .update(schema.artifactData)
      .set({ generation: 5 })
      .where(eq(schema.artifactData.artifactId, id));
    expect(await drain({ subject: id, rounds: 1 })).toEqual(["data_fence:pending"]);
    expect((await controlOf(id))?.hold).toBeNull();
    await db()
      .update(schema.artifactData)
      .set({ generation: 0 })
      .where(eq(schema.artifactData.artifactId, id));
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    expect((await controlOf(id))?.hold).not.toBeNull();
  });
});

describe("a transfer moves the data to the new owner", () => {
  it("fences the object under the old owner; the old owner is stale afterwards", async () => {
    const owner = await user("Owner");
    const id = (await publishSite(owner.id)).artifactId;
    const global = regionsFromEnv(env).global;
    const workspaceId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
    const slug = `d${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await global
      .insert(schema.workspaces)
      .values({ id: workspaceId, slug, name: "Team", createdBy: owner.id, updatedAt: D1_NOW });
    await global
      .insert(schema.workspaceMembers)
      .values({ workspaceId, userId: owner.id, role: "admin", updatedAt: D1_NOW });
    await grantPlan(workspaceId, "team", { seats: 5 });
    await db().insert(schema.artifactData).values({ artifactId: id, updatedAt: D1_NOW });
    await inside(id, (object) =>
      object.store.declare(
        envelope(id, owner.id, 0),
        { kind: "owner" },
        { name: "notes", mode: "own" },
        CONTEXT,
      ),
    );
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: id,
        workspace: slug,
        now: D1_NOW,
      }),
    );
    const [job] = await jobsOf(db(), ["data_fence"], id);
    expect(job?.payload).toMatchObject({
      ownerId: owner.id,
      epoch: 1,
      fence: { kind: "transfer", toOwner: workspaceId },
    });
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    const control = await controlOf(id);
    expect(control?.ownerId).toBe(workspaceId);
    expect(control?.ownerEpoch).toBe(1);
    const asOld = await inside(id, (object) =>
      object.store.create(envelope(id, owner.id, 9), { kind: "owner" }, "notes", {}, CONTEXT),
    );
    expect(asOld.ok || asOld.code).toBe("stale");
    const asNew = await inside(id, (object) =>
      object.store.create(envelope(id, workspaceId, 1), { kind: "owner" }, "notes", {}, CONTEXT),
    );
    expect(asNew.ok).toBe(true);
  });
});

describe("an account deletion erases what the account wrote in others' artifacts", () => {
  async function deleting(userId: string) {
    await regionsFromEnv(env)
      .global.insert(schema.accountDeletions)
      .values({ userId, requestedAt: D1_NOW });
  }

  it("retires the journal, erases the visitor's documents and keeps everyone else's", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    const other = visitorId();
    const { id } = await withData({ visitors: [visitor, other], documents: 2 });
    await claimJournal(userId, id, visitor);
    await deleting(userId);
    await advanceAccountDeletion(regionsFromEnv(env), userId, DATA_NOW);
    expect((await journalOf(userId, id))?.retiredAt).toBe(DATA_NOW);
    expect((await jobsOf(db(), ["data_author_erasure"], id)).map((job) => job.payload)).toEqual([
      { userId, visitorId: visitor },
    ]);
    // A second run finds the entry retired and writes nothing more.
    await advanceAccountDeletion(regionsFromEnv(env), userId, DATA_NOW);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toHaveLength(1);
    expect(await drain({ subject: id })).toEqual(["data_author_erasure:done"]);
    expect(await documentsOf(id, visitor)).toBe(0);
    expect(await documentsOf(id, other)).toBe(1);
    expect(await documentsOf(id)).toBe(3);
    // A retired entry refuses every later claim: no grant revives the person.
    expect(claimOutcome(await journalOf(userId, id), visitorId()).ok).toBe(false);
    expect((await dataRowOf(id))?.reportSeq).toBeGreaterThan(0);
  });

  it("retires an entry that never named a visitor, without a job", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const { id } = await withData();
    await bucketOf().put(
      journalKey(userId, id),
      JSON.stringify({ visitorId: null, firstGrantAt: DATA_NOW }),
    );
    await deleting(userId);
    await advanceAccountDeletion(regionsFromEnv(env), userId, DATA_NOW);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toEqual([]);
    expect((await journalOf(userId, id))?.retiredAt).toBe(DATA_NOW);
  });

  it("waits while the artifact is held and erases after the release", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    const { id } = await withData({ state: "suspended", visitors: [visitor] });
    await hold(id);
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    await claimJournal(userId, id, visitor);
    await deleting(userId);
    await advanceAccountDeletion(regionsFromEnv(env), userId, DATA_NOW);
    expect(await drain({ subject: id })).toEqual(["data_author_erasure:kept"]);
    expect(await documentsOf(id, visitor)).toBe(1);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    expect(await drain({ subject: id })).toEqual(["data_fence:done"]);
    await runHoldRelease(db(), undefined, id, DATA_NOW);
    expect(await drain({ subject: id })).toEqual(["data_author_erasure:done"]);
    expect(await documentsOf(id, visitor)).toBe(0);
  });

  it("has nothing to erase in an artifact without data", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const id = artifactId();
    await artifactRow(id, `u_${crypto.randomUUID()}`);
    await claimJournal(userId, id, visitorId());
    await deleting(userId);
    await advanceAccountDeletion(regionsFromEnv(env), userId, DATA_NOW);
    expect(await drain({ subject: id })).toEqual(["data_author_erasure:done"]);
    expect(await controlOf(id)).toBeNull();
  });
});

describe("the stub", () => {
  it("is made in the EU jurisdiction for the EU region and hinted for the default one", () => {
    const calls: unknown[] = [];
    const namespace = {
      jurisdiction(name: string) {
        calls.push(["jurisdiction", name]);
        return namespace;
      },
      idFromName(name: string) {
        calls.push(["id", name]);
        return name;
      },
      get(id: unknown, options: unknown) {
        calls.push(["get", id, options]);
        return {};
      },
    } as unknown as DurableObjectNamespace;
    dataNamespaces({ ARTIFACT_DOCUMENTS: namespace }, "eu")?.object("abcdefghij");
    dataNamespaces({ ARTIFACT_DOCUMENTS: namespace }, "default")?.object("abcdefghij");
    expect(calls).toEqual([
      ["jurisdiction", "eu"],
      ["id", "abcdefghij"],
      ["get", "abcdefghij", undefined],
      ["id", "abcdefghij"],
      ["get", "abcdefghij", { locationHint: "wnam" }],
    ]);
    expect(dataNamespaces({}, "default")).toBeNull();
    expect(dataNamespaces({ ARTIFACT_DOCUMENTS: namespace }, "eu")?.createsObjects).toBe(false);
    const on = { ARTIFACT_DOCUMENTS: namespace, ARTIFACT_DATA_ENABLED: "true" };
    expect(dataNamespaces(on, "eu")?.createsObjects).toBe(true);
  });
});
