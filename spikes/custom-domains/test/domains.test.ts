import { describe, expect, it } from "vitest";
import {
  activateDomain,
  CLAIM_TTL_MS,
  claimDomain,
  detachArtifactDomains,
  detachDomain,
  enforceDomainLimit,
  ensureCloudflareHostname,
  MAX_MISSED_CHECKS,
  pruneClaims,
  recheckDomain,
  reconcileWithCloudflare,
  runDeleteHostname,
  suspendArtifact,
  txtName,
  verifyClaim,
} from "../src/domains.ts";
import {
  attach,
  count,
  FakeHostnames,
  fakeDns,
  randomHost,
  regions,
  seedArtifact,
  uid,
} from "./harness.ts";

async function customHost(
  r: ReturnType<typeof regions>,
  a: { id: string; region: "default" | "eu" },
) {
  const row = await r
    .db(a.region)
    .prepare("select custom_host from artifacts where id = ?")
    .bind(a.id)
    .first<{ custom_host: string | null }>();
  return row?.custom_host ?? null;
}

async function domainState(r: ReturnType<typeof regions>, hostname: string) {
  const row = await r.global
    .prepare("select state, owner_id, artifact_id from custom_domains where hostname = ?")
    .bind(hostname)
    .first<{ state: string; owner_id: string; artifact_id: string }>();
  return row ?? null;
}

