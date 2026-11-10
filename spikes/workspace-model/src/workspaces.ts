// The recommended alternative, as packages/services would write it: workspaces in Portifact's
// own tables, changed only in D1 batches, with Better Auth left to identity.
import type { Db } from "@portifact/db";
import { and, eq, sql } from "drizzle-orm";
import { WORKSPACE_ID_PREFIX } from "./config.ts";
import type { Actor } from "./membership.ts";
import type { WorkspaceRole } from "./roles.ts";
import { workspaceMembers, workspaces } from "./schema.ts";

export function newWorkspaceId(): string {
  return `${WORKSPACE_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The workspace and its first admin in one batch: both rows or neither. */
export async function createWorkspace(
  db: Db,
  input: { userId: string; name: string; slug: string; now: Date },
): Promise<string> {
  const id = newWorkspaceId();
  await db.batch([
    db.insert(workspaces).values({ id, slug: input.slug, name: input.name, createdAt: input.now }),
    db
      .insert(workspaceMembers)
      .values({ workspaceId: id, userId: input.userId, role: "admin", createdAt: input.now }),
  ]);
  return id;
}

/** Idempotent: a concurrent or repeated add keeps the first membership and its role. */
export async function addMember(
  db: Db,
  input: { workspaceId: string; userId: string; role: WorkspaceRole; now: Date },
): Promise<boolean> {
  const result = await db
    .insert(workspaceMembers)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: input.now,
    })
    .onConflictDoNothing();
  return result.meta.changes === 1;
}

export async function resolveWorkspaceActor(
  db: Db,
  userId: string,
  ownerId: string,
): Promise<Actor | null> {
  if (!ownerId.startsWith(WORKSPACE_ID_PREFIX))
    return ownerId === userId ? { userId, ownerId, role: "admin" } : null;
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row ? { userId, ownerId, role: row.role } : null;
}

export async function countMembers(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return row?.n ?? 0;
}
