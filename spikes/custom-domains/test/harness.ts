import { env } from "cloudflare:workers";
import type { CustomHostnames, Deps } from "../src/domains.ts";
import { createRegions, type Region, type Regions } from "../src/regions.ts";

export const CONTENT_DOMAIN = "portifact.dev";
export const APP_ORIGIN = "https://app.portifact.com";

export function regions(overrides: { global?: D1Database; eu?: D1Database } = {}): Regions {
  return createRegions(overrides.global ?? env.GLOBAL, overrides.eu ?? env.DB_EU);
}

/** A database whose every `prepare` is counted: each is one query sent to D1. */
export function counting(db: D1Database): { db: D1Database; queries: () => number } {
  let queries = 0;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries += 1;
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, queries: () => queries };
}

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** A random valid artifact ID, so tests sharing a database never collide. */
export function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => alphabet[b % 32]).join("");
}

/** A hostname no other test uses. */
export function randomHost(): string {
  return `docs-${crypto.randomUUID().slice(0, 8)}.example.com`;
}

export async function seedArtifact(
  r: Regions,
  input: {
    region?: Region;
    ownerId?: string;
    accessMode?: "public" | "authenticated" | "restricted";
    bar?: boolean;
  } = {},
): Promise<{ id: string; ownerId: string; region: Region }> {
  const id = randomId();
  const ownerId = input.ownerId ?? uid("usr");
  const region = input.region ?? "default";
  await r
    .db(region)
    .prepare("insert into artifacts (id, owner_id, access_mode, bar) values (?, ?, ?, ?)")
    .bind(id, ownerId, input.accessMode ?? "public", input.bar === false ? 0 : 1)
    .run();
  return { id, ownerId, region };
}

/** Cloudflare's custom hostnames as an in-memory fake; `active` decides what status reports. */
export class FakeHostnames implements CustomHostnames {
  readonly hostnames = new Map<string, string>();
  active = true;
  failCreate = false;
  calls: string[] = [];
  #next = 0;

  async create(hostname: string) {
    this.calls.push(`create ${hostname}`);
    if (this.failCreate) throw new Error("Cloudflare unavailable");
    this.#next += 1;
    const id = `cf_${this.#next}_${crypto.randomUUID().slice(0, 6)}`;
    this.hostnames.set(id, hostname);
    return { id };
  }
  async status(id: string) {
    if (!this.hostnames.has(id)) return "missing" as const;
    return this.active ? ("active" as const) : ("pending" as const);
  }
  async remove(id: string) {
    this.calls.push(`remove ${id}`);
    this.hostnames.delete(id);
  }
  async list() {
    return [...this.hostnames].map(([id, hostname]) => ({ id, hostname }));
  }
}

/** DNS as a map from TXT name to its values. */
export function fakeDns(): { records: Map<string, string[]>; deps: (cf: CustomHostnames) => Deps } {
  const records = new Map<string, string[]>();
  return {
    records,
    deps: (cloudflare) => ({ cloudflare, txt: async (name) => records.get(name) ?? [] }),
  };
}

export async function count(db: D1Database, query: string, ...params: unknown[]): Promise<number> {
  const row = await db
    .prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Claim, publish the TXT proof, verify and activate: a domain serving on `hostname`. */
export async function attach(
  r: Regions,
  dns: ReturnType<typeof fakeDns>,
  cloudflare: FakeHostnames,
  artifact: { id: string; ownerId: string; region: Region },
  hostname: string,
  now = 1_000,
): Promise<void> {
  const { claimDomain, verifyClaim, activateDomain } = await import("../src/domains.ts");
  const claim = await claimDomain(r, {
    ownerId: artifact.ownerId,
    artifactId: artifact.id,
    region: artifact.region,
    hostname,
    limit: 5,
    now,
  });
  if (!claim.ok) throw new Error(claim.error);
  dns.records.set(claim.txtName, [claim.txtValue]);
  const deps = dns.deps(cloudflare);
  const verified = await verifyClaim(r, deps, { ownerId: artifact.ownerId, hostname, now });
  if (!verified.ok) throw new Error(verified.error);
  const state = await activateDomain(r, deps, hostname);
  if (state !== "active") throw new Error(state);
}
