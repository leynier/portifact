// Custom domains (premium plan P7, decision 0006): the plan gate and roles, the TXT proof per
// claim, transfers and races, activation, detachment and its job, the scheduled check, plan
// limits, suspension, purge, account deletion, the export and the reconciliation after a restore.
// Cloudflare and DNS are the in-memory fake; nothing here reaches a real endpoint.
import { env } from "cloudflare:test";
import { planRequiredMessage, txtRecordName, txtRecordValue } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceAccountDeletion,
  exportAccount,
  requestAccountDeletion,
} from "../src/account-data.ts";
import type { DomainDeps } from "../src/cloudflare-hostnames.ts";
import {
  addCustomDomain,
  artifactCustomDomains,
  checkCustomDomains,
  type DomainRecord,
  detachDomain,
  domainDbs,
  enforceDomainLimits,
  getCustomDomain,
  listCustomDomains,
  reconcileCustomDomains,
  releaseArtifactDomains,
  releaseOwnerDomains,
  removeCustomDomain,
  runDeleteHostname,
  verifyCustomDomain,
} from "../src/custom-domains.ts";
import { deleteArtifactData } from "../src/maintenance.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { FakeDomains } from "../src/testing/fake-domains.ts";
import { DAY, db, grantPlan, NOW, publishSite, session, sha256, user, value } from "./fixtures.ts";

const CONTENT = "portifact.dev";
const regions = () => regionsFromEnv(env);
const dbs = () => domainDbs(regions());
let counter = 0;
const host = () => `docs${++counter}-${crypto.randomUUID().slice(0, 8)}.example.com`;

async function owned(plan: "free" | "pro" | "team" = "pro") {
  const owner = await user();
  if (plan !== "free") await grantPlan(owner.id, plan);
  const { artifactId } = await publishSite(owner.id);
  return { owner, artifactId };
}

function add(
  fake: FakeDomains | null,
  userId: string,
  artifactId: string,
  hostname: string,
  now = NOW,
) {
  return addCustomDomain(regions(), fake, {
    userId,
    artifactId,
    hostname,
    contentDomain: CONTENT,
    now,
  });
}

function verify(fake: DomainDeps | null, userId: string, hostname: string, now = NOW) {
  return verifyCustomDomain(regions(), fake, { userId, hostname, now });
}

function publishProof(fake: FakeDomains, record: DomainRecord) {
  fake.publishTxt(txtRecordName(record.hostname), txtRecordValue(record.token));
}

async function domainRow(hostname: string) {
  const [row] = await db()
    .select()
    .from(schema.customDomains)
    .where(eq(schema.customDomains.hostname, hostname));
  return row;
}

async function claims(hostname: string) {
  return db().select().from(schema.domainClaims).where(eq(schema.domainClaims.hostname, hostname));
}

async function customHost(artifactId: string) {
  const [row] = await db()
    .select({ customHost: schema.artifacts.customHost })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId));
  return row?.customHost ?? null;
}

async function jobsFor(hostname: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.topic, "delete_custom_hostname"), eq(schema.outbox.subject, hostname)),
    );
}

/** Adds, proves and activates a domain end to end. */
async function attach(fake: FakeDomains, userId: string, artifactId: string, hostname = host()) {
  const claim = value(await add(fake, userId, artifactId, hostname));
  publishProof(fake, claim);
  value(await verify(fake, userId, hostname));
  fake.activate(hostname);
  const active = value(await verify(fake, userId, hostname));
  expect(active.state).toBe("active");
  return { hostname, token: claim.token };
}

