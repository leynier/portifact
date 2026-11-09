// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08): what the
// bar shows about an artifact and who is looking. Signed-in visitors pass the same access check
// as reading the artifact; anonymous visitors see only public artifacts that are servable, so a
// protected, unavailable or missing artifact gives the same answer until they sign in.
import type { ViewerRole } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { effectiveState, fail, ok, type Result } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { checkReadAccess } from "./read-access.ts";

export interface ViewerArtifact {
  name: string;
  type: "site" | "markdown" | "text";
  versionNumber: number;
  accessMode: "public" | "authenticated" | "restricted";
  annotations: "off" | "open" | "locked";
  role: ViewerRole;
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/** The artifact as the viewer shows it to `userId`, or to an anonymous visitor when null. */
export async function getViewerArtifact(
  db: Db,
  input: { artifactId: string; userId: string | null; now: number },
): Promise<Result<ViewerArtifact>> {
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      name: schema.artifacts.name,
      type: schema.artifacts.type,
      state: schema.artifacts.state,
      accessMode: schema.artifacts.accessMode,
      annotations: schema.artifacts.annotations,
      expiresAt: schema.artifacts.expiresAt,
      archivedAt: schema.artifacts.archivedAt,
      versionNumber: schema.versions.number,
    })
    .from(schema.artifacts)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.artifacts.currentVersionId))
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return unavailable();
  let role: ViewerRole;
  if (input.userId === null) {
    const state = effectiveState(
      {
        state: artifact.state,
        expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
        archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
      },
      new Date(input.now),
    );
    if (artifact.accessMode !== "public" || state !== "active") return unavailable();
    role = "anonymous";
  } else {
    const access = await checkReadAccess(db, { ...input, userId: input.userId });
    if (!access.ok) return access;
    role = artifact.ownerId === input.userId ? "owner" : "reader";
  }
  return ok({
    name: artifact.name,
    type: artifact.type,
    versionNumber: artifact.versionNumber,
    accessMode: artifact.accessMode,
    annotations: artifact.annotations,
    role,
  });
}
