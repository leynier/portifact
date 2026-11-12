// The owner's defaults for new artifacts: read them, change them, and the policy a publish gives
// an artifact it creates (`preparePublish`). The same settings hold the expiry notices opt-out and
// the account's language. The rules are in packages/domain/src/account-settings.ts.
import {
  type AccountSettings,
  type AccountSettingsUpdate,
  isLocale,
  isWorkspaceId,
} from "@portifact/contracts";
import { type GlobalDb, schema } from "@portifact/db";
import {
  type Actor,
  accountSettingsUpdateOnlyNarrows,
  BUILT_IN_SETTINGS,
  changeSettings,
  type Entitlements,
  fail,
  hasFeature,
  type NewArtifactPolicy,
  newArtifactPolicy,
  ok,
  policyDefaultAccess,
  type Result,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { actsWithoutCurrentTerms, narrowingOnly } from "./terms.ts";

/** The stored defaults, or the built-in ones without a row. */
export async function loadSettings(db: GlobalDb, userId: string): Promise<AccountSettings> {
  const [row] = await db
    .select({
      defaultAccessMode: schema.accountSettings.defaultAccessMode,
      defaultAnnotations: schema.accountSettings.defaultAnnotations,
      defaultCommentVisibility: schema.accountSettings.defaultCommentVisibility,
      defaultBar: schema.accountSettings.defaultBar,
      expiryNotices: schema.accountSettings.expiryNotices,
      commentNotices: schema.accountSettings.commentNotices,
      locale: schema.accountSettings.locale,
    })
    .from(schema.accountSettings)
    .where(eq(schema.accountSettings.userId, userId))
    .limit(1);
  if (!row) return BUILT_IN_SETTINGS;
  // A language that is no longer offered falls back to the browser's, like no choice.
  return { ...row, locale: isLocale(row.locale) ? row.locale : null };
}

async function accountCreatedAt(db: GlobalDb, userId: string): Promise<Date | undefined> {
  const [user] = await db
    .select({ createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user?.createdAt;
}

/** The account's defaults, the built-in ones when the owner never changed them. */
export async function getAccountSettings(
  db: GlobalDb,
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
  db: GlobalDb,
  input: { userId: string; update: AccountSettingsUpdate; now: number },
): Promise<Result<AccountSettings>> {
  // Someone who declines the current terms can still turn email notices off, and nothing else
  // (docs/legal.md, "Leaving without accepting").
  if (actsWithoutCurrentTerms(db) && !accountSettingsUpdateOnlyNarrows(input.update)) {
    return narrowingOnly();
  }
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
  const s = schema.accountSettings;
  await db.batch([
    db
      .insert(s)
      .values({
        userId: input.userId,
        ...values,
        // A new row only changes the notices from their default when it turns them off.
        commentNoticesChangedAt: values.commentNotices ? null : input.now,
      })
      .onConflictDoUpdate({
        target: s.userId,
        set: {
          ...values,
          // Unsubscribe links issued before a change of the preference stop working
          // (`unsubscribeUsable`), so an old link never undoes turning the notices back on.
          commentNoticesChangedAt: sql`case when ${s.commentNotices} = ${values.commentNotices ? 1 : 0} then ${s.commentNoticesChangedAt} else ${input.now} end`,
        },
      }),
    noticeOptOutMarker(db, input.userId, "comment_notices", values.commentNotices, input.now),
    noticeOptOutMarker(db, input.userId, "expiry_notices", values.expiryNotices, input.now),
  ]);
  return next;
}

/** The email preferences a person can turn off, as the suffix of their `notice_opt_out` tombstone. */
export type NoticePreference = "comment_notices" | "expiry_notices";

/**
 * The `notice_opt_out` tombstone of an email preference (`<user>:<preference>`), in the batch
 * that saves it, so a backup restore cannot turn back on notices the person turned off
 * (docs/operations.md, "Restoring a backup"): written when it is off (keeping the time it was
 * first turned off), deleted when it is on. Pruned after the backup window like the other
 * restore markers (`pruneGroupTombstones`).
 */
export function noticeOptOutMarker(
  db: GlobalDb,
  userId: string,
  preference: NoticePreference,
  on: boolean,
  now: number,
) {
  const t = schema.tombstones;
  const id = `${userId}:${preference}`;
  return on
    ? db.delete(t).where(and(eq(t.kind, "notice_opt_out"), eq(t.id, id)))
    : db.insert(t).values({ kind: "notice_opt_out", id, deletedAt: now }).onConflictDoNothing();
}

/**
 * The policy of an artifact the actor creates now. In the user's personal space it comes from
 * their defaults, and a public default is checked against the account age again (when it does
 * not pass, the artifact starts private). Personal settings never apply in a workspace: a new
 * workspace artifact starts from the built-in defaults.
 */
export async function newArtifactDefaults(
  db: GlobalDb,
  actor: Actor,
  now: number,
  /** The owner's entitlements, which the publish already loaded. */
  owner?: Entitlements,
): Promise<NewArtifactPolicy> {
  if (isWorkspaceId(actor.ownerId)) {
    // A workspace's artifacts start from the built-in defaults, with the access mode its
    // `defaultAccess` policy names, never wider than the workspace can give now (decision 0015);
    // the policy and the verified domain came with the actor.
    return {
      ...newArtifactPolicy(BUILT_IN_SETTINGS, new Date(now), new Date(now)),
      accessMode: policyDefaultAccess(actor.policy, {
        domainVerified: actor.domainVerified !== false,
        workspacesFeature: owner === undefined || hasFeature(owner, "workspaces"),
      }),
    };
  }
  const [settings, createdAt] = await Promise.all([
    loadSettings(db, actor.userId),
    accountCreatedAt(db, actor.userId),
  ]);
  // Without a user row there is nothing to be eligible with: start from the safe defaults.
  return newArtifactPolicy(
    createdAt ? settings : BUILT_IN_SETTINGS,
    createdAt ?? new Date(now),
    new Date(now),
  );
}
