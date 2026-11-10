// Account and workspace deletion in both shapes (decision 0005, "Two-region audit"). With one
// database (production today) a deletion stops serving at once, in the one batch that deletes
// the account or workspace, and finishes only while nothing is left, by SQL in its last batch.
// With a separate regional database the global batch goes first and the regional half follows,
// retried inline; a failure reaches the caller and the job finishes it.
import { env } from "cloudflare:test";
import {
  aliasBinding,
  globalDb,
  type RegionalDb,
  regionalDb,
  regionsFromEnv,
  sameDatabase,
  schema,
} from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  advanceAccountDeletion,
  processAccountDeletions,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import {
  advanceWorkspaceDeletion,
  createWorkspace,
  type DeletionRegions,
  deleteWorkspace,
  processWorkspaceDeletions,
} from "../src/workspaces.ts";
import { NOW, session, sha256, user } from "./fixtures.ts";

/** A binding whose batches fail from the `after`-th one on (0: every batch). */
function failingBatches(d1: D1Database, after: number): D1Database {
  let batches = 0;
  return aliasBinding(
    new Proxy(d1, {
      get(target, property) {
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batches += 1;
            if (batches > after) return Promise.reject(new Error("D1 batch failed"));
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    d1,
  );
}

/** A binding that runs `before` once, right before the first batch that writes `marker`. */
function beforeBatchWriting(d1: D1Database, marker: string, before: () => Promise<unknown>) {
  const sqlOf = new WeakMap<object, string>();
  let fired = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const real = Reflect.get(target, property, target);
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        return typeof real === "function" ? real.bind(target) : real;
      },
    });
    sqlOf.set(wrapped, sql);
    return wrapped;
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  return aliasBinding(
    new Proxy(d1, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            const wrapped = wrap(statement, sql);
            real.set(wrapped, statement);
            return wrapped;
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!fired && statements.some((s) => (sqlOf.get(s) ?? "").includes(marker))) {
              fired = true;
              await before();
            }
            return target.batch(statements.map((s) => real.get(s) ?? s));
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    d1,
  );
}

/** Production's shape: one region, its database the global one, through `binding`. */
function oneDatabase(binding: D1Database = env.DB) {
  return regionsFromEnv({ DB: binding, ACCESS_DB: env.ACCESS_DB, ARTIFACTS: env.ARTIFACTS });
}

/** A default region with a database of its own (`SECOND_DB`), through `binding`. */
function separateDefault(binding: D1Database = env.SECOND_DB): DeletionRegions {
  const global = globalDb(env.DB);
  const db = regionalDb(binding, global);
  return { global, all: () => [{ db, bucket: env.ARTIFACTS, region: "default" as const }] };
}

