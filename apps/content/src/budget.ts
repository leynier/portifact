// Budget protection on delivery (plan section 12). Its last two steps put a tight per-visitor rate
// limit first on public traffic, then, as a last resort, on protected traffic. Serving what is
// published has priority, so this never blocks a visitor outright and fails open: without the
// state or the limiter, delivery is unchanged, and the failure is logged.
//
// The limit is counted by the TrafficLimiter Durable Object (src/traffic-limiter.ts), one per
// visitor IP and kind of traffic, not by Workers Rate Limiting: that binding is approximate per
// location, and in production a 240-a-minute binding refused none of 1,200 protected requests
// a minute from one IP (docs/operations.md).
import type { GlobalDb } from "@portifact/db";
import {
  PROTECTION_TRAFFIC_LIMITS,
  type ProtectionAction,
  trafficLimited,
} from "@portifact/domain";
import { platformProtection } from "@portifact/services";
import type { TrafficLimiter } from "./traffic-limiter.ts";

export interface BudgetEnv {
  /** The per-visitor counters (wrangler.jsonc `durable_objects`). */
  TRAFFIC_LIMITER?: DurableObjectNamespace<TrafficLimiter> | undefined;
}

/** How long an isolate reuses the protection it read: the same 60 s as revocation. */
export const PROTECTION_TTL_MS = 60_000;

/** Visitors an isolate remembers as over their limit before it forgets the expired ones. */
export const MAX_REMEMBERED_REFUSALS = 10_000;

let cached: { actions: ProtectionAction[]; readAt: number } | null = null;

/**
 * Keys known to be over their limit, until their window ends. Refusing them from memory spares a
 * Durable Object request per refused request, which is what a flood is made of.
 */
const refusedUntil = new Map<string, number>();
let maxRefusals = MAX_REMEMBERED_REFUSALS;

/**
 * Forgets the cached protection and the remembered refusals, for tests. `maxRefusals` shrinks the
 * memory so a test can fill it with a few requests instead of ten thousand.
 */
export function resetProtectionCache(options: { maxRefusals?: number } = {}): void {
  cached = null;
  refusedUntil.clear();
  maxRefusals = options.maxRefusals ?? MAX_REMEMBERED_REFUSALS;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

async function protectionActions(db: GlobalDb, now: number): Promise<ProtectionAction[]> {
  if (cached && now - cached.readAt < PROTECTION_TTL_MS) return cached.actions;
  let actions: ProtectionAction[] = [];
  try {
    actions = (await platformProtection(db, now)).actions;
  } catch (error) {
    // Unreadable state never stops delivery; the next minute reads it again.
    console.error(
      JSON.stringify({ event: "budget_protection_unreadable", error: errorName(error) }),
    );
  }
  cached = { actions, readAt: now };
  return actions;
}

function remember(key: string, resetAt: number, now: number): void {
  if (refusedUntil.size >= maxRefusals) {
    for (const [known, until] of refusedUntil) if (until <= now) refusedUntil.delete(known);
    if (refusedUntil.size >= maxRefusals) refusedUntil.clear();
  }
  refusedUntil.set(key, resetAt);
}

/**
 * When the visitor is over the limit protection puts on this kind of traffic, the time their
 * window ends (for `Retry-After`); null when the request may be served. Keyed by the connecting
 * IP, which Cloudflare sets and the visitor cannot choose.
 */
export async function overTrafficLimit(
  request: Request,
  env: BudgetEnv,
  db: GlobalDb,
  isPublic: boolean,
  now: number,
): Promise<number | null> {
  if (!trafficLimited(await protectionActions(db, now), isPublic)) return null;
  const limiters = env.TRAFFIC_LIMITER;
  if (!limiters) return null;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `${isPublic ? "public" : "protected"}:${ip}`;
  const known = refusedUntil.get(key);
  if (known !== undefined && known > now) return known;
  const limit = isPublic ? PROTECTION_TRAFFIC_LIMITS.public : PROTECTION_TRAFFIC_LIMITS.protected;
  try {
    const hit = await limiters
      .get(limiters.idFromName(key))
      .hit(limit, PROTECTION_TRAFFIC_LIMITS.periodMs, now);
    if (hit.allowed) return null;
    remember(key, hit.resetAt, now);
    return hit.resetAt;
  } catch (error) {
    console.error(JSON.stringify({ event: "traffic_limiter_failed", error: errorName(error) }));
    return null;
  }
}
