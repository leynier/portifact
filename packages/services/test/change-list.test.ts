// The change list (decision 0027, "The change list"): read and marked only by the owner side as
// people (a service token gets a missing artifact), names beside the envelope, reopening bounded
// by the open-item cap, a held artifact's list answered to nobody but the operator.
import { CHANGE_LIST_LIMITS, DELETED_ACCOUNT, Envelope } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listChangeItems, markChangeItem } from "../src/change-list.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { db, NOW, user, value } from "./fixtures.ts";
import { auditKinds, publishDoc } from "./suggestion-support.ts";

const ENVELOPE = {
  format: 1,
  status: "listed",
  reason: "spans_nodes",
  operation: { kind: "text", before: "A linked", after: "One linked" },
  binding: {
    artifactId: "x",
    versionId: "v",
    path: "index.md",
    fileSha256: "a".repeat(64),
    renderer: "portifact-render@1",
    route: null,
    subject: "th",
    revision: 1,
  },
  people: { submitter: true, acceptor: true },
  location: { unresolved: true },
  context: null,
  destinations: [],
  destinationsKnown: false,
} as const;

async function listed(count = 2) {
  const owner = await user("Owner Person");
  const reviewer = await user("Reviewer Person");
  const doc = await publishDoc(owner.id);
  const text = JSON.stringify(ENVELOPE);
  for (let i = 0; i < count; i++) {
    await db()
      .insert(schema.changeItems)
      .values({
        id: `chg_${doc.artifactId}_${i}`,
        artifactId: doc.artifactId,
        ownerId: owner.id,
        origin: "suggestion",
        versionId: doc.versionId,
        path: "index.md",
        envelope: text,
        bytes: new TextEncoder().encode(text).length,
        reason: "spans_nodes",
        createdBy: owner.id,
        submittedBy: reviewer.id,
        createdAt: NOW + i,
      });
  }
  const as = (userId: string) => ({ userId, artifactId: doc.artifactId, now: NOW + 100 });
  return { owner, reviewer, doc, as };
}

