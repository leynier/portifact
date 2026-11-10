// Content search under its limits (decision 0012, review of PR #179): the cost of the worst
// accepted query on an owner near its cap, a restricted token's search never reading rows outside
// its reach, the index job's memory and R2 budgets with continuations, missing objects, the owner
// column and the bounded scans.
import { env } from "cloudflare:test";
import { SEARCH_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { type Actor, ownerMatch, ownerToken, personalActor, segmentText } from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  dropLapsedSearchIndexes,
  readIndexText,
  scheduleSearchIndexing,
  searchContent,
  searchPageQuery,
} from "../src/content-search.ts";
import { runJob } from "../src/outbox.ts";
import { db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { publishVersion, workspace } from "./version-support.ts";

const LATER = NOW + 60_000;

async function runSearchJobs(artifactId?: string, now = LATER) {
  const outcomes: string[] = [];
  for (let round = 0; round < 20; round++) {
    const jobs = await db()
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.topic, "search_index"),
          artifactId ? eq(schema.outbox.subject, artifactId) : undefined,
        ),
      );
    if (jobs.length === 0) break;
    for (const job of jobs) {
      outcomes.push(await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "search_index" }, now));
    }
  }
  return outcomes;
}

async function teamOwner() {
  const owner = await user();
  await grantPlan(owner.id, "team");
  return owner;
}

/** Deterministic prose over a vocabulary of `words` words, some far more frequent than others. */
function prose(chars: number, seed: number, words = 3000): string {
  let state = seed;
  let out = "";
  while (out.length < chars) {
    state = (state * 1103515245 + 12345) % 2147483648;
    // Squaring skews the draw toward low numbers: w0 to w9 are very common, w2999 rare.
    const r = ((state >>> 8) % 10_000) / 10_000;
    out += `w${Math.floor(r * r * words)} `;
  }
  return out.slice(0, chars);
}

/**
 * Writes an artifact's index rows directly (the job's own statements, without R2), so a test can
 * fill an owner near its cap quickly: `chunks` chunks of about 4,000 characters.
 */
async function seedIndex(ownerId: string, artifactId: string, chunks: string[]) {
  const token = ownerToken(ownerId);
  const bytes = chunks.reduce((n, chunk) => n + chunk.length, 0);
  await env.DB.prepare(
    "insert into search_artifacts (artifact_id, owner_id, version_id, text_bytes, partial, indexed_at, next_file) select id, owner_id, current_version_id, ?, 0, ?, null from artifacts where id = ?",
  )
    .bind(bytes, NOW, artifactId)
    .run();
  for (let i = 0; i < chunks.length; i += 50) {
    const slice = chunks.slice(i, i + 50);
    await env.DB.batch(
      slice.flatMap((chunk, j) => [
        env.DB.prepare(
          "insert into search_chunks (artifact_id, path, seq) values (?, 'index.html', ?)",
        ).bind(artifactId, i + j),
        env.DB.prepare(
          "insert into search_text (rowid, owner, body) select id, ?, ? from search_chunks where artifact_id = ? and seq = ?",
        ).bind(token, segmentText(chunk), artifactId, i + j),
      ]),
    );
  }
}

