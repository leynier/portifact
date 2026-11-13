// What deletion, transfers and legal holds do to the storage of edit suggestions (decision 0027,
// "Withdrawal, deletion and retention"): an account's drafts, plans and preview codes go with it,
// who decided, accepted or closed is forgotten except on a held artifact, a pending suggestion is
// withdrawn when its author's words are erased, and a transfer moves the change list and drops
// the drafts and plans made under the old owner.
import { env } from "cloudflare:test";
import { ANCHOR_SCHEMA_VERSION, DELETED_ACCOUNT, Envelope } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { buildPlan, presentEnvelope, renderEnvelope } from "@portifact/domain/suggestions";
import { DOCUMENT_RENDERER } from "@portifact/render";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { requestAccountDeletion } from "../src/account-data.ts";
import { eraseAuthorFromThread } from "../src/annotations.ts";
import { applyTombstones } from "../src/backups.ts";
import { eraseAccountTraces } from "../src/history-retention.ts";
import { runHoldRelease } from "../src/legal-holds.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, grantPlan, NOW, publishSite, session, user, value } from "./fixtures.ts";

const EDIT = JSON.stringify({ operations: [{ kind: "text", after: "fox" }] });
const ENVELOPE = '{"format":1}';
const bytesOf = (text: string) => new TextEncoder().encode(text).length;
const th = schema.annotationThreads;

async function suggestion(
  id: string,
  artifactId: string,
  ownerId: string,
  authorId: string,
  values: Partial<typeof th.$inferInsert> = {},
) {
  await db()
    .insert(th)
    .values({
      id,
      artifactId,
      versionId: "v1",
      ownerId,
      authorId,
      target: "{}",
      targetBytes: 2,
      path: "index.html",
      updatedAt: NOW,
      kind: "suggestion",
      suggestionState: "pending",
      edit: EDIT,
      editBytes: bytesOf(EDIT),
      ...values,
    });
}

async function message(
  id: string,
  threadId: string,
  artifactId: string,
  ownerId: string,
  authorId: string,
  createdAt: number,
) {
  await db().insert(schema.annotationMessages).values({
    id,
    threadId,
    artifactId,
    ownerId,
    authorId,
    body: "words",
    bodyBytes: 5,
    createdAt,
  });
}

async function item(
  id: string,
  artifactId: string,
  ownerId: string,
  values: Partial<typeof schema.changeItems.$inferInsert> = {},
) {
  await db()
    .insert(schema.changeItems)
    .values({
      id,
      artifactId,
      ownerId,
      origin: "suggestion",
      versionId: "v1",
      path: "index.html",
      envelope: ENVELOPE,
      bytes: bytesOf(ENVELOPE),
      reason: "spans_nodes",
      ...values,
    });
}

async function draft(artifactId: string, userId: string, ownerId: string) {
  await db()
    .insert(schema.editDrafts)
    .values({
      artifactId,
      userId,
      ownerId,
      baseVersionId: "v1",
      edit: EDIT,
      editBytes: bytesOf(EDIT),
      updatedAt: NOW,
    });
}

async function plan(artifactId: string, userId: string) {
  await db()
    .insert(schema.suggestionPlans)
    .values({ userId, digest: "c".repeat(64), artifactId, plan: "{}", expiresAt: NOW + 600_000 });
}

async function attempt(id: string, artifactId: string, ownerId: string, userId: string) {
  await db()
    .insert(schema.acceptanceAttempts)
    .values({
      id,
      artifactId,
      ownerId,
      origin: "suggestion",
      userId,
      digest: "d".repeat(64),
      baseVersionId: "v1",
      updatedAt: NOW,
    });
}

/** Suspends and holds an artifact as the operator's hold does. */
async function hold(artifactId: string, ownerId: string) {
  await db()
    .update(schema.artifacts)
    .set({ state: "suspended", suspensionReason: "spam" })
    .where(eq(schema.artifacts.id, artifactId));
  await db()
    .insert(schema.legalHolds)
    .values({ id: `lh_${artifactId}`, artifactId, ownerId, reason: "spam", ground: "Court order" });
}

async function annotationBytes(ownerId: string) {
  const [row] = await db()
    .select({ bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, ownerId));
  return row?.bytes ?? 0;
}

