// The owner side of artifact data (decision 0026, delivery 5) against the in-memory reference
// object: authorization on the artifact's owner, the switch, states, holds, the plan's data
// artifact count, every command's success and refusal, and the audit relay. The same services
// against the real Durable Object run in apps/app's tests through the API.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { HELD_MESSAGE } from "@portifact/domain";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import {
  buildDataIndexes,
  countArtifactData,
  createDataDocument,
  createDataDocuments,
  DATA_AUDIT_DELAY_MS,
  type DataObjects,
  declareDataCollection,
  deleteDataDocument,
  deleteDataDocuments,
  describeArtifactData,
  exportArtifactData,
  getDataDocument,
  type OwnerDataDeps,
  ownerOperationId,
  queryArtifactData,
  replaceDataDocument,
  replaceDataDocuments,
  runDataAudit,
} from "../src/index.ts";
import { placeLegalHold } from "../src/legal-holds.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { ownerRpc } from "./data-owner-rpc.ts";
import { db, grantPlan, NOW, publishSite, user, value } from "./fixtures.ts";

function harness(enabled = true) {
  const memories = new Map<string, MemoryObject>();
  const of = (id: string) => {
    let found = memories.get(id);
    if (!found) {
      found = new MemoryObject(id);
      memories.set(id, found);
    }
    return found;
  };
  const objects: DataObjects = {
    region: "default",
    createsObjects: enabled,
    object: (id) => ({ ...ownerRpc(of(id)) }) as never,
  };
  const deps: OwnerDataDeps = { objects, bucket: env.ARTIFACTS, enabled };
  return { deps, of, objects };
}

const key = () => `key-${crypto.randomUUID()}`;

async function ownedArtifact() {
  const owner = await user("Owner");
  const { artifactId } = await publishSite(owner.id);
  return { owner, artifactId };
}

async function workspace(members: [string, "admin" | "editor" | "member"][]) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: members[0]?.[0] ?? "x",
      updatedAt: NOW,
    });
  for (const [userId, role] of members) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  return { id, slug: id.slice(3, 23) };
}

async function declared(deps: OwnerDataDeps, userId: string, artifactId: string) {
  return value(
    await declareDataCollection(db(), deps, {
      userId,
      artifactId,
      now: NOW,
      idempotencyKey: key(),
      declaration: { name: "votes", mode: "own", indexed: ["choice"] },
    }),
  );
}

async function auditJobs(artifactId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "data_audit"), eq(schema.outbox.subject, artifactId)));
}

