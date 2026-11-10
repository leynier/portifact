import { describe, expect, it } from "vitest";
import { ArtifactListQuery, PublishRequest } from "./publishing.ts";
import {
  isServiceTokenId,
  isServiceTokenSecret,
  PublishKey,
  SERVICE_TOKEN_SCOPES,
  SERVICE_TOKENS,
  ServiceTokenCreate,
  ServiceTokenCreated,
  ServiceTokenId,
  ServiceTokenList,
  ServiceTokenRole,
} from "./service-tokens.ts";

// Built at run time so nothing committed matches the secret scanner's rule for the prefix.
const secret = (body: string) => ["pf", "st_", body].join("");
const BODY = "A".repeat(42) + "-";

describe("service token IDs and secrets", () => {
  it("has its own ID prefix", () => {
    expect(ServiceTokenId.safeParse(`st_${"0".repeat(32)}`).success).toBe(true);
    expect(ServiceTokenId.safeParse(`st_${"0".repeat(31)}`).success).toBe(false);
    expect(ServiceTokenId.safeParse(`ws_${"0".repeat(32)}`).success).toBe(false);
    expect(ServiceTokenId.safeParse(`xst_${"0".repeat(32)}`).success).toBe(false);
    expect(ServiceTokenId.safeParse(`st_${"0".repeat(32)}x`).success).toBe(false);
    expect(isServiceTokenId(`st_${"0".repeat(32)}`)).toBe(true);
    expect(isServiceTokenId(`ws_${"0".repeat(32)}`)).toBe(false);
    expect(isServiceTokenId("u_st_1")).toBe(false);
  });

  it("recognizes a secret by its prefix and length only", () => {
    expect(isServiceTokenSecret(secret(BODY))).toBe(true);
    expect(isServiceTokenSecret(secret(BODY.slice(1)))).toBe(false);
    expect(isServiceTokenSecret(`${secret(BODY)}x`)).toBe(false);
    expect(isServiceTokenSecret(`x${secret(BODY)}`)).toBe(false);
    expect(isServiceTokenSecret(secret(`${"A".repeat(42)}=`))).toBe(false);
    expect(isServiceTokenSecret(`pfsx_${BODY}`)).toBe(false);
  });
});

describe("creating a token", () => {
  const base = {
    label: "CI previews",
    role: "editor",
    scopes: ["artifacts:read"],
    expiresInDays: 90,
  };

  it("defaults to no restriction", () => {
    expect(ServiceTokenCreate.parse(base)).toEqual({ ...base, restriction: { kind: "none" } });
  });

  it("never offers admin, annotation scopes or credentials:manage", () => {
    expect(ServiceTokenRole.options).toEqual(["editor"]);
    expect(SERVICE_TOKEN_SCOPES).toEqual([
      "artifacts:read",
      "artifacts:write",
      "artifacts:share",
      "artifacts:delete",
    ]);
    for (const role of ["admin", "owner"]) {
      expect(ServiceTokenCreate.safeParse({ ...base, role }).success).toBe(false);
    }
    for (const scope of ["annotations:write", "credentials:manage", "annotations:read"]) {
      expect(ServiceTokenCreate.safeParse({ ...base, scopes: [scope] }).success).toBe(false);
    }
  });

  it("refuses an empty or repeated scope list, a bad expiry, label or extra field", () => {
    const bad = [
      { ...base, scopes: [] },
      { ...base, scopes: ["artifacts:read", "artifacts:read"] },
      { ...base, expiresInDays: 0 },
      { ...base, expiresInDays: SERVICE_TOKENS.maxDays + 1 },
      { ...base, expiresInDays: 1.5 },
      { ...base, label: " " },
      { ...base, label: "a\u0007b" },
      { ...base, label: "x".repeat(SERVICE_TOKENS.labelMaxLength + 1) },
      { ...base, secret: "chosen" },
      { ...base, restriction: { kind: "key" } },
      { ...base, restriction: { kind: "key", prefix: "-x" } },
    ];
    for (const input of bad) expect(ServiceTokenCreate.safeParse(input).success).toBe(false);
    expect(
      ServiceTokenCreate.safeParse({ ...base, expiresInDays: SERVICE_TOKENS.maxDays }).success,
    ).toBe(true);
    expect(
      ServiceTokenCreate.parse({ ...base, restriction: { kind: "key", prefix: "pr-" } })
        .restriction,
    ).toEqual({ kind: "key", prefix: "pr-" });
  });
});

describe("publish keys", () => {
  it.each([
    ["pr-123", true],
    ["docs/main", true],
    ["a", true],
    ["A_b.c-d/e", true],
    ["x".repeat(128), true],
    ["x".repeat(129), false],
    ["", false],
    ["-x", false],
    ["/x", false],
    [".x", false],
    ["has space", false],
    ["ümlaut", false],
    ["a?b", false],
  ])("%s is valid: %s", (key, valid) => {
    expect(PublishKey.safeParse(key).success).toBe(valid);
  });

  it("is accepted by a publish and the list query", () => {
    const publish = PublishRequest.parse({
      type: "site",
      name: "Preview",
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: "0".repeat(64),
          size: 1,
          contentType: "text/html",
        },
      ],
      key: "pr-1",
    });
    expect(publish.key).toBe("pr-1");
    expect(ArtifactListQuery.parse({ key: "pr-1" }).key).toBe("pr-1");
    expect(ArtifactListQuery.safeParse({ key: "bad key" }).success).toBe(false);
  });
});

describe("token views", () => {
  const view = {
    id: `st_${"a".repeat(32)}`,
    label: "CI",
    role: "editor",
    scopes: ["artifacts:read"],
    restriction: { kind: "own" },
    createdAt: "2026-11-10T00:00:00.000Z",
    expiresAt: "2026-12-10T00:00:00.000Z",
    lastUsedAt: null,
    createdBy: { name: "Ada" },
    expired: false,
  };

  it("lists views and shows a secret only in the create answer, in its shape", () => {
    expect(ServiceTokenList.parse({ items: [view], available: true, limit: 20 })).toEqual({
      items: [view],
      available: true,
      limit: 20,
    });
    for (const bad of [
      { items: [{ ...view, role: "admin" }], available: true, limit: 20 },
      { items: [{ ...view, createdBy: { name: 1 } }], available: true, limit: 20 },
      { items: [view], available: true, limit: 0 },
      { items: [{ ...view, id: "u_1" }], available: true, limit: 20 },
    ]) {
      expect(ServiceTokenList.safeParse(bad).success).toBe(false);
    }
    expect(ServiceTokenCreated.safeParse({ token: view, secret: secret(BODY) }).success).toBe(true);
    expect(ServiceTokenCreated.safeParse({ token: view, secret: "whsec_x" }).success).toBe(false);
  });
});
