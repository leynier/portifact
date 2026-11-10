// Content search (premium plan T8, decision 0012): indexing through the outbox on commit,
// rollback, restore and transfer; every removal path; who may search; the plan gate; paging;
// hostile queries against the real FTS5 table.
import { env } from "cloudflare:test";
import { planRequiredMessage, SEARCH_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyTombstones } from "../src/backups.ts";
import {
  dropLapsedSearchIndexes,
  scheduleSearchIndexing,
  searchContent,
} from "../src/content-search.ts";
import { archiveArtifact, deleteArtifact, restoreArtifact } from "../src/lifecycle.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { resolveOwnerScope } from "../src/workspaces.ts";
import { db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { type Published, publishVersion, workspace } from "./version-support.ts";

const LATER = NOW + 60_000;

async function jobsFor(artifactId: string) {
  return db()
    .select({ id: schema.outbox.id, payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "search_index"), eq(schema.outbox.subject, artifactId)));
}

/** Runs the artifact's waiting search jobs, continuations included, until none is left. */
async function index(artifactId: string, now = LATER) {
  const outcomes = [];
  for (let round = 0; round < 20; round++) {
    const jobs = await jobsFor(artifactId);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      outcomes.push(await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "search_index" }, now));
    }
  }
  return outcomes;
}

async function indexedRows(artifactId: string) {
  const [row] = await db().all<{ artifacts: number; chunks: number; text: number }>(
    sql`select (select count(*) from search_artifacts where artifact_id = ${artifactId}) as artifacts, (select count(*) from search_chunks where artifact_id = ${artifactId}) as chunks, (select count(*) from search_text where rowid in (select id from search_chunks where artifact_id = ${artifactId})) as text`,
  );
  return row;
}

const search = (actor: Actor, query: string, extra: { cursor?: string; limit?: number } = {}) =>
  searchContent(db(), { actor, query, limit: extra.limit ?? 20, cursor: extra.cursor, now: LATER });

const found = async (actor: Actor, query: string) =>
  value(await search(actor, query)).items.map((item) => item.artifact.id);

async function teamOwner() {
  const owner = await user();
  await grantPlan(owner.id, "team");
  return owner;
}

async function site(
  userId: string,
  files: Record<string, string>,
  options: { ownerId?: string; base?: Published } = {},
) {
  const published = await publishVersion(userId, files, { now: NOW, ...options });
  await index(published.artifactId);
  return published;
}

