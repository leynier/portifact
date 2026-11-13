// The restore drill of delivery 2, repeated with the real documents object and the real services
// (decision 0026, "Restore" and "Feasibility results", experiment 2). Each scenario runs its
// transitions on both sides of a restore point through the services that make them in
// production; the restore puts back D1's rows about the scenario's artifact as they were at the
// point (D1 Time Travel does not exist in workerd: the objects and R2 are not rewound, exactly as
// in production); then the operator's runbook: `export-tombstones` before, the holds and markers
// applied after, the data jobs those write, and `data-reconcile` (the region's `data_reconcile`
// job, both phases). The probes are the owner side's write at D1's numbers, the operator's
// export, and what reconciliation recorded.
//
// The grant scenarios of delivery 2 (a grant and a revocation after the point) need `data_grants`,
// which delivery 6 adds with the grant flow; the author journal they rest on is here.

import { env } from "cloudflare:test";
import type { TombstoneMarker } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { claimOutcome, controlEnvelope, LIFECYCLE_LIMITS } from "@portifact/domain/artifact-data";
import {
  applyLegalHolds,
  applyTombstones,
  type DataObjectRpc,
  deleteArtifactData,
  exportLegalHolds,
  lifecycleId,
  placeLegalHold,
  queueDataReconcile,
  queueDataResolve,
  releaseLegalHold,
  scheduleAuthorErasures,
} from "@portifact/services";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { value } from "../../../packages/services/test/fixtures.ts";
import {
  claimJournal,
  controlOf,
  D1_NOW,
  DATA_NOW,
  db,
  documentsOf,
  drain,
  inside,
  jobsOf,
  journalOf,
  reviewedOf,
  stubOf,
  visitorId,
  withData,
} from "./lifecycle.ts";

const regions = () => regionsFromEnv(env);

/** The rows a restore rewinds about one artifact, as they were at the point. */
interface Point {
  artifacts: Record<string, unknown>[];
  data: Record<string, unknown>[];
  holds: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  tombstones: Record<string, unknown>[];
}

async function point(id: string): Promise<Point> {
  const r = regions();
  const home = r.get("default").db;
  return {
    artifacts: await home.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)),
    data: await home
      .select()
      .from(schema.artifactData)
      .where(eq(schema.artifactData.artifactId, id)),
    holds: await home.select().from(schema.legalHolds).where(eq(schema.legalHolds.artifactId, id)),
    outbox: await home.select().from(schema.outbox).where(eq(schema.outbox.subject, id)),
    findings: await home
      .select()
      .from(schema.dataFindings)
      .where(eq(schema.dataFindings.artifactId, id)),
    tombstones: await r.global.select().from(schema.tombstones).where(eq(schema.tombstones.id, id)),
  };
}

/** The local stand-in for D1 Time Travel: the artifact's rows back to the point. */
async function restore(id: string, at: Point): Promise<void> {
  const r = regions();
  const home = r.get("default").db;
  await home.delete(schema.dataFindings).where(eq(schema.dataFindings.artifactId, id));
  await home.delete(schema.outbox).where(eq(schema.outbox.subject, id));
  await home
    .delete(schema.legalHoldIdentities)
    .where(
      inArray(
        schema.legalHoldIdentities.holdId,
        sql`(select ${schema.legalHolds.id} from ${schema.legalHolds} where ${schema.legalHolds.artifactId} = ${id})`,
      ),
    );
  await home.delete(schema.legalHolds).where(eq(schema.legalHolds.artifactId, id));
  await home.delete(schema.artifacts).where(eq(schema.artifacts.id, id));
  await r.global.delete(schema.tombstones).where(eq(schema.tombstones.id, id));
  const put = async (table: Parameters<typeof home.insert>[0], rows: Record<string, unknown>[]) => {
    for (const row of rows) await home.insert(table).values(row as never);
  };
  await put(schema.artifacts, at.artifacts);
  await put(schema.artifactData, at.data);
  await put(schema.legalHolds, at.holds);
  await put(schema.outbox, at.outbox);
  await put(schema.dataFindings, at.findings);
  for (const row of at.tombstones) await r.global.insert(schema.tombstones).values(row as never);
}

