// What the content Worker needs from the global database for delivery (decision 0005, "Two-region
// audit"): the region that holds an artifact and its owner's plan. Artifacts are regional and the
// directory and plans global, so no regional query can join them; each isolate caches both
// instead, so a warm request costs the one regional read it always did.
//
// - The directory answer never changes (a row is never updated or deleted), so a positive answer
//   is kept with no expiry; a miss is never cached. With one region nothing is read at all.
// - A plan can change, so it is kept for `PLAN_TTL_MS`, the same minute budget protection is
//   cached for: a grant, a removal or an expiry reaches delivery within a minute.
import {
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

/** How long an owner's plan is trusted for delivery. */
export const PLAN_TTL_MS = 60_000;

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
let plans = new Lru<{ plan: DeliveryPlan | null; readAt: number }>(DELIVERY_CACHE_ENTRIES);

/** Forgets both caches, for tests. */
export function resetDeliveryCaches(maxEntries = DELIVERY_CACHE_ENTRIES): void {
  regionsOfArtifacts = new Lru(maxEntries);
  plans = new Lru(maxEntries);
}

/** How many entries each cache holds, for tests. */
export function deliveryCacheSizes(): { regions: number; plans: number } {
  return { regions: regionsOfArtifacts.size, plans: plans.size };
}

/**
 * The handles of the region that holds an artifact. An ID the directory does not know answers
 * the default region, where the artifact is missing too, so it is a 404 like any unknown ID.
 */
export async function deliveryRegion(regions: Regions, artifactId: string): Promise<RegionHandles> {
  if (regions.all().length === 1) return personalHandles(regions);
  const known = regionsOfArtifacts.get(artifactId);
  if (known) return regions.get(known);
  const found = await artifactHandles(regions, artifactId);
  if (!found) return personalHandles(regions);
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

/** The delivery lookup in the artifact's region, with the owner's plan attached. */
export async function lookupDelivery(
  regions: Regions,
  db: RegionHandles["db"],
  artifactId: string,
  cycleStart: number,
  now: number,
  customHost?: string,
): Promise<DeliveryArtifact | null> {
  const artifact = await findDeliveryArtifact(db, artifactId, cycleStart, customHost);
  if (!artifact) return null;
  return { ...artifact, plan: await deliveryPlan(regions.global, artifact.ownerId, now) };
}
