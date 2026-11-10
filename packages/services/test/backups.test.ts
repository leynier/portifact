import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { requestAccountDeletion } from "../src/account-data.ts";
import {
  applyTombstones,
  exportTombstones,
  listStorageFindings,
  ORPHAN_GRACE_MS,
  reconcileStorage,
} from "../src/backups.ts";
import { deleteArtifact } from "../src/lifecycle.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { artifactRow, DAY, db, NOW, publishSite, session, sha256, user } from "./fixtures.ts";

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

// Storage is shared by the tests of this file, so the reconciliation tests look only at the keys
// they created and run each scan to the end of its pass.
let clock = Date.now() + ORPHAN_GRACE_MS;
/** A later time for each pass: the scans keep when their current pass started. */
const later = () => {
  clock += DAY;
  return clock;
};

async function verifiedObject(ownerId: string, body: string, rowSize = body.length) {
  const hash = await sha256(body);
  const key = `objects/${ownerId}/${hash}`;
  await db().insert(schema.objects).values({
    ownerId,
    sha256: hash,
    size: rowSize,
    r2Key: key,
    state: "verified",
  });
  return key;
}

async function findingsFor(ownerId: string) {
  return db()
    .select({ kind: schema.storageFindings.kind, r2Key: schema.storageFindings.r2Key })
    .from(schema.storageFindings)
    .where(like(schema.storageFindings.r2Key, `objects/${ownerId}/%`));
}

/** Runs the reconciliation until both scans have finished a pass. */
async function fullPass(now: number, rowLimit = 50, listLimit = 100) {
  const totals = { checkedRows: 0, listedObjects: 0, runs: 0 };
  for (;;) {
    const result = await reconcileStorage(db(), env.ARTIFACTS, now, rowLimit, listLimit);
    totals.checkedRows += result.checkedRows;
    totals.listedObjects += result.listedObjects;
    totals.runs += 1;
    const cursors = await db().select().from(schema.maintenanceCursors);
    if (cursors.every((cursor) => cursor.cursor === "")) return totals;
    if (totals.runs > 50) throw new Error("reconciliation never finished a pass");
  }
}

describe("storage reconciliation", () => {
  it("reports missing objects, size mismatches and old orphans without deleting anything", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const fine = await verifiedObject(owner, "fine");
    await env.ARTIFACTS.put(fine, "fine");
    const missing = await verifiedObject(owner, "missing");
    const resized = await verifiedObject(owner, "resized", 3);
    await env.ARTIFACTS.put(resized, "resized");
    const orphan = `objects/${owner}/${"0".repeat(64)}`;
    await env.ARTIFACTS.put(orphan, "nobody references me");
    // A pending row is an upload in flight: its bytes are not expected yet.
    await db()
      .insert(schema.objects)
      .values({
        ownerId: owner,
        sha256: "1".repeat(64),
        size: 1,
        r2Key: `objects/${owner}/${"1".repeat(64)}`,
      });

    await fullPass(later());
    expect((await findingsFor(owner)).sort((a, b) => a.r2Key.localeCompare(b.r2Key))).toEqual(
      [
        { kind: "missing", r2Key: missing },
        { kind: "orphan", r2Key: orphan },
        { kind: "size_mismatch", r2Key: resized },
      ].sort((a, b) => a.r2Key.localeCompare(b.r2Key)),
    );
    const listed = await listStorageFindings(db(), 500);
    expect(listed.find((finding) => finding.r2Key === resized)?.detail).toBe(
      "row 3 bytes, object 7 bytes",
    );
    // Nothing was deleted or repaired.
    expect(await env.ARTIFACTS.head(orphan)).not.toBeNull();
    const rows = await db().select().from(schema.objects).where(eq(schema.objects.ownerId, owner));
    expect(rows).toHaveLength(4);
  });

  it("does not report a recent object without a row, which may be in flight", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    await env.ARTIFACTS.put(`objects/${owner}/${"2".repeat(64)}`, "just uploaded");
    await fullPass(Date.now());
    expect(await findingsFor(owner)).toEqual([]);
  });

  it("works through storage a bounded slice per run and resumes where it stopped", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    for (let i = 0; i < 7; i += 1) {
      const key = await verifiedObject(owner, `body ${i}`);
      await env.ARTIFACTS.put(key, `body ${i}`);
    }
    const first = await reconcileStorage(db(), env.ARTIFACTS, later(), 2, 3);
    expect(first.checkedRows).toBeLessThanOrEqual(2);
    expect(first.listedObjects).toBeLessThanOrEqual(3);
    const totals = await fullPass(clock, 2, 3);
    expect(totals.runs).toBeGreaterThan(1);
    const rows = await db().select().from(schema.objects);
    // Every row is checked once per pass, never twice.
    expect(totals.checkedRows + first.checkedRows).toBeGreaterThanOrEqual(rows.length);
    expect(await findingsFor(owner)).toEqual([]);
  });

  it("clears a finding once the key is fine again or gone", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const missing = await verifiedObject(owner, "comes back");
    const orphan = `objects/${owner}/${"3".repeat(64)}`;
    await env.ARTIFACTS.put(orphan, "orphan");
    await fullPass(later());
    expect((await findingsFor(owner)).map((finding) => finding.kind).sort()).toEqual([
      "missing",
      "orphan",
    ]);

    // The operator puts the bytes back and removes the orphan by hand.
    await env.ARTIFACTS.put(missing, "comes back");
    await env.ARTIFACTS.delete(orphan);
    await fullPass(later());
    expect(await findingsFor(owner)).toEqual([]);
  });

  it("clears an orphan finding once a row references the key", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const body = "adopted";
    const key = `objects/${owner}/${await sha256(body)}`;
    await env.ARTIFACTS.put(key, body);
    await fullPass(later());
    expect(await findingsFor(owner)).toEqual([{ kind: "orphan", r2Key: key }]);
    await verifiedObject(owner, body);
    await fullPass(later());
    expect(await findingsFor(owner)).toEqual([]);
  });
});