describe("owner document API", () => {
  it("declares, writes, reads, queries, counts and deletes as the owner", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };

    const before = value(await describeArtifactData(db(), deps, input));
    expect(before.exists).toBe(false);
    expect(before.collections).toEqual([]);

    const collection = await declared(deps, owner.id, artifactId);
    expect(collection.collection).toMatchObject({ name: "votes", mode: "own" });
    expect(collection.building).toBe(0);

    const doc = value(
      await createDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        body: { choice: "a" },
      }),
    );
    expect(doc).toMatchObject({ choice: "a", _by: "owner" });
    const id = doc._id;

    expect(
      value(await getDataDocument(db(), deps, { ...input, collection: "votes", id })),
    ).toMatchObject({ _id: id, choice: "a" });

    const replaced = value(
      await replaceDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        id,
        body: { choice: "b" },
      }),
    );
    expect(replaced.choice).toBe("b");

    const page = value(
      await queryArtifactData(db(), deps, {
        ...input,
        query: { collection: "votes", equals: { field: "choice", value: "b" } },
      }),
    );
    expect(page.documents.map((item) => item._id)).toEqual([id]);

    expect(
      value(await countArtifactData(db(), deps, { ...input, count: { collection: "votes" } })),
    ).toEqual({ documents: 1 });

    const described = value(await describeArtifactData(db(), deps, input));
    expect(described.exists).toBe(true);
    expect(described.collections[0]).toMatchObject({ name: "votes", documents: 1 });
    expect(described.limits.bytesPerArtifact).toBe(5_000_000);

    expect(
      value(
        await deleteDataDocument(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          id,
        }),
      ),
    ).toEqual({ id });
    const missing = await getDataDocument(db(), deps, { ...input, collection: "votes", id });
    expect(missing).toMatchObject({ ok: false, code: "not_found" });
  });

  it("writes and deletes in bulk, all or nothing", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    await declared(deps, owner.id, artifactId);
    const { ids } = value(
      await createDataDocuments(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        documents: [{ choice: "a" }, { choice: "b" }, { choice: "c" }],
      }),
    );
    expect(ids).toHaveLength(3);
    expect(
      value(
        await replaceDataDocuments(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          documents: ids.map((id) => ({ id, body: { choice: "z" } })),
        }),
      ),
    ).toEqual({ replaced: 3 });
    const refused = await deleteDataDocuments(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      ids: [...ids, "AAAAAAAAAAAAAAAA"],
    });
    expect(refused.ok).toBe(false);
    expect(
      value(await countArtifactData(db(), deps, { ...input, count: { collection: "votes" } })),
    ).toEqual({ documents: 3 });
    expect(
      value(
        await deleteDataDocuments(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          ids,
        }),
      ),
    ).toEqual({ removed: 3 });
  });

  it("answers a retried write with the same document, applied once", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    await declared(deps, owner.id, artifactId);
    const write = { ...input, idempotencyKey: key(), collection: "votes", body: { choice: "a" } };
    const first = value(await createDataDocument(db(), deps, write));
    const again = value(await createDataDocument(db(), deps, write));
    expect(again._id).toBe(first._id);
    expect(
      value(await countArtifactData(db(), deps, { ...input, count: { collection: "votes" } })),
    ).toEqual({ documents: 1 });
    const bulk = {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      ids: [first._id],
    };
    expect(value(await deleteDataDocuments(db(), deps, bulk))).toEqual({ removed: 1 });
    expect(value(await deleteDataDocuments(db(), deps, bulk))).toEqual({ removed: 1 });
  });

  it("builds a declared index in steps the owner side asks for", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    expect(await buildDataIndexes(db(), deps, { ...input, idempotencyKey: key() })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await declared(deps, owner.id, artifactId);
    expect(value(await buildDataIndexes(db(), deps, { ...input, idempotencyKey: key() }))).toEqual({
      building: 0,
    });
  });

  it("exports pages with the header's collections and the stored bodies", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    const empty = value(await exportArtifactData(db(), deps, { ...input, after: null }));
    expect(empty).toMatchObject({ rows: [], next: null, header: { collections: [] } });
    await declared(deps, owner.id, artifactId);
    await createDataDocument(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      body: { choice: "a", n: 1 },
    });
    const page = value(await exportArtifactData(db(), deps, { ...input, after: null }));
    expect(page.header?.collections).toEqual([
      { name: "votes", mode: "own", uniqueKey: null, indexed: ["choice"] },
    ]);
    expect(page.header?.revision).toBe(page.revision);
    expect(page.rows).toHaveLength(1);
    expect(JSON.parse(page.rows[0]?.body ?? "")).toEqual({ choice: "a", n: 1 });
    const later = value(
      await exportArtifactData(db(), deps, {
        ...input,
        after: { collection: "votes", id: page.rows[0]?.id ?? "" },
      }),
    );
    expect(later.header).toBeNull();
    expect(later.rows).toEqual([]);
  });
});

