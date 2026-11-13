// The change list (decision 0027, "The change list"): accepted operations Portifact did not apply,
// each the canonical envelope the owner side saw and confirmed. Only a human owner-side actor
// reads or marks it: the annotation role of a service token is none, so a token gets what a
// missing artifact gives, and anyone outside the owner side is refused before any item is
// looked up. A held artifact's list answers only the operator (the annotation authorization's
// hold rule). People and the owner's agent (a person's own OAuth token) mark items; nothing here
// applies them. Envelopes name no person: names come from `submitted_by` and `created_by`
// through `presentEnvelope`, and "a deleted account" once account erasure cleared them.
import {
  CHANGE_LIST_LIMITS,
  type ChangeItemList,
  type ChangeItemState,
  type ChangeItemView,
  Envelope,
  type MarkChangeItem,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { checkMark, presentEnvelope } from "@portifact/domain/suggestions";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  type AnnotationActor,
  type AuthorizedAnnotations,
  annotationParts,
} from "./annotations.ts";
import { auditEvent } from "./audit.ts";
import { openItemsSql } from "./suggestion-versions.ts";

const ci = schema.changeItems;
type ItemRow = typeof ci.$inferSelect;

/** The owner side, as a person; anyone else is refused before any item is read. */
async function ownerSide(
  db: RegionalDb,
  input: AnnotationActor,
): Promise<Result<AuthorizedAnnotations>> {
  const loaded = await annotationParts.authorize(db, input, "read");
  if (!loaded.ok) return loaded;
  if (loaded.value.role !== "owner") {
    return fail("forbidden", "Only the people who manage the artifact read its change list.");
  }
  return loaded;
}

async function names(
  db: RegionalDb,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const found = new Map<string, string>();
  // D1 binds at most 100 parameters per statement.
  for (let i = 0; i < wanted.length; i += 90) {
    const rows = await db.global
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(inArray(schema.users.id, wanted.slice(i, i + 90)));
    for (const row of rows) found.set(row.id, row.name);
  }
  return found;
}

function itemView(row: ItemRow, people: Map<string, string>): ChangeItemView {
  const raw = JSON.parse(row.envelope) as { format?: unknown };
  const parsed = Envelope.safeParse(raw);
  // A later envelope format is kept as it comes, for a newer client.
  const envelope = parsed.success
    ? presentEnvelope(parsed.data, {
        submittedBy: row.submittedBy === null ? null : (people.get(row.submittedBy) ?? null),
        acceptedBy: row.createdBy === null ? null : (people.get(row.createdBy) ?? null),
      })
    : (raw as ChangeItemView["envelope"]);
  return {
    id: row.id,
    artifactId: row.artifactId,
    origin: row.origin,
    threadId: row.threadId,
    versionId: row.versionId,
    path: row.path,
    route: row.route,
    envelope,
    reason: row.reason,
    state: row.state,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    closedVersionId: row.closedVersionId,
    revision: row.revision,
  };
}

const encodeCursor = (row: Pick<ItemRow, "createdAt" | "id">) =>
  btoa(`${row.createdAt}:${row.id}`).replace(/=+$/, "");

function decodeCursor(cursor: string): { createdAt: number; id: string } | undefined {
  try {
    const [at, id] = atob(cursor).split(":");
    const createdAt = Number(at);
    return Number.isSafeInteger(createdAt) && id ? { createdAt, id } : undefined;
  } catch {
    return undefined;
  }
}

/** The artifact's change list, oldest first, optionally one state only. */
export async function listChangeItems(
  db: RegionalDb,
  input: AnnotationActor & {
    state?: ChangeItemState | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<Result<ChangeItemList>> {
  const loaded = await ownerSide(db, input);
  if (!loaded.ok) return loaded;
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && after === undefined) {
    return fail("invalid_input", "Invalid cursor.");
  }
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const rows = await db
    .select()
    .from(ci)
    .where(
      and(
        eq(ci.artifactId, loaded.value.artifact.id),
        ...(input.state ? [eq(ci.state, input.state)] : []),
        ...(after
          ? [
              or(
                gt(ci.createdAt, after.createdAt),
                and(eq(ci.createdAt, after.createdAt), gt(ci.id, after.id)),
              ),
            ]
          : []),
      ),
    )
    .orderBy(asc(ci.createdAt), asc(ci.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const people = await names(
    db,
    page.flatMap((row) => [row.submittedBy, row.createdBy]),
  );
  const last = page.at(-1);
  return ok({
    items: page.map((row) => itemView(row, people)),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  });
}

/**
 * Marks an item applied, dismissed or open again, based on the revision the caller holds. A
 * person or their agent marks; reopening needs room in the list. Never refused by budget
 * protection or a plan.
 */
export async function markChangeItem(
  db: RegionalDb,
  input: AnnotationActor & MarkChangeItem & { itemId: string },
): Promise<Result<ChangeItemView>> {
  const loaded = await ownerSide(db, input);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value.artifact;
  const [item] = await db
    .select()
    .from(ci)
    .where(and(eq(ci.id, input.itemId), eq(ci.artifactId, artifact.id)))
    .limit(1);
  if (!item) return fail("not_found", "Change item not found.");
  const [row] = await db.all<{ open: number }>(sql`select ${openItemsSql(artifact.id)} as open`);
  const allowed = checkMark(
    loaded.value.role,
    item.state,
    input.state,
    Number((row as { open: number }).open),
    CHANGE_LIST_LIMITS.openPerArtifact,
  );
  if (!allowed.ok) return allowed;
  if (item.revision !== input.baseRevision) {
    return fail("version_conflict", "The item changed meanwhile. Reload and try again.");
  }
  if (allowed.value === "unchanged")
    return ok(itemView(item, await names(db, [item.submittedBy, item.createdBy])));
  const t = schema.artifacts;
  const guard = sql`exists (select 1 from ${ci} where ${ci.id} = ${item.id} and ${ci.state} = ${item.state} and ${ci.revision} = ${item.revision}) and exists (select 1 from ${t} where ${t.id} = ${artifact.id} and ${t.ownerId} = ${artifact.ownerId})${
    input.state === "open"
      ? sql` and ${openItemsSql(artifact.id)} < ${CHANGE_LIST_LIMITS.openPerArtifact}`
      : sql``
  }`;
  const reopening = input.state === "open";
  const [, updated] = await db.batch([
    auditEvent(
      db,
      {
        ownerId: artifact.ownerId,
        kind: "change_item.marked",
        actor: { type: "user", id: input.userId },
        targetId: artifact.id,
        artifactId: artifact.id,
        detail: { state: input.state },
        now: input.now,
      },
      guard,
    ),
    db
      .update(ci)
      .set({
        state: input.state,
        closedAt: reopening ? null : input.now,
        closedBy: reopening ? null : input.userId,
        closedVersionId: null,
        revision: sql`${ci.revision} + 1`,
      })
      .where(and(eq(ci.id, item.id), guard))
      .returning(),
  ]);
  const changed = updated[0];
  if (!changed) {
    return fail("version_conflict", "The item changed meanwhile. Reload and try again.");
  }
  return ok(itemView(changed, await names(db, [changed.submittedBy, changed.createdBy])));
}
