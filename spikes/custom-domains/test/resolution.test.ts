import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type RegionOf, resolveDelivery } from "../src/delivery.ts";
import { detachDomain, runDeleteHostname } from "../src/domains.ts";
import { HostDirectory } from "../src/host-directory.ts";
import type { Region } from "../src/regions.ts";
import {
  attach,
  CONTENT_DOMAIN,
  counting,
  FakeHostnames,
  fakeDns,
  randomHost,
  regions,
  seedArtifact,
} from "./harness.ts";

/** Both databases counted, as the content Worker would see them. */
function counted() {
  const global = counting(env.GLOBAL);
  const eu = counting(env.DB_EU);
  return {
    r: regions({ global: global.db, eu: eu.db }),
    queries: () => global.queries() + eu.queries(),
  };
}

/** The artifact directory of decision 0005, already warm: it costs nothing per request. */
const warmDirectory =
  (known: Record<string, Region>): RegionOf =>
  async (id) =>
    known[id] ?? null;

describe("custom host resolution", () => {
  it.each(["default", "eu"] as const)(
    "costs two reads on a cold isolate, then one per request like today (%s region)",
    async (region) => {
      const r = regions();
      const artifact = await seedArtifact(r, { region });
      const host = randomHost();
      await attach(r, fakeDns(), new FakeHostnames(), artifact, host);

      const { r: worker, queries } = counted();
      const hosts = new HostDirectory(worker.global);
      const first = await resolveDelivery(worker, hosts, warmDirectory({}), host, CONTENT_DOMAIN);
      expect(first).toMatchObject({ artifact: { id: artifact.id }, region, via: "custom" });
      expect(queries()).toBe(2);
      for (let i = 0; i < 5; i += 1) {
        await resolveDelivery(worker, hosts, warmDirectory({}), host, CONTENT_DOMAIN);
      }
      expect(queries()).toBe(2 + 5);
    },
  );

  it("keeps one read per request on the artifact's own host, which also names its custom host", async () => {
    const r = regions();
    const artifact = await seedArtifact(r);
    const host = randomHost();
    await attach(r, fakeDns(), new FakeHostnames(), artifact, host);
    const { r: worker, queries } = counted();
    const resolved = await resolveDelivery(
      worker,
      new HostDirectory(worker.global),
      warmDirectory({ [artifact.id]: "default" }),
      `${artifact.id}.${CONTENT_DOMAIN}`,
      CONTENT_DOMAIN,
    );
    expect(resolved).toMatchObject({ via: "artifact", artifact: { customHost: host } });
    expect(queries()).toBe(1);
  });

  it("stops serving at the next request after a detach, with the hint still cached", async () => {
    const r = regions();
    const artifact = await seedArtifact(r, { region: "eu" });
    const host = randomHost();
    const cloudflare = new FakeHostnames();
    const dns = fakeDns();
    await attach(r, dns, cloudflare, artifact, host);
    const hosts = new HostDirectory(r.global);
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).not.toBeNull();
    expect(hosts.size).toBe(1);

    await detachDomain(r, host);
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toBeNull();
    expect(hosts.size).toBe(0);
    // And once the job deleted the Cloudflare hostname and the row, it stays gone.
    await runDeleteHostname(r, dns.deps(cloudflare), host);
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toBeNull();
    expect(cloudflare.hostnames.size).toBe(0);
  });

  it("follows a hostname moved to another artifact in another region without serving the old one", async () => {
    const r = regions();
    const before = await seedArtifact(r, { region: "default" });
    const after = await seedArtifact(r, { region: "eu" });
    const host = randomHost();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    await attach(r, dns, cloudflare, before, host);
    const { r: worker, queries } = counted();
    const hosts = new HostDirectory(worker.global);
    expect(
      await resolveDelivery(worker, hosts, warmDirectory({}), host, CONTENT_DOMAIN),
    ).toMatchObject({ artifact: { id: before.id } });

    // The domain changed hands: its new holder proves DNS control with their own token. The
    // isolate still holds the hint that points at the old artifact.
    await attach(r, dns, cloudflare, after, host);
    const start = queries();
    const resolved = await resolveDelivery(worker, hosts, warmDirectory({}), host, CONTENT_DOMAIN);
    expect(resolved).toMatchObject({ artifact: { id: after.id }, region: "eu" });
    // The stale hint cost one regional miss and one global read, then the regional hit.
    expect(queries() - start).toBe(3);
    // One Cloudflare hostname all along: a transfer keeps Portifact's resource.
    expect(cloudflare.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("answers nothing for an unknown host and never caches the miss", async () => {
    const r = regions();
    const hosts = new HostDirectory(r.global);
    const host = randomHost();
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toBeNull();
    expect(hosts.size).toBe(0);
    const artifact = await seedArtifact(r);
    await attach(r, fakeDns(), new FakeHostnames(), artifact, host);
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toMatchObject({
      artifact: { id: artifact.id },
    });
  });

  it("answers nothing for a provisioning domain, before the artifact row takes the host", async () => {
    const r = regions();
    const artifact = await seedArtifact(r);
    const host = randomHost();
    await r.global
      .prepare(
        "insert into custom_domains (hostname, owner_id, artifact_id, region, state, token_hash, verified_at, checked_at) values (?, ?, ?, 'default', 'active', 'x', 1, 1)",
      )
      .bind(host, artifact.ownerId, artifact.id)
      .run();
    // A global row alone (a crash between the two steps, or a restored row) serves nothing:
    // only the regional row is authority.
    const hosts = new HostDirectory(r.global);
    expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toBeNull();
  });

  it("serves nothing on content-domain hosts that are not artifacts, or unknown artifact IDs", async () => {
    const r = regions();
    const hosts = new HostDirectory(r.global);
    for (const host of [
      CONTENT_DOMAIN,
      `domains.${CONTENT_DOMAIN}`,
      `abcdefghij.${CONTENT_DOMAIN}`,
    ]) {
      expect(await resolveDelivery(r, hosts, warmDirectory({}), host, CONTENT_DOMAIN)).toBeNull();
    }
    expect(
      await resolveDelivery(
        r,
        hosts,
        warmDirectory({ abcdefghij: "default" }),
        `abcdefghij.${CONTENT_DOMAIN}`,
        CONTENT_DOMAIN,
      ),
    ).toBeNull();
  });

  it("keeps the isolate cache bounded, least recently used out first", async () => {
    const r = regions();
    const dns = fakeDns();
    const cloudflare = new FakeHostnames();
    const hostsSeen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const host = randomHost();
      hostsSeen.push(host);
      await attach(r, dns, cloudflare, await seedArtifact(r), host);
    }
    const { r: worker, queries } = counted();
    const hosts = new HostDirectory(worker.global, 2);
    await hosts.hint(hostsSeen[0] as string);
    await hosts.hint(hostsSeen[1] as string);
    await hosts.hint(hostsSeen[0] as string); // refreshes the first entry
    await hosts.hint(hostsSeen[2] as string); // evicts the second
    expect(hosts.size).toBe(2);
    const before = queries();
    await hosts.hint(hostsSeen[0] as string);
    expect(queries()).toBe(before);
    await hosts.hint(hostsSeen[1] as string);
    expect(queries()).toBe(before + 1);
  });

  it("refuses a row with an unknown region instead of falling back", async () => {
    const r = regions();
    const host = randomHost();
    await r.global
      .prepare(
        "insert into custom_domains (hostname, owner_id, artifact_id, region, state, token_hash, verified_at, checked_at) values (?, 'o', 'abcdefghij', 'mars', 'active', 'x', 1, 1)",
      )
      .bind(host)
      .run();
    await expect(new HostDirectory(r.global).hint(host)).rejects.toThrow("Unknown region");
  });
});
