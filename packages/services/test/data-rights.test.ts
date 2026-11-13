// A person's own export and deletes from "Data you shared" (decision 0026): as the visitor the
// journal names them, only their own documents, without write permission or an open grant, and
// nothing once the journal entry is retired.
import { env } from "cloudflare:test";
import { PLANS } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  claimVisitorId,
  type DataObjects,
  type DataRightsNotifier,
  declareDataCollection,
  deleteOwnDocument,
  exportOwnData,
  journalVisitorId,
  pageDataCommand,
  requestDataRights,
  retireJournalEntry,
  sendDataRightsNotice,
} from "../src/index.ts";
import { ownerRpc } from "./data-owner-rpc.ts";
import { db, NOW, publishSite, user, value } from "./fixtures.ts";

function harness() {
  const memories = new Map<string, MemoryObject>();
  const objects: DataObjects = {
    region: "default",
    createsObjects: true,
    object: (id) => {
      let found = memories.get(id);
      if (!found) {
        found = new MemoryObject(id);
        memories.set(id, found);
      }
      return { ...ownerRpc(found) } as never;
    },
  };
  return { objects, deps: { objects, bucket: env.ARTIFACTS } };
}

async function setup() {
  const { objects, deps } = harness();
  const owner = await user("Owner");
  const { artifactId } = await publishSite(owner.id);
  value(
    await declareDataCollection(
      db(),
      { objects, bucket: env.ARTIFACTS, enabled: true },
      {
        userId: owner.id,
        artifactId,
        now: NOW,
        idempotencyKey: crypto.randomUUID(),
        declaration: { name: "votes", mode: "own" },
      },
    ),
  );
  const write = async (userId: string, choice: string) => {
    const visitor = value(await claimVisitorId(env.ARTIFACTS, userId, artifactId, NOW));
    const { result } = await pageDataCommand(
      db(),
      { objects },
      {
        artifactId,
        region: "default",
        limits: PLANS.free.data.perArtifact,
        caller: { kind: "visitor", author: visitor, canWrite: true },
        command: { kind: "create", collection: "votes", body: { choice } },
        idempotencyKey: null,
        now: NOW,
      },
    );
    return (value(result).value as { _id: string })._id;
  };
  return { deps, artifactId, write };
}

const input = (userId: string, artifactId: string) => ({
  userId,
  artifactId,
  region: "default",
  now: NOW + 1000,
});

