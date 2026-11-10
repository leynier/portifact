// The owner's access log: deduplicated recording from delivery batches, the owner-only listing,
// retention pruning and the erasure jobs that purges and account deletions write.
import { env } from "cloudflare:test";
import { accessSchema, createAccessDb, schema } from "@portifact/db";
import { ACCESS_RETENTION_MS, ACCESS_WINDOW_MS } from "@portifact/domain";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  ACCESS_DELETE_BATCH,
  eraseAccessEvents,
  getAccessLog,
  pruneAccessEvents,
  recordOpenings,
} from "../src/access-log.ts";
import { advanceAccountDeletion, requestAccountDeletion } from "../src/account-data.ts";
import { archiveArtifact, deleteArtifact } from "../src/lifecycle.ts";
import { runJob } from "../src/outbox.ts";
import { DAY, db, MINUTE, NOW, publishSite, session, user } from "./fixtures.ts";

const access = () => createAccessDb(env.ACCESS_DB);
const WINDOW = Math.floor(NOW / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS;

const eventsOf = (artifactId: string) =>
  access()
    .select()
    .from(accessSchema.accessEvents)
    .where(eq(accessSchema.accessEvents.artifactId, artifactId))
    .orderBy(asc(accessSchema.accessEvents.windowStart), asc(accessSchema.accessEvents.userId));

const eventsBy = (userId: string) =>
  access()
    .select()
    .from(accessSchema.accessEvents)
    .where(eq(accessSchema.accessEvents.userId, userId));

/** An owner with a published artifact and a reader. */
async function setup() {
  const owner = await user("Owner");
  const reader = await user("Reader");
  const { artifactId } = await publishSite(owner.id);
  return { owner, reader, artifactId };
}

const list = (ownerId: string, artifactId: string, extra: object = {}) =>
  getAccessLog(db(), access(), { userId: ownerId, artifactId, limit: 50, now: NOW, ...extra });

/** Inserts `count` openings of one artifact by distinct visitors at `at`, in one statement. */
async function bulkOpenings(artifactId: string, ownerId: string, count: number, at: number) {
  await env.ACCESS_DB.prepare(
    `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
     insert into access_events (artifact_id, window_start, user_id, owner_id, email, opened_at)
     select ?, ?, 'u_' || i, ?, 'r@example.test', ? from n`,
  )
    .bind(count, artifactId, Math.floor(at / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS, ownerId, at)
    .run();
}

describe("recording openings", () => {
  it("stores the visitor's email and the owner, one row per window with the earliest time", async () => {
    const { owner, reader, artifactId } = await setup();
    const written = await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: WINDOW + 5 * MINUTE },
      { artifactId, userId: reader.id, at: WINDOW + MINUTE },
      { artifactId, userId: reader.id, at: WINDOW + ACCESS_WINDOW_MS },
    ]);
    expect(written).toBe(2);
    expect(await eventsOf(artifactId)).toEqual([
      {
        artifactId,
        windowStart: WINDOW,
        userId: reader.id,
        ownerId: owner.id,
        email: reader.email,
        openedAt: WINDOW + MINUTE,
        linkId: null,
        // Free plan: kept 30 days from the opening.
        expiresAt: WINDOW + MINUTE + ACCESS_RETENTION_MS,
      },
      {
        artifactId,
        windowStart: WINDOW + ACCESS_WINDOW_MS,
        userId: reader.id,
        ownerId: owner.id,
        email: reader.email,
        openedAt: WINDOW + ACCESS_WINDOW_MS,
        linkId: null,
        expiresAt: WINDOW + ACCESS_WINDOW_MS + ACCESS_RETENTION_MS,
      },
    ]);
  });

  it("keeps one row and the earliest opening when batches from several isolates overlap", async () => {
    const { reader, artifactId } = await setup();
    const opening = (minute: number) => ({
      artifactId,
      userId: reader.id,
      at: WINDOW + minute * MINUTE,
    });
    await Promise.all([
      recordOpenings(db(), access(), [opening(9)]),
      recordOpenings(db(), access(), [opening(3)]),
      recordOpenings(db(), access(), [opening(7)]),
    ]);
    await recordOpenings(db(), access(), [opening(12)]);
    const rows = await eventsOf(artifactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openedAt).toBe(WINDOW + 3 * MINUTE);
  });

  it("writes nothing for the owner, unknown accounts, unknown or inactive artifacts", async () => {
    const { owner, reader, artifactId } = await setup();
    const archived = await publishSite(owner.id);
    await archiveArtifact(db(), { userId: owner.id, artifactId: archived.artifactId, now: NOW });
    expect(await recordOpenings(db(), access(), [])).toBe(0);
    expect(
      await recordOpenings(db(), access(), [
        { artifactId, userId: owner.id, at: NOW },
        { artifactId, userId: "u_missing", at: NOW },
        { artifactId: "zzzzzzzzzz", userId: reader.id, at: NOW },
        { artifactId: archived.artifactId, userId: reader.id, at: NOW },
      ]),
    ).toBe(0);
    expect(await eventsOf(artifactId)).toEqual([]);
    expect(await eventsOf(archived.artifactId)).toEqual([]);
  });
});

