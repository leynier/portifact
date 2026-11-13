// The second adversarial review of the suggestion services (decision 0027), probes A1 to A29:
// each case places its competing write at the statement or batch it races, or measures the rows
// or bytes a scan or job reads, and fails when the guard or bound it names is removed.
import { env } from "cloudflare:test";
import { PLAN_LIMITS, SUGGESTION_LIMITS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { eraseAuthorFromThread, replyToAnnotationThread } from "../src/annotations.ts";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { acceptSuggestion, publishDraft } from "../src/suggestion-accept.ts";
import { retentionSweeps, sweepPage } from "../src/suggestion-maintenance.ts";
import { planDraft, planSuggestion, readCapped, storedPage } from "../src/suggestion-plans.ts";
import { runChangeListCheck, runSuggestionCarry } from "../src/suggestion-versions.ts";
import { rejectSuggestion, submitSuggestion, withdrawSuggestion } from "../src/suggestions.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith } from "./race.ts";
import {
  attempts,
  DOC,
  DOMAIN,
  humanCheck,
  items,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  republish,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion, workspace } from "./version-support.ts";

function the<T>(x: T | null | undefined): T {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
}
async function draft(owner: { id: string }, ownerId = owner.id) {
  const doc = await publishDoc(owner.id, { ownerId });
  const edit = JSON.stringify({ operations: [textOp(doc, DOC, "Second", "Next")] });
  await db().insert(schema.editDrafts).values({
    artifactId: doc.artifactId,
    userId: owner.id,
    ownerId,
    baseVersionId: doc.versionId,
    edit,
    editBytes: edit.length,
    updatedAt: NOW,
  });
  return {
    doc,
    input: { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10, contentDomain: DOMAIN },
  };
}
it("A1: planning a draft must lose to removal of the author owner-side role", async () => {
  const team = await workspace(() => user("Member"));
  const s = await draft(team.editor, team.id);
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    await db()
      .global.delete(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, team.id),
          eq(schema.workspaceMembers.userId, team.editor.id),
        ),
      );
  });
  const result = await planDraft(h, env.ARTIFACTS, s.input);
  expect.soft(result).toMatchObject({ ok: false });
  expect(
    await db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId)),
  ).toHaveLength(0);
});
it("A2: draft retention must not scan an irrelevant prefix of publishing drafts", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id);
  for (let i = 0; i < 300; i += 5)
    await db()
      .insert(schema.editDrafts)
      .values(
        Array.from({ length: 5 }, (_, j) => ({
          artifactId: doc.artifactId,
          userId: `u${i + j}`,
          ownerId: owner.id,
          baseVersionId: doc.versionId,
          edit: "{}",
          editBytes: 2,
          attemptId: "running",
          updatedAt: NOW - 40 * DAY,
        })),
      );
  const sweep = the(retentionSweeps(NOW).find((x) => x.name === "suggestion_drafts_retention"));
  const q = new SQLiteAsyncDialect().sqlToQuery(sweepPage(sweep, null, 20));
  const result = await env.DB.prepare(q.sql)
    .bind(...q.params)
    .all();
  const plan = await env.DB.prepare(`explain query plan ${q.sql}`)
    .bind(...q.params)
    .all();
  expect(result.results).toEqual([]);
  expect(result.meta.rows_read, JSON.stringify(plan.results)).toBeLessThanOrEqual(20);
});
async function euSetup({ listed = false, start = true } = {}) {
  const regions = regionsFromEnv(env),
    e = { db: regions.get("eu").db, bucket: env.ARTIFACTS_EU };
  const admin = await user("Admin"),
    editor = await user("Editor");
  const ws = value(
    await createWorkspace(regions.global, {
      slug: `r2-${crypto.randomUUID().slice(0, 8)}`,
      name: "EU",
      adminUserId: admin.id,
      region: "eu",
      now: NOW,
    }),
  );
  await grantPlan(ws.id, "team", { seats: 10 });
  await regions.global
    .insert(schema.workspaceMembers)
    .values({ workspaceId: ws.id, userId: editor.id, role: "editor", updatedAt: NOW });
  const hash = await sha256(DOC);
  const prepared = value(
    await preparePublish(e.db, {
      userId: editor.id,
      targetOwnerId: ws.id,
      type: "markdown",
      name: "Versions",
      entrypoint: "index.md",
      baseVersionId: null,
      files: [
        {
          path: "index.md",
          kind: "published",
          sha256: hash,
          size: DOC.length,
          contentType: "text/markdown",
        },
      ],
      now: NOW,
    }),
  );
  await e.bucket.put(`objects/${ws.id}/${hash}`, DOC);
  const doc = value(
    await commitPublish(e.db, e.bucket, {
      userId: editor.id,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  await e.db
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = {
    userId: editor.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const view = value(
    await submitSuggestion(e.db, {
      ...input,
      versionId: doc.versionId,
      edit: {
        operations: [
          textOp(
            { type: "markdown", path: "index.md" },
            DOC,
            listed ? "A linked" : "Second",
            listed ? "One linked" : "Next",
          ),
        ],
      },
      body: "Fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: view.id };
  const plan = value(await planSuggestion(e.db, e.bucket, params));
  if (start) value(await acceptSuggestion(e.db, e.bucket, { ...params, digest: plan.digest }));
  return { e, regions, ws, editor, view, doc, params, plan };
}
it.each([
  ["suggestion", "demoted"],
  ["suggestion", "removed"],
  ["suggestion", "workspace-deleted"],
  ["draft", "demoted"],
  ["draft", "removed"],
] as const)(
  "A3: EU %s commit rereads the role after its render IO, change=%s",
  async (origin, change) => {
    const s = await euSetup({ start: origin === "suggestion" });
    if (origin === "draft") {
      const edit = JSON.stringify({
        operations: [textOp({ type: "markdown", path: "index.md" }, DOC, "Second", "Next")],
      });
      await s.e.db.insert(schema.editDrafts).values({
        artifactId: s.doc.artifactId,
        userId: s.editor.id,
        ownerId: s.ws.id,
        baseVersionId: s.doc.versionId,
        edit,
        editBytes: edit.length,
        updatedAt: NOW,
      });
      const plan = value(
        await planDraft(s.e.db, s.e.bucket, {
          userId: s.editor.id,
          artifactId: s.doc.artifactId,
          now: NOW + 10,
          contentDomain: DOMAIN,
        }),
      );
      value(
        await publishDraft(s.e.db, s.e.bucket, {
          userId: s.editor.id,
          artifactId: s.doc.artifactId,
          now: NOW + 10,
          contentDomain: DOMAIN,
          digest: plan.digest,
        }),
      );
    }
    let fired = false;
    const bucket = new Proxy(s.e.bucket, {
      get(target: R2Bucket, key) {
        if (key === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            // The rendered page's put is inside commitPublish, after its authorization and reads.
            const meta = args[2]?.httpMetadata;
            if (
              !fired &&
              meta &&
              typeof meta === "object" &&
              "contentType" in meta &&
              String(meta.contentType).includes("text/html")
            ) {
              fired = true;
              const member = and(
                eq(schema.workspaceMembers.workspaceId, s.ws.id),
                eq(schema.workspaceMembers.userId, s.editor.id),
              );
              if (change === "demoted")
                await s.regions.global
                  .update(schema.workspaceMembers)
                  .set({ role: "member" })
                  .where(member);
              if (change === "removed")
                await s.regions.global.delete(schema.workspaceMembers).where(member);
              if (change === "workspace-deleted") {
                const { deleteWorkspace } = await import("../src/workspaces.ts");
                value(await deleteWorkspace(s.regions, { workspaceId: s.ws.id, now: NOW + 1500 }));
              }
            }
            return target.put(...args);
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const topic = origin === "suggestion" ? "suggestion_accept" : "draft_publish";
    const [job] = await jobsOf(topic, s.doc.artifactId, s.e.db);
    await runJob(s.e.db, bucket, { id: the(job).id, topic }, NOW + 2000, JOB_DEPS);
    expect(fired).toBe(true);
    const [t] = await s.e.db
      .select()
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.id, s.view.id));
    expect(t?.suggestionState).not.toBe("accepted");
    const committed = await s.e.db
      .select()
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.artifactId, s.doc.artifactId),
          eq(schema.versions.state, "committed"),
        ),
      );
    expect(committed).toHaveLength(1);
    if (change !== "workspace-deleted") {
      expect(await attempts(s.doc.artifactId, s.e.db)).toMatchObject([
        { state: "ended", reason: "revoked" },
      ]);
      const [usage] = await s.e.db
        .select()
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, s.ws.id));
      expect(usage?.openUploads ?? 0).toBe(0);
    }
  },
);
it("A4: actual carry R2 reads stay within the documented per-run byte budget", async () => {
  const owner = await user("Owner");
  // Five files, each eligible by size. A group reads both old and new pages.
  const pad = " ".repeat(900_000),
    before = PAGE + pad,
    after = PAGE.replace("Title", "Other") + pad;
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.html`, before]));
  const first = await publishVersion(owner.id, files, { entrypoint: "0.html" });
  const next = await publishVersion(
    owner.id,
    Object.fromEntries(Object.keys(files).map((k) => [k, after])),
    { base: first, entrypoint: "0.html", now: NOW + 1000 },
  );
  for (const path of Object.keys(files)) {
    const edit = JSON.stringify({
      operations: [textOp({ type: "site", path }, PAGE, "Second", "Next")],
    });
    await db()
      .insert(schema.annotationThreads)
      .values({
        id: `cost-${path}-${first.artifactId}`,
        artifactId: first.artifactId,
        ownerId: owner.id,
        authorId: owner.id,
        versionId: first.versionId,
        path,
        target: "{}",
        targetBytes: 2,
        kind: "suggestion",
        suggestionState: "pending",
        suggestionRevision: 1,
        edit,
        editBytes: edit.length,
        updatedAt: NOW,
      });
  }
  let bytes = 0;
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "get")
        return async (k: string) => {
          const o = await target.get(k);
          bytes += o?.size ?? 0;
          return o;
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await runSuggestionCarry(
    db(),
    bucket,
    { subject: first.artifactId, payload: { versionId: next.versionId } } as never,
    NOW + 2000,
    DOMAIN,
  );
  expect(bytes).toBeLessThanOrEqual(SUGGESTION_LIMITS.jobReadBytes);
  // The jobs that follow, each within the budget, carry every suggestion exactly once.
  const perJob = [bytes];
  for (let round = 0; round < 6; round++) {
    const waiting = await jobsOf("suggestion_carry", first.artifactId);
    if (waiting.length === 0) break;
    for (const job of waiting) {
      bytes = 0;
      await runJob(db(), bucket, { id: job.id, topic: "suggestion_carry" }, NOW + 3000, JOB_DEPS);
      perJob.push(bytes);
    }
  }
  expect(await jobsOf("suggestion_carry", first.artifactId)).toEqual([]);
  expect(perJob.every((read) => read <= SUGGESTION_LIMITS.jobReadBytes)).toBe(true);
  expect(perJob.filter((read) => read > 0).length).toBeGreaterThanOrEqual(2);
  for (const path of Object.keys(files)) {
    // No proofs were planned for these rows: each is outdated, once (one revision step).
    expect(await thread(`cost-${path}-${first.artifactId}`)).toMatchObject({
      suggestionState: "outdated",
      suggestionRevision: 2,
    });
  }
});
it.each(["html", "markdown", "text"] as const)(
  "A5: BOM %s exact source and derived hashes",
  async (kind) => {
    const { publishFile, openArtifact, textOperation } = await import("./suggestion-fixtures.ts");
    const owner = await user("Owner"),
      source = kind === "html" ? PAGE : DOC,
      path = kind === "html" ? "index.html" : kind === "markdown" ? "index.md" : "notes.txt";
    const d = await publishFile(owner.id, kind, `\ufeff${source}`);
    await openArtifact(d.artifactId);
    const input = {
      userId: owner.id,
      artifactId: d.artifactId,
      now: NOW + 10,
      contentDomain: DOMAIN,
    };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: d.versionId,
        edit: { operations: [textOperation(kind, source, d.artifactId, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
    expect(plan.output).not.toBeNull();
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: t.id,
        digest: plan.digest,
      }),
    );
    await runJobs("suggestion_accept", d.artifactId);
    const [a] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, d.artifactId));
    const fs = await db()
      .select()
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, the(the(a).currentVersionId)));
    expect(fs.find((f) => f.kind === "published" && f.path === path)?.sha256).toBe(
      the(plan.output).sha256,
    );
    expect(fs.find((f) => f.kind === "rendered")?.sha256 ?? null).toBe(
      the(plan.output).renderedSha256,
    );
    expect(fs.find((f) => f.kind === "block_map")?.sha256 ?? null).toBe(
      the(plan.output).blockMapSha256,
    );
  },
);
it.each(["rejected", "withdrawn"] as const)(
  "A6: preview refused after %s by the services",
  async (state) => {
    const { ownerSuggestion, issue, codeOf } = await import("./suggestion-fixtures.ts");
    const { redeemPreviewCode } = await import("../src/suggestion-previews.ts");
    const s = await ownerSuggestion();
    const code = codeOf(await issue(s));
    const input = {
      userId: s.owner.id,
      artifactId: s.artifactId,
      now: NOW + 10,
      threadId: s.threadId,
      revision: 1,
    };
    value(await (state === "rejected" ? rejectSuggestion : withdrawSuggestion)(db(), input));
    expect(await redeemPreviewCode(regionsFromEnv(env), code, NOW + 20)).toBeUndefined();
  },
);
it.each([false, true])(
  "A7: erasure/final claim both orders, commit-first=%s",
  async (commitFirst) => {
    const owner = await user("Owner"),
      author = await user("Author"),
      doc = await publishDoc(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "public", commentVisibility: "everyone" })
      .where(eq(schema.artifacts.id, doc.artifactId));
    const input = { userId: author.id, artifactId: doc.artifactId, now: NOW + 10 };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    value(
      await replyToAnnotationThread(db(), {
        ...input,
        userId: owner.id,
        threadId: t.id,
        body: "Keep",
        humanCheck,
      }),
    );
    const params = { ...input, userId: owner.id, threadId: t.id, contentDomain: DOMAIN };
    const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
    const erase = () =>
      eraseAuthorFromThread(db(), { authorId: author.id, threadId: t.id, now: NOW + 100 }).then(
        () => {},
      );
    if (commitFirst) {
      await runJobs("suggestion_accept", doc.artifactId);
      await erase();
    } else {
      const raced = raceBeforeBatchWith(/insert into "acceptance_claims"/i, erase);
      await runJobs("suggestion_accept", doc.artifactId, NOW + 2000, raced);
    }
    expect(await thread(t.id)).toMatchObject(
      commitFirst ? { suggestionState: "accepted" } : { suggestionState: "withdrawn", edit: null },
    );
    const versions = await db()
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.artifactId, doc.artifactId), eq(schema.versions.state, "committed")),
      );
    expect(versions).toHaveLength(commitFirst ? 2 : 1);
  },
);
it("A8: a reader removed from a listed group loses the live plan scope", async () => {
  const team = await workspace(() => user("Member"));
  await grantPlan(team.id, "team", { seats: 10 });
  const reader = await user("Reader"),
    author = await user("Author");
  await db()
    .global.insert(schema.workspaceMembers)
    .values({ workspaceId: team.id, userId: reader.id, role: "member", updatedAt: NOW });
  const doc = await publishDoc(team.editor.id, { ownerId: team.id });
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "owner" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const gid = `wg_${crypto.randomUUID()}`;
  await db()
    .global.insert(schema.workspaceGroups)
    .values({ id: gid, workspaceId: team.id, name: "Readers", createdAt: NOW, updatedAt: NOW });
  await db()
    .global.insert(schema.workspaceGroupMembers)
    .values({
      id: `wgm_${crypto.randomUUID()}`,
      workspaceId: team.id,
      groupId: gid,
      userId: reader.id,
      createdAt: NOW,
    });
  await db()
    .insert(schema.artifactGroups)
    .values({ artifactId: doc.artifactId, groupId: gid, commentVisibility: "all", createdAt: NOW });
  const t = value(
    await submitSuggestion(db(), {
      userId: author.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "private words")] },
      body: "Private",
      humanCheck,
    }),
  );
  const input = {
    userId: reader.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    threadId: t.id,
    contentDomain: DOMAIN,
  };
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    await db()
      .global.delete(schema.workspaceGroupMembers)
      .where(
        and(
          eq(schema.workspaceGroupMembers.groupId, gid),
          eq(schema.workspaceGroupMembers.userId, reader.id),
        ),
      );
  });
  expect
    .soft(await planSuggestion(h, env.ARTIFACTS, input))
    .toMatchObject({ ok: false, code: "not_found" });
  expect(await planSuggestion(db(), env.ARTIFACTS, input)).toMatchObject({
    ok: false,
    code: "not_found",
  });
});
it("A9: refused authorization counts nothing and exhausted artifact/owner windows read nothing", async () => {
  const owner = await user("Owner"),
    stranger = await user("Stranger"),
    doc = await publishDoc(owner.id);
  const t = value(
    await submitSuggestion(db(), {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const input = {
    userId: owner.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    threadId: t.id,
    contentDomain: DOMAIN,
    digest: "a".repeat(64),
  };
  let reads = 0;
  const b = new Proxy(env.ARTIFACTS, {
    get(target, p) {
      if (p === "get")
        return (...a: Parameters<R2Bucket["get"]>) => {
          reads++;
          return target.get(...a);
        };
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const keys = [
    `suggestion-plan:user:${owner.id}`,
    `suggestion-plan:artifact:${doc.artifactId}`,
    `suggestion_accept:owner:${owner.id}`,
  ];
  expect(await acceptSuggestion(db(), b, { ...input, userId: stranger.id })).toMatchObject({
    ok: false,
  });
  expect(
    await db()
      .select()
      .from(schema.rateLimits)
      .where(
        sql`${schema.rateLimits.key} in (${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )})`,
      ),
  ).toEqual([]);
  for (const key of keys.slice(1)) {
    const _window = key.includes("suggestion_accept") ? 86_400_000 : 60_000;
    await db()
      .global.insert(schema.rateLimits)
      .values({ key, windowStart: NOW, count: 1000 })
      .onConflictDoUpdate({
        target: schema.rateLimits.key,
        set: { count: 1000, windowStart: NOW },
      });
    expect(await acceptSuggestion(db(), b, input)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(reads).toBe(0);
    await db().global.delete(schema.rateLimits).where(eq(schema.rateLimits.key, key));
  }
});
it("A10: readCapped stops a mismatched stream at the cap and accepts the boundary", async () => {
  for (const length of [15, 16, 17]) {
    let _cancelled = false;
    const bucket = {
      get: async () => ({
        size: 16,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(length));
            controller.close();
          },
          cancel() {
            _cancelled = true;
          },
        }),
      }),
    } as unknown as R2Bucket;
    const result = await readCapped(bucket, "x", 16);
    expect(result).toEqual(length > 16 ? "too_large" : new Uint8Array(length));
  }
});
async function authorApplying() {
  const owner = await user("Owner"),
    author = await user("Author"),
    doc = await publishDoc(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = { userId: author.id, artifactId: doc.artifactId, now: NOW + 10 };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Unpublished")] },
      body: "Fix",
      humanCheck,
    }),
  );
  value(
    await replyToAnnotationThread(db(), {
      ...input,
      userId: owner.id,
      threadId: t.id,
      body: "Keep",
      humanCheck,
    }),
  );
  const params = { ...input, userId: owner.id, threadId: t.id, contentDomain: DOMAIN };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  return { owner, author, doc, t };
}
it.each([false, true])(
  "A12: tombstone restore and deferred hold release erase applying edits, held=%s",
  async (held) => {
    const s = await authorApplying(),
      regions = regionsFromEnv(env);
    const { applyTombstones } = await import("../src/backups.ts");
    const { advanceAccountDeletion } = await import("../src/account-data.ts");
    const { suspendArtifact } = await import("../src/moderation.ts");
    const { placeLegalHold, releaseLegalHold, runHoldRelease } = await import(
      "../src/legal-holds.ts"
    );
    if (held) {
      value(
        await suspendArtifact(db(), {
          artifactId: s.doc.artifactId,
          reason: "spam",
          now: NOW + 50,
        }),
      );
      value(
        await placeLegalHold(db(), {
          artifactId: s.doc.artifactId,
          ground: "court order",
          releaseAt: null,
          now: NOW + 50,
        }),
      );
    }
    await applyTombstones(
      regions,
      [{ kind: "account", id: s.author.id, deletedAt: NOW + 60 }],
      NOW + 70,
    );
    let state = "pending";
    for (let i = 0; i < 4 && state === "pending"; i++)
      state = await advanceAccountDeletion(regions, s.author.id, NOW + 80 + i);
    expect(state).toBe("finished");
    if (held) {
      expect((await thread(s.t.id))?.suggestionState).toBe("applying");
      await releaseLegalHold(db(), { artifactId: s.doc.artifactId, now: NOW + 100 });
      await runHoldRelease(db(), undefined, s.doc.artifactId, NOW + 110);
    }
    await runJobs("suggestion_accept", s.doc.artifactId, NOW + 2000);
    expect(await thread(s.t.id)).toMatchObject({
      suggestionState: "withdrawn",
      edit: null,
      editBytes: 0,
    });
  },
);
it.each(["archive", "version", "revision"] as const)(
  "A13: a draft plan loses its %s condition before the batch",
  async (change) => {
    const owner = await user("Owner"),
      s = await draft(owner);
    const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
      if (change === "archive")
        await db()
          .update(schema.artifacts)
          .set({ state: "archived", archivedAt: NOW })
          .where(eq(schema.artifacts.id, s.doc.artifactId));
      if (change === "version") await republish(owner.id, s.doc, `${DOC}\nExtra.`);
      if (change === "revision")
        await db()
          .update(schema.editDrafts)
          .set({ revision: 2 })
          .where(eq(schema.editDrafts.artifactId, s.doc.artifactId));
    });
    expect(await planDraft(h, env.ARTIFACTS, s.input)).toMatchObject({ ok: false });
    expect(
      await db()
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId)),
    ).toHaveLength(0);
  },
);
it("A14: a suggestion plan loses to an acceptance that starts before its batch", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id);
  const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW, contentDomain: DOMAIN };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: t.id },
    plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  });
  expect(await planSuggestion(h, env.ARTIFACTS, params)).toMatchObject({ ok: false });
});
it("A15: a retention cursor seeks past a large equal-time prefix", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    time = NOW - 40 * DAY;
  for (let i = 0; i < 300; i += 5)
    await db()
      .insert(schema.acceptanceAttempts)
      .values(
        Array.from({ length: 5 }, (_, j) => ({
          id: `tie-${doc.artifactId}-${i + j}`,
          artifactId: doc.artifactId,
          ownerId: owner.id,
          origin: "draft" as const,
          userId: owner.id,
          digest: "a".repeat(64),
          baseVersionId: doc.versionId,
          state: "ended" as const,
          reason: "failed" as const,
          createdAt: time,
          updatedAt: time,
        })),
      );
  const last = await env.DB.prepare(
    "select max(id) as id from acceptance_attempts where artifact_id = ?",
  )
    .bind(doc.artifactId)
    .first<{ id: string }>();
  const sweep = the(retentionSweeps(NOW).find((x) => x.name === "suggestion_attempts_retention"));
  const q = new SQLiteAsyncDialect().sqlToQuery(sweepPage(sweep, [time, the(last).id], 20));
  const result = await env.DB.prepare(q.sql)
    .bind(...q.params)
    .all();
  expect(result.results).toEqual([]);
  expect(result.meta.rows_read).toBeLessThanOrEqual(20);
});

it.each([false, true])(
  "A16: EU start rechecks role after planning reads, listed=%s",
  async (listed) => {
    const s = await euSetup({ listed, start: false });
    let fired = false;
    const bucket = new Proxy(s.e.bucket, {
      get(target, key) {
        if (key === "get")
          return async (k: string) => {
            const r = await target.get(k);
            if (!fired) {
              fired = true;
              await s.regions.global
                .delete(schema.workspaceMembers)
                .where(
                  and(
                    eq(schema.workspaceMembers.workspaceId, s.ws.id),
                    eq(schema.workspaceMembers.userId, s.editor.id),
                  ),
                );
            }
            return r;
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(
      await acceptSuggestion(s.e.db, bucket, { ...s.params, digest: s.plan.digest }),
    ).toMatchObject({ ok: false });
    expect(fired).toBe(true);
    expect(
      await s.e.db
        .select()
        .from(schema.acceptanceAttempts)
        .where(eq(schema.acceptanceAttempts.artifactId, s.doc.artifactId)),
    ).toEqual([]);
  },
);

it.each(["mode", "reader"] as const)("A17: plan loses to access %s revocation", async (change) => {
  const { updateAccess } = await import("../src/access.ts");
  const owner = await user("Owner"),
    reader = await user("Reader"),
    author = await user("Author"),
    doc = await publishDoc(owner.id);
  value(
    await updateAccess(db(), {
      userId: owner.id,
      artifactId: doc.artifactId,
      change: { mode: "public", commentVisibility: "everyone" },
      now: NOW,
    }),
  );
  const t = value(
    await submitSuggestion(db(), {
      userId: author.id,
      artifactId: doc.artifactId,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
      now: NOW,
    }),
  );
  if (change === "reader")
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        change: { mode: "restricted", addReaders: [reader.email] },
        now: NOW + 1,
      }),
    );
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        change: change === "mode" ? { mode: "restricted" } : { removeReaders: [reader.email] },
        now: NOW + 15,
      }),
    );
  });
  expect(
    await planSuggestion(h, env.ARTIFACTS, {
      userId: reader.id,
      artifactId: doc.artifactId,
      threadId: t.id,
      now: NOW + 10,
      contentDomain: DOMAIN,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, doc.artifactId)),
  ).toEqual([]);
});
it("A18: a renderer version change after confirmation ends the attempt without a publication", async () => {
  const { DOCUMENT_RENDERER } = await import("@portifact/render");
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10, contentDomain: DOMAIN };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: t.id },
    p = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: p.digest }));
  const renderer = DOCUMENT_RENDERER as { label: string },
    label = renderer.label;
  try {
    renderer.label = "portifact-render@next";
    await runJobs("suggestion_accept", doc.artifactId);
  } finally {
    renderer.label = label;
  }
  expect((await attempts(doc.artifactId))[0]).toMatchObject({
    state: "ended",
    reason: "plan_changed",
  });
  expect(await thread(t.id)).toMatchObject({ suggestionState: "pending" });
  expect(
    await db()
      .select()
      .from(schema.versions)
      .where(
        and(eq(schema.versions.artifactId, doc.artifactId), eq(schema.versions.state, "committed")),
      ),
  ).toHaveLength(1);
});

it("A19b: an account deletion releases the prepared upload of the acceptance it ends", async () => {
  const { applyTombstones } = await import("../src/backups.ts");
  const { advanceAccountDeletion } = await import("../src/account-data.ts");
  const s = await authorApplying();
  const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
  const broken = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "put")
        return async () => {
          throw new Error("r2-unavailable");
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(
    runJob(db(), broken, { id: the(job).id, topic: "suggestion_accept" }, NOW + 2000, JOB_DEPS),
  ).rejects.toThrow("r2-unavailable");
  const usage = async () =>
    (
      await db()
        .select()
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, s.owner.id))
    )[0]?.openUploads;
  expect(await usage()).toBe(1);
  const regions = regionsFromEnv(env);
  await applyTombstones(
    regions,
    [{ kind: "account", id: s.author.id, deletedAt: NOW + 2500 }],
    NOW + 2600,
  );
  let state = "pending";
  for (let i = 0; i < 4 && state === "pending"; i++) {
    state = await advanceAccountDeletion(regions, s.author.id, NOW + 2700 + i);
  }
  expect(state).toBe("finished");
  expect((await attempts(s.doc.artifactId))[0]).toMatchObject({
    state: "ended",
    reason: "revoked",
  });
  expect(await thread(s.t.id)).toMatchObject({ suggestionState: "withdrawn", edit: null });
  expect(await usage()).toBe(0);
});

it("A19: erasure releases the prepared upload immediately, including without another delivery", async () => {
  const { expireAcceptAttempts } = await import("../src/suggestion-maintenance.ts");
  const s = await authorApplying(),
    [job] = await jobsOf("suggestion_accept", s.doc.artifactId),
    message = { id: the(job).id, topic: "suggestion_accept" as const };
  const broken = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "put")
        return async () => {
          throw new Error("r2-unavailable");
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(runJob(db(), broken, message, NOW + 2000, JOB_DEPS)).rejects.toThrow(
    "r2-unavailable",
  );
  const usage = async () =>
    (
      await db()
        .select()
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, s.owner.id))
    )[0]?.openUploads;
  expect(await usage()).toBe(1);
  await eraseAuthorFromThread(db(), { authorId: s.author.id, threadId: s.t.id, now: NOW + 3000 });
  expect((await attempts(s.doc.artifactId))[0]).toMatchObject({
    state: "ended",
    reason: "revoked",
  });
  expect(await thread(s.t.id)).toMatchObject({ suggestionState: "withdrawn", edit: null });
  expect.soft(await usage()).toBe(0);
  // The ended attempt is not the recovery scan's any more, and nothing waits for a delivery.
  await expireAcceptAttempts(db(), NOW + SUGGESTION_LIMITS.attemptMs + 4000);
  expect((await attempts(s.doc.artifactId))[0]).toMatchObject({
    state: "ended",
    reason: "revoked",
  });
  expect.soft(await usage()).toBe(0);
  await runJob(db(), env.ARTIFACTS, message, NOW + 5000, JOB_DEPS);
  expect(await usage()).toBe(0);
});

it.each(["sha256", "size", "renderedSha256", "blockMapSha256"] as const)(
  "A20: final publish refuses a mismatched output %s",
  async (field) => {
    const { annotationParts } = await import("../src/annotations.ts");
    const { suggestionPlanOf } = await import("../src/suggestion-plans.ts");
    const { publishFromPlan } = await import("../src/suggestion-accept.ts");
    const { bothSides } = await import("@portifact/db");
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      input = {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        contentDomain: DOMAIN,
      };
    const view = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const params = { ...input, threadId: view.id },
      plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
    const [attempt] = await attempts(doc.artifactId),
      loaded = value(await annotationParts.authorize(db(), input, "moderate"));
    const built = value(
      await suggestionPlanOf(db(), env.ARTIFACTS, {
        artifact: loaded.artifact,
        thread: the(await thread(view.id)),
        acceptor: true,
        contentDomain: DOMAIN,
      }),
    );
    Object.assign(the(built.plan.output), {
      [field]: field === "size" ? the(built.plan.output).size + 1 : "0".repeat(64),
    });
    expect(
      await publishFromPlan(db(), env.ARTIFACTS, {
        attempt: the(attempt),
        loaded,
        built,
        artifact: loaded.artifact,
        w: the(bothSides(db())),
        holds: sql`1`,
        shared: true,
        token: crypto.randomUUID(),
        now: NOW + 2000,
      }),
    ).toBe("done");
    expect((await attempts(doc.artifactId))[0]).toMatchObject({
      state: "ended",
      reason: "plan_changed",
    });
    expect(
      await db()
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.artifactId, doc.artifactId),
            eq(schema.versions.state, "committed"),
          ),
        ),
    ).toHaveLength(1);
  },
);

it("A21: oversized manifest source and rendering cause no R2 get for those objects", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id, { type: "site", body: PAGE + " ".repeat(1_100_000) });
  const t = value(
    await submitSuggestion(db(), {
      userId: owner.id,
      artifactId: doc.artifactId,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, PAGE, "Second", "Next")] },
      body: "Fix",
      humanCheck,
      now: NOW,
    }),
  );
  let gets = 0;
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "get")
        return (...args: Parameters<R2Bucket["get"]>) => {
          gets++;
          return target.get(...args);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const plan = value(
    await planSuggestion(db(), bucket, {
      userId: owner.id,
      artifactId: doc.artifactId,
      threadId: t.id,
      now: NOW + 10,
      contentDomain: DOMAIN,
    }),
  );
  expect(plan.listed[0]?.reason).toBe("too_large");
  expect(gets).toBe(0);
  const md = await publishDoc(owner.id),
    [artifact] = await db()
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, md.artifactId));
  await db()
    .update(schema.versionFiles)
    .set({ size: SUGGESTION_LIMITS.renderingReadBytes + 1 })
    .where(
      and(
        eq(schema.versionFiles.versionId, md.versionId),
        eq(schema.versionFiles.kind, "rendered"),
      ),
    );
  gets = 0;
  value(
    await storedPage(db(), bucket, {
      artifact: the(artifact),
      versionId: md.versionId,
      path: md.path,
      contentDomain: DOMAIN,
    }),
  );
  expect(gets).toBe(1); // only the source; an oversized rendering prevents the baseline reads.
});

it("A23: draft acceptance start loses to a role demotion before its batch", async () => {
  const team = await workspace(() => user("Member")),
    s = await draft(team.editor, team.id),
    p = value(await planDraft(db(), env.ARTIFACTS, s.input));
  const h = raceBeforeBatchWith(/insert into "acceptance_attempts"/i, async () => {
    await db()
      .global.update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, team.id),
          eq(schema.workspaceMembers.userId, team.editor.id),
        ),
      );
  });
  expect(await publishDraft(h, env.ARTIFACTS, { ...s.input, digest: p.digest })).toMatchObject({
    ok: false,
  });
  expect(await attempts(s.doc.artifactId)).toEqual([]);
});
it.each(["expiry", "mode"] as const)(
  "A25: item marking loses to live artifact %s before its batch",
  async (change) => {
    const { markChangeItem } = await import("../src/change-list.ts");
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      input = {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        contentDomain: DOMAIN,
      };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "A linked", "One linked")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const params = { ...input, threadId: t.id },
      p = value(await planSuggestion(db(), env.ARTIFACTS, params));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: p.digest }));
    await runJobs("suggestion_accept", doc.artifactId);
    const [item] = await items(doc.artifactId);
    const h = raceBeforeBatchWith(/update "change_items"/i, async () => {
      await db()
        .update(schema.artifacts)
        .set(change === "expiry" ? { expiresAt: NOW } : { annotations: "off" })
        .where(eq(schema.artifacts.id, doc.artifactId));
    });
    expect(
      await markChangeItem(h, {
        userId: owner.id,
        artifactId: doc.artifactId,
        itemId: the(item).id,
        state: "applied",
        baseRevision: the(item).revision,
        now: NOW + 3000,
      }),
    ).toMatchObject({ ok: false });
    expect((await items(doc.artifactId))[0]?.state).toBe("open");
  },
);
it("A26: a draft plan loses to discard before its batch", async () => {
  const owner = await user("Owner"),
    s = await draft(owner);
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    await db().delete(schema.editDrafts).where(eq(schema.editDrafts.artifactId, s.doc.artifactId));
  });
  expect(await planDraft(h, env.ARTIFACTS, s.input)).toMatchObject({ ok: false });
  expect(
    await db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId)),
  ).toHaveLength(0);
});

it.each([false, true])(
  "A24: first-message deletion loses to a carried revision, keep-thread=%s",
  async (keep) => {
    const { deleteOwnAnnotationMessage } = await import("../src/annotations.ts");
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      input = {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        contentDomain: DOMAIN,
      };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    if (keep)
      value(
        await replyToAnnotationThread(db(), { ...input, threadId: t.id, body: "Keep", humanCheck }),
      );
    value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
    const h = raceBeforeBatchWith(/insert into "annotation_events"/i, async () => {
      await republish(owner.id, doc, `A new first paragraph.\n\n${DOC}`);
      await runJobs("suggestion_carry", doc.artifactId, NOW + 2000);
    });
    expect(
      await deleteOwnAnnotationMessage(h, {
        userId: owner.id,
        artifactId: doc.artifactId,
        messageId: the(t.messages[0]).id,
        now: NOW + 3000,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect((await thread(t.id))?.suggestionState).toBe("pending");
  },
);

it.each(["html", "markdown", "text"] as const)(
  "A22: stored %s files just below, at and above the BOM-aware size ceiling",
  async (kind) => {
    const { publishFile } = await import("./suggestion-fixtures.ts");
    const owner = await user("Owner"),
      source = kind === "html" ? PAGE : DOC,
      path = kind === "html" ? "index.html" : kind === "markdown" ? "index.md" : "notes.txt",
      limit = kind === "html" ? PLAN_LIMITS.htmlBytes : PLAN_LIMITS.documentBytes;
    for (const delta of [-1, 0, 1]) {
      const d = await publishFile(
        owner.id,
        kind,
        `\ufeff${source}${" ".repeat(limit + delta - source.length)}`,
      );
      const [a] = await db()
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, d.artifactId));
      let gets = 0;
      const bucket = new Proxy(env.ARTIFACTS, {
        get(target, key) {
          if (key === "get")
            return (...args: Parameters<R2Bucket["get"]>) => {
              gets++;
              return target.get(...args);
            };
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const p = value(
        await storedPage(db(), bucket, {
          artifact: the(a),
          versionId: d.versionId,
          path,
          contentDomain: DOMAIN,
        }),
      );
      expect(p.oversized).toBe(delta > 0);
      if (delta > 0) expect(gets).toBe(0);
      else {
        expect(p.bom).toBe(true);
        expect(p.source.length).toBe(limit + delta);
      }
    }
  },
);

it("A27: reads, rejection, withdrawal, marking and deletion remain available under full budget protection", async () => {
  const { getSuggestion } = await import("../src/suggestions.ts");
  const { listChangeItems, markChangeItem } = await import("../src/change-list.ts");
  const { deleteOwnAnnotationMessage } = await import("../src/annotations.ts");
  const { setBudgetOverride, clearBudgetOverride } = await import("../src/budget.ts");
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10, contentDomain: DOMAIN };
  const ts = [];
  for (let i = 0; i < 4; i++)
    ts.push(
      value(
        await submitSuggestion(db(), {
          ...input,
          versionId: doc.versionId,
          edit: {
            operations: [
              textOp(doc, DOC, i === 0 ? "A linked" : "Second", i === 0 ? "One linked" : "Next"),
            ],
          },
          body: "Fix",
          humanCheck,
        }),
      ),
    );
  const params = { ...input, threadId: the(ts[0]).id },
    p = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: p.digest }));
  await runJobs("suggestion_accept", doc.artifactId);
  const [item] = await items(doc.artifactId);
  await setBudgetOverride(db().global, {
    level: "protect100",
    steps: 4,
    until: null,
    note: null,
    now: NOW,
  });
  try {
    expect((await getSuggestion(db(), { ...input, threadId: the(ts[1]).id })).ok).toBe(true);
    expect((await listChangeItems(db(), { ...input, limit: 20 })).ok).toBe(true);
    expect(
      (
        await markChangeItem(db(), {
          ...input,
          itemId: the(item).id,
          state: "applied",
          baseRevision: the(item).revision,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await rejectSuggestion(db(), { ...input, threadId: the(ts[1]).id, revision: 1 })).ok,
    ).toBe(true);
    expect(
      (await withdrawSuggestion(db(), { ...input, threadId: the(ts[2]).id, revision: 1 })).ok,
    ).toBe(true);
    expect(
      (
        await deleteOwnAnnotationMessage(db(), {
          ...input,
          messageId: the(the(ts[3]).messages[0]).id,
        })
      ).ok,
    ).toBe(true);
  } finally {
    await clearBudgetOverride(db().global, NOW);
  }
});

it("A28: closure continuation closes every item once without rereading the first page", async () => {
  const owner = await user("Owner"),
    body = PAGE.replace("</body>", "<script>1</script></body>"),
    other = body.replace("Title", "Other");
  const site = await publishVersion(
    owner.id,
    { "a.html": body, "b.html": other },
    { entrypoint: "a.html" },
  );
  await db()
    .update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, site.artifactId));
  const input = {
    userId: owner.id,
    artifactId: site.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  for (const path of ["a.html", "b.html"]) {
    const source = path === "a.html" ? body : other;
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: site.versionId,
        edit: { operations: [textOp({ type: "site", path }, source, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const params = { ...input, threadId: t.id },
      p = value(await planSuggestion(db(), env.ARTIFACTS, params));
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: p.digest }));
    await runJobs("suggestion_accept", site.artifactId);
  }
  const next = await publishVersion(
    owner.id,
    { "a.html": body.replace("Second", "Next"), "b.html": other.replace("Second", "Next") },
    { base: site, entrypoint: "a.html", now: NOW + 1000 },
  );
  const [job] = await jobsOf("change_list_check", site.artifactId),
    seen: string[] = [];
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "get")
        return (k: string) => {
          seen.push(k);
          return target.get(k);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await runChangeListCheck(db(), bucket, the(job), NOW + 2000, DOMAIN, 1);
  expect(
    (await items(site.artifactId)).filter((i) => i.state === "closed_by_version"),
  ).toHaveLength(1);
  expect(seen).toHaveLength(1);
  await db()
    .delete(schema.outbox)
    .where(eq(schema.outbox.id, the(job).id));
  const [continuation] = await jobsOf("change_list_check", site.artifactId);
  await runJob(
    db(),
    bucket,
    { id: the(continuation).id, topic: "change_list_check" },
    NOW + 3000,
    JOB_DEPS,
  );
  const done = await items(site.artifactId);
  expect(done).toHaveLength(2);
  expect(
    done.every(
      (i) =>
        i.state === "closed_by_version" && i.revision === 2 && i.closedVersionId === next.versionId,
    ),
  ).toBe(true);
  expect(seen).toHaveLength(2);
  expect(new Set(seen).size).toBe(2);
  expect(await jobsOf("change_list_check", site.artifactId)).toHaveLength(0);
});

it("A29: a suggestion plan loses to a publish before the cache batch even before carry runs", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10, contentDomain: DOMAIN };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    await republish(owner.id, doc, `${DOC}\nExtra.`);
  });
  expect(await planSuggestion(h, env.ARTIFACTS, { ...input, threadId: t.id })).toMatchObject({
    ok: false,
    code: "version_conflict",
  });
  expect(
    await db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, doc.artifactId)),
  ).toHaveLength(0);
});

describe("plan batches hold the live standing they were authorized on", () => {
  const member = (workspaceId: string, userId: string) =>
    and(
      eq(schema.workspaceMembers.workspaceId, workspaceId),
      eq(schema.workspaceMembers.userId, userId),
    );
  const cached = (artifactId: string) =>
    db()
      .select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, artifactId));

  it("A1b: a draft plan loses to the author's demotion before its batch", async () => {
    const team = await workspace(() => user("Member"));
    const s = await draft(team.editor, team.id);
    const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
      await db()
        .global.update(schema.workspaceMembers)
        .set({ role: "member" })
        .where(member(team.id, team.editor.id));
    });
    expect(await planDraft(h, env.ARTIFACTS, s.input)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await cached(s.doc.artifactId)).toEqual([]);
  });

  it("A1c: an owner-side suggestion plan loses to the planner's demotion before its batch", async () => {
    const team = await workspace(() => user("Member"));
    const doc = await publishDoc(team.editor.id, { ownerId: team.id });
    const input = { userId: team.editor.id, artifactId: doc.artifactId, now: NOW + 10 };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
      await db()
        .global.update(schema.workspaceMembers)
        .set({ role: "member" })
        .where(member(team.id, team.editor.id));
    });
    expect(
      await planSuggestion(h, env.ARTIFACTS, { ...input, threadId: t.id, contentDomain: DOMAIN }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await cached(doc.artifactId)).toEqual([]);
  });

  it("A8b: a workspace artifact's reader loses the plan when they leave the workspace before its batch", async () => {
    const team = await workspace(() => user("Member"));
    await grantPlan(team.id, "team", { seats: 10 });
    const doc = await publishDoc(team.editor.id, { ownerId: team.id });
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "workspace", commentVisibility: "everyone" })
      .where(eq(schema.artifacts.id, doc.artifactId));
    const t = value(
      await submitSuggestion(db(), {
        userId: team.editor.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const input = {
      userId: team.member.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId: t.id,
      contentDomain: DOMAIN,
    };
    // The control: the member plans it while they belong to the workspace.
    value(await planSuggestion(db(), env.ARTIFACTS, input));
    await db()
      .delete(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, doc.artifactId));
    const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
      await db().global.delete(schema.workspaceMembers).where(member(team.id, team.member.id));
    });
    expect(await planSuggestion(h, env.ARTIFACTS, input)).toMatchObject({ ok: false });
    expect(await cached(doc.artifactId)).toEqual([]);
  });
});

it("A4b: closure jobs read within the default budget and each page once across the run", async () => {
  const owner = await user("Owner");
  // Nine pages of 1 MB on the new version (one stored object), more than a job's 8 MiB: bytes
  // that are not UTF-8, so each is read and charged in full but proves nothing, cheaply.
  const page = new Uint8Array(1_000_000).fill(0xff);
  const paths = Array.from({ length: 9 }, (_, i) => `${i}.html`);
  const site = await publishVersion(
    owner.id,
    Object.fromEntries(paths.map((path) => [path, `${PAGE}<!-- ${path} -->`])),
    { entrypoint: "0.html" },
  );
  const proof = JSON.stringify({
    unit: "utf16",
    start: 0,
    end: 1,
    before: "x",
    after: "y",
    shownBefore: "x",
    shownAfter: "y",
    nodeLeft: "",
    nodeRight: "",
    identity: [],
  });
  for (const path of paths) {
    await db()
      .insert(schema.changeItems)
      .values({
        id: `close_${path}_${site.artifactId}`,
        artifactId: site.artifactId,
        ownerId: owner.id,
        origin: "draft",
        versionId: site.versionId,
        path,
        envelope: '{"format":1}',
        proof,
        bytes: 12 + proof.length,
        reason: "not_eligible",
      });
  }
  const next = await publishVersion(
    owner.id,
    Object.fromEntries(paths.map((path) => [path, { body: page }])),
    { base: site, entrypoint: "0.html", now: NOW + 1000 },
  );
  expect(next.versionId).not.toBe(site.versionId);
  let bytes = 0;
  const keys: string[] = [];
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "get")
        return async (k: string) => {
          const o = await target.get(k);
          bytes += o?.size ?? 0;
          keys.push(k);
          return o;
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const perJob: number[] = [];
  for (let round = 0; round < 6; round++) {
    const waiting = await jobsOf("change_list_check", site.artifactId);
    if (waiting.length === 0) break;
    for (const job of waiting) {
      bytes = 0;
      await runJob(db(), bucket, { id: job.id, topic: "change_list_check" }, NOW + 3000, JOB_DEPS);
      perJob.push(bytes);
    }
  }
  expect(await jobsOf("change_list_check", site.artifactId)).toEqual([]);
  expect(perJob.length).toBeGreaterThanOrEqual(2);
  expect(perJob.every((read) => read <= SUGGESTION_LIMITS.jobReadBytes)).toBe(true);
  // Every page of the new version read once, and nothing else (no stored rendering).
  expect(keys).toHaveLength(paths.length);
});

it("readCapped never reads the body of an object stored over its cap", async () => {
  let pulled = false;
  let cancelled = false;
  const bucket = {
    get: async () => ({
      size: 17,
      body: new ReadableStream(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new Uint8Array(17));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    }),
  } as unknown as R2Bucket;
  expect(await readCapped(bucket, "x", 16)).toBe("too_large");
  expect(pulled).toBe(false);
  expect(cancelled).toBe(true);
});

it("a document's closure reads only its source, never the stored rendering", async () => {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id);
  const proof = JSON.stringify({
    unit: "utf16",
    start: 0,
    end: 1,
    before: "x",
    after: "y",
    shownBefore: "x",
    shownAfter: "y",
    nodeLeft: "",
    nodeRight: "",
    identity: [],
  });
  await db()
    .insert(schema.changeItems)
    .values({
      id: `doc_close_${doc.artifactId}`,
      artifactId: doc.artifactId,
      ownerId: owner.id,
      origin: "draft",
      versionId: doc.versionId,
      path: doc.path,
      envelope: '{"format":1}',
      proof,
      bytes: 12 + proof.length,
      reason: "not_eligible",
    });
  await republish(owner.id, doc, `${DOC}\nMore.`);
  const [job] = await jobsOf("change_list_check", doc.artifactId);
  const keys: string[] = [];
  const bucket = new Proxy(env.ARTIFACTS, {
    get(target, key) {
      if (key === "get")
        return (k: string) => {
          keys.push(k);
          return target.get(k);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await runJob(db(), bucket, { id: the(job).id, topic: "change_list_check" }, NOW + 3000, JOB_DEPS);
  const [current] = await db()
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, doc.artifactId));
  const [source] = await db()
    .select()
    .from(schema.versionFiles)
    .where(
      and(
        eq(schema.versionFiles.versionId, the(the(current).currentVersionId)),
        eq(schema.versionFiles.kind, "published"),
      ),
    );
  expect(keys).toEqual([`objects/${owner.id}/${the(source).sha256}`]);
});

describe("a domain reader's plan holds the verified domain that admitted them", () => {
  /** A `domain` artifact of a workspace with a verified domain, a suggestion on it and a reader at the domain. */
  async function domainReader() {
    const team = await workspace(() => user("Member"));
    await grantPlan(team.id, "team", { seats: 10 });
    const domain = `acme${crypto.randomUUID().slice(0, 8)}.com`;
    const domainId = `wd_${crypto.randomUUID()}`;
    await db()
      .global.insert(schema.workspaceDomains)
      .values({
        id: domainId,
        workspaceId: team.id,
        domain,
        token: "t",
        state: "verified",
        createdAt: NOW,
        expiresAt: NOW + DAY,
        verifiedAt: NOW,
      });
    const reader = await user("Reader");
    await db()
      .global.update(schema.users)
      .set({ email: `Dana@${domain.toUpperCase()}`, emailVerified: true })
      .where(eq(schema.users.id, reader.id));
    const doc = await publishDoc(team.editor.id, { ownerId: team.id });
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "domain", commentVisibility: "everyone" })
      .where(eq(schema.artifacts.id, doc.artifactId));
    const t = value(
      await submitSuggestion(db(), {
        userId: team.editor.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const input = {
      userId: reader.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      threadId: t.id,
      contentDomain: DOMAIN,
    };
    const cached = () =>
      db()
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.artifactId, doc.artifactId));
    const domainRow = eq(schema.workspaceDomains.id, domainId);
    return { input, cached, domainRow, reader };
  }

  it("plans while the domain is still verified (the control)", async () => {
    const s = await domainReader();
    value(await planSuggestion(db(), env.ARTIFACTS, s.input));
    expect(await s.cached()).toHaveLength(1);
  });

  it.each(["removed", "unverified"] as const)(
    "refuses the plan when the domain is %s before its batch",
    async (change) => {
      const s = await domainReader();
      const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
        if (change === "removed")
          await db().global.delete(schema.workspaceDomains).where(s.domainRow);
        else
          await db()
            .global.update(schema.workspaceDomains)
            .set({ state: "pending" })
            .where(s.domainRow);
      });
      expect(await planSuggestion(h, env.ARTIFACTS, s.input)).toMatchObject({ ok: false });
      expect(await s.cached()).toEqual([]);
    },
  );

  it("refuses the plan when the reader's address leaves the domain before its batch", async () => {
    const s = await domainReader();
    const h = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
      await db()
        .global.update(schema.users)
        .set({ email: `dana@elsewhere-${crypto.randomUUID().slice(0, 6)}.org` })
        .where(eq(schema.users.id, s.reader.id));
    });
    expect(await planSuggestion(h, env.ARTIFACTS, s.input)).toMatchObject({ ok: false });
    expect(await s.cached()).toEqual([]);
  });
});
