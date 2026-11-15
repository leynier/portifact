// The scheduled cleanup of the author journal (decision 0026, "Author erasure"): entries retired
// more than `journalRetiredMs` ago leave the region's bucket a page per run, except while their
// author erasure still waits, their artifact is held, or a restore's reconciliation is pending.
import { env } from "cloudflare:test";
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { type RegionalDb, regionsFromEnv, schema } from "@portifact/db";
import { JOURNAL_PREFIX, journalKey } from "@portifact/domain/artifact-data";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DataObjects,
  JOURNAL_CLEANUP_CURSOR,
  JOURNAL_CLEANUP_PAGE,
  pruneJournalEntries,
  queueDataReconcile,
  retireJournalEntry,
  runDataReconcile,
} from "../src/artifact-data.ts";
import { runRegionalMaintenance } from "../src/maintenance.ts";
import { db, NOW } from "./fixtures.ts";

const RETENTION = ARTIFACT_DATA.journalRetiredMs;
const DAY = 86_400_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}
const userId = () => `u_${crypto.randomUUID()}`;
const visitorId = () => `v_${crypto.randomUUID().replaceAll("-", "")}`;
const eu = () => regionsFromEnv(env).get("eu").db;

/** Removes every journal key and the cleanup's position, so each test starts a fresh pass. */
async function reset(database: RegionalDb, bucket: R2Bucket) {
  for (;;) {
    const listed = await bucket.list({ prefix: JOURNAL_PREFIX, limit: 1000 });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    if (!listed.truncated) break;
  }
  const c = schema.maintenanceCursors;
  await database.delete(c).where(eq(c.name, JOURNAL_CLEANUP_CURSOR));
  await database.delete(schema.outbox).where(eq(schema.outbox.topic, "data_reconcile"));
}

/** A journal entry with a visitor ID, retired at `retiredAt` (live when it is null). */
async function entry(
  bucket: R2Bucket,
  retiredAt: number | null,
  user = userId(),
  id = artifactId(),
) {
  await bucket.put(
    journalKey(user, id),
    JSON.stringify({ visitorId: visitorId(), firstGrantAt: 0 }),
  );
  if (retiredAt !== null) await retireJournalEntry(bucket, user, id, retiredAt);
  return { user, id, key: journalKey(user, id) };
}

/** An open legal hold on `id`, which needs a suspended artifact row (`released` closes it). */
async function hold(database: RegionalDb, id: string, released?: number) {
  const ownerId = userId();
  await database
    .insert(schema.artifacts)
    .values({ id, ownerId, type: "site", name: "Plan", state: "suspended" });
  await database.insert(schema.legalHolds).values({
    id: `hold_${id}`,
    artifactId: id,
    ownerId,
    reason: "other",
    ground: "Order",
    ...(released === undefined ? {} : { releasedAt: released }),
  });
}

const exists = async (bucket: R2Bucket, key: string) => (await bucket.get(key)) !== null;

async function cursor(database: RegionalDb) {
  const c = schema.maintenanceCursors;
  const [row] = await database.select().from(c).where(eq(c.name, JOURNAL_CLEANUP_CURSOR));
  return row?.cursor ?? "";
}

beforeEach(async () => {
  await reset(db(), env.ARTIFACTS);
  await reset(eu(), env.ARTIFACTS_EU);
});
afterEach(() => vi.restoreAllMocks());

