// Boundaries the suggestion services' mutation run found unchecked (decision 0027): a job's
// continuation at exactly its limit, the owner's daily acceptances at their limit, the change
// list's last page, and the rows a completion writes.
import { env } from "cloudflare:test";
import { SUGGESTION_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listChangeItems } from "../src/change-list.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { runChangeListCheck, runSuggestionCarry } from "../src/suggestion-versions.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
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
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

function the<T>(x: T | null | undefined): T {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
}

const SCRIPTED = PAGE.replace("</body>", "<script>1</script></body>");

/** `count` pending suggestions with no proofs on one site page, and its next version. */
async function pendingOn(count: number) {
  const owner = await user("Owner");
  const site = await publishVersion(owner.id, { "a.html": PAGE }, { entrypoint: "a.html" });
  for (let i = 0; i < count; i++) {
    await db()
      .insert(schema.annotationThreads)
      .values({
        id: `lim_${i}_${site.artifactId}`,
        artifactId: site.artifactId,
        ownerId: owner.id,
        authorId: owner.id,
        versionId: site.versionId,
        path: "a.html",
        target: "{}",
        targetBytes: 2,
        kind: "suggestion",
        suggestionState: "pending",
        suggestionRevision: 1,
        edit: '{"operations":[]}',
        editBytes: 17,
        updatedAt: NOW,
        createdAt: NOW + i,
      });
  }
  const next = await publishVersion(
    owner.id,
    { "a.html": PAGE.replace("Title", "Other") },
    { base: site, entrypoint: "a.html", now: NOW + 1_000 },
  );
  return { owner, site, next };
}

/** `count` open items with a proof on one site page, and its next version. */
async function openItemsOn(count: number) {
  const owner = await user("Owner");
  const site = await publishVersion(owner.id, { "a.html": PAGE }, { entrypoint: "a.html" });
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
  for (let i = 0; i < count; i++) {
    await db()
      .insert(schema.changeItems)
      .values({
        id: `lim_${String(i).padStart(3, "0")}_${site.artifactId}`,
        artifactId: site.artifactId,
        ownerId: owner.id,
        origin: "draft",
        versionId: site.versionId,
        path: "a.html",
        envelope: '{"format":1}',
        proof,
        bytes: 12 + proof.length,
        reason: "not_eligible",
      });
  }
  await publishVersion(
    owner.id,
    { "a.html": PAGE.replace("Title", "Other") },
    { base: site, entrypoint: "a.html", now: NOW + 1_000 },
  );
  return { owner, site };
}

describe("a job continues only when work is left past its limit", () => {
  it.each([
    [2, 0],
    [3, 1],
  ])("a carry of %i suggestions with a limit of 2 writes %i continuation", async (count, more) => {
    const s = await pendingOn(count);
    const [job] = await jobsOf("suggestion_carry", s.site.artifactId);
    await runSuggestionCarry(db(), env.ARTIFACTS, the(job), NOW + 2_000, DOMAIN, 2);
    await db()
      .delete(schema.outbox)
      .where(eq(schema.outbox.id, the(job).id));
    expect(await jobsOf("suggestion_carry", s.site.artifactId)).toHaveLength(more);
  });

  it.each([
    [2, 0],
    [3, 1],
  ])("a closure of %i items with a limit of 2 writes %i continuation", async (count, more) => {
    const s = await openItemsOn(count);
    const [job] = await jobsOf("change_list_check", s.site.artifactId);
    await runChangeListCheck(db(), env.ARTIFACTS, the(job), NOW + 2_000, DOMAIN, 2);
    await db()
      .delete(schema.outbox)
      .where(eq(schema.outbox.id, the(job).id));
    const continuations = await jobsOf("change_list_check", s.site.artifactId);
    expect(continuations).toHaveLength(more);
    // The continuation resumes after the last item this run checked.
    if (more) {
      expect(the(continuations[0]).payload).toMatchObject({
        after: `lim_001_${s.site.artifactId}`,
      });
    }
  });
});

/** A pending suggestion of the owner's and its plan, ready to accept. */
async function readyToAccept(body = DOC, type: "markdown" | "site" = "markdown") {
  const owner = await user("Owner");
  const doc = await publishDoc(owner.id, { type, body });
  const input = {
    userId: owner.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, body, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const params = { ...input, threadId: t.id };
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, params));
  return { owner, doc, t, params, plan };
}

describe("the owner's acceptances in a day", () => {
  it.each([
    [SUGGESTION_LIMITS.acceptsPerOwner - 1, true],
    [SUGGESTION_LIMITS.acceptsPerOwner, false],
  ])("after %i acceptances, one more is allowed: %s", async (count, allowed) => {
    const s = await readyToAccept();
    await db()
      .global.insert(schema.rateLimits)
      .values({ key: `suggestion_accept:owner:${s.owner.id}`, windowStart: NOW, count });
    const result = await acceptSuggestion(db(), env.ARTIFACTS, {
      ...s.params,
      digest: s.plan.digest,
    });
    expect(result.ok).toBe(allowed);
    expect(await attempts(s.doc.artifactId)).toHaveLength(allowed ? 1 : 0);
  });
});

describe("what a completion writes", () => {
  it("records the version an acceptance published on its attempt", async () => {
    const s = await readyToAccept();
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...s.params, digest: s.plan.digest }));
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    await runJob(
      db(),
      env.ARTIFACTS,
      { id: the(job).id, topic: "suggestion_accept" },
      NOW + 2_000,
      JOB_DEPS,
    );
    const done = the(await thread(s.t.id));
    expect(done.suggestionState).toBe("accepted");
    expect(await attempts(s.doc.artifactId)).toMatchObject([
      { state: "done", versionId: done.resultVersionId },
    ]);
  });

  it("lists a suggestion's items with its author, and a no-version attempt records no version", async () => {
    const s = await readyToAccept(SCRIPTED, "site");
    expect(s.plan.output).toBeNull();
    value(await acceptSuggestion(db(), env.ARTIFACTS, { ...s.params, digest: s.plan.digest }));
    const [job] = await jobsOf("suggestion_accept", s.doc.artifactId);
    await runJob(
      db(),
      env.ARTIFACTS,
      { id: the(job).id, topic: "suggestion_accept" },
      NOW + 2_000,
      JOB_DEPS,
    );
    expect(await attempts(s.doc.artifactId)).toMatchObject([{ state: "done", versionId: null }]);
    const listed = await items(s.doc.artifactId);
    expect(listed.length).toBe(s.plan.listed.length);
    for (const item of listed) {
      expect(item).toMatchObject({
        origin: "suggestion",
        submittedBy: s.owner.id,
        createdBy: s.owner.id,
        threadId: s.t.id,
      });
    }
  });
});

describe("the change list's pages", () => {
  it("gives a cursor only when another page follows", async () => {
    const s = await openItemsOn(3);
    const input = { userId: s.owner.id, artifactId: s.site.artifactId, now: NOW + 3_000 };
    expect(value(await listChangeItems(db(), { ...input, limit: 3 })).nextCursor).toBeNull();
    const first = value(await listChangeItems(db(), { ...input, limit: 2 }));
    expect(first.items).toHaveLength(2);
    const rest = value(
      await listChangeItems(db(), { ...input, limit: 2, cursor: the(first.nextCursor) }),
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(new Set([...first.items, ...rest.items].map((item) => item.id)).size).toBe(3);
  });
});
