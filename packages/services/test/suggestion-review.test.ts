import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { deleteOwnAnnotationMessage, replyToAnnotationThread } from "../src/annotations.ts";
import { markChangeItem } from "../src/change-list.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { acceptSuggestion, endAttempt } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith } from "./race.ts";
import {
  attempts,
  currentText,
  DOC,
  DOMAIN,
  humanCheck,
  items,
  PAGE,
  publishDoc,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { workspace } from "./version-support.ts";

async function setup(
  options: { listed?: boolean; bom?: boolean; owner?: { id: string }; ownerId?: string } = {},
) {
  const owner = options.owner ?? (await user("Owner"));
  const doc = await publishDoc(owner.id, {
    ...(options.bom ? { type: "site" as const, body: `\ufeff${PAGE}` } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
  });
  const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      now: NOW,
      versionId: doc.versionId,
      edit: {
        operations: [
          textOp(
            doc,
            options.bom ? PAGE : DOC,
            options.listed ? "A linked" : "Second",
            options.listed ? "One linked" : "Next",
          ),
        ],
      },
      body: "Please fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: view.id, contentDomain: DOMAIN };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  const accept = (handle = db()) =>
    acceptSuggestion(handle, env.ARTIFACTS, { ...params, digest: plan.digest });
  return { owner, doc, input, view, plan, params, accept };
}

it("R1: a plan must not survive comment scope narrowing before its write batch", async () => {
  const s = await setup();
  const author = await user("Author");
  const reader = await user("Reader");
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  const suggestion = value(
    await submitSuggestion(db(), {
      ...s.input,
      userId: author.id,
      versionId: s.doc.versionId,
      edit: { operations: [textOp(s.doc, DOC, "Second", "Private replacement")] },
      body: "Private note",
      humanCheck,
    }),
  );
  const handle = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    await db()
      .update(schema.artifacts)
      .set({ commentVisibility: "owner" })
      .where(eq(schema.artifacts.id, s.doc.artifactId));
  });
  const result = await planSuggestion(handle, env.ARTIFACTS, {
    ...s.params,
    userId: reader.id,
    threadId: suggestion.id,
  });
  expect(result).toMatchObject({ ok: false, code: "not_found" });
});

it("R2: first-message deletion must lose to an acceptance started before its batch", async () => {
  const s = await setup();
  value(
    await replyToAnnotationThread(db(), {
      ...s.input,
      threadId: s.view.id,
      body: "Keep thread",
      humanCheck,
    }),
  );
  const handle = raceBeforeBatchWith(/insert into "annotation_events"/i, async () => {
    value(await s.accept());
  });
  const result = await deleteOwnAnnotationMessage(handle, {
    ...s.input,
    messageId: s.view.messages[0]!.id,
  });
  const [attempt] = await attempts(s.doc.artifactId);
  await endAttempt(db(), attempt!, "failed", NOW + 200);
  expect.soft(result).toMatchObject({ ok: false, code: "version_conflict" });
  const [message] = await db()
    .select()
    .from(schema.annotationMessages)
    .where(eq(schema.annotationMessages.id, s.view.messages[0]!.id));
  expect.soft(message?.state).not.toBe("deleted");
});

it("R3: published source bytes must equal the confirmed output hash and size, including BOM", async () => {
  const s = await setup({ bom: true });
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId);
  const text = await currentText(s.doc.artifactId, s.doc.path);
  expect(await sha256(text)).toBe(s.plan.output!.sha256);
  expect(new TextEncoder().encode(text).length).toBe(s.plan.output!.size);
});

it("R4: failed digest confirmations must consume a bounded acceptance budget", async () => {
  const s = await setup();
  const before = await db()
    .select()
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.key, `suggestion_accept:owner:${s.owner.id}`));
  expect(before).toEqual([]);
  expect(
    await acceptSuggestion(db(), env.ARTIFACTS, { ...s.params, digest: "0".repeat(64) }),
  ).toMatchObject({ ok: false, code: "version_conflict" });
  const after = await db()
    .select()
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.key, `suggestion_accept:owner:${s.owner.id}`));
  expect(after[0]?.count).toBe(1);
});

