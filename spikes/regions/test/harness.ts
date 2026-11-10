import { env } from "cloudflare:workers";
import { createRegions, type Regions } from "../src/regions.ts";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/**
 * The two layouts every cross-database test runs in. `separate`: the global database and each
 * region apart, which proves the code never relies on two handles being one database.
 * `colocated`: the default region inside the control database, as production would run it.
 */
export const LAYOUTS = ["separate", "colocated"] as const;
export type Layout = (typeof LAYOUTS)[number];

export function regionsFor(layout: Layout, overrides: { eu?: D1Database } = {}): Regions {
  return createRegions({
    global: env.GLOBAL,
    accountId: ACCOUNT_ID,
    regions: {
      default: {
        db: layout === "separate" ? env.DB_DEFAULT : env.GLOBAL,
        bucket: env.ARTIFACTS,
        bucketName: "portifact-artifacts",
      },
      eu: {
        db: overrides.eu ?? env.DB_EU,
        bucket: env.ARTIFACTS_EU,
        bucketName: "portifact-artifacts-eu",
      },
    },
  });
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

/** A database whose batches fail the first `times` times, like a region that is briefly down. */
export function flaky(db: D1Database, times = 1): D1Database {
  let left = times;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          if (left > 0) {
            left -= 1;
            return Promise.reject(new Error("D1 unavailable"));
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function seedUser(regions: Regions): Promise<{ userId: string; sessionId: string }> {
  const userId = uid("usr");
  const sessionId = uid("ses");
  await regions.global.batch([
    regions.global
      .prepare("insert into users (id, email) values (?, ?)")
      .bind(userId, `${userId}@example.com`),
    regions.global
      .prepare("insert into sessions (id, user_id, expires_at) values (?, ?, ?)")
      .bind(sessionId, userId, Date.now() + 86_400_000),
  ]);
  return { userId, sessionId };
}

export async function seedWorkspace(regions: Regions, region: string): Promise<string> {
  const id = uid("org");
  await regions.global
    .prepare("insert into organizations (id, region) values (?, ?)")
    .bind(id, region)
    .run();
  return id;
}

/** Random bytes that spell out `ids` in order, one ID per call. */
export function scripted(ids: string[]) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let next = 0;
  return (bytes: Uint8Array<ArrayBuffer>) => {
    const id = ids[next] ?? ids.at(-1) ?? "";
    next += 1;
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = alphabet.indexOf(id[i] ?? "a");
  };
}

/** A random valid artifact ID, so tests sharing a database never collide. */
export function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % 32]).join("");
}

export async function count(db: D1Database, query: string, ...params: unknown[]): Promise<number> {
  const row = await db
    .prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
