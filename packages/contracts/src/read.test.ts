import { describe, expect, it } from "vitest";
import { OpaqueToken, ReadClaims, ReadTransaction } from "./read.ts";
import { ReviewClaims, ReviewKind, ReviewStart, ReviewTabStart } from "./review.ts";

const token = "A".repeat(42) + "_";
const tag = "abcdefghij-_KLMNOPQRST";

const readClaims = {
  v: 1,
  sid: token,
  aid: "k7d2qm4xab",
  uid: "user_1",
  gen: 1,
  exp: 0,
  sexp: 1_700_000_000_000,
};

const reviewClaims = {
  v: 1,
  sid: token,
  aid: "k7d2qm4xab",
  vid: "ver_1",
  uid: "user_1",
  gen: 2,
  tag,
  exp: 0,
  sexp: 1_700_000_000_000,
};

const reject = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

describe("read session contracts", () => {
  it("takes one-use tokens of exactly 43 base64url characters", () => {
    expect(OpaqueToken.parse(token)).toBe(token);
    expect(OpaqueToken.safeParse("-".repeat(43)).success).toBe(true);
    for (const bad of [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      ` ${"A".repeat(43)}`,
      `${"A".repeat(43)}\n`,
      `x${"A".repeat(43)}`,
      `${"A".repeat(43)}x`,
    ]) {
      reject(OpaqueToken, bad);
    }
    expect(OpaqueToken.safeParse("short").error?.issues[0]?.message).toBe("Invalid token");
  });

  it("accepts read claims as signed and nothing else", () => {
    expect(ReadClaims.parse(readClaims)).toEqual(readClaims);
    expect(ReadClaims.safeParse({ ...readClaims, uid: "u".repeat(64) }).success).toBe(true);
    for (const bad of [
      { v: 2 },
      { sid: "short" },
      { aid: "NOTANID000" },
      { uid: "" },
      { uid: "u".repeat(65) },
      { gen: 0 },
      { gen: 1.5 },
      { exp: -1 },
      { sexp: -1 },
      { extra: true },
    ]) {
      reject(ReadClaims, { ...readClaims, ...bad });
    }
  });

  it("binds a sign-in transaction to a same-origin path of bounded length", () => {
    const tx = { v: 1, aid: "k7d2qm4xab", nonce: token, path: "/docs?a=1", exp: 5 };
    expect(ReadTransaction.parse(tx)).toEqual(tx);
    expect(ReadTransaction.safeParse({ ...tx, path: `/${"p".repeat(2_047)}` }).success).toBe(true);
    for (const bad of [
      { path: "docs/" },
      { path: "https://evil.test/" },
      { path: `/${"p".repeat(2_048)}` },
      { nonce: "x" },
      { exp: -1 },
      { v: 0 },
      { extra: 1 },
    ]) {
      reject(ReadTransaction, { ...tx, ...bad });
    }
  });
});

describe("review session contracts", () => {
  it("redeems a review code in a frame or a tab only", () => {
    expect(ReviewKind.options).toEqual(["frame", "tab"]);
    reject(ReviewKind, "window");
  });

  it("accepts review claims pinned to one version, with a 22-character session tag", () => {
    expect(ReviewClaims.parse(reviewClaims)).toEqual(reviewClaims);
    expect(
      ReviewClaims.safeParse({ ...reviewClaims, vid: "v".repeat(64), uid: "u".repeat(64) }).success,
    ).toBe(true);
    for (const bad of [
      { vid: "" },
      { vid: "v".repeat(65) },
      { uid: "" },
      { uid: "u".repeat(65) },
      { gen: 0 },
      { tag: tag.slice(1) },
      { tag: `${tag}x` },
      { tag: `x${tag}` },
      { tag: `${tag.slice(1)}=` },
      { tag: "!".repeat(22) },
      { sid: "short" },
      { exp: -1 },
      { extra: true },
    ]) {
      reject(ReviewClaims, { ...reviewClaims, ...bad });
    }
  });

  it("starts a review in the viewer's frame with the tag the bridge must echo", () => {
    const start = {
      artifactId: "k7d2qm4xab",
      name: "Plan",
      type: "markdown",
      url: "https://k7d2qm4xab.portifact.dev/__portifact/review?code=x",
      origin: "https://k7d2qm4xab.portifact.dev",
      versionId: "ver_1",
      entrypoint: "index.md",
      sessionTag: tag,
      expiresAt: "2026-11-08T00:01:00.000Z",
    };
    expect(ReviewStart.parse(start)).toEqual(start);
    for (const bad of [
      { sessionTag: tag.slice(1) },
      { sessionTag: `${tag}x` },
      { sessionTag: `x${tag}` },
      { sessionTag: "!".repeat(22) },
      { url: "not a url" },
      { type: "pdf" },
      { expiresAt: "soon" },
    ]) {
      reject(ReviewStart, { ...start, ...bad });
    }
  });

  it("starts a review tab with how long its session lasts", () => {
    const start = {
      artifactId: "k7d2qm4xab",
      url: "https://k7d2qm4xab.portifact.dev/__portifact/review?code=x",
      origin: "https://k7d2qm4xab.portifact.dev",
      versionId: "ver_1",
      expiresAt: "2026-11-08T00:01:00.000Z",
      sessionSeconds: 900,
    };
    expect(ReviewTabStart.parse(start)).toEqual(start);
    for (const bad of [{ sessionSeconds: 0 }, { sessionSeconds: 1.5 }, { origin: "nowhere" }]) {
      reject(ReviewTabStart, { ...start, ...bad });
    }
  });
});