it("R5: a no-version acceptance must recheck role in the completing batch", async () => {
  const team = await workspace(() => user("Member"));
  const s = await setup({ listed: true, owner: team.editor, ownerId: team.id });
  value(await s.accept());
  const handle = raceBeforeBatchWith(/insert into "acceptance_claims"/i, async () => {
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
  await runJobs("suggestion_accept", s.doc.artifactId, NOW + 2000, handle);
  expect((await thread(s.view.id))?.suggestionState).not.toBe("accepted");
  expect(await items(s.doc.artifactId)).toHaveLength(0);
});

it("R6: a hold placed between a mark's read and batch must stop the mutation", async () => {
  const s = await setup({ listed: true });
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId);
  const [item] = await items(s.doc.artifactId);
  const handle = raceBeforeBatchWith(/update "change_items"/i, async () => {
    value(
      await suspendArtifact(db(), {
        artifactId: s.doc.artifactId,
        reason: "spam",
        now: NOW + 3000,
      }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: s.doc.artifactId,
        ground: "court order",
        releaseAt: null,
        now: NOW + 3000,
      }),
    );
  });
  const result = await markChangeItem(handle, {
    ...s.input,
    now: NOW + 3000,
    itemId: item!.id,
    baseRevision: item!.revision,
    state: "applied",
  });
  expect(result).toMatchObject({ ok: false });
  expect(result).not.toHaveProperty("value");
  expect((await items(s.doc.artifactId))[0]).toMatchObject({
    state: "open",
    revision: item!.revision,
  });
  const marked = await db()
    .select()
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.artifactId, s.doc.artifactId),
        eq(schema.auditEvents.kind, "change_item.marked"),
      ),
    );
  expect(marked).toEqual([]);
});

it("R6b: marking is an annotation write: refused on suspended, archived and expired artifacts", async () => {
  const s = await setup({ listed: true });
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId);
  const [item] = await items(s.doc.artifactId);
  const mark = (now: number) =>
    markChangeItem(db(), {
      ...s.input,
      now,
      itemId: item!.id,
      baseRevision: item!.revision,
      state: "applied",
    });
  await db()
    .update(schema.artifacts)
    .set({ expiresAt: NOW + 5000 })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  expect(await mark(NOW + 6000)).toMatchObject({ ok: false, code: "artifact_archived" });
  await db()
    .update(schema.artifacts)
    .set({ expiresAt: null, state: "archived", archivedAt: NOW })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  expect(await mark(NOW + 6000)).toMatchObject({ ok: false, code: "artifact_archived" });
  await db()
    .update(schema.artifacts)
    .set({ state: "active", archivedAt: null })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  value(
    await suspendArtifact(db(), { artifactId: s.doc.artifactId, reason: "spam", now: NOW + 6000 }),
  );
  expect(await mark(NOW + 6000)).toMatchObject({ ok: false, code: "forbidden" });
  value(
    await placeLegalHold(db(), {
      artifactId: s.doc.artifactId,
      ground: "order",
      releaseAt: null,
      now: NOW + 6000,
    }),
  );
  const held = await mark(NOW + 6000);
  expect(held.ok).toBe(false);
  expect((await items(s.doc.artifactId))[0]?.state).toBe("open");
});

it("R7: a no-version acceptance must not finish on an expired artifact", async () => {
  const s = await setup({ listed: true });
  await db()
    .update(schema.artifacts)
    .set({ expiresAt: NOW + 150 })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId, NOW + 2000);
  expect(await thread(s.view.id)).toMatchObject({
    suggestionState: "pending",
    attemptReason: "revoked",
  });
  expect(await items(s.doc.artifactId)).toEqual([]);
});

