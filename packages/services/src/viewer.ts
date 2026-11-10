// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08): what the
// bar shows about an artifact and who is looking. Signed-in visitors pass the same access check
// as reading the artifact; anonymous visitors see only public artifacts that are servable, so a
// protected, unavailable or missing artifact gives the same answer until they sign in.
import type { AccessMode, ViewerRole } from "@portifact/contracts";
import { bothSides, type RegionalDb, schema } from "@portifact/db";
import {
  actsForOwner,
  customHostWithoutClick,
  effectiveState,
  entitlements,
  fail,
  type OwnerPlanRecord,
  ok,
  type Result,
} from "@portifact/domain";
import { eq } from "drizzle-orm";
import { actorOn } from "./actors.ts";
import { type ViewerBrandFacts, viewerBrandFacts } from "./branding.ts";
import { activeCustomHost } from "./custom-domains.ts";
import { ownerPlanRecord } from "./plans.ts";
import { checkReadAccess } from "./read-access.ts";

export interface ViewerArtifact {
  name: string;
  type: "site" | "markdown" | "text";
  versionNumber: number;
  accessMode: AccessMode;
  annotations: "off" | "open" | "locked";
  role: ViewerRole;
  /** The owner's brand for the bar, or null for the default bar (premium plan P9). */
  brand: ViewerBrandFacts | null;
  /**
   * The artifact's active custom host, given only to a visitor who may read it (this answer is
   * one): the viewer frames it instead of the `.dev` origin (`viewerFrameOrigin`).
   */
  customHost: string | null;
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/** The artifact as the viewer shows it to `userId`, or to an anonymous visitor when null. */
export async function getViewerArtifact(
  db: RegionalDb,
  input: {
    artifactId: string;
    userId: string | null;
    now: number;
    /** Whether this Worker serves custom hosts (`customDomainsServing`). */
    customDomains: boolean;
  },
): Promise<Result<ViewerArtifact>> {
  // With one database the plan comes with the artifact, as it always did; otherwise it is read
  // from the global database only for a branded owner (decision 0005).
  const both = bothSides(db);
  const p = schema.ownerPlans;
  const planColumns = {
    plan: p.plan,
    seats: p.seats,
    validUntil: p.validUntil,
    overrides: p.overrides,
  };
  const base = (both ?? db)
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
      // The owner's brand comes with the artifact; the plan (global, decision 0005) is read only
      // for a branded owner, so an unbranded one costs no read.
      brandName: schema.ownerBrands.name,
      brandAccent: schema.ownerBrands.accentColor,
      brandLink: schema.ownerBrands.link,
      brandLogo: schema.ownerBrands.logoSha256,
      brandLogoWidth: schema.ownerBrands.logoWidth,
      brandLogoHeight: schema.ownerBrands.logoHeight,
      brandSuspendedAt: schema.ownerBrands.suspendedAt,
      ...(both ? { joinedPlan: planColumns } : {}),
    })
    .from(schema.artifacts)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.artifacts.currentVersionId))
    .leftJoin(schema.ownerBrands, eq(schema.ownerBrands.ownerId, schema.artifacts.ownerId))
    .$dynamic();
  const [artifact] = await (both ? base.leftJoin(p, eq(p.ownerId, schema.artifacts.ownerId)) : base)
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
    // An admin or editor of the owner is the owner here, as the user of a personal space is.
    const actor = await actorOn(db.global, input.userId, artifact.ownerId);
    role = actsForOwner(actor, artifact.ownerId) ? "owner" : "reader";
  }
  return ok({
    name: artifact.name,
    type: artifact.type,
    versionNumber: artifact.versionNumber,
    accessMode: artifact.accessMode,
    annotations: artifact.annotations,
    role,
    brand: viewerBrandFacts(
      artifact.brandName === null
        ? null
        : {
            name: artifact.brandName,
            accentColor: artifact.brandAccent,
            link: artifact.brandLink,
            logoSha256: artifact.brandLogo,
            logoWidth: artifact.brandLogoWidth,
            logoHeight: artifact.brandLogoHeight,
            suspendedAt: artifact.brandSuspendedAt,
          },
      entitlements(
        both
          ? (("joinedPlan" in artifact ? artifact.joinedPlan : null) as OwnerPlanRecord | null)
          : artifact.brandName === null
            ? null
            : await ownerPlanRecord(db.global, artifact.ownerId),
        input.now,
      ),
    ),
    // The frame's host: never for an `authenticated`, `workspace` or `domain` artifact, which the
    // viewer frames on `.dev` because it opens with no click (`customHostWithoutClick`).
    customHost: customHostWithoutClick(artifact.accessMode)
      ? await activeCustomHost(db, input.artifactId, input.customDomains)
      : null,
  });
}
