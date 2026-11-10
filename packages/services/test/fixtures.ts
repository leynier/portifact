// Accounts and artifacts published through the real publish flow, for the moderation and
// account-data tests. Every helper uses a fresh user, so tests in a file do not share rows.
import { env } from "cloudflare:test";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { commitPublish, preparePublish } from "../src/publish.ts";

export const db = () => regionsFromEnv(env).get("default").db;
export const NOW = Date.UTC(2026, 10, 8, 12);
export const MINUTE = 60_000;
export const DAY = 86_400_000;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function user(name = "Someone"): Promise<{ id: string; email: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

/** A dashboard session signed in at `createdAt`. */
export async function session(userId: string, createdAt = NOW): Promise<string> {
  const id = `s_${crypto.randomUUID()}`;
  await db()
    .insert(schema.sessions)
    .values({
      id,
      token: `t_${crypto.randomUUID()}`,
      userId,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      expiresAt: new Date(NOW + 7 * DAY),
    });
  return id;
}

/** Publishes a site with the given files for `ownerId` and returns its IDs. */
export async function publishSite(
  ownerId: string,
  bodies: Record<string, string> = { "index.html": `<p>${crypto.randomUUID()}</p>` },
  now = NOW,
  base?: { artifactId: string; versionId: string },
) {
  const files = await Promise.all(
    Object.entries(bodies).map(async ([path, body]) => ({
      path,
      kind: "published" as const,
      sha256: await sha256(body),
      size: body.length,
      contentType: "text/html",
    })),
  );
  const prepared = await preparePublish(db(), {
    userId: ownerId,
    type: "site",
    name: "Plan",
    entrypoint: "index.html",
    baseVersionId: base?.versionId ?? null,
    ...(base ? { artifactId: base.artifactId } : {}),
    files,
    now,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  for (const body of Object.values(bodies)) {
    await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(body)}`, body);
  }
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    userId: ownerId,
    sessionId: prepared.value.sessionId,
    now,
  });
  if (!committed.ok) throw new Error(committed.message);
  return { artifactId: committed.value.artifactId, versionId: committed.value.versionId };
}

export async function artifactRow(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

export async function activeSlots(ownerId: string): Promise<number> {
  const [row] = await db()
    .select({ active: schema.accountUsage.activeArtifacts })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row?.active ?? 0;
}

/**
 * Wraps the database so the next `batch` first lets a competing change commit, which is how a
 * race between a request's reads and its write batch is tested deterministically.
 */
/**
 * Every region, with the global database's first batch running `before` first: the race of a
 * request that writes globally first (account and workspace deletion, decision 0005).
 */
export function racingGlobally(before: () => Promise<unknown>) {
  // On the binding, so the batch races whichever handle runs it: with one database a deletion's
  // one batch runs on the handle that reaches both sides (`bothSides`).
  let raced = false;
  const binding = aliasBinding(
    new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch" && !raced) {
          return async (statements: D1PreparedStatement[]) => {
            raced = true;
            await before();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    env.DB,
  );
  return regionsFromEnv({ ...env, DB: binding });
}

export function racing(before: () => Promise<unknown>) {
  const real = db();
  let raced = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "batch" || raced) return Reflect.get(target, property, receiver);
      return async (statements: Parameters<typeof real.batch>[0]) => {
        raced = true;
        await before();
        return target.batch(statements);
      };
    },
  }) as ReturnType<typeof db>;
}

/**
 * Gives an owner a plan by writing its `owner_plans` row directly: nothing in the product grants
 * plans yet, and the database CHECK constraints still hold the free limits.
 */
export async function grantPlan(
  ownerId: string,
  plan: "free" | "pro" | "team" | "enterprise",
  options: { seats?: number; validUntil?: number | null; overrides?: unknown } = {},
): Promise<void> {
  await db()
    .insert(schema.ownerPlans)
    .values({
      ownerId,
      plan,
      seats: options.seats ?? 1,
      validUntil: options.validUntil ?? null,
      overrides: options.overrides ?? null,
      grantedBy: "test",
      updatedAt: NOW,
    })
    .onConflictDoUpdate({
      target: schema.ownerPlans.ownerId,
      set: {
        plan,
        seats: options.seats ?? 1,
        validUntil: options.validUntil ?? null,
        overrides: options.overrides ?? null,
      },
    });
}

/** The value of a successful result; fails the test with the error otherwise. */
export function value<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
