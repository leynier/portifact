// The owner's plan (premium plan section 3, F1): the services read the `owner_plans` row and pass
// the effective limits to the domain rules, so every adapter gets the same limits. Adapters never
// resolve a plan themselves. The content Worker reads the row with its artifact lookup instead
// (`findDeliveryArtifact`), so delivery adds no read.
import type { PlanView } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { type Entitlements, entitlements } from "@portifact/domain";
import { eq } from "drizzle-orm";

/** What the owner's plan grants at `now`; `free` without a row or once it expired. */
export async function ownerEntitlements(
  db: Db,
  ownerId: string,
  now: number,
): Promise<Entitlements> {
  const [row] = await db
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId))
    .limit(1);
  return entitlements(row ?? null, now);
}

/** The plan as the usage endpoint, the CLI, MCP and the account export show it. */
export function planView(owner: Entitlements): PlanView {
  return {
    name: owner.plan,
    validUntil: owner.validUntil === null ? null : new Date(owner.validUntil).toISOString(),
    seats: owner.seats,
    limits: owner.limits,
    features: owner.features,
  };
}
