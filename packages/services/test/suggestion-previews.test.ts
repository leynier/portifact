// Preview codes of edit suggestions (decision 0027, "Previews"): issued for a stored plan to a
// person who may read the suggestion's thread, redeemed once on the preview host while the
// session, the thread and the artifact still allow it, and pruned with their cached documents.
import { env } from "cloudflare:test";
import { PLANNING_RATE_LIMITS, PREVIEW_CODES, previewHost } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  issuePreviewCode,
  previewKey,
  prunePreviewCodes,
  redeemPreviewCode,
} from "../src/suggestion-previews.ts";
import { db, NOW, session } from "./fixtures.ts";
import {
  CONTENT_DOMAIN,
  codeOf,
  codeRows,
  issue,
  MARKDOWN,
  openArtifact,
  ownerSuggestion,
  person,
  publishFile,
  suggestionWithPlan,
  textOperation,
} from "./suggestion-fixtures.ts";

const regions = () => regionsFromEnv(env);

describe("issuing a preview code", () => {
  it("builds the changed page, stores only the code's hash and redeems it once", async () => {
    const s = await ownerSuggestion();
    const issued = await issue(s);
    const code = codeOf(issued);
    expect(issued.ok && issued.value.state === "ready" && issued.value.expiresAt).toBe(
      NOW + PREVIEW_CODES.ttlMs,
    );
    const [row] = await codeRows(s.artifactId);
    expect(row).toMatchObject({ userId: s.owner.id, sessionId: s.sessionId, threadId: s.threadId });
    expect(row?.codeSha256).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code);

    const document = await redeemPreviewCode(regions(), code, NOW + 1_000);
    expect(document).toContain("The quick brown dog jumps.");
    expect(document).not.toContain("brown cat");
    expect(document).toContain("Content-Security-Policy");
    // One use: the row is spent and the cached document is gone.
    expect(await redeemPreviewCode(regions(), code, NOW + 2_000)).toBeUndefined();
    expect(await env.ARTIFACTS.get(row?.r2Key ?? "")).toBeNull();
  });

  it("previews a subset HTML page and a text document", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    for (const [kind, source, before] of [
      [
        "html",
        "<!doctype html><html><head><title>T</title></head><body><p>Hello there world</p></body></html>",
        "there",
      ],
      ["text", "First line\nSecond line here\n", "Second"],
    ] as const) {
      const { artifactId, versionId } = await publishFile(owner.id, kind, source);
      await openArtifact(artifactId);
      const { plan } = await suggestionWithPlan({
        kind,
        source,
        artifactId,
        versionId,
        ownerId: owner.id,
        authorId: owner.id,
        viewerId: owner.id,
        operations: [textOperation(kind, source, artifactId, before, "Changed")],
      });
      const code = codeOf(await issue({ owner, sessionId, artifactId, plan }));
      const document = await redeemPreviewCode(regions(), code, NOW);
      expect(document).toContain("Changed");
      expect(document).not.toContain(before === "there" ? "Hello there" : "Second line");
    }
  });

  it("answers unavailable with the reasons, and issues nothing, when nothing applies", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const source = "Some **bold** words here.\n";
    const { artifactId, versionId } = await publishFile(owner.id, "markdown", source);
    await openArtifact(artifactId);
    // The selection crosses the bold element: listed, never applied.
    const { plan } = await suggestionWithPlan({
      kind: "markdown",
      source,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: owner.id,
      operations: [textOperation("markdown", source, artifactId, "Some bold", "A")],
    });
    expect(plan.output).toBeNull();
    const result = await issue({ owner, sessionId, artifactId, plan });
    expect(result).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: [plan.listed[0]?.reason] },
    });
    expect(await codeRows(artifactId)).toEqual([]);
  });

  it("answers unavailable when the builder refuses the page's CSS, never the CSS as it came", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const deep = `${"@media screen{".repeat(40)}p{color:red}${"}".repeat(40)}`;
    const source = `<!doctype html><html><head><title>T</title><style>${deep}</style></head><body><p>Hello there world</p></body></html>`;
    const { artifactId, versionId } = await publishFile(owner.id, "html", source);
    await openArtifact(artifactId);
    const { plan } = await suggestionWithPlan({
      kind: "html",
      source,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: owner.id,
      operations: [textOperation("html", source, artifactId, "there", "here")],
    });
    expect(plan.output).not.toBeNull();
    expect(await issue({ owner, sessionId, artifactId, plan })).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["css_too_complex"] },
    });
    expect(await codeRows(artifactId)).toEqual([]);
  });

  it("refuses another person's plan, an expired plan and an unknown digest like a missing one", async () => {
    const s = await ownerSuggestion();
    const other = await person("Other");
    const otherSession = await session(other.id);
    expect(await issue(s, { userId: other.id, sessionId: otherSession })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await issue(s, { now: NOW + 10 * 60_000 })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await issue(s, { digest: "0".repeat(64) })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await issue(s)).toMatchObject({ ok: true });
  });

  it("refuses a service token and a reader who does not see the thread", async () => {
    const s = await ownerSuggestion();
    expect(await issue(s, { userId: "st_token" })).toMatchObject({ ok: false, code: "not_found" });

    // A reader whose scope is the owner's threads and their own does not see another reader's
    // suggestion; the plan they hold for it does not help.
    const owner = await person("Owner");
    const author = await person("Author");
    const reader = await person("Reader");
    const readerSession = await session(reader.id);
    const { artifactId, versionId } = await publishFile(owner.id, "markdown", MARKDOWN);
    await openArtifact(artifactId, { commentVisibility: "owner" });
    await db()
      .insert(schema.artifactReaders)
      .values([
        { artifactId, email: author.email },
        { artifactId, email: reader.email },
      ]);
    const hidden = await suggestionWithPlan({
      kind: "markdown",
      source: MARKDOWN,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: author.id,
      viewerId: reader.id,
      operations: [textOperation("markdown", MARKDOWN, artifactId, "cat", "dog")],
    });
    const asReader = { owner: reader, sessionId: readerSession, artifactId, plan: hidden.plan };
    expect(await issue(asReader)).toMatchObject({ ok: false, code: "not_found" });
    // The same reader sees it once comments are visible to everyone.
    await openArtifact(artifactId, { commentVisibility: "everyone" });
    expect(await issue(asReader)).toMatchObject({ ok: true, value: { state: "ready" } });
  });

  it("refuses a withdrawn or revised suggestion and a version that is no longer current", async () => {
    const withdrawn = await ownerSuggestion();
    await db()
      .update(schema.annotationThreads)
      .set({ suggestionState: "withdrawn", edit: null, editBytes: 0, suggestionRevision: 2 })
      .where(eq(schema.annotationThreads.id, withdrawn.threadId));
    expect(await issue(withdrawn)).toMatchObject({ ok: false, code: "version_conflict" });

    const revised = await ownerSuggestion();
    await db()
      .update(schema.annotationThreads)
      .set({ suggestionRevision: 2 })
      .where(eq(schema.annotationThreads.id, revised.threadId));
    expect(await issue(revised)).toMatchObject({ ok: false, code: "version_conflict" });

    const rejected = await ownerSuggestion();
    await db()
      .update(schema.annotationThreads)
      .set({ suggestionState: "rejected", decidedAt: NOW, state: "resolved" })
      .where(eq(schema.annotationThreads.id, rejected.threadId));
    expect(await issue(rejected)).toMatchObject({ ok: false, code: "version_conflict" });

    const replaced = await ownerSuggestion();
    await publishFile(replaced.owner.id, "markdown", "# Other\n", {
      artifactId: replaced.artifactId,
      versionId: replaced.versionId,
    });
    expect(await issue(replaced)).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("refuses a stored plan whose digest no longer matches what the files and edit give", async () => {
    const s = await ownerSuggestion();
    // A stored plan claiming another rendering title: rebuilt from the stored files, the
    // baseline no longer reproduces and every operation is listed, so the digest differs.
    const [row] = await db()
      .select({ plan: schema.suggestionPlans.plan })
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.digest, s.plan.digest));
    const tampered = JSON.parse(row?.plan ?? "{}") as { output: { options: { title: string } } };
    tampered.output.options.title = "Another title";
    await db()
      .update(schema.suggestionPlans)
      .set({ plan: JSON.stringify(tampered) })
      .where(eq(schema.suggestionPlans.digest, s.plan.digest));
    expect(await issue(s)).toMatchObject({ ok: false, code: "version_conflict" });
  });

  it("refuses suspended, held and archived artifacts", async () => {
    const suspended = await ownerSuggestion();
    await openArtifact(suspended.artifactId, { state: "suspended" });
    expect(await issue(suspended)).toMatchObject({ ok: false });

    const held = await ownerSuggestion();
    await openArtifact(held.artifactId, { state: "suspended" });
    await db()
      .insert(schema.legalHolds)
      .values({
        id: `lh_${crypto.randomUUID()}`,
        artifactId: held.artifactId,
        ownerId: held.owner.id,
        reason: "phishing",
        ground: "test",
      });
    expect(await issue(held)).toMatchObject({ ok: false, code: "forbidden" });

    const archived = await ownerSuggestion();
    await openArtifact(archived.artifactId, {
      state: "archived",
      archivedAt: NOW,
      expiresAt: null,
    });
    expect(await issue(archived)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("counts previews in the planning limits after authorization", async () => {
    const s = await ownerSuggestion();
    // Refused before the limit: nothing counted.
    for (let i = 0; i < PLANNING_RATE_LIMITS.perArtifact.requests + 2; i++) {
      await issue(s, { userId: "st_token" });
    }
    for (let i = 0; i < PLANNING_RATE_LIMITS.perArtifact.requests; i++) {
      // Spend the code each time so the open-code cap never decides.
      const code = codeOf(await issue(s));
      expect(await redeemPreviewCode(regions(), code, NOW)).toBeDefined();
    }
    expect(await issue(s)).toMatchObject({ ok: false, code: "rate_limited" });
    // A new window allows it again.
    expect(await issue(s, { now: NOW + PLANNING_RATE_LIMITS.perArtifact.windowMs })).toMatchObject({
      ok: true,
    });
  });

  it("maps the open-code cap to rate_limited", async () => {
    const s = await ownerSuggestion();
    for (let i = 0; i < PREVIEW_CODES.openPerUser; i++) {
      await db()
        .insert(schema.previewCodes)
        .values({
          codeSha256: i.toString(16).padStart(64, "0").replace(/^0/, "a"),
          userId: s.owner.id,
          sessionId: s.sessionId,
          artifactId: s.artifactId,
          threadId: s.threadId,
          r2Key: previewKey(NOW),
          createdAt: NOW,
          expiresAt: NOW + PREVIEW_CODES.ttlMs,
        });
    }
    const result = await issue(s);
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
    expect(!result.ok && result.message).toBe(
      "Too many previews open. Wait a minute and try again.",
    );
  });
});

describe("what decides a stored plan", () => {
  const MISSING = { ok: false, code: "not_found", message: "Preview not found." };
  const CHANGED = {
    ok: false,
    code: "version_conflict",
    message: "The suggestion or the artifact changed. Review it again.",
  };

  async function rewritePlan(digest: string, change: (plan: Record<string, unknown>) => string) {
    const [row] = await db()
      .select({ plan: schema.suggestionPlans.plan })
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.digest, digest));
    await db()
      .update(schema.suggestionPlans)
      .set({ plan: change(JSON.parse(row?.plan ?? "{}") as Record<string, unknown>) })
      .where(eq(schema.suggestionPlans.digest, digest));
  }

  it("answers a missing plan with one message, also for a draft's plan or an unreadable row", async () => {
    const s = await ownerSuggestion();
    expect(await issue(s, { digest: "0".repeat(64) })).toEqual(MISSING);
    await db()
      .update(schema.suggestionPlans)
      .set({ threadId: null })
      .where(eq(schema.suggestionPlans.digest, s.plan.digest));
    expect(await issue(s)).toEqual(MISSING);

    const unreadable = await ownerSuggestion();
    await rewritePlan(unreadable.plan.digest, () => "not json");
    expect(await issue(unreadable)).toEqual(MISSING);
  });

  it("answers a plan whose thread is a comment like a missing one", async () => {
    const s = await ownerSuggestion();
    const commentId = `th_${crypto.randomUUID()}`;
    await db().insert(schema.annotationThreads).values({
      id: commentId,
      artifactId: s.artifactId,
      versionId: s.versionId,
      ownerId: s.owner.id,
      authorId: s.owner.id,
      target: "{}",
      targetBytes: 2,
      path: "index.md",
      updatedAt: NOW,
    });
    await db()
      .update(schema.suggestionPlans)
      .set({ threadId: commentId })
      .where(eq(schema.suggestionPlans.digest, s.plan.digest));
    expect(await issue(s)).toEqual(MISSING);
  });

  // The row's own `digest` and `kind` are never read (the digest asked for and the artifact's
  // type are); everything the rebuild takes from the row is confirmed by the digest.
  it("trusts nothing a cached row says that the rebuilt plan does not confirm", async () => {
    for (const change of [
      (plan: Record<string, unknown>) => ({
        ...plan,
        binding: { ...(plan.binding as object), fileSha256: "e".repeat(64) },
      }),
      (plan: Record<string, unknown>) => ({
        ...plan,
        binding: { ...(plan.binding as object), subject: "th_other" },
      }),
    ]) {
      const s = await ownerSuggestion();
      await rewritePlan(s.plan.digest, (plan) => JSON.stringify(change(plan)));
      expect(await issue(s)).toEqual(CHANGED);
    }
  });

  it("refuses when a stored file of the version is gone", async () => {
    const noFile = await ownerSuggestion();
    await db()
      .delete(schema.versionFiles)
      .where(
        and(
          eq(schema.versionFiles.versionId, noFile.versionId),
          eq(schema.versionFiles.kind, "published"),
        ),
      );
    expect(await issue(noFile)).toEqual(CHANGED);

    for (const kind of ["rendered", "block_map"] as const) {
      const s = await ownerSuggestion();
      const [entry] = await db()
        .select()
        .from(schema.versionFiles)
        .where(
          and(eq(schema.versionFiles.versionId, s.versionId), eq(schema.versionFiles.kind, kind)),
        );
      await env.ARTIFACTS.delete(`objects/${entry?.ownerId}/${entry?.sha256}`);
      expect(await issue(s), kind).toEqual(CHANGED);
    }
  });

  it("counts the person's planning across artifacts", async () => {
    const s = await ownerSuggestion();
    await db()
      .$client.prepare("insert into rate_limits (key, window_start, count) values (?, ?, ?)")
      .bind(`suggestion-plan:user:${s.owner.id}`, NOW, PLANNING_RATE_LIMITS.perUser.requests)
      .run();
    expect(await issue(s)).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many previews. Wait a moment.",
    });
  });
});

