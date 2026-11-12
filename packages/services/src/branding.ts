// The owner's brand on the viewer's bar (premium plan P9, feature `branding`): reading and
// changing it, its logo, what the viewer and the content Worker get, and the operator's
// suspension. The rules are in packages/domain/src/branding.ts.
//
// - Only admins of the owner manage it (`brand`); a user without a role gets `not_found`.
// - Setting the brand or a logo needs the owner's plan to include `branding`. Removing either
//   never does, and a lapsed plan keeps the brand, unused, until the plan returns.
// - The logo's bytes live in R2 at `brands/<owner>/<sha256>`, outside `objects/`, and count in
//   the owner's `account_usage.stored_bytes` while the row names them: the batch that names a new
//   logo adds its size and subtracts the old one's, so the storage limit's CHECK refuses a logo
//   that does not fit, and the old key goes to a `delete_objects` job in the same batch.
import {
  type AbuseReason,
  type AuditDetail,
  BRAND_LOGO_PATH,
  type Brand,
  type BrandSettings,
  type BrandUpdate,
  brandLogoKey,
  lowestPlanWith,
} from "@portifact/contracts";
import { bothSides, type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  brandShown,
  type Entitlements,
  entitlements,
  fail,
  formatSize,
  inspectLogo,
  limitColumns,
  normalizeBrandLink,
  normalizeBrandName,
  type OwnerPlanRecord,
  ok,
  type Result,
  requireFeature,
} from "@portifact/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { auditEvent } from "./audit.ts";
import { type DecisionStatement, decisionStatements, newDecisionId } from "./moderation-notices.ts";
import { sha256Hex } from "./objects.ts";
import { OUTBOX_INLINE_GRACE_MS } from "./outbox.ts";
import { ownerEntitlements, ownerPlanRecord } from "./plans.ts";

type BrandRow = typeof schema.ownerBrands.$inferSelect;

