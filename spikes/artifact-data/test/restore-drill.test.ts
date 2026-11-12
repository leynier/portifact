import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DRILL_LIMITS,
  Drill,
  idsFor,
  matches,
  type Probe,
  SCENARIOS,
  type ScenarioIds,
  type ScenarioResult,
  type ScenarioState,
} from "../src/drill.ts";

// Experiment 2 of decision 0026's delivery 2, local half: every transition the record lists, on
// both sides of a restore point, with real Durable Object storage and R2 in workerd and a local
// D1 restored by snapshot (Time Travel does not exist in workerd). The deployed half runs the
// same scenarios with a real Time Travel restore (drill/runbook.ts).

const drill = new Drill({ db: env.MAIN, bucket: env.JOURNAL, documents: env.DOCUMENTS });
const run = "l";
const ids = SCENARIOS.map((_, index) => idsFor(index, run));
const states: ScenarioState[] = SCENARIOS.map(() => ({}));
const results: ScenarioResult[] = [];
let actions: Record<string, string> = {};
let windowWrite = "";

function at(name: string): ScenarioIds {
  const index = SCENARIOS.findIndex((scenario) => scenario.name === name);
  return ids[index] as ScenarioIds;
}

beforeAll(async () => {
  await drill.setup();
  for (const [index, scenario] of SCENARIOS.entries())
    await scenario.before(drill, ids[index] as ScenarioIds, states[index] as ScenarioState);
  const point = await drill.snapshot();
  for (const [index, scenario] of SCENARIOS.entries())
    await scenario.after(drill, ids[index] as ScenarioIds, states[index] as ScenarioState);
  const exported = await drill.exportTombstones();
  for (const [index, scenario] of SCENARIOS.entries())
    await scenario.afterExport?.(drill, ids[index] as ScenarioIds, states[index] as ScenarioState);
  await drill.restore(point);
  // Between the restore and apply-tombstones a revoked grant is live again: why requests stop.
  const revoked = at("revocation after the restore point");
  windowWrite = await drill.visitorWrite(revoked.artifact, revoked.visitor, { window: true });
  await drill.applyTombstones(exported);
  actions = await drill.reconcileAll();
  for (const [index, scenario] of SCENARIOS.entries()) {
    const scenarioIds = ids[index] as ScenarioIds;
    const probe: Probe = await drill.probe(
      scenarioIds.artifact,
      scenario.probeOwner(scenarioIds),
      scenarioIds.visitor,
    );
    results.push({
      name: scenario.name,
      transition: scenario.transition,
      action: actions[scenarioIds.artifact] ?? "missing",
      expectedAction: scenario.action,
      probe,
      expected: scenario.expected,
      pass: matches(probe, scenario.expected) && actions[scenarioIds.artifact] === scenario.action,
    });
  }
  console.log(JSON.stringify({ measure: "restore_drill", windowWrite, results }));
});

