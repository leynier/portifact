// Read queries used when serving artifacts. They run on every uncached request, so each is a
// single indexed lookup.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import {
  artifacts,
  objects,
  ownerPlans,
  trafficCounters,
  versionFiles,
  versions,
  workspaces,
} from "./schema.ts";

export interface DeliveryArtifact {
  id: string;
  ownerId: string;
  type: "site" | "markdown" | "text";
  state: "draft" | "active" | "archived" | "suspended" | "purging" | "deleted";
  accessMode: "public" | "authenticated" | "restricted" | "workspace" | "domain";
  policyGeneration: number;
  indexable: boolean;
  embeddable: boolean;
  /** Top-level page visits open in the viewer with the Portifact bar. */
  bar: boolean;
  /** The artifact's active custom host (decision 0006), or null. */
  customHost: string | null;
  currentVersionId: string | null;
  /** Entrypoint of the current version: the original of a document. */
  entrypoint: string | null;
  expiresAt: number | null;
  archivedAt: number | null;
  /** What the owner's artifacts served in the cycle asked for; zero without a counter yet. */
  traffic: { requests: number; bytes: number };
  /**
   * The owner's plan row, which decides its traffic quota; null when it has none (free). Joined
   * by the lookup with `withPlan` (a handle from `bothSides`, where the region's database is the
   * global one); otherwise null, and the content Worker attaches it from its per-isolate cache of
   * `findDeliveryPlan` (decision 0005).
   */
  plan: DeliveryPlan | null;
  /**
   * The people network allowlist of the owning workspace's policy (decision 0020), as stored
   * (normalized ranges), or null: none, or a personal space. Joined with the plan, attached from
   * the same per-isolate cache otherwise, so it adds no read.
   */
  networks: string[] | null;
}

/** The people network allowlist of a stored policy, from its JSON text; null without one. */
export const policyNetworksSql = sql<
  string | null
>`json_extract(${workspaces.policy}, '$.ipAllowlist')`;

/**
 * What stands for a stored allowlist that is not a list of strings: an entry no range parser
 * reads, so the list refuses everyone it binds (decision 0020). Delivery never throws on it.
 */
export const UNREADABLE_NETWORKS: readonly string[] = Object.freeze(["unreadable"]);

/** The stored allowlist as the lookup returns it (JSON text from SQLite), parsed. */
export function networksOf(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [...UNREADABLE_NETWORKS];
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    // A stored policy was validated on write; anything else must not open the workspace.
    return [...UNREADABLE_NETWORKS];
  }
  return parsed;
}

/** The `owner_plans` columns `entitlements` (@portifact/domain) reads. */
export interface DeliveryPlan {
  plan: string;
  seats: number;
  validUntil: number | null;
  overrides: unknown;
  /** The drops still held (decision 0022), riding the same row. */
  grace: unknown;
}

/**
 * The artifact, its current version's entrypoint, the owner's traffic counter for the cycle that
 * starts at `cycleStart` and, with `withPlan`, the owner's plan, in one lookup. `withPlan` needs
 * a handle that reaches both sides (`bothSides`: one database, production today); otherwise
 * `plan` comes back null and the caller attaches it from the global database
 * (`findDeliveryPlan`). With `customHost`, only an artifact that holds exactly that custom host
 * (decision 0006): the regional column decides what a custom host serves, whatever any cached
 * hint said.
 */
export async function findDeliveryArtifact(
  db: Db,
  id: string,
  cycleStart: number,
  customHost?: string,
  options: { withPlan?: boolean } = {},
): Promise<DeliveryArtifact | null> {
  if (options.withPlan) return findWithPlan(db, id, cycleStart, customHost);
  const [row] = await db
    .select({
      id: artifacts.id,
      ownerId: artifacts.ownerId,
      type: artifacts.type,
      state: artifacts.state,
      accessMode: artifacts.accessMode,
      policyGeneration: artifacts.policyGeneration,
      indexable: artifacts.indexable,
      embeddable: artifacts.embeddable,
      bar: artifacts.bar,
      customHost: artifacts.customHost,
      currentVersionId: artifacts.currentVersionId,
      entrypoint: versions.entrypoint,
      expiresAt: artifacts.expiresAt,
      archivedAt: artifacts.archivedAt,
      requests: sql<number>`coalesce(${trafficCounters.requests}, 0)`,
      bytes: sql<number>`coalesce(${trafficCounters.bytes}, 0)`,
    })
    .from(artifacts)
    .leftJoin(versions, eq(versions.id, artifacts.currentVersionId))
    .leftJoin(
      trafficCounters,
      and(
        eq(trafficCounters.ownerId, artifacts.ownerId),
        eq(trafficCounters.cycleStart, cycleStart),
      ),
    )
    .where(
      customHost === undefined
        ? eq(artifacts.id, id)
        : and(eq(artifacts.id, id), eq(artifacts.customHost, customHost)),
    )
    .limit(1);
  if (!row) return null;
  const { requests, bytes, ...artifact } = row;
  return {
    ...artifact,
    traffic: { requests: Number(requests), bytes: Number(bytes) },
    plan: null,
    networks: null,
  };
}

