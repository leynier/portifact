import { LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { BUILT_IN_SETTINGS, changeSettings, newArtifactPolicy } from "./account-settings.ts";

const MINUTE = 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00.000Z");
const ageLimit = LIMITS.publicAccessMinAccountAgeMinutes * MINUTE;
const old = new Date(NOW.getTime() - ageLimit);
const fresh = new Date(NOW.getTime() - ageLimit + 1);

describe("BUILT_IN_SETTINGS", () => {
  it("keeps new artifacts private, without comments, owner visibility, the bar and notices on", () => {
    expect(BUILT_IN_SETTINGS).toEqual({
      defaultAccessMode: "restricted",
      defaultAnnotations: "off",
      defaultCommentVisibility: "owner",
      defaultBar: true,
      expiryNotices: true,
    });
  });
});

describe("changeSettings", () => {
  it("changes only what the update names", () => {
    expect(changeSettings(BUILT_IN_SETTINGS, { defaultBar: false }, fresh, NOW)).toEqual({
      ok: true,
      value: { ...BUILT_IN_SETTINGS, defaultBar: false },
    });
    expect(changeSettings(BUILT_IN_SETTINGS, { expiryNotices: false }, fresh, NOW)).toEqual({
      ok: true,
      value: { ...BUILT_IN_SETTINGS, expiryNotices: false },
    });
    const off = { ...BUILT_IN_SETTINGS, expiryNotices: false };
    expect(changeSettings(off, { defaultBar: false }, fresh, NOW)).toMatchObject({
      value: { expiryNotices: false },
    });
    expect(
      changeSettings(
        BUILT_IN_SETTINGS,
        { defaultAnnotations: "open", defaultCommentVisibility: "everyone" },
        fresh,
        NOW,
      ),
    ).toEqual({
      ok: true,
      value: {
        ...BUILT_IN_SETTINGS,
        defaultAnnotations: "open",
        defaultCommentVisibility: "everyone",
      },
    });
  });

  it("refuses a public default while the account is too new, at the exact boundary", () => {
    expect(
      changeSettings(BUILT_IN_SETTINGS, { defaultAccessMode: "public" }, fresh, NOW),
    ).toMatchObject({ ok: false, code: "account_too_new_for_public" });
    expect(changeSettings(BUILT_IN_SETTINGS, { defaultAccessMode: "public" }, old, NOW)).toEqual({
      ok: true,
      value: { ...BUILT_IN_SETTINGS, defaultAccessMode: "public" },
    });
  });

  it("lets a new account narrow or keep an access default", () => {
    const current = { ...BUILT_IN_SETTINGS, defaultAccessMode: "public" as const };
    expect(changeSettings(current, { defaultBar: false }, fresh, NOW)).toMatchObject({ ok: true });
    expect(
      changeSettings(current, { defaultAccessMode: "authenticated" }, fresh, NOW),
    ).toMatchObject({ ok: true, value: { defaultAccessMode: "authenticated" } });
  });
});

describe("newArtifactPolicy", () => {
  it("copies the defaults onto the new artifact", () => {
    expect(
      newArtifactPolicy(
        {
          defaultAccessMode: "authenticated",
          defaultAnnotations: "open",
          defaultCommentVisibility: "everyone",
          defaultBar: false,
          expiryNotices: false,
        },
        fresh,
        NOW,
      ),
    ).toEqual({
      accessMode: "authenticated",
      annotations: "open",
      commentVisibility: "everyone",
      bar: false,
    });
  });

  it("starts the artifact private when a public default meets an account too new for it", () => {
    const settings = { ...BUILT_IN_SETTINGS, defaultAccessMode: "public" as const };
    expect(newArtifactPolicy(settings, fresh, NOW).accessMode).toBe("restricted");
    expect(newArtifactPolicy(settings, old, NOW).accessMode).toBe("public");
  });
});