describe("a deleted account's traces on edit suggestions", () => {
  it("forgets who decided, accepted, closed or ran an acceptance, and deletes its drafts, except on a held artifact", async () => {
    const owner = await user();
    const gone = await user();
    const open = await publishSite(owner.id);
    const held = await publishSite(owner.id);
    for (const { artifactId } of [open, held]) {
      const tag = artifactId;
      await suggestion(`s_${tag}`, artifactId, owner.id, owner.id, {
        suggestionState: "rejected",
        decidedBy: gone.id,
        decidedAt: NOW,
      });
      await item(`ci_a_${tag}`, artifactId, owner.id, { createdBy: gone.id });
      await item(`ci_b_${tag}`, artifactId, owner.id, {
        state: "applied",
        closedAt: NOW,
        closedBy: gone.id,
      });
      await attempt(`aa_${tag}`, artifactId, owner.id, gone.id);
      await draft(artifactId, gone.id, owner.id);
    }
    await hold(held.artifactId, owner.id);

    expect(await eraseAccountTraces(db(), gone.id, 1)).toEqual({ more: true });
    expect(await eraseAccountTraces(db(), gone.id)).toEqual({ more: false });

    const decided = async (artifactId: string) =>
      (
        await db()
          .select({ by: th.decidedBy, at: th.decidedAt })
          .from(th)
          .where(eq(th.artifactId, artifactId))
      )[0];
    expect(await decided(open.artifactId)).toEqual({ by: null, at: NOW });
    expect(await decided(held.artifactId)).toEqual({ by: gone.id, at: NOW });
    const items = async (artifactId: string) =>
      db()
        .select({ createdBy: schema.changeItems.createdBy, closedBy: schema.changeItems.closedBy })
        .from(schema.changeItems)
        .where(eq(schema.changeItems.artifactId, artifactId))
        .orderBy(schema.changeItems.id);
    expect(await items(open.artifactId)).toEqual([
      { createdBy: null, closedBy: null },
      { createdBy: null, closedBy: null },
    ]);
    expect(await items(held.artifactId)).toEqual([
      { createdBy: gone.id, closedBy: null },
      { createdBy: null, closedBy: gone.id },
    ]);
    const attempts = await db()
      .select({
        artifactId: schema.acceptanceAttempts.artifactId,
        userId: schema.acceptanceAttempts.userId,
      })
      .from(schema.acceptanceAttempts)
      .where(eq(schema.acceptanceAttempts.ownerId, owner.id));
    expect(attempts).toContainEqual({ artifactId: open.artifactId, userId: null });
    expect(attempts).toContainEqual({ artifactId: held.artifactId, userId: gone.id });
    const drafts = await db()
      .select({ artifactId: schema.editDrafts.artifactId })
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.userId, gone.id));
    expect(drafts).toEqual([{ artifactId: held.artifactId }]);
  });

  it("deletes the account's drafts, plans and preview codes when it asks for deletion", async () => {
    const owner = await user();
    const editor = await user();
    const sessionId = await session(editor.id);
    const site = await publishSite(owner.id);
    const held = await publishSite(owner.id);
    await draft(site.artifactId, editor.id, owner.id);
    await draft(held.artifactId, editor.id, owner.id);
    await draft(site.artifactId, owner.id, owner.id);
    await plan(site.artifactId, editor.id);
    await plan(site.artifactId, owner.id);
    await db()
      .insert(schema.previewCodes)
      .values({
        codeSha256: "e".repeat(64),
        userId: editor.id,
        sessionId,
        artifactId: site.artifactId,
        r2Key: "previews/e",
        createdAt: NOW,
        expiresAt: NOW + 60_000,
      });
    await hold(held.artifactId, owner.id);

    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: editor.id,
        sessionId,
        confirmEmail: editor.email,
        now: NOW,
      }),
    );

    const drafts = await db()
      .select({ artifactId: schema.editDrafts.artifactId, userId: schema.editDrafts.userId })
      .from(schema.editDrafts);
    expect(drafts).toContainEqual({ artifactId: held.artifactId, userId: editor.id });
    expect(drafts).toContainEqual({ artifactId: site.artifactId, userId: owner.id });
    expect(drafts).not.toContainEqual({ artifactId: site.artifactId, userId: editor.id });
    const plans = await db()
      .select({ userId: schema.suggestionPlans.userId })
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, site.artifactId));
    expect(plans).toEqual([{ userId: owner.id }]);
    expect(
      await db()
        .select()
        .from(schema.previewCodes)
        .where(eq(schema.previewCodes.userId, editor.id)),
    ).toEqual([]);
  });
});