async function findWithPlan(
  db: Db,
  id: string,
  cycleStart: number,
  customHost: string | undefined,
): Promise<DeliveryArtifact | null> {
  const [row] = await db
    .select({
      id: artifacts.id,
      ownerId: artifacts.ownerId,
      type: artifacts.type,
      state: artifacts.state,
      accessMode: artifacts.accessMode,
      policyGeneration: artifacts.policyGeneration,
      indexable: artifacts.indexable,
      embeddable: artifacts.embeddable,
      bar: artifacts.bar,
      customHost: artifacts.customHost,
      currentVersionId: artifacts.currentVersionId,
      entrypoint: versions.entrypoint,
      expiresAt: artifacts.expiresAt,
      archivedAt: artifacts.archivedAt,
      requests: sql<number>`coalesce(${trafficCounters.requests}, 0)`,
      bytes: sql<number>`coalesce(${trafficCounters.bytes}, 0)`,
      plan: ownerPlans.plan,
      seats: ownerPlans.seats,
      validUntil: ownerPlans.validUntil,
      overrides: ownerPlans.overrides,
      grace: ownerPlans.grace,
      networks: policyNetworksSql,
    })
    .from(artifacts)
    .leftJoin(versions, eq(versions.id, artifacts.currentVersionId))
    .leftJoin(
      trafficCounters,
      and(
        eq(trafficCounters.ownerId, artifacts.ownerId),
        eq(trafficCounters.cycleStart, cycleStart),
      ),
    )
    .leftJoin(ownerPlans, eq(ownerPlans.ownerId, artifacts.ownerId))
    .leftJoin(workspaces, eq(workspaces.id, artifacts.ownerId))
    .where(
      customHost === undefined
        ? eq(artifacts.id, id)
        : and(eq(artifacts.id, id), eq(artifacts.customHost, customHost)),
    )
    .limit(1);
  if (!row) return null;
  const { requests, bytes, plan, seats, validUntil, overrides, grace, networks, ...artifact } = row;
  return {
    ...artifact,
    networks: networksOf(networks),
    traffic: { requests: Number(requests), bytes: Number(bytes) },
    plan:
      plan === null || seats === null
        ? null
        : { plan, seats, validUntil, overrides: overrides ?? null, grace: grace ?? null },
  };
}

/** The owner's plan row for delivery, from the global database; null when it has none (free). */
export async function findDeliveryPlan(global: Db, ownerId: string): Promise<DeliveryPlan | null> {
  const [row] = await global
    .select({
      plan: ownerPlans.plan,
      seats: ownerPlans.seats,
      validUntil: ownerPlans.validUntil,
      overrides: ownerPlans.overrides,
      grace: ownerPlans.grace,
    })
    .from(ownerPlans)
    .where(eq(ownerPlans.ownerId, ownerId))
    .limit(1);
  return row ? { ...row, overrides: row.overrides ?? null, grace: row.grace ?? null } : null;
}

/** What delivery needs of an artifact's owner from the global database. */
export interface DeliveryOwner {
  plan: DeliveryPlan | null;
  networks: string[] | null;
}

/** JSON from a column, or the text itself when it is not JSON (the validators then ignore it). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The owner's plan and its workspace's people network allowlist (decision 0020) in one read of
 * the global database, for a region with its own database, where the lookup cannot join them.
 */
export async function findDeliveryOwner(global: Db, ownerId: string): Promise<DeliveryOwner> {
  const [row] = await global.all<{
    plan: string | null;
    seats: number | null;
    validUntil: number | null;
    overrides: string | null;
    grace: string | null;
    networks: string | null;
  }>(
    sql`select ${ownerPlans.plan} as plan, ${ownerPlans.seats} as seats, ${ownerPlans.validUntil} as validUntil, ${ownerPlans.overrides} as overrides, ${ownerPlans.grace} as grace, (select ${policyNetworksSql} from ${workspaces} where ${workspaces.id} = ${ownerId}) as networks from (select 1) left join ${ownerPlans} on ${ownerPlans.ownerId} = ${ownerId}`,
  );
  const plan =
    row && row.plan !== null && row.seats !== null
      ? {
          plan: row.plan,
          seats: row.seats,
          validUntil: row.validUntil,
          overrides: row.overrides === null ? null : parseJson(row.overrides),
          // Raw text: `readGrace` (@portifact/domain) parses it and never throws.
          grace: row.grace,
        }
      : null;
  return { plan, networks: networksOf(row?.networks ?? null) };
}

export interface DeliveryFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  r2Key: string;
}

/** A published file of a version together with the R2 key of its verified object. */
export function findPublishedFile(
  db: Db,
  versionId: string,
  path: string,
): Promise<DeliveryFile | null> {
  return findVersionFile(db, versionId, "published", path);
}

/** The rendered page of a document version, if it was rendered. */
export function findRenderedPage(
  db: Db,
  versionId: string,
  entrypoint: string,
): Promise<DeliveryFile | null> {
  return findVersionFile(db, versionId, "rendered", entrypoint);
}

async function findVersionFile(
  db: Db,
  versionId: string,
  kind: "published" | "rendered",
  path: string,
): Promise<DeliveryFile | null> {
  const [row] = await db
    .select({
      path: versionFiles.path,
      sha256: versionFiles.sha256,
      size: versionFiles.size,
      contentType: versionFiles.contentType,
      r2Key: objects.r2Key,
    })
    .from(versionFiles)
    .innerJoin(
      objects,
      and(eq(objects.ownerId, versionFiles.ownerId), eq(objects.sha256, versionFiles.sha256)),
    )
    .where(
      and(
        eq(versionFiles.versionId, versionId),
        eq(versionFiles.kind, kind),
        eq(versionFiles.path, path),
        eq(objects.state, "verified"),
      ),
    )
    .limit(1);
  return row ?? null;
}
