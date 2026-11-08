// Budget protection on delivery (plan section 12). Its last two steps put a tight per-visitor rate
// limit first on public traffic, then, as a last resort, on protected traffic. Serving what is
// published has priority, so this never blocks a visitor outright and fails open: without the
// state or the rate limit bindings, delivery is unchanged.
import type { Db } from "@portifact/db";
import { type ProtectionAction, trafficLimited } from "@portifact/domain";
import { platformProtection } from "@portifact/services";

export interface BudgetEnv {
  /** Workers Rate Limiting bindings keyed by visitor IP (wrangler.jsonc `ratelimits`). */
  PUBLIC_TRAFFIC_LIMIT?: RateLimit | undefined;
  PROTECTED_TRAFFIC_LIMIT?: RateLimit | undefined;
}

/** How long an isolate reuses the protection it read: the same 60 s as revocation. */
export const PROTECTION_TTL_MS = 60_000;

let cached: { actions: ProtectionAction[]; readAt: number } | null = null;

/** Forgets the cached protection, for tests. */
export function resetProtectionCache(): void {
  cached = null;
}

async function protectionActions(db: Db, now: number): Promise<ProtectionAction[]> {
  if (cached && now - cached.readAt < PROTECTION_TTL_MS) return cached.actions;
  let actions: ProtectionAction[] = [];
  try {
    actions = (await platformProtection(db, now)).actions;
  } catch {
    // Unreadable state never stops delivery; the next minute reads it again.
  }
  cached = { actions, readAt: now };
  return actions;
}

/**
 * The visitor's rate limit while protection limits this kind of traffic: true when the request
 * is over it. Keyed by the connecting IP, which Cloudflare sets and the visitor cannot choose.
 */
export async function overTrafficLimit(
  request: Request,
  env: BudgetEnv,
  db: Db,
  isPublic: boolean,
  now: number,
): Promise<boolean> {
  if (!trafficLimited(await protectionActions(db, now), isPublic)) return false;
  const limiter = isPublic ? env.PUBLIC_TRAFFIC_LIMIT : env.PROTECTED_TRAFFIC_LIMIT;
  if (!limiter) return false;
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: `${isPublic ? "public" : "protected"}:${key}` });
  return !success;
}