async function loadBrand(db: Db, ownerId: string): Promise<BrandRow | null> {
  const [row] = await db
    .select()
    .from(schema.ownerBrands)
    .where(eq(schema.ownerBrands.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/** The stored brand as the Branding page and the account export show it. */
export function brandView(row: BrandRow): Brand {
  return {
    name: row.name,
    accentColor: row.accentColor,
    link: row.link,
    logo:
      row.logoSha256 !== null &&
      row.logoType !== null &&
      row.logoWidth !== null &&
      row.logoHeight !== null &&
      row.logoBytes !== null
        ? {
            sha256: row.logoSha256,
            type: row.logoType,
            width: row.logoWidth,
            height: row.logoHeight,
            bytes: row.logoBytes,
          }
        : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function settingsOf(row: BrandRow | null, owner: Entitlements): BrandSettings {
  return {
    available: owner.features.includes("branding"),
    lowestPlan: lowestPlanWith("branding"),
    suspended: row?.suspendedAt != null,
    brand: row ? brandView(row) : null,
  };
}

async function currentSettings(
  db: RegionalDb,
  ownerId: string,
  now: number,
): Promise<BrandSettings> {
  const [row, owner] = await Promise.all([
    loadBrand(db, ownerId),
    ownerEntitlements(db.global, ownerId, now),
  ]);
  return settingsOf(row, owner);
}

const CHANGED = "The brand changed meanwhile. Reload the page and try again.";

/** The owner's brand for its admins. */
export async function getBrandSettings(
  db: RegionalDb,
  input: { actor: Actor; now: number },
): Promise<Result<BrandSettings>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  return ok(await currentSettings(db, input.actor.ownerId, input.now));
}

/**
 * Sets the name, accent color and link. `blockedHosts` are the deployment's own domains, which a
 * brand link may not point at (Portifact's public domains always are).
 */
export async function updateBrand(
  db: RegionalDb,
  input: { actor: Actor; update: BrandUpdate; blockedHosts: readonly string[]; now: number },
): Promise<Result<BrandSettings>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  const owner = await ownerEntitlements(db.global, input.actor.ownerId, input.now);
  const gate = requireFeature(owner, "branding");
  if (!gate.ok) return gate;
  const name = normalizeBrandName(input.update.name);
  if (!name.ok) return name;
  let link: string | null = null;
  if (input.update.link !== null && input.update.link.trim() !== "") {
    const checked = normalizeBrandLink(input.update.link, input.blockedHosts);
    if (!checked.ok) return checked;
    link = checked.value;
  }
  const values = {
    name: name.value,
    accentColor: input.update.accentColor,
    link,
    updatedAt: input.now,
  };
  const b = schema.ownerBrands;
  const [, [row]] = await db.batch([
    // Before the upsert, only when it changes something.
    brandEvent(
      db,
      input.actor,
      "brand.changed",
      ["name", "accent", "link"],
      input.now,
      sql`not exists (select 1 from ${b} where ${b.ownerId} = ${input.actor.ownerId} and ${b.name} = ${values.name} and ${b.accentColor} = ${values.accentColor} and ${b.link} is ${values.link})`,
    ),
    db
      .insert(b)
      .values({ ownerId: input.actor.ownerId, ...values })
      .onConflictDoUpdate({
        target: b.ownerId,
        set: { ...values, revision: sql`${b.revision} + 1` },
      })
      .returning(),
  ]);
  return ok(settingsOf(row ?? null, owner));
}

/** The audit event of a brand change, before its guarded write on the same condition. */
function brandEvent<K extends "brand.changed" | "brand.removed">(
  db: Db,
  actor: Actor,
  kind: K,
  fields: AuditDetail<K>["fields"],
  now: number,
  condition: SQL,
): BatchItem<"sqlite"> {
  return auditEvent(
    db,
    {
      ownerId: actor.ownerId,
      kind,
      actor: { type: "user", id: actor.userId },
      targetId: actor.ownerId,
      detail: { fields } as AuditDetail<K>,
      now,
    },
    condition,
  );
}

/** The statements that release a stored logo, while the row still has the revision read. */
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

function releaseLogo(db: Db, row: BrandRow, guard: SQL, now: number): BatchItem<"sqlite">[] {
  if (row.logoSha256 === null || row.logoBytes === null) return [];
  const key = brandLogoKey(row.ownerId, row.logoSha256);
  return [
    db
      .insert(schema.outbox)
      .select(
        sql`select null, 'delete_objects', json_object('keys', json_array(${key})), ${now + OUTBOX_INLINE_GRACE_MS}, null, 0, ${now}, ${row.ownerId}, null where ${guard}`,
      ),
    db
      .update(schema.accountUsage)
      .set({
        storedBytes: sql`max(0, ${schema.accountUsage.storedBytes} - ${row.logoBytes})`,
        updatedAt: now,
      })
      .where(and(eq(schema.accountUsage.ownerId, row.ownerId), guard)),
  ] as const;
}

function sameRevision(row: BrandRow): SQL {
  const b = schema.ownerBrands;
  return sql`exists (select 1 from ${b} where ${b.ownerId} = ${row.ownerId} and ${b.revision} = ${row.revision})`;
}

/** Deletes the brand and its logo; the default bar shows again. Allowed on every plan. */
export async function deleteBrand(
  db: RegionalDb,
  input: { actor: Actor; now: number },
): Promise<Result<BrandSettings>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  const row = await loadBrand(db, input.actor.ownerId);
  if (row) {
    if (row.suspendedAt !== null) {
      // Deleting would clear the operator's decision; the owner writes to abuse@ instead.
      return fail("forbidden", "This brand is suspended. Write to abuse@portifact.com about it.");
    }
    const b = schema.ownerBrands;
    const results = await db.batch([
      brandEvent(db, input.actor, "brand.removed", ["all"], input.now, sameRevision(row)),
      ...releaseLogo(db, row, sameRevision(row), input.now),
      db
        .delete(b)
        .where(and(eq(b.ownerId, row.ownerId), eq(b.revision, row.revision)))
        .returning({ ownerId: b.ownerId }),
    ] as BatchItem<"sqlite">[] as Batch);
    if ((results.at(-1) as unknown[]).length === 0) return fail("version_conflict", CHANGED);
  }
  return ok(await currentSettings(db, input.actor.ownerId, input.now));
}

function storageFull(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/CHECK constraint failed: account_usage/.test(e.message)) return true;
  }
  return false;
}

