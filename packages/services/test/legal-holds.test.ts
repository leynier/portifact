// Legal holds (docs/operations.md, "Legal holds"): every way an artifact can be deleted, moved,
// pruned, brought back into service or read is tried on a held one, and each must leave it as it
// was until the hold is released; then the deletions that waited go on.
import { env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { accessSchema, createAccessDb, regionsFromEnv, schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { eraseAccessEvents, getAccessLog, pruneAccessEvents } from "../src/access-log.ts";
import {
  advanceAccountDeletion,
  exportAccount,
  processAccountDeletions,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { actorOn } from "../src/actors.ts";
import { getArtifactStats } from "../src/analytics.ts";
import {
  createAnnotationThread,
  exportAnnotations,
  getAnnotationThread,
  listAnnotationHistory,
  listAnnotations,
} from "../src/annotations.ts";
import { eraseApprovalAuthor, getApprovalReview } from "../src/approval-reviews.ts";
import { getArtifact } from "../src/artifacts.ts";
import { applyTombstones } from "../src/backups.ts";
import { listOpenFeedback } from "../src/feedback.ts";
import { eraseAccountTraces, historyHeld, pruneGoneHistory } from "../src/history-retention.ts";
import {
  applyLegalHolds,
  exportLegalHolds,
  heldArtifactIds,
  holdIdentities,
  isHeld,
  listLegalHolds,
  placeLegalHold,
  releaseDueHolds,
  releaseLegalHold,
  runHoldRelease,
} from "../src/legal-holds.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { archiveExpired, pruneVersions, purgeArchived } from "../src/maintenance.ts";
import {
  reinstateAccount,
  reinstateArtifact,
  suspendAccount,
  suspendArtifact,
} from "../src/moderation.ts";
import { runJob } from "../src/outbox.ts";
import { readVersionFile } from "../src/read-file.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { compareVersions } from "../src/version-diff.ts";
import { getVersionDownload } from "../src/versions.ts";
import { advanceWorkspaceDeletion, createWorkspace, deleteWorkspace } from "../src/workspaces.ts";
import {
  artifactRow,
  DAY,
  db,
  grantPlan,
  NOW,
  publishSite,
  racing,
  session,
  user,
  value,
} from "./fixtures.ts";
import { recording } from "./recording.ts";

const regions = () => regionsFromEnv(env);

async function heldArtifact(ownerId: string, publishedAt = NOW) {
  const published = await publishSite(ownerId, undefined, publishedAt);
  value(
    await suspendArtifact(db(), {
      artifactId: published.artifactId,
      reason: "child_safety",
      now: NOW,
    }),
  );
  const hold = value(
    await placeLegalHold(db(), {
      artifactId: published.artifactId,
      ground: "Preservation request of an authority, case 123",
      releaseAt: null,
      now: NOW,
    }),
  );
  return { ...published, hold: hold.hold };
}

/** Runs every purge job in the outbox until none is left. */
async function drainPurges(now: number) {
  for (let round = 0; round < 5; round += 1) {
    const rows = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "purge_artifact"));
    if (rows.length === 0) return;
    for (const row of rows) {
      await runJob(db(), env.ARTIFACTS, { id: row.id, topic: row.topic } as JobMessage, now, {
        access: regions().get("default").accessDb,
      });
    }
  }
}

describe("placing a hold", () => {
  it("holds only a suspended artifact, once, and records the owner's address", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const refused = await placeLegalHold(db(), {
      artifactId,
      ground: "Authority request",
      releaseAt: null,
      now: NOW,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_input" });
    value(await suspendArtifact(db(), { artifactId, reason: "child_safety", now: NOW }));
    expect(
      await placeLegalHold(db(), { artifactId, ground: "x", releaseAt: NOW, now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await placeLegalHold(db(), { artifactId, ground: "  ", releaseAt: null, now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const placed = value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Authority request",
        releaseAt: null,
        now: NOW,
      }),
    );
    expect(placed.changed).toBe(true);
    expect(placed.hold).toMatchObject({
      ownerId: owner.id,
      ownerEmail: owner.email,
      reason: "child_safety",
    });
    const again = value(
      await placeLegalHold(db(), { artifactId, ground: "Another", releaseAt: null, now: NOW + 1 }),
    );
    expect(again).toMatchObject({ changed: false, hold: { id: placed.hold.id } });
    expect(await isHeld(db(), artifactId)).toBe(true);
    expect(
      await placeLegalHold(db(), {
        artifactId: "zzzzzzzzzz",
        ground: "x",
        releaseAt: null,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("lists open holds, and released ones with --all, and releases at the release date", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "malware", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Until a date",
        releaseAt: NOW + DAY,
        now: NOW,
      }),
    );
    expect(
      (await listLegalHolds(db(), { all: false, limit: 500 })).map((h) => h.artifactId),
    ).toContain(artifactId);
    expect(await releaseDueHolds(db(), NOW + DAY - 1)).toBeGreaterThanOrEqual(0);
    expect(await isHeld(db(), artifactId)).toBe(true);
    await releaseDueHolds(db(), NOW + DAY);
    expect(await isHeld(db(), artifactId)).toBe(false);
    const all = await listLegalHolds(db(), { all: true, limit: 500 });
    expect(all.find((h) => h.artifactId === artifactId)).toMatchObject({
      releasedAt: NOW + DAY,
      ownerEmail: null,
    });
    expect(
      (await listLegalHolds(db(), { all: false, limit: 500 })).some(
        (h) => h.artifactId === artifactId,
      ),
    ).toBe(false);
  });
});

describe("while an artifact is held", () => {
  it("refuses the owner's deletion without saying why, and allows it after the release", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    const refused = await deleteArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId,
      now: NOW,
    });
    expect(refused).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    expect(HELD_MESSAGE).not.toMatch(/hold|legal|authorit/i);
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
    expect(await releaseLegalHold(db(), { artifactId, now: NOW + 1 })).toEqual({ released: true });
    expect(await releaseLegalHold(db(), { artifactId, now: NOW + 1 })).toEqual({ released: false });
    expect(
      (await deleteArtifact(db(), env.ARTIFACTS, { userId: owner.id, artifactId, now: NOW + 2 }))
        .ok,
    ).toBe(true);
  });

  it("writes no deletion event when a hold lands between the check and the claim", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "child_safety", now: NOW }));
    const raced = racing(() =>
      placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    expect(
      await deleteArtifact(raced, env.ARTIFACTS, { userId: owner.id, artifactId, now: NOW }),
    ).toEqual({
      ok: false,
      code: "forbidden",
      message: HELD_MESSAGE,
    });
    const audit = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.artifactId, artifactId));
    expect(audit.filter((row) => row.kind === "artifact.deleted")).toEqual([]);
    const lifecycle = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, artifactId));
    expect(lifecycle.map((row) => row.event)).toEqual(["published", "suspended"]);
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, artifactId));
    expect(jobs.map((job) => job.topic)).not.toContain("purge_artifact");
  });

  it("refuses a held deletion before writing anything, in a fixed number of reads", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    const other = await user();
    const { artifactId: otherId } = await heldArtifact(other.id);
    const measure = async (userId: string, id: string) => {
      const { database, count } = recording();
      const result = await deleteArtifact(database, env.ARTIFACTS, {
        userId,
        artifactId: id,
        now: NOW,
      });
      return { result, calls: count() };
    };
    const first = await measure(owner.id, artifactId);
    expect(first.result).toMatchObject({ code: "forbidden" });
    // Without the service's own check, the claim batch would run and add a call.
    expect(first.calls).toBe((await measure(other.id, otherId)).calls);
    // The artifact with its role in one read, then the hold: no batch is written.
    expect(first.calls).toBe(2);
  });

  it("serves its content to nobody, its owner included", async () => {
    const owner = await user();
    const { artifactId, versionId } = await heldArtifact(owner.id);
    expect(
      await getVersionDownload(db(), {
        userId: owner.id,
        artifactId,
        versionId,
        kind: "published",
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    expect(
      await compareVersions(db(), {
        userId: owner.id,
        artifactId,
        fromVersionId: versionId,
        toVersionId: versionId,
        limit: 10,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    // A suspended artifact that is not held still downloads for its owner.
    const other = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId: other.artifactId, reason: "spam", now: NOW }));
    expect(
      (
        await getVersionDownload(db(), {
          userId: owner.id,
          artifactId: other.artifactId,
          versionId: other.versionId,
          kind: "published",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("is not reinstated, alone or with its account, until released", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    expect(await reinstateArtifact(db(), { artifactId, now: NOW + 1 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const other = await publishSite(owner.id);
    value(await suspendAccount(db(), { userId: owner.id, reason: "spam", now: NOW + 2 }));
    const back = value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 3 }));
    expect(back).toMatchObject({ artifacts: 1, held: 0 });
    expect(await artifactRow(other.artifactId)).toMatchObject({ state: "active" });
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
    await releaseLegalHold(db(), { artifactId, now: NOW + 4 });
    expect(value(await reinstateArtifact(db(), { artifactId, now: NOW + 5 }))).toMatchObject({
      changed: true,
    });
  });

  it("keeps a held child of an account suspension suspended when the account comes back", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendAccount(db(), { userId: owner.id, reason: "child_safety", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    const back = value(await reinstateAccount(db(), { userId: owner.id, now: NOW + 1 }));
    expect(back).toEqual({ artifacts: 0, changed: true, held: 1 });
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended" });
  });

  it("is not moved to another space", async () => {
    const owner = await user();
    const { artifactId } = await heldArtifact(owner.id);
    const slug = `h-${crypto.randomUUID().slice(0, 8)}`;
    value(
      await createWorkspace(db().global, {
        slug,
        name: "Elsewhere",
        adminUserId: owner.id,
        now: NOW,
      }),
    );
    const moved = await transferArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId,
      workspace: slug,
      now: NOW,
    });
    expect(moved.ok).toBe(false);
    expect(await artifactRow(artifactId)).toMatchObject({ ownerId: owner.id });
  });

  it("is never archived, purged or pruned by maintenance", async () => {
    const owner = await user();
    const first = await publishSite(owner.id, undefined, NOW - 200 * DAY);
    await publishSite(owner.id, { "index.html": "<p>second</p>" }, NOW - 199 * DAY, first);
    value(
      await suspendArtifact(db(), { artifactId: first.artifactId, reason: "malware", now: NOW }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: first.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    await archiveExpired(db(), NOW + 400 * DAY);
    await purgeArchived(db(), env.ARTIFACTS, NOW + 400 * DAY);
    await pruneVersions(db(), env.ARTIFACTS, NOW + 400 * DAY, 500);
    expect(await artifactRow(first.artifactId)).toMatchObject({ state: "suspended" });
    const [kept] = await db()
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(eq(schema.versions.id, first.versionId));
    expect(kept?.id).toBe(first.versionId);
    // Released, the old version is pruned again.
    await releaseLegalHold(db(), { artifactId: first.artifactId, now: NOW + 400 * DAY });
    await pruneVersions(db(), env.ARTIFACTS, NOW + 400 * DAY, 500);
    const [gone] = await db()
      .select({ id: schema.versions.id })
      .from(schema.versions)
      .where(eq(schema.versions.id, first.versionId));
    expect(gone).toBeUndefined();
  });

  it("is protected by the database even from a path the services miss", async () => {
    const owner = await user();
    const { artifactId, versionId } = await heldArtifact(owner.id);
    const a = schema.artifacts;
    await expect(
      db().update(a).set({ state: "purging" }).where(eq(a.id, artifactId)),
    ).rejects.toThrow();
    await expect(
      db().update(a).set({ ownerId: "someone" }).where(eq(a.id, artifactId)),
    ).rejects.toThrow();
    await expect(db().delete(a).where(eq(a.id, artifactId))).rejects.toThrow();
    await expect(
      db().delete(schema.versions).where(eq(schema.versions.id, versionId)),
    ).rejects.toThrow();
    // An artifact that is not suspended cannot be held at all.
    const served = await publishSite(owner.id);
    await expect(
      db().run(
        sql`insert into legal_holds (id, artifact_id, owner_id, reason, ground) values ('hold_x', ${served.artifactId}, ${owner.id}, 'spam', 'x')`,
      ),
    ).rejects.toThrow();
    expect(await artifactRow(artifactId)).toMatchObject({ state: "suspended", ownerId: owner.id });
  });
});

/** A team workspace with an admin, an editor, a member and two of its artifacts, one held. */
async function heldInWorkspace() {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const slug = `t${id.slice(3, 22)}`;
  const [admin, editor, member] = [await user("Admin"), await user("Editor"), await user("Member")];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(id, "team", { seats: 5 });
  const reader = await user("Reader");
  const artifacts: { artifactId: string; versionId: string }[] = [];
  for (let i = 0; i < 2; i += 1) {
    const published = await publishSite(editor.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: editor.id,
        artifactId: published.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: published.artifactId, email: reader.email });
    value(
      await suspendArtifact(db(), {
        artifactId: published.artifactId,
        reason: "spam",
        statement: {
          facts: "Spam pages.",
          ground: "AUP: spam.",
          source: "review",
          withhold: false,
        },
        now: NOW,
      }),
    );
    artifacts.push(published);
  }
  const [held, suspended] = artifacts as [(typeof artifacts)[0], (typeof artifacts)[0]];
  value(
    await placeLegalHold(db(), {
      artifactId: held.artifactId,
      ground: "Authority",
      releaseAt: null,
      now: NOW,
    }),
  );
  const token = (restriction: { kind: "none" } | { kind: "key"; prefix: string }) =>
    createServiceToken(db().global, {
      userId: admin.id,
      slug,
      body: {
        label: "CI",
        role: "editor",
        scopes: ["artifacts:read", "artifacts:write"],
        expiresInDays: 30,
        restriction,
      },
      now: NOW,
    }).then((created) => value(created).token.id);
  return {
    held,
    suspended,
    admin,
    editor,
    member,
    reader,
    keyToken: await token({ kind: "key", prefix: "elsewhere/" }),
    fullToken: await token({ kind: "none" }),
  };
}

/** Every read of a held artifact's comments, history, review, access log and analytics. */
function managedReads(database: ReturnType<typeof db>, userId: string, artifactId: string) {
  const access = createAccessDb(env.ACCESS_DB);
  const base = { userId, artifactId, now: NOW };
  return {
    list: () => listAnnotations(database, { ...base, limit: 10, version: "all" }),
    export: () => exportAnnotations(database, { ...base, version: "all" }),
    thread: () => getAnnotationThread(database, { ...base, threadId: "th_none" }),
    history: () => listAnnotationHistory(database, { ...base, limit: 10 }),
    review: () => getApprovalReview(database, base),
    accessLog: () => getAccessLog(database, access, { ...base, limit: 10 }),
    stats: () => getArtifactStats(database, access, base),
  };
}

describe("a held artifact's records are read by nobody but the operator", () => {
  it("refuses its comments, history, review, access log and analytics to the people who manage it", async () => {
    const owner = await user();
    await grantPlan(owner.id, "team");
    const { artifactId } = await heldArtifact(owner.id);
    for (const [name, read] of Object.entries(managedReads(db(), owner.id, artifactId))) {
      expect(await read(), name).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    }
    // The space's open feedback leaves it out.
    const actor = value(await actorOn(db().global, owner.id, owner.id));
    if (!actor) throw new Error("no actor");
    const feedback = value(await listOpenFeedback(db(), { actor, limit: 50, now: NOW }));
    expect(feedback.items.some((item) => item.artifact.id === artifactId)).toBe(false);
  });

  it("leaves a held artifact's comments out of its owner's account export", async () => {
    const owner = await user();
    const { artifactId, versionId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    value(
      await createAnnotationThread(db(), {
        humanCheck: { token: "solved", verify: async () => "passed" },
        userId: owner.id,
        artifactId,
        versionId,
        target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
        body: "Held words",
        now: NOW,
      }),
    );
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    const before = await exportAccount(db(), { userId: owner.id, now: NOW });
    expect(JSON.stringify(before)).toContain("Held words");
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    const after = await exportAccount(db(), { userId: owner.id, now: NOW });
    expect(JSON.stringify(after)).not.toContain("Held words");
  });

  it("answers everyone else exactly as for a suspended twin, with the same reads", async () => {
    const w = await heldInWorkspace();
    const stranger = await user("Stranger");
    for (const userId of [stranger.id, w.reader.id, w.member.id, w.keyToken, ""]) {
      const run = async (artifactId: string) => {
        const results: Record<string, unknown> = {};
        let calls = 0;
        for (const [name, read] of Object.entries(managedReads(db(), userId, artifactId))) {
          const { database, count } = recording();
          results[name] = await managedReads(database, userId, artifactId)[name as "list"]();
          calls += count();
          void read;
        }
        return { results, calls };
      };
      const held = await run(w.held.artifactId);
      expect(held, userId || "anonymous").toEqual(await run(w.suspended.artifactId));
    }
  });
});

describe("a hold is invisible to everyone who does not manage the artifact", () => {
  it("answers a stranger, a reader, a member, an out-of-reach token and an anonymous caller as for a missing artifact, with the same reads", async () => {
    const w = await heldInWorkspace();
    const stranger = await user("Stranger");
    const callers = [stranger.id, w.reader.id, w.member.id, w.keyToken, ""];
    const ask = async (
      userId: string,
      artifactId: string,
      versionId: string,
      kind: "published" | "source",
    ) => {
      const { database, count } = recording();
      const download = await getVersionDownload(database, {
        userId,
        artifactId,
        versionId,
        kind,
        now: NOW,
      });
      const read = await readVersionFile(database, env.ARTIFACTS, {
        userId,
        artifactId,
        versionId,
        kind,
        offset: 0,
        now: NOW,
      });
      return { download, read, calls: count() };
    };
    for (const userId of callers) {
      for (const kind of ["published", "source"] as const) {
        const held = await ask(userId, w.held.artifactId, w.held.versionId, kind);
        const suspended = await ask(userId, w.suspended.artifactId, w.suspended.versionId, kind);
        const missing = await ask(userId, "zzzzzzzzzz", w.held.versionId, kind);
        expect(held, `${userId || "anonymous"} ${kind}`).toEqual(suspended);
        expect(held.download, userId).toEqual(missing.download);
        expect(held.read, userId).toEqual(missing.read);
        expect(held.download).toMatchObject({ ok: false, code: "not_found" });
      }
    }
    // The people who manage it learn only that it cannot be read now.
    for (const userId of [w.admin.id, w.editor.id, w.fullToken]) {
      expect(
        await getVersionDownload(db(), {
          userId,
          artifactId: w.held.artifactId,
          versionId: w.held.versionId,
          kind: "published",
          now: NOW,
        }),
      ).toEqual({ ok: false, code: "forbidden", message: HELD_MESSAGE });
    }
  });

  it("answers comparison and deletion by anyone who does not manage it as for a suspended twin", async () => {
    const w = await heldInWorkspace();
    const stranger = await user("Stranger");
    for (const userId of [stranger.id, w.member.id, w.keyToken]) {
      const compare = (artifact: { artifactId: string; versionId: string }) =>
        compareVersions(db(), {
          userId,
          artifactId: artifact.artifactId,
          fromVersionId: artifact.versionId,
          toVersionId: artifact.versionId,
          limit: 10,
          now: NOW,
        });
      const held = await compare(w.held);
      expect(held).not.toMatchObject({ message: HELD_MESSAGE });
      expect(held).toEqual(await compare(w.suspended));
      const del = (artifactId: string) =>
        deleteArtifact(db(), env.ARTIFACTS, { userId, artifactId, now: NOW });
      const deleted = await del(w.held.artifactId);
      expect(deleted).not.toMatchObject({ message: HELD_MESSAGE });
      expect(deleted.ok).toBe(false);
    }
    expect(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: stranger.id,
        artifactId: w.held.artifactId,
        now: NOW,
      }),
    ).toEqual(
      await deleteArtifact(db(), env.ARTIFACTS, {
        userId: stranger.id,
        artifactId: "zzzzzzzzzz",
        now: NOW,
      }),
    );
  });
});

describe("the statement of reasons on the artifact's view", () => {
  it("is for the admins and editors who manage it; a service token gets the category only", async () => {
    const w = await heldInWorkspace();
    for (const userId of [w.admin.id, w.editor.id]) {
      const viewed = value(await getArtifact(db(), { userId, artifactId: w.suspended.artifactId }));
      expect(viewed.statement).toMatchObject({ facts: "Spam pages." });
    }
    const asToken = value(
      await getArtifact(db(), { userId: w.fullToken, artifactId: w.suspended.artifactId }),
    );
    expect(asToken.suspensionReason).toBe("spam");
    expect(asToken.statement).toBeNull();
  });
});

describe("who a hold keeps", () => {
  it("keeps the creator's and each publisher's email past their account's deletion, erased at release and never exported", async () => {
    const admin = await user("Admin");
    const editor = await user("Editor");
    const slug = `i-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Ids", adminUserId: editor.id, now: NOW }),
    );
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: admin.id, role: "admin", updatedAt: NOW });
    await grantPlan(ws.id, "team", { seats: 5 });
    const first = await publishSite(editor.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: editor.id,
        artifactId: first.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );
    await db()
      .update(schema.versions)
      .set({ authorId: admin.id })
      .where(eq(schema.versions.id, first.versionId));
    await db()
      .insert(schema.versions)
      .values({
        id: `ver_${crypto.randomUUID().replaceAll("-", "")}`,
        artifactId: first.artifactId,
        number: 2,
        authorId: editor.id,
        state: "committed",
        entrypoint: "index.html",
        publishedBytes: 1,
        sourceBytes: 0,
        createdAt: NOW,
      });
    value(
      await suspendArtifact(db(), {
        artifactId: first.artifactId,
        reason: "child_safety",
        now: NOW,
      }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: first.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    const kept = await holdIdentities(db(), first.artifactId);
    expect(kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "creator", actorId: editor.id, email: editor.email }),
        expect.objectContaining({ role: "publisher", actorId: admin.id, email: admin.email }),
        expect.objectContaining({ role: "publisher", actorId: editor.id, email: editor.email }),
      ]),
    );
    // The uploader's account goes; the hold still names them.
    await db().global.delete(schema.users).where(eq(schema.users.id, admin.id));
    expect(
      (await holdIdentities(db(), first.artifactId)).some((row) => row.email === admin.email),
    ).toBe(true);
    // The restore file never carries an address.
    const lines = (await exportLegalHolds(regions())).filter(
      (l) => l.legalHold.artifactId === first.artifactId,
    );
    expect(JSON.stringify(lines)).not.toContain("@example.test");
    const holdId = (await holdIdentities(db(), first.artifactId))[0]?.holdId ?? "";
    await releaseLegalHold(db(), { artifactId: first.artifactId, now: NOW + 1 });
    // Read directly, not through the open holds: the rows themselves are gone.
    expect(
      await db()
        .select()
        .from(schema.legalHoldIdentities)
        .where(eq(schema.legalHoldIdentities.holdId, holdId)),
    ).toEqual([]);
  });

  it("captures them again when a restore puts a hold back", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const lines = (await exportLegalHolds(regions())).filter(
      (l) => l.legalHold.artifactId === held.artifactId,
    );
    await db().delete(schema.legalHoldIdentities);
    await db().delete(schema.legalHolds).where(eq(schema.legalHolds.artifactId, held.artifactId));
    await applyLegalHolds(regions(), lines, NOW + 1);
    expect(await holdIdentities(db(), held.artifactId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "owner", email: owner.email })]),
    );
    await releaseDueHolds(db(), NOW);
  });
});

describe("a held artifact's evidence", () => {
  const access = () => createAccessDb(env.ACCESS_DB);
  async function logged(artifactId: string, userId: string, expiresAt: number) {
    await access()
      .insert(accessSchema.accessEvents)
      .values({
        artifactId,
        windowStart: NOW - DAY,
        userId,
        ownerId: "u_owner",
        email: `${userId}@example.test`,
        openedAt: NOW - DAY,
        expiresAt,
      });
    await access()
      .insert(accessSchema.artifactViews)
      .values({
        artifactId,
        day: NOW - DAY,
        ownerId: "u_owner",
        views: 1,
        signedInViews: 1,
        expiresAt,
      })
      .onConflictDoNothing();
  }
  const eventsOf = (artifactId: string) =>
    access()
      .select()
      .from(accessSchema.accessEvents)
      .where(eq(accessSchema.accessEvents.artifactId, artifactId));
  const viewsOf = (artifactId: string) =>
    access()
      .select()
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.artifactId, artifactId));

  it("keeps its access log and analytics past their expiry and a visitor's deletion, until the release", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const free = await publishSite(owner.id);
    for (const id of [held.artifactId, free.artifactId]) await logged(id, "u_visitor", NOW - 1);
    const holds = await heldArtifactIds(db());
    expect(holds).toContain(held.artifactId);
    await pruneAccessEvents(access(), NOW, 10, holds);
    expect(await eventsOf(held.artifactId)).toHaveLength(1);
    expect(await viewsOf(held.artifactId)).toHaveLength(1);
    expect(await eventsOf(free.artifactId)).toEqual([]);
    // A visitor's account deletion leaves their openings of the held artifact.
    await logged(free.artifactId, "u_visitor", NOW + DAY);
    await eraseAccessEvents(access(), "user", "u_visitor", 10, holds);
    expect(await eventsOf(held.artifactId)).toHaveLength(1);
    expect(await eventsOf(free.artifactId)).toEqual([]);
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW });
    await pruneAccessEvents(access(), NOW, 10, await heldArtifactIds(db()));
    expect(await eventsOf(held.artifactId)).toEqual([]);
  });

  it("keeps a held artifact's openings when an account's erasure runs as its job", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const free = await publishSite(owner.id);
    const visitor = `u_visitor_${crypto.randomUUID()}`;
    for (const id of [held.artifactId, free.artifactId]) await logged(id, visitor, NOW + DAY);
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "erase_access_events",
        payload: { kind: "user" },
        availableAt: NOW,
        createdAt: NOW,
        subject: visitor,
      })
      .returning();
    await runJob(
      db(),
      env.ARTIFACTS,
      { id: row?.id ?? 0, topic: "erase_access_events" } as JobMessage,
      NOW,
      {
        access: access(),
      },
    );
    expect(await eventsOf(held.artifactId)).toHaveLength(1);
    expect(await eventsOf(free.artifactId)).toEqual([]);
  });

  it("keeps a deleted commenter's words and verdicts until the release, then erases them", async () => {
    const owner = await user();
    const commenter = await user("Commenter");
    const { artifactId, versionId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open", accessMode: "restricted" })
      .where(eq(schema.artifacts.id, artifactId));
    await db().insert(schema.artifactReaders).values({ artifactId, email: commenter.email });
    value(
      await createAnnotationThread(db(), {
        humanCheck: { token: "solved", verify: async () => "passed" },
        userId: commenter.id,
        artifactId,
        versionId,
        target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
        body: "Evidence in this comment",
        now: NOW,
      }),
    );
    const requestId = `rr_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(schema.reviewRequests)
      .values({ id: requestId, artifactId, versionId, updatedAt: NOW });
    await db().insert(schema.reviewVerdicts).values({
      requestId,
      email: commenter.email,
      versionId,
      authorId: commenter.id,
      verdict: "changes",
      updatedAt: NOW,
    });
    const verdicts = () =>
      db()
        .select()
        .from(schema.reviewVerdicts)
        .where(eq(schema.reviewVerdicts.authorId, commenter.id));
    value(await suspendArtifact(db(), { artifactId, reason: "child_safety", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    value(
      await requestAccountDeletion(regions(), {
        userId: commenter.id,
        sessionId: await session(commenter.id),
        confirmEmail: commenter.email,
        now: NOW,
      }),
    );
    let state = await advanceAccountDeletion(regions(), commenter.id, NOW + 1);
    for (let i = 0; i < 3 && state !== "finished"; i += 1)
      state = await advanceAccountDeletion(regions(), commenter.id, NOW + 2);
    expect(state).toBe("finished");
    const m = schema.annotationMessages;
    const words = () =>
      db().select({ body: m.body, state: m.state }).from(m).where(eq(m.authorId, commenter.id));
    expect((await words()).map((row) => row.body)).toEqual(["Evidence in this comment"]);
    expect(await verdicts()).toHaveLength(1);
    // A restore that re-applies the deletion, with holds put back first, keeps them too.
    await applyTombstones(
      regions(),
      [{ kind: "account", id: commenter.id, deletedAt: NOW }],
      NOW + 2,
    );
    await advanceAccountDeletion(regions(), commenter.id, NOW + 2);
    expect((await words()).map((row) => row.body)).toEqual(["Evidence in this comment"]);
    expect(await verdicts()).toHaveLength(1);
    // Released: the job the release wrote erases what the deletion deferred, once.
    await releaseLegalHold(db(), { artifactId, now: NOW + 3 });
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, artifactId));
    const release = jobs.filter((job) => job.topic === "legal_hold_release");
    expect(release).toHaveLength(1);
    for (const job of release) {
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic } as JobMessage, NOW + 4, {
        access: regions().get("default").accessDb,
      });
    }
    expect((await words()).filter((row) => row.state !== "deleted" && row.body !== null)).toEqual(
      [],
    );
    expect(await verdicts()).toEqual([]);
  });
});

describe("what a release erases", () => {
  it("keeps the words and verdict of a commenter whose account still exists", async () => {
    const w = await heldWithThread();
    const reviewer = await user("Reviewer");
    const rq = schema.reviewRequests;
    const requestId = `rr_${crypto.randomUUID().replaceAll("-", "")}`;
    await db().insert(rq).values({
      id: requestId,
      artifactId: w.artifactId,
      versionId: w.versionId,
      requestedBy: reviewer.id,
      updatedAt: NOW,
    });
    await db().insert(schema.reviewVerdicts).values({
      requestId,
      email: reviewer.email,
      versionId: w.versionId,
      authorId: reviewer.id,
      verdict: "approve",
      updatedAt: NOW,
    });
    await releaseLegalHold(db(), { artifactId: w.artifactId, now: NOW + 1 });
    expect(await runHoldRelease(db(), undefined, w.artifactId, NOW + 2)).toBe("done");
    const m = schema.annotationMessages;
    expect(
      (await db().select().from(m).where(eq(m.threadId, w.threadId))).map((row) => row.body),
    ).toEqual(["Owner's question"]);
    expect(
      await db()
        .select()
        .from(schema.reviewVerdicts)
        .where(eq(schema.reviewVerdicts.requestId, requestId)),
    ).toHaveLength(1);
    expect((await db().select().from(rq).where(eq(rq.id, requestId)))[0]?.requestedBy).toBe(
      reviewer.id,
    );
  });

  it("does nothing while the artifact is held again", async () => {
    const w = await heldWithThread();
    const m = schema.annotationMessages;
    const [first] = await db().select().from(m).where(eq(m.threadId, w.threadId));
    await db()
      .insert(m)
      .values({
        ...(first as typeof m.$inferInsert),
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        authorId: w.gone.id,
        body: "Gone's words",
        createdAt: NOW + 1,
      });
    await releaseLegalHold(db(), { artifactId: w.artifactId, now: NOW + 2 });
    value(
      await placeLegalHold(db(), {
        artifactId: w.artifactId,
        ground: "Again",
        releaseAt: null,
        now: NOW + 3,
      }),
    );
    expect(await runHoldRelease(db(), undefined, w.artifactId, NOW + 4)).toBe("done");
    expect(
      (await db().select().from(m).where(eq(m.threadId, w.threadId))).map((row) => row.body),
    ).toContain("Gone's words");
  });

  it("is written by the release at the release date", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Authority",
        releaseAt: NOW + DAY,
        now: NOW,
      }),
    );
    await releaseDueHolds(db(), NOW + DAY);
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, artifactId));
    expect(jobs.map((job) => job.topic)).toEqual(["legal_hold_release"]);
  });

  async function heldWithThread() {
    const owner = await user();
    const gone = await user("Gone");
    const { artifactId, versionId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    const thread = value(
      await createAnnotationThread(db(), {
        humanCheck: { token: "solved", verify: async () => "passed" },
        userId: owner.id,
        artifactId,
        versionId,
        target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
        body: "Owner's question",
        now: NOW,
      }),
    ) as unknown as { id: string };
    value(await suspendArtifact(db(), { artifactId, reason: "spam", now: NOW }));
    value(
      await placeLegalHold(db(), { artifactId, ground: "Authority", releaseAt: null, now: NOW }),
    );
    await db()
      .global.insert(schema.tombstones)
      .values({ kind: "account", id: gone.id, deletedAt: NOW });
    return { owner, gone, artifactId, versionId, threadId: thread.id };
  }

  it("erases a deleted account's lone message-deleted marker nobody replied to", async () => {
    const w = await heldWithThread();
    const m = schema.annotationMessages;
    const [first] = await db().select().from(m).where(eq(m.threadId, w.threadId));
    const markerId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    await db()
      .insert(m)
      .values({
        ...(first as typeof m.$inferInsert),
        id: markerId,
        authorId: w.gone.id,
        state: "deleted",
        body: null,
        bodyBytes: 0,
        createdAt: NOW + 1,
      });
    await releaseLegalHold(db(), { artifactId: w.artifactId, now: NOW + 2 });
    expect(await runHoldRelease(db(), undefined, w.artifactId, NOW + 3)).toBe("done");
    // Gone, as an account deletion's erasure leaves it, not merely renamed to `deleted`.
    expect(await db().select().from(m).where(eq(m.id, markerId))).toEqual([]);
  });

  it("leaves a held review request's requester until the release, then forgets a deleted one", async () => {
    const w = await heldWithThread();
    const rq = schema.reviewRequests;
    const id = `rr_${crypto.randomUUID().replaceAll("-", "")}`;
    await db().insert(rq).values({
      id,
      artifactId: w.artifactId,
      versionId: w.versionId,
      requestedBy: w.gone.id,
      updatedAt: NOW,
    });
    await db().batch(eraseApprovalAuthor(db(), w.gone.id) as never);
    expect((await db().select().from(rq).where(eq(rq.id, id)))[0]?.requestedBy).toBe(w.gone.id);
    await releaseLegalHold(db(), { artifactId: w.artifactId, now: NOW + 1 });
    await runHoldRelease(db(), undefined, w.artifactId, NOW + 2);
    expect((await db().select().from(rq).where(eq(rq.id, id)))[0]?.requestedBy).toBeNull();
  });
});

