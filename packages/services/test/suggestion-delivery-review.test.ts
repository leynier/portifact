// The adversarial review of PR #272 (decision 0027): the account export's drafts (held artifacts,
// every region) and tests for guards whose removal left the suites green.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount } from "../src/account-data.ts";
import { replyToAnnotationThread } from "../src/annotations.ts";
import { rebaseDraft } from "../src/draft-rebase.ts";
import { discardDraft, getDraft, saveDraft } from "../src/edit-drafts.ts";
import { placeLegalHold, releaseLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { planDraft } from "../src/suggestion-plans.ts";
import { issuePreviewCode, redeemPreviewCode } from "../src/suggestion-previews.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, grantPlan, NOW, session, sha256, value } from "./fixtures.ts";
import { raceBeforeStatement } from "./race.ts";
import { codeOf, person } from "./suggestion-fixtures.ts";
import { DOC, DOMAIN, humanCheck, publishDoc, textOp } from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

const everyRegion = () =>
  regionsFromEnv(env)
    .all()
    .map((handles) => handles.db);

async function setup(workspace = false) {
  const owner = await person("Owner");
  const admin = await person("Admin");
  const ws = workspace
    ? value(
        await createWorkspace(db().global, {
          slug: `pf272-${crypto.randomUUID().slice(0, 8)}`,
          name: "Team",
          adminUserId: admin.id,
          now: NOW,
        }),
      )
    : null;
  if (ws) {
    await grantPlan(ws.id, "team", { seats: 10 });
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: owner.id, role: "editor", updatedAt: NOW });
  }
  const doc = await publishDoc(owner.id, ws ? { ownerId: ws.id } : {});
  const actor = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10 };
  const edit = { operations: [textOp(doc, DOC, "Second", "Private replacement")] };
  const held = value(
    await saveDraft(db(), {
      ...actor,
      baseVersionId: doc.versionId,
      baseRevision: null,
      baseIncarnation: null,
      edit,
    }),
  );
  return { owner, admin, ws, doc, actor, edit, held };
}