/**
 * Stores a new logo, judged by its bytes alone (`inspectLogo`), and names it in the brand. The
 * brand must exist first (it needs a name). The same bytes again change nothing.
 */
export async function setBrandLogo(
  db: RegionalDb,
  bucket: R2Bucket,
  input: { actor: Actor; bytes: Uint8Array; now: number },
): Promise<Result<BrandSettings>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  const ownerId = input.actor.ownerId;
  const owner = await ownerEntitlements(db.global, ownerId, input.now);
  const gate = requireFeature(owner, "branding");
  if (!gate.ok) return gate;
  const logo = inspectLogo(input.bytes);
  if (!logo.ok) return logo;
  const row = await loadBrand(db, ownerId);
  if (!row) return fail("invalid_input", "logo: Save the brand's name before adding a logo.");
  const sha256 = await sha256Hex(input.bytes);
  if (row.logoSha256 === sha256) return ok(settingsOf(row, owner));

  const key = brandLogoKey(ownerId, sha256);
  // A safety net written before the bytes: if this request dies before its batch names the key,
  // the job deletes it; once named, the job keeps it (`deleteUnreferencedKeys`).
  await db.insert(schema.outbox).values({
    topic: "delete_objects",
    payload: { keys: [key] },
    availableAt: input.now + OUTBOX_INLINE_GRACE_MS,
    createdAt: input.now,
    subject: ownerId,
  });
  await bucket.put(key, input.bytes, {
    httpMetadata: { contentType: logo.value.type },
    sha256,
  });

  const guard = sameRevision(row);
  const b = schema.ownerBrands;
  const u = schema.accountUsage;
  const columns = limitColumns(owner);
  const monthStart = new Date(input.now);
  try {
    const results = await db.batch([
      db
        .insert(u)
        .values({
          ownerId,
          monthStartedAt: Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1),
          activeLimit: columns.activeLimit,
          bytesLimit: columns.bytesLimit,
        })
        .onConflictDoNothing(),
      brandEvent(db, input.actor, "brand.changed", ["logo"], input.now, guard),
      ...releaseLogo(db, row, guard, input.now),
      db
        .update(u)
        .set({ storedBytes: sql`${u.storedBytes} + ${input.bytes.length}`, updatedAt: input.now })
        .where(and(eq(u.ownerId, ownerId), guard)),
      // The guarded update last: every write above is conditioned on the revision it changes.
      db
        .update(b)
        .set({
          logoSha256: sha256,
          logoType: logo.value.type,
          logoWidth: logo.value.width,
          logoHeight: logo.value.height,
          logoBytes: input.bytes.length,
          revision: sql`${b.revision} + 1`,
          updatedAt: input.now,
        })
        .where(and(eq(b.ownerId, ownerId), eq(b.revision, row.revision)))
        .returning(),
    ] as BatchItem<"sqlite">[] as Batch);
    const [updated] = results.at(-1) as BrandRow[];
    if (!updated) return fail("version_conflict", CHANGED);
    return ok(settingsOf(updated, owner));
  } catch (error) {
    if (!storageFull(error)) throw error;
    return fail(
      "quota_exceeded",
      `logo: Your storage is full (${formatSize(owner.limits.accountBytes)} on your plan). Delete something first.`,
    );
  }
}

/** Removes the logo and releases its bytes. Allowed on every plan. */
export async function removeBrandLogo(
  db: RegionalDb,
  input: { actor: Actor; now: number },
): Promise<Result<BrandSettings>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  const row = await loadBrand(db, input.actor.ownerId);
  if (row?.logoSha256 != null) {
    const b = schema.ownerBrands;
    const results = await db.batch([
      brandEvent(db, input.actor, "brand.removed", ["logo"], input.now, sameRevision(row)),
      ...releaseLogo(db, row, sameRevision(row), input.now),
      db
        .update(b)
        .set({
          logoSha256: null,
          logoType: null,
          logoWidth: null,
          logoHeight: null,
          logoBytes: null,
          revision: sql`${b.revision} + 1`,
          updatedAt: input.now,
        })
        .where(and(eq(b.ownerId, row.ownerId), eq(b.revision, row.revision)))
        .returning({ ownerId: b.ownerId }),
    ] as BatchItem<"sqlite">[] as Batch);
    if ((results.at(-1) as unknown[]).length === 0) return fail("version_conflict", CHANGED);
  }
  return ok(await currentSettings(db, input.actor.ownerId, input.now));
}