describe("indexing", () => {
  it("indexes the visible text of a site's pages through the commit's job, never scripts or attributes", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    const published = await publishVersion(owner.id, {
      "index.html":
        '<h1>Quarterly roadmap</h1><script>secretscript</script><a title="hiddenattr">link</a>',
      "about/team.html": "<p>Meet the platform team</p>",
      "style.css": "body { color: quarterly }",
    });
    expect(await jobsFor(published.artifactId)).toEqual([
      { id: expect.any(Number), payload: { versionId: published.versionId } },
    ]);
    expect(await index(published.artifactId)).toEqual(["done"]);
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 1, chunks: 2, text: 2 });
    const [hit] = value(await search(actor, "quarterly")).items;
    expect(hit).toMatchObject({
      artifact: { id: published.artifactId, activity: { versions: 1 } },
      path: "index.html",
      partial: false,
      snippet: { text: "Quarterly roadmap link", highlights: [[0, 9]] },
    });
    expect(value(await search(actor, "platform")).items[0]?.path).toBe("about/team.html");
    for (const hidden of ["secretscript", "hiddenattr", "color"]) {
      expect(await found(actor, hidden), hidden).toEqual([]);
    }
  });

  it("indexes the source of a Markdown document, not its rendering", async () => {
    const owner = await teamOwner();
    const published = await publishVersion(
      owner.id,
      {
        "notes.md": {
          body: "# Release plan\n\nThe **migración** starts in March.",
          contentType: "text/markdown",
        },
      },
      { type: "markdown", entrypoint: "notes.md" },
    );
    await index(published.artifactId);
    const [hit] = value(await search(personalActor(owner.id), "migracion")).items;
    expect(hit?.path).toBe("notes.md");
    expect(hit?.snippet.text).toContain("**migración**");
    expect(await found(personalActor(owner.id), "strong")).toEqual([]);
  });

  it("writes no job and indexes nothing for an owner without the feature", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const published = await publishVersion(owner.id, { "index.html": "<p>pro words</p>" });
    expect(await jobsFor(published.artifactId)).toEqual([]);
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
  });

  it("replaces the previous version's text on a new publish and on a rollback", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    const v1 = await site(owner.id, { "index.html": "<p>alpha</p>" });
    const v2 = await site(owner.id, { "index.html": "<p>beta</p>" }, { base: v1 });
    expect(await found(actor, "alpha")).toEqual([]);
    expect(await found(actor, "beta")).toEqual([v1.artifactId]);
    const rolled = value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: v1.artifactId,
        versionId: v1.versionId,
        baseVersionId: v2.versionId,
        now: LATER,
      }),
    );
    expect((await jobsFor(v1.artifactId)).map((job) => job.payload)).toEqual([
      { versionId: rolled.versionId },
    ]);
    await index(v1.artifactId);
    expect(await found(actor, "alpha")).toEqual([v1.artifactId]);
    expect(await found(actor, "beta")).toEqual([]);
    expect(await indexedRows(v1.artifactId)).toEqual({ artifacts: 1, chunks: 1, text: 1 });
  });

  it("does nothing for a stale job, and a repeated job is done without writing", async () => {
    const owner = await teamOwner();
    const v1 = await publishVersion(owner.id, { "index.html": "<p>first</p>" });
    const [stale] = await jobsFor(v1.artifactId);
    const v2 = await publishVersion(owner.id, { "index.html": "<p>second</p>" }, { base: v1 });
    expect(
      await runJob(db(), env.ARTIFACTS, { id: stale?.id ?? 0, topic: "search_index" }, LATER),
    ).toBe("stale");
    expect(await indexedRows(v1.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
    expect(await index(v2.artifactId)).toEqual(["done"]);
    const before = await db()
      .select()
      .from(schema.searchArtifacts)
      .where(eq(schema.searchArtifacts.artifactId, v1.artifactId));
    // The same job delivered again after its row went: done, nothing written.
    expect(
      await runJob(db(), env.ARTIFACTS, { id: stale?.id ?? 0, topic: "search_index" }, LATER + 1),
    ).toBe("done");
    await db()
      .insert(schema.outbox)
      .values({
        topic: "search_index",
        payload: { versionId: v2.versionId },
        availableAt: NOW,
        subject: v1.artifactId,
      });
    expect(await index(v1.artifactId, LATER + 2)).toEqual(["done"]);
    expect(
      await db()
        .select()
        .from(schema.searchArtifacts)
        .where(eq(schema.searchArtifacts.artifactId, v1.artifactId)),
    ).toEqual(before);
  });

  it("marks a file over the per-file cap as partly indexed", async () => {
    const owner = await teamOwner();
    const big = `<p>${"word ".repeat(SEARCH_LIMITS.fileTextBytes / 5 + 100)} tailword</p>`;
    const published = await site(owner.id, { "index.html": big });
    const [hit] = value(await search(personalActor(owner.id), "word")).items;
    expect(hit?.partial).toBe(true);
    expect(await found(personalActor(owner.id), "tailword")).toEqual([]);
    expect(published).toBeDefined();
  });

  it("indexes nothing while the owner's other artifacts fill its cap, and says pending", async () => {
    const owner = await teamOwner();
    const filler = await site(owner.id, { "index.html": "<p>filler</p>" });
    await db()
      .update(schema.searchArtifacts)
      .set({ textBytes: SEARCH_LIMITS.ownerTextBytes })
      .where(eq(schema.searchArtifacts.artifactId, filler.artifactId));
    const published = await publishVersion(owner.id, { "index.html": "<p>overflow</p>" });
    // The plan leaves no room: an empty, partial row is written, never more than the cap.
    expect(await index(published.artifactId)).toEqual(["done"]);
    expect(
      await db()
        .select({
          bytes: schema.searchArtifacts.textBytes,
          partial: schema.searchArtifacts.partial,
        })
        .from(schema.searchArtifacts)
        .where(eq(schema.searchArtifacts.artifactId, published.artifactId)),
    ).toEqual([{ bytes: 0, partial: true }]);
    expect(await found(personalActor(owner.id), "overflow")).toEqual([]);
  });
});

