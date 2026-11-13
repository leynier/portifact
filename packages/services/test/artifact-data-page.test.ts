// The page side of artifact data (decision 0026, delivery 6) against the in-memory reference
// object: the envelope from D1, a visitor's own documents, a reader, retries keyed by the page,
// writes paused by budget protection while deletes go on, and an artifact without data.

import { env } from "cloudflare:test";
import { PLANS } from "@portifact/contracts";
import type { PageCaller } from "@portifact/contracts/artifact-data";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { describe, expect, it } from "vitest";
import {
  clearBudgetOverride,
  createDataDocument,
  type DataObjects,
  declareDataCollection,
  type OwnerDataDeps,
  pageDataCommand,
  setBudgetOverride,
} from "../src/index.ts";
import { ownerRpc } from "./data-owner-rpc.ts";
import { db, NOW, publishSite, user, value } from "./fixtures.ts";

const LIMITS = PLANS.free.data.perArtifact;
const ALICE: PageCaller = { kind: "visitor", author: "v_alice0000000000000", canWrite: true };
const BOB: PageCaller = { kind: "visitor", author: "v_bob00000000000000", canWrite: true };

function harness() {
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
    createsObjects: true,
    object: (id) => ({ ...ownerRpc(of(id)) }) as never,
  };
  const owner: OwnerDataDeps = { objects, bucket: env.ARTIFACTS, enabled: true };
  return { objects, owner };
}

async function artifactWithVotes(owner: OwnerDataDeps) {
  const person = await user("Owner");
  const { artifactId } = await publishSite(person.id);
  value(
    await declareDataCollection(db(), owner, {
      userId: person.id,
      artifactId,
      now: NOW,
      idempotencyKey: crypto.randomUUID(),
      declaration: { name: "votes", mode: "own" },
    }),
  );
  return { artifactId, ownerId: person.id };
}

describe("page data commands", () => {
  it("writes and reads a visitor's own documents through the object, keyed by the page", async () => {
    const { objects, owner } = harness();
    const { artifactId } = await artifactWithVotes(owner);
    const run = (
      caller: PageCaller,
      command: Parameters<typeof pageDataCommand>[2]["command"],
      key: string | null = null,
    ) =>
      pageDataCommand(
        db(),
        { objects },
        {
          artifactId,
          region: "default",
          limits: LIMITS,
          caller,
          command,
          idempotencyKey: key,
          now: NOW,
        },
      );

    const created = await run(
      ALICE,
      { kind: "create", collection: "votes", body: { choice: "a" } },
      "k1",
    );
    expect(created.result.ok).toBe(true);
    expect(created.storage?.seq).toBeGreaterThan(0);
    const id = (value(created.result).value as { _id: string })._id;

    // The same key from the same visitor is the same operation: replayed, never applied twice.
    const again = await run(
      ALICE,
      { kind: "create", collection: "votes", body: { choice: "a" } },
      "k1",
    );
    expect(value(again.result).replayed).toBe(true);

    expect(
      value((await run(ALICE, { kind: "get", collection: "votes", id })).result).value,
    ).toMatchObject({
      choice: "a",
      _by: ALICE.kind === "visitor" ? ALICE.author : "",
    });
    expect((await run(BOB, { kind: "get", collection: "votes", id })).result).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const mine = value((await run(ALICE, { kind: "export_mine", after: null })).result).value as {
      rows: unknown[];
    };
    expect(mine.rows).toHaveLength(1);
  });

  it("answers not_found for an artifact without data and never reaches an object", async () => {
    const person = await user("Owner");
    const { artifactId } = await publishSite(person.id);
    let reached = false;
    const objects: DataObjects = {
      region: "default",
      createsObjects: true,
      object: () => {
        reached = true;
        throw new Error("no object for an artifact without data");
      },
    };
    const answer = await pageDataCommand(
      db(),
      { objects },
      {
        artifactId,
        region: "default",
        limits: LIMITS,
        caller: ALICE,
        command: { kind: "query", query: { collection: "votes" } },
        idempotencyKey: null,
        now: NOW,
      },
    );
    expect(answer).toEqual({
      result: { ok: false, code: "not_found", message: "This artifact has no data." },
      storage: null,
    });
    expect(reached).toBe(false);
  });

  it("pauses page writes under budget protection's data step but keeps deletes and reads", async () => {
    const { objects, owner } = harness();
    const { artifactId, ownerId } = await artifactWithVotes(owner);
    const run = (command: Parameters<typeof pageDataCommand>[2]["command"]) =>
      pageDataCommand(
        db(),
        { objects },
        {
          artifactId,
          region: "default",
          limits: LIMITS,
          caller: ALICE,
          command,
          idempotencyKey: null,
          now: NOW,
        },
      );
    const id = (
      value((await run({ kind: "create", collection: "votes", body: { choice: "b" } })).result)
        .value as {
        _id: string;
      }
    )._id;
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      expect(
        (await run({ kind: "create", collection: "votes", body: { choice: "c" } })).result,
      ).toMatchObject({
        ok: false,
        code: "capacity_unavailable",
      });
      expect((await run({ kind: "query", query: { collection: "votes" } })).result.ok).toBe(true);
      expect((await run({ kind: "remove", collection: "votes", id })).result.ok).toBe(true);
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
    // The owner side is unaffected by the page's caller.
    expect(
      (
        await createDataDocument(db(), owner, {
          userId: ownerId,
          artifactId,
          now: NOW,
          idempotencyKey: crypto.randomUUID(),
          collection: "votes",
          body: { choice: "owner" },
        })
      ).ok,
    ).toBe(true);
  });

  it("answers capacity_unavailable without the binding", async () => {
    const { owner } = harness();
    const { artifactId } = await artifactWithVotes(owner);
    const answer = await pageDataCommand(
      db(),
      { objects: null },
      {
        artifactId,
        region: "default",
        limits: LIMITS,
        caller: { kind: "reader" },
        command: { kind: "query", query: { collection: "votes" } },
        idempotencyKey: null,
        now: NOW,
      },
    );
    expect(answer.result).toMatchObject({ ok: false, code: "capacity_unavailable" });
  });
});