it("R10: two already-running no-version deliveries must not duplicate items", async () => {
  const s = await setup({ listed: true });
  value(await s.accept());
  const { jobsOf, JOB_DEPS } = await import("./suggestion-support.ts");
  const { runJob } = await import("../src/outbox.ts");
  const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
  const [copy] = await db()
    .insert(schema.outbox)
    .values({ ...job!, id: undefined })
    .returning();
  const handle = raceBeforeBatchWith(/insert into "acceptance_claims"/i, async () => {
    await runJob(
      db(),
      env.ARTIFACTS,
      { id: copy!.id, topic: "suggestion_accept" },
      NOW + 2000,
      JOB_DEPS,
    );
  });
  await runJob(
    handle,
    env.ARTIFACTS,
    { id: job!.id, topic: "suggestion_accept" },
    NOW + 2000,
    JOB_DEPS,
  );
  expect(await items(s.doc.artifactId)).toHaveLength(1);
});

it("R11: no-version acceptance must refuse an editor demoted before the job", async () => {
  const team = await workspace(() => user("Member"));
  const s = await setup({ listed: true, owner: team.editor, ownerId: team.id });
  value(await s.accept());
  await db()
    .global.update(schema.workspaceMembers)
    .set({ role: "member" })
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, team.id),
        eq(schema.workspaceMembers.userId, team.editor.id),
      ),
    );
  await runJobs("suggestion_accept", s.doc.artifactId);
  expect((await thread(s.view.id))?.suggestionState).not.toBe("accepted");
  expect(await items(s.doc.artifactId)).toHaveLength(0);
  expect((await thread(s.view.id))?.attemptReason).toBe("revoked");
});

it("R12: no-version item-byte quota refusal must end the attempt as quota_exceeded", async () => {
  const s = await setup({ listed: true });
  const [usage] = await db()
    .select()
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, s.owner.id));
  await db()
    .update(schema.annotationUsage)
    .set({ bytesLimit: usage!.bytes + 1 })
    .where(eq(schema.annotationUsage.ownerId, s.owner.id));
  value(await s.accept());
  await expect(runJobs("suggestion_accept", s.doc.artifactId)).resolves.toEqual(["done"]);
  expect(await thread(s.view.id)).toMatchObject({
    suggestionState: "pending",
    attemptReason: "quota_exceeded",
  });
});

it("R13: a normal Markdown plan stores the same source, rendering and block map as normal publish", async () => {
  const s = await setup();
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId);
  const normal = await publishDoc(s.owner.id, { body: DOC.replace("Second", "Next") });
  const { artifactOf } = await import("./suggestion-support.ts");
  const accepted = await artifactOf(s.doc.artifactId);
  const files = async (versionId: string) =>
    db()
      .select({
        kind: schema.versionFiles.kind,
        path: schema.versionFiles.path,
        sha256: schema.versionFiles.sha256,
        size: schema.versionFiles.size,
      })
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, versionId))
      .orderBy(schema.versionFiles.kind, schema.versionFiles.path);
  const actual = await files(accepted!.currentVersionId!);
  expect(actual).toEqual(await files(normal.versionId));
  expect(actual.find((f) => f.kind === "published")?.sha256).toBe(s.plan.output!.sha256);
  expect(actual.find((f) => f.kind === "rendered")?.sha256).toBe(s.plan.output!.renderedSha256);
  expect(actual.find((f) => f.kind === "block_map")?.sha256).toBe(s.plan.output!.blockMapSha256);
});

it("R14: a BOM Markdown acceptance must match every confirmed output hash", async () => {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id, { body: `\ufeff${DOC}` });
  const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Please fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: view.id, contentDomain: DOMAIN };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  expect(plan.output).not.toBeNull();
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  await runJobs("suggestion_accept", doc.artifactId);
  expect((await thread(view.id))?.suggestionState).toBe("accepted");
  const { artifactOf } = await import("./suggestion-support.ts");
  const artifact = await artifactOf(doc.artifactId);
  const files = await db()
    .select()
    .from(schema.versionFiles)
    .where(eq(schema.versionFiles.versionId, artifact!.currentVersionId!));
  expect.soft(files.find((f) => f.kind === "published")?.sha256).toBe(plan.output!.sha256);
  expect.soft(files.find((f) => f.kind === "rendered")?.sha256).toBe(plan.output!.renderedSha256);
  expect.soft(files.find((f) => f.kind === "block_map")?.sha256).toBe(plan.output!.blockMapSha256);
});

