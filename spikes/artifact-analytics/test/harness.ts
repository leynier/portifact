import { env } from "cloudflare:workers";
import { DAY_MS } from "../src/views.ts";

export function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % 32]).join("");
}

/** 2026-11-10 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 10, 12);
export const TODAY = Date.UTC(2026, 10, 10);
export const daysAgo = (n: number) => TODAY - n * DAY_MS;

export async function seedArtifact(
  options: { accessMode?: string; plan?: string | null; state?: string } = {},
): Promise<{ id: string; ownerId: string }> {
  const id = randomId();
  const ownerId = `user-${randomId()}`;
  await env.CONTROL.prepare(
    "insert into artifacts (id, owner_id, access_mode, state) values (?, ?, ?, ?)",
  )
    .bind(id, ownerId, options.accessMode ?? "public", options.state ?? "active")
    .run();
  const plan = options.plan === undefined ? "pro" : options.plan;
  if (plan !== null) {
    await env.CONTROL.prepare("insert into owner_plans (owner_id, plan) values (?, ?)")
      .bind(ownerId, plan)
      .run();
  }
  return { id, ownerId };
}

/** One access log row, as `recordOpenings` writes it, with an expiry 365 days after opening. */
export async function seedOpening(
  artifactId: string,
  ownerId: string,
  userId: string,
  at: number,
  retentionDays = 365,
): Promise<void> {
  const window = Math.floor(at / 1_800_000) * 1_800_000;
  await env.ACCESS.prepare(
    `insert into access_events values (?, ?, ?, ?, ?, ?, ?)
     on conflict do nothing`,
  )
    .bind(
      artifactId,
      window,
      userId,
      ownerId,
      `${userId}@example.com`,
      at,
      at + retentionDays * DAY_MS,
    )
    .run();
}

export async function viewRows(artifactId: string) {
  const { results } = await env.ACCESS.prepare(
    "select day, views, signed_in_views, expires_at from artifact_views where artifact_id = ? order by day",
  )
    .bind(artifactId)
    .all<{ day: number; views: number; signed_in_views: number; expires_at: number }>();
  return results;
}

/** A `waitUntil` that keeps the promises, so a test can wait for scheduled flushes. */
export function collector() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    settle: () => Promise.all(promises),
    scheduled: () => promises.length,
  };
}