/** The stored logo for the Branding page's preview, for the owner's admins. */
export async function readBrandLogo(
  db: RegionalDb,
  bucket: R2Bucket,
  input: { actor: Actor },
): Promise<Result<{ type: string; body: ReadableStream }>> {
  const allowed = authorize(input.actor, "brand");
  if (!allowed.ok) return allowed;
  const row = await loadBrand(db, input.actor.ownerId);
  if (!row?.logoSha256 || !row.logoType) return fail("not_found", "There is no logo.");
  const object = await bucket.get(brandLogoKey(row.ownerId, row.logoSha256));
  if (!object) return fail("not_found", "There is no logo.");
  return ok({ type: row.logoType, body: object.body });
}

/** The parts of the brand the viewer needs, from the artifact lookup's join. */
export interface ViewerBrandRow {
  name: string;
  accentColor: string | null;
  link: string | null;
  logoSha256: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  suspendedAt: number | null;
}

/** What the viewer shows of a brand: null for the default bar. */
export interface ViewerBrandFacts {
  name: string;
  accentColor: string | null;
  link: string | null;
  logo: { sha256: string; width: number; height: number } | null;
}

export function viewerBrandFacts(
  row: ViewerBrandRow | null,
  owner: Entitlements,
): ViewerBrandFacts | null {
  if (row === null || !brandShown(row, owner)) return null;
  return {
    name: row.name,
    accentColor: row.accentColor,
    link: row.link,
    logo:
      row.logoSha256 !== null && row.logoWidth !== null && row.logoHeight !== null
        ? { sha256: row.logoSha256, width: row.logoWidth, height: row.logoHeight }
        : null,
  };
}

/** The URL of a logo on the artifact's own origin. */
export function brandLogoUrl(artifactOrigin: string, sha256: string): string {
  return `${artifactOrigin}${BRAND_LOGO_PATH}${sha256}`;
}

/**
 * The logo the content Worker serves at `/__portifact/brand/<sha256>` on an artifact's origin:
 * only the current logo of the artifact's owner, while the artifact is servable and the brand is
 * shown (the plan has `branding`, no suspension). Null for everything else.
 */
export async function findBrandLogo(
  db: RegionalDb,
  input: { artifactId: string; sha256: string; now: number },
): Promise<{ key: string; type: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) return null;
  const a = schema.artifacts;
  const b = schema.ownerBrands;
  const p = schema.ownerPlans;
  // With one database the plan comes with the brand, as it always did; otherwise it is read from
  // the global database, only for a logo that exists and may be shown (decision 0005).
  const both = bothSides(db);
  const base = (both ?? db)
    .select({
      ownerId: a.ownerId,
      state: a.state,
      expiresAt: a.expiresAt,
      logoType: b.logoType,
      suspendedAt: b.suspendedAt,
      ...(both
        ? {
            joinedPlan: {
              plan: p.plan,
              seats: p.seats,
              validUntil: p.validUntil,
              overrides: p.overrides,
              grace: p.grace,
            },
          }
        : {}),
    })
    .from(a)
    .innerJoin(b, eq(b.ownerId, a.ownerId))
    .$dynamic();
  const [row] = await (both ? base.leftJoin(p, eq(p.ownerId, a.ownerId)) : base)
    .where(and(eq(a.id, input.artifactId), eq(b.logoSha256, input.sha256)))
    .limit(1);
  if (!row?.logoType) return null;
  if (row.state !== "active" || (row.expiresAt !== null && row.expiresAt <= input.now)) {
    return null;
  }
  const plan = both
    ? (("joinedPlan" in row ? row.joinedPlan : null) as OwnerPlanRecord | null)
    : await ownerPlanRecord(db.global, row.ownerId);
  const owner = entitlements(plan, input.now);
  if (!brandShown(row, owner)) return null;
  return { key: brandLogoKey(row.ownerId, input.sha256), type: row.logoType };
}

