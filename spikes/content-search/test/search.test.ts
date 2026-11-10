import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  buildMatch,
  indexArtifact,
  ownerToken,
  parseSnippet,
  searchOwner,
  segment,
} from "../src/search.ts";
import { count, id, seedArtifact } from "./harness.ts";

describe("FTS5 on D1 in workerd", () => {
  it("creates the virtual table from a plain migration and answers a MATCH", async () => {
    const owner = id("u");
    const { artifactId, versionId } = await seedArtifact(owner);
    expect(
      await indexArtifact(env.DB, {
        artifactId,
        ownerId: owner,
        versionId,
        files: [{ path: "index.md", text: "The quarterly report" }],
      }),
    ).toBe(true);
    const { hits } = await searchOwner(env.DB, owner, "quarterly");
    expect(hits).toEqual([
      { artifactId, path: "index.md", snippet: "The quarterly report", ranges: [[4, 13]] },
    ]);
  });

  it("lives beside Drizzle: Drizzle reads the regular tables and runs MATCH through a raw sql template", async () => {
    const searchFiles = sqliteTable("search_files", {
      id: integer("id").primaryKey(),
      artifactId: text("artifact_id").notNull(),
      ownerId: text("owner_id").notNull(),
      path: text("path").notNull(),
    });
    const db = drizzle(env.DB);
    const owner = id("u");
    const { artifactId, versionId } = await seedArtifact(owner);
    await indexArtifact(env.DB, {
      artifactId,
      ownerId: owner,
      versionId,
      files: [{ path: "a.txt", text: "drizzle meets fts" }],
    });
    const rows = await db
      .select({ path: searchFiles.path })
      .from(searchFiles)
      .where(
        sql`${searchFiles.id} in (select rowid from search_text where search_text match ${`owner : ${ownerToken(owner)} AND "fts"`})`,
      );
    expect(rows).toEqual([{ path: "a.txt" }]);
    // A batch can hold a raw statement built with Drizzle's sql template.
    const [deleted] = await db.batch([db.run(sql`delete from search_text where rowid = -1`)]);
    expect(deleted.meta.changes).toBe(0);
  });

  it("never lets a search see another owner's rows", async () => {
    const a = id("u");
    const b = `${a}x`; // an owner ID that extends another must not match it
    const one = await seedArtifact(a);
    const two = await seedArtifact(b);
    await indexArtifact(env.DB, {
      ...one,
      ownerId: a,
      files: [{ path: "x.md", text: "shared secret word" }],
    });
    await indexArtifact(env.DB, {
      ...two,
      ownerId: b,
      files: [{ path: "x.md", text: "shared secret word" }],
    });
    expect((await searchOwner(env.DB, a, "secret")).hits.map((h) => h.artifactId)).toEqual([
      one.artifactId,
    ]);
    expect((await searchOwner(env.DB, b, "secret")).hits.map((h) => h.artifactId)).toEqual([
      two.artifactId,
    ]);
  });
});