describe("claim and proof", () => {
  it("serves only after the TXT proof and Cloudflare's activation, in that order", async () => {
    const r = regions();
    const artifact = await seedArtifact(r, { region: "eu" });
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const deps = dns.deps(cloudflare);
    const claim = await claimDomain(r, {
      ...artifact,
      artifactId: artifact.id,
      hostname: host.toUpperCase(),
      limit: 1,
      now: 1,
    });
    if (!claim.ok) throw new Error(claim.error);
    expect(claim.hostname).toBe(host);
    expect(claim.txtName).toBe(`_portifact.${host}`);
    expect(claim.txtValue).toMatch(/^portifact-verify=[0-9a-f]{40}$/);

    // No proof yet: nothing reaches Cloudflare.
    expect(
      await verifyClaim(r, deps, { ownerId: artifact.ownerId, hostname: host, now: 2 }),
    ).toEqual({ ok: false, error: "unverified" });
    expect(cloudflare.calls).toEqual([]);

    dns.records.set(claim.txtName, ["v=spf1 -all", claim.txtValue]);
    expect(
      await verifyClaim(r, deps, { ownerId: artifact.ownerId, hostname: host, now: 3 }),
    ).toEqual({ ok: true, state: "provisioning" });
    expect(cloudflare.calls).toEqual([`create ${host}`]);
    expect(await customHost(r, artifact)).toBeNull();

    cloudflare.active = false;
    expect(await activateDomain(r, deps, host)).toBe("pending");
    expect(await customHost(r, artifact)).toBeNull();
    cloudflare.active = true;
    expect(await activateDomain(r, deps, host)).toBe("active");
    expect(await customHost(r, artifact)).toBe(host);
    expect((await domainState(r, host))?.state).toBe("active");
    expect(await activateDomain(r, deps, host)).toBe("skipped");
  });

  it("does not let a stale CNAME or another owner's token make Portifact serve a name", async () => {
    const r = regions();
    const owner = await seedArtifact(r);
    const attacker = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const deps = dns.deps(cloudflare);
    const real = await claimDomain(r, {
      ...owner,
      artifactId: owner.id,
      hostname: host,
      limit: 1,
      now: 1,
    });
    const squat = await claimDomain(r, {
      ...attacker,
      artifactId: attacker.id,
      hostname: host,
      limit: 1,
      now: 1,
    });
    if (!real.ok || !squat.ok) throw new Error("claim");
    expect(squat.txtValue).not.toBe(real.txtValue);
    // DNS holds only the real owner's token: the squatter's claim proves nothing.
    dns.records.set(txtName(host), [real.txtValue]);
    expect(
      await verifyClaim(r, deps, { ownerId: attacker.ownerId, hostname: host, now: 2 }),
    ).toEqual({ ok: false, error: "unverified" });
    expect(
      await verifyClaim(r, deps, { ownerId: owner.ownerId, hostname: host, now: 2 }),
    ).toMatchObject({ ok: true });
    // Every claim is spent: the squatter must start again with a fresh token.
    expect(
      await verifyClaim(r, deps, { ownerId: attacker.ownerId, hostname: host, now: 3 }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an expired claim", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const claim = await claimDomain(r, {
      ...a,
      artifactId: a.id,
      hostname: host,
      limit: 1,
      now: 1,
    });
    if (!claim.ok) throw new Error(claim.error);
    dns.records.set(claim.txtName, [claim.txtValue]);
    expect(
      await verifyClaim(r, dns.deps(new FakeHostnames()), {
        ownerId: a.ownerId,
        hostname: host,
        now: 1 + CLAIM_TTL_MS,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await pruneClaims(r, 1 + CLAIM_TTL_MS)).toBeGreaterThanOrEqual(1);
  });

  it("applies the plan's domain count, one domain per artifact, and the artifact's ownership", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const b = await seedArtifact(r, { ownerId: a.ownerId });
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const host = randomHost();
    await attach(r, dns, cloudflare, a, host);
    const base = { ownerId: a.ownerId, region: a.region, now: 5 } as const;
    expect(
      await claimDomain(r, { ...base, artifactId: b.id, hostname: randomHost(), limit: 1 }),
    ).toEqual({ ok: false, error: "quota_exceeded" });
    expect(
      await claimDomain(r, { ...base, artifactId: b.id, hostname: randomHost(), limit: 0 }),
    ).toEqual({ ok: false, error: "quota_exceeded" });
    expect(
      await claimDomain(r, { ...base, artifactId: a.id, hostname: randomHost(), limit: 5 }),
    ).toEqual({ ok: false, error: "conflict" });
    expect(await claimDomain(r, { ...base, artifactId: b.id, hostname: host, limit: 5 })).toEqual({
      ok: false,
      error: "conflict",
    });
    expect(
      await claimDomain(r, {
        ...base,
        ownerId: uid("usr"),
        artifactId: b.id,
        hostname: randomHost(),
        limit: 5,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await claimDomain(r, { ...base, artifactId: b.id, hostname: "*.example.com", limit: 5 }),
    ).toEqual({ ok: false, error: "wildcard" });
    expect(
      await claimDomain(r, { ...base, artifactId: b.id, hostname: randomHost(), limit: 5 }),
    ).toMatchObject({ ok: true });
  });

  it("retries a Cloudflare create that failed, exactly once", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const deps = dns.deps(cloudflare);
    const claim = await claimDomain(r, {
      ...a,
      artifactId: a.id,
      hostname: host,
      limit: 1,
      now: 1,
    });
    if (!claim.ok) throw new Error(claim.error);
    dns.records.set(claim.txtName, [claim.txtValue]);
    cloudflare.failCreate = true;
    await expect(
      verifyClaim(r, deps, { ownerId: a.ownerId, hostname: host, now: 2 }),
    ).rejects.toThrow("Cloudflare unavailable");
    expect(await activateDomain(r, deps, host)).toBe("skipped");
    cloudflare.failCreate = false;
    await ensureCloudflareHostname(r, deps, host);
    await ensureCloudflareHostname(r, deps, host);
    expect(cloudflare.hostnames.size).toBe(1);
    expect(await activateDomain(r, deps, host)).toBe("active");
  });

  it("detaches instead of activating when the artifact can no longer take the host", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const deps = dns.deps(cloudflare);
    const claim = await claimDomain(r, {
      ...a,
      artifactId: a.id,
      hostname: host,
      limit: 1,
      now: 1,
    });
    if (!claim.ok) throw new Error(claim.error);
    dns.records.set(claim.txtName, [claim.txtValue]);
    await verifyClaim(r, deps, { ownerId: a.ownerId, hostname: host, now: 2 });
    await r
      .db(a.region)
      .prepare("update artifacts set state = 'archived' where id = ?")
      .bind(a.id)
      .run();
    expect(await activateDomain(r, deps, host)).toBe("detached");
    expect((await domainState(r, host))?.state).toBe("detaching");
  });
});

describe("transfer, detach and lifecycle", () => {
  it("moves a domain to whoever proves DNS control, taking it from the previous owner first", async () => {
    const r = regions();
    const previous = await seedArtifact(r, { region: "eu" });
    const next = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, previous, host);
    await attach(r, dns, cloudflare, next, host);
    expect(await customHost(r, previous)).toBeNull();
    expect(await customHost(r, next)).toBe(host);
    expect(await domainState(r, host)).toMatchObject({ owner_id: next.ownerId, state: "active" });
  });

  it("refuses a new proof while the Cloudflare hostname is being deleted", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const b = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, a, host);
    await detachDomain(r, host);
    await expect(attach(r, dns, cloudflare, b, host)).rejects.toThrow("busy");
    await runDeleteHostname(r, dns.deps(cloudflare), host);
    await attach(r, dns, cloudflare, b, host);
    expect(await customHost(r, b)).toBe(host);
  });

  it("writes the deletion job once however often a detach is retried, and the job is idempotent", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, a, host);
    await Promise.all([detachDomain(r, host), detachDomain(r, host)]);
    await detachDomain(r, host);
    const jobs = await count(
      r.global,
      "select count(*) as n from outbox where topic = 'delete_custom_hostname' and json_extract(payload, '$.hostname') = ?",
      host,
    );
    expect(jobs).toBe(1);
    expect(await customHost(r, a)).toBeNull();
    const deps = dns.deps(cloudflare);
    expect(await runDeleteHostname(r, deps, host)).toBe("done");
    expect(await runDeleteHostname(r, deps, host)).toBe("done");
    expect(cloudflare.hostnames.size).toBe(0);
    expect(await domainState(r, host)).toBeNull();
    expect(await detachDomain(r, host)).toBe(false);
  });

  it("withdraws the hostname when the operator suspends the artifact, and reinstating does not restore it", async () => {
    const r = regions();
    const a = await seedArtifact(r, { region: "eu" });
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, a, host);
    await suspendArtifact(r, { artifactId: a.id, region: a.region });
    expect(await customHost(r, a)).toBeNull();
    expect((await domainState(r, host))?.state).toBe("detaching");
    await runDeleteHostname(r, dns.deps(cloudflare), host);
    await r
      .db(a.region)
      .prepare("update artifacts set state = 'active' where id = ?")
      .bind(a.id)
      .run();
    expect(await customHost(r, a)).toBeNull();
  });

  it("detaches every domain of a purged artifact (account and workspace deletion)", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    await attach(r, fakeDns(), new FakeHostnames(), a, host);
    expect(await detachArtifactDomains(r, a.id)).toBe(1);
    expect(await detachArtifactDomains(r, a.id)).toBe(0);
  });

  it("detaches a domain whose TXT proof disappeared, only after repeated misses", async () => {
    const r = regions();
    const a = await seedArtifact(r);
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, a, host);
    const deps = dns.deps(cloudflare);
    expect(await recheckDomain(r, deps, host, 10)).toBe("kept");
    const proof = dns.records.get(txtName(host)) ?? [];
    dns.records.delete(txtName(host));
    for (let i = 1; i < MAX_MISSED_CHECKS; i += 1) {
      expect(await recheckDomain(r, deps, host, 10 + i)).toBe("missed");
    }
    // A record back in time resets the count.
    dns.records.set(txtName(host), proof);
    expect(await recheckDomain(r, deps, host, 20)).toBe("kept");
    dns.records.delete(txtName(host));
    for (let i = 1; i < MAX_MISSED_CHECKS; i += 1) await recheckDomain(r, deps, host, 20 + i);
    expect(await recheckDomain(r, deps, host, 30)).toBe("detached");
    expect(await customHost(r, a)).toBeNull();
    expect(await recheckDomain(r, deps, host, 31)).toBe("skipped");
  });

  it("keeps the oldest domains on a downgrade and detaches the rest", async () => {
    const r = regions();
    const ownerId = uid("usr");
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const hosts = [randomHost(), randomHost(), randomHost()];
    for (const [i, host] of hosts.entries()) {
      await attach(r, dns, cloudflare, await seedArtifact(r, { ownerId }), host, 1_000 + i);
    }
    expect(await enforceDomainLimit(r, ownerId, 1)).toEqual([hosts[1], hosts[2]]);
    expect(await enforceDomainLimit(r, ownerId, 1)).toEqual([]);
    expect((await domainState(r, hosts[0] as string))?.state).toBe("active");
    expect(await enforceDomainLimit(r, ownerId, 0)).toEqual([hosts[0]]);
  });

  it("reconciles with Cloudflare after a restore: rows without their hostname detach, orphans go", async () => {
    const r = regions();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const kept = randomHost();
    const lost = randomHost();
    await attach(r, dns, cloudflare, await seedArtifact(r), kept);
    const lostArtifact = await seedArtifact(r);
    await attach(r, dns, cloudflare, lostArtifact, lost);
    // After the restore point: `lost` was released and its Cloudflare hostname deleted, and an
    // orphan hostname was attached whose row the restore rewound away.
    for (const [id, name] of cloudflare.hostnames)
      if (name === lost) cloudflare.hostnames.delete(id);
    const orphan = await cloudflare.create(randomHost());
    const result = await reconcileWithCloudflare(r, dns.deps(cloudflare));
    expect(result.detached).toContain(lost);
    expect(result.detached).not.toContain(kept);
    expect(result.removed).toHaveLength(1);
    expect(cloudflare.hostnames.has(orphan.id)).toBe(false);
    expect(await customHost(r, lostArtifact)).toBeNull();
  });
});