describe("the owner's access log", () => {
  it("lists openings newest window first, with the visitor's email and time", async () => {
    const { owner, reader, artifactId } = await setup();
    const other = await user("Other reader");
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: WINDOW - ACCESS_WINDOW_MS + MINUTE },
      { artifactId, userId: reader.id, at: WINDOW + 2 * MINUTE },
      { artifactId, userId: other.id, at: WINDOW + MINUTE },
    ]);
    const sameWindow = [reader, other]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((visitor) => ({
        email: visitor.email,
        openedAt: visitor === reader ? WINDOW + 2 * MINUTE : WINDOW + MINUTE,
      }));
    expect(await list(owner.id, artifactId)).toEqual({
      ok: true,
      value: {
        artifactId,
        entries: [
          ...sameWindow,
          { email: reader.email, openedAt: WINDOW - ACCESS_WINDOW_MS + MINUTE },
        ],
        nextCursor: null,
        windowMinutes: 30,
        retentionDays: 30,
      },
    });
  });

  it("answers not_found to a reader, another owner, and for missing or purging artifacts", async () => {
    const { owner, reader, artifactId } = await setup();
    const stranger = await user("Stranger");
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW }]);
    for (const ownerId of [reader.id, stranger.id]) {
      expect(await list(ownerId, artifactId)).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
    }
    expect(await list(owner.id, "zzzzzzzzzz")).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await list(owner.id, artifactId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("keeps the log of an archived artifact for its owner", async () => {
    const { owner, reader, artifactId } = await setup();
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW }]);
    await archiveArtifact(db(), { userId: owner.id, artifactId, now: NOW + MINUTE });
    expect(await list(owner.id, artifactId)).toMatchObject({
      ok: true,
      value: { entries: [{ email: reader.email, openedAt: NOW }] },
    });
  });

  it("filters by since and never shows entries past retention", async () => {
    const { owner, reader, artifactId } = await setup();
    const old = NOW - ACCESS_RETENTION_MS - MINUTE;
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW - ACCESS_RETENTION_MS },
      { artifactId, userId: reader.id, at: NOW - 2 * DAY },
      { artifactId, userId: reader.id, at: NOW },
    ]);
    // A row the prune has not reached yet.
    await access()
      .insert(accessSchema.accessEvents)
      .values({
        artifactId,
        windowStart: Math.floor(old / ACCESS_WINDOW_MS) * ACCESS_WINDOW_MS,
        userId: reader.id,
        ownerId: owner.id,
        email: reader.email,
        openedAt: old,
      });
    const all = await list(owner.id, artifactId);
    expect(all.ok && all.value.entries.map((entry) => entry.openedAt)).toEqual([
      NOW,
      NOW - 2 * DAY,
      NOW - ACCESS_RETENTION_MS,
    ]);
    const recent = await list(owner.id, artifactId, { since: NOW - 2 * DAY });
    expect(recent.ok && recent.value.entries.map((entry) => entry.openedAt)).toEqual([
      NOW,
      NOW - 2 * DAY,
    ]);
  });

  it("pages with a cursor until the end, and refuses a malformed cursor", async () => {
    const { owner, reader, artifactId } = await setup();
    await recordOpenings(
      db(),
      access(),
      Array.from({ length: 5 }, (_, i) => ({
        artifactId,
        userId: reader.id,
        at: WINDOW - i * ACCESS_WINDOW_MS,
      })),
    );
    const seen: number[] = [];
    const cursors: (string | null)[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await list(owner.id, artifactId, { limit: 2, cursor });
      if (!result.ok) throw new Error(result.message);
      seen.push(...result.value.entries.map((entry) => entry.openedAt));
      cursors.push(result.value.nextCursor);
      cursor = result.value.nextCursor ?? undefined;
    }
    expect(cursors.map((value) => value !== null)).toEqual([true, true, false]);
    expect(seen).toEqual(Array.from({ length: 5 }, (_, i) => WINDOW - i * ACCESS_WINDOW_MS));
    for (const bad of ["not-a-cursor!", btoa("1.bad id"), btoa("x.u_a")]) {
      expect(await list(owner.id, artifactId, { cursor: bad })).toEqual({
        ok: false,
        code: "invalid_input",
        message: "Invalid cursor.",
      });
    }
  });
});

