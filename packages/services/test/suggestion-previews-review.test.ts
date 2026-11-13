// The adversarial review of pull request #264 (decision 0027, the preview origin): each finding's
// reproduction, committed failing before its fix. Findings 1 to 8; finding 9 is the browser suite.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, PLANNING_RATE_LIMITS, PREVIEW_CODES } from "@portifact/contracts";
import {
  aliasBinding,
  globalDb,
  regionalDb,
  regionsFromEnv,
  schema,
  withRequestContext,
} from "@portifact/db";
import { buildPlan } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issuePreviewCode,
  previewKey,
  prunePreviewCodes,
  redeemPreviewCode,
} from "../src/suggestion-previews.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, NOW, session, sha256 } from "./fixtures.ts";
import { raceBeforeStatement } from "./race.ts";
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

/** An EU workspace's HTML artifact with a suggestion and its admin's stored plan for it. */
async function euPreview(existingOwner?: { id: string; email: string }) {
  const owner = existingOwner ?? (await person("EU owner"));
  const sessionId = await session(owner.id);
  const created = await createWorkspace(db().global, {
    slug: `review-${crypto.randomUUID().slice(0, 8)}`,
    name: "EU team",
    adminUserId: owner.id,
    now: NOW,
    region: "eu",
  });
  if (!created.ok) throw new Error(created.message);
  const ws = created.value;
  const r = regions().get("eu");
  const artifactId = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (n) => "abcdefghijklmnopqrstuvwxyz234567"[n % 32],
  ).join("");
  const versionId = `v_${crypto.randomUUID()}`;
  const threadId = `th_${crypto.randomUUID()}`;
  const source =
    "<!doctype html><html><head><title>T</title></head><body><p>The cat sat.</p></body></html>";
  const hash = await sha256(source);
  await r.db.insert(schema.artifacts).values({
    id: artifactId,
    ownerId: ws.id,
    type: "site",
    name: "T",
    state: "active",
    accessMode: "restricted",
    annotations: "open",
    currentVersionId: versionId,
    expiresAt: NOW + 86_400_000,
  });
  await r.db.insert(schema.versions).values({
    id: versionId,
    artifactId,
    number: 1,
    authorId: owner.id,
    entrypoint: "index.html",
    publishedBytes: source.length,
    state: "committed",
    createdAt: NOW,
  });
  const key = `objects/${ws.id}/${hash}`;
  await r.db
    .insert(schema.objects)
    .values({ ownerId: ws.id, sha256: hash, size: source.length, r2Key: key, state: "verified" });
  await env.ARTIFACTS_EU.put(key, source);
  await r.db.insert(schema.versionFiles).values({
    versionId,
    ownerId: ws.id,
    path: "index.html",
    kind: "published",
    sha256: hash,
    size: source.length,
    contentType: "text/html",
  });
  const operations = [textOperation("html", source, artifactId, "cat", "dog")];
  const edit = JSON.stringify({ operations });
  const target = JSON.stringify(operations[0]?.target);
  await r.db.insert(schema.annotationThreads).values({
    id: threadId,
    artifactId,
    versionId,
    ownerId: ws.id,
    authorId: owner.id,
    target,
    targetBytes: target.length,
    path: "index.html",
    updatedAt: NOW,
    kind: "suggestion",
    suggestionState: "pending",
    suggestionRevision: 1,
    edit,
    editBytes: edit.length,
  });
  const plan = await buildPlan({
    binding: {
      artifactId,
      versionId,
      path: "index.html",
      fileSha256: hash,
      renderer: DOCUMENT_RENDERER.label,
      subject: threadId,
      revision: 1,
    },
    people: { submitter: true, acceptor: true },
    kind: "html",
    source,
    operations,
    pageUrl: `https://${artifactId}.portifact.dev/index.html`,
    renderer: DOCUMENT_RENDERER,
  });
  const { newSource: _n, proofs: _p, work: _w, ...exported } = plan;
  await r.db.insert(schema.suggestionPlans).values({
    userId: owner.id,
    digest: plan.digest,
    artifactId,
    threadId,
    plan: JSON.stringify(exported),
    createdAt: NOW,
    expiresAt: NOW + 600_000,
  });
  return { owner, sessionId, artifactId, threadId, plan, ws };
}