describe("the restore drill (local, snapshot restore)", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: ${scenario.action}, as the recovery table says`, () => {
      const result = results.find((entry) => entry.name === scenario.name);
      expect(result?.action).toBe(scenario.action);
      expect(result?.probe).toMatchObject({
        ownerRead: scenario.expected.ownerRead,
        ownerWrite: scenario.expected.ownerWrite,
        visitorWrite: scenario.expected.visitorWrite,
        operatorExport: scenario.expected.operatorExport,
        quarantined: scenario.expected.quarantined,
      });
      if (scenario.expected.documents !== "any")
        expect(result?.probe.documents).toBe(scenario.expected.documents);
      expect(result?.pass).toBe(true);
    });
  }

  it("leaves a revoked grant live between the restore and apply-tombstones", () => {
    // The record's assumption: requests are stopped across that window (operations.md, step 0).
    expect(windowWrite).toBe("ok");
  });

  it("ends a transfer's quarantine by adoption: the new owner acts, the former one never", async () => {
    const t = at("transfer after the restore point");
    const before = await drill.stub(t.artifact).controlRecord();
    // Only the operator acts on quarantined data; adopting needs D1 to name the object's owner.
    expect(await drill.resolve(t.artifact, "adopt")).toEqual({ ok: true });
    expect(await drill.ownerRead(t.artifact, t.newOwner)).toBe("ok");
    expect(await drill.ownerWrite(t.artifact, t.newOwner)).toBe("ok");
    expect(await drill.ownerRead(t.artifact, t.owner)).toBe("forbidden");
    // Even an envelope forged with the former owner at any epoch is stale in the object.
    for (const epoch of [0, (before?.epoch ?? 0) + 5]) {
      expect(
        await drill.direct(
          t.artifact,
          { artifactId: t.artifact, region: "default", ownerId: t.owner, generation: 0, epoch },
          { kind: "owner" },
        ),
      ).toBe("stale");
    }
    expect(await drill.visitorWrite(t.artifact, t.visitor, { after: "adopt" })).toBe("ok");
  });

  it("keeps a held quarantine until a release: erasing is refused, adopting restores the hold", async () => {
    const h = at("hold after the export (missing from it)");
    expect(await drill.resolve(h.artifact, "erase")).toEqual({ ok: false });
    expect((await drill.operatorExport(h.artifact)).documents).toBe(1);
    expect(await drill.resolve(h.artifact, "adopt")).toEqual({ ok: true });
    expect(await drill.ownerRead(h.artifact, h.owner)).toBe("held");
    await drill.release(h.artifact);
    expect(await drill.ownerWrite(h.artifact, h.owner)).toBe("ok");
  });

  it("ends a new artifact's quarantine by erasing or adopting it", async () => {
    const n = at("new artifact after the restore point");
    expect(await drill.resolve(n.artifact, "erase")).toEqual({ ok: true });
    const control = await drill.stub(n.artifact).controlRecord();
    expect(control).toMatchObject({ generation: 1, quarantine: null });
    expect((await drill.operatorExport(n.artifact)).documents).toBe(0);
    // Erasing leaves no D1 row: the artifact stays unreachable until the operator adopts it.
    expect(await drill.ownerRead(n.artifact, n.owner)).toBe("not_found");
    expect(await drill.resolve(n.artifact, "adopt")).toEqual({ ok: false });
  });

  it("asks a visitor whose grant the restore lost to consent again, under the same identity", async () => {
    const g = at("grant after the restore point");
    expect(await drill.visitorIdOf(g.artifact, g.visitor)).toBeNull();
    expect(await drill.regrant(g.artifact, g.visitor)).toBe("granted");
    expect(await drill.visitorWrite(g.artifact, g.visitor, { again: true })).toBe("ok");
    const visitorId = (await drill.visitorIdOf(g.artifact, g.visitor)) as string;
    const mine = await drill.stub(g.artifact).query(
      drill.envelope((await drill.row(g.artifact)) ?? fail(), false),
      {
        caller: { kind: "visitor", author: visitorId, canWrite: true },
        limits: DRILL_LIMITS,
        now: Date.now(),
      },
      { collection: "notes" },
    );
    // The document written after the restore point is still the person's own.
    expect(mine.ok && "value" in mine ? mine.value.documents.length : -1).toBe(2);
  });

  it("never revives an erased author: no grant, the journal refuses, the barrier refuses", async () => {
    const a = at("author erasure after the restore point");
    expect(await drill.visitorIdOf(a.artifact, a.visitor)).toBeNull();
    expect(await drill.regrant(a.artifact, a.visitor)).toBe("retired");
    const row = (await drill.row(a.artifact)) ?? fail();
    const exported = await drill
      .stub(a.artifact)
      .exportPage(
        drill.envelope(row, false),
        { caller: { kind: "owner" }, limits: DRILL_LIMITS, now: Date.now() },
        null,
        500,
      );
    // Only the owner's probe document is left: nothing of the erased author came back.
    const authors = exported.ok && "value" in exported ? exported.value.rows.map((r) => r.by) : [];
    expect(authors).toEqual(["owner"]);
  });

  it("refuses an envelope from before an erase the restore rewound", async () => {
    for (const name of [
      "whole erase prepared and committed after the restore point",
      "whole erase prepared before and committed after the restore point",
      "whole erase prepared after the restore point",
    ]) {
      const e = at(name);
      expect(
        await drill.direct(
          e.artifact,
          { artifactId: e.artifact, region: "default", ownerId: e.owner, generation: 0, epoch: 9 },
          { kind: "owner" },
        ),
      ).toBe("stale");
    }
  });

  it("raises D1's epoch again on every rerun (not a fixpoint), and changes no access", async () => {
    // reconcile() answers `raise` with max(epochs) + 1 whenever the numbers differ, and after a
    // raise they always differ, so each pass raises D1's epoch once more. Harmless for access
    // (a newer epoch is admitted, never adopted) but the record says "raised to them": delivery 3
    // should raise only when D1 is behind.
    const raised = Object.entries(actions)
      .filter(([, action]) => action === "raise")
      .map(([artifact]) => artifact)
      .sort();
    const again = await drill.reconcileAll();
    const raisedAgain = Object.entries(again)
      .filter(([, action]) => action === "raise")
      .map(([artifact]) => artifact)
      .sort();
    expect(raisedAgain).toEqual(raised);
    expect(Object.values(again)).not.toContain("resume_erase");
    const r = at("release after the restore point");
    expect(await drill.ownerWrite(r.artifact, r.owner)).toBe("ok");
  });

  it("keeps the write a revoked grant made in the restore window", () => {
    const result = results.find((entry) => entry.name === "revocation after the restore point");
    expect(result?.probe.documents).toBe(1);
  });

  it("cleans its bucket entries", async () => {
    expect(await drill.clearBucket()).toBeGreaterThan(0);
    expect(await drill.clearBucket()).toBe(0);
  });
});

function fail(): never {
  throw new Error("missing row");
}