it("R15: deleting an author during acceptance must not leave an accept-ready pending edit", async () => {
  const owner = await user("Owner");
  const author = await user("Reviewer");
  const doc = await publishDoc(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = { artifactId: doc.artifactId, now: NOW + 100 };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      userId: author.id,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Author's unpublished edit")] },
      body: "Author's note",
      humanCheck,
    }),
  );
  value(
    await replyToAnnotationThread(db(), {
      ...input,
      userId: owner.id,
      threadId: view.id,
      body: "Keep conversation",
      humanCheck,
    }),
  );
  const params = { ...input, userId: owner.id, threadId: view.id, contentDomain: DOMAIN };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  const { regionsFromEnv } = await import("@portifact/db");
  const { session } = await import("./fixtures.ts");
  const { requestAccountDeletion, advanceAccountDeletion } = await import("../src/account-data.ts");
  const regions = regionsFromEnv(env);
  value(
    await requestAccountDeletion(regions, {
      userId: author.id,
      sessionId: await session(author.id),
      confirmEmail: author.email,
      now: NOW + 200,
    }),
  );
  let result = "pending";
  for (let i = 0; i < 4 && result === "pending"; i++)
    result = await advanceAccountDeletion(regions, author.id, NOW + 300 + i);
  expect(result).toBe("finished");
  const { expireAcceptAttempts } = await import("../src/suggestion-maintenance.ts");
  await expireAcceptAttempts(db(), NOW + 31 * 60_000);
  expect(await thread(view.id)).toMatchObject({
    suggestionState: "withdrawn",
    edit: null,
    editBytes: 0,
  });
});

it("R16: protection stops a no-version acceptance as annotation work, a version as a publish", async () => {
  const s = await setup({ listed: true });
  const { setBudgetOverride, clearBudgetOverride } = await import("../src/budget.ts");
  await setBudgetOverride(db().global, {
    level: "protect100",
    steps: 2,
    until: null,
    note: null,
    now: NOW,
  });
  try {
    expect(await s.accept()).toMatchObject({ ok: false, code: "capacity_unavailable" });
  } finally {
    await clearBudgetOverride(db().global, NOW);
  }
});

it("R1b: a plan started under the old owner must not recreate the cache a transfer deleted", async () => {
  const { createWorkspace } = await import("../src/workspaces.ts");
  const { transferArtifact } = await import("../src/transfer.ts");
  const { grantPlan } = await import("./fixtures.ts");
  const s = await setup();
  const slug = `x-${crypto.randomUUID().slice(0, 8)}`;
  const team = value(
    await createWorkspace(db().global, { slug, name: "Team", adminUserId: s.owner.id, now: NOW }),
  );
  await grantPlan(team.id, "team", { seats: 10 });
  await db()
    .delete(schema.suggestionPlans)
    .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId));
  const handle = raceBeforeBatchWith(/insert into "suggestion_plans"/i, async () => {
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: s.owner.id,
        artifactId: s.doc.artifactId,
        workspace: slug,
        now: NOW + 150,
      }),
    );
  });
  expect(
    await planSuggestion(handle, env.ARTIFACTS, { ...s.params, now: NOW + 150 }),
  ).toMatchObject({
    ok: false,
  });
  const rows = await db()
    .select()
    .from(schema.suggestionPlans)
    .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId));
  expect(rows).toEqual([]);
});

const demote = (workspaceId: string, userId: string) =>
  db()
    .global.update(schema.workspaceMembers)
    .set({ role: "member" })
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );

async function committedVersions(artifactId: string) {
  return (
    await db()
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.artifactId, artifactId), eq(schema.versions.state, "committed")),
      )
  ).length;
}

it("R5b: a version acceptance must recheck role in the commit's claim", async () => {
  const team = await workspace(() => user("Member"));
  const s = await setup({ owner: team.editor, ownerId: team.id });
  value(await s.accept());
  const handle = raceBeforeBatchWith(/insert into "acceptance_claims"/i, async () => {
    await demote(team.id, team.editor.id);
  });
  await runJobs("suggestion_accept", s.doc.artifactId, NOW + 2000, handle);
  expect(await thread(s.view.id)).toMatchObject({
    suggestionState: "pending",
    attemptReason: "revoked",
  });
  expect(await committedVersions(s.doc.artifactId)).toBe(1);
});

