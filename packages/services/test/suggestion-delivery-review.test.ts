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
