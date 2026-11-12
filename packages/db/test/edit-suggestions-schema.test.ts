// Storage of edit suggestions (decision 0027): the suggestion columns of `annotation_threads` and
// their triggers, the change list, drafts, the plan cache, acceptance attempts and claims, and
// preview codes, with the annotation usage they count in and the cascades that remove them.
import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";
import { TABLE_HOMES } from "../src/table-homes.ts";

const db = () => createDb(env.DB);
const NOW = Date.UTC(2026, 10, 12);
const OWNER = "u_suggest_owner";
const ARTIFACT = "sugg3stion";
const DIGEST = "a".repeat(64);
const EDIT = JSON.stringify({ operations: [{ kind: "text", after: "fox" }] });
const bytesOf = (text: string) => new TextEncoder().encode(text).length;

async function rejects(statement: Promise<unknown>, pattern: RegExp) {
  const error = await statement.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "the statement should have been rejected").toBeInstanceOf(Error);
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join("\n")).toMatch(pattern);
}

type ThreadValues = typeof schema.annotationThreads.$inferInsert;

function thread(id: string, values: Partial<ThreadValues> = {}) {
  return db()
    .insert(schema.annotationThreads)
    .values({
      id,
      artifactId: ARTIFACT,
      versionId: "v1",
      ownerId: OWNER,
      authorId: "u_author",
      target: "{}",
      targetBytes: 30,
      path: "index.html",
      updatedAt: NOW,
      ...values,
    });
}

const suggestion = (id: string, values: Partial<ThreadValues> = {}) =>
  thread(id, {
    kind: "suggestion",
    suggestionState: "pending",
    edit: EDIT,
    editBytes: bytesOf(EDIT),
    ...values,
  });

const setThread = (id: string, values: Partial<ThreadValues>) =>
  db().update(schema.annotationThreads).set(values).where(eq(schema.annotationThreads.id, id));

async function usageBytes(owner = OWNER) {
  const [row] = await db()
    .select({ bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, owner));
  return row?.bytes;
}

function item(id: string, values: Partial<typeof schema.changeItems.$inferInsert> = {}) {
  const envelope = values.envelope ?? '{"format":1}';
  const proof = values.proof === undefined ? null : values.proof;
  return db()
    .insert(schema.changeItems)
    .values({
      id,
      artifactId: ARTIFACT,
      ownerId: OWNER,
      origin: "suggestion",
      versionId: "v1",
      path: "index.md",
      envelope,
      proof,
      bytes: bytesOf(envelope) + (proof === null ? 0 : bytesOf(proof)),
      reason: "spans_nodes",
      ...values,
    });
}

/** Inserts `count` open items at once, as an acceptance batch would. */
function openItems(count: number, prefix = "bulk") {
  return env.DB.prepare(
    `insert into change_items (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason)
     with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
     select ? || i, ?, ?, 'suggestion', 'v1', 'index.md', '{}', 2, 'overlap' from n`,
  )
    .bind(count, prefix, ARTIFACT, OWNER)
    .run();
}