describe("redeeming a preview code", () => {
  it("refuses malformed, unknown and expired codes", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    expect(await redeemPreviewCode(regions(), "short", NOW)).toBeUndefined();
    expect(await redeemPreviewCode(regions(), "A".repeat(43), NOW)).toBeUndefined();
    expect(await redeemPreviewCode(regions(), code, NOW + PREVIEW_CODES.ttlMs)).toBeUndefined();
  });

  it("refuses once the dashboard session ended", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    await db().delete(schema.sessions).where(eq(schema.sessions.id, s.sessionId));
    expect(await redeemPreviewCode(regions(), code, NOW)).toBeUndefined();
    // Spent even so: a later session cannot use it.
    expect(await codeRows(s.artifactId)).toMatchObject([{ redeemedAt: NOW }]);
  });

  it("refuses after the suggestion was withdrawn, access narrowed or the artifact moved", async () => {
    const withdrawn = await ownerSuggestion();
    const first = codeOf(await issue(withdrawn));
    await db()
      .update(schema.annotationThreads)
      .set({ suggestionState: "withdrawn", edit: null, editBytes: 0, suggestionRevision: 2 })
      .where(eq(schema.annotationThreads.id, withdrawn.threadId));
    expect(await redeemPreviewCode(regions(), first, NOW)).toBeUndefined();

    // A reader removed from the list between issue and redemption.
    const owner = await person("Owner");
    const reader = await person("Reader");
    const readerSession = await session(reader.id);
    const { artifactId, versionId } = await publishFile(owner.id, "markdown", MARKDOWN);
    await openArtifact(artifactId, { commentVisibility: "everyone" });
    await db().insert(schema.artifactReaders).values({ artifactId, email: reader.email });
    const { plan } = await suggestionWithPlan({
      kind: "markdown",
      source: MARKDOWN,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: reader.id,
      operations: [textOperation("markdown", MARKDOWN, artifactId, "cat", "dog")],
    });
    const asReader = { owner: reader, sessionId: readerSession, artifactId, plan };
    const narrowed = codeOf(await issue(asReader));
    await db()
      .delete(schema.artifactReaders)
      .where(and(eq(schema.artifactReaders.artifactId, artifactId)));
    expect(await redeemPreviewCode(regions(), narrowed, NOW)).toBeUndefined();

    // The artifact moved to an owner the person does not act for.
    const moved = await ownerSuggestion();
    const third = codeOf(await issue(moved));
    await openArtifact(moved.artifactId, { ownerId: "ws_elsewhere" });
    expect(await redeemPreviewCode(regions(), third, NOW)).toBeUndefined();
  });

  it("refuses after the artifact was suspended or deleted", async () => {
    const suspended = await ownerSuggestion();
    const code = codeOf(await issue(suspended));
    await openArtifact(suspended.artifactId, { state: "suspended" });
    expect(await redeemPreviewCode(regions(), code, NOW)).toBeUndefined();

    const deleted = await ownerSuggestion();
    const gone = codeOf(await issue(deleted));
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, deleted.artifactId));
    expect(await redeemPreviewCode(regions(), gone, NOW)).toBeUndefined();
  });
});

describe("pruning preview codes", () => {
  it("deletes codes and cached documents past the cache's lifetime, and keeps younger ones", async () => {
    const s = await ownerSuggestion();
    codeOf(await issue(s));
    const young = codeOf(await issue(s, { now: NOW + 60_000 }));
    const [oldRow] = (await codeRows(s.artifactId)).filter((row) => row.createdAt === NOW);
    // A document whose row went another way (an account deletion) is found by its key.
    const stray = previewKey(NOW);
    await env.ARTIFACTS.put(stray, "x");

    const pruned = await prunePreviewCodes(db(), env.ARTIFACTS, NOW + PREVIEW_CODES.documentTtlMs);
    expect(pruned).toBeGreaterThanOrEqual(3);
    expect(await env.ARTIFACTS.get(stray)).toBeNull();
    expect(await env.ARTIFACTS.get(oldRow?.r2Key ?? "")).toBeNull();
    const left = await codeRows(s.artifactId);
    expect(left.map((row) => row.createdAt)).toEqual([NOW + 60_000]);
    expect(await env.ARTIFACTS.get(left[0]?.r2Key ?? "")).not.toBeNull();
    expect(await redeemPreviewCode(regions(), young, NOW + 61_000)).toBeDefined();
  });
});