describe("owner document API refusals", () => {
  it("answers a stranger and a member exactly like a missing artifact or a role refusal", async () => {
    const { deps } = harness();
    const { artifactId } = await ownedArtifact();
    const stranger = await user("Stranger");
    expect(
      await describeArtifactData(db(), deps, { userId: stranger.id, artifactId, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found", message: "Artifact not found." });
    expect(
      await describeArtifactData(db(), deps, {
        userId: stranger.id,
        artifactId: "zzzzzzzzzz",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found", message: "Artifact not found." });

    const admin = await user("Admin");
    const editor = await user("Editor");
    const member = await user("Member");
    const space = await workspace([
      [admin.id, "admin"],
      [editor.id, "editor"],
      [member.id, "member"],
    ]);
    const { artifactId: shared } = await publishSite(admin.id);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: space.id })
      .where(eq(schema.artifacts.id, shared));
    expect(
      await describeArtifactData(db(), deps, { userId: member.id, artifactId: shared, now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      (await describeArtifactData(db(), deps, { userId: editor.id, artifactId: shared, now: NOW }))
        .ok,
    ).toBe(true);
  });

  it("lets a service token act only with a token's role on its own workspace", async () => {
    const { deps } = harness();
    const admin = await user("Admin");
    const space = await workspace([[admin.id, "admin"]]);
    const { artifactId } = await publishSite(admin.id);
    await db()
      .update(schema.artifacts)
      .set({ ownerId: space.id })
      .where(eq(schema.artifacts.id, artifactId));
    await grantPlan(space.id, "team");
    const token = value(
      await createServiceToken(db().global, {
        userId: admin.id,
        slug: space.slug,
        body: {
          label: "CI",
          role: "editor",
          scopes: ["data:read", "data:write"],
          expiresInDays: 30,
          restriction: { kind: "none" },
        },
        now: NOW,
      }),
    ).token.id;
    await declared(deps, token, artifactId);
    const doc = value(
      await createDataDocument(db(), deps, {
        userId: token,
        artifactId,
        now: NOW,
        idempotencyKey: key(),
        collection: "votes",
        body: { choice: "a" },
      }),
    );
    expect(doc._by).toBe("owner");
  });

  it("answers not_found while artifact data is off, except the export", async () => {
    const { deps } = harness(false);
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    expect(await describeArtifactData(db(), deps, input)).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Artifact data is not available.",
    });
    const declare = await declareDataCollection(db(), deps, {
      ...input,
      idempotencyKey: key(),
      declaration: { name: "votes", mode: "own" },
    });
    expect(declare).toMatchObject({ ok: false, code: "not_found" });
    expect(await auditJobs(artifactId)).toEqual([]);
    const page = value(await exportArtifactData(db(), deps, { ...input, after: null }));
    expect(page.rows).toEqual([]);
    // Nothing was registered or created.
    const [row] = await db()
      .select()
      .from(schema.artifactData)
      .where(eq(schema.artifactData.artifactId, artifactId));
    expect(row).toBeUndefined();
  });

  it("refuses writes before any collection exists and on archived artifacts", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    expect(
      await createDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        body: {},
      }),
    ).toMatchObject({ ok: false, code: "not_found", message: "No such collection." });
    expect(
      await queryArtifactData(db(), deps, { ...input, query: { collection: "votes" } }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await declared(deps, owner.id, artifactId);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(
      await createDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        body: {},
      }),
    ).toMatchObject({ ok: false, code: "artifact_archived" });
    // An archived artifact's data is still read and exported.
    expect((await describeArtifactData(db(), deps, input)).ok).toBe(true);
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(
      await deleteDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        id: "AAAAAAAAAAAAAAAA",
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("refuses everything on a held artifact without saying why", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    await declared(deps, owner.id, artifactId);
    await db()
      .update(schema.artifacts)
      .set({ state: "suspended" })
      .where(eq(schema.artifacts.id, artifactId));
    value(await placeLegalHold(db(), { artifactId, ground: "case-1", releaseAt: null, now: NOW }));
    const input = { userId: owner.id, artifactId, now: NOW };
    expect(await describeArtifactData(db(), deps, input)).toEqual({
      ok: false,
      code: "forbidden",
      message: HELD_MESSAGE,
    });
    expect(await exportArtifactData(db(), deps, { ...input, after: null })).toMatchObject({
      ok: false,
      message: HELD_MESSAGE,
    });
  });

  it("refuses a second data artifact beyond the Free plan's one, and allows it on Pro", async () => {
    const { deps } = harness();
    const owner = await user("Owner");
    const { artifactId: first } = await publishSite(owner.id);
    const { artifactId: second } = await publishSite(owner.id);
    await declared(deps, owner.id, first);
    const refused = await declareDataCollection(db(), deps, {
      userId: owner.id,
      artifactId: second,
      now: NOW,
      idempotencyKey: key(),
      declaration: { name: "votes", mode: "own" },
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "quota_exceeded",
      message: "Your plan allows data on 1 artifact.",
    });
    await grantPlan(owner.id, "pro");
    expect((await declared(deps, owner.id, second)).collection.name).toBe("votes");
  });

  it("maps the object's refusals to the API's errors", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    await declared(deps, owner.id, artifactId);
    const big = await createDataDocument(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      body: { text: "x".repeat(20_000) },
    });
    expect(big.ok).toBe(false);
    const unknown = await queryArtifactData(db(), deps, {
      ...input,
      query: { collection: "votes", equals: { field: "missing", value: 1 } },
    });
    expect(unknown).toMatchObject({ ok: false, code: "invalid_input" });
    const none = await createDataDocument(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "absent",
      body: {},
    });
    expect(none).toMatchObject({ ok: false, code: "not_found" });
  });

  it("answers unavailable without the binding", async () => {
    const { owner, artifactId } = await ownedArtifact();
    const deps: OwnerDataDeps = { objects: null, bucket: env.ARTIFACTS, enabled: true };
    await db()
      .insert(schema.artifactData)
      .values({ artifactId, generation: 0, epoch: 0, updatedAt: NOW });
    expect(
      await describeArtifactData(db(), deps, { userId: owner.id, artifactId, now: NOW }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
  });
});

describe("budget protection's data step", () => {
  it("stops declarations, creates and replacements, never reads, exports or deletes", async () => {
    const { deps } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    await declared(deps, owner.id, artifactId);
    const doc = value(
      await createDataDocument(db(), deps, {
        ...input,
        idempotencyKey: key(),
        collection: "votes",
        body: { choice: "a" },
      }),
    );
    const jobsBefore = (await auditJobs(artifactId)).length;
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      const paused = { ok: false, code: "capacity_unavailable" };
      expect(
        await declareDataCollection(db(), deps, {
          ...input,
          idempotencyKey: key(),
          declaration: { name: "more", mode: "own" },
        }),
      ).toMatchObject(paused);
      expect(
        await createDataDocument(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          body: { choice: "b" },
        }),
      ).toMatchObject(paused);
      expect(
        await replaceDataDocument(db(), deps, {
          ...input,
          idempotencyKey: key(),
          collection: "votes",
          id: doc._id,
          body: { choice: "c" },
        }),
      ).toMatchObject(paused);
      expect(await buildDataIndexes(db(), deps, { ...input, idempotencyKey: key() })).toMatchObject(
        paused,
      );
      // A refusal writes no audit job: nothing reached the object.
      expect(await auditJobs(artifactId)).toHaveLength(jobsBefore);
      expect((await describeArtifactData(db(), deps, input)).ok).toBe(true);
      expect((await exportArtifactData(db(), deps, { ...input, after: null })).ok).toBe(true);
      expect(
        value(
          await deleteDataDocument(db(), deps, {
            ...input,
            idempotencyKey: key(),
            collection: "votes",
            id: doc._id,
          }),
        ),
      ).toEqual({ id: doc._id });
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
  });
});

describe("the audit relay", () => {
  it("records each committed owner change once, with counts only", async () => {
    const { deps, objects } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const input = { userId: owner.id, artifactId, now: NOW };
    await declared(deps, owner.id, artifactId);
    await createDataDocuments(db(), deps, {
      ...input,
      idempotencyKey: key(),
      collection: "votes",
      documents: [{ choice: "a" }, { choice: "b" }],
    });
    const jobs = await auditJobs(artifactId);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.availableAt === NOW + DATA_AUDIT_DELAY_MS)).toBe(true);
    for (const job of jobs) {
      expect(await runDataAudit(db(), objects, job, NOW + DATA_AUDIT_DELAY_MS)).toBe("done");
      // A repeated delivery adds nothing.
      expect(await runDataAudit(db(), objects, job, NOW + DATA_AUDIT_DELAY_MS)).toBe("done");
    }
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.artifactId, artifactId));
    const data = events.filter((event) => event.kind.startsWith("data."));
    expect(data.map((event) => [event.kind, event.detail, event.actorId]).sort()).toEqual([
      ["data.collection_set", {}, owner.id],
      ["data.documents_created", { documents: 2 }, owner.id],
    ]);
    expect(data.every((event) => event.ownerId === owner.id && event.at === NOW)).toBe(true);
  });

  it("records an operation that never reached the object as aborted, and nothing in D1", async () => {
    const { deps, objects, of } = harness();
    const { owner, artifactId } = await ownedArtifact();
    await declared(deps, owner.id, artifactId);
    const opId = await ownerOperationId(owner.id, "lost", NOW);
    const [row] = await db()
      .select()
      .from(schema.artifactData)
      .where(eq(schema.artifactData.artifactId, artifactId));
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_audit",
        payload: {
          ownerId: owner.id,
          generation: row?.generation ?? 0,
          epoch: row?.epoch ?? 0,
          actor: owner.id,
          opId,
        },
        availableAt: NOW,
        createdAt: NOW,
        subject: artifactId,
      })
      .returning();
    if (!job) throw new Error("no job");
    expect(await runDataAudit(db(), objects, job, NOW + 1_000)).toBe("done");
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.artifactId, artifactId),
          eq(schema.auditEvents.kind, "data.document_created"),
        ),
      );
    expect(events).toEqual([]);
    // The late arrival of that operation cannot commit.
    expect(of(artifactId)).toBeDefined();
    const retried = await createDataDocument(db(), deps, {
      userId: owner.id,
      artifactId,
      now: NOW,
      idempotencyKey: "lost",
      collection: "votes",
      body: { choice: "a" },
    });
    expect(retried.ok).toBe(false);
  });

  it("waits on an ID from the future and ends on a malformed payload or another artifact", async () => {
    const { objects } = harness();
    const { owner, artifactId } = await ownedArtifact();
    const future = await ownerOperationId(owner.id, "future", NOW + 3_600_000);
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_audit",
        payload: { ownerId: owner.id, generation: 0, epoch: 0, actor: owner.id, opId: future },
        availableAt: NOW,
        createdAt: NOW,
        subject: artifactId,
      })
      .returning();
    if (!job) throw new Error("no job");
    expect(await runDataAudit(db(), objects, job, NOW)).toBe("kept");
    expect(await runDataAudit(db(), objects, { ...job, payload: { nope: 1 } }, NOW)).toBe("stale");
    expect(await runDataAudit(db(), objects, { ...job, subject: null }, NOW)).toBe("stale");
    await expect(runDataAudit(db(), null, job, NOW)).rejects.toThrow("binding");
  });

  it("binds no empty object while artifact data is off", async () => {
    const { objects, of } = harness(false);
    const { owner, artifactId } = await ownedArtifact();
    const opId = await ownerOperationId(owner.id, "never", NOW);
    const [job] = await db()
      .insert(schema.outbox)
      .values({
        topic: "data_audit",
        payload: { ownerId: owner.id, generation: 0, epoch: 0, actor: owner.id, opId },
        availableAt: NOW,
        createdAt: NOW,
        subject: artifactId,
      })
      .returning();
    if (!job) throw new Error("no job");
    expect(await runDataAudit(db(), objects, job, NOW)).toBe("done");
    expect(of(artifactId).durable.control).toBeNull();
  });
});