describe("retention", () => {
  it("prunes openings older than 30 days and keeps the rest", async () => {
    const { owner, reader, artifactId } = await setup();
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW - ACCESS_RETENTION_MS },
      { artifactId, userId: reader.id, at: NOW },
    ]);
    await access()
      .insert(accessSchema.accessEvents)
      .values({
        artifactId,
        windowStart: WINDOW - 40 * DAY,
        userId: reader.id,
        ownerId: owner.id,
        email: reader.email,
        openedAt: NOW - ACCESS_RETENTION_MS - 1,
      });
    expect(await pruneAccessEvents(access(), NOW)).toBeGreaterThanOrEqual(1);
    expect((await eventsOf(artifactId)).map((row) => row.openedAt)).toEqual([
      NOW - ACCESS_RETENTION_MS,
      NOW,
    ]);
  });

  it("deletes in bounded statements and resumes on the next run", async () => {
    const owner = await user();
    await bulkOpenings("prunetests", owner.id, ACCESS_DELETE_BATCH + 1, NOW - 40 * DAY);
    expect(await pruneAccessEvents(access(), NOW, 1)).toBe(ACCESS_DELETE_BATCH);
    expect(await eventsOf("prunetests")).not.toEqual([]);
    await pruneAccessEvents(access(), NOW);
    expect(await eventsOf("prunetests")).toEqual([]);
  });
});

describe("erasing", () => {
  it("erases an artifact's log or an account's openings and nothing else", async () => {
    const { reader, artifactId } = await setup();
    const second = await setup();
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW },
      { artifactId, userId: second.reader.id, at: NOW },
      { artifactId: second.artifactId, userId: reader.id, at: NOW },
      { artifactId: second.artifactId, userId: second.reader.id, at: NOW },
    ]);
    expect(await eraseAccessEvents(access(), "artifact", artifactId)).toBe("done");
    expect(await eventsOf(artifactId)).toEqual([]);
    expect(await eraseAccessEvents(access(), "user", reader.id)).toBe("done");
    expect(await eventsBy(reader.id)).toEqual([]);
    expect((await eventsOf(second.artifactId)).map((row) => row.userId)).toEqual([
      second.reader.id,
    ]);
    // Again: nothing left, still done.
    expect(await eraseAccessEvents(access(), "artifact", artifactId)).toBe("done");
  });

  it("reports pending when its rounds did not reach the end", async () => {
    await bulkOpenings("erasetests", "u_o", ACCESS_DELETE_BATCH + 1, NOW);
    expect(await eraseAccessEvents(access(), "artifact", "erasetests", 1)).toBe("pending");
    expect(await eventsOf("erasetests")).toHaveLength(1);
    expect(await eraseAccessEvents(access(), "artifact", "erasetests", 1)).toBe("done");
    expect(await eventsOf("erasetests")).toEqual([]);
  });
});

const eraseJobs = (subject: string) =>
  db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "erase_access_events"), eq(schema.outbox.subject, subject)));

async function runEraseJobs(subject: string) {
  for (const job of await eraseJobs(subject)) {
    await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "erase_access_events" }, NOW, {
      access: access(),
    });
  }
}

