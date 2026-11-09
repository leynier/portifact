// The owner's defaults for new artifacts: which access, comments, comment visibility and bar a
// publish gives an artifact it creates. Existing artifacts never change when the defaults do.
// The account's language lives with them; it changes nothing about artifacts.
import type { AccountSettings, AccountSettingsUpdate } from "@portifact/contracts";
import { checkAccessChange } from "./access.ts";
import { ok, type Result } from "./result.ts";

/** What an account starts with: private to the owner, comments off, owner visibility, bar on. */
export const BUILT_IN_SETTINGS: AccountSettings = {
  defaultAccessMode: "restricted",
  defaultAnnotations: "off",
  defaultCommentVisibility: "owner",
  defaultBar: true,
  locale: null,
};

/**
 * Applies a change to the defaults. A public default is checked against the account age like
 * making an artifact public, so a new account cannot get around the rule by saving a default.
 */
export function changeSettings(
  current: AccountSettings,
  update: AccountSettingsUpdate,
  accountCreatedAt: Date,
  now: Date,
): Result<AccountSettings> {
  const next: AccountSettings = {
    defaultAccessMode: update.defaultAccessMode ?? current.defaultAccessMode,
    defaultAnnotations: update.defaultAnnotations ?? current.defaultAnnotations,
    defaultCommentVisibility: update.defaultCommentVisibility ?? current.defaultCommentVisibility,
    defaultBar: update.defaultBar ?? current.defaultBar,
    // null is a choice of its own (follow the browser), so only a missing field keeps the old one.
    locale: update.locale === undefined ? current.locale : update.locale,
  };
  if (next.defaultAccessMode !== current.defaultAccessMode) {
    const allowed = checkAccessChange(next.defaultAccessMode, accountCreatedAt, now);
    if (!allowed.ok) return allowed;
  }
  return ok(next);
}

/** The policy columns of an artifact a publish creates. */
export interface NewArtifactPolicy {
  accessMode: AccountSettings["defaultAccessMode"];
  annotations: AccountSettings["defaultAnnotations"];
  commentVisibility: AccountSettings["defaultCommentVisibility"];
  bar: boolean;
}

/**
 * The policy of a new artifact from the owner's defaults. The public-access rule is applied
 * again at publish time: when the account may not publish in public, the artifact starts with
 * the built-in private mode, never public.
 */
export function newArtifactPolicy(
  settings: AccountSettings,
  accountCreatedAt: Date,
  now: Date,
): NewArtifactPolicy {
  const eligible = checkAccessChange(settings.defaultAccessMode, accountCreatedAt, now).ok;
  return {
    accessMode: eligible ? settings.defaultAccessMode : BUILT_IN_SETTINGS.defaultAccessMode,
    annotations: settings.defaultAnnotations,
    commentVisibility: settings.defaultCommentVisibility,
    bar: settings.defaultBar,
  };
}
