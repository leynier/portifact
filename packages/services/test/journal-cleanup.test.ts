// The scheduled cleanup of the author journal (decision 0026, "Author erasure"): an entry leaves
// the region's bucket only once it is retired, past `journalRetiredMs`, and either names no
// visitor or records that its author erasure completed (`erasedAt`), and only while nothing
// protects it. The protections (an open hold, a waiting reconciliation) are decided in D1 by the
// claim and the finalize, so a protection that commits while the delete is under way still keeps
// the mapping (the reproductions of PR #302's review, findings 1, 2 and 4).
import { env } from "cloudflare:test";
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { aliasBinding, type RegionalDb, regionsFromEnv, schema, withBindings } from "@portifact/db";
import { JOURNAL_PREFIX, journalKey } from "@portifact/domain/artifact-data";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DataObjects,
  JOURNAL_CLAIM_STALE_MS,
  JOURNAL_CLEANUP_CURSOR,
  JOURNAL_CLEANUP_PAGE,
  markJournalErased,
  pruneJournalEntries,
  queueDataReconcile,
  retireJournalEntry,
  runDataAuthorErasure,
  runDataReconcile,
} from "../src/artifact-data.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
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
type RegionName = "default" | "eu";
const regionDb = (name: RegionName) => (name === "eu" ? eu() : db());
const bucketOf = (name: RegionName) => (name === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS);

/** Removes every journal key, claim and the cleanup's position, so each test starts afresh. */
async function reset(database: RegionalDb, bucket: R2Bucket) {
  for (;;) {
    const listed = await bucket.list({ prefix: JOURNAL_PREFIX, limit: 1000 });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    if (!listed.truncated) break;
  }
  const c = schema.maintenanceCursors;
  await database.delete(c).where(eq(c.name, JOURNAL_CLEANUP_CURSOR));
  await database.delete(schema.outbox);
  await database.delete(schema.legalHolds);
  await database.delete(schema.journalDeletions);
}

/**
 * A journal entry with a visitor ID, retired at `retiredAt` (live when null); `erased` records
 * its author erasure as completed, which is what lets the cleanup delete it.
 */
async function entry(
  bucket: R2Bucket,
  retiredAt: number | null,
  options: { erased?: boolean; user?: string; id?: string } = {},
) {
  const user = options.user ?? userId();
  const id = options.id ?? artifactId();
  const visitor = visitorId();
  await bucket.put(journalKey(user, id), JSON.stringify({ visitorId: visitor, firstGrantAt: 0 }));
  if (retiredAt !== null) await retireJournalEntry(bucket, user, id, retiredAt);
  if (retiredAt !== null && options.erased !== false) {
    await markJournalErased(bucket, user, id, retiredAt + 1);
  }
  return { user, id, visitor, key: journalKey(user, id) };
}

/** A suspended artifact row, which a legal hold needs. */
async function suspended(database: RegionalDb, id: string) {
  await database
    .insert(schema.artifacts)
    .values({ id, ownerId: userId(), type: "site", name: "Plan", state: "suspended" })
    .onConflictDoNothing();
}

async function hold(database: RegionalDb, id: string) {
  await suspended(database, id);
  const placed = await placeLegalHold(database, {
    artifactId: id,
    ground: "Preserve the authors",
    releaseAt: null,
    now: NOW,
  });
  if (!placed.ok) throw new Error(placed.code);
}

const exists = async (bucket: R2Bucket, key: string) => (await bucket.get(key)) !== null;

/** The stored entry at `key`, or null. */
async function stored(bucket: R2Bucket, key: string) {
  const found = await bucket.get(key);
  return found === null
    ? null
    : {
        ...((await found.json()) as { visitorId: string | null; erasedAt?: number }),
        retired: found.customMetadata?.retired,
      };
}
const claims = (database: RegionalDb) => database.select().from(schema.journalDeletions);

