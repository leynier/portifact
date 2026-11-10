import { env } from "cloudflare:test";
import { LIMITS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { BUILT_IN_SETTINGS } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount, requestAccountDeletion } from "../src/account-data.ts";
import { getAccountSettings, updateAccountSettings } from "../src/account-settings.ts";
import { artifactRow, db, MINUTE, NOW, publishSite, session, user } from "./fixtures.ts";

const OPEN_DEFAULTS = {
  defaultAccessMode: "authenticated",
  defaultAnnotations: "open",
  defaultCommentVisibility: "everyone",
  defaultBar: false,
  expiryNotices: false,
  commentNotices: false,
  locale: null,
} as const;

async function newAccount(): Promise<string> {
  const { id } = await user();
  await db()
    .update(schema.users)
    .set({ createdAt: new Date(NOW - MINUTE) })
    .where(eq(schema.users.id, id));
  return id;
}

async function settingsRow(userId: string) {
  const [row] = await db()
    .select()
    .from(schema.accountSettings)
    .where(eq(schema.accountSettings.userId, userId));
  return row;
}

describe("account settings", () => {
  it("answers the built-in defaults until the owner changes them", async () => {
    const { id } = await user();
    expect(await getAccountSettings(db().global, { userId: id })).toEqual({
      ok: true,
      value: BUILT_IN_SETTINGS,
    });
    expect(await settingsRow(id)).toBeUndefined();
  });

  it("saves a change, keeps what it does not name and is idempotent", async () => {
    const { id } = await user();
    const first = await updateAccountSettings(db().global, {
      userId: id,
      update: { defaultBar: false },
      now: NOW,
    });
    expect(first).toEqual({ ok: true, value: { ...BUILT_IN_SETTINGS, defaultBar: false } });
    const second = await updateAccountSettings(db().global, {
      userId: id,
      update: { defaultAnnotations: "open" },
      now: NOW + 1,
    });
    expect(second).toEqual({
      ok: true,
      value: { ...BUILT_IN_SETTINGS, defaultBar: false, defaultAnnotations: "open" },
    });
    await updateAccountSettings(db().global, {
      userId: id,
      update: { defaultAnnotations: "open" },
      now: NOW + 2,
    });
    expect(await getAccountSettings(db().global, { userId: id })).toEqual(second);
    expect((await settingsRow(id))?.updatedAt).toBe(NOW + 2);
  });

  it("refuses a public default for an account in its first minutes, and allows it after", async () => {
    const id = await newAccount();
    expect(
      await updateAccountSettings(db().global, {
        userId: id,
        update: { defaultAccessMode: "public" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "account_too_new_for_public" });
    expect(await settingsRow(id)).toBeUndefined();
    const later = NOW - MINUTE + LIMITS.publicAccessMinAccountAgeMinutes * MINUTE;
    expect(
      await updateAccountSettings(db().global, {
        userId: id,
        update: { defaultAccessMode: "public" },
        now: later,
      }),
    ).toMatchObject({ ok: true, value: { defaultAccessMode: "public" } });
  });

  it("refuses an account that does not exist", async () => {
    expect(await getAccountSettings(db().global, { userId: "u_missing" })).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
    expect(
      await updateAccountSettings(db().global, {
        userId: "u_missing",
        update: { defaultBar: false },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});

describe("defaults on new artifacts", () => {
  it("gives a new artifact the built-in policy without settings", async () => {
    const { id } = await user();
    const { artifactId } = await publishSite(id);
    expect(await artifactRow(artifactId)).toMatchObject({
      accessMode: "restricted",
      annotations: "off",
      commentVisibility: "owner",
      bar: true,
    });
  });

  it("applies the owner's defaults to an artifact the publish service creates", async () => {
    const { id } = await user();
    await updateAccountSettings(db().global, { userId: id, update: OPEN_DEFAULTS, now: NOW });
    const { artifactId } = await publishSite(id);
    expect(await artifactRow(artifactId)).toMatchObject({
      accessMode: "authenticated",
      annotations: "open",
      commentVisibility: "everyone",
      bar: false,
    });
  });

  it("never changes existing artifacts, also when a new version is published", async () => {
    const { id } = await user();
    const first = await publishSite(id);
    await updateAccountSettings(db().global, {
      userId: id,
      update: { ...OPEN_DEFAULTS, defaultAccessMode: "public" },
      now: NOW,
    });
    expect(await artifactRow(first.artifactId)).toMatchObject({
      accessMode: "restricted",
      annotations: "off",
      bar: true,
    });
    await publishSite(id, { "index.html": "<p>v2</p>" }, NOW + 1, first);
    expect(await artifactRow(first.artifactId)).toMatchObject({
      accessMode: "restricted",
      annotations: "off",
      commentVisibility: "owner",
      bar: true,
    });
  });

  it("starts an artifact private when a stored public default meets an account too new for it", async () => {
    const id = await newAccount();
    // A row written directly, as if the rule had changed after the default was saved.
    await db()
      .insert(schema.accountSettings)
      .values({ userId: id, defaultAccessMode: "public", updatedAt: NOW });
    const { artifactId } = await publishSite(id);
    expect((await artifactRow(artifactId))?.accessMode).toBe("restricted");
    const later = NOW + LIMITS.publicAccessMinAccountAgeMinutes * MINUTE;
    const second = await publishSite(id, undefined, later);
    expect((await artifactRow(second.artifactId))?.accessMode).toBe("public");
  });
});

describe("the account's language", () => {
  it("is saved, kept by later changes and cleared with null", async () => {
    const { id } = await user();
    const saved = await updateAccountSettings(db().global, {
      userId: id,
      update: { locale: "es" },
      now: NOW,
    });
    expect(saved).toEqual({ ok: true, value: { ...BUILT_IN_SETTINGS, locale: "es" } });
    expect((await settingsRow(id))?.locale).toBe("es");
    await updateAccountSettings(db().global, {
      userId: id,
      update: { defaultBar: false },
      now: NOW,
    });
    expect(await getAccountSettings(db().global, { userId: id })).toMatchObject({
      ok: true,
      value: { locale: "es", defaultBar: false },
    });
    await updateAccountSettings(db().global, { userId: id, update: { locale: null }, now: NOW });
    expect((await settingsRow(id))?.locale).toBeNull();
  });

  it("reads a stored language that is no longer offered as no choice", async () => {
    const { id } = await user();
    await db().insert(schema.accountSettings).values({ userId: id, locale: "xx", updatedAt: NOW });
    expect(await getAccountSettings(db().global, { userId: id })).toEqual({
      ok: true,
      value: BUILT_IN_SETTINGS,
    });
  });

  it("never changes the policy of new artifacts", async () => {
    const id = await newAccount();
    await updateAccountSettings(db().global, { userId: id, update: { locale: "es" }, now: NOW });
    const { artifactId } = await publishSite(id);
    expect((await artifactRow(artifactId))?.accessMode).toBe("restricted");
  });
});

describe("settings in the account's data", () => {
  it("are part of the export", async () => {
    const { id } = await user();
    const before = await exportAccount(db(), { userId: id, now: NOW });
    expect(before.ok && before.value.account.settings).toEqual(BUILT_IN_SETTINGS);
    await updateAccountSettings(db().global, { userId: id, update: OPEN_DEFAULTS, now: NOW });
    const after = await exportAccount(db(), { userId: id, now: NOW });
    expect(after.ok && after.value.account.settings).toEqual(OPEN_DEFAULTS);
    await updateAccountSettings(db().global, { userId: id, update: { locale: "es" }, now: NOW });
    const localized = await exportAccount(db(), { userId: id, now: NOW });
    expect(localized.ok && localized.value.account.settings).toEqual({
      ...OPEN_DEFAULTS,
      locale: "es",
    });
  });

  it("go with the account when it is deleted", async () => {
    const { id, email } = await user();
    await updateAccountSettings(db().global, { userId: id, update: OPEN_DEFAULTS, now: NOW });
    const sessionId = await session(id, NOW);
    const deleted = await requestAccountDeletion(regionsFromEnv(env), {
      userId: id,
      sessionId,
      confirmEmail: email,
      now: NOW,
    });
    expect(deleted.ok).toBe(true);
    expect(await settingsRow(id)).toBeUndefined();
  });
});