/** A default-region handle over `env.DB` whose statements add up the rows D1 says they read. */
function measuring() {
  const seen = { rowsRead: 0, statements: [] as { sql: string; params: unknown[] }[] };
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    params: unknown[],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const real = Reflect.get(target, property, target);
        if (typeof real !== "function") return real;
        if (property === "bind") {
          return (...args: unknown[]) => wrap(real.apply(target, args), sql, args);
        }
        if (["all", "run", "first", "raw"].includes(String(property))) {
          return async (...args: unknown[]) => {
            seen.statements.push({ sql, params });
            const result = await real.apply(target, args);
            const meta = (result as { meta?: { rows_read?: number } } | null)?.meta;
            if (property === "all" || property === "run") seen.rowsRead += meta?.rows_read ?? 0;
            return result;
          };
        }
        return real.bind(target);
      },
    });
  const binding = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql, []);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = regionalDb(aliasBinding(binding, env.DB), globalDb(env.DB));
  return { database, seen };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("finding 1: a session whose account's terms lapsed counts as none", () => {
  it("invalidates a code when its account's terms lapse", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    const [row] = await codeRows(s.artifactId);
    await db()
      .global.update(schema.users)
      .set({ termsVersion: null })
      .where(eq(schema.users.id, s.owner.id));
    expect(await redeemPreviewCode(regions(), code, NOW + 1)).toBeUndefined();
    // Refused after the code was found: the cached document is gone too.
    expect(await env.ARTIFACTS.get(row?.r2Key ?? "")).toBeNull();
  });
});

describe("finding 2: issuing writes only while what it authorized still holds", () => {
  const racedIssue = async (
    change: (s: Awaited<ReturnType<typeof ownerSuggestion>>) => Promise<unknown>,
  ) => {
    const s = await ownerSuggestion();
    const raced = raceBeforeStatement(/insert into "preview_codes"/i, async () => {
      await change(s);
    });
    const result = await issuePreviewCode(raced, env.ARTIFACTS, {
      userId: s.owner.id,
      sessionId: s.sessionId,
      artifactId: s.artifactId,
      digest: s.plan.digest,
      now: NOW,
      contentDomain: CONTENT_DOMAIN,
    });
    return { s, result };
  };

  it("conditions code issuance on the owner it authorized", async () => {
    const other = await person("Other owner");
    const { s, result } = await racedIssue((s) =>
      db()
        .update(schema.artifacts)
        .set({ ownerId: other.id })
        .where(eq(schema.artifacts.id, s.artifactId)),
    );
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await codeRows(s.artifactId)).toEqual([]);
    const listed = await env.ARTIFACTS.list({ prefix: `previews/${NOW}/` });
    expect(listed.objects.filter((o) => o.key.includes(s.artifactId))).toEqual([]);
  });

  it("conditions it on the version planned and the suggestion's revision and state", async () => {
    for (const change of [
      (s: Awaited<ReturnType<typeof ownerSuggestion>>) =>
        db()
          .update(schema.artifacts)
          .set({ currentVersionId: "v_other" })
          .where(eq(schema.artifacts.id, s.artifactId)),
      (s: Awaited<ReturnType<typeof ownerSuggestion>>) =>
        db()
          .update(schema.annotationThreads)
          .set({ suggestionRevision: 2 })
          .where(eq(schema.annotationThreads.id, s.threadId)),
      (s: Awaited<ReturnType<typeof ownerSuggestion>>) =>
        db()
          .update(schema.annotationThreads)
          .set({ suggestionState: "withdrawn", edit: null, editBytes: 0 })
          .where(eq(schema.annotationThreads.id, s.threadId)),
      (s: Awaited<ReturnType<typeof ownerSuggestion>>) =>
        db()
          .update(schema.artifacts)
          .set({ state: "archived", archivedAt: NOW, expiresAt: null })
          .where(eq(schema.artifacts.id, s.artifactId)),
    ]) {
      const { s, result } = await racedIssue(change);
      expect(result).toMatchObject({ ok: false, code: "version_conflict" });
      expect(await codeRows(s.artifactId)).toEqual([]);
    }
  });
});

