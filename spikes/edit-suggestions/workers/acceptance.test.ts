// The acceptance claim on local D1 in workerd (decision 0027, rule 12 of the second round).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runAcceptance } from "./acceptance.ts";

const db = env.DB;
const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
const value = async (sql: string) => (await db.prepare(sql).first<{ v: string }>())?.v;

beforeEach(async () => {
  await db.batch([
    db.prepare("delete from artifacts"),
    db.prepare("delete from suggestions"),
    db.prepare("delete from drafts"),
    db.prepare("delete from change_items"),
    db.prepare("delete from acceptance_claims"),
    db.prepare("insert into artifacts values ('a1', 'v1')"),
    db.prepare("insert into suggestions values ('s1', 'a1', 'applying', 'att1')"),
    db.prepare("insert into drafts values ('a1', 'u1', 3)"),
    // 990 open items: room for exactly 10 more.
    db.prepare(
      "insert into change_items (artifact_id, state, envelope) with recursive n(i) as (select 1 union all select i + 1 from n where i < 990) select 'a1', 'open', '{}' from n",
    ),
  ]);
});

const accept = {
  attempt: "att1",
  runToken: "r1",
  artifactId: "a1",
  baseVersion: "v1",
  newVersion: "v2",
  suggestionId: "s1",
  items: Array.from({ length: 10 }, () => "{}"),
};

describe("the acceptance claim", () => {
  it("publishes, lists every item and completes together", async () => {
    expect(await runAcceptance(db, accept)).toBe(true);
    expect(await count("select count(*) n from change_items where state = 'open'")).toBe(1_000);
    expect(await value("select current_version v from artifacts")).toBe("v2");
    expect(await value("select state v from suggestions")).toBe("accepted");
  });

  it("does nothing at all when a competing insertion filled the list first", async () => {
    await db
      .prepare(
        "insert into change_items (artifact_id, state, envelope) values ('a1', 'open', '{}')",
      )
      .run();
    expect(await runAcceptance(db, accept)).toBe(false);
    expect(await count("select count(*) n from change_items")).toBe(991);
    expect(await value("select current_version v from artifacts")).toBe("v1");
    expect(await value("select state v from suggestions")).toBe("applying");
  });

  it("does nothing when the version moved or the attempt is not the suggestion's", async () => {
    await db.prepare("update artifacts set current_version = 'v9'").run();
    expect(await runAcceptance(db, accept)).toBe(false);
    await db.prepare("update artifacts set current_version = 'v1'").run();
    expect(await runAcceptance(db, { ...accept, attempt: "att-other" })).toBe(false);
    expect(await count("select count(*) n from change_items")).toBe(990);
  });

  it("changes nothing on a duplicate delivery", async () => {
    expect(await runAcceptance(db, accept)).toBe(true);
    expect(await runAcceptance(db, { ...accept, runToken: "r2" })).toBe(false);
    expect(await count("select count(*) n from change_items")).toBe(1_000);
  });

  it("completes a no-version draft publish exactly once", async () => {
    const draft = {
      attempt: "att2",
      runToken: "r3",
      artifactId: "a1",
      baseVersion: "v1",
      newVersion: null,
      draft: { userId: "u1", revision: 3 },
      items: ["{}"],
    };
    expect(await runAcceptance(db, draft)).toBe(true);
    expect(await count("select count(*) n from drafts")).toBe(0);
    expect(await value("select current_version v from artifacts")).toBe("v1");
    expect(await runAcceptance(db, { ...draft, runToken: "r4" })).toBe(false);
    expect(await count("select count(*) n from change_items")).toBe(991);
  });

  it("claims nothing without a suggestion or a draft to complete", async () => {
    const { suggestionId: _s, ...orphan } = accept;
    expect(await runAcceptance(db, orphan)).toBe(false);
    expect(await value("select current_version v from artifacts")).toBe("v1");
  });
});