/** The operator's view of an owner's brand (`operator brand <owner>`). */
export async function showBrand(db: RegionalDb, ownerId: string, now: number) {
  const [row, owner] = await Promise.all([
    loadBrand(db, ownerId),
    ownerEntitlements(db.global, ownerId, now),
  ]);
  return {
    brand: row ? brandView(row) : null,
    suspendedAt: row?.suspendedAt ?? null,
    suspensionReason: row?.suspensionReason ?? null,
    shown: row !== null && brandShown(row, owner),
  };
}

/**
 * Suspends an owner's brand (operator tool only): the viewer shows the default bar and the logo
 * stops being served at once. The brand is kept, and the owner cannot delete it meanwhile. The
 * statement of reasons, when given, is written in the same batch on the revision read.
 */
export async function suspendBrand(
  db: Db,
  input: {
    ownerId: string;
    reason: AbuseReason;
    now: number;
    reportId?: string | undefined;
    statement?: DecisionStatement | undefined;
  },
): Promise<Result<{ suspended: boolean }>> {
  return changeBrandSuspension(db, input, "suspend");
}

/** Lifts a brand suspension (operator tool only); the brand shows again if the plan has it. */
export async function reinstateBrand(
  db: Db,
  input: { ownerId: string; now: number; statement?: DecisionStatement | undefined },
): Promise<Result<{ reinstated: boolean }>> {
  const result = await changeBrandSuspension(db, input, "reinstate");
  return result.ok ? ok({ reinstated: result.value.suspended }) : result;
}

async function changeBrandSuspension(
  db: Db,
  input: {
    ownerId: string;
    reason?: AbuseReason;
    now: number;
    reportId?: string | undefined;
    statement?: DecisionStatement | undefined;
  },
  action: "suspend" | "reinstate",
): Promise<Result<{ suspended: boolean }>> {
  const b = schema.ownerBrands;
  const row = await loadBrand(db, input.ownerId);
  if (!row) return fail("not_found", "This owner has no brand.");
  const suspending = action === "suspend";
  if ((row.suspendedAt === null) !== suspending) return ok({ suspended: false });
  const unchanged = and(
    eq(b.ownerId, input.ownerId),
    eq(b.revision, row.revision),
    suspending ? sql`${b.suspendedAt} is null` : sql`${b.suspendedAt} is not null`,
  ) as SQL;
  const decision = input.statement
    ? decisionStatements(
        db,
        newDecisionId(),
        {
          targetKind: "brand",
          targetId: input.ownerId,
          ownerId: input.ownerId,
          action,
          reason: suspending ? (input.reason ?? null) : null,
          suspensionId: null,
          reportId: input.reportId ?? null,
          now: input.now,
        },
        input.statement,
        sql`exists (select 1 from ${b} where ${unchanged})`,
      )
    : [];
  const results = (await db.batch([
    ...decision,
    db
      .update(b)
      .set({
        suspendedAt: suspending ? input.now : null,
        suspensionReason: suspending ? (input.reason ?? null) : null,
        revision: sql`${b.revision} + 1`,
        updatedAt: input.now,
      })
      .where(unchanged)
      .returning({ ownerId: b.ownerId }),
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]])) as unknown[];
  if ((results.at(-1) as unknown[]).length > 0) return ok({ suspended: true });
  return fail("version_conflict", "The brand changed meanwhile. Try again.");
}

/**
 * Deletes an owner's brand and its logo at the end of an account deletion; the usage row goes
 * with the rest of the account's counters, so nothing is released. Safe to run again.
 */
export async function eraseOwnerBrand(db: Db, bucket: R2Bucket, ownerId: string): Promise<void> {
  const row = await loadBrand(db, ownerId);
  if (!row) return;
  if (row.logoSha256 !== null) await bucket.delete(brandLogoKey(ownerId, row.logoSha256));
  await db.delete(schema.ownerBrands).where(eq(schema.ownerBrands.ownerId, ownerId));
}

/** The brand of a user's personal space for the account export. */
export async function exportedBrand(db: Db, userId: string): Promise<Brand | null> {
  const row = await loadBrand(db, userId);
  return row ? brandView(row) : null;
}
