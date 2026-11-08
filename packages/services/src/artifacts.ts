// Read use cases for an owner's artifacts: list with a cursor and look one up. Someone else's
// artifact looks exactly like a missing one.
import { type Db, schema } from "@portifact/db";
import { and, desc, eq, lt, ne, or } from "drizzle-orm";

export type ArtifactRow = typeof schema.artifacts.$inferSelect;

export interface ListInput {
  ownerId: string;
  cursor?: string | undefined;
  limit: number;
}

export interface ArtifactPage {
  items: ArtifactRow[];
  nextCursor: string | null;
}

/** Opaque cursor: the sort key of the last item, `<updatedAt>.<id>` in base64url. */
export function encodeCursor(row: Pick<ArtifactRow, "updatedAt" | "id">): string {
  return btoa(`${row.updatedAt}.${row.id}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(cursor: string): { updatedAt: number; id: string } | undefined {
  try {
    const text = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const match = /^(\d{1,15})\.([a-z2-7]{10})$/.exec(text);
    if (!match) return undefined;
    return { updatedAt: Number(match[1]), id: match[2] as string };
  } catch {
    return undefined;
  }
}

/** The owner's artifacts, most recently updated first. Deleted artifacts are not listed. */
export async function listArtifacts(db: Db, input: ListInput): Promise<ArtifactPage | undefined> {
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !after) return undefined;
  const t = schema.artifacts;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.ownerId, input.ownerId),
        ne(t.state, "deleted"),
        ne(t.state, "draft"),
        after
          ? or(
              lt(t.updatedAt, after.updatedAt),
              and(eq(t.updatedAt, after.updatedAt), lt(t.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(t.updatedAt), desc(t.id))
    .limit(input.limit + 1);
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null };
}

/** One of the owner's artifacts, or undefined when it is missing, deleted or someone else's. */
export async function getArtifact(
  db: Db,
  input: { ownerId: string; artifactId: string },
): Promise<ArtifactRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!row || row.ownerId !== input.ownerId || row.state === "deleted") return undefined;
  return row;
}
