// What a new current version does to suggestions and the change list (decision 0027, "Suggestions
// and new versions", "Closing by itself"): a planned suggestion whose target did not change is
// carried with its proofs, anything else is outdated, and an open item closes only with a proof on
// the new version's rendered page. Publishes and rollbacks write the jobs; the jobs are idempotent.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { storedProofs, submitSuggestion } from "../src/suggestions.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import {
  currentText,
  DOC,
  type Doc,
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

const MD = { type: "markdown" as const, path: "index.md" };
const LONGER = DOC.replace("First paragraph.", "First paragraph, now much longer than before.");

async function suggest(owner: { id: string }, doc: Doc, body: string, before: string, after: string) {
  const view = value(
    await submitSuggestion(db(), {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW,
      versionId: doc.versionId,
      edit: { operations: [textOp(MD, body, before, after)] },
      body: "Fix",
      humanCheck,
    }),
  );
  return view.id;
}

const plan = (owner: { id: string }, doc: Doc, threadId: string, now = NOW + 10) =>
  planSuggestion(db(), env.ARTIFACTS, {
    userId: owner.id,
    artifactId: doc.artifactId,
    now,
    threadId,
    contentDomain: DOMAIN,
  });

describe("carrying suggestions", () => {
  it("carries a planned suggestion whose target did not change, and it applies there", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(owner, doc, DOC, "Second", "Next");
    value(await plan(owner, doc, threadId));
    expect(storedProofs((await thread(threadId)) ?? { editProofs: null })?.versionId).toBe(doc.versionId);
    const next = await republish(owner.id, doc, LONGER);
    expect(await jobsOf("suggestion_carry", doc.artifactId)).toHaveLength(1);
    expect(await runJobs("suggestion_carry", doc.artifactId)).toEqual(["done"]);
    const carried = await thread(threadId);
    expect(carried).toMatchObject({
      suggestionState: "pending",
      versionId: next.versionId,
      originVersionId: doc.versionId,
      suggestionRevision: 2,
    });
    expect(carried?.originTarget).toBe(carried?.target);
    expect(storedProofs(carried ?? { editProofs: null })?.versionId).toBe(next.versionId);
    // The carried suggestion plans and applies on the new version.
    const again = value(await plan(owner, next, threadId, NOW + 2_000));
    expect(again.applied).toHaveLength(1);
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 2_000,
        threadId,
        digest: again.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", doc.artifactId, NOW + 3_000);
    expect(await currentText(doc.artifactId, "index.md")).toBe(LONGER.replace("Second", "Next"));
  });

  it("outdates a suggestion never planned, and one whose target changed", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const unplanned = await suggest(owner, doc, DOC, "Second", "Next");
    const changed = await suggest(owner, doc, DOC, "First", "Opening");
    value(await plan(owner, doc, changed));
    await republish(owner.id, doc, DOC.replace("First paragraph.", "The first paragraph."));
    await runJobs("suggestion_carry", doc.artifactId);
    expect(await thread(unplanned)).toMatchObject({ suggestionState: "outdated", versionId: doc.versionId });
    expect(await thread(changed)).toMatchObject({ suggestionState: "outdated", versionId: doc.versionId });
  });

  it("does nothing for a version that is no longer current, and once only", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const threadId = await suggest(owner, doc, DOC, "Second", "Next");
    value(await plan(owner, doc, threadId));
    const second = await republish(owner.id, doc, LONGER);
    const [stale] = await jobsOf("suggestion_carry", doc.artifactId);
    await republish(owner.id, second, LONGER.replace("much longer", "far longer"), NOW + 1_500);
    expect(
      await runJob(db(), env.ARTIFACTS, { id: stale?.id ?? 0, topic: "suggestion_carry" }, NOW + 2_000, JOB_DEPS),
    ).toBe("stale");
    await runJobs("suggestion_carry", doc.artifactId);
    const carried = await thread(threadId);
    expect(carried?.suggestionState).toBe("pending");
    const revision = carried?.suggestionRevision;
    // A repeated delivery finds nothing pending on an earlier version.
    await runJobs("suggestion_carry", doc.artifactId);
    expect((await thread(threadId))?.suggestionRevision).toBe(revision);
  });

  it("writes the jobs on a rollback, and none when nothing waits", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const next = await republish(owner.id, doc, LONGER);
    expect(await jobsOf("suggestion_carry", doc.artifactId)).toEqual([]);
    expect(await jobsOf("change_list_check", doc.artifactId)).toEqual([]);
    const threadId = await suggest(owner, next, LONGER, "Second", "Next");
    value(await plan(owner, next, threadId));
    value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        versionId: doc.versionId,
        baseVersionId: next.versionId,
        now: NOW + 2_000,
      }),
    );
    expect(await jobsOf("suggestion_carry", doc.artifactId)).toHaveLength(1);
    await runJobs("suggestion_carry", doc.artifactId, NOW + 3_000);
    expect((await thread(threadId))?.suggestionState).toBe("pending");
  });
});

describe("closing change items by a new version", () => {
  // A page outside the subset (it runs a script): its edits are listed with their proven place.
  const SCRIPTED = PAGE.replace("</body>", "<script>1</script></body>");
  const SITE = { type: "site" as const, path: "index.html" };

  it("closes a listed item whose change the new page shows, and keeps the others open", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id, { type: "site", body: SCRIPTED });
    const view = value(
      await submitSuggestion(db(), {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [textOp(SITE, SCRIPTED, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    const built = value(await plan(owner, doc, view.id));
    expect(built.listed.map((item) => item.reason)).toEqual(["not_eligible"]);
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        threadId: view.id,
        digest: built.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runJobs("suggestion_accept", doc.artifactId);
    const [item] = await items(doc.artifactId);
    expect(item).toMatchObject({ state: "open", reason: "not_eligible" });
    expect(item?.proof).not.toBeNull();
    // A publish that does not show the change leaves it open.
    const unrelated = await republish(owner.id, doc, SCRIPTED.replace("Title", "Heading"), NOW + 1_000);
    await runJobs("change_list_check", doc.artifactId);
    expect((await items(doc.artifactId))[0]?.state).toBe("open");
    const fixed = await republish(
      owner.id,
      unrelated,
      SCRIPTED.replace("Title", "Heading").replace("Second", "Next"),
      NOW + 1_500,
    );
    await runJobs("change_list_check", doc.artifactId, NOW + 2_000);
    expect((await items(doc.artifactId))[0]).toMatchObject({
      state: "closed_by_version",
      closedVersionId: fixed.versionId,
      closedBy: null,
    });
  });

  it("checks no item without proof data", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    await db().insert(schema.changeItems).values({
      id: `noproof_${doc.artifactId}`,
      artifactId: doc.artifactId,
      ownerId: owner.id,
      origin: "draft",
      versionId: doc.versionId,
      path: "index.md",
      envelope: '{"format":1}',
      bytes: 12,
      reason: "spans_nodes",
    });
    await republish(owner.id, doc, LONGER);
    expect(await jobsOf("change_list_check", doc.artifactId)).toEqual([]);
    const [row] = await db().select().from(schema.changeItems).where(eq(schema.changeItems.artifactId, doc.artifactId));
    expect(row?.state).toBe("open");
  });
});
