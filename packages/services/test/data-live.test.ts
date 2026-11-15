// Live updates' services (decision 0026, delivery 7) against the in-memory reference object: the
// switches, the artifact's state, the data row, budget protection's data step, the owner's plan
// limits, the hello message, renewal by the same principal and the owner side's live counters.
import { env } from "cloudflare:test";
import { ARTIFACT_DATA, LiveHello } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { MemoryObject } from "@portifact/domain/testing/artifact-data";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import {
  type DataObjects,
  dataLiveEnabled,
  declareDataCollection,
  describeArtifactData,
  type LiveDeps,
  type OwnerDataDeps,
  openLiveConnection,
  renewLiveConnection,
} from "../src/index.ts";
import { liveRpc } from "./data-live-rpc.ts";
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
    createsObjects: true,
    object: (id) => ({ ...ownerRpc(of(id)), ...liveRpc(of(id)) }) as never,
  };
  const owner: OwnerDataDeps = { objects, bucket: env.ARTIFACTS, enabled: true };
  const live: LiveDeps = { objects, enabled };
  return { owner, live, of };
}

const VISITOR = "v_AAAAAAAAAAAAAAAAAAAA";

async function withData(deps: OwnerDataDeps) {
  const person = await user("Owner");
  const { artifactId } = await publishSite(person.id);
  value(
    await declareDataCollection(db(), deps, {
      userId: person.id,
      artifactId,
      now: NOW,
      idempotencyKey: `key-${crypto.randomUUID()}`,
      declaration: { name: "votes", mode: "shared" },
    }),
  );
  return { person, artifactId };
}

const caller = (artifactId: string, principal = "dg_one", author: string | null = VISITOR) => ({
  artifactId,
  author,
  principal,
  // The credential's claims hold well past these tests unless one says otherwise.
  expiresAt: NOW + 10 * 60_000,
  now: NOW,
});

describe("opening a live connection", () => {
  it("answers 101 with the client end, after the object sent its hello", async () => {
    const { owner, live, of } = harness();
    const { artifactId } = await withData(owner);
    const opened = value(await openLiveConnection(db(), live, caller(artifactId)));
    expect(opened.status).toBe(101);
    expect(opened.webSocket).not.toBeNull();
    const [socket] = [...of(artifactId).sockets.values()];
    expect(socket?.attachment).toMatchObject({ author: VISITOR, principal: "dg_one" });
    expect(socket?.attachment.deadline).toBe(NOW + ARTIFACT_DATA.live.deadlineMs);
    const hello = LiveHello.parse(JSON.parse(socket?.received[0] ?? "null"));
    expect(hello).toEqual({
      connected: socket?.attachment.socketId,
      deadline: NOW + ARTIFACT_DATA.live.deadlineMs,
    });
    // A reader connects too, under its own principal.
    expect((await openLiveConnection(db(), live, caller(artifactId, "rs_reader", null))).ok).toBe(
      true,
    );
  });

  it("answers not_found while switched off, without data, or on an archived artifact", async () => {
    const off = harness(false);
    const { artifactId } = await withData(off.owner);
    expect(await openLiveConnection(db(), off.live, caller(artifactId))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(off.of(artifactId).sockets.size).toBe(0);

    const { owner, live } = harness();
    const person = await user("Owner");
    const { artifactId: empty } = await publishSite(person.id);
    expect(await openLiveConnection(db(), live, caller(empty))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const { artifactId: archived } = await withData(owner);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, archived));
    expect(await openLiveConnection(db(), live, caller(archived))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await openLiveConnection(db(), { objects: null, enabled: true }, caller(archived)),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
  });

  it("is stopped by budget protection's data step, as new writes are", async () => {
    const { owner, live, of } = harness();
    const { artifactId } = await withData(owner);
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 2,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      expect(await openLiveConnection(db(), live, caller(artifactId))).toMatchObject({
        ok: false,
        code: "capacity_unavailable",
      });
      expect(of(artifactId).sockets.size).toBe(0);
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
  });

  it("holds the owner's plan's connection limits, and Team's are wider", async () => {
    const { owner, live } = harness();
    const { person, artifactId } = await withData(owner);
    const perAuthor = Array.from({ length: 6 }, () => caller(artifactId));
    const answers = [];
    for (const one of perAuthor) answers.push(await openLiveConnection(db(), live, one));
    const refused = answers.find((answer) => !answer.ok);
    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    await grantPlan(person.id, "team");
    const plan = value(
      await describeArtifactData(db(), owner, { userId: person.id, artifactId, now: NOW }),
    );
    expect(plan.limits.connectionsPerArtifact).toBe(25);
  });
});

describe("renewing and the owner's counters", () => {
  it("renews for the same principal only, with the plan's current limits", async () => {
    const { owner, live, of } = harness();
    const { person, artifactId } = await withData(owner);
    value(await openLiveConnection(db(), live, caller(artifactId)));
    const [socket] = [...of(artifactId).sockets.values()];
    const socketId = socket?.attachment.socketId ?? "";
    const later = NOW + 30_000;
    expect(
      value(await renewLiveConnection(db(), live, { ...caller(artifactId), now: later, socketId })),
    ).toEqual({ deadline: later + ARTIFACT_DATA.live.deadlineMs });
    expect(socket?.attachment.deadline).toBe(later + ARTIFACT_DATA.live.deadlineMs);
    expect(
      await renewLiveConnection(db(), live, {
        ...caller(artifactId, "dg_other"),
        now: later,
        socketId,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    // Switched off, a renewal is refused and the connection ends at its deadline.
    expect(
      await renewLiveConnection(
        db(),
        { ...live, enabled: false },
        { ...caller(artifactId), now: later, socketId },
      ),
    ).toMatchObject({ ok: false, code: "not_found" });

    const described = value(
      await describeArtifactData(db(), owner, { userId: person.id, artifactId, now: later }),
    );
    expect(described.live.connections).toBe(1);
    expect(described.live.messagesToday).toBeGreaterThan(0);
    expect(described.limits.liveMessagesPerDay).toBeGreaterThan(0);
  });

  it("never gives a connection a deadline past its credential's claims", async () => {
    const { owner, live, of } = harness();
    const { artifactId } = await withData(owner);
    const soon = NOW + 20_000;
    value(await openLiveConnection(db(), live, { ...caller(artifactId), expiresAt: soon }));
    const [socket] = [...of(artifactId).sockets.values()];
    expect(socket?.attachment.deadline).toBe(soon);
    const socketId = socket?.attachment.socketId ?? "";
    expect(
      value(
        await renewLiveConnection(db(), live, {
          ...caller(artifactId),
          now: NOW + 10_000,
          expiresAt: soon,
          socketId,
        }),
      ),
    ).toEqual({ deadline: soon });
    // Claims already over renew nothing.
    expect(
      await renewLiveConnection(db(), live, {
        ...caller(artifactId),
        now: soon,
        expiresAt: soon,
        socketId,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("reads both switches", () => {
    expect(dataLiveEnabled({ ARTIFACT_DATA_ENABLED: "true", DATA_LIVE_ENABLED: "true" })).toBe(
      true,
    );
    expect(dataLiveEnabled({ ARTIFACT_DATA_ENABLED: "true" })).toBe(false);
    expect(dataLiveEnabled({ DATA_LIVE_ENABLED: "true" })).toBe(false);
  });
});