describe("reading the change list", () => {
  it("gives the owner side the shown envelopes with the people's names, page by page", async () => {
    const l = await listed(3);
    const first = value(await listChangeItems(db(), { ...l.as(l.owner.id), limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.envelope).toMatchObject({
      provenance: { submittedBy: "Reviewer Person", acceptedBy: "Owner Person" },
      status: "listed",
    });
    expect(Envelope.safeParse(first.items[0]?.envelope).success).toBe(true);
    const rest = value(
      await listChangeItems(db(), {
        ...l.as(l.owner.id),
        limit: 2,
        cursor: first.nextCursor ?? "",
      }),
    );
    expect(rest.items.map((item) => item.id)).toEqual([`chg_${l.doc.artifactId}_2`]);
    expect(rest.nextCursor).toBeNull();
    expect(
      await listChangeItems(db(), { ...l.as(l.owner.id), limit: 2, cursor: "!" }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("names a deleted account as such, and keeps a later envelope format as it comes", async () => {
    const l = await listed(1);
    await db()
      .update(schema.changeItems)
      .set({ submittedBy: null })
      .where(eq(schema.changeItems.artifactId, l.doc.artifactId));
    const later = JSON.stringify({ format: 2, anything: "new" });
    await db()
      .insert(schema.changeItems)
      .values({
        id: `chg_${l.doc.artifactId}_later`,
        artifactId: l.doc.artifactId,
        ownerId: l.owner.id,
        origin: "draft",
        versionId: l.doc.versionId,
        path: "index.md",
        envelope: later,
        bytes: later.length,
        reason: "not_text",
        createdAt: NOW + 50,
      });
    const page = value(await listChangeItems(db(), { ...l.as(l.owner.id), limit: 10 }));
    expect(page.items[0]?.envelope).toMatchObject({ provenance: { submittedBy: DELETED_ACCOUNT } });
    expect(page.items[1]?.envelope).toEqual({ format: 2, anything: "new" });
  });

  it("refuses a reader, and answers a token or a stranger as a missing artifact", async () => {
    const l = await listed(1);
    const reader = await user("Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: l.doc.artifactId, email: reader.email });
    expect(await listChangeItems(db(), { ...l.as(reader.id), limit: 10 })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(
      await listChangeItems(db(), { ...l.as("st_00000000000000000000"), limit: 10 }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await listChangeItems(db(), { ...l.as((await user("Stranger")).id), limit: 10 }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("answers nobody for a held artifact", async () => {
    const l = await listed(1);
    value(await suspendArtifact(db(), { artifactId: l.doc.artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId: l.doc.artifactId,
        ground: "order",
        releaseAt: null,
        now: NOW,
      }),
    );
    const refused = await listChangeItems(db(), { ...l.as(l.owner.id), limit: 10 });
    expect(refused.ok).toBe(false);
    expect(
      await markChangeItem(db(), {
        ...l.as(l.owner.id),
        itemId: `chg_${l.doc.artifactId}_0`,
        state: "dismissed",
        baseRevision: 1,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("marking items", () => {
  it("marks, records it, and refuses a stale revision", async () => {
    const l = await listed(1);
    const itemId = `chg_${l.doc.artifactId}_0`;
    const applied = value(
      await markChangeItem(db(), {
        ...l.as(l.owner.id),
        itemId,
        state: "applied",
        baseRevision: 1,
      }),
    );
    expect(applied).toMatchObject({ state: "applied", revision: 2, closedVersionId: null });
    expect(
      await markChangeItem(db(), { ...l.as(l.owner.id), itemId, state: "open", baseRevision: 1 }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    const same = value(
      await markChangeItem(db(), {
        ...l.as(l.owner.id),
        itemId,
        state: "applied",
        baseRevision: 2,
      }),
    );
    expect(same.revision).toBe(2);
    const reopened = value(
      await markChangeItem(db(), { ...l.as(l.owner.id), itemId, state: "open", baseRevision: 2 }),
    );
    expect(reopened).toMatchObject({ state: "open", closedAt: null, revision: 3 });
    expect(
      (await auditKinds(l.doc.artifactId)).filter((k) => k === "change_item.marked"),
    ).toHaveLength(2);
    expect(
      await markChangeItem(db(), {
        ...l.as(l.owner.id),
        itemId: "nope",
        state: "open",
        baseRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a reader and a token", async () => {
    const l = await listed(1);
    const itemId = `chg_${l.doc.artifactId}_0`;
    expect(
      await markChangeItem(db(), {
        ...l.as("st_00000000000000000000"),
        itemId,
        state: "dismissed",
        baseRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const reader = await user("Reader");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: l.doc.artifactId, email: reader.email });
    expect(
      await markChangeItem(db(), {
        ...l.as(reader.id),
        itemId,
        state: "dismissed",
        baseRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("reopens only while the list has room", async () => {
    const l = await listed(1);
    const itemId = `chg_${l.doc.artifactId}_0`;
    value(
      await markChangeItem(db(), {
        ...l.as(l.owner.id),
        itemId,
        state: "dismissed",
        baseRevision: 1,
      }),
    );
    const envelope = '{"format":1}';
    await db().run(
      sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${CHANGE_LIST_LIMITS.openPerArtifact}) insert into ${schema.changeItems} (id, artifact_id, owner_id, origin, version_id, path, envelope, bytes, reason, state, created_at, revision) select 'fill_' || ${l.doc.artifactId} || '_' || i, ${l.doc.artifactId}, ${l.owner.id}, 'draft', ${l.doc.versionId}, 'index.md', ${envelope}, ${envelope.length}, 'spans_nodes', 'open', ${NOW}, 1 from n`,
    );
    expect(
      await markChangeItem(db(), { ...l.as(l.owner.id), itemId, state: "open", baseRevision: 2 }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });
});
