// Review of #275, finding 4: the restore's attempt lookup reads rows by the markers, never all
// running attempts times all drafts.
import { env } from "cloudflare:test";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { expect, it } from "vitest";
import { applyTombstones } from "../src/backups.ts";
import { db, NOW, user } from "./fixtures.ts";
import { publishDoc } from "./suggestion-support.ts";

it("PF275 actual restore bounds attempt lookup work", async () => {
  const owner = await user();
  const doc = await publishDoc(owner.id);
  const tag = crypto.randomUUID();
  for (let i = 0; i < 100; i++) {
    const id = `acc_${tag}-${i}`;
    await db()
      .insert(schema.editDrafts)
      .values({
        artifactId: doc.artifactId,
        userId: `${tag}-${i}`,
        ownerId: owner.id,
        baseVersionId: doc.versionId,
        edit: "{}",
        editBytes: 2,
        updatedAt: NOW,
        incarnation: `${tag}-${i}`,
        attemptId: id,
      });
    await db()
      .insert(schema.acceptanceAttempts)
      .values({
        id,
        artifactId: doc.artifactId,
        ownerId: owner.id,
        origin: "draft",
        threadId: null,
        userId: `${tag}-${i}`,
        digest: "a".repeat(64),
        baseVersionId: doc.versionId,
        createdAt: NOW,
        updatedAt: NOW,
      });
  }
  const queries = new WeakMap<D1PreparedStatement, string>();
  const measured: { sql: string; rows: number }[] = [];
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
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            statements.forEach((statement, i) => {
              const sql = queries.get(statement) ?? "";
              if (sql.startsWith('update "acceptance_attempts"'))
                measured.push({ sql, rows: result[i]?.meta.rows_read ?? 0 });
            });
            return result;
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
    env.DB,
  );
  const r = regionsFromEnv({ ...env, DB: binding });
  await applyTombstones({ global: r.global, all: () => [r.get("default")] }, [], NOW + 100);
  expect(measured).toHaveLength(1);
  expect(measured[0]?.rows, measured[0]?.sql).toBeLessThanOrEqual(300);
});