describe("the worst accepted query on an owner near its cap", () => {
  it("stays under the stated budget", async () => {
    const owner = await teamOwner();
    // 8 artifacts of 4 MiB each: the owner's 32 MiB cap, in 8,400 chunks of 4,000 characters.
    const perArtifact = SEARCH_LIMITS.ownerTextBytes / 8;
    for (let n = 0; n < 8; n++) {
      const { artifactId } = await publishVersion(owner.id, { "index.html": `<p>a${n}</p>` });
      const text = prose(perArtifact, n + 1);
      await seedIndex(owner.id, artifactId, text.match(/[\s\S]{1,4000}/g) ?? []);
    }
    // The most frequent different words the builder accepts, and the longest CJK run.
    const common = Array.from({ length: SEARCH_LIMITS.queryTerms }, (_, i) => `w${i}`).join(" ");
    const cjk = "会".repeat(SEARCH_LIMITS.queryPhraseTokens);
    const actor = personalActor(owner.id);
    for (const query of [common, cjk, `${common.split(" ").slice(0, 7).join(" ")} ${cjk}`]) {
      const started = performance.now();
      const result = await searchContent(db(), { actor, query, limit: 50, now: LATER });
      const elapsed = performance.now() - started;
      expect(result.ok, query).toBe(true);
      if (query === common && result.ok) expect(result.value.items).toHaveLength(8);
      // Budget: under 1.5 s in local workerd (20 ms observed for the eight common words on
      // 2026-11-10, 4 ms for the CJK run), so CI has room; the caps keep it bounded remotely.
      expect(elapsed, query).toBeLessThan(1_500);
    }
    // 100 repeated words are one word; 100 different ones are refused before any work.
    const refused = await searchContent(db(), {
      actor,
      query: Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "),
      limit: 50,
      now: LATER,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_input" });
  }, 120_000);
});

describe("a restricted service token", () => {
  async function rowsRead(actor: Actor, word: string): Promise<number> {
    const query = searchPageQuery(db(), {
      actor,
      match: ownerMatch(actor.ownerId, `"${word}"`),
      after: undefined,
      limit: 20,
      now: LATER,
      retention: { previousVersions: 2, days: 7 },
    }).toSQL();
    const result = await env.DB.prepare(query.sql)
      .bind(...(query.params as unknown[]))
      .all();
    return result.meta.rows_read;
  }

  it("never reads full-text rows outside its reach", async () => {
    const t = await workspace(user);
    await grantPlan(t.id, "team");
    const mine = await publishVersion(t.editor.id, { "index.html": "<p>x</p>" }, { ownerId: t.id });
    await db()
      .update(schema.artifacts)
      .set({ createdBy: "st_reach", externalKey: "pr_1" })
      .where(eq(schema.artifacts.id, mine.artifactId));
    await seedIndex(t.id, mine.artifactId, ["needle in reach"]);
    const token = (restriction: NonNullable<Actor["token"]>["restriction"]): Actor => ({
      userId: "st_reach",
      ownerId: t.id,
      role: "editor",
      region: "default",
      token: { restriction, scopes: ["artifacts:read"], createdAt: NOW, label: "ci" },
    });
    const own = token({ kind: "own" });
    const key = token({ kind: "key", prefix: "pr_" });
    const none = token({ kind: "none" });
    const outside = await publishVersion(
      t.editor.id,
      { "index.html": "<p>y</p>" },
      { ownerId: t.id },
    );
    await seedIndex(t.id, outside.artifactId, Array(200).fill("needle outside reach"));
    const before = {
      own: await rowsRead(own, "needle"),
      key: await rowsRead(key, "needle"),
      none: await rowsRead(none, "needle"),
    };
    // Ten times as many matching rows outside the reach.
    const more = await publishVersion(t.editor.id, { "index.html": "<p>z</p>" }, { ownerId: t.id });
    await seedIndex(t.id, more.artifactId, Array(2_000).fill("needle outside reach"));
    // 2,000 more matching chunks outside the reach: the restricted searches read no more of them,
    // only the extra artifact row each one looks at to decide the reach.
    expect(await rowsRead(own, "needle")).toBeLessThanOrEqual(before.own + 2);
    expect(await rowsRead(key, "needle")).toBeLessThanOrEqual(before.key + 2);
    // Without a restriction the same search reads them all: the measure sees the difference.
    expect(await rowsRead(none, "needle")).toBeGreaterThan(before.none + 1_000);
    const found = value(
      await searchContent(db(), { actor: own, query: "needle", limit: 20, now: LATER }),
    );
    expect(found.items.map((item) => item.artifact.id)).toEqual([mine.artifactId]);
  });
});

/** A bucket that serves `count` objects of `size` characters each and counts what it hands out. */
function fakeBucket(objects: Record<string, string>) {
  const served: string[] = [];
  return {
    served,
    bucket: {
      async get(key: string, options?: { range?: { offset: number; length: number } }) {
        const body = objects[key];
        if (body === undefined) return null;
        const bytes = new TextEncoder().encode(body);
        const sliced = options?.range ? bytes.slice(0, options.range.length) : bytes;
        served.push(key);
        return { arrayBuffer: async () => sliced.buffer };
      },
    } as unknown as R2Bucket,
  };
}

describe("the index job's budgets", () => {
  const MIB = 1024 * 1024;
  const files = (count: number, size: number) =>
    Array.from({ length: count }, (_, i) => ({
      path: `p${String(i).padStart(3, "0")}.md`,
      r2Key: `k${i}`,
      size,
    }));

  it("holds at most the text budget, stops reading once it is spent and marks the rest partial", async () => {
    const refs = files(60, 2 * MIB);
    const { bucket, served } = fakeBucket(
      Object.fromEntries(refs.map((f, i) => [f.r2Key, `${i} ${"word ".repeat((2 * MIB) / 5)}`])),
    );
    const read = await readIndexText(bucket, refs, {
      html: false,
      textBudget: SEARCH_LIMITS.versionTextBytes,
      readBudget: Number.POSITIVE_INFINITY,
      maxReads: Number.POSITIVE_INFINITY,
      maxFiles: SEARCH_LIMITS.filesPerVersion,
    });
    const held = read.files.reduce((n, file) => n + file.text.length, 0);
    expect(held).toBeLessThanOrEqual(SEARCH_LIMITS.versionTextBytes);
    expect(read.bytes).toBe(held);
    expect(read.partial).toBe(true);
    // 512 KiB a file fills the 4 MiB budget in 8 files; the 9th is never fetched.
    expect(served).toHaveLength(SEARCH_LIMITS.versionTextBytes / SEARCH_LIMITS.fileTextBytes);
    expect(read.next).toBeNull();
  });

  it("stops at the job's R2 budget and names where a continuation resumes", async () => {
    const refs = files(10, 2 * MIB);
    const { bucket, served } = fakeBucket(Object.fromEntries(refs.map((f) => [f.r2Key, "a b c"])));
    const read = await readIndexText(bucket, refs, {
      html: false,
      textBudget: SEARCH_LIMITS.versionTextBytes,
      readBudget: SEARCH_LIMITS.jobReadBytes,
      maxReads: SEARCH_LIMITS.jobFiles,
      maxFiles: SEARCH_LIMITS.filesPerVersion,
    });
    expect(served).toHaveLength(4);
    expect(read.readBytes).toBe(SEARCH_LIMITS.jobReadBytes);
    expect(read.next).toBe(4);
    expect(read.partial).toBe(false);
  });

  it("marks the artifact partial when an object is missing from R2", async () => {
    const owner = await teamOwner();
    const published = await publishVersion(owner.id, {
      "index.html": "<p>present words</p>",
      "gone.html": "<p>missing words</p>",
    });
    const [gone] = await db()
      .select({ key: schema.objects.r2Key })
      .from(schema.objects)
      .innerJoin(
        schema.versionFiles,
        and(
          eq(schema.versionFiles.sha256, schema.objects.sha256),
          eq(schema.versionFiles.ownerId, schema.objects.ownerId),
        ),
      )
      .where(
        and(
          eq(schema.versionFiles.versionId, published.versionId),
          eq(schema.versionFiles.path, "gone.html"),
        ),
      );
    await env.ARTIFACTS.delete(gone?.key ?? "");
    await runSearchJobs(published.artifactId);
    const [row] = await db()
      .select({ partial: schema.searchArtifacts.partial })
      .from(schema.searchArtifacts)
      .where(eq(schema.searchArtifacts.artifactId, published.artifactId));
    expect(row).toEqual({ partial: true });
    const hits = value(
      await searchContent(db(), {
        actor: personalActor(owner.id),
        query: "present",
        limit: 5,
        now: LATER,
      }),
    );
    expect(hits.items[0]?.partial).toBe(true);
  });

  it("indexes a site larger than one job reads through continuations, once each", async () => {
    const owner = await teamOwner();
    // Five pages just under the per-file read: four fill one job's 8 MiB, the fifth continues.
    const page = (word: string) => {
      const filler = "<p>common text</p>";
      return `<p>${word}</p>${filler.repeat(Math.floor((2 * 1024 * 1024 - 200) / filler.length))}`;
    };
    const published = await publishVersion(owner.id, {
      "index.html": page("home"),
      ...Object.fromEntries([0, 1, 2, 3].map((i) => [`p${i}.html`, page(`page${i}`)])),
    });
    const outcomes = await runSearchJobs(published.artifactId);
    expect(outcomes).toEqual(["done", "done"]);
    const actor = personalActor(owner.id);
    for (const word of ["home", "page0", "page3"]) {
      const hits = value(await searchContent(db(), { actor, query: word, limit: 5, now: LATER }));
      expect(
        hits.items.map((item) => item.artifact.id),
        word,
      ).toEqual([published.artifactId]);
    }
    const [row] = await db()
      .select({ next: schema.searchArtifacts.nextFile, partial: schema.searchArtifacts.partial })
      .from(schema.searchArtifacts)
      .where(eq(schema.searchArtifacts.artifactId, published.artifactId));
    // Each page's visible text is over the per-file cap, so the artifact is partly indexed.
    expect(row).toEqual({ next: null, partial: true });
    const chunks = async () =>
      (
        await db().all<{ n: number }>(
          sql`select count(*) as n from search_chunks where artifact_id = ${published.artifactId}`,
        )
      )[0]?.n;
    const before = await chunks();
    // The continuation delivered again finds its pass moved on and writes nothing.
    await db()
      .insert(schema.outbox)
      .values({
        topic: "search_index",
        payload: { versionId: published.versionId, from: 4 },
        availableAt: NOW,
        subject: published.artifactId,
      });
    expect(await runSearchJobs(published.artifactId)).toEqual(["done"]);
    expect(await chunks()).toBe(before);
  });
});

describe("the owner column and the limits", () => {
  it("never matches the user's words against the owner column", async () => {
    const owner = await teamOwner();
    const published = await publishVersion(owner.id, { "index.html": "<p>plain text</p>" });
    await runSearchJobs(published.artifactId);
    const actor = personalActor(owner.id);
    expect(
      value(await searchContent(db(), { actor, query: ownerToken(owner.id), limit: 5, now: LATER }))
        .items,
    ).toEqual([]);
    expect(
      value(await searchContent(db(), { actor, query: "plain", limit: 5, now: LATER })).items,
    ).toHaveLength(1);
  });

  it("refuses too many different words and limits searches per owner, whoever acts", async () => {
    const t = await workspace(user);
    await grantPlan(t.id, "team");
    const slug =
      (
        await db()
          .select({ slug: schema.workspaces.slug })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, t.id))
      )[0]?.slug ?? "";
    const { resolveOwnerScope } = await import("../src/workspaces.ts");
    const admin = value(await resolveOwnerScope(db().global, t.admin.id, slug));
    const editor = value(await resolveOwnerScope(db().global, t.editor.id, slug));
    const words = Array.from({ length: SEARCH_LIMITS.queryTerms + 1 }, (_, i) => `w${i}`).join(" ");
    expect(await searchContent(db(), { actor: admin, query: words, limit: 5, now: LATER })).toEqual(
      {
        ok: false,
        code: "invalid_input",
        message: `Search for at most ${SEARCH_LIMITS.queryTerms} different words.`,
      },
    );
    // Each person stays under their own limit; together they reach the owner's.
    const at = LATER + 3_600_000;
    let refused = 0;
    for (let i = 0; i < SEARCH_LIMITS.perOwnerWindow + 10; i++) {
      // A new actor every perWindow searches, so only the owner's counter can refuse.
      const actor = {
        ...(i % 2 === 0 ? admin : editor),
        userId: `u_${Math.floor(i / SEARCH_LIMITS.perWindow)}_${i % 2}`,
      };
      const result = await searchContent(db(), { actor, query: "x", limit: 1, now: at });
      if (!result.ok) {
        expect(result.code).toBe("rate_limited");
        refused++;
      }
    }
    expect(refused).toBe(10);
  }, 60_000);
});