describe("tokenizers for the product's languages", () => {
  const corpus = [
    ["en", "The Quarterly Revenue report"],
    ["es", "La canción del año está aquí"],
    ["pt-BR", "Informação sobre a migração"],
    ["fr", "Le café est déjà prêt"],
    ["de", "Die Straße über den Fluss"],
    ["ru", "Отчёт о данных за квартал"],
    ["ja", "東京都の会議資料をまとめました"],
    ["zh-CN", "我们的中文文档包含季度报告"],
  ] as const;
  const queries = [
    ["en", "revenue", true],
    ["es", "cancion", true],
    ["es", "ANO", true],
    ["pt-BR", "migracao", true],
    ["fr", "deja", true],
    ["de", "uber", true],
    ["de", "strasse", false], // ß is not folded to ss by either tokenizer
    ["ru", "отчет", true], // ё is not a diacritic to unicode61: segment() folds it to е
    ["ja", "会議", true],
    ["ja", "会議資料", true],
    ["zh-CN", "中文", true],
    ["zh-CN", "季度报告", true],
  ] as const;

  async function unicodeAlone(text: string, q: string): Promise<boolean> {
    await env.DB.prepare("delete from unicode_text").run();
    await env.DB.prepare("insert into unicode_text (body) values (?)").bind(text).run();
    const term = `"${q.replace(/"/g, '""')}"`;
    return (
      (await count("select count(*) as n from unicode_text where unicode_text match ?", term)) > 0
    );
  }

  async function trigram(text: string, q: string): Promise<boolean> {
    await env.DB.prepare("delete from trigram_text").run();
    await env.DB.prepare("insert into trigram_text (body) values (?)").bind(text).run();
    const term = `"${q.replace(/"/g, '""')}"`;
    return (
      (await count("select count(*) as n from trigram_text where trigram_text match ?", term)) > 0
    );
  }

  async function segmented(text: string, q: string): Promise<boolean> {
    const owner = id("u");
    const seeded = await seedArtifact(owner);
    await indexArtifact(env.DB, { ...seeded, ownerId: owner, files: [{ path: "a.md", text }] });
    return (await searchOwner(env.DB, owner, q)).hits.length > 0;
  }

  it("records which tokenizer finds what", async () => {
    const table: Record<string, { unicode61: boolean; trigram: boolean; segmented: boolean }> = {};
    for (const [lang, q, _] of queries) {
      const text = corpus.find(([l]) => l === lang)?.[1] ?? "";
      table[`${lang} ${q}`] = {
        unicode61: await unicodeAlone(text, q),
        trigram: await trigram(text, q),
        segmented: await segmented(text, q),
      };
    }
    // unicode61 alone treats a run of Han or kana as one token: a word inside it is not found.
    // trigram finds substrings of three characters or more, so two-character Chinese and
    // Japanese words find nothing. unicode61 with CJK characters segmented finds every case.
    expect(table).toEqual({
      "en revenue": { unicode61: true, trigram: true, segmented: true },
      "es cancion": { unicode61: true, trigram: true, segmented: true },
      "es ANO": { unicode61: true, trigram: true, segmented: true },
      "pt-BR migracao": { unicode61: true, trigram: true, segmented: true },
      "fr deja": { unicode61: true, trigram: true, segmented: true },
      "de uber": { unicode61: true, trigram: true, segmented: true },
      "de strasse": { unicode61: false, trigram: false, segmented: false },
      "ru отчет": { unicode61: false, trigram: false, segmented: true },
      "ja 会議": { unicode61: false, trigram: false, segmented: true },
      "ja 会議資料": { unicode61: false, trigram: true, segmented: true },
      "zh-CN 中文": { unicode61: false, trigram: false, segmented: true },
      "zh-CN 季度报告": { unicode61: false, trigram: true, segmented: true },
    });
    for (const [lang, q, expected] of queries)
      expect(table[`${lang} ${q}`]?.segmented, `${lang} ${q}`).toBe(expected);
  });

  it("matches a whole word, not a part of one, outside CJK (prefix search is a separate choice)", async () => {
    expect(await segmented("roadmap", "road")).toBe(false);
    expect(await trigram("roadmap", "road")).toBe(true);
  });

  it("highlights a CJK match as one range, without the separators", async () => {
    const owner = id("u");
    const seeded = await seedArtifact(owner);
    await indexArtifact(env.DB, {
      ...seeded,
      ownerId: owner,
      files: [{ path: "a.md", text: "我们的中文文档" }],
    });
    const [hit] = (await searchOwner(env.DB, owner, "中文")).hits;
    expect(hit).toMatchObject({ snippet: "我们的中文文档", ranges: [[3, 5]] });
  });
});

describe("the MATCH expression is built only from plain terms", () => {
  const hostile = [
    '"',
    '""',
    "a OR b",
    "NEAR(a b)",
    "owner : x",
    "{owner body} : x",
    "a* ^b -c +d",
    "(((((",
    "AND OR NOT",
    "body:secret",
    "\u0000\u001f\ue000",
    "x".repeat(10_000),
    "🙂 😀",
  ];

  it.each(hostile)("never errors and never leaves the owner: %j", async (q) => {
    const owner = id("u");
    const other = id("u");
    const mine = await seedArtifact(owner);
    const theirs = await seedArtifact(other);
    await indexArtifact(env.DB, {
      ...mine,
      ownerId: owner,
      files: [{ path: "a.md", text: "a b c d x secret owner body near" }],
    });
    await indexArtifact(env.DB, {
      ...theirs,
      ownerId: other,
      files: [{ path: "a.md", text: "a b c d x secret owner body near" }],
    });
    const { hits } = await searchOwner(env.DB, owner, q);
    expect(hits.every((h) => h.artifactId === mine.artifactId)).toBe(true);
  });

  it("quotes every term and drops what is not a letter, mark or digit", () => {
    expect(buildMatch('say "hi" OR NEAR(x)')).toBe('"say" "hi" "OR" "NEAR" "x"');
    expect(buildMatch("会議 notes")).toBe('"会 議" "notes"');
    expect(buildMatch("  ")).toBeNull();
    expect(buildMatch("a b c d e f g h i j")?.split(" ").length).toBe(8);
  });

  it("strips the index's own markers from stored text", () => {
    expect(segment("a\ue000b\u001fc")).toBe("abc");
    expect(segment("ab中文cd")).toBe("ab中\u001f文cd");
    expect(parseSnippet("x\ue000\ue001y")).toEqual({ snippet: "xy", ranges: [] });
  });
});