async function cursor(database: RegionalDb) {
  const c = schema.maintenanceCursors;
  const [row] = await database.select().from(c).where(eq(c.name, JOURNAL_CLEANUP_CURSOR));
  return row?.cursor ?? "";
}

/** A bucket whose first delete runs `before` and `after` around itself, or fails. */
function around(
  bucket: R2Bucket,
  hooks: { before?: () => Promise<unknown>; after?: () => Promise<unknown>; fail?: boolean },
): R2Bucket {
  let ran = false;
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          if (ran) return target.delete(keys);
          ran = true;
          await hooks.before?.();
          if (hooks.fail) throw new Error("R2 delete failed");
          const result = await target.delete(keys);
          await hooks.after?.();
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await reset(db(), env.ARTIFACTS);
  await reset(eu(), env.ARTIFACTS_EU);
});
afterEach(() => vi.restoreAllMocks());

describe("the journal cleanup", () => {
  it("deletes erased entries past their retention, and keeps younger, live and owed ones", async () => {
    const old = await entry(env.ARTIFACTS, NOW - RETENTION);
    const young = await entry(env.ARTIFACTS, NOW - RETENTION + 1);
    const live = await entry(env.ARTIFACTS, null);
    // Retired long ago, but its erasure never completed: the only trace of the erasure it owes.
    const owed = await entry(env.ARTIFACTS, NOW - 400 * DAY, { erased: false });
    // Retired without ever having an ID: nothing to erase.
    const blank = { user: userId(), id: artifactId() };
    await retireJournalEntry(env.ARTIFACTS, blank.user, blank.id, NOW - RETENTION);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toEqual({
      deleted: 2,
      kept: 0,
      failed: 0,
      paused: false,
    });
    expect(await exists(env.ARTIFACTS, old.key)).toBe(false);
    expect(await exists(env.ARTIFACTS, journalKey(blank.user, blank.id))).toBe(false);
    expect(await exists(env.ARTIFACTS, young.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, live.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, owed.key)).toBe(true);
    expect(await claims(db())).toEqual([]);
    // The pass fit in one page: the next starts from the beginning without a write.
    expect(await cursor(db())).toBe("");
  });

  it("keeps the entry of a held artifact, and lets it go once the hold is released", async () => {
    const held = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await hold(db(), held.id);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({
      deleted: 0,
      kept: 1,
    });
    expect(await exists(env.ARTIFACTS, held.key)).toBe(true);
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: NOW })
      .where(eq(schema.legalHolds.artifactId, held.id));
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({ deleted: 1 });
    expect(await exists(env.ARTIFACTS, held.key)).toBe(false);
  });

  it("does nothing new while a reconciliation waits in the region", async () => {
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

  for (const name of ["default", "eu"] as const) {
    for (const protection of ["hold", "reconciliation"] as const) {
      for (const when of ["before", "after"] as const) {
        it(`${name}: keeps the mapping when a ${protection} commits ${when} the R2 delete`, async () => {
          const database = regionDb(name);
          const bucket = bucketOf(name);
          const target = await entry(bucket, NOW - 40 * DAY);
          await suspended(database, target.id);
          const protect = async () => {
            if (protection === "hold") await hold(database, target.id);
            else await queueDataReconcile(database, NOW);
          };
          const run = await pruneJournalEntries(
            database,
            around(bucket, when === "before" ? { before: protect } : { after: protect }),
            NOW,
            name,
          );
          expect(run).toMatchObject({ deleted: 0, kept: 1, failed: 0 });
          expect(await stored(bucket, target.key), "the protected mapping survives").toMatchObject({
            visitorId: target.visitor,
            retired: "1",
          });
          expect(await claims(database)).toEqual([]);
        });
      }
    }
    it(`${name}: keeps a mapping whose erasure has not completed, whatever races it`, async () => {
      const database = regionDb(name);
      const bucket = bucketOf(name);
      const target = await entry(bucket, NOW - 40 * DAY, { erased: false });
      await database.insert(schema.outbox).values({
        topic: "data_author_erasure",
        subject: target.id,
        payload: { userId: target.user, visitorId: target.visitor },
        availableAt: NOW,
      });
      expect(await pruneJournalEntries(database, bucket, NOW, name)).toMatchObject({
        deleted: 0,
      });
      expect(await exists(bucket, target.key)).toBe(true);
    });
  }

  it("finishes a claim a stopped run left, writing the entry back if a hold won it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gone = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    const won = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    // The run claims both and stops at the R2 delete.
    const stopped = await pruneJournalEntries(db(), around(env.ARTIFACTS, { fail: true }), NOW);
    expect(stopped).toMatchObject({ deleted: 0, failed: 1 });
    expect(String(error.mock.calls[0]?.[0])).toContain("data_journal_cleanup_failed");
    expect((await claims(db())).map((row) => row.key).sort()).toEqual([gone.key, won.key].sort());
    expect(await exists(env.ARTIFACTS, gone.key)).toBe(true);
    await hold(db(), won.id);
    // A fresh claim is another run's: it is left alone, and the key cannot be claimed twice.
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW + 1)).toMatchObject({
      deleted: 0,
      kept: 2,
    });
    expect(await exists(env.ARTIFACTS, gone.key)).toBe(true);
    // Once stale, the next run finishes both from the R2 delete; the entry written back is then
    // listed again and still protected, so it is not claimed (kept twice).
    const later = NOW + JOURNAL_CLAIM_STALE_MS;
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, later)).toMatchObject({
      deleted: 1,
      kept: 2,
      failed: 0,
    });
    expect(await exists(env.ARTIFACTS, gone.key)).toBe(false);
    expect(await exists(env.ARTIFACTS, won.key)).toBe(true);
    expect(await claims(db())).toEqual([]);
  });

  it("reads a page per run, resumes from its position and wraps at the end", async () => {
    for (let i = 0; i < JOURNAL_CLEANUP_PAGE + 20; i += 1) {
      await entry(env.ARTIFACTS, NOW - 40 * DAY);
    }
    const first = await pruneJournalEntries(db(), env.ARTIFACTS, NOW);
    expect(first.deleted).toBe(JOURNAL_CLEANUP_PAGE);
    expect(await cursor(db())).not.toBe("");
    const second = await pruneJournalEntries(db(), env.ARTIFACTS, NOW);
    expect(second.deleted).toBe(20);
    expect(await cursor(db())).toBe("");
  });

  it("skips and logs an unreadable entry and still moves on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = journalKey(userId(), artifactId());
    await env.ARTIFACTS.put(broken, JSON.stringify({ visitorId: 7 }), {
      customMetadata: { retired: "1" },
    });
    const old = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({
      deleted: 1,
      failed: 1,
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain("data_journal_unreadable");
    expect(await exists(env.ARTIFACTS, broken)).toBe(true);
    expect(await exists(env.ARTIFACTS, old.key)).toBe(false);
  });

  it("never throws out of maintenance when R2 cannot be listed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "list") return () => Promise.reject(new Error("R2 down"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await pruneJournalEntries(db(), broken, NOW)).toMatchObject({ failed: 1 });
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

  it("reads a bounded number of rows however many jobs and holds the region has", async () => {
    const target = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    // 501 author erasure jobs of other accounts on the same artifact, and 501 other open holds.
    await env.DB.prepare(
      `with recursive n(x) as (values(1) union all select x + 1 from n where x < 501)
       insert into outbox (topic, subject, payload, available_at, created_at)
       select 'data_author_erasure', ?1, json_object('userId', 'u_other_' || x, 'visitorId', 'v_other_' || x), ?2, ?2 from n`,
    )
      .bind(target.id, NOW)
      .run();
    await env.DB.prepare(
      `with recursive n(x) as (values(1) union all select x + 1 from n where x < 501)
       insert into artifacts (id, owner_id, type, name, state) select printf('h%09d', x), 'u_o', 'site', 'Held', 'suspended' from n`,
    ).run();
    await env.DB.prepare(
      `insert into legal_holds (id, artifact_id, owner_id, reason, ground)
       select 'hold_' || id, id, 'u_o', 'other', 'Order' from artifacts where id like 'h%' and name = 'Held'`,
    ).run();
    const reads: { sql: string; rows: number }[] = [];
    const queries = new WeakMap<D1PreparedStatement, string>();
    const record = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      queries.set(statement, sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => record(bind(...args), sql);
      return statement;
    };
    const binding = aliasBinding(
      new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => record(target.prepare(sql), sql);
          if (key === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              statements.forEach((statement, i) => {
                reads.push({
                  sql: queries.get(statement) ?? "",
                  rows: result[i]?.meta.rows_read ?? 0,
                });
              });
              return result;
            };
          }
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
      env.DB,
    );
    const measured = regionsFromEnv(withBindings(env, { DB: binding })).get("default").db;
    expect(await pruneJournalEntries(measured, env.ARTIFACTS, NOW)).toMatchObject({ deleted: 1 });
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.rows, read.sql).toBeLessThanOrEqual(5);
  });
});

