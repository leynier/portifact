// Accepting suggestions (decision 0027, "Producing the new version", "The acceptance claim"): the
// route confirms a plan by its digest and starts an attempt; the job publishes the plan's new file
// through the publish path, lists what did not apply and completes the suggestion, all on one
// claim.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import {
  artifactOf,
  attempts,
  auditKinds,
  currentText,
  DOC,
  DOMAIN,
  humanCheck,
  items,
  jobsOf,
  PAGE,
  publishDoc,
  runJobs,
  textOp,
  thread,
} from "./suggestion-support.ts";

async function suggested(
  operations: ReturnType<typeof textOp>[],
  options: { type?: "markdown" | "site" } = {},
) {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id, options);
  const view = value(
    await submitSuggestion(db(), {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: operations.map((op) => ({ ...op, target: { ...op.target, path: doc.path } })) },
      body: "Please fix",
      humanCheck,
    }),
  );
  return { owner, doc, threadId: view.id };
}

describe("accepting a suggestion", () => {
  it("publishes the change as a new version through the publish path", async () => {
    const doc = { type: "markdown" as const, path: "index.md" };
    const { owner, doc: artifact, threadId } = await suggested([
      textOp(doc, DOC, "Second", "Next"),
    ]);
    const input = { userId: owner.id, artifactId: artifact.artifactId, now: NOW + 100 };
    const plan = value(
      await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId, contentDomain: DOMAIN }),
    );
    expect(plan.applied).toHaveLength(1);
    expect(plan.listed).toHaveLength(0);
    const started = value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    expect(started.state).toBe("applying");
    expect((await thread(threadId))?.suggestionState).toBe("applying");
    expect(await runJobs("suggestion_accept", artifact.artifactId)).toEqual(["done"]);
    const after = await thread(threadId);
    expect(after).toMatchObject({
      suggestionState: "accepted",
      state: "resolved",
      decidedBy: owner.id,
      attemptId: null,
    });
    const current = await artifactOf(artifact.artifactId);
    expect(current?.currentVersionId).toBe(after?.resultVersionId);
    expect(await currentText(artifact.artifactId, "index.md")).toBe(
      DOC.replace("Second", "Next"),
    );
    // The rendering is the commit's own, stored with the version.
    const [rendered] = await db()
      .select()
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, current?.currentVersionId ?? ""));
    expect(rendered).toBeDefined();
    expect(await auditKinds(artifact.artifactId)).toEqual(
      expect.arrayContaining(["artifact.published", "suggestion.accepted"]),
    );
    expect((await attempts(artifact.artifactId))[0]).toMatchObject({ state: "done" });
    expect(await items(artifact.artifactId)).toEqual([]);
  });

  it("applies an HTML page in the subset", async () => {
    const page = { type: "site" as const, path: "index.html" };
    const { owner, doc, threadId } = await suggested([textOp(page, PAGE, "Second", "Next")], {
      type: "site",
    });
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
    const plan = value(
      await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId, contentDomain: DOMAIN }),
    );
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", doc.artifactId);
    expect(await currentText(doc.artifactId, "index.html")).toBe(PAGE.replace("Second", "Next"));
    expect((await jobsOf("suggestion_accept", doc.artifactId)).length).toBe(0);
  });
});