it("R5c: starting an acceptance must recheck role in its batch, for both kinds", async () => {
  for (const listed of [false, true]) {
    const team = await workspace(() => user("Member"));
    const s = await setup({ listed, owner: team.editor, ownerId: team.id });
    const handle = raceBeforeBatchWith(/insert into "acceptance_attempts"/i, async () => {
      await demote(team.id, team.editor.id);
    });
    expect(await s.accept(handle)).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await attempts(s.doc.artifactId)).toEqual([]);
    expect((await thread(s.view.id))?.suggestionState).toBe("pending");
  }
});

it("R4b: every acceptance counts in the planning windows, a draft's too, before any file is read", async () => {
  const s = await setup();
  const key = `suggestion_plan:user:${s.owner.id}`;
  const count = async () =>
    (await db().select().from(schema.rateLimits).where(eq(schema.rateLimits.key, key)))[0]?.count ??
    0;
  const before = await count();
  expect(
    await acceptSuggestion(db(), env.ARTIFACTS, { ...s.params, digest: "1".repeat(64) }),
  ).toMatchObject({ ok: false });
  expect(await count()).toBe(before + 1);
  // Exhausted: refused before the stored file is read.
  await db().update(schema.rateLimits).set({ count: 1_000 }).where(eq(schema.rateLimits.key, key));
  let reads = 0;
  const watched = new Proxy(env.ARTIFACTS, {
    get(target, prop) {
      if (prop === "get")
        return (...args: Parameters<R2Bucket["get"]>) => {
          reads++;
          return target.get(...args);
        };
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  expect(
    await acceptSuggestion(db(), watched, { ...s.params, digest: s.plan.digest }),
  ).toMatchObject({ ok: false, code: "rate_limited" });
  expect(reads).toBe(0);
  const { publishDraft } = await import("../src/suggestion-accept.ts");
  const edit = JSON.stringify({ operations: [textOp(s.doc, DOC, "Second", "Next")] });
  await db().insert(schema.editDrafts).values({
    artifactId: s.doc.artifactId,
    userId: s.owner.id,
    ownerId: s.owner.id,
    baseVersionId: s.doc.versionId,
    edit,
    editBytes: edit.length,
    updatedAt: NOW,
  });
  expect(
    await publishDraft(db(), watched, { ...s.input, digest: s.plan.digest, contentDomain: DOMAIN }),
  ).toMatchObject({ ok: false, code: "rate_limited" });
  expect(reads).toBe(0);
});

async function draftOn(s: Awaited<ReturnType<typeof setup>>, listed: boolean) {
  const edit = JSON.stringify({
    operations: [
      textOp(s.doc, DOC, listed ? "A linked" : "Second", listed ? "One linked" : "Next"),
    ],
  });
  await db().insert(schema.editDrafts).values({
    artifactId: s.doc.artifactId,
    userId: s.owner.id,
    ownerId: s.owner.id,
    baseVersionId: s.doc.versionId,
    edit,
    editBytes: edit.length,
    updatedAt: NOW,
  });
  const { planDraft } = await import("../src/suggestion-plans.ts");
  const { publishDraft } = await import("../src/suggestion-accept.ts");
  const plan = value(await planDraft(db(), env.ARTIFACTS, { ...s.input, contentDomain: DOMAIN }));
  return () =>
    publishDraft(db(), env.ARTIFACTS, { ...s.input, digest: plan.digest, contentDomain: DOMAIN });
}

it("R7b: a no-version draft publish must not finish on an expired artifact", async () => {
  const s = await setup();
  const publish = await draftOn(s, true);
  await db()
    .update(schema.artifacts)
    .set({ expiresAt: NOW + 150 })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  value(await publish());
  await runJobs("draft_publish", s.doc.artifactId, NOW + 2000);
  expect((await attempts(s.doc.artifactId)).find((a) => a.origin === "draft")).toMatchObject({
    state: "ended",
    reason: "revoked",
  });
  expect(await items(s.doc.artifactId)).toEqual([]);
});

it("R12b: a refused annotation quota ends the attempt, and a new acceptance succeeds once freed; drafts too", async () => {
  const s = await setup({ listed: true });
  const [usage] = await db()
    .select()
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, s.owner.id));
  await db()
    .update(schema.annotationUsage)
    .set({ bytesLimit: usage!.bytes + 1 })
    .where(eq(schema.annotationUsage.ownerId, s.owner.id));
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId);
  expect(await items(s.doc.artifactId)).toEqual([]);
  expect(
    await db()
      .select()
      .from(schema.acceptanceClaims)
      .where(eq(schema.acceptanceClaims.artifactId, s.doc.artifactId)),
  ).toEqual([]);
  expect(
    await db()
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.artifactId, s.doc.artifactId),
          eq(schema.auditEvents.kind, "suggestion.accepted"),
        ),
      ),
  ).toEqual([]);
  const publish = await draftOn(s, true);
  value(await publish());
  await runJobs("draft_publish", s.doc.artifactId);
  expect((await attempts(s.doc.artifactId)).find((a) => a.origin === "draft")).toMatchObject({
    state: "ended",
    reason: "quota_exceeded",
  });
  await db()
    .update(schema.annotationUsage)
    .set({ bytesLimit: usage!.bytes + 1_000_000 })
    .where(eq(schema.annotationUsage.ownerId, s.owner.id));
  value(await s.accept());
  await runJobs("suggestion_accept", s.doc.artifactId, NOW + 3000);
  expect((await thread(s.view.id))?.suggestionState).toBe("accepted");
  expect(await items(s.doc.artifactId)).toHaveLength(1);
});

