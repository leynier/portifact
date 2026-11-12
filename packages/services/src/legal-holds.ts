// Legal holds (docs/operations.md, "Legal holds"): the operator preserves an artifact for an
// authority. A hold is set, listed and released only with the operator tool. While it is open
// the artifact stays suspended (served to nobody, its owner included), and no path deletes it,
// moves it or prunes its versions: the owner side's deletion and transfer are refused with
// `forbidden` and a message that never says why (`HELD_MESSAGE`), account and workspace deletions
// and a restore's re-applied deletions leave it out and wait, and triggers in the
// `legal_hold_triggers` migration back every one of those. Releasing the hold (by hand, or by the
// maintenance scan at its release date) lets a deferred deletion go on at its next run.
import { type AbuseReason, isWorkspaceId, type LegalHoldLine } from "@portifact/contracts";
import { type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import { checkHoldPlacement, fail, HELD_MESSAGE, ok, type Result } from "@portifact/domain";
import { and, asc, eq, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import { suspendArtifact } from "./moderation.ts";

const h = schema.legalHolds;

/** The artifacts row's ID, named with its table so it never binds to the subquery's own `id`. */
const ARTIFACT_ID = sql`"artifacts"."id"`;

/**
 * SQL that is true while an artifact has an open hold: the `artifacts` row of the statement, or
 * the ID given. Its own columns name their table, so it holds inside any statement.
 */
export function heldSql(artifactId: SQL = ARTIFACT_ID): SQL {
  return sql`exists (select 1 from "legal_holds" where "legal_holds"."artifact_id" = ${artifactId} and "legal_holds"."released_at" is null)`;
}

/** SQL that is true while an artifact has no open hold (see `heldSql`). */
export function notHeldSql(artifactId: SQL = ARTIFACT_ID): SQL {
  return sql`not ${heldSql(artifactId)}`;
}

/** Whether an artifact has an open hold. */
export async function isHeld(db: Db, artifactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: h.id })
    .from(h)
    .where(and(eq(h.artifactId, artifactId), isNull(h.releasedAt)))
    .limit(1);
  return row !== undefined;
}

/** The refusal of every owner-side change a hold stops; it never says why. */
export const heldRefusal = () => fail<never>("forbidden", HELD_MESSAGE);

export type LegalHoldRow = typeof schema.legalHolds.$inferSelect;

