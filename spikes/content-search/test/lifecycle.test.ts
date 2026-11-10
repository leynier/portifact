import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { indexArtifact, searchOwner } from "../src/search.ts";
import { count, databaseSize, id, prose, seedArtifact } from "./harness.ts";

async function indexed(artifactId: string) {
  return {
    artifacts: await count(
      "select count(*) as n from search_artifacts where artifact_id = ?",
      artifactId,
    ),
    files: await count("select count(*) as n from search_files where artifact_id = ?", artifactId),
    text: await count(
      "select count(*) as n from search_text where rowid in (select id from search_files where artifact_id = ?)",
      artifactId,
    ),
  };
}

async function textRows(): Promise<number> {
  return count("select count(*) as n from search_text");
}

describe("writes in a D1 batch", () => {
  it("writes nothing when the version is no longer current (a stale job)", async () => {
    const owner = id("u");
    const { artifactId } = await seedArtifact(owner, "v2");
    const before = await textRows();
    expect(
      await indexArtifact(env.DB, {
        artifactId,
        ownerId: owner,
        versionId: "v1",
        files: [{ path: "a.md", text: "old" }],
      }),
    ).toBe(false);
    expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
    expect(await textRows()).toBe(before);
  });

  it("replaces the previous version's rows, and running the same job twice changes nothing", async () => {
    const owner = id("u");
    const { artifactId } = await seedArtifact(owner, "v1");
    await indexArtifact(env.DB, {
      artifactId,
      ownerId: owner,
      versionId: "v1",
      files: [
        { path: "a.md", text: "first" },
        { path: "b.md", text: "second" },
      ],
    });
    await env.DB.prepare("update artifacts set current_version_id = 'v2' where id = ?")
      .bind(artifactId)
      .run();
    const job = {
      artifactId,
      ownerId: owner,
      versionId: "v2",
      files: [{ path: "a.md", text: "third" }],
    };
    await indexArtifact(env.DB, job);
    await indexArtifact(env.DB, job);
    expect(await indexed(artifactId)).toEqual({ artifacts: 1, files: 1, text: 1 });
    expect((await searchOwner(env.DB, owner, "first")).hits).toEqual([]);
    expect((await searchOwner(env.DB, owner, "third")).hits).toHaveLength(1);
  });

  it("rolls the full-text writes back with the rest when a statement of the batch fails", async () => {
    const owner = id("u");
    const { artifactId, versionId } = await seedArtifact(owner);
    const before = await textRows();
    await expect(
      env.DB.batch([
        env.DB.prepare("insert into search_artifacts values (?, ?, ?, 1, 0)").bind(
          artifactId,
          owner,
          versionId,
        ),
        env.DB.prepare(
          "insert into search_files (artifact_id, owner_id, path) values (?, ?, 'a')",
        ).bind(artifactId, owner),
        env.DB.prepare(
          "insert into search_text (rowid, owner, body) select id, 'o', 'rolled back' from search_files where artifact_id = ?",
        ).bind(artifactId),
        env.DB.prepare("insert into search_artifacts values (?, ?, ?, 1, 0)").bind(
          artifactId,
          owner,
          versionId,
        ), // duplicate key
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await textRows()).toBe(before);
    expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
  });
});

describe("removal follows the artifact", () => {
  async function seededIndex() {
    const owner = id("u");
    const seeded = await seedArtifact(owner);
    await indexArtifact(env.DB, {
      ...seeded,
      ownerId: owner,
      files: [
        { path: "a.md", text: "alpha" },
        { path: "b.md", text: "beta" },
      ],
    });
    expect(await indexed(seeded.artifactId)).toEqual({ artifacts: 1, files: 2, text: 2 });
    return { owner, ...seeded };
  }

  it.each(["archived", "suspended", "purging", "deleted"])(
    "empties the index when the state becomes %s",
    async (state) => {
      const { artifactId } = await seededIndex();
      await env.DB.prepare("update artifacts set state = ? where id = ?")
        .bind(state, artifactId)
        .run();
      expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
    },
  );

  it("empties the index when the artifact row is deleted: the foreign key cascade fires the trigger", async () => {
    const { artifactId } = await seededIndex();
    const before = await textRows();
    await env.DB.prepare("delete from artifacts where id = ?").bind(artifactId).run();
    expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
    expect(await textRows()).toBe(before - 2);
  });

  it("empties the index when the artifact moves to another owner", async () => {
    const { artifactId } = await seededIndex();
    await env.DB.prepare("update artifacts set owner_id = 'ws_other' where id = ?")
      .bind(artifactId)
      .run();
    expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
  });

  it("does the same inside a batch that also guards on the old state (an archive with its outbox row)", async () => {
    const { artifactId } = await seededIndex();
    const [, archived] = await env.DB.batch([
      env.DB.prepare(
        "insert into outbox (id, topic, payload) select ?, 'x', '{}' where exists (select 1 from artifacts where id = ? and state = 'active')",
      ).bind(id("o"), artifactId),
      env.DB.prepare(
        "update artifacts set state = 'archived' where id = ? and state = 'active' returning id",
      ).bind(artifactId),
    ]);
    // meta.changes counts the trigger's writes too (the artifact, the index rows and FTS5's own
    // shadow-table writes), so a guarded update is checked with `returning`, as the services do.
    expect(archived?.meta.changes).toBeGreaterThan(1);
    expect(archived?.results).toEqual([{ id: artifactId }]);
    expect(await indexed(artifactId)).toEqual({ artifacts: 0, files: 0, text: 0 });
  });
});

describe("storage and query cost", () => {
  it("measures the bytes one indexed megabyte adds, and the rows a search reads", async () => {
    const owner = id("u");
    const startSize = await databaseSize();
    const files = Array.from({ length: 16 }, (_, i) => ({
      path: `p${i}.md`,
      text: prose(64 * 1024, i + 1),
    }));
    for (const chunk of [files.slice(0, 8), files.slice(8)]) {
      const seeded = await seedArtifact(owner);
      await indexArtifact(env.DB, { ...seeded, ownerId: owner, files: chunk });
    }
    const growth = (await databaseSize()) - startSize;
    const beforeTrigram = await databaseSize();
    for (const file of files)
      await env.DB.prepare("insert into trigram_text (body) values (?)").bind(file.text).run();
    const trigramGrowth = (await databaseSize()) - beforeTrigram;
    const cjk = "季度报告包含我们的中文文档和东京都的会议资料".repeat(2000);
    const beforeCjk = await databaseSize();
    const cjkOwner = id("u");
    const cjkSeed = await seedArtifact(cjkOwner);
    await indexArtifact(env.DB, {
      ...cjkSeed,
      ownerId: cjkOwner,
      files: [{ path: "zh.md", text: cjk }],
    });
    const cjkGrowth = (await databaseSize()) - beforeCjk;
    // Other owners in the same database, to see whether their rows add to this owner's search.
    for (let i = 0; i < 20; i++) {
      const other = id("u");
      const seeded = await seedArtifact(other);
      await indexArtifact(env.DB, {
        ...seeded,
        ownerId: other,
        files: [{ path: "x.md", text: prose(32 * 1024, 100 + i) }],
      });
    }
    const common = await searchOwner(env.DB, owner, "revenue");
    const rare = await searchOwner(env.DB, owner, "notpresent");
    const ownerOnly = await env.DB.prepare(
      "select count(*) as n from search_text where search_text match ?",
    )
      .bind(`"revenue"`)
      .first<{ n: number }>();
    const report = {
      indexedMiB: 1,
      growthBytes: growth,
      growthPerIndexedByte: Number((growth / (1024 * 1024)).toFixed(2)),
      trigramGrowthPerIndexedByte: Number((trigramGrowth / (1024 * 1024)).toFixed(2)),
      cjkGrowthPerIndexedByte: Number(
        (cjkGrowth / new TextEncoder().encode(cjk).length).toFixed(2),
      ),
      commonTermHits: common.hits.length,
      commonTermRowsRead: common.rowsRead,
      missingTermRowsRead: rare.rowsRead,
      regionWideMatches: ownerOnly?.n,
    };
    // Measured on 2026-11-10 (decision 0012): 1.29 bytes per indexed byte with unicode61 (text
    // stored once in FTS5's content table plus the index), 2.74 with trigram, 1.68 for CJK text
    // segmented with one separator byte per character pair. A common term read 54 rows for 2
    // artifacts of 16 files among 36 matching files in the database; a missing term read 1.
    expect(report.growthPerIndexedByte).toBeLessThan(1.6);
    expect(report.trigramGrowthPerIndexedByte).toBeGreaterThan(2 * report.growthPerIndexedByte);
    expect(report.cjkGrowthPerIndexedByte).toBeLessThan(2.2);
    expect(report.missingTermRowsRead).toBeLessThan(5);
    expect(common.hits).toHaveLength(2);
    expect(rare.hits).toEqual([]);
  });
});