describe("erasing an author from a suggestion thread", () => {
  it("withdraws their pending suggestion and gives its bytes back, leaving others' suggestions", async () => {
    const owner = await user();
    const gone = await user();
    const site = await publishSite(owner.id);
    const a = site.artifactId;
    await suggestion("s_mine", a, owner.id, gone.id);
    await message("m1", "s_mine", a, owner.id, gone.id, NOW);
    await message("m2", "s_mine", a, owner.id, owner.id, NOW + 1);
    // Someone else's suggestion the account only replied to stays pending.
    await suggestion("s_theirs", a, owner.id, owner.id);
    await message("m3", "s_theirs", a, owner.id, owner.id, NOW);
    await message("m4", "s_theirs", a, owner.id, gone.id, NOW + 1);
    await message("m5", "s_theirs", a, owner.id, owner.id, NOW + 2);
    // A decided suggestion keeps its edit as the record of what was accepted.
    await suggestion("s_done", a, owner.id, gone.id, {
      suggestionState: "accepted",
      decidedAt: NOW,
      state: "resolved",
    });
    await message("m6", "s_done", a, owner.id, gone.id, NOW);
    await message("m7", "s_done", a, owner.id, owner.id, NOW + 1);
    const before = await annotationBytes(owner.id);

    for (const threadId of ["s_mine", "s_theirs", "s_done"]) {
      expect(await eraseAuthorFromThread(db(), { authorId: gone.id, threadId, now: NOW + 5 })).toBe(
        true,
      );
    }

    const rows = await db()
      .select({
        id: th.id,
        state: th.suggestionState,
        edit: th.edit,
        revision: th.suggestionRevision,
      })
      .from(th)
      .where(eq(th.artifactId, a))
      .orderBy(th.id);
    expect(rows).toEqual([
      { id: "s_done", state: "accepted", edit: EDIT, revision: 0 },
      { id: "s_mine", state: "withdrawn", edit: null, revision: 1 },
      { id: "s_theirs", state: "pending", edit: EDIT, revision: 0 },
    ]);
    // The withdrawn edit's bytes and the three erased messages' bodies are given back.
    expect(await annotationBytes(owner.id)).toBe(before - bytesOf(EDIT) - 3 * 5);
  });
});