function newHoldId(): string {
  return `hold_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The account's address while the hold lasts, so the uploader is known even after deletion. */
async function ownerEmail(global: GlobalDb, ownerId: string): Promise<string | null> {
  if (isWorkspaceId(ownerId)) return null;
  const [row] = await global
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Places a hold on a suspended artifact. Holding one already held changes nothing and answers the
 * open hold.
 */
export async function placeLegalHold(
  db: RegionalDb,
  input: { artifactId: string; ground: string; releaseAt: number | null; now: number },
): Promise<Result<{ hold: LegalHoldRow; changed: boolean }>> {
  const ground = input.ground.trim();
  if (ground.length === 0 || ground.length > 500) {
    return fail("invalid_input", "The ground must be 1 to 500 characters.");
  }
  const [artifact] = await db
    .select({
      id: schema.artifacts.id,
      state: schema.artifacts.state,
      ownerId: schema.artifacts.ownerId,
      reason: schema.artifacts.suspensionReason,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return fail("not_found", "Artifact not found.");
  const open = await openHold(db, artifact.id);
  if (open) return ok({ hold: open, changed: false });
  const allowed = checkHoldPlacement(artifact.state, input.releaseAt, input.now);
  if (!allowed.ok) return allowed;
  const row: LegalHoldRow = {
    id: newHoldId(),
    artifactId: artifact.id,
    ownerId: artifact.ownerId,
    ownerEmail: await ownerEmail(db.global, artifact.ownerId),
    reason: (artifact.reason ?? "other") as AbuseReason,
    ground,
    createdAt: input.now,
    releaseAt: input.releaseAt,
    releasedAt: null,
  };
  try {
    await db.insert(h).values(row);
  } catch (error) {
    // A concurrent hold won the open slot, or the artifact was reinstated in between.
    const won = await openHold(db, artifact.id);
    if (won) return ok({ hold: won, changed: false });
    if (causeIncludes(error, "legal_hold_needs_suspension")) {
      return fail("version_conflict", "The artifact changed meanwhile. Try again.");
    }
    throw error;
  }
  return ok({ hold: row, changed: true });
}

async function openHold(db: Db, artifactId: string): Promise<LegalHoldRow | undefined> {
  const [row] = await db
    .select()
    .from(h)
    .where(and(eq(h.artifactId, artifactId), isNull(h.releasedAt)))
    .limit(1);
  return row;
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

/**
 * Releases an artifact's open hold and forgets the owner's address it kept. The artifact stays
 * suspended until the operator reinstates it; deletions that waited for the hold go on at their
 * next run. `released` is false when there was no open hold.
 */
export async function releaseLegalHold(
  db: RegionalDb,
  input: { artifactId: string; now: number },
): Promise<{ released: boolean }> {
  const rows = await db
    .update(h)
    .set({ releasedAt: input.now, ownerEmail: null })
    .where(and(eq(h.artifactId, input.artifactId), isNull(h.releasedAt)))
    .returning({ id: h.id });
  return { released: rows.length > 0 };
}

/** The region's holds, open ones first, then the released ones when `all`. */
export async function listLegalHolds(
  db: Db,
  input: { all: boolean; limit: number },
): Promise<LegalHoldRow[]> {
  return db
    .select()
    .from(h)
    .where(input.all ? undefined : isNull(h.releasedAt))
    .orderBy(sql`${h.releasedAt} is not null`, asc(h.createdAt), asc(h.id))
    .limit(input.limit);
}

/** The maintenance scan's part: releases the holds whose release date has come. */
export async function releaseDueHolds(db: Db, now: number): Promise<number> {
  const rows = await db
    .update(h)
    .set({ releasedAt: now, ownerEmail: null })
    .where(and(isNull(h.releasedAt), isNotNull(h.releaseAt), lte(h.releaseAt, now)))
    .returning({ id: h.id });
  return rows.length;
}

/** Every region's holds, for `export-tombstones` before a restore. */
export async function exportLegalHolds(regions: {
  all(): readonly { db: RegionalDb }[];
}): Promise<LegalHoldLine[]> {
  const lines: LegalHoldLine[] = [];
  for (const { db } of regions.all()) {
    for (const row of await db.select().from(h).orderBy(asc(h.id))) {
      lines.push({
        legalHold: {
          id: row.id,
          artifactId: row.artifactId,
          ownerId: row.ownerId,
          ownerEmail: row.ownerEmail,
          reason: row.reason,
          ground: row.ground,
          createdAt: row.createdAt,
          releaseAt: row.releaseAt,
          releasedAt: row.releasedAt,
        },
      });
    }
  }
  return lines;
}

export interface ApplyLegalHoldsResult {
  /** Holds the restore had lost or brought back open, put back as they were. */
  restored: number;
  /** Held artifacts the restore brought back unsuspended, suspended again. */
  suspended: number;
  /** Open holds whose artifact is gone or being purged in every region given: report these. */
  missing: string[];
}

/**
 * Puts the exported holds back after a restore, before any tombstone is re-applied: a hold the
 * restore lost is inserted again (its artifact suspended again first if the restore brought it
 * back served), and one released after the restore point is released again. Running it again
 * changes nothing.
 */
export async function applyLegalHolds(
  regions: { all(): readonly { db: RegionalDb }[] },
  lines: readonly LegalHoldLine[],
  now: number,
): Promise<ApplyLegalHoldsResult> {
  const result: ApplyLegalHoldsResult = { restored: 0, suspended: 0, missing: [] };
  for (const { legalHold: line } of lines) {
    let found = false;
    for (const { db } of regions.all()) {
      const [artifact] = await db
        .select({ state: schema.artifacts.state })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, line.artifactId))
        .limit(1);
      if (!artifact) continue;
      found = true;
      const [current] = await db.select().from(h).where(eq(h.id, line.id)).limit(1);
      if (line.releasedAt !== null) {
        if (current && current.releasedAt === null) {
          await db
            .update(h)
            .set({ releasedAt: line.releasedAt, ownerEmail: null })
            .where(and(eq(h.id, line.id), isNull(h.releasedAt)));
          result.restored += 1;
        }
        continue;
      }
      if (current?.releasedAt === null) continue;
      if (artifact.state === "purging" || artifact.state === "deleted") {
        result.missing.push(line.artifactId);
        continue;
      }
      if (artifact.state !== "suspended") {
        const suspended = await suspendArtifact(db, {
          artifactId: line.artifactId,
          reason: line.reason as AbuseReason,
          note: "Suspended again after a restore: legal hold.",
          now,
        });
        if (!suspended.ok) {
          result.missing.push(line.artifactId);
          continue;
        }
        result.suspended += 1;
      }
      const values = {
        id: line.id,
        artifactId: line.artifactId,
        ownerId: line.ownerId,
        ownerEmail: line.ownerEmail,
        reason: line.reason as AbuseReason,
        ground: line.ground,
        createdAt: line.createdAt,
        releaseAt: line.releaseAt,
        releasedAt: null,
      };
      if (current) {
        await db.update(h).set({ releasedAt: null }).where(eq(h.id, line.id));
      } else if (!(await openHold(db, line.artifactId))) {
        await db.insert(h).values(values).onConflictDoNothing();
      }
      result.restored += 1;
    }
    if (!found && line.releasedAt === null) result.missing.push(line.artifactId);
  }
  return result;
}
