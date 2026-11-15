// A person's own export and deletes from "Data you shared" (decision 0026): as the visitor the
// journal names them, only their own documents, without write permission or an open grant, and
// nothing once the journal entry is retired.
import { env } from "cloudflare:test";
import { PLANS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { NOTICE_EMAILS_PER_CYCLE } from "@portifact/domain";
import { journalKey } from "@portifact/domain/artifact-data";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_CHUNKS_PER_RUN,
  claimVisitorId,
  DATA_RIGHTS_KEEP_MS,
  type DataObjects,
  type DataRightsNotifier,
  declareDataCollection,
  deleteOwnDocument,
  emailsSentInCycle,
  exportOwnData,
  isEmailSuppressed,
  journalVisitorId,
  listDataRightsRequests,
  OWN_ERASURES_PER_DAY,
  pageDataCommand,
  placeLegalHold,
  pruneDataRightsRequests,
  RecipientSuppressedError,
  recordEmailsSent,
  requestDataRights,
  requestOwnErasure,
  resolveDataRightsRequest,
  retireJournalEntry,
  retryDataRightsRequest,
  runJob,
  sendDataRightsNotice,
  suppressEmail,
} from "../src/index.ts";
import { ownerRpc } from "./data-owner-rpc.ts";
import { db, NOW, publishSite, user, value } from "./fixtures.ts";

function harness() {
  const memories = new Map<string, MemoryObject>();
  const objects: DataObjects = {
    region: "default",
    createsObjects: true,
    object: (id) => {
      let found = memories.get(id);
      if (!found) {
        found = new MemoryObject(id);
        memories.set(id, found);
      }
      return { ...ownerRpc(found) } as never;
    },
  };
  return { objects, deps: { objects, bucket: env.ARTIFACTS } };
}

async function setup() {
  const { objects, deps } = harness();
  const owner = await user("Owner");
  const { artifactId } = await publishSite(owner.id);
  value(
    await declareDataCollection(
      db(),
      { objects, bucket: env.ARTIFACTS, enabled: true },
      {
        userId: owner.id,
        artifactId,
        now: NOW,
        idempotencyKey: crypto.randomUUID(),
        declaration: { name: "votes", mode: "own" },
      },
    ),
  );
  const write = async (userId: string, choice: string) => {
    const visitor = value(await claimVisitorId(env.ARTIFACTS, userId, artifactId, NOW));
    const { result } = await pageDataCommand(
      db(),
      { objects, pageWrites: true },
      {
        artifactId,
        region: "default",
        limits: PLANS.free.data.perArtifact,
        caller: { kind: "visitor", author: visitor, canWrite: true },
        command: { kind: "create", collection: "votes", body: { choice } },
        idempotencyKey: null,
        now: NOW,
      },
    );
    return (value(result).value as { _id: string })._id;
  };
  return { deps, artifactId, write, owner };
}

const input = (userId: string, artifactId: string) => ({
  userId,
  artifactId,
  region: "default",
  now: NOW + 1000,
});

