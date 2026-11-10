// Custom domains in the jobs Worker (decision 0006): the scheduled check activates and
// re-checks domains, the queue runs `delete_custom_hostname`, the operator shows, detaches and
// reconciles them, and with the feature switched off nothing calls Cloudflare. The fake stands in
// for Cloudflare and DNS.
import { createMessageBatch, env } from "cloudflare:test";
import { txtRecordName, txtRecordValue } from "@portifact/contracts";
import { createDb, regionsFromEnv, schema } from "@portifact/db";
import { FakeDomains } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { domainsFromEnv, runQueue, runScheduled } from "../src/index.ts";
import { domainNotifierFromEnv } from "../src/notices.ts";
import { runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;
/** The TXT proof of every seeded domain: a low-entropy stand-in, not a credential. */
const PROOF = "a".repeat(32);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const db = () => regionsFromEnv(env).get("default").db;

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

/** An active artifact and a domain row for it, with its Cloudflare hostname in the fake. */
async function domain(
  fake: FakeDomains,
  state: "provisioning" | "active",
  options: { checkedAt?: number } = {},
) {
  const id = artifactId();
  const ownerId = `u_${crypto.randomUUID()}`;
  const hostname = `${id}.example.com`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Plan",
      state: "active",
      customHost: state === "active" ? hostname : null,
    });
  const { id: cfId } = await fake.hostnames.create(hostname);
  await db()
    .insert(schema.customDomains)
    .values({
      hostname,
      ownerId,
      artifactId: id,
      region: "default",
      state,
      token: PROOF,
      cfHostnameId: cfId,
      verifiedAt: NOW,
      checkedAt: options.checkedAt ?? NOW,
    });
  // Pro, so the plan limit keeps the domain.
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan: "pro", grantedBy: "test", updatedAt: NOW });
  return { id, hostname };
}

async function row(hostname: string) {
  const [found] = await db()
    .select()
    .from(schema.customDomains)
    .where(eq(schema.customDomains.hostname, hostname));
  return found;
}

describe("the scheduled run", () => {
  it("activates what Cloudflare finished and re-checks active domains daily", async () => {
    const fake = new FakeDomains();
    const provisioning = await domain(fake, "provisioning");
    fake.activate(provisioning.hostname);
    const active = await domain(fake, "active", { checkedAt: NOW - DAY });
    fake.activate(active.hostname);
    fake.publishTxt(txtRecordName(active.hostname), txtRecordValue(PROOF));
    const result = await runScheduled(env, NOW, fake);
    expect(result.customDomains).toMatchObject({ activated: expect.any(Number) });
    expect((await row(provisioning.hostname))?.state).toBe("active");
    expect(await row(active.hostname)).toMatchObject({ state: "active", checkedAt: NOW });
  });

  it("calls nothing while custom domains are switched off", async () => {
    expect(domainsFromEnv(env)).toBeNull();
    const fake = new FakeDomains();
    const provisioning = await domain(fake, "provisioning");
    fake.calls.length = 0;
    const result = await runScheduled(env, NOW);
    expect(result.customDomains).toMatchObject({ activated: 0, checked: 0 });
    expect(fake.calls).toEqual([]);
    expect((await row(provisioning.hostname))?.state).toBe("provisioning");
  });

  it("reports a failed check without stopping the run", async () => {
    // A row in a region this Worker has no binding for (a restore from another deployment).
    const fake = new FakeDomains();
    const { hostname } = await domain(fake, "provisioning");
    fake.activate(hostname);
    await db()
      .global.update(schema.customDomains)
      .set({ region: "mars" as "default" })
      .where(eq(schema.customDomains.hostname, hostname));
    const result = await runScheduled(env, NOW, fake);
    expect(result.customDomains).toBe("failed");
    expect(result).toHaveProperty("relayed");
    await db()
      .global.delete(schema.customDomains)
      .where(eq(schema.customDomains.hostname, hostname));
  });
});

describe("the delete_custom_hostname job", () => {
  it("deletes the Cloudflare hostname and the row, and retries without the client", async () => {
    const fake = new FakeDomains();
    const { hostname } = await domain(fake, "active");
    expect((await runOperator(createDb(env.DB), ["detach-domain", hostname], NOW)).exitCode).toBe(
      0,
    );
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.subject, hostname));
    if (!job) throw new Error("no job");
    const deliver = async (deps: FakeDomains | null) => {
      const batch = createMessageBatch("portifact-jobs", [
        { id: "m1", timestamp: new Date(NOW), attempts: 1, body: { id: job.id, topic: job.topic } },
      ]);
      await runQueue(batch, env, NOW, deps);
    };
    await deliver(null);
    expect((await row(hostname))?.state).toBe("detaching");
    await deliver(fake);
    expect(await row(hostname)).toBeUndefined();
    expect(fake.idOf(hostname)).toBeUndefined();
  });
});