describe("finding 3: an issued preview dies with its version and its suggestion's revision", () => {
  it("invalidates a code when the suggestion revision changes", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    await db()
      .update(schema.annotationThreads)
      .set({ suggestionRevision: 2 })
      .where(eq(schema.annotationThreads.id, s.threadId));
    expect(await redeemPreviewCode(regions(), code, NOW + 1)).toBeUndefined();
  });

  it("invalidates the owner's code after a new version", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    const [row] = await codeRows(s.artifactId);
    await publishFile(s.owner.id, "markdown", "# Replacement\n", {
      artifactId: s.artifactId,
      versionId: s.versionId,
    });
    expect(await redeemPreviewCode(regions(), code, NOW + 1)).toBeUndefined();
    expect(await env.ARTIFACTS.get(row?.r2Key ?? "")).toBeNull();
  });

  it("refuses a cached document without the binding it was issued for", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    const [row] = await codeRows(s.artifactId);
    // The same document, written again without its metadata.
    const document = await (await env.ARTIFACTS.get(row?.r2Key ?? ""))?.text();
    await env.ARTIFACTS.put(row?.r2Key ?? "", document ?? "");
    expect(await redeemPreviewCode(regions(), code, NOW + 1)).toBeUndefined();
  });
});

describe("finding 4: ten open codes per person in each region", () => {
  it("caps a region's open codes at ten and gives another region its own ten", async () => {
    const first = await ownerSuggestion();
    // A second artifact of the same person, so the per-artifact planning window never decides.
    const { artifactId, versionId } = await publishFile(first.owner.id, "markdown", MARKDOWN);
    await openArtifact(artifactId);
    const { plan } = await suggestionWithPlan({
      kind: "markdown",
      source: MARKDOWN,
      artifactId,
      versionId,
      ownerId: first.owner.id,
      authorId: first.owner.id,
      viewerId: first.owner.id,
      operations: [textOperation("markdown", MARKDOWN, artifactId, "cat", "dog")],
    });
    const second = { ...first, artifactId, plan };
    for (let i = 0; i < 6; i++) codeOf(await issue(first));
    for (let i = 0; i < 4; i++) codeOf(await issue(second));
    expect(await issue(second)).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many previews open. Wait a minute and try again.",
    });

    const eu = await euPreview(first.owner);
    for (let i = 0; i < 10; i++) {
      codeOf(
        await issuePreviewCode(regions().get("eu").db, env.ARTIFACTS_EU, {
          userId: first.owner.id,
          sessionId: eu.sessionId,
          artifactId: eu.artifactId,
          digest: eu.plan.digest,
          now: NOW,
          contentDomain: CONTENT_DOMAIN,
        }),
      );
    }
    const open = await Promise.all(
      regions()
        .all()
        .map((r) =>
          r.db
            .select()
            .from(schema.previewCodes)
            .where(eq(schema.previewCodes.userId, first.owner.id)),
        ),
    );
    expect(open.map((rows) => rows.length)).toEqual([10, 10]);
  });
});