describe("a person's own data", () => {
  it("refuses a malformed journal entry and data whose D1 registration is gone", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    const id = await write(visitor.id, "a");
    await db().delete(schema.artifactData).where(eq(schema.artifactData.artifactId, artifactId));
    expect(
      await exportOwnData(db(), deps, { ...input(visitor.id, artifactId), after: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await deleteOwnDocument(db(), deps, {
        ...input(visitor.id, artifactId),
        collection: "votes",
        id,
        idempotencyKey: null,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await deps.bucket.put(
      journalKey(visitor.id, artifactId),
      JSON.stringify({ visitorId: "invalid" }),
    );
    expect(await journalVisitorId(deps.bucket, visitor.id, artifactId)).toBeNull();
  });

  it("exports only the person's own documents and deletes one of them", async () => {
    const { deps, artifactId, write } = await setup();
    const alice = await user("Alice");
    const bob = await user("Bob");
    const mine = await write(alice.id, "a");
    await write(bob.id, "b");

    const page = value(
      await exportOwnData(db(), deps, { ...input(alice.id, artifactId), after: null }),
    ) as { rows: { id: string }[] };
    expect(page.rows.map((row) => row.id)).toEqual([mine]);

    // Bob cannot delete Alice's document from his own rights.
    expect(
      await deleteOwnDocument(db(), deps, {
        ...input(bob.id, artifactId),
        collection: "votes",
        id: mine,
        idempotencyKey: null,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await deleteOwnDocument(db(), deps, {
        ...input(alice.id, artifactId),
        collection: "votes",
        id: mine,
        idempotencyKey: `${NOW}.deletemine`,
      }),
    ).toEqual({ ok: true, value: { deleted: true } });
    const after = value(
      await exportOwnData(db(), deps, { ...input(alice.id, artifactId), after: null }),
    ) as { rows: unknown[] };
    expect(after.rows).toEqual([]);
  });

  it("has nothing for a person the journal does not name, or names retired", async () => {
    const { deps, artifactId, write } = await setup();
    const stranger = await user("Stranger");
    expect(
      await exportOwnData(db(), deps, { ...input(stranger.id, artifactId), after: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const leaving = await user("Leaving");
    await write(leaving.id, "c");
    expect(await journalVisitorId(env.ARTIFACTS, leaving.id, artifactId)).toMatch(/^v_/);
    await retireJournalEntry(env.ARTIFACTS, leaving.id, artifactId, NOW);
    expect(await journalVisitorId(env.ARTIFACTS, leaving.id, artifactId)).toBeNull();
    expect(
      await exportOwnData(db(), deps, { ...input(leaving.id, artifactId), after: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

/** A workspace that owns the artifact, with two admins and a member. */
async function workspaceOwner(artifactId: string) {
  const first = await user("Admin one");
  const second = await user("Admin two");
  const member = await user("Member");
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .global.insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: first.id, updatedAt: NOW });
  for (const [userId, role] of [
    [first.id, "admin"],
    [second.id, "admin"],
    [member.id, "member"],
  ] as const) {
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  await db()
    .update(schema.artifacts)
    .set({ ownerId: id })
    .where(eq(schema.artifacts.id, artifactId));
  return { first, second, member, slug: id.slice(3, 23) };
}

async function rightsRequests(artifactId: string) {
  return db()
    .select()
    .from(schema.dataRightsRequests)
    .where(eq(schema.dataRightsRequests.artifactId, artifactId));
}

async function rightsJobs(artifactId: string) {
  const ids = (await rightsRequests(artifactId)).map((request) => request.id);
  if (ids.length === 0) return [];
  return db()
    .select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.topic, "data_rights_request"), inArray(schema.outbox.subject, ids)),
    );
}

/** Runs the request's one job as the jobs Worker does, deleting its row when it is done. */
async function deliver(artifactId: string, now: number, notifier: DataRightsNotifier) {
  const [job] = await rightsJobs(artifactId);
  if (!job) throw new Error("no job");
  return runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic }, now, {
    dataRightsNotifier: notifier,
  });
}

function recordingNotifier(fail: (to: string) => boolean = () => false) {
  const sent: Parameters<DataRightsNotifier["send"]>[0][] = [];
  const notifier: DataRightsNotifier = {
    async send(notice) {
      if (fail(notice.to)) throw new Error("email delivery failed");
      sent.push(notice);
    },
  };
  return { sent, notifier };
}

async function requested(kind: "access" | "erasure" = "access") {
  const { deps, artifactId, write, owner } = await setup();
  const visitor = await user("Visitor");
  await write(visitor.id, "a");
  expect(
    await requestDataRights(db(), deps.bucket, { ...input(visitor.id, artifactId), kind }),
  ).toEqual({ ok: true, value: { requested: true } });
  return { deps, artifactId, owner, visitor };
}

describe("rights requests", () => {
  it("sends a personal-space request without a workspace and counts only its delivered email", async () => {
    const { artifactId, owner } = await requested();
    const before = await emailsSentInCycle(db().global, NOW);
    const { sent, notifier } = recordingNotifier();
    expect(await deliver(artifactId, NOW + 2000, notifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner.email, workspaceSlug: null, kind: "access" });
    expect(await emailsSentInCycle(db().global, NOW)).toBe(before + 1);
    expect(await rightsJobs(artifactId)).toEqual([]);
    const [request] = await rightsRequests(artifactId);
    expect(request).toMatchObject({ state: "delivered", recipients: 1, settledAt: NOW + 2000 });
    // The send claims go once it settled; the request keeps only the count.
    expect(
      await db()
        .select()
        .from(schema.dataRightsRequestSends)
        .where(eq(schema.dataRightsRequestSends.requestId, request?.id ?? "")),
    ).toEqual([]);
  });

  it("keeps a request every admin is suppressed for, for the operator to retry or resolve", async () => {
    const { artifactId } = await requested();
    const admins = await workspaceOwner(artifactId);
    await suppressEmail(db().global, { email: admins.first.email, reason: "complaint", now: NOW });
    const attempted: string[] = [];
    const before = await emailsSentInCycle(db().global, NOW);
    expect(
      await deliver(artifactId, NOW + 2000, {
        async send(notice) {
          attempted.push(notice.to);
          throw new RecipientSuppressedError();
        },
      }),
    ).toBe("done");
    expect(attempted).toEqual([admins.second.email]);
    expect(await isEmailSuppressed(db().global, admins.second.email, NOW + 2000)).toBe(true);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(before);
    // Nobody got it: the job ended, the request stays, listed for the operator.
    expect(await rightsJobs(artifactId)).toEqual([]);
    const [request] = await rightsRequests(artifactId);
    expect(request).toMatchObject({ state: "undeliverable", reason: "suppressed", recipients: 0 });
    const listed = await listDataRightsRequests(db(), NOW + 3000);
    expect(listed.find((item) => item.id === request?.id)).toMatchObject({
      artifactId,
      kind: "access",
      state: "undeliverable",
      reason: "suppressed",
    });
    if (!request) throw new Error("no request");

    // A retry after the suppressions are lifted delivers it.
    await db().global.delete(schema.emailSuppressions);
    expect(await retryDataRightsRequest(db(), request.id, NOW + 4000)).toBe(true);
    expect(await retryDataRightsRequest(db(), request.id, NOW + 4000)).toBe(false);
    expect(await rightsJobs(artifactId)).toHaveLength(1);
    const { sent, notifier } = recordingNotifier();
    expect(await deliver(artifactId, NOW + 5000, notifier)).toBe("done");
    expect(sent.map((notice) => notice.to).sort()).toEqual(
      [admins.first.email, admins.second.email].sort(),
    );
    expect((await rightsRequests(artifactId))[0]).toMatchObject({
      state: "delivered",
      recipients: 2,
    });
    // Delivered or resolved requests are not the operator's to resolve.
    expect(await resolveDataRightsRequest(db(), request.id, NOW + 6000)).toBe(false);
  });

  it("keeps a request whose owner has no admin to email, until the operator resolves it", async () => {
    const { artifactId } = await requested();
    // An owner nobody manages any more: no admin to email.
    await db()
      .update(schema.artifacts)
      .set({ ownerId: `ws_${"0".repeat(32)}` })
      .where(eq(schema.artifacts.id, artifactId));
    const { sent, notifier } = recordingNotifier();
    expect(await deliver(artifactId, NOW + 2000, notifier)).toBe("done");
    expect(sent).toEqual([]);
    const [request] = await rightsRequests(artifactId);
    expect(request).toMatchObject({ state: "undeliverable", reason: "no_recipient" });
    if (!request) throw new Error("no request");
    expect(await resolveDataRightsRequest(db(), request.id, NOW + 3000)).toBe(true);
    expect((await rightsRequests(artifactId))[0]).toMatchObject({
      state: "resolved",
      settledAt: NOW + 3000,
    });
    expect((await listDataRightsRequests(db(), NOW + 4000)).map((item) => item.id)).not.toContain(
      request.id,
    );
    expect(await retryDataRightsRequest(db(), request.id, NOW + 4000)).toBe(false);
  });

  it("refuses a request once the artifact is purging, even when its journal remains", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(visitor.id, artifactId),
        kind: "access",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await rightsRequests(artifactId)).toEqual([]);
  });

  it("waits while the notice capacity is spent, then delivers in a later cycle", async () => {
    const { artifactId, owner } = await requested();
    const laterCycle = Date.UTC(2040, 0, 1);
    await recordEmailsSent(db().global, laterCycle, NOTICE_EMAILS_PER_CYCLE);
    const { sent, notifier } = recordingNotifier();
    expect(await deliver(artifactId, laterCycle, notifier)).toBe("pending");
    expect(sent).toEqual([]);
    expect(await emailsSentInCycle(db().global, laterCycle)).toBe(NOTICE_EMAILS_PER_CYCLE);
    // The job and the request stay, and the request is the operator's to see a day later.
    expect(await rightsJobs(artifactId)).toHaveLength(1);
    const [request] = await rightsRequests(artifactId);
    expect(request).toMatchObject({ state: "pending" });
    expect(
      (await listDataRightsRequests(db(), laterCycle)).find((item) => item.id === request?.id),
    ).toMatchObject({ state: "pending" });
    // Still spent on a redelivery the same cycle.
    expect(await deliver(artifactId, laterCycle + 60_000, notifier)).toBe("pending");
    const nextCycle = Date.UTC(2040, 1, 1);
    expect(await deliver(artifactId, nextCycle, notifier)).toBe("done");
    expect(sent.map((notice) => notice.to)).toEqual([owner.email]);
    expect(await rightsJobs(artifactId)).toEqual([]);
    expect((await rightsRequests(artifactId))[0]).toMatchObject({ state: "delivered" });
  });

  it("emails each admin of the artifact's owner, naming the person only by their visitor ID", async () => {
    const { artifactId, visitor } = await requested("erasure");
    const admins = await workspaceOwner(artifactId);
    const [job] = await rightsJobs(artifactId);
    if (!job) throw new Error("no job");
    expect(JSON.stringify(job.payload)).not.toContain(visitor.email);
    const { sent, notifier } = recordingNotifier();
    expect(await sendDataRightsNotice(db(), job, NOW + 2000, notifier)).toBe("done");
    expect(sent.map((notice) => notice.to).sort()).toEqual(
      [admins.first.email, admins.second.email].sort(),
    );
    const visitorId = await journalVisitorId(env.ARTIFACTS, visitor.id, artifactId);
    expect(sent[0]).toMatchObject({
      kind: "erasure",
      artifactId,
      visitorId,
      workspaceSlug: admins.slug,
    });
    expect(JSON.stringify(sent)).not.toContain(visitor.email);
    // Delivered: a second delivery of the same job sends nothing.
    expect(await sendDataRightsNotice(db(), job, NOW + 3000, notifier)).toBe("stale");
    expect(sent).toHaveLength(2);
  });

  it("emails only the admins not told yet when a send fails partway", async () => {
    const { artifactId } = await requested();
    const admins = await workspaceOwner(artifactId);
    const [firstAdmin, secondAdmin] = [admins.first.email, admins.second.email].sort();
    const failing = recordingNotifier(() => true);
    await expect(deliver(artifactId, NOW + 2000, failing.notifier)).rejects.toThrow();
    expect(await rightsJobs(artifactId)).toHaveLength(1);
    // The first admin gets it, the second's send fails: the job runs again.
    const partial = recordingNotifier((to) => to !== firstAdmin);
    await expect(deliver(artifactId, NOW + 3000, partial.notifier)).rejects.toThrow();
    expect(partial.sent.map((notice) => notice.to)).toEqual([firstAdmin]);
    expect((await rightsRequests(artifactId))[0]).toMatchObject({ state: "pending" });
    const rest = recordingNotifier();
    expect(await deliver(artifactId, NOW + 4000, rest.notifier)).toBe("done");
    expect(rest.sent.map((notice) => notice.to)).toEqual([secondAdmin]);
    expect((await rightsRequests(artifactId))[0]).toMatchObject({
      state: "delivered",
      recipients: 2,
    });
    expect(await rightsJobs(artifactId)).toEqual([]);
  });

  it("refuses a person the journal does not name, and limits requests a day", async () => {
    const { deps, artifactId, write } = await setup();
    const stranger = await user("Stranger");
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(stranger.id, artifactId),
        kind: "access",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await requestDataRights(db(), deps.bucket, {
            ...input(visitor.id, artifactId),
            kind: "access",
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(visitor.id, artifactId),
        kind: "access",
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await rightsRequests(artifactId)).toHaveLength(3);
  });

  it("ends a job whose request is gone or was resolved, without email", async () => {
    const { artifactId } = await requested();
    const { sent, notifier } = recordingNotifier();
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_rights_request",
        payload: {},
        availableAt: NOW,
        createdAt: NOW,
        subject: "dr_missing",
      })
      .returning();
    if (!row) throw new Error("no row");
    expect(await sendDataRightsNotice(db(), row, NOW, notifier)).toBe("stale");
    const [request] = await rightsRequests(artifactId);
    if (!request) throw new Error("no request");
    expect(await resolveDataRightsRequest(db(), request.id, NOW + 1000)).toBe(true);
    expect(await deliver(artifactId, NOW + 2000, notifier)).toBe("stale");
    expect(sent).toEqual([]);
    // A request goes with its artifact.
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    expect(await rightsRequests(artifactId)).toEqual([]);
  });

  it("prunes delivered and resolved requests 30 days after they settled, never the rest", async () => {
    const { artifactId } = await requested();
    const { notifier } = recordingNotifier();
    await deliver(artifactId, NOW + 2000, notifier);
    const [delivered] = await rightsRequests(artifactId);
    const other = await requested();
    const keptId = (await rightsRequests(other.artifactId))[0]?.id;
    await db()
      .update(schema.dataRightsRequests)
      .set({ state: "undeliverable", settledAt: NOW })
      .where(eq(schema.dataRightsRequests.artifactId, other.artifactId));
    expect(await pruneDataRightsRequests(db(), NOW + 2000 + DATA_RIGHTS_KEEP_MS - 1)).toEqual({
      processed: 0,
    });
    await pruneDataRightsRequests(db(), NOW + 2000 + DATA_RIGHTS_KEEP_MS);
    const left = await db()
      .select({ id: schema.dataRightsRequests.id })
      .from(schema.dataRightsRequests);
    expect(left.map((row) => row.id)).not.toContain(delivered?.id);
    expect(left.map((row) => row.id)).toContain(keptId);
  });
});

describe("a person's own export and deletes over the plan's limits", () => {
  const DAY = 86_400_000;

  /** 501 small documents of one visitor on the Free plan, created over as many days as needed. */
  async function many(count: number) {
    const { deps, artifactId, owner } = await setup();
    const visitor = await user("Prolific");
    const author = value(await claimVisitorId(env.ARTIFACTS, visitor.id, artifactId, NOW));
    let at = (Math.floor(NOW / DAY) + 1) * DAY;
    for (let n = 0; n < count; ) {
      const { result } = await pageDataCommand(
        db(),
        { objects: deps.objects, pageWrites: true },
        {
          artifactId,
          region: "default",
          limits: PLANS.free.data.perArtifact,
          caller: { kind: "visitor", author, canWrite: true },
          command: { kind: "create", collection: "votes", body: { n } },
          idempotencyKey: null,
          now: at,
        },
      );
      if (result.ok) n += 1;
      // The per-author write rate and the day's growth: wait a little, or for the next day.
      at =
        result.ok || result.code === "rate_limited" ? at + 2_100 : (Math.floor(at / DAY) + 1) * DAY;
    }
    return { deps, artifactId, owner, visitor, day: (Math.floor(at / DAY) + 1) * DAY };
  }

  it("downloads 501 documents on Free across an allowance reset, resuming from the cursor", async () => {
    const { deps, artifactId, visitor, day } = await many(501);
    expect(PLANS.free.data.perArtifact.rightsRowsPerDay).toBe(500);
    const page = async (now: number, after: { collection: string; id: string } | null) =>
      exportOwnData(db(), deps, { userId: visitor.id, artifactId, region: "default", now, after });
    const first = value(await page(day, null)) as {
      rows: { id: string }[];
      next: { collection: string; id: string } | null;
    };
    expect(first.rows).toHaveLength(500);
    expect(first.next).not.toBeNull();
    // The first page spent the day's allowance: the next one waits for tomorrow.
    expect(await page(day + 1000, first.next)).toMatchObject({ ok: false, code: "rate_limited" });
    const rest = value(await page(day + DAY, first.next)) as {
      rows: { id: string }[];
      next: unknown;
    };
    expect(rest.rows).toHaveLength(1);
    expect(rest.next).toBeNull();
    expect(new Set([...first.rows, ...rest.rows].map((row) => row.id)).size).toBe(501);
  });

  /** Runs the erasure's jobs as the jobs Worker does, until none is left; answers how many runs. */
  async function runErasure(deps: { objects: DataObjects }, artifactId: string, now: number) {
    let runs = 0;
    for (; runs < 1000; runs++) {
      const [job] = await db()
        .select()
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.topic, "data_own_erasure"), eq(schema.outbox.subject, artifactId)),
        );
      if (!job) return runs;
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic }, now + runs * 60_000, {
        data: deps.objects,
      });
    }
    throw new Error("the erasure did not end");
  }

  const erasureRow = async (artifactId: string) =>
    (
      await db()
        .select()
        .from(schema.dataOwnErasures)
        .where(eq(schema.dataOwnErasures.artifactId, artifactId))
    )[0];

  it("erases 501 documents on Free in one job, after the person's allowance is spent", async () => {
    const { deps, artifactId, visitor, day } = await many(501);
    const base = { userId: visitor.id, artifactId, region: "default" };
    // The day's rights allowance is spent by an export page: deleting one by one now waits.
    value(await exportOwnData(db(), deps, { ...base, now: day, after: null }));
    expect(await exportOwnData(db(), deps, { ...base, now: day + 1, after: null })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    const started = value(await requestOwnErasure(db(), deps.bucket, { ...base, now: day + 2 }));
    expect(started).toMatchObject({ state: "running", documents: 0, finishedAt: null });
    // Asking again while it runs answers the same erasure and queues nothing more.
    value(await requestOwnErasure(db(), deps.bucket, { ...base, now: day + 3 }));
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "data_own_erasure"));
    expect(jobs.filter((job) => job.subject === artifactId)).toHaveLength(1);
    expect(await runErasure(deps, artifactId, day + 4)).toBe(1);
    expect(await erasureRow(artifactId)).toMatchObject({ state: "done", documents: 501 });
    const left = value(
      await exportOwnData(db(), deps, { ...base, now: day + DAY, after: null }),
    ) as { rows: unknown[] };
    expect(left.rows).toEqual([]);
    // Not terminal: the person may save there again and erase again.
    expect((await requestOwnErasure(db(), deps.bucket, { ...base, now: day + DAY })).ok).toBe(true);
  }, 120_000);

  it("runs in bounded runs of chunks, so the largest dataset any plan allows ends within hours", async () => {
    // Each run sends at most AUTHOR_CHUNKS_PER_RUN chunks of 500 and the relay sends the next run
    // within a minute: the runs a plan's largest dataset needs, at one a minute.
    for (const plan of Object.values(PLANS)) {
      const most = plan.data.perArtifact.documentsPerCollection * plan.data.perArtifact.collections;
      const runs = Math.ceil(most / (AUTHOR_CHUNKS_PER_RUN * 500));
      expect(runs, `${most} documents`).toBeLessThanOrEqual(120);
    }
    // And the job keeps to it: 4,100 documents over three collections take two runs.
    const { deps, artifactId, owner } = await setup();
    for (const name of ["a", "b"]) {
      value(
        await declareDataCollection(
          db(),
          { objects: deps.objects, bucket: env.ARTIFACTS, enabled: true },
          {
            userId: owner.id,
            artifactId,
            now: NOW,
            idempotencyKey: crypto.randomUUID(),
            declaration: { name, mode: "own" },
          },
        ),
      );
    }
    const person = await user("Bulk");
    const author = value(await claimVisitorId(env.ARTIFACTS, person.id, artifactId, NOW));
    const roomy = {
      ...PLANS.team.data.perArtifact,
      writesPerAuthorPerMinute: 1_000_000,
      readsPerCallerPerMinute: 1_000_000,
      rowsWrittenPerDay: 1_000_000_000,
      documentsPerCollection: 1_000_000,
      bytesPerArtifact: 1_000_000_000,
    };
    for (let n = 0; n < 4_100; n++) {
      const { result } = await pageDataCommand(
        db(),
        { objects: deps.objects, pageWrites: true },
        {
          artifactId,
          region: "default",
          limits: roomy,
          caller: { kind: "visitor", author, canWrite: true },
          command: {
            kind: "create",
            collection: ["votes", "a", "b"][n % 3] as string,
            body: { n },
          },
          idempotencyKey: null,
          now: NOW + 1000,
        },
      );
      value(result);
    }
    value(
      await requestOwnErasure(db(), deps.bucket, {
        userId: person.id,
        artifactId,
        region: "default",
        now: NOW + 2000,
      }),
    );
    expect(await runErasure(deps, artifactId, NOW + 3000)).toBe(2);
    expect(await erasureRow(artifactId)).toMatchObject({ state: "done", documents: 4_100 });
  }, 120_000);

  it("waits while the artifact is held, and refuses someone the journal does not name", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    const stranger = await user("Stranger");
    expect(
      await requestOwnErasure(db(), deps.bucket, input(stranger.id, artifactId)),
    ).toMatchObject({ ok: false, code: "not_found" });
    value(await requestOwnErasure(db(), deps.bucket, input(visitor.id, artifactId)));
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, artifactId));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Order", releaseAt: null, now: NOW + 3000 }),
    );
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "data_own_erasure"), eq(schema.outbox.subject, artifactId)),
      );
    if (!job) throw new Error("no job");
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic }, NOW + 5000, {
        data: deps.objects,
      }),
    ).toBe("kept");
    expect(await erasureRow(artifactId)).toMatchObject({ state: "running", documents: 0 });
  });

  it("marks an erasure the object refuses for good as failed, ends a superseded job, and starts again", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    value(await requestOwnErasure(db(), deps.bucket, input(visitor.id, artifactId)));
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "data_own_erasure"), eq(schema.outbox.subject, artifactId)),
      );
    if (!job) throw new Error("no job");
    // A job another request superseded touches nothing.
    const stale = { ...job, payload: { ...(job.payload as object), writeId: "f".repeat(32) } };
    await db()
      .update(schema.outbox)
      .set({ payload: stale.payload })
      .where(eq(schema.outbox.id, job.id));
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic }, NOW + 2000, {
        data: deps.objects,
      }),
    ).toBe("stale");
    // The object refuses with a code no retry fixes: the erasure ends as failed.
    await db()
      .insert(schema.outbox)
      .values({ ...job, id: undefined, dispatchedAt: null });
    const [again] = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "data_own_erasure"), eq(schema.outbox.subject, artifactId)),
      );
    if (!again) throw new Error("no job");
    const refusing: DataObjects = {
      ...deps.objects,
      object: (id) =>
        ({
          ...deps.objects.object(id),
          lifecycleEraseOwn: async () => ({
            ok: false,
            code: "forbidden",
            message: "another artifact",
            storage: { bytes: 0, generation: 0, seq: 0 },
          }),
        }) as never,
    };
    await runJob(db(), env.ARTIFACTS, { id: again.id, topic: again.topic }, NOW + 3000, {
      data: refusing,
    });
    expect(await erasureRow(artifactId)).toMatchObject({ state: "failed" });
    const restarted = value(
      await requestOwnErasure(db(), deps.bucket, {
        ...input(visitor.id, artifactId),
        now: NOW + 4000,
      }),
    );
    expect(restarted).toMatchObject({ state: "running", documents: 0 });
    await runErasure(deps, artifactId, NOW + 5000);
    expect(await erasureRow(artifactId)).toMatchObject({ state: "done", documents: 1 });
  });

  it("limits how often a person starts one in a day", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    for (let n = 0; n < OWN_ERASURES_PER_DAY; n++) {
      value(await requestOwnErasure(db(), deps.bucket, input(visitor.id, artifactId)));
      await runErasure(deps, artifactId, NOW + 2000);
    }
    expect(await requestOwnErasure(db(), deps.bucket, input(visitor.id, artifactId))).toMatchObject(
      { ok: false, code: "rate_limited" },
    );
  });
});
