// What suggestions and the change list answer when they refuse (decision 0027): each refusal's
// code and the message a person reads, which tells apart refusals that share a code; the change
// list's room at its cap, raced; and cursors that are not the list's.
import { env } from "cloudflare:test";
import { CHANGE_LIST_LIMITS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAnnotationThread } from "../src/annotations.ts";
import { listChangeItems, markChangeItem } from "../src/change-list.ts";
import { runJob } from "../src/outbox.ts";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { getSuggestion, rejectSuggestion, submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith } from "./race.ts";
import {
  DOC,
  DOMAIN,
  humanCheck,
  items,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  textOp,
} from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

function the<T>(x: T | null | undefined): T {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
}

const SCRIPTED = PAGE.replace("</body>", "<script>1</script></body>");

describe("refusing a suggestion", () => {
  it("tells a missing thread from a thread that is no suggestion", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10 };
    const comment = value(
      await createAnnotationThread(db(), {
        ...input,
        versionId: doc.versionId,
        target: { schema: 1, path: doc.path, anchor: { kind: "document" } },
        body: "A comment",
        humanCheck,
      }),
    );
    expect(await getSuggestion(db(), { ...input, threadId: comment.id })).toEqual({
      ok: false,
      code: "not_found",
      message: "Suggestion not found.",
    });
    expect(await getSuggestion(db(), { ...input, threadId: "th_missing" })).toEqual({
      ok: false,
      code: "not_found",
      message: "Thread not found.",
    });
  });

  it("names why a submission does not fit the version", async () => {
    const owner = await user("Owner");
    const site = await publishVersion(
      owner.id,
      { "index.html": PAGE, "style.css": { body: "p{}", contentType: "text/css" } },
      { entrypoint: "index.html" },
    );
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const input = { userId: owner.id, artifactId: site.artifactId, now: NOW + 10, humanCheck };
    const page = textOp({ type: "site", path: "index.html" }, PAGE, "Second", "Next");
    const at = (path: string) => ({ ...page, target: { ...page.target, path } });
    const submit = (versionId: string, operation: unknown, body = "Fix") =>
      submitSuggestion(db(), { ...input, versionId, edit: { operations: [operation] }, body });
    expect(await submit("ver_old", page)).toEqual({
      ok: false,
      code: "version_conflict",
      message: "Suggest on the current version of the artifact.",
    });
    expect(await submit(site.versionId, at("missing.html"))).toEqual({
      ok: false,
      code: "invalid_input",
      message: "target.path: No such file in this version.",
    });
    expect(await submit(site.versionId, at("style.css"))).toEqual({
      ok: false,
      code: "invalid_input",
      message: "target.path: Suggestions are made on pages and documents.",
    });
    const malformed = await submit(site.versionId, { kind: "text" });
    expect(malformed).toMatchObject({ ok: false, code: "invalid_input" });
    expect(malformed.ok ? "" : malformed.message).toMatch(/^Invalid edit: \S/);
  });

  it("answers a rejection on a stale revision as a conflict a person can reload", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id);
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10 };
    const t = value(
      await submitSuggestion(db(), {
        ...input,
        versionId: doc.versionId,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
        body: "Fix",
        humanCheck,
      }),
    );
    expect(await rejectSuggestion(db(), { ...input, threadId: t.id, revision: 2 })).toEqual({
      ok: false,
      code: "version_conflict",
      message: "The suggestion changed meanwhile. Reload and try again.",
    });
  });
});