/** `export-tombstones` before the restore: the artifact's holds and markers. */
async function exported(id: string) {
  const holds = (await exportLegalHolds(regions())).filter(
    (line) => line.legalHold.artifactId === id,
  );
  const markers: TombstoneMarker[] = (
    await regions().global.select().from(schema.tombstones).where(eq(schema.tombstones.id, id))
  ).map((row) => ({ kind: row.kind, id: row.id, deletedAt: row.deletedAt }) as TombstoneMarker);
  return { holds, markers };
}

/** The runbook after the restore: holds first, then markers, their jobs, then reconciliation. */
async function afterRestore(file: Awaited<ReturnType<typeof exported>>, id: string) {
  await applyLegalHolds(regions(), file.holds, D1_NOW);
  if (file.markers.length > 0) await applyTombstones(regions(), file.markers, D1_NOW);
  // A re-applied purge (its artifact tombstone) runs its purge like any.
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  if (row?.state === "purging") await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
  await drain({ subject: id });
  await reconcileRegion();
}

/** `data-reconcile` for the default region: its job until both phases are done. */
async function reconcileRegion() {
  await queueDataReconcile(db(), DATA_NOW);
  for (let round = 0; round < 200; round += 1) {
    const left = await jobsOf(db(), ["data_reconcile"]);
    if (left.length === 0) return;
    await drain({ rounds: 1 });
  }
  throw new Error("reconciliation did not finish");
}

async function findingOf(id: string) {
  const [finding] = await db()
    .select()
    .from(schema.dataFindings)
    .where(eq(schema.dataFindings.artifactId, id));
  return finding === undefined
    ? "none"
    : `${finding.action}${finding.reason ? `:${finding.reason}` : ""}`;
}

/** The owner side's write, at the numbers D1 now holds, as the owner API will send it. */
async function ownerWrite(id: string): Promise<string> {
  const [row] = await db()
    .select({
      ownerId: schema.artifacts.ownerId,
      generation: schema.artifactData.generation,
      epoch: schema.artifactData.epoch,
    })
    .from(schema.artifacts)
    .innerJoin(schema.artifactData, eq(schema.artifactData.artifactId, schema.artifacts.id))
    .where(eq(schema.artifacts.id, id));
  if (!row) return "not_found";
  const answer = await inside(id, (object) =>
    object.store.create(
      { artifactId: id, region: "default", opId: lifecycleId(DATA_NOW), ...row },
      { kind: "owner" },
      "notes",
      { probe: true },
      { now: DATA_NOW, limits: LIFECYCLE_LIMITS },
    ),
  );
  return answer.ok ? "ok" : answer.code;
}

/** The operator's export, under the object's own identity: allowed held or quarantined. */
async function operatorExport(id: string): Promise<string> {
  const control = await controlOf(id);
  if (control === null) return "empty";
  const page = await (stubOf(id) as unknown as DataObjectRpc).lifecycleExport(
    controlEnvelope(control),
    null,
    DATA_NOW,
  );
  return page.ok ? `ok:${page.value.rows.length}` : page.code;
}

async function probe(id: string) {
  return {
    finding: await findingOf(id),
    exported: await operatorExport(id),
    owner: await ownerWrite(id),
  };
}

const hold = async (id: string) =>
  value(
    await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW }),
  );

function envelopeAt(id: string, ownerId: string, generation: number, epoch: number) {
  return { artifactId: id, region: "default", ownerId, generation, epoch };
}