describe("removal", () => {
  async function indexed() {
    const owner = await teamOwner();
    const published = await site(owner.id, { "index.html": "<p>removable</p>" });
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 1, chunks: 1, text: 1 });
    return { owner, published };
  }
  const input = (owner: { id: string }, published: Published, now = LATER) => ({
    userId: owner.id,
    artifactId: published.artifactId,
    now,
  });

  it("drops an archived artifact and indexes it again on restore", async () => {
    const { owner, published } = await indexed();
    value(await archiveArtifact(db(), input(owner, published)));
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
    expect(await found(personalActor(owner.id), "removable")).toEqual([]);
    value(await restoreArtifact(db(), input(owner, published, LATER + 1)));
    await index(published.artifactId, LATER + 2);
    expect(await found(personalActor(owner.id), "removable")).toEqual([published.artifactId]);
  });

  it("drops a deleted artifact, the full-text rows included", async () => {
    const { owner, published } = await indexed();
    value(await deleteArtifact(db(), env.ARTIFACTS, input(owner, published)));
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
  });

  it("drops a suspended artifact and its row goes with a purge", async () => {
    const { published } = await indexed();
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, published.artifactId));
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
  });

  it("leaves no searchable text of artifacts a restore brought back once the tombstones are applied", async () => {
    const { owner, published } = await indexed();
    const textBefore = await db().all<{ n: number }>(sql`select count(*) as n from search_text`);
    await applyTombstones(
      db(),
      [{ kind: "artifact", id: published.artifactId, deletedAt: NOW }],
      LATER,
    );
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
    expect((await db().all<{ n: number }>(sql`select count(*) as n from search_text`))[0]?.n).toBe(
      (textBefore[0]?.n ?? 0) - 1,
    );
    expect(await found(personalActor(owner.id), "removable")).toEqual([]);
  });

  it("re-indexes a transferred artifact under a target with the feature, and drops it under one without", async () => {
    const t = await workspace(user);
    await grantPlan(t.id, "team");
    await grantPlan(t.editor.id, "team");
    const published = await site(t.editor.id, { "index.html": "<p>travelling words</p>" });
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: published.artifactId,
        workspace: await slugOf(t.id),
        now: LATER,
      }),
    );
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
    await index(published.artifactId, LATER + 1);
    const admin = value(await resolveOwnerScope(db().global, t.admin.id, await slugOf(t.id)));
    expect(await found(admin, "travelling")).toEqual([published.artifactId]);
    expect(await found(personalActor(t.editor.id), "travelling")).toEqual([]);

    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId: published.artifactId,
        workspace: null,
        now: LATER + 2,
      }),
    );
    expect(await jobsFor(published.artifactId)).toEqual([]);
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
  });

  it("drops the index of an owner whose plan lost the feature, keeping one granted again meanwhile", async () => {
    const { owner, published } = await indexed();
    const kept = await teamOwner();
    const keptSite = await site(kept.id, { "index.html": "<p>kept</p>" });
    await grantPlan(owner.id, "pro");
    await grantPlan(kept.id, "enterprise");
    expect((await dropLapsedSearchIndexes(db(), LATER)).dropped).toBeGreaterThanOrEqual(1);
    expect(await indexedRows(published.artifactId)).toEqual({ artifacts: 0, chunks: 0, text: 0 });
    expect(await indexedRows(keptSite.artifactId)).toEqual({ artifacts: 1, chunks: 1, text: 1 });
    expect((await dropLapsedSearchIndexes(db(), LATER, 0)).dropped).toBe(0);
  });

  it("indexes lazily after a plan is gained, once per artifact, through the scheduled scan", async () => {
    const owner = await user();
    const published = await publishVersion(owner.id, { "index.html": "<p>later plan</p>" });
    await grantPlan(owner.id, "team");
    expect((await scheduleSearchIndexing(db(), LATER)).scheduled).toBeGreaterThanOrEqual(1);
    expect(await jobsFor(published.artifactId)).toHaveLength(1);
    await scheduleSearchIndexing(db(), LATER);
    expect(await jobsFor(published.artifactId)).toHaveLength(1);
    await index(published.artifactId);
    expect(await found(personalActor(owner.id), "later")).toEqual([published.artifactId]);
    await scheduleSearchIndexing(db(), LATER);
    expect(await jobsFor(published.artifactId)).toEqual([]);
    expect(Object.keys(await runMaintenance(db(), env.ARTIFACTS, LATER))).toEqual(
      expect.arrayContaining(["droppedSearchIndexes", "scheduledSearchIndexing"]),
    );
  });
});

