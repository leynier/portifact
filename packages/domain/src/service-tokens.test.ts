import { SERVICE_TOKENS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import type { TokenReach } from "./actor.ts";
import {
  checkCommentVisibilityChange,
  checkPublishKeyReach,
  lastUsedDue,
  lastUsedPeriodStart,
  restrictionAllows,
  restrictionColumns,
  restrictionOf,
  seesReaders,
  serviceTokenExpired,
  serviceTokenExpiry,
  storedTokenScopes,
} from "./service-tokens.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 10, 12, 30);
const TOKEN = `st_${"0".repeat(32)}`;

const reach = (
  restriction: TokenReach["restriction"],
  scopes: TokenReach["scopes"] = ["artifacts:read", "artifacts:write"],
): TokenReach => ({
  restriction,
  scopes,
  createdAt: 0,
  label: "CI",
});

describe("expiry", () => {
  it("expires the given number of days after creation", () => {
    expect(serviceTokenExpiry(NOW, 1)).toBe(NOW + DAY);
    expect(serviceTokenExpiry(NOW, 90)).toBe(NOW + 90 * DAY);
  });

  it("is expired from the expiry on, not before", () => {
    expect(serviceTokenExpired(NOW + 1, NOW)).toBe(false);
    expect(serviceTokenExpired(NOW, NOW)).toBe(true);
    expect(serviceTokenExpired(NOW - 1, NOW)).toBe(true);
  });
});

describe("last used", () => {
  it("is written once per hour", () => {
    expect(SERVICE_TOKENS.lastUsedPeriodMs).toBe(HOUR);
    expect(lastUsedPeriodStart(NOW)).toBe(Date.UTC(2026, 10, 10, 12));
    expect(lastUsedPeriodStart(Date.UTC(2026, 10, 10, 12))).toBe(Date.UTC(2026, 10, 10, 12));
  });

  it("is due without a stored time or with one from an earlier hour only", () => {
    expect(lastUsedDue(null, NOW)).toBe(true);
    expect(lastUsedDue(Date.UTC(2026, 10, 10, 11, 59, 59, 999), NOW)).toBe(true);
    expect(lastUsedDue(Date.UTC(2026, 10, 10, 12), NOW)).toBe(false);
    expect(lastUsedDue(NOW - 1, NOW)).toBe(false);
  });
});

describe("restrictions", () => {
  const subject = (createdBy: string | null, externalKey: string | null) => ({
    createdBy,
    externalKey,
  });

  it("reaches everything without one", () => {
    expect(restrictionAllows(TOKEN, { kind: "none" }, subject(null, null))).toBe(true);
    expect(restrictionAllows(TOKEN, { kind: "none" }, subject("u_1", "x"))).toBe(true);
  });

  it("reaches only what the token created with `own`", () => {
    expect(restrictionAllows(TOKEN, { kind: "own" }, subject(TOKEN, null))).toBe(true);
    expect(restrictionAllows(TOKEN, { kind: "own" }, subject("u_1", null))).toBe(false);
    expect(restrictionAllows(TOKEN, { kind: "own" }, subject(null, null))).toBe(false);
  });

  it("reaches only keys under the prefix with `key`", () => {
    const key = { kind: "key", prefix: "pr-" } as const;
    expect(restrictionAllows(TOKEN, key, subject(null, "pr-12"))).toBe(true);
    expect(restrictionAllows(TOKEN, key, subject(null, "pr-"))).toBe(true);
    expect(restrictionAllows(TOKEN, key, subject(TOKEN, "docs/pr-12"))).toBe(false);
    expect(restrictionAllows(TOKEN, key, subject(TOKEN, "PR-12"))).toBe(false);
    expect(restrictionAllows(TOKEN, key, subject(TOKEN, null))).toBe(false);
  });

  it("stores the prefix only for `key`, and reads a broken row as reaching nothing", () => {
    expect(restrictionColumns({ kind: "none" })).toEqual({ restriction: "none", keyPrefix: null });
    expect(restrictionColumns({ kind: "own" })).toEqual({ restriction: "own", keyPrefix: null });
    expect(restrictionColumns({ kind: "key", prefix: "pr-" })).toEqual({
      restriction: "key",
      keyPrefix: "pr-",
    });
    expect(restrictionOf("none", null)).toEqual({ kind: "none" });
    expect(restrictionOf("own", "ignored")).toEqual({ kind: "own" });
    expect(restrictionOf("key", "pr-")).toEqual({ kind: "key", prefix: "pr-" });
    const broken = restrictionOf("key", null);
    expect(restrictionAllows(TOKEN, broken, subject(TOKEN, "pr-1"))).toBe(false);
    expect(restrictionAllows(TOKEN, broken, subject(TOKEN, ""))).toBe(false);
  });
});

describe("publishing with a key", () => {
  it("lets people and unrestricted tokens publish with any key or none", () => {
    expect(checkPublishKeyReach(undefined, undefined)).toEqual({ ok: true, value: undefined });
    expect(checkPublishKeyReach(undefined, "anything").ok).toBe(true);
    expect(checkPublishKeyReach(reach({ kind: "none" }), undefined).ok).toBe(true);
    expect(checkPublishKeyReach(reach({ kind: "own" }), undefined).ok).toBe(true);
  });

  it("makes a token restricted by key publish only under its prefix", () => {
    const keyed = reach({ kind: "key", prefix: "pr-" });
    expect(checkPublishKeyReach(keyed, "pr-7")).toEqual({ ok: true, value: undefined });
    expect(checkPublishKeyReach(keyed, undefined)).toEqual({
      ok: false,
      code: "forbidden",
      message: 'This service token publishes only with a key starting with "pr-".',
    });
    expect(checkPublishKeyReach(keyed, "docs")).toEqual({
      ok: false,
      code: "forbidden",
      message: 'This service token publishes only keys starting with "pr-".',
    });
  });
});

describe("stored scopes", () => {
  it("reads the space-separated scopes and drops what is not a token scope", () => {
    expect(storedTokenScopes("artifacts:read artifacts:write")).toEqual([
      "artifacts:read",
      "artifacts:write",
    ]);
    expect(storedTokenScopes("artifacts:share credentials:manage annotations:write")).toEqual([
      "artifacts:share",
    ]);
    expect(storedTokenScopes("")).toEqual([]);
  });
});

describe("readers and comment visibility", () => {
  const none = { kind: "none" } as const;

  it("shows readers to people and to tokens that may manage them", () => {
    expect(seesReaders(undefined)).toBe(true);
    expect(seesReaders(reach(none, ["artifacts:read", "artifacts:share"]))).toBe(true);
    expect(
      seesReaders(reach(none, ["artifacts:read", "artifacts:write", "artifacts:delete"])),
    ).toBe(false);
  });

  it("lets people change who sees comments and never a token", () => {
    const everyone = { commentVisibility: "everyone" };
    const exception = { readerCommentVisibility: [] };
    expect(checkCommentVisibilityChange(undefined, everyone)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(checkCommentVisibilityChange(undefined, exception).ok).toBe(true);
    const token = reach(none, ["artifacts:share"]);
    expect(checkCommentVisibilityChange(token, {})).toEqual({ ok: true, value: undefined });
    expect(checkCommentVisibilityChange(token, { commentVisibility: undefined }).ok).toBe(true);
    const refused = {
      ok: false,
      code: "forbidden",
      message: "A service token cannot change who sees comments.",
    };
    expect(checkCommentVisibilityChange(token, everyone)).toEqual(refused);
    expect(checkCommentVisibilityChange(token, exception)).toEqual(refused);
  });
});