describe("the restore drill with the real object", () => {
  it("control: nothing after the point changes nothing", async () => {
    const { id } = await withData();
    const file = await exported(id);
    await restore(id, await point(id));
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({ finding: "none", exported: "ok:1", owner: "ok" });
  });

  it("a hold after the point: re-applied by apply-tombstones, D1 raised to the object", async () => {
    const { id } = await withData({ state: "suspended" });
    const at = await point(id);
    await hold(id);
    await drain({ subject: id });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({ finding: "raised", exported: "ok:1", owner: "held" });
  });

  it("a hold placed after the export: quarantined for the operator", async () => {
    const { id } = await withData({ state: "suspended" });
    const at = await point(id);
    const file = await exported(id);
    await hold(id);
    await drain({ subject: id });
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({
      finding: "quarantined:hold",
      exported: "ok:1",
      owner: "quarantined",
    });
  });

  it("a release after the point: re-released, the same transition acknowledged again", async () => {
    const { id } = await withData({ state: "suspended" });
    await hold(id);
    await drain({ subject: id });
    const at = await point(id);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    await drain({ subject: id });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({ finding: "none", exported: "ok:1", owner: "ok" });
    expect((await controlOf(id))?.hold).toBeNull();
  });

  it("a hold and its release after the point: D1 raised past the object", async () => {
    const { id } = await withData({ state: "suspended" });
    const at = await point(id);
    await hold(id);
    await drain({ subject: id });
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    await drain({ subject: id });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({ finding: "raised", exported: "ok:1", owner: "ok" });
  });

  it("a transfer after the point: quarantined, then adopted once D1 names the new owner", async () => {
    const { id, ownerId } = await withData();
    const at = await point(id);
    const newOwner = `u_${crypto.randomUUID()}`;
    await inside(id, (object) =>
      object.store.fence(
        envelopeAt(id, ownerId, 0, 1),
        { kind: "transfer", transition: "transfer_drill", toOwner: newOwner },
        DATA_NOW,
      ),
    );
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({
      finding: "quarantined:owner",
      exported: "ok:1",
      owner: "quarantined",
    });
    // A forged envelope naming the former owner is refused at any epoch.
    const forged = await inside(id, (object) =>
      object.store.create(
        { ...envelopeAt(id, ownerId, 0, 99), opId: lifecycleId(DATA_NOW) },
        { kind: "owner" },
        "notes",
        {},
        { now: DATA_NOW, limits: LIFECYCLE_LIMITS },
      ),
    );
    expect(forged.ok || forged.code).toBe("quarantined");
    // The operator repairs ownership, then adopts.
    await db()
      .update(schema.artifacts)
      .set({ ownerId: newOwner })
      .where(eq(schema.artifacts.id, id));
    await queueDataResolve(db(), id, "adopt", await reviewedOf(id), DATA_NOW);
    await drain({ subject: id });
    // The export comes before the probe's own write.
    expect(await probe(id)).toEqual({ finding: "adopted", exported: "ok:1", owner: "ok" });
  });

  it("a whole erase prepared after the point: resumed under its ID", async () => {
    const { id, ownerId } = await withData({ documents: 2 });
    const at = await point(id);
    const eraseId = lifecycleId(DATA_NOW);
    await inside(id, (object) =>
      object.store.prepareErase(envelopeAt(id, ownerId, 0, 0), eraseId, DATA_NOW),
    );
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({
      finding: "resumed_erase",
      exported: "ok:0",
      owner: "not_found",
    });
    expect((await controlOf(id))?.lastErase).toEqual({ id: eraseId, outcome: "committed" });
  });

  it("a whole erase committed after the point: D1 raised to the new generation", async () => {
    const { id, ownerId } = await withData({ documents: 2 });
    const at = await point(id);
    const eraseId = lifecycleId(DATA_NOW);
    await inside(id, (object) => {
      object.store.prepareErase(envelopeAt(id, ownerId, 0, 0), eraseId, DATA_NOW);
      object.store.commitErase(envelopeAt(id, ownerId, 0, 0), eraseId, DATA_NOW);
    });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({ finding: "raised", exported: "ok:0", owner: "not_found" });
    expect(
      (
        await db().select().from(schema.artifactData).where(eq(schema.artifactData.artifactId, id))
      )[0]?.generation,
    ).toBe(1);
  });

  it("a purge after the point: re-applied by its tombstone, nothing comes back", async () => {
    const { id } = await withData({ state: "purging", documents: 2 });
    const at = await point(id);
    await deleteArtifactData(db(), env.ARTIFACTS, id, D1_NOW);
    await drain({ subject: id });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await documentsOf(id)).toBe(0);
    // The re-applied purge proves the deletion, so it erases the object's own (empty) generation.
    expect((await controlOf(id))?.generation).toBe(2);
    expect(await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id))).toEqual(
      [],
    );
    expect(await findingOf(id)).toBe("none");
  });

  it("an artifact created after the point: quarantined as an orphan, then erased", async () => {
    const at = { artifacts: [], data: [], holds: [], outbox: [], findings: [], tombstones: [] };
    const { id } = await withData({ documents: 2 });
    const file = await exported(id);
    await restore(id, at);
    await afterRestore(file, id);
    expect(await probe(id)).toEqual({
      finding: "quarantined:orphan",
      exported: "ok:2",
      owner: "not_found",
    });
    await queueDataResolve(db(), id, "erase", await reviewedOf(id), DATA_NOW);
    await drain({ subject: id });
    expect(await probe(id)).toEqual({ finding: "erased", exported: "ok:0", owner: "not_found" });
    // The erased orphan's entry is retired: a second walk leaves it alone.
    await reconcileRegion();
    expect(await findingOf(id)).toBe("erased");
  });

  it("a held orphan cannot be erased before its release", async () => {
    const { id, ownerId } = await withData({ documents: 1 });
    await inside(id, (object) =>
      object.store.fence(
        envelopeAt(id, ownerId, 0, 1),
        { kind: "hold", transition: "hold_drill" },
        DATA_NOW,
      ),
    );
    await restore(id, {
      artifacts: [],
      data: [],
      holds: [],
      outbox: [],
      findings: [],
      tombstones: [],
    });
    await reconcileRegion();
    expect(await findingOf(id)).toBe("quarantined:orphan");
    await queueDataResolve(db(), id, "erase", await reviewedOf(id), DATA_NOW);
    await drain({ subject: id });
    expect(await findingOf(id)).toBe("refused:held");
    expect(await documentsOf(id)).toBe(1);
  });

  it("an author erasure after the point: re-derived from the retired journal, nothing comes back", async () => {
    const userId = `u_${crypto.randomUUID()}`;
    const visitor = visitorId();
    const { id } = await withData({ state: "suspended", visitors: [visitor] });
    await claimJournal(userId, id, visitor);
    // The hold keeps the erasure waiting, so the restore loses a job that has not run.
    await hold(id);
    await drain({ subject: id });
    const at = await point(id);
    await scheduleAuthorErasures(db(), env.ARTIFACTS, userId, DATA_NOW);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toHaveLength(1);
    const file = await exported(id);
    await restore(id, at);
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toEqual([]);
    await afterRestore(file, id);
    // Re-derived from the journal's retired entry, never from the rewound outbox.
    expect(await jobsOf(db(), ["data_author_erasure"], id)).toHaveLength(1);
    await releaseLegalHold(db(), { artifactId: id, now: D1_NOW });
    await drain({ subject: id });
    const { runHoldRelease } = await import("@portifact/services");
    await runHoldRelease(db(), undefined, id, DATA_NOW);
    await drain({ subject: id });
    expect(await documentsOf(id, visitor)).toBe(0);
    expect(claimOutcome(await journalOf(userId, id), visitorId()).ok).toBe(false);
  });
});
