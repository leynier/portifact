import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("0082 keeps an override's steps when the data step joins them and allows five", async () => {
  const db = env.MIGRATION_DB,
    all = env.TEST_MIGRATIONS;
  const at = all.findIndex((m) => m.name.startsWith("0082_"));
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, all.slice(0, at));
  // Four steps before: uploads, comments, public and protected traffic.
  await db
    .prepare(
      "insert into platform_budget(id,cycle_start,level,actions,projected_cents,metrics,analytics,measured_at,level_changed_at,override_level,override_steps,override_until,override_note,override_set_at) values('global',1,'protect100','[\"block_uploads\"]',12000,'{\"storedBytes\":0}','ok',2,3,'protect100',4,null,'note',5)",
    )
    .run();
  await applyD1Migrations(db, all.slice(0, at + 1));
  const row = await db.prepare("select * from platform_budget").first();
  // The same four, now with the data step between uploads and comments: five steps.
  expect(row).toEqual({
    id: "global",
    cycle_start: 1,
    level: "protect100",
    actions: '["block_uploads"]',
    projected_cents: 12000,
    metrics: '{"storedBytes":0}',
    analytics: "ok",
    measured_at: 2,
    level_changed_at: 3,
    override_level: "protect100",
    override_steps: 5,
    override_until: null,
    override_note: "note",
    override_set_at: 5,
  });
  await db.prepare("update platform_budget set override_steps = 1").run();
  expect(
    await db.prepare("select override_steps from platform_budget").first("override_steps"),
  ).toBe(1);
  await expect(db.prepare("update platform_budget set override_steps = 6").run()).rejects.toThrow(
    /CHECK constraint failed/,
  );
});