describe("transferring an artifact with suggestions", () => {
  it("moves its change list and drops the drafts and plans made under the old owner", async () => {
    const alice = await user();
    const slug = `x-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, {
        slug,
        name: `WS ${slug}`,
        adminUserId: alice.id,
        now: NOW,
      }),
    );
    await grantPlan(ws.id, "team", { seats: 10 });
    const site = await publishSite(alice.id);
    const other = await publishSite(alice.id);
    await item("ci_moved", site.artifactId, alice.id);
    await item("ci_stays", other.artifactId, alice.id);
    await draft(site.artifactId, alice.id, alice.id);
    await draft(other.artifactId, alice.id, alice.id);
    await plan(site.artifactId, alice.id);

    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: alice.id,
        artifactId: site.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );

    const owners = await db()
      .select({ id: schema.changeItems.id, ownerId: schema.changeItems.ownerId })
      .from(schema.changeItems)
      .where(eq(schema.changeItems.ownerId, ws.id));
    expect(owners).toEqual([{ id: "ci_moved", ownerId: ws.id }]);
    expect(await annotationBytes(ws.id)).toBe(bytesOf(ENVELOPE));
    expect(await annotationBytes(alice.id)).toBe(bytesOf(ENVELOPE));
    const drafts = await db()
      .select({ artifactId: schema.editDrafts.artifactId })
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.userId, alice.id));
    expect(drafts).toEqual([{ artifactId: other.artifactId }]);
    expect(
      await db()
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.artifactId, site.artifactId)),
    ).toEqual([]);
  });
});

describe("the stored enums match the contracts", () => {
  it("lists the same kinds, states and reasons", async () => {
    const contracts = await import("@portifact/contracts");
    expect(schema.SUGGESTION_THREAD_KINDS).toEqual(contracts.THREAD_KINDS);
    expect(schema.SUGGESTION_STATES).toEqual(contracts.SUGGESTION_STATES);
    expect(schema.ACCEPTANCE_END_REASONS).toEqual(contracts.ATTEMPT_END_REASONS);
    expect(schema.CHANGE_ITEM_STATES).toEqual(contracts.CHANGE_ITEM_STATES);
    expect(schema.CHANGE_ITEMS_OPEN_MAX).toBe(contracts.CHANGE_LIST_LIMITS.openPerArtifact);
  });
});

/** A real plan's first listed envelope and its proof, as an acceptance would store them. */
async function realItem(html: string, before: string, after: string) {
  const text = "Pay now and later";
  const start = text.indexOf(before);
  const built = await buildPlan({
    binding: {
      artifactId: "a",
      versionId: "v1",
      path: "index.html",
      fileSha256: "0".repeat(64),
      renderer: DOCUMENT_RENDERER.label,
      subject: "th_1",
      revision: 1,
    },
    people: { submitter: true, acceptor: true },
    kind: "html",
    source: html,
    operations: [
      {
        kind: "text",
        target: {
          schema: ANCHOR_SCHEMA_VERSION,
          path: "index.html",
          anchor: {
            kind: "text",
            quote: { exact: before, prefix: "", suffix: "" },
            position: { start, end: start + before.length },
          },
        },
        after,
      },
    ],
    pageUrl: "https://k7d2qm4xab.portifact.dev/index.html",
    renderer: DOCUMENT_RENDERER,
  });
  const envelope = JSON.stringify(built.listed[0]);
  const proof = built.proofs[built.applied.length] ?? null;
  const proofText = proof === null ? null : JSON.stringify(proof);
  return {
    envelope,
    proof: proofText,
    bytes: bytesOf(envelope) + (proofText ? bytesOf(proofText) : 0),
  };
}

describe("people of a real envelope (review of #252, finding 3)", () => {
  const html = "<!doctype html><p>Pay now and later</p><script>1</script>";

  async function shown(id: string, names: Record<string, string>) {
    const [row] = await db().select().from(schema.changeItems).where(eq(schema.changeItems.id, id));
    if (!row) throw new Error("no item");
    const envelope = Envelope.parse(JSON.parse(row.envelope));
    const name = (ref: string | null) => (ref === null ? null : (names[ref] ?? null));
    return presentEnvelope(envelope, {
      submittedBy: name(row.submittedBy),
      acceptedBy: name(row.createdBy),
    });
  }

  it("stores no name, shows current names, and shows a deleted account once erased", async () => {
    const owner = await user();
    const reviewer = await user();
    const site = await publishSite(owner.id);
    const real = await realItem(html, "now", "soon");
    await item("ci_real", site.artifactId, owner.id, {
      ...real,
      createdBy: owner.id,
      submittedBy: reviewer.id,
    });
    const before = await annotationBytes(owner.id);
    const names = { [owner.id]: "Actual Owner", [reviewer.id]: "Actual Reviewer" };
    expect(real.envelope).not.toContain("Actual");
    const first = await shown("ci_real", names);
    expect(first.provenance).toEqual({
      submittedBy: "Actual Reviewer",
      acceptedBy: "Actual Owner",
    });
    expect(renderEnvelope(first).join("\n")).toContain("suggested by Actual Reviewer");

    await eraseAccountTraces(db(), reviewer.id);
    const erased = await shown("ci_real", names);
    expect(erased.provenance).toEqual({ submittedBy: DELETED_ACCOUNT, acceptedBy: "Actual Owner" });
    expect(renderEnvelope(erased).join("\n")).toContain(`suggested by ${DELETED_ACCOUNT}`);
    expect(await annotationBytes(owner.id)).toBe(before);
  });

  it("keeps a held artifact's people until the release, and erases them again after a restore", async () => {
    const owner = await user();
    const reviewer = await user();
    const site = await publishSite(owner.id);
    const real = await realItem(html, "now", "soon");
    await item("ci_held", site.artifactId, owner.id, {
      ...real,
      createdBy: owner.id,
      submittedBy: reviewer.id,
    });
    await hold(site.artifactId, owner.id);
    await applyTombstones(db(), [{ kind: "account", id: reviewer.id, deletedAt: NOW }], NOW);
    await eraseAccountTraces(db(), reviewer.id);
    const submitter = async () =>
      (
        await db()
          .select({ by: schema.changeItems.submittedBy })
          .from(schema.changeItems)
          .where(eq(schema.changeItems.id, "ci_held"))
      )[0]?.by;
    expect(await submitter()).toBe(reviewer.id);
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: NOW + 1 })
      .where(eq(schema.legalHolds.artifactId, site.artifactId));
    expect(await runHoldRelease(db(), undefined, site.artifactId, NOW + 2)).toBe("done");
    expect(await submitter()).toBeNull();

    // A restore rewinds the erasure; the account's tombstone erases it again.
    await db()
      .update(schema.changeItems)
      .set({ submittedBy: reviewer.id })
      .where(eq(schema.changeItems.id, "ci_held"));
    await applyTombstones(db(), [{ kind: "account", id: reviewer.id, deletedAt: NOW }], NOW + 3);
    expect(await submitter()).toBeNull();
  });
});

describe("what a planner produces is storable (review of #252, finding 8)", () => {
  it("inserts the envelope and proof of a page with a huge attribute and of a deep page", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    const pages = [
      `<!doctype html><p data-note="${"a".repeat(17_000)}">Pay now and later</p><script>1</script>`,
      `<!doctype html>${"<div>".repeat(5_000)}Pay now and later${"</div>".repeat(5_000)}<script>1</script>`,
    ];
    for (const [index, page] of pages.entries()) {
      const real = await realItem(page, "now", "soon");
      await item(`ci_big_${index}`, site.artifactId, owner.id, real);
    }
    const stored = await db()
      .select({ id: schema.changeItems.id })
      .from(schema.changeItems)
      .where(eq(schema.changeItems.artifactId, site.artifactId));
    expect(stored).toHaveLength(2);
  });
});