/** Every row a restore would bring back for these artifacts and accounts. */
async function snapshot(artifactIds: string[], userIds: string[]) {
  const versions = await db()
    .select()
    .from(schema.versions)
    .where(inArray(schema.versions.artifactId, artifactIds));
  const versionIds = versions.map((version) => version.id);
  return {
    users: await db().select().from(schema.users).where(inArray(schema.users.id, userIds)),
    usage: await db()
      .select()
      .from(schema.accountUsage)
      .where(inArray(schema.accountUsage.ownerId, userIds)),
    artifacts: await db()
      .select()
      .from(schema.artifacts)
      .where(inArray(schema.artifacts.id, artifactIds)),
    versions,
    files: await db()
      .select()
      .from(schema.versionFiles)
      .where(inArray(schema.versionFiles.versionId, versionIds)),
    objects: await db()
      .select()
      .from(schema.objects)
      .where(inArray(schema.objects.ownerId, userIds)),
  };
}

/** Puts the snapshot back as a D1 Time Travel restore would, tombstones included. */
async function restore(rows: Awaited<ReturnType<typeof snapshot>>, ids: string[]) {
  await db().delete(schema.tombstones).where(inArray(schema.tombstones.id, ids));
  await db()
    .delete(schema.accountUsage)
    .where(
      inArray(
        schema.accountUsage.ownerId,
        rows.usage.map((row) => row.ownerId),
      ),
    );
  await db().insert(schema.users).values(rows.users);
  await db().insert(schema.accountUsage).values(rows.usage);
  await db().insert(schema.artifacts).values(rows.artifacts);
  await db().insert(schema.versions).values(rows.versions);
  await db().insert(schema.versionFiles).values(rows.files);
  await db().insert(schema.objects).values(rows.objects);
}