describe("the account export's drafts (review findings 1 and 2)", () => {
  it("leaves out a held artifact's draft, and gives it back once the hold is released", async () => {
    const s = await setup();
    const exportNow = async (now: number) =>
      value(await exportAccount(db(), { userId: s.owner.id, now, regions: everyRegion() }));
    value(
      await suspendArtifact(db(), { artifactId: s.doc.artifactId, reason: "spam", now: NOW + 20 }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: s.doc.artifactId,
        ground: "Evidence",
        releaseAt: null,
        now: NOW + 21,
      }),
    );
    expect(await getDraft(db(), { ...s.actor, now: NOW + 30 })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect((await exportNow(NOW + 30)).drafts).toEqual([]);
    expect(await releaseLegalHold(db(), { artifactId: s.doc.artifactId, now: NOW + 40 })).toEqual({
      released: true,
    });
    expect((await exportNow(NOW + 50)).drafts).toEqual([
      expect.objectContaining({ artifactId: s.doc.artifactId }),
    ]);
  });

  it("holds the account's draft in another region", async () => {
    const owner = await person("EU author");
    const ws = value(
      await createWorkspace(db().global, {
        slug: `pf272-eu-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU team",
        adminUserId: owner.id,
        region: "eu",
        now: NOW,
      }),
    );
    await grantPlan(ws.id, "team", { seats: 10 });
    const eu = regionsFromEnv(env).get("eu");
    const hash = await sha256(DOC);
    const pending = value(
      await preparePublish(eu.db, {
        userId: owner.id,
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
    await env.ARTIFACTS_EU.put(`objects/${ws.id}/${hash}`, DOC);
    const published = value(
      await commitPublish(eu.db, env.ARTIFACTS_EU, {
        userId: owner.id,
        sessionId: pending.sessionId,
        now: NOW,
      }),
    );
    const doc = { ...published, type: "markdown" as const, path: "index.md" };
    await eu.db
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, doc.artifactId));
    const draft = value(
      await saveDraft(eu.db, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        baseVersionId: doc.versionId,
        baseRevision: null,
        baseIncarnation: null,
        edit: { operations: [textOp(doc, DOC, "Second", "EU private draft")] },
      }),
    );
    const exported = value(
      await exportAccount(db(), { userId: owner.id, now: NOW + 20, regions: everyRegion() }),
    );
    expect(exported.drafts).toEqual([
      expect.objectContaining({ artifactId: draft.artifactId, edit: draft.edit }),
    ]);
  });
});

describe("guards the suites did not hold (review finding 3)", () => {
  it("M1: a stored draft preview dies when the draft is replaced at the same revision", async () => {
    const s = await setup();
    const sessionId = await session(s.owner.id);
    const plan = value(await planDraft(db(), env.ARTIFACTS, { ...s.actor, contentDomain: DOMAIN }));
    const code = codeOf(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.actor,
        sessionId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    value(await discardDraft(db(), s.actor));
    const replacement = value(
      await saveDraft(db(), {
        ...s.actor,
        baseVersionId: s.doc.versionId,
        baseRevision: null,
        baseIncarnation: null,
        edit: s.edit,
      }),
    );
    expect(replacement.revision).toBe(s.held.revision);
    expect(await redeemPreviewCode(regionsFromEnv(env), code, NOW + 30)).toBeUndefined();
  });

  for (const change of ["incarnation", "version"] as const) {
    it(`M3/M4: a rebase loses to a concurrent ${change} change`, async () => {
      const s = await setup(true);
      await publishVersion(
        s.owner.id,
        { "index.md": { body: `Intro.\n\n${DOC}`, contentType: "text/markdown" } },
        {
          base: s.doc,
          ownerId: s.ws?.id ?? "",
          type: "markdown",
          entrypoint: "index.md",
          now: NOW + 1_000,
        },
      );
      let fired = false;
      const handle = raceBeforeStatement(/^update "edit_drafts"/i, async () => {
        fired = true;
        if (change === "incarnation") {
          await db()
            .update(schema.editDrafts)
            .set({ incarnation: "BBBBBBBBBBBBBBBBBBBBBB" })
            .where(eq(schema.editDrafts.artifactId, s.doc.artifactId));
        } else {
          await db()
            .update(schema.artifacts)
            .set({ currentVersionId: s.doc.versionId })
            .where(eq(schema.artifacts.id, s.doc.artifactId));
        }
      });
      const result = await rebaseDraft(handle, env.ARTIFACTS, {
        ...s.actor,
        now: NOW + 2_000,
        baseRevision: s.held.revision,
        baseIncarnation: s.held.incarnation,
        contentDomain: DOMAIN,
      });
      expect(fired).toBe(true);
      expect(result.ok).toBe(false);
      const [row] = await db()
        .select()
        .from(schema.editDrafts)
        .where(
          and(
            eq(schema.editDrafts.artifactId, s.doc.artifactId),
            eq(schema.editDrafts.userId, s.owner.id),
          ),
        );
      expect(row?.baseVersionId).toBe(s.doc.versionId);
    });
  }

  it("M5: an unsaved preview counts in the artifact's planning window", async () => {
    const s = await setup();
    const sessionId = await session(s.owner.id);
    const preview = () =>
      issuePreviewCode(db(), env.ARTIFACTS, {
        ...s.actor,
        sessionId,
        contentDomain: DOMAIN,
        unsaved: { versionId: s.doc.versionId, as: "suggestion", edit: s.edit },
      });
    // Ten plans a minute per artifact: ten previews, then a refusal.
    for (let i = 0; i < 10; i++) {
      const code = codeOf(await preview());
      expect(await redeemPreviewCode(regionsFromEnv(env), code, NOW + 20)).toBeTruthy();
    }
    expect(await preview()).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("M6: exporting a reply elsewhere leaves out the other author's suggestion", async () => {
    const author = await person("Other name");
    const reader = await person("Exporting person");
    const doc = await publishDoc(author.id);
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: doc.artifactId, email: reader.email });
    const suggestion = value(
      await submitSuggestion(db(), {
        userId: author.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        versionId: doc.versionId,
        body: "Other body",
        humanCheck,
        edit: { operations: [textOp(doc, DOC, "Second", "Other author's replacement")] },
      }),
    );
    value(
      await replyToAnnotationThread(db(), {
        userId: reader.id,
        artifactId: doc.artifactId,
        threadId: suggestion.id,
        now: NOW + 20,
        body: "My reply",
        humanCheck,
      }),
    );
    const exported = value(
      await exportAccount(db(), { userId: reader.id, now: NOW + 30, regions: everyRegion() }),
    );
    expect(exported.commentsElsewhere).toHaveLength(1);
    expect(exported.commentsElsewhere[0]?.suggestion).toBeUndefined();
    expect(JSON.stringify(exported.commentsElsewhere)).not.toContain("Other author's replacement");
  });
});