describe("finding 5: the prune reads only what it deletes", () => {
  it("bounds rows read by the expiry scan even when no code is due", async () => {
    const s = await ownerSuggestion();
    await db().delete(schema.previewCodes);
    // No account foreign key: these model 200 people's one outstanding code each.
    for (let i = 0; i < 200; i++) {
      await db()
        .insert(schema.previewCodes)
        .values({
          codeSha256: i.toString(16).padStart(64, "0"),
          userId: `user_${i}`,
          sessionId: s.sessionId,
          artifactId: s.artifactId,
          threadId: s.threadId,
          r2Key: previewKey(NOW),
          createdAt: NOW,
          expiresAt: NOW + PREVIEW_CODES.ttlMs,
        });
    }
    const { database, seen } = measuring();
    const done = await prunePreviewCodes(database, env.ARTIFACTS, NOW);
    expect(done.rows).toBe(0);
    expect(seen.rowsRead).toBeLessThanOrEqual(1);
    // The statement reaches due rows through the expiry index, never by scanning the table.
    const statement = seen.statements.find((st) => /preview_codes/.test(st.sql));
    const plan = await env.DB.prepare(`explain query plan ${statement?.sql}`)
      .bind(...(statement?.params ?? []))
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toContain("preview_codes_expires_idx");
    expect(details).not.toMatch(/SCAN preview_codes(?! USING)/);
  });
});

describe("finding 6: cached documents go within minutes, and a backlog is worked off", () => {
  it("deletes an unused preview's document once it is two minutes old", async () => {
    expect(PREVIEW_CODES.documentTtlMs).toBe(2 * 60_000);
    const s = await ownerSuggestion();
    codeOf(await issue(s));
    const [row] = await codeRows(s.artifactId);
    await prunePreviewCodes(db(), env.ARTIFACTS, NOW + PREVIEW_CODES.documentTtlMs - 1);
    expect(await env.ARTIFACTS.head(row?.r2Key ?? "")).not.toBeNull();
    await prunePreviewCodes(db(), env.ARTIFACTS, NOW + PREVIEW_CODES.documentTtlMs);
    expect(await env.ARTIFACTS.head(row?.r2Key ?? "")).toBeNull();
    expect(await codeRows(s.artifactId)).toEqual([]);
  });

  it("works off more than one page of old documents in one run", async () => {
    const keys = Array.from({ length: 25 }, () => previewKey(NOW - 1));
    await Promise.all(keys.map((key) => env.ARTIFACTS.put(key, "<p>old private preview</p>")));
    const done = await prunePreviewCodes(db(), env.ARTIFACTS, NOW + PREVIEW_CODES.documentTtlMs, {
      pageSize: 10,
      pages: 3,
    });
    expect(done).toMatchObject({ documents: 25, behind: false });
    const remaining = await Promise.all(keys.map((key) => env.ARTIFACTS.head(key)));
    expect(remaining.filter(Boolean)).toHaveLength(0);
  });

  it("says once, with a count, when a run ends at its cap with more to do", async () => {
    const keys = Array.from({ length: 25 }, () => previewKey(NOW - 2));
    await Promise.all(keys.map((key) => env.ARTIFACTS.put(key, "<p>old</p>")));
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const done = await prunePreviewCodes(
      db(),
      env.ARTIFACTS,
      NOW + PREVIEW_CODES.documentTtlMs,
      { pageSize: 10, pages: 2 },
      "default",
    );
    expect(done).toMatchObject({ documents: 20, behind: true });
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      { event: "preview_prune_behind", region: "default", documents: 20 },
    ]);
    // The next run finishes what was left.
    const next = await prunePreviewCodes(db(), env.ARTIFACTS, NOW + PREVIEW_CODES.documentTtlMs);
    expect(next.documents).toBeGreaterThanOrEqual(5);
    expect(next.behind).toBe(false);
  });
});

