import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { TABLE_HOMES } from "../src/table-homes.ts";

it("0079 preserves populated rows and the entire trigger inventory", async () => {
  const db = env.MIGRATION_DB,
    all = env.TEST_MIGRATIONS;
  const at = all.findIndex((m) => m.name.startsWith("0079_"));
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, all.slice(0, at));
  await db.batch([
    db.prepare(
      "insert into artifacts(id,owner_id,type,name) values('upgrade079','owner','site','Ordinary')",
    ),
    db.prepare(
      "insert into annotation_threads(id,artifact_id,version_id,owner_id,author_id,target,target_bytes,path,updated_at) values('t79','upgrade079','v1','owner','u','{}',2,'index.html',1)",
    ),
    db.prepare(
      "insert into annotation_messages(id,thread_id,artifact_id,owner_id,author_id,body,body_bytes,created_at) values('m79','t79','upgrade079','owner','u','hello',5,1)",
    ),
  ]);
  const triggers = async () =>
    (
      await db
        .prepare("select name,sql from sqlite_master where type='trigger' order by name")
        .all()
    ).results;
  const before = await triggers();
  const rows = await db.prepare("select * from artifacts").all();
  const usage = await db.prepare("select * from annotation_usage").all();
  const messages = await db.prepare("select * from annotation_messages").all();
  await applyD1Migrations(db, all.slice(0, at + 1));
  expect(await triggers()).toEqual(before);
  expect(before).toHaveLength(51);
  expect((await db.prepare("select * from annotation_messages").all()).results).toEqual(
    messages.results,
  );
  expect((await db.prepare("select * from artifacts").all()).results).toEqual(rows.results);
  expect((await db.prepare("select * from annotation_usage").all()).results).toEqual(usage.results);
  expect(TABLE_HOMES.artifact_data).toBe("regional");
  expect(TABLE_HOMES.data_findings).toBe("regional");
  await db
    .prepare("insert into artifact_data(artifact_id,updated_at) values('upgrade079',1)")
    .run();
  await db
    .prepare(
      "insert into data_findings(artifact_id,action,first_seen_at,last_seen_at) values('upgrade079','raised',1,1)",
    )
    .run();
  await db.prepare("delete from artifacts where id='upgrade079'").run();
  expect(await db.prepare("select count(*) n from artifact_data").first("n")).toBe(0);
  expect(await db.prepare("select count(*) n from data_findings").first("n")).toBe(1);
  console.log("MIGRATION79_TRIGGER_COUNT", before.length);
});