async function publishIn(db: RegionalDb, userId: string, ownerId = userId) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = await preparePublish(db, {
    userId,
    targetOwnerId: ownerId,
    type: "site",
    name: "Plan",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [
      {
        path: "index.html",
        kind: "published",
        sha256: digest,
        size: body.length,
        contentType: "text/html",
      },
    ],
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.value.artifactId;
}

async function stateIn(db: RegionalDb, artifactId: string) {
  const [row] = await db
    .select({ state: schema.artifacts.state })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  return row?.state;
}

async function committed(db: RegionalDb, userId: string, ownerId = userId) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = await preparePublish(db, {
    userId,
    targetOwnerId: ownerId,
    type: "site",
    name: "Plan",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [
      {
        path: "index.html",
        kind: "published",
        sha256: digest,
        size: body.length,
        contentType: "text/html",
      },
    ],
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS.put(`objects/${ownerId}/${digest}`, body);
  const done = await commitPublish(db, env.ARTIFACTS, {
    userId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!done.ok) throw new Error(done.message);
  return done.value.artifactId;
}

async function tombstone(id: string) {
  const [row] = await globalDb(env.DB)
    .select()
    .from(schema.tombstones)
    .where(eq(schema.tombstones.id, id));
  return row;
}

describe("the shape of a region", () => {
  it("is one database when the handles share a binding, whatever wraps it, and two otherwise", () => {
    expect(sameDatabase(regionsFromEnv(env).get("default").db)).toBe(true);
    expect(sameDatabase(regionsFromEnv(env).get("eu").db)).toBe(false);
    expect(sameDatabase(oneDatabase(failingBatches(env.DB, 0)).get("default").db)).toBe(true);
    expect(sameDatabase(separateDefault().all()[0]?.db as RegionalDb)).toBe(false);
  });
});

describe("account deletion with one database", () => {
  it("serves nothing once the request returns, in one batch, even when a second batch would fail", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    const artifactId = await committed(oneDatabase().get("default").db, owner.id);
    // Every batch after the first fails: the deletion must not need a second one.
    const regions = oneDatabase(failingBatches(env.DB, 1));
    const deleted = await requestAccountDeletion(regions, {
      userId: owner.id,
      sessionId,
      confirmEmail: owner.email,
      now: NOW,
    });
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    expect(await stateIn(oneDatabase().get("default").db, artifactId)).toBe("purging");
  });

  it("does not finish while a request authorized just before inserts an artifact", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    expect(
      (
        await requestAccountDeletion(oneDatabase(), {
          userId: owner.id,
          sessionId,
          confirmEmail: owner.email,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const late = "latedrafta";
    const racing = oneDatabase(
      beforeBatchWriting(env.DB, '"tombstones"', () =>
        env.DB.prepare(
          "insert into artifacts (id, owner_id, type, name, state) values (?, ?, 'site', 'Late', 'draft')",
        )
          .bind(late, owner.id)
          .run(),
      ),
    );
    expect(await advanceAccountDeletion(racing, owner.id, NOW + 1)).toBe("pending");
    expect(await tombstone(owner.id)).toBeUndefined();
    // The next run claims what arrived, and the deletion goes on.
    await advanceAccountDeletion(oneDatabase(), owner.id, NOW + 2);
    expect(await stateIn(oneDatabase().get("default").db, late)).toBe("purging");
  });

  it("refuses a new artifact for an account whose deletion is pending", async () => {
    const owner = await user();
    await globalDb(env.DB)
      .insert(schema.accountDeletions)
      .values({ userId: owner.id, requestedAt: NOW });
    await expect(publishIn(oneDatabase().get("default").db, owner.id)).rejects.toThrow(
      "Not found.",
    );
  });
});

describe("account deletion with a separate regional database", () => {
  it("lets no failure pass: the global batch holds the job, and the job claims what the request could not", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    const db = separateDefault().all()[0]?.db as RegionalDb;
    const artifactId = await publishIn(db, owner.id);
    await expect(
      requestAccountDeletion(separateDefault(failingBatches(env.SECOND_DB, 0)), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    ).rejects.toThrow("D1 batch failed");
    // The crash point: the account is gone, its artifact not yet claimed (the bounded window).
    const [gone] = await globalDb(env.DB)
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, owner.id));
    expect(gone).toBeUndefined();
    expect(await stateIn(db, artifactId)).toBe("draft");
    const [job] = await globalDb(env.DB)
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, owner.id));
    expect(job?.topic).toBe("account_deletion");
    await processAccountDeletions(separateDefault(), NOW + 1);
    expect(await stateIn(db, artifactId)).toBe("purging");
  });

  it("counts the separate region again right before the last batch", async () => {
    const owner = await user();
    const sessionId = await session(owner.id);
    const regions = separateDefault();
    expect(
      (
        await requestAccountDeletion(regions, {
          userId: owner.id,
          sessionId,
          confirmEmail: owner.email,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const late = "latesecond";
    // Between the regional pass and the last batch: the global audit erase runs there.
    const global = globalDb(
      beforeBatchWriting(env.DB, '"audit_events"', () =>
        env.SECOND_DB.prepare(
          "insert into artifacts (id, owner_id, type, name, state) values (?, ?, 'site', 'Late', 'draft')",
        )
          .bind(late, owner.id)
          .run(),
      ),
    );
    const db = regionalDb(env.SECOND_DB, global);
    const racing: DeletionRegions = {
      global,
      all: () => [{ db, bucket: env.ARTIFACTS, region: "default" as const }],
    };
    expect(await advanceAccountDeletion(racing, owner.id, NOW + 1)).toBe("pending");
    expect(await tombstone(owner.id)).toBeUndefined();
  });
});

describe("workspace deletion", () => {
  async function workspace(region: "default" | "eu") {
    const admin = await user("Admin");
    const created = await createWorkspace(globalDb(env.DB), {
      slug: `del-${crypto.randomUUID().slice(0, 8)}`,
      name: "Deleted",
      adminUserId: admin.id,
      now: NOW,
      region,
    });
    if (!created.ok) throw new Error(created.message);
    return { admin, id: created.value.id };
  }

  it("with one database serves nothing once it returns, in one batch", async () => {
    const { admin, id } = await workspace("default");
    const artifactId = await committed(oneDatabase().get("default").db, admin.id, id);
    const deleted = await deleteWorkspace(oneDatabase(failingBatches(env.DB, 1)), {
      workspaceId: id,
      now: NOW,
    });
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    expect(await stateIn(oneDatabase().get("default").db, artifactId)).toBe("purging");
  });

  it("with one database does not finish while an artifact arrives before the last batch", async () => {
    const { id } = await workspace("default");
    expect((await deleteWorkspace(oneDatabase(), { workspaceId: id, now: NOW })).ok).toBe(true);
    const late = "latewkspce";
    const racing = oneDatabase(
      beforeBatchWriting(env.DB, '"tombstones"', () =>
        env.DB.prepare(
          "insert into artifacts (id, owner_id, type, name, state) values (?, ?, 'site', 'Late', 'draft')",
        )
          .bind(late, id)
          .run(),
      ),
    );
    expect(await advanceWorkspaceDeletion(racing, id, NOW + 1)).toBe("pending");
    expect(await tombstone(id)).toBeUndefined();
  });

  it("in the EU lets no failure pass, and a retry or the job claims in every region", async () => {
    const { admin, id } = await workspace("eu");
    const eu = regionsFromEnv(env).get("eu").db;
    const artifactId = await publishIn(eu, admin.id, id);
    const failing = regionsFromEnv({ ...env, DB_EU: failingBatches(env.DB_EU, 0) });
    await expect(deleteWorkspace(failing, { workspaceId: id, now: NOW })).rejects.toThrow(
      "D1 batch failed",
    );
    expect(await stateIn(eu, artifactId)).toBe("draft");
    // A retry finds the workspace row gone and claims again everywhere.
    expect(await deleteWorkspace(regionsFromEnv(env), { workspaceId: id, now: NOW + 1 })).toEqual({
      ok: true,
      value: { deleted: false },
    });
    expect(await stateIn(eu, artifactId)).toBe("purging");
    await processWorkspaceDeletions(regionsFromEnv(env), NOW + 2);
    expect(await stateIn(eu, artifactId)).toBe("purging");
  });
});