/** An owner's site whose listing acceptance left items, with the items' rows. */
async function listedItems() {
  const owner = await user("Owner Name");
  const doc = await publishDoc(owner.id, { type: "site", body: SCRIPTED });
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
      edit: { operations: [textOp(doc, SCRIPTED, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  const plan = value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
  value(
    await acceptSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id, digest: plan.digest }),
  );
  const [job] = await jobsOf("suggestion_accept", doc.artifactId);
  await runJob(
    db(),
    env.ARTIFACTS,
    { id: the(job).id, topic: "suggestion_accept" },
    NOW + 2_000,
    JOB_DEPS,
  );
  const [item] = await items(doc.artifactId);
  return {
    owner,
    doc,
    item: the(item),
    input: { userId: owner.id, artifactId: doc.artifactId, now: NOW + 3_000 },
  };
}

/** Open items on the artifact up to `count` in one statement. */
async function fillOpen(artifactId: string, ownerId: string, versionId: string, count: number) {
  await env.DB.prepare(
    `with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
     insert into change_items (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason)
     select 'fill_' || ? || '_' || i, ?, ?, 'draft', ?, 'index.html', '{}', 2, 'not_eligible' from n`,
  )
    .bind(count, artifactId, artifactId, ownerId, versionId)
    .run();
}

const openCount = async (artifactId: string) =>
  (await items(artifactId)).filter((item) => item.state === "open").length;

describe("marking a change item", () => {
  it("shows the item with the names of the people beside it", async () => {
    const s = await listedItems();
    const marked = value(
      await markChangeItem(db(), {
        ...s.input,
        itemId: s.item.id,
        state: "applied",
        baseRevision: s.item.revision,
      }),
    );
    expect(marked.state).toBe("applied");
    expect(JSON.stringify(marked.envelope)).toContain("Owner Name");
  });

  it("marks an item applied while the list is at its cap", async () => {
    const s = await listedItems();
    await fillOpen(
      s.doc.artifactId,
      s.owner.id,
      s.doc.versionId,
      CHANGE_LIST_LIMITS.openPerArtifact - (await openCount(s.doc.artifactId)),
    );
    expect(await openCount(s.doc.artifactId)).toBe(CHANGE_LIST_LIMITS.openPerArtifact);
    const marked = await markChangeItem(db(), {
      ...s.input,
      itemId: s.item.id,
      state: "applied",
      baseRevision: s.item.revision,
    });
    expect(marked).toMatchObject({ ok: true, value: { state: "applied" } });
  });

  it("refuses to reopen an item once another one filled the list before its batch", async () => {
    const s = await listedItems();
    const dismissed = value(
      await markChangeItem(db(), {
        ...s.input,
        itemId: s.item.id,
        state: "dismissed",
        baseRevision: s.item.revision,
      }),
    );
    await fillOpen(
      s.doc.artifactId,
      s.owner.id,
      s.doc.versionId,
      CHANGE_LIST_LIMITS.openPerArtifact - 1 - (await openCount(s.doc.artifactId)),
    );
    const raced = raceBeforeBatchWith(/update "change_items"/i, async () => {
      await env.DB.prepare(
        "insert into change_items (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason) values (?, ?, ?, 'draft', ?, 'index.html', '{}', 2, 'not_eligible')",
      )
        .bind(`last_${s.doc.artifactId}`, s.doc.artifactId, s.owner.id, s.doc.versionId)
        .run();
    });
    const reopened = await markChangeItem(raced, {
      ...s.input,
      itemId: s.item.id,
      state: "open",
      baseRevision: dismissed.revision,
    });
    expect(reopened).toMatchObject({ ok: false });
    expect((await items(s.doc.artifactId)).find((item) => item.id === s.item.id)?.state).toBe(
      "dismissed",
    );
  });

  it("answers the annotation refusal, not a conflict, for an archived artifact, also when it is archived before the batch", async () => {
    const s = await listedItems();
    const archive = async () => {
      await db()
        .update(schema.artifacts)
        .set({ state: "archived", archivedAt: NOW })
        .where(eq(schema.artifacts.id, s.doc.artifactId));
    };
    const raced = raceBeforeBatchWith(/update "change_items"/i, archive);
    const lost = await markChangeItem(raced, {
      ...s.input,
      itemId: s.item.id,
      state: "applied",
      baseRevision: s.item.revision,
    });
    const fresh = await markChangeItem(db(), {
      ...s.input,
      itemId: s.item.id,
      state: "applied",
      baseRevision: s.item.revision,
    });
    expect(fresh.ok).toBe(false);
    expect(fresh).not.toMatchObject({ code: "version_conflict" });
    expect(lost).toEqual(fresh);
  });
});

describe("the change list's cursors", () => {
  it.each([
    ["text that is not base64", "%%%"],
    ["a cursor without an item", btoa("12:")],
    ["a cursor without a time", btoa("later:item")],
  ])("refuses %s", async (_name, cursor) => {
    const s = await listedItems();
    expect(await listChangeItems(db(), { ...s.input, limit: 5, cursor })).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Invalid cursor.",
    });
  });
});
