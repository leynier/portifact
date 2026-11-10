// The table map and the region guard (decision 0005, "Two-region audit"): every table has a home,
// the guard refuses the other side's tables and batches that span two handles, and the strict
// mode lets through only test files and the listed known crossings.
import { env } from "cloudflare:test";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as authSchema from "../src/auth-schema.ts";
import {
  describeViolation,
  globalDb,
  guardD1,
  guardFor,
  KNOWN_CROSS_DATABASE,
  misplacedTables,
  RegionGuardError,
  type RegionGuardViolation,
  regionalDb,
  schema,
  statementCaller,
  TABLE_HOMES,
  tablesIn,
} from "../src/index.ts";

function tablesOf(module: Record<string, unknown>): string[] {
  return Object.values(module)
    .filter((value): value is SQLiteTable => {
      try {
        return Boolean(getTableConfig(value as SQLiteTable).name);
      } catch {
        return false;
      }
    })
    .map((table) => getTableConfig(table).name);
}

describe("the table map", () => {
  it("gives every table of the schema a home, and names no table that does not exist", async () => {
    const declared = [...tablesOf(schema), ...tablesOf(authSchema)];
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name not like 'd1_%' and name not like 'search_text_%'",
    ).all<{ name: string }>();
    const migrated = results.map((row) => row.name);
    const homes = Object.keys(TABLE_HOMES);
    for (const table of [...declared, ...migrated]) expect(homes, table).toContain(table);
    for (const table of homes) expect(migrated, table).toContain(table);
  });

  it("finds tables after the keywords that name one and as qualifiers, never in literals or columns", () => {
    expect(
      tablesIn('select "comment_notices" from "account_settings" where "user_id" = ?'),
    ).toEqual(["account_settings"]);
    expect(
      tablesIn(
        'select 1 from `artifacts` inner join "versions" on "versions"."id" = "artifacts"."current_version_id"',
      ),
    ).toEqual(["artifacts", "versions"]);
    expect(
      tablesIn("insert into outbox select 'users', 1 where exists (select 1 from users)"),
    ).toEqual(["users", "outbox"]);
    expect(tablesIn('update "owner_plans" set "plan" = ?')).toEqual(["owner_plans"]);
    expect(tablesIn("delete from search_text where rowid = ?")).toEqual(["search_text"]);
    expect(tablesIn("select 'from users'")).toEqual([]);
  });

  it("lets each side touch its own tables and the tables every database has", () => {
    expect(misplacedTables("regional", "select * from artifacts join users on 1")).toEqual([
      "users",
    ]);
    expect(misplacedTables("global", "select * from artifacts join users on 1")).toEqual([
      "artifacts",
    ]);
    expect(misplacedTables("regional", "insert into outbox values (1)")).toEqual([]);
    expect(misplacedTables("global", "insert into audit_events values (1)")).toEqual([]);
  });
});

