// What the content Worker needs from the global database for delivery (decision 0005, "Two-region
// audit"): the region that holds an artifact and its owner's plan.
//
// - With one region bound (production today) nothing here reads anything: the region is the
//   default one, and the delivery lookup joins the plan in its one read, exactly as before.
// - The default region's database is the global one even beside a second region, so its
//   artifacts keep the joined lookup too.
// - Only an artifact in a region with its own database (the EU) cannot join the global plan: its
//   owner's plan is cached per isolate for `PLAN_TTL_MS` (a grant or removal reaches its traffic
//   limits and analytics within a minute), so a warm request still costs one regional read.
// - With more than one region the directory says which; a positive answer never changes and is
//   kept with no expiry, a miss is kept for `MISS_TTL_MS` so random IDs do not cost a global
//   read each. Both caches are bounded.
import {
  bothSides,
  type DeliveryArtifact,
  type DeliveryPlan,
  findDeliveryArtifact,
  findDeliveryPlan,
  type GlobalDb,
  type RegionHandles,
  type Regions,
} from "@portifact/db";
import { artifactHandles, personalHandles } from "@portifact/services";

/** Entries one isolate remembers in each cache, least recently used dropped first. */
export const DELIVERY_CACHE_ENTRIES = 10_000;

/** How long an owner's plan is trusted for delivery, in a region with its own database. */
export const PLAN_TTL_MS = 60_000;

/** How long an ID the directory does not know answers 404 without asking again. */
export const MISS_TTL_MS = 10_000;

class Lru<V> {
  readonly #entries = new Map<string, V>();
  constructor(readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.max) {
      this.#entries.delete(this.#entries.keys().next().value as string);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

let regionsOfArtifacts = new Lru<RegionHandles["region"]>(DELIVERY_CACHE_ENTRIES);
let misses = new Lru<number>(DELIVERY_CACHE_ENTRIES);
let plans = new Lru<{ plan: DeliveryPlan | null; readAt: number }>(DELIVERY_CACHE_ENTRIES);

/** Forgets every cache, for tests. */
export function resetDeliveryCaches(maxEntries = DELIVERY_CACHE_ENTRIES): void {
  regionsOfArtifacts = new Lru(maxEntries);
  misses = new Lru(maxEntries);
  plans = new Lru(maxEntries);
}

/** How many entries each cache holds, for tests. */
export function deliveryCacheSizes(): { regions: number; misses: number; plans: number } {
  return { regions: regionsOfArtifacts.size, misses: misses.size, plans: plans.size };
}

/**
 * The handles of the region that holds an artifact. An ID the directory does not know answers
 * the default region, where the artifact is missing too, so it is a 404 like any unknown ID.
 */
export async function deliveryRegion(
  regions: Regions,
  artifactId: string,
  now: number = Date.now(),
): Promise<RegionHandles> {
  if (regions.all().length === 1) return personalHandles(regions);
  const known = regionsOfArtifacts.get(artifactId);
  if (known) return regions.get(known);
  const missedAt = misses.get(artifactId);
  if (missedAt !== undefined && now - missedAt < MISS_TTL_MS && now >= missedAt) {
    return personalHandles(regions);
  }
  const found = await artifactHandles(regions, artifactId);
  if (!found) {
    misses.set(artifactId, now);
    return personalHandles(regions);
  }
  regionsOfArtifacts.set(artifactId, found.region);
  return found;
}

/** The owner's plan for delivery, from the isolate's cache or one read of the global database. */
export async function deliveryPlan(
  global: GlobalDb,
  ownerId: string,
  now: number,
): Promise<DeliveryPlan | null> {
  const cached = plans.get(ownerId);
  if (cached && now - cached.readAt < PLAN_TTL_MS && now >= cached.readAt) return cached.plan;
  const plan = await findDeliveryPlan(global, ownerId);
  plans.set(ownerId, { plan, readAt: now });
  return plan;
}

/**
 * The delivery lookup in the artifact's region, with the owner's plan: joined in the one read
 * when the region's database is the global one, from the isolate's cache otherwise.
 */
export async function lookupDelivery(
  regions: Regions,
  db: RegionHandles["db"],
  artifactId: string,
  cycleStart: number,
  now: number,
  customHost?: string,
): Promise<DeliveryArtifact | null> {
  const both = bothSides(db);
  if (both) {
    return findDeliveryArtifact(both, artifactId, cycleStart, customHost, { withPlan: true });
  }
  const artifact = await findDeliveryArtifact(db, artifactId, cycleStart, customHost);
  if (!artifact) return null;
  return { ...artifact, plan: await deliveryPlan(regions.global, artifact.ownerId, now) };
}
