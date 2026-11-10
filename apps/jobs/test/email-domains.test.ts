// The scheduled re-check of workspace email domains (decision 0010): it runs in the maintenance
// run with the DNS it is given, counts a missing record, removes a domain at the third miss in a
// row, and a failing resolver neither counts nor stops the rest of the run. The fake stands in for
// DNS; without one the re-check is skipped.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { FakeDomains } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;
/** A low-entropy stand-in token, not a credential. */
const TOKEN = "c".repeat(32);
const db = () => regionsFromEnv(env).get("default").db;

async function verifiedDomain(checkedAt: number, failedChecks = 0) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = `u_${crypto.randomUUID()}`;
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values({
      id: admin,
      name: "A",
      email: `${admin}@example.org`,
      emailVerified: true,
      createdAt: at,
      updatedAt: at,
    });
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin, updatedAt: NOW });
  const domainId = `wd_${crypto.randomUUID().replaceAll("-", "")}`;
  const domain = `${id.slice(3, 13)}.com`;
  await db()
    .insert(schema.workspaceDomains)
    .values({
      id: domainId,
      workspaceId: id,
      domain,
      token: TOKEN,
      state: "verified",
      createdAt: NOW - 10 * DAY,
      expiresAt: NOW - 3 * DAY,
      verifiedAt: NOW - 10 * DAY,
      checkedAt,
      failedChecks,
    });
  return { domainId, domain };
}

const row = async (id: string) =>
  (await db().select().from(schema.workspaceDomains).where(eq(schema.workspaceDomains.id, id)))[0];

describe("the email domain re-check", () => {
  it("keeps a domain whose record stands and removes one at its third missed check", async () => {
    const dns = new FakeDomains();
    const kept = await verifiedDomain(NOW - DAY - 1);
    dns.publishTxt(`_portifact-email.${kept.domain}`, `portifact-email-verify=${TOKEN}`);
    const lost = await verifiedDomain(NOW - DAY - 1, 2);
    const result = await runScheduled(env, NOW, null, { relay: false, emailDomains: dns });
    expect(result.emailDomains).toMatchObject({ removed: 1 });
    expect(await row(kept.domainId)).toMatchObject({ failedChecks: 0, checkedAt: NOW });
    expect(await row(lost.domainId)).toBeUndefined();
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, lost.domainId));
    expect(tombstone?.kind).toBe("workspace_domain");
  });

  it("counts nothing when DNS fails, and is skipped without DNS", async () => {
    const dns = new FakeDomains();
    dns.failing.txt = true;
    const domain = await verifiedDomain(NOW - DAY - 1, 2);
    const failing = await runScheduled(env, NOW, null, { relay: false, emailDomains: dns });
    expect(failing.emailDomains).toMatchObject({ unavailable: expect.any(Number), removed: 0 });
    expect(await row(domain.domainId)).toMatchObject({ failedChecks: 2 });
    const skipped = await runScheduled(env, NOW, null, { relay: false });
    expect(skipped.emailDomains).toBe("skipped");
  });
});
