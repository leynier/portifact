import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("0080 preserves populated artifact data, findings, ordinary rows and every trigger", async () => {
  const db = env.MIGRATION_DB,
    all = env.TEST_MIGRATIONS;
  const at = all.findIndex((m) => m.name.startsWith("0080_"));
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, all.slice(0, at));
  await db.batch([
    db.prepare(
      "insert into artifacts(id,owner_id,type,name) values('upgrade080','owner','site','Ordinary')",
    ),
    db.prepare(
      "insert into annotation_threads(id,artifact_id,version_id,owner_id,author_id,target,target_bytes,path,updated_at) values('t80','upgrade080','v1','owner','u','{}',2,'index.html',1)",
    ),
    db.prepare(
      "insert into annotation_messages(id,thread_id,artifact_id,owner_id,author_id,body,body_bytes,created_at) values('m80','t80','upgrade080','owner','u','hello',5,1)",
    ),
    db.prepare(
      "insert into artifact_data(artifact_id,generation,epoch,documents_bytes,report_generation,report_seq,updated_at) values('upgrade080',3,7,1234,3,9,10)",
    ),
    db.prepare(
      "insert into data_findings(artifact_id,action,reason,first_seen_at,last_seen_at) values('upgrade080','quarantined','hold',11,12)",
    ),
    db.prepare(
      "insert into data_findings(artifact_id,action,reason,first_seen_at,last_seen_at) values('orphan080','awaiting_operator','orphan',13,14)",
    ),
  ]);
  const rows = async (table: string) =>
    (await db.prepare(`select * from ${table} order by 1`).all()).results;
  const triggers = async () =>
    (
      await db
        .prepare("select name,sql from sqlite_master where type='trigger' order by name")
        .all()
    ).results;
  const before = await triggers();
  const tables = [
    "artifacts",
    "annotation_threads",
    "annotation_messages",
    "annotation_usage",
    "artifact_data",
    "data_findings",
  ];
  const snapshots = await Promise.all(tables.map(rows));
  await applyD1Migrations(db, all.slice(0, at + 1));
  expect(before).toHaveLength(51);
  expect(await triggers()).toEqual(before);
  for (let i = 0; i < tables.length; i++)
    expect(await rows(tables[i]!)).toEqual(
      tables[i] === "data_findings"
        ? snapshots[i]!.map((r) => ({ ...r, state: null }))
        : snapshots[i],
    );
  await db
    .prepare("update data_findings set state='hold:1:owner:3:7' where artifact_id='upgrade080'")
    .run();
  expect(
    await db
      .prepare("select state from data_findings where artifact_id='upgrade080'")
      .first("state"),
  ).toBe("hold:1:owner:3:7");
  console.log("MIGRATION80_TRIGGER_INVENTORY", JSON.stringify({ before, after: await triggers() }));
});