describe("operator domain commands", () => {
  it("shows a domain and its claims, and detaches it once", async () => {
    const fake = new FakeDomains();
    const { id, hostname } = await domain(fake, "active");
    await db()
      .insert(schema.domainClaims)
      .values({
        hostname,
        ownerId: "u_claimant",
        artifactId: "abcdefghij",
        region: "default",
        token: "f".repeat(32),
        expiresAt: NOW + DAY,
      });
    const shown = await runOperator(createDb(env.DB), ["show-domain", hostname.toUpperCase()], NOW);
    expect(shown.output).toContain(`domain    ${hostname}`);
    expect(shown.output).toContain(`artifact  ${id}`);
    expect(shown.output).toContain("claim     u_claimant for abcdefghij");
    expect(shown.output).not.toContain("f".repeat(32));
    expect(
      (await runOperator(createDb(env.DB), ["show-domain", "none.example.com"], NOW)).exitCode,
    ).toBe(1);
    expect((await runOperator(createDb(env.DB), ["show-domain"], NOW)).exitCode).toBe(2);
    expect((await runOperator(createDb(env.DB), ["detach-domain"], NOW)).exitCode).toBe(2);

    const detached = await runOperator(createDb(env.DB), ["detach-domain", hostname], NOW);
    expect(detached.output).toContain(`Detached ${hostname}`);
    expect(await row(hostname)).toMatchObject({ state: "detaching", detachReason: "operator" });
    const [artifact] = await db()
      .select({ customHost: schema.artifacts.customHost })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, id));
    expect(artifact?.customHost).toBeNull();
    expect((await runOperator(createDb(env.DB), ["detach-domain", hostname], NOW)).exitCode).toBe(
      1,
    );
    const again = await runOperator(createDb(env.DB), ["show-domain", hostname], NOW);
    expect(again.output).toContain("state     detaching (operator)");
  });

  it("reconciles with Cloudflare only with its client", async () => {
    const without = await runOperator(createDb(env.DB), ["reconcile-domains"], NOW);
    expect(without).toEqual({
      exitCode: 1,
      output:
        "reconcile-domains needs CF_CONTENT_ZONE_ID and CF_HOSTNAMES_TOKEN in the environment.",
    });
    const fake = new FakeDomains();
    const lost = await domain(fake, "active");
    fake.created.delete(fake.idOf(lost.hostname) as string);
    await fake.hostnames.create("orphan.example.com");
    const result = await runOperator(createDb(env.DB), ["reconcile-domains"], NOW, undefined, fake);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(lost.hostname);
    expect(result.output).toContain("Deleted from Cloudflare (no row): orphan.example.com");
  });
});

describe("the operator's block list", () => {
  it("blocks a name, detaching what it covers, lists it and lifts it", async () => {
    const fake = new FakeDomains();
    const { hostname } = await domain(fake, "active");
    const name = hostname.split(".").slice(1).join(".");
    expect((await runOperator(createDb(env.DB), ["block-domain", name], NOW)).exitCode).toBe(2);
    const blocked = await runOperator(
      createDb(env.DB),
      ["block-domain", name, "--note", "phishing"],
      NOW,
    );
    expect(blocked.output).toBe(`Blocked ${name} and every name under it. Detached: ${hostname}.`);
    expect(await row(hostname)).toMatchObject({ state: "detaching", detachReason: "blocked" });
    expect((await runOperator(createDb(env.DB), ["blocked-domains"], NOW)).output).toContain(
      `${name}  `,
    );
    expect(
      (await runOperator(createDb(env.DB), ["block-domain", "not a name", "--note", "x"], NOW))
        .exitCode,
    ).toBe(1);
    expect((await runOperator(createDb(env.DB), ["unblock-domain", name], NOW)).exitCode).toBe(0);
    expect((await runOperator(createDb(env.DB), ["unblock-domain", name], NOW)).exitCode).toBe(1);
    expect((await runOperator(createDb(env.DB), ["unblock-domain"], NOW)).exitCode).toBe(2);
    expect((await runOperator(createDb(env.DB), ["blocked-domains"], NOW)).output).toBe(
      "No blocked names.",
    );
  });
});

describe("the downgrade notice email", () => {
  it("renders in the owner's language with the usage page, and maps provider refusals", async () => {
    const sent: unknown[] = [];
    const notifier = domainNotifierFromEnv({
      APP_ORIGIN: "https://app.portifact.com",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message);
          return { messageId: "m" };
        },
      } as unknown as SendEmail,
    });
    await notifier.send({
      to: "owner@example.com",
      hostnames: ["docs.example.com"],
      detachAt: NOW,
      limit: 0,
      locale: "es",
    });
    const [message] = sent as { to: string; subject: string; text: string }[];
    expect(message?.to).toBe("owner@example.com");
    expect(message?.subject).toBe("Tu dominio propio dejará de funcionar pronto");
    expect(message?.text).toContain("https://app.portifact.com/usage");
    const failing = domainNotifierFromEnv({
      APP_ORIGIN: "https://app.portifact.com",
      EMAIL: {
        send: async () => {
          throw new Error(`refused owner@example.com: ${"secret"}`);
        },
      } as unknown as SendEmail,
    });
    await expect(
      failing.send({
        to: "owner@example.com",
        hostnames: ["a.example.com"],
        detachAt: NOW,
        limit: 0,
        locale: null,
      }),
    ).rejects.toThrow(/^email delivery failed$/);
  });
});