it("R15b: erasing an author's words alone ends their suggestion's running acceptance", async () => {
  const { eraseAuthorFromThread } = await import("../src/annotations.ts");
  const owner = await user("Owner");
  const author = await user("Reviewer");
  const doc = await publishDoc(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = { artifactId: doc.artifactId, now: NOW + 100 };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      userId: author.id,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Unpublished")] },
      body: "Note",
      humanCheck,
    }),
  );
  value(
    await replyToAnnotationThread(db(), {
      ...input,
      userId: owner.id,
      threadId: view.id,
      body: "Keep",
      humanCheck,
    }),
  );
  const params = { ...input, userId: owner.id, threadId: view.id, contentDomain: DOMAIN };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: plan.digest }));
  expect(
    await eraseAuthorFromThread(db(), { authorId: author.id, threadId: view.id, now: NOW + 200 }),
  ).toBe(true);
  expect(await thread(view.id)).toMatchObject({
    suggestionState: "withdrawn",
    edit: null,
    attemptId: null,
  });
  expect((await attempts(doc.artifactId))[0]).toMatchObject({ state: "ended", reason: "revoked" });
  await runJobs("suggestion_accept", doc.artifactId);
  expect(await thread(view.id)).toMatchObject({ suggestionState: "withdrawn", edit: null });
  expect(await committedVersions(doc.artifactId)).toBe(1);
});

it("R11b: a demoted editor who can still read the artifact is refused by the job", async () => {
  const team = await workspace(() => user("Member"));
  await grantPlanFor(team.id);
  const s = await setup({ listed: true, owner: team.editor, ownerId: team.id });
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "workspace" })
    .where(eq(schema.artifacts.id, s.doc.artifactId));
  value(await s.accept());
  await demote(team.id, team.editor.id);
  await runJobs("suggestion_accept", s.doc.artifactId);
  expect(await thread(s.view.id)).toMatchObject({
    suggestionState: "pending",
    attemptReason: "revoked",
  });
  expect(await items(s.doc.artifactId)).toEqual([]);
});

async function grantPlanFor(ownerId: string) {
  const { grantPlan } = await import("./fixtures.ts");
  await grantPlan(ownerId, "team", { seats: 10 });
}