describe("the journal cleanup", () => {
  it("deletes retired entries past their retention and keeps younger and live ones", async () => {
    const old = await entry(env.ARTIFACTS, NOW - RETENTION);
    const young = await entry(env.ARTIFACTS, NOW - RETENTION + 1);
    const live = await entry(env.ARTIFACTS, null);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toEqual({
      deleted: 1,
      kept: 0,
      failed: 0,
      paused: false,
    });
    expect(await exists(env.ARTIFACTS, old.key)).toBe(false);
    expect(await exists(env.ARTIFACTS, young.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, live.key)).toBe(true);
    // The pass fit in one page: the next starts from the beginning without a write.
    expect(await cursor(db())).toBe("");
  });

  it("keeps an entry whose author erasure still waits, and one of a held artifact", async () => {
    const waiting = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_author_erasure",
        payload: { userId: waiting.user, visitorId: visitorId() },
        availableAt: NOW + DAY,
        subject: waiting.id,
      });
    // Another account's erasure on the same artifact keeps nothing of this one.
    const other = await entry(env.ARTIFACTS, NOW - 40 * DAY, userId(), waiting.id);
    const held = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await hold(db(), held.id);
    const released = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await hold(db(), released.id, NOW - DAY);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({
      deleted: 2,
      kept: 2,
    });
    expect(await exists(env.ARTIFACTS, waiting.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, held.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, other.key)).toBe(false);
    expect(await exists(env.ARTIFACTS, released.key)).toBe(false);
  });

  it("does nothing while a reconciliation waits in the region", async () => {
    const old = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await queueDataReconcile(db(), NOW);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
      paused: true,
    });
    expect(await exists(env.ARTIFACTS, old.key)).toBe(true);
  });

  it("reads a page per run, resumes from its position and wraps at the end", async () => {
    const total = JOURNAL_CLEANUP_PAGE + 20;
    const keys = await Promise.all(
      Array.from({ length: total }, () => entry(env.ARTIFACTS, NOW - 40 * DAY)),
    );
    const first = await pruneJournalEntries(db(), env.ARTIFACTS, NOW);
    expect(first.deleted).toBe(JOURNAL_CLEANUP_PAGE);
    const sorted = keys.map((k) => k.key).sort();
    expect(await cursor(db())).toBe(sorted[JOURNAL_CLEANUP_PAGE - 1]);
    const second = await pruneJournalEntries(db(), env.ARTIFACTS, NOW);
    expect(second.deleted).toBe(20);
    expect(await cursor(db())).toBe("");
    const left = await env.ARTIFACTS.list({ prefix: JOURNAL_PREFIX });
    expect(left.objects).toHaveLength(0);
  });

  it("skips and logs an unreadable entry, and a failed delete, and still moves on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = journalKey(userId(), artifactId());
    await env.ARTIFACTS.put(broken, "not json", { customMetadata: { retired: "1" } });
    const invalid = journalKey(userId(), artifactId());
    await env.ARTIFACTS.put(invalid, JSON.stringify({ visitorId: 5 }), {
      customMetadata: { retired: "1" },
    });
    const old = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({
      deleted: 1,
      failed: 2,
    });
    expect(await exists(env.ARTIFACTS, broken)).toBe(true);
    expect(await exists(env.ARTIFACTS, old.key)).toBe(false);
    const lines = warn.mock.calls.map((call) => JSON.parse(String(call[0])) as { event: string });
    expect(lines.filter((line) => line.event === "data_journal_unreadable")).toHaveLength(2);

    // A delete R2 refuses is counted and logged; the run returns.
    const stuck = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    const refusing = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "delete") return async () => Promise.reject(new Error("r2 down (10001)"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await pruneJournalEntries(db(), refusing, NOW)).toMatchObject({ deleted: 0, failed: 3 });
    expect(await exists(env.ARTIFACTS, stuck.key)).toBe(true);
    expect(warn.mock.calls.at(-1)?.[0]).toContain("data_journal_cleanup_failed");
  });

  it("never throws out of maintenance when R2 cannot be listed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "list") return async () => Promise.reject(new Error("r2 down"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await pruneJournalEntries(db(), down, NOW)).toEqual({
      deleted: 0,
      kept: 0,
      failed: 1,
      paused: false,
    });
    expect(String(error.mock.calls[0]?.[0])).toContain("data_journal_cleanup_failed");
  });

  it("runs in a region with its own database and bucket", async () => {
    const old = await entry(env.ARTIFACTS_EU, NOW - 40 * DAY);
    const held = await entry(env.ARTIFACTS_EU, NOW - 40 * DAY);
    await hold(eu(), held.id);
    const home = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    const summary = await runRegionalMaintenance(eu(), env.ARTIFACTS_EU, NOW, "eu");
    expect(summary.journalEntries).toEqual({ deleted: 1, kept: 1, failed: 0, paused: false });
    expect(await exists(env.ARTIFACTS_EU, old.key)).toBe(false);
    expect(await exists(env.ARTIFACTS_EU, held.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, home.key)).toBe(true);
  });
});

describe("reconciliation's journal phase", () => {
  it("keeps entries past retention whose erasure waits or whose artifact is held", async () => {
    const waiting = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await db()
      .insert(schema.outbox)
      .values({
        topic: "data_author_erasure",
        payload: { userId: waiting.user, visitorId: visitorId() },
        availableAt: NOW,
        subject: waiting.id,
      });
    const held = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await hold(db(), held.id);
    const old = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_reconcile",
        payload: { phase: "journal", cursor: null },
        availableAt: NOW,
        subject: `reconcile:${NOW}`,
      })
      .returning();
    if (!row) throw new Error("no row");
    // The journal phase reaches no object.
    const objects = { region: "default", createsObjects: false } as DataObjects;
    expect(await runDataReconcile(db(), env.ARTIFACTS, objects, row, NOW)).toBe("done");
    expect(await exists(env.ARTIFACTS, waiting.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, held.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, old.key)).toBe(false);
  });
});
