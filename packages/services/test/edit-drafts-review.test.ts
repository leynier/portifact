// The adversarial review of PR #267 (decision 0027, "The owner's draft"): each test reproduces a
// finding against the draft services and fails without its fix.
import { env } from "cloudflare:test";
import { DRAFT_LIMITS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { discardDraft, saveDraft } from "../src/edit-drafts.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeStatement } from "./race.ts";
import { DOC, publishDoc, textOp } from "./suggestion-support.ts";

describe("discarding a draft (finding 1)", () => {
  it("preserves a draft when a legal hold lands before its discard", async () => {
    const owner = await user("Draft author");
    const doc = await publishDoc(owner.id);
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10 };
    value(
      await saveDraft(db(), {
        ...input,
        baseVersionId: doc.versionId,
        baseRevision: null,
        baseIncarnation: null,
        edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      }),
    );
    let held = false;
    const raced = raceBeforeStatement(/^delete from "edit_drafts"/i, async () => {
      await db()
        .update(schema.artifacts)
        .set({ state: "suspended" })
        .where(eq(schema.artifacts.id, doc.artifactId));
      value(
        await placeLegalHold(db(), {
          artifactId: doc.artifactId,
          ground: "Preserve evidence",
          releaseAt: null,
          now: NOW + 11,
        }),
      );
      held = true;
    });
    const result = await discardDraft(raced, input);
    expect(held).toBe(true);
    const rows = await db()
      .select()
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    expect(rows, JSON.stringify(result)).toHaveLength(1);
    expect(result.ok).toBe(false);
  });
});

describe("saving over a discarded draft (finding 2)", () => {
  it("does not overwrite a replacement draft from a discarded incarnation", async () => {
    const author = await user("Two tabs");
    const doc = await publishDoc(author.id);
    const input = {
      userId: author.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      baseVersionId: doc.versionId,
      baseRevision: null as number | null,
      baseIncarnation: null as string | null,
      edit: { operations: [textOp(doc, DOC, "Second", "Original")] },
    };
    // Tab A holds the first incarnation at revision 1.
    const first = value(await saveDraft(db(), input));
    const raced = raceBeforeStatement(/^update "edit_drafts"/i, async () => {
      // Tab B discards it and starts a replacement, which is at revision 1 again.
      value(await discardDraft(db(), input));
      value(
        await saveDraft(db(), {
          ...input,
          edit: { operations: [textOp(doc, DOC, "Second", "Replacement")] },
        }),
      );
    });
    const result = await saveDraft(raced, {
      ...input,
      baseRevision: 1,
      baseIncarnation: first.incarnation,
      edit: { operations: [textOp(doc, DOC, "Second", "Stale tab")] },
    });
    const [row] = await db()
      .select()
      .from(schema.editDrafts)
      .where(eq(schema.editDrafts.artifactId, doc.artifactId));
    expect(row?.edit, JSON.stringify(result)).toContain("Replacement");
    expect(result).toMatchObject({ ok: false, code: "version_conflict" });
  });
});

/**
 * Gives `userId` `count` drafts in the default region, each on an archived copy of `artifactId`
 * (copies of the row, so no publish is needed and no active slot is taken).
 */
async function fillDrafts(userId: string, artifactId: string, count: number) {
  const columns = (
    await env.DB.prepare("select name from pragma_table_info('artifacts')").all<{ name: string }>()
  ).results.map((c) => c.name);
  const list = columns.map((c) => `"${c}"`).join(", ");
  const values = columns
    .map((c) => (c === "id" ? "?1" : c === "state" ? "'archived'" : `"${c}"`))
    .join(", ");
  const ids = Array.from({ length: count }, (_, i) =>
    `${artifactId.slice(0, 6)}cp${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`.slice(
      0,
      10,
    ),
  );
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        `insert into artifacts (${list}) select ${values} from artifacts where id = ?2`,
      ).bind(id, artifactId),
      env.DB.prepare(
        "insert into edit_drafts (artifact_id, user_id, owner_id, base_version_id, edit, edit_bytes, updated_at) values (?1, ?2, ?2, 'v', '{}', 2, 0)",
      ).bind(id, userId),
    ]),
  );
}

describe("the draft cap (finding 5)", () => {
  it("keeps 20 drafts per person in each region, and says so", async () => {
    const owner = await user("Two-region author");
    const save = (doc: { artifactId: string; versionId: string }, handle = db()) =>
      saveDraft(handle, {
        userId: owner.id,
        artifactId: doc.artifactId,
        now: NOW + 10,
        baseVersionId: doc.versionId,
        baseRevision: null,
        baseIncarnation: null,
        edit: {
          operations: [textOp({ type: "markdown", path: "index.md" }, DOC, "Second", "Next")],
        },
      });
    const first = await publishDoc(owner.id);
    await fillDrafts(owner.id, first.artifactId, DRAFT_LIMITS.perUser);
    const refused = await save(first);
    expect(refused).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(refused.ok ? "" : refused.message).toContain("in this region");
    // The cap is the regional trigger's: the EU region holds its own 20 (decision 0027).
    const regions = regionsFromEnv(env);
    const eu = regions.get("eu");
    const workspace = value(
      await createWorkspace(regions.global, {
        slug: `pf267-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU workspace",
        adminUserId: owner.id,
        region: "eu",
        now: NOW,
      }),
    );
    const body = "<p>Second paragraph here.</p>";
    const digest = await sha256(body);
    const prepared = value(
      await preparePublish(eu.db, {
        userId: owner.id,
        targetOwnerId: workspace.id,
        type: "site",
        name: "EU page",
        entrypoint: "index.html",
        baseVersionId: null,
        now: NOW,
        files: [
          {
            path: "index.html",
            kind: "published",
            sha256: digest,
            size: body.length,
            contentType: "text/html",
          },
        ],
      }),
    );
    await eu.bucket?.put(`objects/${workspace.id}/${digest}`, body);
    const doc = value(
      await commitPublish(eu.db, eu.bucket as R2Bucket, {
        userId: owner.id,
        sessionId: prepared.sessionId,
        now: NOW,
      }),
    );
    await eu.db
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, doc.artifactId));
    const inEu = await saveDraft(eu.db, {
      userId: owner.id,
      artifactId: doc.artifactId,
      now: NOW + 10,
      baseVersionId: doc.versionId,
      baseRevision: null,
      baseIncarnation: null,
      edit: { operations: [textOp({ type: "site", path: "index.html" }, body, "Second", "Next")] },
    });
    expect(inEu.ok).toBe(true);
  });
});
