import { describe, expect, it } from "vitest";
import { TombstoneMarker } from "./jobs.ts";
import {
  CreateShareLinkInput,
  ListShareLinksInput,
  RevokeShareLinkInput,
  SHARE_ENTRY_PATH,
  SHARE_LINKS,
  SHARE_OPEN_LIMITS,
  ShareClaims,
  ShareLinkCreate,
  ShareLinkCreated,
  ShareLinkId,
  ShareLinkLabel,
  ShareLinkList,
  ShareLinkPassword,
  ShareLinkRevoked,
  ShareLinkState,
  ShareLinkView,
  ShareOpenInput,
  ShareOpenResult,
  shareLinkUrl,
} from "./share-links.ts";

const TOKEN = "a".repeat(43);
const LINK = `sl_${"0123456789abcdef".repeat(2)}`;

describe("share link contracts", () => {
  it("keeps the documented caps and lifetimes", () => {
    expect(SHARE_LINKS).toEqual({
      activePerArtifact: 20,
      labelMaxLength: 80,
      passwordMinLength: 8,
      passwordMaxLength: 200,
      maxExpiryDays: 365,
      sessionTtlSeconds: 43_200,
      handoffTtlSeconds: 60,
      passwordIterations: 100_000,
      passwordSaltBytes: 16,
      openBodyMaxBytes: 1024,
    });
    expect(SHARE_OPEN_LIMITS.perIp).toEqual({ max: 60, windowSeconds: 600 });
    expect(SHARE_OPEN_LIMITS.failureWindowSeconds).toBe(900);
  });

  it("puts the token in the fragment of the entry page", () => {
    expect(SHARE_ENTRY_PATH).toBe("/s");
    expect(shareLinkUrl("https://app.portifact.com", TOKEN)).toBe(
      `https://app.portifact.com/s#${TOKEN}`,
    );
  });

  it("accepts only sl_ IDs with 32 lowercase hex characters", () => {
    expect(ShareLinkId.safeParse(LINK).success).toBe(true);
    for (const bad of [
      `sl_${"A".repeat(32)}`,
      `sl_${"0".repeat(31)}`,
      `x${LINK}`,
      `${LINK}0`,
      "u_1",
    ]) {
      expect(ShareLinkId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("trims labels and refuses empty, long and control characters", () => {
    expect(ShareLinkLabel.parse("  Board  ")).toBe("Board");
    expect(ShareLinkLabel.parse("x".repeat(80))).toHaveLength(80);
    for (const bad of ["", "   ", "x".repeat(81), "a\u0000b", "a\nb", "a\u009fb"]) {
      expect(ShareLinkLabel.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ShareLinkLabel.safeParse("").error?.issues[0]?.message).toBe("Give the link a label.");
  });

  it("takes passwords of 8 to 200 characters", () => {
    expect(ShareLinkPassword.safeParse("x".repeat(8)).success).toBe(true);
    expect(ShareLinkPassword.safeParse("x".repeat(200)).success).toBe(true);
    expect(ShareLinkPassword.safeParse("x".repeat(7)).error?.issues[0]?.message).toBe(
      "A password has at least 8 characters.",
    );
    expect(ShareLinkPassword.safeParse("x".repeat(201)).error?.issues[0]?.message).toBe(
      "A password has at most 200 characters.",
    );
  });

  it("refuses unknown fields in what clients send", () => {
    expect(ShareLinkCreate.safeParse({ label: "x", artifactId: "y" }).success).toBe(false);
    expect(ShareLinkCreate.safeParse({ label: "x", expiresAt: "tomorrow" }).success).toBe(false);
    expect(
      ShareLinkCreate.safeParse({ label: "x", expiresAt: "2026-12-01T00:00:00+01:00" }).success,
    ).toBe(true);
    expect(ShareOpenInput.safeParse({ token: TOKEN, linkId: LINK }).success).toBe(false);
    expect(ShareOpenInput.safeParse({ token: "short" }).success).toBe(false);
    expect(ShareOpenInput.safeParse({ token: TOKEN, password: "" }).success).toBe(false);
    expect(ShareOpenInput.safeParse({ token: TOKEN, password: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(
      ShareOpenInput.safeParse({ token: TOKEN, turnstileToken: "x".repeat(2049) }).success,
    ).toBe(false);
    expect(ShareOpenInput.parse({ token: TOKEN, password: "p", turnstileToken: "t" })).toEqual({
      token: TOKEN,
      password: "p",
      turnstileToken: "t",
    });
    expect(CreateShareLinkInput.safeParse({ artifactId: "abcdefghij", label: "x" }).success).toBe(
      true,
    );
  });

  it("seals strict claims bound to an artifact and a link", () => {
    const claims = { v: 1, sid: TOKEN, aid: "abcdefghij", lid: LINK, exp: 1, sexp: 2 };
    expect(ShareClaims.parse(claims)).toEqual(claims);
    expect(ShareClaims.safeParse({ ...claims, uid: "u_1" }).success).toBe(false);
    expect(ShareClaims.safeParse({ ...claims, lid: "x" }).success).toBe(false);
    expect(ShareClaims.safeParse({ ...claims, v: 2 }).success).toBe(false);
  });

  it("lists links with whether the plan has them", () => {
    expect(
      ShareLinkList.safeParse({
        artifactId: "abcdefghij",
        enabled: false,
        links: [],
        activeLimit: 20,
      }).success,
    ).toBe(true);
  });

  it("lets a revoked share link be a tombstone marker", () => {
    expect(TombstoneMarker.safeParse({ kind: "share_link", id: LINK, deletedAt: 1 }).success).toBe(
      true,
    );
  });

  it("describes what the owner sees, never a token", () => {
    const view = {
      id: LINK,
      label: "Board",
      state: "active",
      hasPassword: true,
      createdAt: "2026-11-10T00:00:00.000Z",
      expiresAt: null,
      lastUsedOn: "2026-11-10",
    };
    expect(ShareLinkView.parse(view)).toEqual(view);
    for (const [key, bad] of [
      ["id", "x"],
      ["label", 1],
      ["state", "revoked"],
      ["hasPassword", "yes"],
      ["createdAt", "today"],
      ["expiresAt", "later"],
      ["lastUsedOn", "2026-11-10T00:00:00Z"],
    ] as const) {
      expect(ShareLinkView.safeParse({ ...view, [key]: bad }).success, key).toBe(false);
    }
    expect(ShareLinkCreated.safeParse({ link: view, url: "not a url" }).success).toBe(false);
    expect(
      ShareLinkCreated.safeParse({ link: view, url: `https://a.test/s#${TOKEN}` }).success,
    ).toBe(true);
    expect(ShareLinkRevoked.safeParse({ id: LINK, revoked: false }).success).toBe(false);
    expect(ShareLinkRevoked.safeParse({ id: LINK, revoked: true }).success).toBe(true);
    expect(ShareOpenResult.safeParse({ location: "nowhere" }).success).toBe(false);
    expect(
      ShareLinkList.safeParse({
        artifactId: "abcdefghij",
        enabled: "yes",
        links: [],
        activeLimit: 20,
      }).success,
    ).toBe(false);
    expect(
      ShareLinkList.safeParse({
        artifactId: "abcdefghij",
        enabled: true,
        links: [],
        activeLimit: 0,
      }).success,
    ).toBe(false);
    expect(ShareOpenInput.safeParse({ token: TOKEN, turnstileToken: "" }).success).toBe(false);
    expect(ListShareLinksInput.safeParse({ artifactId: "x" }).success).toBe(false);
    expect(RevokeShareLinkInput.safeParse({ artifactId: "abcdefghij", linkId: "x" }).success).toBe(
      false,
    );
    expect(CreateShareLinkInput.safeParse({ artifactId: "abcdefghij", label: "" }).success).toBe(
      false,
    );
    expect(
      CreateShareLinkInput.safeParse({ artifactId: "abcdefghij", label: "x", password: "short" })
        .success,
    ).toBe(false);
    expect(
      CreateShareLinkInput.safeParse({ artifactId: "abcdefghij", label: "x", expiresAt: "soon" })
        .success,
    ).toBe(false);
  });

  it("explains each refusal and tells agents what each argument means", () => {
    expect(ShareLinkId.safeParse("x").error?.issues[0]?.message).toBe("Invalid share link id");
    expect(ShareLinkLabel.safeParse("x".repeat(81)).error?.issues[0]?.message).toBe(
      "A label has at most 80 characters.",
    );
    expect(ShareLinkLabel.safeParse("a\u0001b").error?.issues[0]?.message).toBe(
      "A label cannot hold control characters.",
    );
    expect(ShareLinkState.options).toEqual(["active", "expired"]);
    expect(
      CreateShareLinkInput.safeParse({
        artifactId: "abcdefghij",
        label: "x",
        expiresAt: "2026-12-01T00:00:00+02:00",
      }).success,
    ).toBe(true);
    const shape = CreateShareLinkInput.shape;
    expect(shape.artifactId.description).toContain("list_artifacts");
    expect(shape.label.description).toContain("only the owner sees");
    expect(shape.expiresAt.description).toContain("365 days");
    expect(shape.password.description).toContain("Only set one the user gave you");
    expect(RevokeShareLinkInput.shape.linkId.description).toContain("list_share_links");
  });
});
