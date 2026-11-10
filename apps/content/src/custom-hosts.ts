// Custom hosts in the content Worker (decision 0006, section 5). A request on a host that is not
// `<id>.portifact.dev` can only be a custom domain, because Cloudflare routes to the zone only
// hostnames it holds a custom hostname for. The global `custom_domains` table says which artifact
// and region an active hostname belongs to; each isolate caches that answer as a hint, without an
// expiry and without invalidation, because it is never trusted: the delivery lookup reads the
// artifact anyway and only matches while `artifacts.custom_host` holds exactly this host. A stale
// hint misses, is dropped, the global table is read once more on the same request, and the answer
// is that or 404. So a warm request costs today's one read, a cold one two, a host that moved
// three, and a removal holds at the very next request in every isolate. A miss is never cached.
import type { DeliveryArtifact, Region, Regions } from "@portifact/db";
import { customHostHint } from "@portifact/services";
import { lookupDelivery } from "./directory.ts";

/** Hostnames one isolate remembers, least recently used dropped first. */
export const HOST_CACHE_ENTRIES = 10_000;

export interface HostHint {
  artifactId: string;
  region: Region;
}

export class HostDirectory {
  readonly #cache = new Map<string, HostHint>();
  readonly #max: number;

  constructor(maxEntries = HOST_CACHE_ENTRIES) {
    this.#max = maxEntries;
  }

  /** The cached hint, or none. */
  cached(hostname: string): HostHint | undefined {
    const hint = this.#cache.get(hostname);
    if (hint) {
      this.#cache.delete(hostname);
      this.#cache.set(hostname, hint);
    }
    return hint;
  }

  /** Reads the global table again; remembers an answer and forgets a miss. */
  async refresh(regions: Regions, hostname: string): Promise<HostHint | undefined> {
    this.#cache.delete(hostname);
    const hint = await customHostHint(regions.global, hostname);
    if (!hint) return undefined;
    this.#cache.set(hostname, hint);
    if (this.#cache.size > this.#max) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return hint;
  }

  get size(): number {
    return this.#cache.size;
  }
}

/** One directory per isolate. */
let directory: HostDirectory | undefined;

export function isolateHosts(): HostDirectory {
  directory ??= new HostDirectory();
  return directory;
}

/**
 * Whether the global table says `hostname` is active for `artifactId`, for the `.dev` redirect:
 * a cached hint for that artifact answers at once; anything else reads the table once (a hint for
 * another artifact may be stale). Never true from the regional column alone.
 */
export async function hintAgrees(
  regions: Regions,
  hostname: string,
  artifactId: string,
  hosts: HostDirectory = isolateHosts(),
): Promise<boolean> {
  if (hosts.cached(hostname)?.artifactId === artifactId) return true;
  return (await hosts.refresh(regions, hostname))?.artifactId === artifactId;
}

/** What a custom host resolved to: the artifact (with the delivery lookup's joins) and its region. */
export interface CustomHostTarget {
  artifact: DeliveryArtifact;
  region: Region;
}

/**
 * Resolves a custom host to the artifact that holds it, or null (404). The hint gives the
 * artifact and region; the delivery lookup decides, matched on the host.
 */
export async function resolveCustomHost(
  regions: Regions,
  hosts: HostDirectory,
  hostname: string,
  cycleStart: number,
  now: number,
): Promise<CustomHostTarget | null> {
  const lookup = async (hint: HostHint) => {
    const artifact = await lookupDelivery(
      regions,
      regions.get(hint.region).db,
      hint.artifactId,
      cycleStart,
      now,
      hostname,
    );
    return artifact ? { artifact, region: hint.region } : null;
  };
  const cached = hosts.cached(hostname);
  if (cached) {
    const found = await lookup(cached);
    if (found) return found;
  }
  // No hint, or a stale one: read the table again, once, on this same request.
  const fresh = await hosts.refresh(regions, hostname);
  if (!fresh) return null;
  if (cached && fresh.artifactId === cached.artifactId && fresh.region === cached.region) {
    return null;
  }
  return lookup(fresh);
}