describe("finding 7: the guards the suite missed", () => {
  it("does not spend an already redeemed code again", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    expect(await redeemPreviewCode(regions(), code, NOW)).toBeDefined();
    expect(await redeemPreviewCode(regions(), code, NOW + 1)).toBeUndefined();
    expect((await codeRows(s.artifactId))[0]?.redeemedAt).toBe(NOW);
  });

  it("gives the document to one of two concurrent redemptions", async () => {
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    const answers = await Promise.all([
      redeemPreviewCode(regions(), code, NOW),
      redeemPreviewCode(regions(), code, NOW),
    ]);
    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
  });

  it("does not count a forbidden cached plan against the planning budget", async () => {
    const s = await ownerSuggestion();
    await openArtifact(s.artifactId, { state: "archived", archivedAt: NOW, expiresAt: null });
    expect(await issue(s)).toMatchObject({ ok: false, code: "not_found" });
    const counted = await db()
      .global.select()
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.key, `suggestion-plan:user:${s.owner.id}`));
    expect(counted).toEqual([]);
    expect(PLANNING_RATE_LIMITS.perUser.requests).toBeGreaterThan(0);
  });
});

describe("finding 8: the session's own sign-in decides workspace sign-in policies", () => {
  it("redeems a valid workspace session under its sign-in policy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const s = await euPreview();
    await db()
      .global.insert(schema.ownerPlans)
      .values({
        ownerId: s.ws.id,
        plan: "enterprise",
        seats: 5,
        grantedBy: "test",
        updatedAt: NOW,
      });
    await db()
      .global.update(schema.workspaces)
      .set({ policy: { ...DEFAULT_POLICY, sessionMaxHours: 24 } })
      .where(eq(schema.workspaces.id, s.ws.id));
    const context = {
      kind: "request" as const,
      ip: "192.0.2.10",
      credential: {
        kind: "session" as const,
        userId: s.owner.id,
        signedInAt: NOW,
        method: { kind: "code" as const },
      },
    };
    const issueRegions = regionsFromEnv(withRequestContext(env, context));
    const code = codeOf(
      await issuePreviewCode(issueRegions.get("eu").db, env.ARTIFACTS_EU, {
        userId: s.owner.id,
        sessionId: s.sessionId,
        artifactId: s.artifactId,
        digest: s.plan.digest,
        now: NOW,
        contentDomain: CONTENT_DOMAIN,
      }),
    );
    // The preview host builds a fresh request context: the credential comes from the session.
    const redeemRegions = regionsFromEnv(
      withRequestContext(env, { kind: "request", ip: "192.0.2.10" }),
    );
    expect(await redeemPreviewCode(redeemRegions, code, NOW)).toContain("The dog sat.");
  });

  it("still refuses a session older than the workspace allows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const s = await euPreview();
    await db()
      .global.insert(schema.ownerPlans)
      .values({
        ownerId: s.ws.id,
        plan: "enterprise",
        seats: 5,
        grantedBy: "test",
        updatedAt: NOW,
      });
    const context = {
      kind: "request" as const,
      ip: "192.0.2.10",
      credential: {
        kind: "session" as const,
        userId: s.owner.id,
        signedInAt: NOW,
        method: { kind: "code" as const },
      },
    };
    const code = codeOf(
      await issuePreviewCode(
        regionsFromEnv(withRequestContext(env, context)).get("eu").db,
        env.ARTIFACTS_EU,
        {
          userId: s.owner.id,
          sessionId: s.sessionId,
          artifactId: s.artifactId,
          digest: s.plan.digest,
          now: NOW,
          contentDomain: CONTENT_DOMAIN,
        },
      ),
    );
    // The policy now allows sessions of an hour; this session signed in 30 days ago.
    await db()
      .global.update(schema.workspaces)
      .set({ policy: { ...DEFAULT_POLICY, sessionMaxHours: 1 } })
      .where(eq(schema.workspaces.id, s.ws.id));
    await db()
      .global.update(schema.sessions)
      .set({ createdAt: new Date(NOW - 30 * 86_400_000) })
      .where(eq(schema.sessions.id, s.sessionId));
    const redeemRegions = regionsFromEnv(
      withRequestContext(env, { kind: "request", ip: "192.0.2.10" }),
    );
    expect(await redeemPreviewCode(redeemRegions, code, NOW)).toBeUndefined();
  });
});
