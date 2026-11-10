// Migration 0034 (decision 0006): one artifact per custom host, one row per hostname, several
// owners' claims per name, and only the three states of a proven domain.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);

beforeEach(async () => {
  for (const table of ["custom_domains", "domain_claims", "artifacts"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  for (const id of ["cd2345abcd", "cd2345abce"]) {
    await db().insert(schema.artifacts).values({
      id,
      ownerId: "u_owner",
      type: "site",
      name: "Plan",
      state: "active",
    });
  }
});

const domain = (overrides: Partial<typeof schema.customDomains.$inferInsert> = {}) => ({
  hostname: "docs.example.com",
  ownerId: "u_owner",
  artifactId: "cd2345abcd",
  region: "default" as const,
  state: "provisioning" as const,
  token: "0".repeat(32),
  verifiedAt: NOW,
  checkedAt: NOW,
  ...overrides,
});

describe("custom domain tables", () => {
  it("lets one artifact at most hold a custom host, and many hold none", async () => {
    await env.DB.exec(
      "UPDATE artifacts SET custom_host = 'docs.example.com' WHERE id = 'cd2345abcd'",
    );
    await expect(
      env.DB.exec("UPDATE artifacts SET custom_host = 'docs.example.com' WHERE id = 'cd2345abce'"),
    ).rejects.toThrow(/UNIQUE/);
    await env.DB.exec("UPDATE artifacts SET custom_host = NULL");
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM artifacts WHERE custom_host IS NULL",
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(2);
  });

  it("keeps one row per hostname in one of three states", async () => {
    await db().insert(schema.customDomains).values(domain());
    await expect(
      db()
        .insert(schema.customDomains)
        .values(domain({ ownerId: "u_other" })),
    ).rejects.toThrow();
    await expect(
      db()
        .insert(schema.customDomains)
        .values(domain({ hostname: "x.example.com", state: "pending" as "active" })),
    ).rejects.toThrow();
  });

  it("holds one claim per owner and name, and claims of several owners for one name", async () => {
    const claim = {
      hostname: "docs.example.com",
      artifactId: "cd2345abcd",
      region: "default" as const,
      token: "1".repeat(32),
      expiresAt: NOW,
    };
    await db()
      .insert(schema.domainClaims)
      .values({ ...claim, ownerId: "u_owner" });
    await db()
      .insert(schema.domainClaims)
      .values({ ...claim, ownerId: "u_other" });
    await expect(
      db()
        .insert(schema.domainClaims)
        .values({ ...claim, ownerId: "u_owner" }),
    ).rejects.toThrow();
  });
});