describe("a person's own data", () => {
  it("exports only the person's own documents and deletes one of them", async () => {
    const { deps, artifactId, write } = await setup();
    const alice = await user("Alice");
    const bob = await user("Bob");
    const mine = await write(alice.id, "a");
    await write(bob.id, "b");

    const page = value(
      await exportOwnData(db(), deps, { ...input(alice.id, artifactId), after: null }),
    ) as { rows: { id: string }[] };
    expect(page.rows.map((row) => row.id)).toEqual([mine]);

    // Bob cannot delete Alice's document from his own rights.
    expect(
      await deleteOwnDocument(db(), deps, {
        ...input(bob.id, artifactId),
        collection: "votes",
        id: mine,
        idempotencyKey: null,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await deleteOwnDocument(db(), deps, {
        ...input(alice.id, artifactId),
        collection: "votes",
        id: mine,
        idempotencyKey: `${NOW}.deletemine`,
      }),
    ).toEqual({ ok: true, value: { deleted: true } });
    const after = value(
      await exportOwnData(db(), deps, { ...input(alice.id, artifactId), after: null }),
    ) as { rows: unknown[] };
    expect(after.rows).toEqual([]);
  });

  it("has nothing for a person the journal does not name, or names retired", async () => {
    const { deps, artifactId, write } = await setup();
    const stranger = await user("Stranger");
    expect(
      await exportOwnData(db(), deps, { ...input(stranger.id, artifactId), after: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const leaving = await user("Leaving");
    await write(leaving.id, "c");
    expect(await journalVisitorId(env.ARTIFACTS, leaving.id, artifactId)).toMatch(/^v_/);
    await retireJournalEntry(env.ARTIFACTS, leaving.id, artifactId, NOW);
    expect(await journalVisitorId(env.ARTIFACTS, leaving.id, artifactId)).toBeNull();
    expect(
      await exportOwnData(db(), deps, { ...input(leaving.id, artifactId), after: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

/** A workspace that owns the artifact, with two admins and a member. */
async function workspaceOwner(artifactId: string) {
  const first = await user("Admin one");
  const second = await user("Admin two");
  const member = await user("Member");
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .global.insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: first.id, updatedAt: NOW });
  for (const [userId, role] of [
    [first.id, "admin"],
    [second.id, "admin"],
    [member.id, "member"],
  ] as const) {
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  await db()
    .update(schema.artifacts)
    .set({ ownerId: id })
    .where(eq(schema.artifacts.id, artifactId));
  return { first, second, member, slug: id.slice(3, 23) };
}

async function rightsJobs(artifactId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.topic, "data_rights_request"), eq(schema.outbox.subject, artifactId)),
    );
}

function recordingNotifier(fail: (to: string) => boolean = () => false) {
  const sent: Parameters<DataRightsNotifier["send"]>[0][] = [];
  const notifier: DataRightsNotifier = {
    async send(notice) {
      if (fail(notice.to)) throw new Error("email delivery failed");
      sent.push(notice);
    },
  };
  return { sent, notifier };
}

describe("rights requests", () => {
  it("emails each admin of the artifact's owner, naming the person only by their visitor ID", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    const admins = await workspaceOwner(artifactId);
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(visitor.id, artifactId),
        kind: "erasure",
      }),
    ).toEqual({ ok: true, value: { requested: true } });
    const [job] = await rightsJobs(artifactId);
    if (!job) throw new Error("no job");
    expect(JSON.stringify(job.payload)).not.toContain(visitor.email);
    const { sent, notifier } = recordingNotifier();
    expect(await sendDataRightsNotice(db(), job, NOW + 2000, notifier)).toBe("done");
    expect(sent.map((notice) => notice.to).sort()).toEqual(
      [admins.first.email, admins.second.email].sort(),
    );
    const visitorId = await journalVisitorId(env.ARTIFACTS, visitor.id, artifactId);
    expect(sent[0]).toMatchObject({
      kind: "erasure",
      artifactId,
      visitorId,
      workspaceSlug: admins.slug,
    });
    expect(JSON.stringify(sent)).not.toContain(visitor.email);
    // The job claimed its row: a second delivery sends nothing.
    expect(await sendDataRightsNotice(db(), job, NOW + 3000, notifier)).toBe("done");
    expect(sent).toHaveLength(2);
  });

  it("puts the job back when the first send fails, and drops it after one admin got it", async () => {
    const { deps, artifactId, write } = await setup();
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    const admins = await workspaceOwner(artifactId);
    await requestDataRights(db(), deps.bucket, {
      ...input(visitor.id, artifactId),
      kind: "access",
    });
    const [job] = await rightsJobs(artifactId);
    if (!job) throw new Error("no job");
    const failing = recordingNotifier(() => true);
    await expect(sendDataRightsNotice(db(), job, NOW + 2000, failing.notifier)).rejects.toThrow();
    const [again] = await rightsJobs(artifactId);
    if (!again) throw new Error("the job was not put back");
    const [firstAdmin] = [admins.first.email, admins.second.email].sort();
    const partial = recordingNotifier((to) => to !== firstAdmin);
    expect(await sendDataRightsNotice(db(), again, NOW + 3000, partial.notifier)).toBe("done");
    expect(await rightsJobs(artifactId)).toEqual([]);
  });

  it("refuses a person the journal does not name, and limits requests a day", async () => {
    const { deps, artifactId, write } = await setup();
    const stranger = await user("Stranger");
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(stranger.id, artifactId),
        kind: "access",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const visitor = await user("Visitor");
    await write(visitor.id, "a");
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await requestDataRights(db(), deps.bucket, {
            ...input(visitor.id, artifactId),
            kind: "access",
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await requestDataRights(db(), deps.bucket, {
        ...input(visitor.id, artifactId),
        kind: "access",
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("drops a job whose artifact is gone", async () => {
    const { artifactId } = await setup();
    const { sent, notifier } = recordingNotifier();
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_rights_request",
        payload: { visitorId: "v_1234567890123456", kind: "access" },
        availableAt: NOW,
        createdAt: NOW,
        subject: "zzzzzzzzzz",
      })
      .returning();
    if (!row) throw new Error("no row");
    expect(await sendDataRightsNotice(db(), row, NOW, notifier)).toBe("stale");
    expect(sent).toEqual([]);
    expect(artifactId).toBeTruthy();
  });
});