describe("tombstones after a restore", () => {
  it("purges resurrected artifacts and accounts again, and a second run changes nothing", async () => {
    const owner = await user();
    const purged = await publishSite(owner.id);
    const leaving = await user();
    const leavingSite = await publishSite(leaving.id);
    const kept = await publishSite(owner.id);
    const before = await snapshot([purged.artifactId, leavingSite.artifactId], [leaving.id]);

    // After the backup: one artifact is deleted and one account deletes itself.
    await deleteArtifact(db(), env.ARTIFACTS, {
      userId: owner.id,
      artifactId: purged.artifactId,
      now: NOW,
    });
    await requestAccountDeletion(db(), {
      userId: leaving.id,
      sessionId: await session(leaving.id),
      confirmEmail: leaving.email,
      now: NOW,
    });
    await runMaintenance(db(), env.ARTIFACTS, NOW);
    await runMaintenance(db(), env.ARTIFACTS, NOW);
    const markers = await exportTombstones(db());
    expect(markers).toEqual(
      expect.arrayContaining([
        { kind: "artifact", id: purged.artifactId, deletedAt: NOW },
        { kind: "account", id: leaving.id, deletedAt: NOW },
      ]),
    );
    expect(markers.some((marker) => marker.id === kept.artifactId)).toBe(false);

    // The restore brings everything back and loses the tombstones written since.
    await restore(before, [purged.artifactId, leavingSite.artifactId, leaving.id]);
    expect((await artifactRow(purged.artifactId))?.state).toBe("active");

    const applied = await applyTombstones(db(), markers, NOW + DAY);
    expect(applied).toEqual({ inserted: markers.length, artifacts: 2, accounts: 1, shareLinks: 0 });
    expect((await artifactRow(purged.artifactId))?.state).toBe("purging");
    expect((await artifactRow(leavingSite.artifactId))?.state).toBe("purging");
    expect((await artifactRow(kept.artifactId))?.state).toBe("active");
    expect(await db().select().from(schema.users).where(eq(schema.users.id, leaving.id))).toEqual(
      [],
    );
    const jobs = await db()
      .select()
      .from(schema.outbox)
      .where(
        and(
          inArray(schema.outbox.subject, [purged.artifactId, leavingSite.artifactId, leaving.id]),
          // Access log erasure jobs are covered in access-log.test.ts.
          ne(schema.outbox.topic, "erase_access_events"),
        ),
      );
    expect(jobs.map((job) => job.topic).sort()).toEqual([
      "account_deletion",
      "purge_artifact",
      "purge_artifact",
    ]);

    // The jobs Worker finishes the purge.
    for (const job of jobs.filter((row) => row.topic === "purge_artifact")) {
      expect(await runJob(db(), env.ARTIFACTS, { id: job.id, topic: job.topic }, NOW + DAY)).toBe(
        "done",
      );
    }
    const deletion = must(jobs.find((row) => row.topic === "account_deletion"));
    expect(
      await runJob(db(), env.ARTIFACTS, { id: deletion.id, topic: deletion.topic }, NOW + DAY),
    ).toBe("done");
    expect(await artifactRow(purged.artifactId)).toBeUndefined();
    expect(await artifactRow(leavingSite.artifactId)).toBeUndefined();
    expect(
      await db().select().from(schema.objects).where(eq(schema.objects.ownerId, leaving.id)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.accountDeletions)
        .where(eq(schema.accountDeletions.userId, leaving.id)),
    ).toEqual([]);

    expect(await applyTombstones(db(), markers, NOW + 2 * DAY)).toEqual({
      inserted: 0,
      artifacts: 0,
      accounts: 0,
      shareLinks: 0,
    });
    expect((await artifactRow(kept.artifactId))?.state).toBe("active");
  });

  it("exports deletions in progress and artifacts claimed for purging", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await requestAccountDeletion(db(), {
      userId: owner.id,
      sessionId: await session(owner.id),
      confirmEmail: owner.email,
      now: NOW,
    });
    const markers = await exportTombstones(db());
    expect(markers).toEqual(
      expect.arrayContaining([
        { kind: "account", id: owner.id, deletedAt: NOW },
        { kind: "artifact", id: site.artifactId, deletedAt: NOW },
      ]),
    );
    // Each marker appears once even when it is both a tombstone and in progress.
    const keys = markers.map((marker) => `${marker.kind}:${marker.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("applies the tombstones the restored database still has, with no markers given", async () => {
    const owner = await user();
    const site = await publishSite(owner.id);
    await db().insert(schema.tombstones).values({ kind: "account", id: owner.id, deletedAt: NOW });
    expect(await applyTombstones(db(), [], NOW)).toMatchObject({
      inserted: 0,
      artifacts: 1,
      accounts: 1,
    });
    expect((await artifactRow(site.artifactId))?.state).toBe("purging");
  });
});
