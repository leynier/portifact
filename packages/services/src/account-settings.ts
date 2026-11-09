// The owner's defaults for new artifacts: read them, change them, and the policy a publish gives
// an artifact it creates (`preparePublish`). The rules are in packages/domain/src/account-settings.ts.
import { type AccountSettings, type AccountSettingsUpdate, isLocale } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  BUILT_IN_SETTINGS,
  changeSettings,
  fail,
  type NewArtifactPolicy,
  newArtifactPolicy,
  ok,
  type Result,
} from "@portifact/domain";
import { eq } from "drizzle-orm";

/** The stored defaults, or the built-in ones without a row. */
export async function loadSettings(db: Db, userId: string): Promise<AccountSettings> {
  const [row] = await db
    .select({
      defaultAccessMode: schema.accountSettings.defaultAccessMode,
      defaultAnnotations: schema.accountSettings.defaultAnnotations,
      defaultCommentVisibility: schema.accountSettings.defaultCommentVisibility,
      defaultBar: schema.accountSettings.defaultBar,
      locale: schema.accountSettings.locale,
    })
    .from(schema.accountSettings)
    .where(eq(schema.accountSettings.userId, userId))
    .limit(1);
  if (!row) return BUILT_IN_SETTINGS;
  // A language that is no longer offered falls back to the browser's, like no choice.
  return { ...row, locale: isLocale(row.locale) ? row.locale : null };
}

async function accountCreatedAt(db: Db, userId: string): Promise<Date | undefined> {
  const [user] = await db
    .select({ createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user?.createdAt;
}

/** The account's defaults, the built-in ones when the owner never changed them. */
export async function getAccountSettings(
  db: Db,
  input: { userId: string },
): Promise<Result<AccountSettings>> {
  if (!(await accountCreatedAt(db, input.userId))) {
    return fail("unauthenticated", "Sign in to see your settings.");
  }
  return ok(await loadSettings(db, input.userId));
}

/**
 * Changes the defaults. Only new artifacts use them, so nothing else changes. Saving the same
 * change twice leaves the same settings.
 */
export async function updateAccountSettings(
  db: Db,
  input: { userId: string; update: AccountSettingsUpdate; now: number },
): Promise<Result<AccountSettings>> {
  const createdAt = await accountCreatedAt(db, input.userId);
  if (!createdAt) return fail("unauthenticated", "Sign in to change your settings.");
  const next = changeSettings(
    await loadSettings(db, input.userId),
    input.update,
    createdAt,
    new Date(input.now),
  );
  if (!next.ok) return next;
  const values = { ...next.value, updatedAt: input.now };
  await db
    .insert(schema.accountSettings)
    .values({ userId: input.userId, ...values })
    .onConflictDoUpdate({ target: schema.accountSettings.userId, set: values });
  return next;
}

/**
 * The policy of an artifact `ownerId` creates now, from their defaults. A public default is
 * checked against the account age again; when it does not pass, the artifact starts private.
 */
export async function newArtifactDefaults(
  db: Db,
  ownerId: string,
  now: number,
): Promise<NewArtifactPolicy> {
  const [settings, createdAt] = await Promise.all([
    loadSettings(db, ownerId),
    accountCreatedAt(db, ownerId),
  ]);
  // Without a user row there is nothing to be eligible with: start from the safe defaults.
  return newArtifactPolicy(
    createdAt ? settings : BUILT_IN_SETTINGS,
    createdAt ?? new Date(now),
    new Date(now),
  );
}