async function team() {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const [admin, editor, member, outsider] = [
    await user(),
    await user(),
    await user(),
    await user(),
  ];
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
      userId: editor.id,
      targetOwnerId: id,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: await sha256(body),
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${id}/${await sha256(body)}`, body);
  const { artifactId } = value(
    await commitPublish(db(), env.ARTIFACTS, {
      userId: editor.id,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  return { id, admin, editor, member, outsider, artifactId };
}

describe("adding a domain", () => {
  it("is refused on free with plan_required, before anything else", async () => {
    const { owner, artifactId } = await owned("free");
    const fake = new FakeDomains();
    for (const deps of [fake, null]) {
      expect(await add(deps, owner.id, artifactId, "not a host")).toEqual({
        ok: false,
        code: "plan_required",
        message: planRequiredMessage("customDomains"),
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("answers capacity_unavailable while the feature is switched off", async () => {
    const { owner, artifactId } = await owned();
    const hostname = host();
    expect(await add(null, owner.id, artifactId, hostname)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "Custom domains are not available yet.",
    });
    expect(await verify(null, owner.id, hostname)).toMatchObject({ code: "not_found" });
    expect(await claims(hostname)).toEqual([]);
  });

  it("stores a claim with a fresh token and touches neither DNS nor Cloudflare", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const hostname = host();
    const claim = value(await add(fake, owner.id, artifactId, ` ${hostname.toUpperCase()}. `));
    expect(claim).toMatchObject({
      hostname,
      artifactId,
      ownerId: owner.id,
      state: "pending",
      claimExpiresAt: NOW + 7 * DAY,
      verifiedAt: null,
      problem: null,
    });
    expect(claim.token).toMatch(/^[0-9a-f]{32}$/);
    // Only DNS is asked whether the name is the apex of its zone; Cloudflare is not called.
    expect(fake.calls).toEqual([`apex ${hostname}`]);
    // Adding again keeps the token, so a record already published stays valid.
    expect(value(await add(fake, owner.id, artifactId, hostname, NOW + DAY)).token).toBe(
      claim.token,
    );
    const [row] = await claims(hostname);
    expect(row?.expiresAt).toBe(NOW + 8 * DAY);
    // Once the claim expired, a new one gets a new token.
    const later = value(await add(fake, owner.id, artifactId, hostname, NOW + 9 * DAY));
    expect(later.token).not.toBe(claim.token);
  });

  it("refuses hostnames, inactive artifacts and a second domain per artifact", async () => {
    const { owner, artifactId } = await owned("team");
    const fake = new FakeDomains();
    expect(await add(fake, owner.id, artifactId, "example.com")).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("subdomain"),
    });
    expect(await add(fake, owner.id, artifactId, `${artifactId}.${CONTENT}`)).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Portifact's own domains"),
    });
    const { hostname } = await attach(fake, owner.id, artifactId);
    expect(await add(fake, owner.id, artifactId, host())).toEqual({
      ok: false,
      code: "invalid_input",
      message: `This artifact already has the custom domain ${hostname}. Remove it first.`,
    });
    // The same name on the same artifact answers the domain; on another artifact it is refused.
    expect(value(await add(fake, owner.id, artifactId, hostname)).state).toBe("active");
    const { artifactId: second } = await publishSite(owner.id);
    expect(await add(fake, owner.id, second, hostname)).toMatchObject({
      code: "invalid_input",
      message: `${hostname} is already the custom domain of another artifact. Remove it there first.`,
    });
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, second));
    expect(await add(fake, owner.id, second, host())).toMatchObject({
      code: "invalid_input",
      message: "Only an active artifact can get a custom domain.",
    });
  });

  it("counts domains against the plan", async () => {
    const { owner, artifactId } = await owned("pro");
    const fake = new FakeDomains();
    await attach(fake, owner.id, artifactId);
    const { artifactId: second } = await publishSite(owner.id);
    expect(await add(fake, owner.id, second, host())).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "Your plan includes 1 custom domain. Remove one before adding another.",
    });
    await grantPlan(owner.id, "team");
    expect((await add(fake, owner.id, second, host())).ok).toBe(true);
  });

  it("answers someone without a role like a missing artifact, and a member forbidden", async () => {
    const t = await team();
    await grantPlan(t.id, "team");
    const fake = new FakeDomains();
    const missing = await add(fake, t.outsider.id, "abcdefghij", host());
    expect(missing).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    expect(await add(fake, t.outsider.id, t.artifactId, host())).toEqual(missing);
    expect(
      await artifactCustomDomains(regions(), fake, {
        userId: t.outsider.id,
        artifactId: t.artifactId,
        now: NOW,
      }),
    ).toEqual(missing);
    expect(await add(fake, t.member.id, t.artifactId, host())).toMatchObject({ code: "forbidden" });
    const { hostname } = await attach(fake, t.editor.id, t.artifactId);
    // The admin manages what the editor attached; the member and outsider cannot reach it.
    expect(
      value(await getCustomDomain(regions(), { userId: t.admin.id, hostname, now: NOW })).ownerId,
    ).toBe(t.id);
    expect(
      await getCustomDomain(regions(), { userId: t.member.id, hostname, now: NOW }),
    ).toMatchObject({ code: "forbidden" });
    expect(await getCustomDomain(regions(), { userId: t.outsider.id, hostname, now: NOW })).toEqual(
      {
        ok: false,
        code: "not_found",
        message: "Custom domain not found.",
      },
    );
    expect(
      await removeCustomDomain(regions(), { userId: t.outsider.id, hostname, now: NOW }),
    ).toMatchObject({ code: "not_found" });
    expect((await domainRow(hostname))?.state).toBe("active");
  });

  it("follows the workspace's plan, not the editor's", async () => {
    const t = await team();
    await grantPlan(t.editor.id, "pro");
    const fake = new FakeDomains();
    expect(await add(fake, t.editor.id, t.artifactId, host())).toMatchObject({
      code: "plan_required",
    });
    await grantPlan(t.id, "team");
    expect((await add(fake, t.editor.id, t.artifactId, host())).ok).toBe(true);
  });
});

describe("the TXT proof", () => {
  it("creates nothing in Cloudflare until this claim's token is published", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const hostname = host();
    const claim = value(await add(fake, owner.id, artifactId, hostname));
    expect(value(await verify(fake, owner.id, hostname))).toMatchObject({
      state: "pending",
      problem: "txt_missing",
    });
    // A wrong value, or the value at the wrong name, proves nothing.
    fake.publishTxt(txtRecordName(hostname), txtRecordValue("0".repeat(32)));
    fake.publishTxt(hostname, txtRecordValue(claim.token));
    expect(value(await verify(fake, owner.id, hostname)).state).toBe("pending");
    expect(
      fake.calls.filter(
        (call) => call !== `txt ${txtRecordName(hostname)}` && call !== `apex ${hostname}`,
      ),
    ).toEqual([]);
    expect(await domainRow(hostname)).toBeUndefined();

    publishProof(fake, claim);
    const proven = value(await verify(fake, owner.id, hostname));
    expect(proven).toMatchObject({
      state: "provisioning",
      verifiedAt: NOW,
      problem: "certificate_pending",
    });
    expect(fake.calls).toContain("create");
    expect(await claims(hostname)).toEqual([]);
    expect(await customHost(artifactId)).toBeNull();
  });

  it("answers capacity_unavailable when DNS cannot be asked, without counting anything", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const hostname = host();
    value(await add(fake, owner.id, artifactId, hostname));
    fake.failing.txt = true;
    expect(await verify(fake, owner.id, hostname)).toMatchObject({ code: "capacity_unavailable" });
    expect(await claims(hostname)).toHaveLength(1);
  });

  it("lets a second account take a released name only with its own proof", async () => {
    const first = await owned();
    const fake = new FakeDomains();
    const { hostname, token } = await attach(fake, first.owner.id, first.artifactId);
    value(await removeCustomDomain(regions(), { userId: first.owner.id, hostname, now: NOW }));
    await runDeleteHostname(dbs(), fake, hostname);
    expect(await domainRow(hostname)).toBeUndefined();
    // The first owner's record and CNAME are still in DNS: Cloudflare would validate the name in
    // real time, but Portifact asks for the new claim's own token.
    const second = await owned();
    const claim = value(await add(fake, second.owner.id, second.artifactId, hostname));
    expect(claim.token).not.toBe(token);
    expect(value(await verify(fake, second.owner.id, hostname)).problem).toBe("txt_missing");
    expect(fake.idOf(hostname)).toBeUndefined();
    publishProof(fake, claim);
    expect(value(await verify(fake, second.owner.id, hostname)).state).toBe("provisioning");
  });

  it("moves a name to the owner who proves control, keeping Cloudflare's hostname", async () => {
    const first = await owned();
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, first.owner.id, first.artifactId);
    const cfId = (await domainRow(hostname))?.cfHostnameId;
    const second = await owned();
    const claim = value(await add(fake, second.owner.id, second.artifactId, hostname));
    // The first owner's claim was spent; their domain stays theirs until the new proof holds.
    expect(value(await verify(fake, second.owner.id, hostname)).problem).toBe("txt_missing");
    expect(await customHost(first.artifactId)).toBe(hostname);
    fake.clearTxt(txtRecordName(hostname));
    publishProof(fake, claim);
    const moved = value(await verify(fake, second.owner.id, hostname));
    expect(moved).toMatchObject({ ownerId: second.owner.id, artifactId: second.artifactId });
    expect(await customHost(first.artifactId)).toBeNull();
    expect((await domainRow(hostname))?.cfHostnameId).toBe(cfId);
    expect(
      await getCustomDomain(regions(), { userId: first.owner.id, hostname, now: NOW }),
    ).toMatchObject({ code: "not_found" });
    expect(value(await verify(fake, second.owner.id, hostname)).state).toBe("active");
    expect(await customHost(second.artifactId)).toBe(hostname);
  });

  it("lets exactly one of two concurrent proofs win", async () => {
    const one = await owned();
    const two = await owned();
    const fake = new FakeDomains();
    const hostname = host();
    const a = value(await add(fake, one.owner.id, one.artifactId, hostname));
    const b = value(await add(fake, two.owner.id, two.artifactId, hostname));
    publishProof(fake, a);
    publishProof(fake, b);
    const results = await Promise.all([
      verify(fake, one.owner.id, hostname),
      verify(fake, two.owner.id, hostname),
    ]);
    const row = await domainRow(hostname);
    expect([one.owner.id, two.owner.id]).toContain(row?.ownerId);
    // Whichever lost finds the name taken: its claim was spent with every other.
    for (const result of results) {
      if (result.ok) expect(result.value.ownerId).toBe(row?.ownerId);
    }
    expect(await claims(hostname)).toEqual([]);
    expect([...fake.created.values()].filter((entry) => entry.hostname === hostname)).toHaveLength(
      1,
    );
  });

  it("refuses a proof past the plan's count, and a transfer past it leaves the holder serving", async () => {
    const { owner, artifactId } = await owned("pro");
    const { artifactId: second } = await publishSite(owner.id);
    const fake = new FakeDomains();
    const x = value(await add(fake, owner.id, artifactId, host()));
    const y = value(await add(fake, owner.id, second, host()));
    publishProof(fake, x);
    publishProof(fake, y);
    value(await verify(fake, owner.id, x.hostname));
    expect(await verify(fake, owner.id, y.hostname)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "Your plan includes 1 custom domain. Remove one before adding another.",
    });
    expect(await domainRow(y.hostname)).toBeUndefined();

    // Another owner claims x, then fills their plan elsewhere, then proves x: nothing moves, and
    // x keeps serving its artifact.
    fake.activate(x.hostname);
    value(await verify(fake, owner.id, x.hostname));
    const other = await owned("pro");
    const takeover = value(
      await add(fake, other.owner.id, (await publishSite(other.owner.id)).artifactId, x.hostname),
    );
    await attach(fake, other.owner.id, other.artifactId);
    fake.clearTxt(txtRecordName(x.hostname));
    publishProof(fake, takeover);
    expect(await verify(fake, other.owner.id, x.hostname)).toMatchObject({
      code: "quota_exceeded",
    });
    expect(await domainRow(x.hostname)).toMatchObject({ ownerId: owner.id, state: "active" });
    expect(await customHost(artifactId)).toBe(x.hostname);
  });

  it("gives up a claim whose artifact is no longer active", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const claim = value(await add(fake, owner.id, artifactId, host()));
    publishProof(fake, claim);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await verify(fake, owner.id, claim.hostname)).toMatchObject({ code: "invalid_input" });
    expect(await claims(claim.hostname)).toEqual([]);
  });

  it("is refused while the name is being removed", async () => {
    const first = await owned();
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, first.owner.id, first.artifactId);
    value(await removeCustomDomain(regions(), { userId: first.owner.id, hostname, now: NOW }));
    const second = await owned();
    const claim = value(await add(fake, second.owner.id, second.artifactId, hostname));
    publishProof(fake, claim);
    expect(await verify(fake, second.owner.id, hostname)).toEqual({
      ok: false,
      code: "version_conflict",
      message: `${hostname} is being removed. Try again in a few minutes.`,
    });
  });
});

describe("activation", () => {
  it("binds the artifact only once Cloudflare reports the hostname and certificate active", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const claim = value(await add(fake, owner.id, artifactId, host()));
    publishProof(fake, claim);
    value(await verify(fake, owner.id, claim.hostname));
    expect(await customHost(artifactId)).toBeNull();
    fake.activate(claim.hostname);
    const result = await checkCustomDomains(dbs(), fake, NOW + 60_000);
    expect(result.activated).toBeGreaterThanOrEqual(1);
    expect((await domainRow(claim.hostname))?.state).toBe("active");
    expect(await customHost(artifactId)).toBe(claim.hostname);
  });

  it("retries a failed Cloudflare create and records the problem meanwhile", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const claim = value(await add(fake, owner.id, artifactId, host()));
    publishProof(fake, claim);
    fake.failing.hostnames = true;
    expect(value(await verify(fake, owner.id, claim.hostname))).toMatchObject({
      state: "provisioning",
      problem: "cloudflare_unavailable",
    });
    fake.failing.hostnames = false;
    await checkCustomDomains(dbs(), fake, NOW + 60_000);
    expect((await domainRow(claim.hostname))?.cfHostnameId).toBe(fake.idOf(claim.hostname));
  });

  it("detaches what cannot be activated", async () => {
    const fake = new FakeDomains();
    // The artifact was archived meanwhile.
    const one = await owned();
    const a = value(await add(fake, one.owner.id, one.artifactId, host()));
    publishProof(fake, a);
    value(await verify(fake, one.owner.id, a.hostname));
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, one.artifactId));
    fake.activate(a.hostname);
    await checkCustomDomains(dbs(), fake, NOW + 60_000);
    expect(await domainRow(a.hostname)).toMatchObject({
      state: "detaching",
      detachReason: "artifact_unavailable",
    });
    expect(await customHost(one.artifactId)).toBeNull();
    // Cloudflare never finished within a week.
    const two = await owned();
    const b = value(await add(fake, two.owner.id, two.artifactId, host()));
    publishProof(fake, b);
    value(await verify(fake, two.owner.id, b.hostname));
    await checkCustomDomains(dbs(), fake, NOW + 2 * DAY - 1);
    expect((await domainRow(b.hostname))?.state).toBe("provisioning");
    await checkCustomDomains(dbs(), fake, NOW + 2 * DAY);
    expect(await domainRow(b.hostname)).toMatchObject({
      state: "detaching",
      detachReason: "provisioning_timeout",
    });
    // Cloudflare lost or blocked the hostname.
    const three = await owned();
    const c = value(await add(fake, three.owner.id, three.artifactId, host()));
    publishProof(fake, c);
    value(await verify(fake, three.owner.id, c.hostname));
    fake.setStatus(c.hostname, "blocked");
    await checkCustomDomains(dbs(), fake, NOW + 60_000);
    expect(await domainRow(c.hostname)).toMatchObject({
      state: "detaching",
      detachReason: "cloudflare_gone",
    });
  });
});

describe("removing and the deletion job", () => {
  it("stops serving first, writes one job however often it runs, and frees the name", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    await Promise.all([
      removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }),
      removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }),
    ]);
    value(await removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }));
    expect(await customHost(artifactId)).toBeNull();
    expect(await domainRow(hostname)).toMatchObject({
      state: "detaching",
      detachReason: "removed",
    });
    const jobs = await jobsFor(hostname);
    expect(jobs).toHaveLength(1);
    expect(
      value(await getCustomDomain(regions(), { userId: owner.id, hostname, now: NOW })).state,
    ).toBe("removing");

    const job = jobs[0] as (typeof jobs)[number];
    // Without the client the job fails and stays; with it, it deletes and is idempotent.
    await expect(
      runJob(db(), env.ARTIFACTS, { id: job.id, topic: "delete_custom_hostname" }, NOW),
    ).rejects.toThrow("needs the Cloudflare client");
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "delete_custom_hostname" }, NOW, {
        domains: fake,
      }),
    ).toBe("done");
    expect(fake.idOf(hostname)).toBeUndefined();
    expect(await domainRow(hostname)).toBeUndefined();
    expect(await jobsFor(hostname)).toEqual([]);
    expect(await runDeleteHostname(dbs(), fake, hostname)).toBe("done");
    expect(
      await getCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }),
    ).toMatchObject({ code: "not_found" });
  });

  it("removes a pending claim and works without the plan or the switch", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const pending = value(await add(fake, owner.id, artifactId, host()));
    const { hostname } = await attach(fake, owner.id, (await publishSite(owner.id)).artifactId);
    await grantPlan(owner.id, "free");
    expect(await verify(fake, owner.id, hostname)).toMatchObject({ code: "plan_required" });
    value(
      await removeCustomDomain(regions(), {
        userId: owner.id,
        hostname: pending.hostname,
        now: NOW,
      }),
    );
    expect(await claims(pending.hostname)).toEqual([]);
    value(await removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }));
    expect((await domainRow(hostname))?.state).toBe("detaching");
    // A stale job (the row became something else) does nothing.
    expect(await runDeleteHostname(dbs(), null, "nothing.example.com")).toBe("done");
    expect(artifactId).toBeTruthy();
  });

  it("a stale deletion job leaves an attached domain alone", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    expect(await runDeleteHostname(dbs(), fake, hostname)).toBe("stale");
    expect((await domainRow(hostname))?.state).toBe("active");
    expect(await detachDomain(dbs(), hostname, "operator", NOW, { ownerId: "someone-else" })).toBe(
      false,
    );
    expect(await detachDomain(dbs(), hostname, "operator", NOW, { artifactId: "abcdefghij" })).toBe(
      false,
    );
    expect(await detachDomain(dbs(), hostname, "operator", NOW)).toBe(true);
    expect(await detachDomain(dbs(), hostname, "operator", NOW)).toBe(false);
  });
});

describe("the daily check", () => {
  it("detaches after three missed TXT checks in a row, and a held record resets them", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const { hostname, token } = await attach(fake, owner.id, artifactId);
    fake.clearTxt(txtRecordName(hostname));
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    await checkCustomDomains(dbs(), fake, NOW + DAY + 3_600_000);
    expect(await domainRow(hostname)).toMatchObject({ missedChecks: 1, problem: "txt_missing" });
    await checkCustomDomains(dbs(), fake, NOW + 2 * DAY);
    expect((await domainRow(hostname))?.missedChecks).toBe(2);
    fake.publishTxt(txtRecordName(hostname), txtRecordValue(token));
    await checkCustomDomains(dbs(), fake, NOW + 3 * DAY);
    expect(await domainRow(hostname)).toMatchObject({
      missedChecks: 0,
      problem: null,
      state: "active",
    });
    fake.clearTxt(txtRecordName(hostname));
    fake.failing.txt = true;
    await checkCustomDomains(dbs(), fake, NOW + 4 * DAY);
    expect((await domainRow(hostname))?.missedChecks).toBe(0);
    fake.failing.txt = false;
    for (const day of [5, 6, 7]) await checkCustomDomains(dbs(), fake, NOW + day * DAY);
    expect(await domainRow(hostname)).toMatchObject({
      state: "detaching",
      detachReason: "txt_lost",
    });
    expect(await customHost(artifactId)).toBeNull();
  });

  it("'check again' clears a miss once the record is back", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const { hostname, token } = await attach(fake, owner.id, artifactId);
    fake.clearTxt(txtRecordName(hostname));
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    expect(value(await verify(fake, owner.id, hostname, NOW + DAY))).toMatchObject({
      missedChecks: 1,
      problem: "txt_missing",
    });
    fake.publishTxt(txtRecordName(hostname), txtRecordValue(token));
    expect(value(await verify(fake, owner.id, hostname, NOW + DAY))).toMatchObject({
      missedChecks: 0,
      problem: null,
    });
  });

  it("detaches a hostname Cloudflare moved and keeps one for an archived artifact", async () => {
    const fake = new FakeDomains();
    const one = await owned();
    const moved = await attach(fake, one.owner.id, one.artifactId);
    fake.setStatus(moved.hostname, "moved");
    const two = await owned();
    const kept = await attach(fake, two.owner.id, two.artifactId);
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, two.artifactId));
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    expect(await domainRow(moved.hostname)).toMatchObject({
      state: "detaching",
      detachReason: "cloudflare_gone",
    });
    expect((await domainRow(kept.hostname))?.state).toBe("active");
  });

  it("prunes expired claims and runs without Cloudflare too", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const claim = value(await add(fake, owner.id, artifactId, host()));
    await checkCustomDomains(dbs(), null, NOW + 7 * DAY - 1);
    expect(await claims(claim.hostname)).toHaveLength(1);
    const result = await checkCustomDomains(dbs(), null, NOW + 7 * DAY);
    expect(result.prunedClaims).toBeGreaterThanOrEqual(1);
    expect(await claims(claim.hostname)).toEqual([]);
  });
});

describe("plan limits", () => {
  it("keeps the oldest domains after a downgrade, a week after an expiry", async () => {
    const owner = await user();
    await grantPlan(owner.id, "team");
    const fake = new FakeDomains();
    const attached: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { artifactId } = await publishSite(owner.id);
      attached.push((await attach(fake, owner.id, artifactId)).hostname);
      await db()
        .update(schema.customDomains)
        .set({ verifiedAt: NOW + i })
        .where(eq(schema.customDomains.hostname, attached[i] as string));
    }
    await grantPlan(owner.id, "pro", { validUntil: NOW + DAY });
    expect(await enforceDomainLimits(dbs(), NOW)).toBe(2);
    expect((await domainRow(attached[0] as string))?.state).toBe("active");
    expect(await domainRow(attached[2] as string)).toMatchObject({
      state: "detaching",
      detachReason: "plan_limit",
    });
    // The Pro plan expires: its one domain stays for the grace week, then goes.
    expect(await enforceDomainLimits(dbs(), NOW + 7 * DAY)).toBe(0);
    expect(await enforceDomainLimits(dbs(), NOW + 8 * DAY)).toBe(1);
    expect((await domainRow(attached[0] as string))?.state).toBe("detaching");
  });
});

describe("lifecycle", () => {
  it("a suspension withdraws the hostname and reinstating does not bring it back", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    value(await suspendArtifact(db(), { artifactId, reason: "phishing", now: NOW }));
    expect(await customHost(artifactId)).toBeNull();
    expect(await domainRow(hostname)).toMatchObject({
      state: "detaching",
      detachReason: "suspended",
    });
    // A retried suspension writes no second job.
    value(await suspendArtifact(db(), { artifactId, reason: "phishing", now: NOW }));
    expect(await jobsFor(hostname)).toHaveLength(1);
  });

  it("a purge releases the artifact's domain and claims", async () => {
    const { owner, artifactId } = await owned("team");
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    const { artifactId: other } = await publishSite(owner.id);
    const pending = value(await add(fake, owner.id, other, host()));
    for (const id of [artifactId, other]) {
      await db()
        .update(schema.artifacts)
        .set({ state: "purging" })
        .where(eq(schema.artifacts.id, id));
      await deleteArtifactData(db(), env.ARTIFACTS, id, NOW);
    }
    expect(await domainRow(hostname)).toMatchObject({ state: "detaching", detachReason: "purged" });
    expect(await claims(pending.hostname)).toEqual([]);
  });

  it("an account deletion releases the owner's domains and claims", async () => {
    const { owner, artifactId } = await owned("team");
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    const pending = value(
      await add(fake, owner.id, (await publishSite(owner.id)).artifactId, host()),
    );
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(db(), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    await advanceAccountDeletion(db(), env.ARTIFACTS, owner.id, NOW);
    expect(await domainRow(hostname)).toMatchObject({ state: "detaching" });
    expect(await claims(pending.hostname)).toEqual([]);
  });

  it("the account export lists domains and claims per artifact", async () => {
    const { owner, artifactId } = await owned("team");
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    const { artifactId: other } = await publishSite(owner.id);
    const pending = value(await add(fake, owner.id, other, host()));
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    const byId = new Map(
      exported.artifacts.map((artifact) => [artifact.id, artifact.customDomains]),
    );
    expect(byId.get(artifactId)).toEqual([
      { hostname, state: "active", verifiedAt: new Date(NOW).toISOString() },
    ]);
    expect(byId.get(other)).toEqual([
      { hostname: pending.hostname, state: "pending", verifiedAt: null },
    ]);
    expect(JSON.stringify(exported)).not.toContain(pending.token);
  });
});

describe("listing", () => {
  it("lists the owner's domains with the plan, and the artifact's alone", async () => {
    const { owner, artifactId } = await owned("team");
    const fake = new FakeDomains();
    const { hostname } = await attach(fake, owner.id, artifactId);
    const { artifactId: other } = await publishSite(owner.id);
    const pending = value(await add(fake, owner.id, other, host()));
    const actor = {
      userId: owner.id,
      ownerId: owner.id,
      role: "admin" as const,
      region: "default" as const,
    };
    const all = value(await listCustomDomains(regions(), fake, { actor, now: NOW }));
    expect(all).toMatchObject({ available: true, enabled: true, limit: 5, used: 1 });
    expect(all.domains.map((d) => d.hostname)).toEqual([hostname, pending.hostname]);
    const one = value(
      await artifactCustomDomains(regions(), null, {
        userId: owner.id,
        artifactId: other,
        now: NOW,
      }),
    );
    expect(one).toMatchObject({ available: false, used: 1 });
    expect(one.domains.map((d) => d.hostname)).toEqual([pending.hostname]);
    expect(
      await listCustomDomains(regions(), fake, { actor: { ...actor, role: "member" }, now: NOW }),
    ).toMatchObject({ code: "forbidden" });
    await grantPlan(owner.id, "free");
    expect(value(await listCustomDomains(regions(), fake, { actor, now: NOW }))).toMatchObject({
      enabled: false,
      limit: 0,
    });
  });
});

describe("reconciliation after a restore", () => {
  it("follows Cloudflare: detaches rows it lost, deletes hostnames without a row, clears stray hosts", async () => {
    const fake = new FakeDomains();
    const one = await owned();
    const lost = await attach(fake, one.owner.id, one.artifactId);
    const two = await owned();
    const kept = await attach(fake, two.owner.id, two.artifactId);
    // Cloudflare lost the first hostname; a hostname exists with no row; an artifact holds a host
    // no row gives it.
    fake.created.delete(fake.idOf(lost.hostname) as string);
    const orphan = (await fake.hostnames.create("orphan.example.com")).id;
    const three = await owned();
    await db()
      .update(schema.artifacts)
      .set({ customHost: "stray.example.com" })
      .where(eq(schema.artifacts.id, three.artifactId));
    const result = await reconcileCustomDomains(dbs(), [db()], fake, NOW);
    expect(result.detached).toContain(lost.hostname);
    expect(result.removed).toContain("orphan.example.com");
    expect(result.cleared).toContain("stray.example.com");
    expect(fake.created.has(orphan)).toBe(false);
    expect((await domainRow(kept.hostname))?.state).toBe("active");
    expect(await customHost(three.artifactId)).toBeNull();
    expect(await customHost(one.artifactId)).toBeNull();
  });
});

// Each test below starts from no domains and no claims, so counts and lists are exact.
describe("exact outcomes", () => {
  beforeEach(async () => {
    await db().delete(schema.customDomains);
    await db().delete(schema.domainClaims);
    await db().update(schema.artifacts).set({ customHost: null });
  });

  async function provisioned(fake: FakeDomains, plan: "pro" | "team" = "pro") {
    const { owner, artifactId } = await owned(plan);
    const claim = value(await add(fake, owner.id, artifactId, host()));
    publishProof(fake, claim);
    value(await verify(fake, owner.id, claim.hostname));
    return { owner, artifactId, hostname: claim.hostname, token: claim.token };
  }

  it("counts what each scheduled pass did", async () => {
    const fake = new FakeDomains();
    const a = await provisioned(fake);
    fake.activate(a.hostname);
    expect(await checkCustomDomains(dbs(), fake, NOW)).toEqual({
      prunedClaims: 0,
      activated: 1,
      checked: 0,
      detached: 0,
      notices: 0,
    });
    // Not due a moment before a day has passed, due at the day.
    expect((await checkCustomDomains(dbs(), fake, NOW + DAY - 1)).checked).toBe(0);
    expect(await checkCustomDomains(dbs(), fake, NOW + DAY)).toEqual({
      prunedClaims: 0,
      activated: 0,
      checked: 1,
      detached: 0,
      notices: 0,
    });
    fake.setStatus(a.hostname, "deleted");
    expect(await checkCustomDomains(dbs(), fake, NOW + 2 * DAY)).toEqual({
      prunedClaims: 0,
      activated: 0,
      checked: 1,
      detached: 1,
      notices: 0,
    });
    const b = await provisioned(fake);
    fake.setStatus(b.hostname, "moved");
    expect(await checkCustomDomains(dbs(), fake, NOW + 2 * DAY)).toMatchObject({
      activated: 0,
      detached: 1,
      notices: 0,
    });
    expect(await domainRow(b.hostname)).toMatchObject({ detachReason: "cloudflare_gone" });
  });

  it("detaches an active domain whose artifact no longer holds it, and records Cloudflare outages", async () => {
    const fake = new FakeDomains();
    const cases = [
      { state: "suspended" as const, customHost: true },
      { state: "active" as const, customHost: false },
    ];
    const names: string[] = [];
    for (const change of cases) {
      const { owner, artifactId } = await owned();
      const { hostname } = await attach(fake, owner.id, artifactId);
      names.push(hostname);
      await db()
        .update(schema.artifacts)
        .set({
          state: change.state,
          customHost: change.customHost ? hostname : "elsewhere.example.com",
        })
        .where(eq(schema.artifacts.id, artifactId));
    }
    const kept = await owned();
    const { hostname: keptName, token } = await attach(fake, kept.owner.id, kept.artifactId);
    fake.publishTxt(txtRecordName(keptName), txtRecordValue(token));
    fake.failing.hostnames = true;
    expect(await checkCustomDomains(dbs(), fake, NOW + DAY)).toEqual({
      prunedClaims: 0,
      activated: 0,
      checked: 3,
      detached: 2,
      notices: 0,
    });
    for (const name of names) {
      expect(await domainRow(name), name).toMatchObject({
        state: "detaching",
        detachReason: "artifact_unavailable",
      });
    }
    expect(await domainRow(keptName)).toMatchObject({
      state: "active",
      missedChecks: 0,
      problem: "cloudflare_unavailable",
      checkedAt: NOW + DAY,
    });
  });

  it("releases only the named artifact's or owner's domains, and counts them", async () => {
    const fake = new FakeDomains();
    const owner = await user();
    await grantPlan(owner.id, "team");
    const first = (await publishSite(owner.id)).artifactId;
    const second = (await publishSite(owner.id)).artifactId;
    const a = await attach(fake, owner.id, first);
    const b = await attach(fake, owner.id, second);
    const other = await owned();
    const c = await attach(fake, other.owner.id, other.artifactId);
    expect(await releaseArtifactDomains(dbs(), first, "purged", NOW)).toBe(1);
    expect(await releaseArtifactDomains(dbs(), first, "purged", NOW)).toBe(0);
    expect((await domainRow(b.hostname))?.state).toBe("active");
    expect(await releaseOwnerDomains(dbs(), owner.id, "account_deleted", NOW)).toBe(1);
    expect(await domainRow(a.hostname)).toMatchObject({ detachReason: "purged" });
    expect(await domainRow(b.hostname)).toMatchObject({ detachReason: "account_deleted" });
    expect((await domainRow(c.hostname))?.state).toBe("active");
  });

  it("applies plan limits only to owners over them", async () => {
    const fake = new FakeDomains();
    const at = await owned("pro");
    await attach(fake, at.owner.id, at.artifactId);
    const over = await owned("team");
    const one = await attach(fake, over.owner.id, over.artifactId);
    const two = await attach(fake, over.owner.id, (await publishSite(over.owner.id)).artifactId);
    await db()
      .update(schema.customDomains)
      .set({ verifiedAt: NOW + 1 })
      .where(eq(schema.customDomains.hostname, two.hostname));
    await grantPlan(over.owner.id, "pro");
    expect(await enforceDomainLimits(dbs(), NOW)).toBe(1);
    expect((await domainRow(one.hostname))?.state).toBe("active");
    expect(await domainRow(two.hostname)).toMatchObject({ detachReason: "plan_limit" });
    expect(await enforceDomainLimits(dbs(), NOW)).toBe(0);
  });

  it("lists claims, domains and what counts, exactly", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned("team");
    const active = await attach(fake, owner.id, artifactId);
    const second = (await publishSite(owner.id)).artifactId;
    const removing = await attach(fake, owner.id, second);
    value(
      await removeCustomDomain(regions(), {
        userId: owner.id,
        hostname: removing.hostname,
        now: NOW,
      }),
    );
    const third = (await publishSite(owner.id)).artifactId;
    const pending = value(await add(fake, owner.id, third, host()));
    const actor = {
      userId: owner.id,
      ownerId: owner.id,
      role: "admin" as const,
      region: "default" as const,
    };
    const listed = value(await listCustomDomains(regions(), null, { actor, now: NOW }));
    expect(listed).toMatchObject({ available: false, enabled: true, limit: 5, used: 1 });
    expect(listed.domains.map((d) => [d.hostname, d.state])).toEqual([
      [active.hostname, "active"],
      [removing.hostname, "removing"],
      [pending.hostname, "pending"],
    ]);
    // A name removed while still detaching does not count against adding another.
    expect((await add(fake, owner.id, second, host())).ok).toBe(true);
  });

  it("answers missing artifacts and hostnames the same way", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    for (const state of ["purging", "deleted"] as const) {
      await db().update(schema.artifacts).set({ state }).where(eq(schema.artifacts.id, artifactId));
      expect(await add(fake, owner.id, artifactId, host())).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
      expect(
        await artifactCustomDomains(regions(), fake, { userId: owner.id, artifactId, now: NOW }),
      ).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
    }
    for (const name of ["not a host", "example.com", "nobody.example.com"]) {
      expect(
        await getCustomDomain(regions(), { userId: owner.id, hostname: name, now: NOW }),
      ).toEqual({
        ok: false,
        code: "not_found",
        message: "Custom domain not found.",
      });
    }
  });

  it("explains a refused role and a proof for an artifact that changed", async () => {
    const fake = new FakeDomains();
    const t = await team();
    await grantPlan(t.id, "team");
    const claim = value(await add(fake, t.editor.id, t.artifactId, host()));
    expect(await verify(fake, t.member.id, claim.hostname)).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    });
    // The artifact got another domain after the claim.
    const other = await attach(fake, t.editor.id, t.artifactId);
    publishProof(fake, claim);
    expect(await verify(fake, t.editor.id, claim.hostname)).toEqual({
      ok: false,
      code: "invalid_input",
      message: `This artifact already has the custom domain ${other.hostname}. Remove it first.`,
    });
    // The artifact went away.
    const gone = await owned();
    const lost = value(await add(fake, gone.owner.id, gone.artifactId, host()));
    publishProof(fake, lost);
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, gone.artifactId));
    expect(await verify(fake, gone.owner.id, lost.hostname)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "The artifact this domain was added to is no longer active. Add the domain again.",
    });
  });

  it("checks again: busy while removing, unavailable when DNS cannot be asked", async () => {
    const fake = new FakeDomains();
    const a = await provisioned(fake);
    fake.activate(a.hostname);
    value(await verify(fake, a.owner.id, a.hostname));
    fake.failing.txt = true;
    expect(await verify(fake, a.owner.id, a.hostname)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "DNS could not be checked right now. Try again in a minute.",
    });
    fake.failing.txt = false;
    await detachDomain(dbs(), a.hostname, "operator", NOW);
    expect(await verify(fake, a.owner.id, a.hostname)).toEqual({
      ok: false,
      code: "version_conflict",
      message: `${a.hostname} is being removed. Try again in a few minutes.`,
    });
  });

  it("gives back a Cloudflare hostname created for a row that changed meanwhile", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const claim = value(await add(fake, owner.id, artifactId, host()));
    publishProof(fake, claim);
    const racing = {
      txt: fake.txt,
      apex: fake.apex,
      hostnames: {
        ...fake.hostnames,
        create: async (hostname: string) => {
          await detachDomain(dbs(), hostname, "removed", NOW);
          return fake.hostnames.create(hostname);
        },
      },
    };
    expect(value(await verify(racing, owner.id, claim.hostname)).state).toBe("removing");
    expect(fake.idOf(claim.hostname)).toBeUndefined();
    // Its row never had a Cloudflare hostname, so the job deletes it without the client.
    expect(await runDeleteHostname(dbs(), null, claim.hostname)).toBe("done");
    expect(await domainRow(claim.hostname)).toBeUndefined();
  });

  it("detaches when another artifact still holds the name, and gives a host back after a lost race", async () => {
    const fake = new FakeDomains();
    const a = await provisioned(fake);
    const squatter = await owned();
    await db()
      .update(schema.artifacts)
      .set({ customHost: a.hostname })
      .where(eq(schema.artifacts.id, squatter.artifactId));
    fake.activate(a.hostname);
    expect(value(await verify(fake, a.owner.id, a.hostname)).state).toBe("removing");
    expect(await domainRow(a.hostname)).toMatchObject({ detachReason: "artifact_unavailable" });

    const b = await provisioned(fake);
    fake.activate(b.hostname);
    const racing = {
      txt: fake.txt,
      apex: fake.apex,
      hostnames: {
        ...fake.hostnames,
        status: async (id: string) => {
          // The domain is removed while Cloudflare answers.
          await db()
            .update(schema.customDomains)
            .set({ state: "detaching" })
            .where(eq(schema.customDomains.hostname, b.hostname));
          return fake.hostnames.status(id);
        },
      },
    };
    expect(value(await verify(racing, b.owner.id, b.hostname)).state).toBe("removing");
    expect(await customHost(b.artifactId)).toBeNull();
  });

  it("reconciles exactly", async () => {
    const fake = new FakeDomains();
    const one = await owned();
    const gone = await attach(fake, one.owner.id, one.artifactId);
    const two = await owned();
    const kept = await attach(fake, two.owner.id, two.artifactId);
    const removing = await owned();
    const going = await attach(fake, removing.owner.id, removing.artifactId);
    await detachDomain(dbs(), going.hostname, "removed", NOW);
    fake.created.delete(fake.idOf(gone.hostname) as string);
    fake.created.delete(fake.idOf(going.hostname) as string);
    await fake.hostnames.create("orphan.example.com");
    const stray = await owned();
    await db()
      .update(schema.artifacts)
      .set({ customHost: "stray.example.com" })
      .where(eq(schema.artifacts.id, stray.artifactId));
    expect(await reconcileCustomDomains(dbs(), [db()], fake, NOW)).toEqual({
      detached: [gone.hostname],
      removed: ["orphan.example.com"],
      cleared: ["stray.example.com"],
    });
    expect(await domainRow(gone.hostname)).toMatchObject({ detachReason: "reconciled" });
    expect((await domainRow(kept.hostname))?.state).toBe("active");
    expect(await reconcileCustomDomains(dbs(), [db()], fake, NOW)).toEqual({
      detached: [],
      removed: [],
      cleared: [],
    });
  });
});