describe("the scans", () => {
  it("read one page of owners a run, resume from a cursor and schedule each due artifact once", async () => {
    // Owners before and after this test's ones may exist; give these an ID that sorts last.
    const owners = [];
    for (let i = 0; i < 120; i++) {
      const id = `zz_scan_${String(i).padStart(3, "0")}_${crypto.randomUUID().slice(0, 8)}`;
      owners.push(id);
    }
    const someone = await teamOwner();
    const published = await publishVersion(someone.id, { "index.html": "<p>scan</p>" });
    await db().delete(schema.outbox).where(eq(schema.outbox.topic, "search_index"));
    for (const id of owners) await grantPlan(id, "team");
    await db().delete(schema.maintenanceCursors);
    // Walk passes until the published artifact's owner was read; every run reads one page.
    let seen = false;
    for (let run = 0; run < 50 && !seen; run++) {
      await scheduleSearchIndexing(db(), LATER);
      const jobs = await db()
        .select()
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.topic, "search_index"),
            eq(schema.outbox.subject, published.artifactId),
          ),
        );
      seen = jobs.length > 0;
      expect(jobs.length).toBeLessThanOrEqual(1);
    }
    expect(seen).toBe(true);
    const [cursor] = await db()
      .select()
      .from(schema.maintenanceCursors)
      .where(eq(schema.maintenanceCursors.name, "search_index_schedule"));
    expect(cursor).toBeDefined();
    // A full pass more never writes a second job for it.
    for (let run = 0; run < 50; run++) await scheduleSearchIndexing(db(), LATER);
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.topic, "search_index"),
          eq(schema.outbox.subject, published.artifactId),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect((await dropLapsedSearchIndexes(db(), LATER)).dropped).toBeGreaterThanOrEqual(0);
  });
});
