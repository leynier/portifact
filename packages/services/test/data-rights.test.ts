// A person's own export and deletes from "Data you shared" (decision 0026): as the visitor the
// journal names them, only their own documents, without write permission or an open grant, and
// nothing once the journal entry is retired.
import { env } from "cloudflare:test";
import { PLANS } from "@portifact/contracts";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { describe, expect, it } from "vitest";
import {
  claimVisitorId,
  type DataObjects,
  declareDataCollection,
  deleteOwnDocument,
  exportOwnData,
  journalVisitorId,
  pageDataCommand,
  retireJournalEntry,
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