const TABLES = [
  "preview_codes",
  "acceptance_claims",
  "acceptance_attempts",
  "suggestion_plans",
  "edit_drafts",
  "change_items",
  "annotation_messages",
  "annotation_threads",
  "annotation_usage",
  "artifacts",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DELETE FROM ${table}`);
  await db()
    .insert(schema.artifacts)
    .values([
      { id: ARTIFACT, ownerId: OWNER, type: "markdown", name: "Plan" },
      { id: "other0000a", ownerId: OWNER, type: "markdown", name: "Other" },
    ]);
});

describe("suggestion threads", () => {
  it("keeps comments free of every suggestion column", async () => {
    await thread("c1");
    const [row] = await db()
      .select()
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.id, "c1"));
    expect(row).toMatchObject({ kind: "comment", suggestionState: null, edit: null, editBytes: 0 });
    await rejects(thread("c2", { suggestionState: "pending" }), /annotation_threads_suggestion/);
    await rejects(thread("c3", { edit: EDIT, editBytes: bytesOf(EDIT) }), /suggestion/);
    await rejects(thread("c4", { decidedAt: NOW }), /annotation_threads_suggestion/);
    await rejects(thread("c5", { suggestionRevision: 1 }), /annotation_threads_suggestion/);
    await rejects(thread("c6", { originTarget: "{}" }), /annotation_threads_suggestion/);
    // A comment cannot turn into a suggestion afterwards either.
    await rejects(setThread("c1", { suggestionState: "pending" }), /suggestion/);
    // Ordinary thread writes still pass the triggers.
    await setThread("c1", { state: "resolved", resolvedAt: NOW, revision: 2 });
  });

  it("refuses an unknown kind or state", async () => {
    await rejects(
      env.DB.prepare(
        "insert into annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, updated_at, kind) values ('k', ?, 'v1', ?, 'u', '{}', 2, 'p', 1, 'note')",
      )
        .bind(ARTIFACT, OWNER)
        .run(),
      /annotation_threads_suggestion/,
    );
    await rejects(
      env.DB.prepare(
        "insert into annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, updated_at, kind, suggestion_state, edit, edit_bytes) values ('s', ?, 'v1', ?, 'u', '{}', 2, 'p', 1, 'suggestion', 'maybe', '{}', 2)",
      )
        .bind(ARTIFACT, OWNER)
        .run(),
      /annotation_threads_suggestion/,
    );
    await rejects(suggestion("s2", { suggestionState: null }), /annotation_threads_suggestion/);
  });

  it("stores a pending suggestion whose edit bytes are its edit's UTF-8 size", async () => {
    await suggestion("s1");
    const unicode = JSON.stringify({ after: "zoë ✓" });
    await suggestion("s2", { edit: unicode, editBytes: bytesOf(unicode) });
    await rejects(suggestion("s3", { editBytes: bytesOf(EDIT) - 1 }), /suggestion/);
    await rejects(suggestion("s4", { edit: null, editBytes: 0 }), /suggestion/);
    // At most 32 KiB, the edit model's limit.
    const largest = "x".repeat(32_768);
    await suggestion("s5", { edit: largest, editBytes: 32_768 });
    await rejects(
      suggestion("s6", { edit: `${largest}x`, editBytes: 32_769 }),
      /annotation_threads_suggestion/,
    );
  });

  it("ties attempts, reasons, decisions and results to the states they belong to", async () => {
    await rejects(suggestion("a1", { suggestionState: "applying" }), /suggestion/);
    await suggestion("a2", { suggestionState: "applying", attemptId: "aa_1" });
    await rejects(suggestion("a3", { attemptId: "aa_1" }), /suggestion/);
    await suggestion("a4", { attemptReason: "version_conflict" });
    await rejects(
      suggestion("a5", { suggestionState: "outdated", attemptReason: "failed" }),
      /suggestion/,
    );
    await rejects(suggestion("a6", { suggestionState: "accepted" }), /suggestion/);
    await suggestion("a7", {
      suggestionState: "accepted",
      decidedAt: NOW,
      decidedBy: "u_owner",
      resultVersionId: "v2",
      state: "resolved",
    });
    // An account deletion forgets who decided, never when.
    await suggestion("a8", { suggestionState: "rejected", decidedAt: NOW, decidedBy: null });
    await rejects(suggestion("a9", { decidedBy: "u_owner" }), /suggestion/);
    await rejects(
      suggestion("a10", { suggestionState: "rejected", decidedAt: NOW, resultVersionId: "v2" }),
      /suggestion/,
    );
    await rejects(suggestion("a11", { editProofs: "[]", edit: null }), /suggestion/);
    await suggestion("a12", { editProofs: "[]" });
  });

  it("never resolves an undecided suggestion's thread", async () => {
    await rejects(suggestion("r1", { state: "resolved" }), /annotation_threads_suggestion/);
    await suggestion("r2");
    await rejects(setThread("r2", { state: "resolved", resolvedAt: NOW }), /suggestion/);
    await setThread("r2", { suggestionState: "applying", attemptId: "aa_1" });
    await rejects(setThread("r2", { state: "resolved", resolvedAt: NOW }), /suggestion/);
    await setThread("r2", {
      suggestionState: "accepted",
      attemptId: null,
      decidedAt: NOW,
      state: "resolved",
      resolvedAt: NOW,
    });
  });

  it("keeps a submitted edit and a final decision immutable", async () => {
    await suggestion("i1");
    const other = JSON.stringify({ operations: [] });
    await rejects(
      setThread("i1", { edit: other, editBytes: bytesOf(other) }),
      /annotation_threads_suggestion_immutable/,
    );
    await rejects(setThread("i1", { kind: "comment" }), /suggestion/);
    // Carrying it moves its proofs and keeps where it was made.
    await setThread("i1", {
      editProofs: "[]",
      originVersionId: "v1",
      originTarget: "{}",
      versionId: "v2",
      suggestionRevision: 1,
    });
    // A withdrawal clears the edit, and nothing brings one back.
    await setThread("i1", {
      suggestionState: "withdrawn",
      edit: null,
      editBytes: 0,
      editProofs: null,
    });
    await rejects(
      setThread("i1", { suggestionState: "pending", edit: EDIT, editBytes: bytesOf(EDIT) }),
      /annotation_threads_suggestion_immutable/,
    );
    await suggestion("i2", { suggestionState: "rejected", decidedAt: NOW });
    await rejects(setThread("i2", { suggestionState: "pending", decidedAt: null }), /immutable/);
    await suggestion("i3", { suggestionState: "outdated" });
    await setThread("i3", { suggestionState: "rejected", decidedAt: NOW });
  });

  it("counts the edit in the owner's annotation bytes until it is withdrawn or deleted", async () => {
    await suggestion("u1");
    expect(await usageBytes()).toBe(30 + bytesOf(EDIT));
    await thread("u2");
    expect(await usageBytes()).toBe(60 + bytesOf(EDIT));
    await setThread("u1", { suggestionState: "withdrawn", edit: null, editBytes: 0 });
    expect(await usageBytes()).toBe(60);
    await suggestion("u3");
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "u3"));
    expect(await usageBytes()).toBe(60);
  });

  it("moves the edit's bytes with the thread to a new owner", async () => {
    await suggestion("o1");
    await setThread("o1", { ownerId: "ws_target" });
    expect(await usageBytes()).toBe(0);
    expect(await usageBytes("ws_target")).toBe(30 + bytesOf(EDIT));
  });

  it("refuses a suggestion past the owner's annotation bytes limit", async () => {
    await thread("l1");
    await db()
      .update(schema.annotationUsage)
      .set({ bytesLimit: 60 + bytesOf(EDIT) - 1 })
      .where(eq(schema.annotationUsage.ownerId, OWNER));
    await rejects(suggestion("l2"), /annotation_usage_bytes_limit/);
    await db()
      .update(schema.annotationUsage)
      .set({ bytesLimit: 60 + bytesOf(EDIT) })
      .where(eq(schema.annotationUsage.ownerId, OWNER));
    await suggestion("l2");
  });
});

describe("change items", () => {
  it("counts envelope and proof bytes, and frees them when the item goes", async () => {
    await item("ci_1", { proof: '{"unit":"utf16"}' });
    expect(await usageBytes()).toBe(bytesOf('{"format":1}') + bytesOf('{"unit":"utf16"}'));
    await item("ci_2");
    await db().delete(schema.changeItems).where(eq(schema.changeItems.id, "ci_1"));
    expect(await usageBytes()).toBe(bytesOf('{"format":1}'));
  });

  it("refuses wrong bytes, oversized envelopes and malformed reasons", async () => {
    await rejects(item("b1", { bytes: 1 }), /change_items_bytes/);
    const big = `"${"x".repeat(16_383)}"`;
    await rejects(item("b2", { envelope: big }), /change_items_bytes/);
    await item("b3", { envelope: `"${"x".repeat(16_382)}"` });
    await rejects(item("b4", { proof: `"${"x".repeat(16_383)}"` }), /change_items_bytes/);
    await rejects(item("b5", { reason: "Not A Token" }), /change_items_reason/);
    await rejects(item("b6", { reason: "" }), /change_items_reason/);
    await rejects(item("b7", { reason: "x".repeat(65) }), /change_items_reason/);
    await item("b8", { reason: "x".repeat(64) });
  });

  it("keeps a draft's items without a thread and closing fields consistent with the state", async () => {
    await thread("t1");
    await rejects(item("d1", { origin: "draft", threadId: "t1" }), /change_items_draft_thread/);
    await item("d2", { origin: "draft" });
    await rejects(item("d3", { state: "applied" }), /change_items_closing/);
    await item("d4", { state: "applied", closedAt: NOW, closedBy: "u_owner" });
    await item("d5", { state: "dismissed", closedAt: NOW, closedBy: null });
    await rejects(
      item("d6", { state: "closed_by_version", closedAt: NOW, closedBy: "u_owner" }),
      /change_items_closing/,
    );
    await item("d7", { state: "closed_by_version", closedAt: NOW, closedVersionId: "v2" });
    await rejects(item("d8", { closedAt: NOW }), /change_items_closing/);
    await rejects(item("d9", { revision: 0 }), /change_items_revision/);
  });

  it("never changes an item's envelope, proof, artifact or origin", async () => {
    await item("m1");
    const set = (values: Partial<typeof schema.changeItems.$inferInsert>) =>
      db().update(schema.changeItems).set(values).where(eq(schema.changeItems.id, "m1"));
    await rejects(set({ envelope: '{"format":2}' }), /change_items_immutable/);
    await rejects(set({ proof: "{}", bytes: bytesOf('{"format":1}') + 2 }), /immutable/);
    await rejects(set({ artifactId: "other0000a" }), /change_items_immutable/);
    await rejects(set({ origin: "draft" }), /change_items_immutable/);
    await set({ state: "applied", closedAt: NOW, closedBy: "u_owner", revision: 2 });
  });

  it("stays with the artifact when its thread is deleted, and goes with the artifact", async () => {
    await suggestion("t1");
    await item("g1", { threadId: "t1" });
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "t1"));
    const [kept] = await db().select().from(schema.changeItems);
    expect(kept?.threadId).toBeNull();
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await db().select().from(schema.changeItems)).toEqual([]);
    expect(await usageBytes()).toBe(0);
  });

  it("moves the item's bytes with a transfer", async () => {
    await item("w1");
    await db()
      .update(schema.changeItems)
      .set({ ownerId: "ws_target" })
      .where(eq(schema.changeItems.artifactId, ARTIFACT));
    expect(await usageBytes()).toBe(0);
    expect(await usageBytes("ws_target")).toBe(bytesOf('{"format":1}'));
  });

  it("refuses the 1,001st open item of an artifact, and reopening past the limit", async () => {
    await openItems(999);
    await item("last");
    await rejects(item("over"), /change_items_open_limit/);
    await rejects(openItems(1, "batch"), /change_items_open_limit/);
    // Closed items and other artifacts do not count.
    await item("closed", { state: "dismissed", closedAt: NOW });
    await item("elsewhere", { artifactId: "other0000a" });
    const reopen = (id: string) =>
      db()
        .update(schema.changeItems)
        .set({ state: "open", closedAt: null, closedBy: null })
        .where(eq(schema.changeItems.id, id));
    await rejects(reopen("closed"), /change_items_open_limit/);
    await db()
      .update(schema.changeItems)
      .set({ state: "applied", closedAt: NOW })
      .where(eq(schema.changeItems.id, "last"));
    await reopen("closed");
    // An update that keeps an open item open is not a reopening.
    await db()
      .update(schema.changeItems)
      .set({ revision: 2 })
      .where(eq(schema.changeItems.id, "closed"));
    const [open] = await db()
      .select({ n: sql<number>`count(*)` })
      .from(schema.changeItems)
      .where(sql`${schema.changeItems.artifactId} = ${ARTIFACT} and state = 'open'`);
    expect(open?.n).toBe(1_000);
  });
});

describe("drafts", () => {
  const draft = (artifactId: string, userId = "u_editor", edit = EDIT) =>
    db()
      .insert(schema.editDrafts)
      .values({
        artifactId,
        userId,
        ownerId: OWNER,
        baseVersionId: "v1",
        edit,
        editBytes: bytesOf(edit),
        updatedAt: NOW,
      });

  it("keeps one draft per person and artifact, at most 20 per person", async () => {
    await draft(ARTIFACT);
    await rejects(draft(ARTIFACT), /UNIQUE constraint failed/);
    await draft(ARTIFACT, "u_other");
    const ids = Array.from({ length: 19 }, (_, i) => `drafts${String(i).padStart(4, "0")}`);
    // One row per statement: D1 binds at most 100 parameters.
    for (const id of ids.concat("drafts0019")) {
      await db().insert(schema.artifacts).values({ id, ownerId: OWNER, type: "text", name: id });
    }
    for (const id of ids) await draft(id);
    await rejects(draft("drafts0019"), /edit_drafts_limit/);
    await draft("drafts0019", "u_other");
  });

  it("checks the edit's bytes, at most 128 KiB, and goes with the artifact", async () => {
    await rejects(
      db().insert(schema.editDrafts).values({
        artifactId: ARTIFACT,
        userId: "u",
        ownerId: OWNER,
        baseVersionId: "v1",
        edit: EDIT,
        editBytes: 3,
        updatedAt: NOW,
      }),
      /edit_drafts_bytes/,
    );
    await rejects(draft(ARTIFACT, "u", "x".repeat(131_073)), /edit_drafts_bytes/);
    await draft(ARTIFACT, "u", "x".repeat(131_072));
    await rejects(
      db().update(schema.editDrafts).set({ revision: 0 }).where(eq(schema.editDrafts.userId, "u")),
      /edit_drafts_revision/,
    );
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await db().select().from(schema.editDrafts)).toEqual([]);
  });
});

describe("plans, attempts, claims and preview codes", () => {
  it("caches plans per person by digest and drops them with their thread", async () => {
    await suggestion("p1");
    const plan = (digest: string, userId = "u_owner", threadId: string | null = "p1") =>
      db()
        .insert(schema.suggestionPlans)
        .values({ userId, digest, artifactId: ARTIFACT, threadId, plan: "{}", expiresAt: NOW });
    await plan(DIGEST);
    await plan(DIGEST, "u_other");
    await rejects(plan(DIGEST), /UNIQUE constraint failed/);
    await rejects(plan("A".repeat(64)), /suggestion_plans_digest/);
    await rejects(plan("a".repeat(63)), /suggestion_plans_digest/);
    await plan("b".repeat(64), "u_owner", null);
    await rejects(
      db()
        .insert(schema.suggestionPlans)
        .values({
          userId: "u",
          digest: DIGEST,
          artifactId: ARTIFACT,
          plan: "x".repeat(524_289),
          expiresAt: NOW,
        }),
      /suggestion_plans_bytes/,
    );
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "p1"));
    expect(await db().select().from(schema.suggestionPlans)).toHaveLength(1);
  });

  it("keeps an attempt's reason with its end, and its claim with the attempt", async () => {
    await suggestion("t1");
    const attempt = (id: string, values: Partial<typeof schema.acceptanceAttempts.$inferInsert>) =>
      db()
        .insert(schema.acceptanceAttempts)
        .values({
          id,
          artifactId: ARTIFACT,
          ownerId: OWNER,
          origin: "suggestion",
          threadId: "t1",
          userId: "u_owner",
          digest: DIGEST,
          baseVersionId: "v1",
          updatedAt: NOW,
          ...values,
        });
    await attempt("aa_1", {});
    await rejects(attempt("aa_2", { reason: "failed" }), /acceptance_attempts_reason/);
    await rejects(attempt("aa_3", { state: "ended" }), /acceptance_attempts_reason/);
    await attempt("aa_4", { state: "ended", reason: "quota_exceeded" });
    await rejects(attempt("aa_5", { digest: "z".repeat(64) }), /acceptance_attempts_digest/);
    await rejects(attempt("aa_6", { deliveries: -1 }), /acceptance_attempts_deliveries/);

    const claim = (runToken: string) =>
      db()
        .insert(schema.acceptanceClaims)
        .values({ attemptId: "aa_1", runToken, artifactId: ARTIFACT });
    await claim("r1");
    // A duplicate delivery cannot take the claim a second time.
    await rejects(claim("r2"), /UNIQUE constraint failed/);
    await rejects(
      db()
        .insert(schema.acceptanceClaims)
        .values({ attemptId: "aa_missing", runToken: "r", artifactId: ARTIFACT }),
      /FOREIGN KEY constraint failed/,
    );

    // The thread's deletion keeps the attempt for the cleanup of its pending version.
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "t1"));
    const attempts = await db().select().from(schema.acceptanceAttempts);
    expect(attempts.map((row) => row.threadId)).toEqual([null, null]);
    await db().delete(schema.acceptanceAttempts).where(eq(schema.acceptanceAttempts.id, "aa_1"));
    expect(await db().select().from(schema.acceptanceClaims)).toEqual([]);
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await db().select().from(schema.acceptanceAttempts)).toEqual([]);
  });

  it("holds at most 10 open preview codes per person, counting only live ones", async () => {
    const code = (n: number, values: Partial<typeof schema.previewCodes.$inferInsert> = {}) =>
      db()
        .insert(schema.previewCodes)
        .values({
          codeSha256: n.toString(16).padStart(64, "0"),
          userId: "u_viewer",
          sessionId: "s1",
          artifactId: ARTIFACT,
          r2Key: `previews/${n}`,
          createdAt: NOW,
          expiresAt: NOW + 60_000,
          ...values,
        });
    for (let n = 0; n < 10; n++) await code(n);
    await rejects(code(10), /preview_codes_limit/);
    await code(11, { userId: "u_else" });
    // A redeemed code and an expired one free their place.
    await db()
      .update(schema.previewCodes)
      .set({ redeemedAt: NOW })
      .where(eq(schema.previewCodes.codeSha256, (0).toString(16).padStart(64, "0")));
    await code(12);
    await rejects(code(13), /preview_codes_limit/);
    await code(14, { createdAt: NOW + 60_000, expiresAt: NOW + 120_000 });
    await rejects(code(15, { r2Key: "objects/x", userId: "u_new" }), /preview_codes_key/);
    await rejects(code(16, { expiresAt: NOW, userId: "u_new" }), /preview_codes_expiry/);
    await rejects(code(17, { codeSha256: "short", userId: "u_new" }), /preview_codes_code/);
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, ARTIFACT));
    expect(await db().select().from(schema.previewCodes)).toEqual([]);
  });

  it("drops a thread's preview codes with the thread", async () => {
    await suggestion("t1");
    await db()
      .insert(schema.previewCodes)
      .values({
        codeSha256: DIGEST,
        userId: "u",
        sessionId: "s",
        artifactId: ARTIFACT,
        threadId: "t1",
        r2Key: "previews/x",
        createdAt: NOW,
        expiresAt: NOW + 1,
      });
    await db().delete(schema.annotationThreads).where(eq(schema.annotationThreads.id, "t1"));
    expect(await db().select().from(schema.previewCodes)).toEqual([]);
  });
});

describe("the migration", () => {
  it("creates every trigger, the rebuilt usage triggers included", async () => {
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'trigger' order by name",
    ).all<{ name: string }>();
    const names = results.map((row) => row.name);
    for (const name of [
      "annotation_threads_suggestion_insert",
      "annotation_threads_suggestion_update",
      "annotation_threads_suggestion_immutable",
      "annotation_threads_usage_insert",
      "annotation_threads_usage_delete",
      "annotation_threads_usage_owner",
      "annotation_threads_usage_edit",
      "change_items_usage_insert",
      "change_items_usage_delete",
      "change_items_usage_owner",
      "change_items_immutable",
      "change_items_open_limit_insert",
      "change_items_open_limit_reopen",
      "edit_drafts_limit",
      "preview_codes_limit",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("homes every new table in its owner's region", () => {
    for (const table of [
      "change_items",
      "edit_drafts",
      "suggestion_plans",
      "acceptance_attempts",
      "acceptance_claims",
      "preview_codes",
    ] as const) {
      expect(TABLE_HOMES[table]).toBe("regional");
    }
  });
});