describe("a held artifact's history", () => {
  it("keeps its lifecycle, suspension and moderation records and a deleted actor's traces while held", async () => {
    const owner = await user();
    const actor = await user("Actor");
    const held = await heldArtifact(owner.id);
    // Records of the held artifact, from a year and more ago, and an actor who deleted their account.
    const le = schema.lifecycleEvents;
    await db()
      .insert(le)
      .values({
        artifactId: held.artifactId,
        actorId: actor.id,
        channel: "web",
        event: "renewed",
        at: NOW - 400 * DAY,
      });
    await db()
      .update(schema.suspensions)
      .set({ targetGoneAt: NOW - 400 * DAY })
      .where(eq(schema.suspensions.targetId, held.artifactId));
    expect(
      (
        await db().all<{ held: number }>(
          sql`select ${historyHeld(sql`${held.artifactId}`)} as held`,
        )
      )[0]?.held,
    ).toBe(1);
    expect(
      (await db().all<{ held: number }>(sql`select ${historyHeld(sql`${owner.id}`)} as held`))[0]
        ?.held,
    ).toBe(1);
    expect(
      (
        await db().all<{ held: number }>(sql`select ${historyHeld(sql`${"zzzzzzzzzz"}`)} as held`)
      )[0]?.held,
    ).toBe(0);
    await pruneGoneHistory(db(), NOW);
    expect(
      await db()
        .select()
        .from(schema.suspensions)
        .where(eq(schema.suspensions.targetId, held.artifactId)),
    ).toHaveLength(1);
    await eraseAccountTraces(db(), actor.id);
    const [kept] = await db()
      .select()
      .from(le)
      .where(and(eq(le.artifactId, held.artifactId), eq(le.event, "renewed")));
    expect(kept?.actorId).toBe(actor.id);
    // Released, the traces of an account deleted meanwhile go with the release job.
    await db()
      .global.insert(schema.tombstones)
      .values({ kind: "account", id: actor.id, deletedAt: NOW });
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW });
    expect(await runHoldRelease(db(), undefined, held.artifactId, NOW)).toBe("done");
    const [erased] = await db()
      .select()
      .from(le)
      .where(and(eq(le.artifactId, held.artifactId), eq(le.event, "renewed")));
    expect(erased?.actorId).toBeNull();
  });

  it("keeps an open hold that is a year old, and its records", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    await db()
      .update(schema.legalHolds)
      .set({ createdAt: NOW - 800 * DAY })
      .where(eq(schema.legalHolds.id, held.hold.id));
    await pruneGoneHistory(db(), NOW);
    expect(await isHeld(db(), held.artifactId)).toBe(true);
  });

  it("prunes the decisions, sends and released holds of something gone more than a year ago", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await suspendArtifact(db(), {
        artifactId,
        reason: "spam",
        statement: { facts: "F", ground: "G", source: "review", withhold: false },
        now: NOW - 500 * DAY,
      }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW - 500 * DAY,
      }),
    );
    const [decision] = await db()
      .select()
      .from(schema.moderationDecisions)
      .where(eq(schema.moderationDecisions.targetId, artifactId));
    await db()
      .insert(schema.moderationNoticeSends)
      .values({ decisionId: decision?.id ?? "", userId: owner.id, sentAt: NOW - 500 * DAY });
    // Kept while held, even with the artifact gone.
    await releaseLegalHold(db(), { artifactId, now: NOW - 450 * DAY });
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: null })
      .where(eq(schema.legalHolds.artifactId, artifactId));
    await db()
      .delete(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId))
      .catch(() => undefined);
    await pruneGoneHistory(db(), NOW);
    expect(
      await db()
        .select()
        .from(schema.moderationDecisions)
        .where(eq(schema.moderationDecisions.targetId, artifactId)),
    ).toHaveLength(1);
    // Released more than a year ago and the artifact gone: all of it goes.
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: NOW - 450 * DAY })
      .where(eq(schema.legalHolds.artifactId, artifactId));
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    await pruneGoneHistory(db(), NOW);
    expect(
      await db()
        .select()
        .from(schema.moderationDecisions)
        .where(eq(schema.moderationDecisions.targetId, artifactId)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.moderationNoticeSends)
        .where(eq(schema.moderationNoticeSends.decisionId, decision?.id ?? "")),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.legalHolds)
        .where(eq(schema.legalHolds.artifactId, artifactId)),
    ).toEqual([]);
  });
});