describe("the guard", () => {
  const record = () => {
    const seen: RegionGuardViolation[] = [];
    return { seen, report: (violation: RegionGuardViolation) => seen.push(violation) };
  };

  it("refuses a regional handle that names a global table, and the reverse", async () => {
    const regional = regionalDb(guardD1(env.DB, "regional", "default"), globalDb(env.DB));
    await expect(regional.select().from(schema.ownerPlans).limit(1)).rejects.toThrow(
      RegionGuardError,
    );
    const global = globalDb(guardD1(env.DB, "global", "global"));
    await expect(global.select().from(schema.artifacts).limit(1)).rejects.toThrow(
      "A statement through the global database names regional tables (artifacts)",
    );
    // Its own tables pass, raw statements and `exec` included.
    await regional.select().from(schema.artifacts).limit(1);
    await global.select().from(schema.users).limit(1);
    expect(() => guardD1(env.DB, "regional", "eu").exec("select 1 from users")).toThrow(
      "region eu's database names global tables (users)",
    );
  });

  it("refuses a batch with a statement another handle prepared, and runs one of its own", async () => {
    const { seen, report } = record();
    const raw = env.DB;
    const global = globalDb(guardD1(raw, "global", "global", report));
    const regional = regionalDb(guardD1(raw, "regional", "default", report), global);
    await regional.batch([
      regional.select().from(schema.artifacts).limit(1),
      regional.select().from(schema.versions).limit(1),
    ]);
    expect(seen).toEqual([]);
    await regional.batch([
      regional.select().from(schema.artifacts).limit(1),
      global.select().from(schema.users).limit(1),
    ]);
    expect(seen).toMatchObject([{ kind: "batch", side: "regional", region: "default" }]);
    expect(describeViolation(seen[0] as RegionGuardViolation)).toContain(
      "A batch on region default's database carries statements prepared through another handle",
    );
  });

  it("names who prepared a statement, and tells test files from product code", () => {
    const product = [
      "Error",
      "    at Proxy.<anonymous> (/repo/packages/db/src/region-guard.ts:1:1)",
      "    at SQLiteSelectBase.all (/repo/node_modules/drizzle-orm/select.js:1:1)",
      "    at async ownerEntitlements (/repo/packages/services/src/plans.ts:1:1)",
      "    at async it (/repo/packages/services/test/plans.test.ts:1:1)",
    ].join("\n");
    expect(statementCaller(product)).toEqual({ name: "ownerEntitlements", test: false });
    const test = [
      "Error",
      "    at Object.prepare (/repo/packages/db/src/region-guard.ts:1:1)",
      "    at /repo/packages/services/test/fixtures.ts:3:3",
    ].join("\n");
    expect(statementCaller(test)?.test).toBe(true);
    expect(statementCaller("Error\n    at Proxy.x (/repo/node_modules/a.js:1:1)")).toBeUndefined();
  });

  it("is off in deployed Workers and lets test files through when strict or collecting", async () => {
    expect(guardFor(undefined)(env.DB, "regional", "default")).toBe(env.DB);
    expect(guardFor("off")(env.DB, "regional", "default")).toBe(env.DB);
    // A missing binding stays missing, so a test can stand it in for a failing one.
    expect(guardFor("strict")(undefined as unknown as D1Database, "regional", "default")).toBe(
      undefined,
    );
    for (const mode of ["strict", "collect"]) {
      const guarded = regionalDb(guardFor(mode)(env.DB, "regional", "default"), globalDb(env.DB));
      // Prepared right here, in a test file: arranging rows is not product code.
      await guarded.select().from(schema.users).limit(1);
    }
  });

  it("throws for product code unless the crossing is known, and collects instead when asked", async () => {
    const from = (name: string) => () =>
      `Error\n    at async ${name} (/repo/packages/services/src/plans.ts:1:1)`;
    const regional = (mode: string, name: string) =>
      regionalDb(guardFor(mode, from(name))(env.DB, "regional", "default"), globalDb(env.DB));
    await expect(
      regional("strict", "ownerEntitlements").select().from(schema.ownerPlans).limit(1),
    ).rejects.toThrow(RegionGuardError);
    // A listed crossing passes until the change that fixes it removes it from the list.
    await regional("strict", "setOwnerPlan").select().from(schema.ownerPlans).limit(1);
    const store = globalThis as { __regionGuard?: Set<string> };
    delete store.__regionGuard;
    await regional("collect", "ownerEntitlements").select().from(schema.ownerPlans).limit(1);
    expect([...(store.__regionGuard ?? [])]).toEqual([
      "ownerEntitlements | table regional/default owner_plans",
    ]);
    delete store.__regionGuard;
  });

  it("lists every known crossing with what it still does wrong", () => {
    for (const [name, why] of Object.entries(KNOWN_CROSS_DATABASE)) {
      expect(name).toMatch(/^[a-z][A-Za-z]+$/);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