describe("erasure jobs", () => {
  it("deleting an artifact writes one job that erases its log through the queue", async () => {
    const { owner, reader, artifactId } = await setup();
    await recordOpenings(db(), access(), [{ artifactId, userId: reader.id, at: NOW }]);
    const input = { userId: owner.id, artifactId, now: NOW + MINUTE };
    await deleteArtifact(db(), env.ARTIFACTS, input);
    // A retry finds the artifact gone and writes no second job.
    await deleteArtifact(db(), env.ARTIFACTS, input);
    const jobs = await eraseJobs(artifactId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ kind: "artifact" });
    const message = { id: jobs[0]?.id ?? 0, topic: "erase_access_events" as const };
    // Without the access database the job fails and stays for a delivery that has it.
    await expect(runJob(db(), env.ARTIFACTS, message, NOW + MINUTE)).rejects.toThrow(
      "access log database",
    );
    expect(await eraseJobs(artifactId)).toHaveLength(1);
    expect(await runJob(db(), env.ARTIFACTS, message, NOW + MINUTE, { access: access() })).toBe(
      "done",
    );
    expect(await eventsOf(artifactId)).toEqual([]);
    expect(await eraseJobs(artifactId)).toEqual([]);
    // A duplicate delivery finds the row gone.
    expect(await runJob(db(), env.ARTIFACTS, message, NOW + MINUTE, { access: access() })).toBe(
      "done",
    );
  });

  it("leaves a pending job for the next delivery when the log is long", async () => {
    const { owner, artifactId } = await setup();
    await bulkOpenings(artifactId, owner.id, 10 * ACCESS_DELETE_BATCH + 1, NOW);
    await deleteArtifact(db(), env.ARTIFACTS, { userId: owner.id, artifactId, now: NOW });
    const [job] = await eraseJobs(artifactId);
    const message = { id: job?.id ?? 0, topic: "erase_access_events" as const };
    expect(await runJob(db(), env.ARTIFACTS, message, NOW, { access: access() })).toBe("pending");
    expect(await eraseJobs(artifactId)).toHaveLength(1);
    expect(await runJob(db(), env.ARTIFACTS, message, NOW, { access: access() })).toBe("done");
    expect(await eventsOf(artifactId)).toEqual([]);
  });

  it("deleting an account erases its openings elsewhere and its artifacts' logs", async () => {
    const { owner, reader, artifactId } = await setup();
    const theirs = await publishSite(reader.id);
    await recordOpenings(db(), access(), [
      { artifactId, userId: reader.id, at: NOW },
      { artifactId: theirs.artifactId, userId: owner.id, at: NOW },
    ]);
    const sessionId = await session(reader.id);
    await requestAccountDeletion(db(), {
      userId: reader.id,
      sessionId,
      confirmEmail: reader.email,
      now: NOW,
    });
    const [userJob] = await eraseJobs(reader.id);
    expect(userJob?.payload).toEqual({ kind: "user" });
    // Finishing the deletion purges the reader's artifact (its own job) and erases once more.
    let state = await advanceAccountDeletion(db(), env.ARTIFACTS, reader.id, NOW);
    for (let i = 0; i < 5 && state !== "finished"; i += 1) {
      const purges = await db()
        .select()
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.topic, "purge_artifact"),
            eq(schema.outbox.subject, theirs.artifactId),
          ),
        );
      for (const job of purges) {
        await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "purge_artifact" }, NOW, {
          access: access(),
        });
      }
      state = await advanceAccountDeletion(db(), env.ARTIFACTS, reader.id, NOW);
    }
    expect(state).toBe("finished");
    expect(await advanceAccountDeletion(db(), env.ARTIFACTS, reader.id, NOW)).toBe("absent");
    expect(await eraseJobs(reader.id)).toHaveLength(2);
    expect(await eraseJobs(theirs.artifactId)).toHaveLength(1);
    await runEraseJobs(reader.id);
    await runEraseJobs(theirs.artifactId);
    expect(await eventsBy(reader.id)).toEqual([]);
    expect(await eventsOf(theirs.artifactId)).toEqual([]);
    expect(await list(owner.id, artifactId)).toMatchObject({ ok: true, value: { entries: [] } });
  });
});