async function slugOf(workspaceId: string): Promise<string> {
  const [row] = await db()
    .select({ slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return row?.slug ?? "";
}

describe("who may search", () => {
  async function teamSpace() {
    const t = await workspace(user);
    await grantPlan(t.id, "team");
    const slug = await slugOf(t.id);
    const published = await site(
      t.editor.id,
      { "index.html": "<p>shared text</p>" },
      { ownerId: t.id },
    );
    return { t, slug, published };
  }

  it("lets admins and editors search, refuses members and answers non-members like a missing workspace", async () => {
    const { t, slug, published } = await teamSpace();
    for (const person of [t.admin, t.editor]) {
      const actor = value(await resolveOwnerScope(db().global, person.id, slug));
      expect(await found(actor, "shared")).toEqual([published.artifactId]);
    }
    const member = value(await resolveOwnerScope(db().global, t.member.id, slug));
    expect(await search(member, "shared")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await resolveOwnerScope(db().global, t.outsider.id, slug)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("never returns another owner's artifacts", async () => {
    const { t, published } = await teamSpace();
    const other = await teamOwner();
    await site(other.id, { "index.html": "<p>shared text</p>" });
    expect(await found(personalActor(other.id), "shared")).not.toContain(published.artifactId);
    expect(t).toBeDefined();
  });

  it("limits a service token to the artifacts its restriction reaches", async () => {
    const { t, published } = await teamSpace();
    const keyed = await site(
      t.editor.id,
      { "index.html": "<p>shared text</p>" },
      { ownerId: t.id },
    );
    await db()
      .update(schema.artifacts)
      .set({ externalKey: "pr_1", createdBy: "st_token" })
      .where(eq(schema.artifacts.id, keyed.artifactId));
    const token = (restriction: NonNullable<Actor["token"]>["restriction"]): Actor => ({
      userId: "st_token",
      ownerId: t.id,
      role: "editor",
      region: "default",
      token: { restriction, scopes: ["artifacts:read"], createdAt: NOW, label: "ci" },
    });
    expect((await found(token({ kind: "none" }), "shared")).sort()).toEqual(
      [published.artifactId, keyed.artifactId].sort(),
    );
    expect(await found(token({ kind: "own" }), "shared")).toEqual([keyed.artifactId]);
    expect(await found(token({ kind: "key", prefix: "pr_" }), "shared")).toEqual([
      keyed.artifactId,
    ]);
    expect(await found(token({ kind: "key", prefix: "docs/" }), "shared")).toEqual([]);
  });

  it("needs content search in the owner's plan, checked after authorization", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    expect(await search(personalActor(owner.id), "anything")).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("contentSearch"),
    });
    const t = await workspace(user);
    const member = value(await resolveOwnerScope(db().global, t.member.id, await slugOf(t.id)));
    expect(await search(member, "anything")).toMatchObject({ code: "forbidden" });
  });

  it("limits searches per actor", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    for (let i = 0; i < SEARCH_LIMITS.perWindow; i++)
      expect((await search(actor, "x")).ok).toBe(true);
    expect(await search(actor, "x")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(
      (await searchContent(db(), { actor, query: "x", limit: 1, now: LATER + 61_000 })).ok,
    ).toBe(true);
  });
});

describe("searching", () => {
  it("pages one result per artifact, newest first, with a cursor that stays stable", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const published = await publishVersion(
        owner.id,
        { "index.html": `<p>paged ${i}</p>`, "b.html": "<p>paged again</p>" },
        { now: NOW + i },
      );
      await index(published.artifactId);
      made.push(published.artifactId);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = value(await search(actor, "paged", { limit: 2, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((item) => item.artifact.id));
      cursor = page.nextCursor ?? undefined;
      // A publish meanwhile moves an artifact to the top; the walk still sees each one once.
      if (seen.length === 2) {
        const [first] = made;
        await db()
          .update(schema.artifacts)
          .set({ updatedAt: NOW + 100 })
          .where(eq(schema.artifacts.id, first as string));
      }
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 2)).toEqual([made[4], made[3]]);
    expect(await search(actor, "paged", { cursor: "not-a-cursor" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("finds Chinese and Japanese words inside a run and folds diacritics", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    const published = await site(owner.id, {
      "index.html": "<p>我们的中文文档 東京都の会議資料 Canción Отчёт</p>",
    });
    for (const query of ["中文", "会議", "cancion", "отчет", "CANCIÓN"]) {
      expect(await found(actor, query), query).toEqual([published.artifactId]);
    }
    const [hit] = value(await search(actor, "中文")).items;
    expect(hit?.snippet.text.slice(...(hit?.snippet.highlights[0] ?? [0, 0]))).toBe("中文");
  });

  it("never errors or leaves the owner, whatever the query", async () => {
    const owner = await teamOwner();
    const actor = personalActor(owner.id);
    const other = await teamOwner();
    await site(owner.id, { "index.html": "<p>a b c owner body near secret</p>" });
    await site(other.id, { "index.html": "<p>a b c owner body near secret</p>" });
    const hostile = [
      '"',
      "a OR b",
      "NEAR(a b)",
      "owner : x",
      "{owner body} : secret",
      "a* ^b -c",
      "(((",
      "AND OR NOT",
      "body:secret",
      `\u0000\u001f${String.fromCharCode(0xe000)}`,
      "🙂",
    ];
    for (const query of hostile) {
      const result = value(await search(actor, query));
      expect(
        result.items.every((item) => item.artifact.ownerId === owner.id),
        query,
      ).toBe(true);
    }
    // Random strings over FTS5's syntax characters, letters and CJK, deterministic.
    const pool = [
      '"',
      "'",
      "*",
      "^",
      ":",
      "{",
      "}",
      "(",
      ")",
      "-",
      "+",
      " ",
      "a",
      "Z",
      "OR",
      "NEAR",
      "中",
      "é",
      "\u0000",
      "\\",
      ",",
    ];
    let state = 7;
    for (let run = 0; run < 40; run++) {
      let query = "";
      for (let i = 0; i < 1 + (run % 30); i++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        query += pool[(state >>> 16) % pool.length];
      }
      const result = await searchContent(db(), {
        actor: personalActor(other.id),
        query,
        limit: 5,
        now: LATER + 120_000 + run * 61_000,
      });
      expect(result.ok, query).toBe(true);
      if (result.ok)
        expect(
          result.value.items.every((item) => item.artifact.ownerId === other.id),
          query,
        ).toBe(true);
    }
  });
});