describe("reconciliation's journal phase", () => {
  async function reconcileJournal(database: RegionalDb, bucket: R2Bucket) {
    const [row] = await database
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
    return runDataReconcile(database, bucket, objects, row, NOW);
  }
  const erasures = (id: string) =>
    db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "data_author_erasure"), eq(schema.outbox.subject, id)));

  it("re-derives a lost erasure from an entry retired long ago, and deletes nothing", async () => {
    // Retired on day 0; a restore to before it rewound the job; reconciliation reaches it on day 32.
    const owed = await entry(env.ARTIFACTS, NOW - 32 * DAY, { erased: false });
    const done = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    expect(await reconcileJournal(db(), env.ARTIFACTS)).toBe("done");
    expect(await erasures(owed.id)).toMatchObject([
      { payload: { userId: owed.user, visitorId: owed.visitor } },
    ]);
    expect(await erasures(done.id)).toEqual([]);
    expect(await exists(env.ARTIFACTS, owed.key)).toBe(true);
    expect(await exists(env.ARTIFACTS, done.key)).toBe(true);
  });

  it("keeps the mapping when a hold commits while it runs", async () => {
    const target = await entry(env.ARTIFACTS, NOW - 40 * DAY);
    await suspended(db(), target.id);
    const raced = around(env.ARTIFACTS, { before: () => hold(db(), target.id) });
    expect(await reconcileJournal(db(), raced)).toBe("done");
    expect(await exists(env.ARTIFACTS, target.key)).toBe(true);
  });
});

describe("an author erasure's completion", () => {
  it("is recorded in the journal, so only then can the entry go", async () => {
    const target = await entry(env.ARTIFACTS, NOW - 40 * DAY, { erased: false });
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_author_erasure",
        subject: target.id,
        payload: { userId: target.user, visitorId: target.visitor },
        availableAt: NOW,
      })
      .returning();
    if (!row) throw new Error("no row");
    // No object holds anything of the artifact: the erasure completes at once.
    const objects = {
      region: "default",
      createsObjects: false,
      object: () => ({ lifecycleControl: async () => null }),
    } as unknown as DataObjects;
    expect(await runDataAuthorErasure(db(), env.ARTIFACTS, objects, row, NOW)).toBe("done");
    expect((await stored(env.ARTIFACTS, target.key))?.erasedAt).toBe(NOW);
    // Marking twice keeps the first time.
    await markJournalErased(env.ARTIFACTS, target.user, target.id, NOW + 5);
    expect((await stored(env.ARTIFACTS, target.key))?.erasedAt).toBe(NOW);
    expect(await pruneJournalEntries(db(), env.ARTIFACTS, NOW)).toMatchObject({ deleted: 1 });
  });
});