describe("deleting an account or a workspace with a held artifact", () => {
  it("deletes the account at once but keeps the held artifact until the release, then finishes", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const other = await publishSite(owner.id);
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(regions(), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    // The person's account, sessions and other content go as usual.
    const [account] = await db()
      .global.select()
      .from(schema.users)
      .where(eq(schema.users.id, owner.id));
    expect(account).toBeUndefined();
    expect(await artifactRow(other.artifactId)).toMatchObject({ state: "purging" });
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    await drainPurges(NOW);
    expect(await advanceAccountDeletion(regions(), owner.id, NOW + 1)).toBe("pending");
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });

    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 2 });
    expect(await advanceAccountDeletion(regions(), owner.id, NOW + 3)).toBe("pending");
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "purging" });
    await drainPurges(NOW + 3);
    let state = await advanceAccountDeletion(regions(), owner.id, NOW + 4);
    for (let i = 0; i < 3 && state !== "finished"; i += 1) {
      await drainPurges(NOW + 4);
      state = await advanceAccountDeletion(regions(), owner.id, NOW + 5);
    }
    expect(state).toBe("finished");
  });

  it("tries a waiting deletion last, so it never stops the others", async () => {
    const waiting = await user();
    await heldArtifact(waiting.id);
    value(
      await requestAccountDeletion(regions(), {
        userId: waiting.id,
        sessionId: await session(waiting.id),
        confirmEmail: waiting.email,
        now: NOW - 10 * DAY,
      }),
    );
    await processAccountDeletions(regions(), NOW + 10, 500);
    const d = schema.accountDeletions;
    const [tried] = await db().global.select().from(d).where(eq(d.userId, waiting.id));
    expect(tried?.attemptedAt).toBe(NOW + 10);
    const next = await user();
    value(
      await requestAccountDeletion(regions(), {
        userId: next.id,
        sessionId: await session(next.id),
        confirmEmail: next.email,
        now: NOW + 1,
      }),
    );
    const before = await db().global.select().from(d);
    const order = before
      .map((row) => ({ id: row.userId, at: row.attemptedAt ?? row.requestedAt }))
      .sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
    expect(order.findIndex((row) => row.id === next.id)).toBeLessThan(
      order.findIndex((row) => row.id === waiting.id),
    );
  });

  it("keeps a workspace's held artifact through its deletion until the release", async () => {
    const admin = await user();
    const slug = `w-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(db().global, { slug, name: "Held", adminUserId: admin.id, now: NOW }),
    );
    const published = await publishSite(admin.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: admin.id,
        artifactId: published.artifactId,
        workspace: slug,
        now: NOW,
      }),
    );
    value(
      await suspendArtifact(db(), {
        artifactId: published.artifactId,
        reason: "child_safety",
        now: NOW,
      }),
    );
    value(
      await placeLegalHold(db(), {
        artifactId: published.artifactId,
        ground: "Authority",
        releaseAt: null,
        now: NOW,
      }),
    );
    value(await deleteWorkspace(regions(), { workspaceId: ws.id, now: NOW }));
    expect(await artifactRow(published.artifactId)).toMatchObject({
      state: "suspended",
      ownerId: ws.id,
    });
    expect(await advanceWorkspaceDeletion(regions(), ws.id, NOW + 1)).toBe("pending");
    expect(await artifactRow(published.artifactId)).toMatchObject({ state: "suspended" });
    await releaseLegalHold(db(), { artifactId: published.artifactId, now: NOW + 2 });
    await advanceWorkspaceDeletion(regions(), ws.id, NOW + 3);
    expect(await artifactRow(published.artifactId)).toMatchObject({ state: "purging" });
  });
});

describe("a restore", () => {
  it("puts holds back before tombstones, suspends a held artifact the restore served, and keeps a release", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const released = await heldArtifact(owner.id);
    await releaseLegalHold(db(), { artifactId: released.artifactId, now: NOW + 1 });
    const lines = (await exportLegalHolds(regions())).filter((line) =>
      [held.artifactId, released.artifactId].includes(line.legalHold.artifactId),
    );
    expect(lines).toHaveLength(2);

    // The restore rewinds to before the hold and the suspension, and before the release.
    const h = schema.legalHolds;
    await db().delete(h).where(eq(h.artifactId, held.artifactId));
    await db().update(h).set({ releasedAt: null }).where(eq(h.artifactId, released.artifactId));
    await db()
      .update(schema.suspensions)
      .set({ liftedAt: NOW })
      .where(eq(schema.suspensions.targetId, held.artifactId));
    await db()
      .update(schema.artifacts)
      .set({ state: "active", suspensionReason: null })
      .where(eq(schema.artifacts.id, held.artifactId));

    const result = await applyLegalHolds(regions(), lines, NOW + 2);
    expect(result).toMatchObject({ restored: 2, suspended: 1, missing: [] });
    expect(await isHeld(db(), held.artifactId)).toBe(true);
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    expect(await isHeld(db(), released.artifactId)).toBe(false);
    // Running it again changes nothing.
    expect(await applyLegalHolds(regions(), lines, NOW + 3)).toMatchObject({
      restored: 0,
      suspended: 0,
    });

    // A re-applied account deletion leaves the held artifact alone.
    await applyTombstones(regions(), [{ kind: "account", id: owner.id, deletedAt: NOW }], NOW + 4);
    expect(await artifactRow(held.artifactId)).toMatchObject({ state: "suspended" });
    expect(await artifactRow(released.artifactId)).toMatchObject({ state: "purging" });
  });

  it("re-applies a later hold even when the file lists it before the release of the one the restore left open", async () => {
    // Found by the artifact data model check (fourth review of PR 261): the file holds H1
    // released and H2 open, the restored D1 still has H1 open, and H2 came first in the file. H2
    // was skipped while H1 was still open, and nothing reported it.
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const first = held.hold.id;
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 1 });
    const second = value(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "A second order",
        releaseAt: null,
        now: NOW + 2,
      }),
    ).hold.id;
    const lines = (await exportLegalHolds(regions())).filter(
      (l) => l.legalHold.artifactId === held.artifactId,
    );
    // The restore: H1 open again, H2 gone.
    const h = schema.legalHolds;
    await db()
      .delete(schema.legalHoldIdentities)
      .where(eq(schema.legalHoldIdentities.holdId, second));
    await db().delete(h).where(eq(h.id, second));
    await db().update(h).set({ releasedAt: null }).where(eq(h.id, first));
    // The open hold first, then the release, whatever order the file has.
    const reordered = [...lines].sort((a, b) =>
      a.legalHold.releasedAt === null ? -1 : b.legalHold.releasedAt === null ? 1 : 0,
    );
    expect(await applyLegalHolds(regions(), reordered, NOW + 3)).toMatchObject({ restored: 2 });
    const open = await db()
      .select({ id: h.id })
      .from(h)
      .where(sql`${h.artifactId} = ${held.artifactId} and ${h.releasedAt} is null`);
    expect(open.map((row) => row.id)).toEqual([second]);
  });

  it("reopens a hold the file has open, and reports one whose artifact is being purged", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    const [line] = (await exportLegalHolds(regions())).filter(
      (l) => l.legalHold.artifactId === held.artifactId,
    );
    if (!line) throw new Error("no line");
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 1 });
    expect(await applyLegalHolds(regions(), [line], NOW + 2)).toMatchObject({ restored: 1 });
    expect(await isHeld(db(), held.artifactId)).toBe(true);

    const gone = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, gone.artifactId));
    const result = await applyLegalHolds(
      regions(),
      [
        {
          legalHold: {
            ...line.legalHold,
            id: `hold_${"1".repeat(32)}`,
            artifactId: gone.artifactId,
          },
        },
      ],
      NOW,
    );
    expect(result.missing).toEqual([gone.artifactId]);
    expect(
      await placeLegalHold(db(), {
        artifactId: held.artifactId,
        ground: "x".repeat(501),
        releaseAt: null,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("releases again through the release's own batch: no identity left, one release job", async () => {
    const owner = await user();
    const held = await heldArtifact(owner.id);
    await releaseLegalHold(db(), { artifactId: held.artifactId, now: NOW + 1 });
    const lines = (await exportLegalHolds(regions())).filter(
      (line) => line.legalHold.artifactId === held.artifactId,
    );
    // The restore rewinds the hold to open, with its identities and without the release job.
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, held.artifactId));
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: null, ownerEmail: owner.email })
      .where(eq(schema.legalHolds.id, held.hold.id));
    await db().insert(schema.legalHoldIdentities).values({
      holdId: held.hold.id,
      role: "owner",
      actorId: owner.id,
      email: owner.email,
      recordedAt: NOW,
    });
    await applyLegalHolds(regions(), lines, NOW + 2);
    expect(await isHeld(db(), held.artifactId)).toBe(false);
    expect(
      await db()
        .select()
        .from(schema.legalHoldIdentities)
        .where(eq(schema.legalHoldIdentities.holdId, held.hold.id)),
    ).toEqual([]);
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, held.artifactId));
    expect(jobs.filter((job) => job.topic === "legal_hold_release")).toHaveLength(1);
  });

  it("reports a held artifact the restore cannot bring back", async () => {
    const result = await applyLegalHolds(
      regions(),
      [
        {
          legalHold: {
            id: `hold_${"0".repeat(32)}`,
            artifactId: "zzzzzzzzzz",
            ownerId: "u_gone",
            ownerEmail: null,
            reason: "spam",
            ground: "Authority",
            createdAt: NOW,
            releaseAt: null,
            releasedAt: null,
          },
        },
      ],
      NOW,
    );
    expect(result.missing).toEqual(["zzzzzzzzzz"]);
  });
});
