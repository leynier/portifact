// Custom domains, second part (decision 0006): zone apexes and the operator's block list refused
// before anything reaches Cloudflare, the active custom host the app's entries may use, codes
// bound to the host they were issued for (read, review and share-link handoffs), and the
// downgrade notice. Cloudflare and DNS are the in-memory fake.
import { env } from "cloudflare:test";
import { txtRecordName, txtRecordValue } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { HOSTNAME_MESSAGES } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeCustomHost,
  addCustomDomain,
  blockHostname,
  checkCustomDomains,
  customHostHint,
  domainDbs,
  listBlockedHostnames,
  removeCustomDomain,
  unblockHostname,
  verifyCustomDomain,
} from "../src/custom-domains.ts";
import {
  type DomainNotifier,
  scheduleDomainNotices,
  sendDomainNotice,
} from "../src/domain-notices.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  suppressEmail,
} from "../src/email.ts";
import { runJob } from "../src/outbox.ts";
import { issueReadHandoff, readEntryConfirmation, redeemReadHandoff } from "../src/read-access.ts";
import { issueReviewHandoff, redeemReviewHandoff } from "../src/review-access.ts";
import { createShareLink, openShareLink, redeemShareHandoff } from "../src/share-links.ts";
import { FakeDomains } from "../src/testing/fake-domains.ts";
import { getViewerArtifact } from "../src/viewer.ts";
import { DAY, db, grantPlan, NOW, publishSite, session, user, value } from "./fixtures.ts";

const CONTENT = "portifact.dev";
const regions = () => regionsFromEnv(env);
const dbs = () => domainDbs(regions());
let counter = 0;
const host = () => `site${++counter}-${crypto.randomUUID().slice(0, 8)}.example.com`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function owned(plan: "pro" | "team" = "pro") {
  const owner = await user();
  await grantPlan(owner.id, plan);
  const { artifactId } = await publishSite(owner.id);
  return { owner, artifactId };
}

/** Adds, proves and activates a domain. */
async function attach(fake: FakeDomains, userId: string, artifactId: string, hostname = host()) {
  const claim = value(
    await addCustomDomain(regions(), fake, {
      userId,
      artifactId,
      hostname,
      contentDomain: CONTENT,
      now: NOW,
    }),
  );
  fake.publishTxt(txtRecordName(hostname), txtRecordValue(claim.token));
  value(await verifyCustomDomain(regions(), fake, { userId, hostname, now: NOW }));
  fake.activate(hostname);
  value(await verifyCustomDomain(regions(), fake, { userId, hostname, now: NOW }));
  return hostname;
}

async function domainRow(hostname: string) {
  const [row] = await db()
    .select()
    .from(schema.customDomains)
    .where(eq(schema.customDomains.hostname, hostname));
  return row;
}

describe("names refused before Cloudflare", () => {
  it("refuses the apex of a DNS zone, at adding and again at the proof", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    const apex = "example.co.uk";
    // Three labels pass the shape check; DNS says it is the apex of its zone.
    fake.apexes.add(`docs.${apex}`);
    expect(
      await addCustomDomain(regions(), fake, {
        userId: owner.id,
        artifactId,
        hostname: `docs.${apex}`,
        contentDomain: CONTENT,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "invalid_input", message: HOSTNAME_MESSAGES.zone_apex });
    // A zone created after the claim is caught before Cloudflare, and the claim is dropped.
    const later = host();
    const claim = value(
      await addCustomDomain(regions(), fake, {
        userId: owner.id,
        artifactId,
        hostname: later,
        contentDomain: CONTENT,
        now: NOW,
      }),
    );
    fake.apexes.add(later);
    fake.publishTxt(txtRecordName(later), txtRecordValue(claim.token));
    expect(
      await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname: later, now: NOW }),
    ).toEqual({
      ok: false,
      code: "invalid_input",
      message: HOSTNAME_MESSAGES.zone_apex,
    });
    expect(fake.idOf(later)).toBeUndefined();
    expect(
      await db().select().from(schema.domainClaims).where(eq(schema.domainClaims.hostname, later)),
    ).toEqual([]);
  });

  it("answers capacity_unavailable when DNS cannot say whether a name is a zone apex", async () => {
    const { owner, artifactId } = await owned();
    const fake = new FakeDomains();
    fake.failing.txt = true;
    expect(
      await addCustomDomain(regions(), fake, {
        userId: owner.id,
        artifactId,
        hostname: host(),
        contentDomain: CONTENT,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
  });

  it("blocks a name and everything under it, detaching what it covers", async () => {
    const fake = new FakeDomains();
    const one = await owned();
    const name = `blocked${++counter}.example`;
    const covered = await attach(fake, one.owner.id, one.artifactId, `docs.${name}`);
    const two = await owned();
    const claim = value(
      await addCustomDomain(regions(), fake, {
        userId: two.owner.id,
        artifactId: two.artifactId,
        hostname: `www.${name}`,
        contentDomain: CONTENT,
        now: NOW,
      }),
    );
    const outside = await attach(fake, two.owner.id, (await publishSite(two.owner.id)).artifactId);

    expect(
      await blockHostname(dbs(), { name: ` ${name.toUpperCase()}. `, note: "phishing", now: NOW }),
    ).toEqual({
      ok: true,
      value: { name, detached: [covered] },
    });
    expect(await domainRow(covered)).toMatchObject({ state: "detaching", detachReason: "blocked" });
    expect((await domainRow(outside))?.state).toBe("active");
    expect(
      await db()
        .select()
        .from(schema.domainClaims)
        .where(eq(schema.domainClaims.hostname, claim.hostname)),
    ).toEqual([]);
    expect(
      await addCustomDomain(regions(), fake, {
        userId: two.owner.id,
        artifactId: two.artifactId,
        hostname: `a.b.${name}`,
        contentDomain: CONTENT,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "invalid_input", message: HOSTNAME_MESSAGES.blocked });
    expect(
      (await listBlockedHostnames(db().global)).map((row) => [row.name, row.note]),
    ).toContainEqual([name, "phishing"]);
    expect(await blockHostname(dbs(), { name: "not a name", now: NOW })).toMatchObject({
      ok: false,
    });

    // Lifting the block lets the name be added again; what it detached stays detached.
    expect(await unblockHostname(db().global, name)).toBe(true);
    expect(await unblockHostname(db().global, name)).toBe(false);
    expect(await unblockHostname(db().global, "not a name")).toBe(false);
    expect((await domainRow(covered))?.state).toBe("detaching");
  });

  it("detaches an active domain blocked after it was attached, at the daily check", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    await db().insert(schema.blockedHostnames).values({ name: hostname, createdAt: NOW });
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    expect(await domainRow(hostname)).toMatchObject({
      state: "detaching",
      detachReason: "blocked",
    });
  });
});

describe("the active custom host", () => {
  it("is the artifact's host only while the global row is active for the same artifact", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
    const hostname = await attach(fake, owner.id, artifactId);
    expect(await activeCustomHost(db(), artifactId, true)).toBe(hostname);
    // Switched off, the app's entries use the `.dev` host whatever the tables say.
    expect(await activeCustomHost(db(), artifactId, false)).toBeNull();
    expect(await customHostHint(db().global, hostname)).toEqual({ artifactId, region: "default" });
    // A host the artifact holds without an active row (a restore, a race) is never used.
    await db()
      .update(schema.customDomains)
      .set({ state: "provisioning" })
      .where(eq(schema.customDomains.hostname, hostname));
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
    expect(await customHostHint(db().global, hostname)).toBeNull();
    expect(await customHostHint(db().global, "nobody.example.com")).toBeNull();
    await db()
      .update(schema.customDomains)
      .set({ state: "active", artifactId: "abcdefghij" })
      .where(eq(schema.customDomains.hostname, hostname));
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
  });
});

describe("codes bound to their host", () => {
  async function withDomain() {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    return { owner, artifactId, hostname, dev: `${artifactId}.${CONTENT}` };
  }

  it("read codes go to the `.dev` host or the active custom host, and redeem only there", async () => {
    const { owner, artifactId, hostname, dev } = await withDomain();
    const authSessionId = await session(owner.id);
    const issue = (requestedHost: string | null, state: string) =>
      issueReadHandoff(db(), {
        customDomains: true,
        confirmed: false,
        artifactId,
        userId: owner.id,
        authSessionId,
        state,
        now: NOW,
        requestedHost,
        contentDomain: CONTENT,
      });
    const onDev = value(await issue(null, "s".repeat(43)));
    expect(onDev.host).toBe(dev);
    const onCustom = value(await issue(hostname, "t".repeat(43)));
    expect(onCustom.host).toBe(hostname);
    // Any other host answers exactly like an artifact the visitor cannot open.
    const other = await issue("evil.example.com", "u".repeat(43));
    const missing = await issueReadHandoff(db(), {
      customDomains: true,
      confirmed: false,
      artifactId: "abcdefghij",
      userId: owner.id,
      authSessionId,
      state: "v".repeat(43),
      now: NOW,
      requestedHost: null,
      contentDomain: CONTENT,
    });
    expect(other).toEqual(missing);
    expect(await issue(dev, "w".repeat(43))).toEqual(missing);

    const redeem = (code: string, state: string, on: string) =>
      redeemReadHandoff(db(), {
        code,
        artifactId,
        states: [state],
        host: on,
        devHost: dev,
        now: NOW,
      });
    expect((await redeem(onCustom.code, "t".repeat(43), dev)).ok).toBe(false);
    expect((await redeem(onDev.code, "s".repeat(43), hostname)).ok).toBe(false);
    expect((await redeem(onCustom.code, "t".repeat(43), hostname)).ok).toBe(true);
    expect((await redeem(onDev.code, "s".repeat(43), dev)).ok).toBe(true);
  });

  it("a code issued before hosts were stored counts as the `.dev` host's", async () => {
    const { owner, artifactId, hostname, dev } = await withDomain();
    const authSessionId = await session(owner.id);
    const issued = value(
      await issueReadHandoff(db(), {
        customDomains: true,
        confirmed: false,
        artifactId,
        userId: owner.id,
        authSessionId,
        state: "x".repeat(43),
        now: NOW,
        requestedHost: null,
        contentDomain: CONTENT,
      }),
    );
    await db().update(schema.readHandoffs).set({ host: null });
    const redeem = (on: string) =>
      redeemReadHandoff(db(), {
        code: issued.code,
        artifactId,
        states: ["x".repeat(43)],
        host: on,
        devHost: dev,
        now: NOW,
      });
    expect((await redeem(hostname)).ok).toBe(false);
    expect((await redeem(dev)).ok).toBe(true);
  });

  it("review codes go to the active custom host of a reader and redeem only there", async () => {
    const { owner, artifactId, hostname, dev } = await withDomain();
    const authSessionId = await session(owner.id);
    const issued = value(
      await issueReviewHandoff(db(), {
        customDomains: true,
        artifactId,
        userId: owner.id,
        authSessionId,
        now: NOW,
        contentDomain: CONTENT,
      }),
    );
    expect(issued.host).toBe(hostname);
    const redeem = (on: string) =>
      redeemReviewHandoff(db(), {
        code: issued.code,
        artifactId,
        kind: "frame",
        host: on,
        devHost: dev,
        now: NOW,
      });
    expect((await redeem(dev)).ok).toBe(false);
    expect((await redeem(hostname)).ok).toBe(true);
    // Without a domain, the `.dev` host as before.
    const plain = await owned();
    const plainCode = value(
      await issueReviewHandoff(db(), {
        customDomains: true,
        artifactId: plain.artifactId,
        userId: plain.owner.id,
        authSessionId: await session(plain.owner.id),
        now: NOW,
        contentDomain: CONTENT,
      }),
    );
    expect(plainCode.host).toBe(`${plain.artifactId}.${CONTENT}`);
  });

  it("share links open on the active custom host and their codes redeem only there", async () => {
    const { owner, artifactId, hostname, dev } = await withDomain();
    const { token } = value(
      await createShareLink(db(), {
        userId: owner.id,
        artifactId,
        label: "Board",
        expiresAt: null,
        now: NOW,
      }),
    );
    const opened = await openShareLink([db()], {
      customDomains: true,
      token,
      now: NOW,
      contentDomain: CONTENT,
    });
    if (opened.kind !== "opened") throw new Error("not opened");
    expect(opened.host).toBe(hostname);
    const redeem = (on: string) =>
      redeemShareHandoff(db(), { code: opened.code, artifactId, host: on, devHost: dev, now: NOW });
    expect((await redeem(dev)).ok).toBe(false);
    expect((await redeem(hostname)).ok).toBe(true);
    // Removing the domain sends the next opening to `.dev`.
    value(await removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW }));
    const again = await openShareLink([db()], {
      customDomains: true,
      token,
      now: NOW,
      contentDomain: CONTENT,
    });
    expect(again.kind === "opened" && again.host).toBe(dev);
  });
});

describe("the downgrade notice", () => {
  beforeEach(async () => {
    await db().delete(schema.customDomains);
    await db().delete(schema.outbox);
    await env.DB.exec("DELETE FROM email_counters; DELETE FROM email_suppressions");
  });

  /** An owner whose Team plan ended a day ago, with three domains (oldest first), in the grace. */
  async function lapsed() {
    const fake = new FakeDomains();
    const owner = await user();
    await grantPlan(owner.id, "team");
    const names: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const name = await attach(fake, owner.id, (await publishSite(owner.id)).artifactId);
      await db()
        .update(schema.customDomains)
        .set({ verifiedAt: NOW + i })
        .where(eq(schema.customDomains.hostname, name));
      names.push(name);
    }
    await grantPlan(owner.id, "team", { validUntil: NOW - DAY });
    return { owner, names };
  }

  function notifier() {
    const sent: Parameters<DomainNotifier["send"]>[0][] = [];
    const send: DomainNotifier = {
      async send(notice) {
        sent.push(notice);
      },
    };
    return { sent, send };
  }

  async function jobs() {
    return db().select().from(schema.outbox).where(eq(schema.outbox.topic, "domain_notice"));
  }

  it("is scheduled once per detach time, during the grace, for the domains at risk", async () => {
    const { owner, names } = await lapsed();
    expect(await scheduleDomainNotices(db(), NOW)).toBe(1);
    expect(await scheduleDomainNotices(db(), NOW)).toBe(0);
    const [job] = await jobs();
    expect(job?.subject).toBe(owner.id);
    // The Team plan ended, so the free plan allows none: all three stop after the grace.
    expect(job?.payload).toEqual({ hostnames: names, detachAt: NOW - DAY + 7 * DAY });
    expect((await domainRow(names[0] as string))?.noticeFor).toBe(NOW + 6 * DAY);
  });

  it("emails the owner, counts it and skips once the plan is renewed", async () => {
    const { owner, names } = await lapsed();
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    const { sent, send } = notifier();
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "domain_notice" }, NOW, {
        domainNotifier: send,
      }),
    ).toBe("done");
    expect(sent).toEqual([
      { to: owner.email, hostnames: names, detachAt: NOW + 6 * DAY, limit: 0, locale: null },
    ]);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(1);
    // The job was claimed: a second delivery does nothing.
    expect(await sendDomainNotice(db(), job, NOW, send)).toBe("done");
    expect(sent).toHaveLength(1);

    // Renewed before the job ran: nothing is sent.
    const second = await lapsed();
    await db().delete(schema.customDomains).where(eq(schema.customDomains.ownerId, owner.id));
    await scheduleDomainNotices(db(), NOW);
    const [next] = await jobs();
    if (!next) throw new Error("no job");
    await grantPlan(second.owner.id, "team");
    expect(await sendDomainNotice(db(), next, NOW, send)).toBe("stale");
    expect(sent).toHaveLength(1);
  });

  it("skips suppressed addresses, stops at the email capacity and puts a failed send back", async () => {
    const { owner } = await lapsed();
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    const failing: DomainNotifier = {
      async send() {
        throw new Error("email delivery failed");
      },
    };
    await expect(sendDomainNotice(db(), job, NOW, failing)).rejects.toThrow(
      "email delivery failed",
    );
    const [back] = await jobs();
    expect(back?.subject).toBe(owner.id);
    // Suppressed: nothing sent, nothing put back.
    await suppressEmail(db().global, { email: owner.email, reason: "hard_bounce", now: NOW });
    const { sent, send } = notifier();
    expect(await sendDomainNotice(db(), back as NonNullable<typeof back>, NOW, send)).toBe("stale");
    expect(sent).toEqual([]);
  });

  it("stops before the cycle's emails run out", async () => {
    await lapsed();
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    // The whole cycle's sign-in emails are spent: notices stop first.
    await db()
      .insert(schema.emailCounters)
      .values({ day: Date.UTC(2026, 10, 8), sent: 20_000 });
    const { sent, send } = notifier();
    expect(await sendDomainNotice(db(), job, NOW, send)).toBe("stale");
    expect(sent).toEqual([]);
  });

  it("leaves out domains already detaching and ones removed before the job runs", async () => {
    const { names } = await lapsed();
    await db()
      .update(schema.customDomains)
      .set({ state: "detaching" })
      .where(eq(schema.customDomains.hostname, names[2] as string));
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    expect(job.payload).toMatchObject({ hostnames: names.slice(0, 2) });
    await db()
      .delete(schema.customDomains)
      .where(eq(schema.customDomains.hostname, names[0] as string));
    const { sent, send } = notifier();
    expect(await sendDomainNotice(db(), job, NOW, send)).toBe("done");
    expect(sent.map((notice) => notice.hostnames)).toEqual([[names[1]]]);
  });

  it("schedules nothing for an owner whose domains are all detaching", async () => {
    await lapsed();
    await db().update(schema.customDomains).set({ state: "detaching" });
    expect(await scheduleDomainNotices(db(), NOW)).toBe(0);
    expect(await jobs()).toEqual([]);
  });

  it("logs only the reason it skips: a bad payload, an owner with nothing at risk, a provider suppression", async () => {
    const { owner } = await lapsed();
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const reasons = () =>
      log.mock.calls.map(
        (call) => JSON.parse(String(call[0])) as { event: string; reason: string },
      );
    const { sent, send } = notifier();
    try {
      const put = async (row: Partial<typeof job>) => {
        const [inserted] = await db()
          .insert(schema.outbox)
          .values({ ...job, id: undefined, ...row })
          .returning();
        return inserted as typeof job;
      };
      expect(
        await sendDomainNotice(db(), await put({ payload: { hostnames: [] } }), NOW, send),
      ).toBe("stale");
      // A payload stored as text reads the same as one stored as JSON.
      const text = await put({ payload: JSON.stringify(job.payload) });
      expect(
        await sendDomainNotice(db(), { ...text, payload: JSON.stringify(job.payload) }, NOW, send),
      ).toBe("done");
      expect(sent).toHaveLength(1);
      expect(await sendDomainNotice(db(), await put({ subject: "nobody" }), NOW, send)).toBe(
        "stale",
      );
      const refused: DomainNotifier = {
        async send() {
          throw new RecipientSuppressedError();
        },
      };
      expect(await sendDomainNotice(db(), job, NOW, refused)).toBe("stale");
      expect(await isEmailSuppressed(db().global, owner.email, NOW)).toBe(true);
      expect(await jobs()).toEqual([]);
      expect(reasons()).toEqual([
        { event: "domain_notice_skipped", reason: "renewed" },
        { event: "domain_notice_skipped", reason: "renewed" },
        { event: "domain_notice_skipped", reason: "suppressed" },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("logs the capacity as the reason when the cycle's emails run out", async () => {
    await lapsed();
    await scheduleDomainNotices(db(), NOW);
    const [job] = await jobs();
    if (!job) throw new Error("no job");
    await db()
      .insert(schema.emailCounters)
      .values({ day: Date.UTC(2026, 10, 8), sent: 20_000 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await sendDomainNotice(db(), job, NOW, notifier().send)).toBe("stale");
      expect(log.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
        { event: "domain_notice_skipped", reason: "capacity" },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the switch decides every host the app sends to", () => {
  it("names only `.dev` while off, with an active domain in the tables, and again after a rollback", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    const dev = `${artifactId}.${CONTENT}`;
    const authSessionId = await session(owner.id);
    const { token } = value(
      await createShareLink(db(), {
        userId: owner.id,
        artifactId,
        label: "Board",
        expiresAt: null,
        now: NOW,
      }),
    );
    const hosts = async (customDomains: boolean) => {
      const read = await issueReadHandoff(db(), {
        customDomains,
        confirmed: false,
        artifactId,
        userId: owner.id,
        authSessionId,
        state: crypto.randomUUID().replaceAll("-", "").padEnd(43, "a"),
        now: NOW,
        requestedHost: hostname,
        contentDomain: CONTENT,
      });
      const review = value(
        await issueReviewHandoff(db(), {
          customDomains,
          artifactId,
          userId: owner.id,
          authSessionId,
          now: NOW,
          contentDomain: CONTENT,
        }),
      );
      const link = await openShareLink([db()], {
        customDomains,
        token,
        now: NOW,
        contentDomain: CONTENT,
      });
      const viewer = value(
        await getViewerArtifact(db(), { customDomains, artifactId, userId: owner.id, now: NOW }),
      );
      return {
        read: read.ok ? read.value.host : "refused",
        review: review.host,
        link: link.kind === "opened" ? link.host : link.kind,
        viewer: viewer.customHost,
      };
    };
    const on = { read: hostname, review: hostname, link: hostname, viewer: hostname };
    // Off: a read entry asking for the custom host is refused like any unknown host.
    const off = { read: "refused", review: dev, link: dev, viewer: null };
    expect(await hosts(true)).toEqual(on);
    expect(await hosts(false)).toEqual(off);
    expect(await hosts(true)).toEqual(on);
  });
});

describe("an artifact every signed-in account reads", () => {
  async function authenticated() {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "authenticated" })
      .where(eq(schema.artifacts.id, artifactId));
    const visitor = await user();
    return { owner, artifactId, hostname, visitor, dev: `${artifactId}.${CONTENT}` };
  }

  it("asks the visitor to confirm before a read code goes to the custom host", async () => {
    const { artifactId, hostname, visitor, dev } = await authenticated();
    const authSessionId = await session(visitor.id);
    const input = (requestedHost: string | null, confirmed: boolean) => ({
      customDomains: true,
      confirmed,
      artifactId,
      userId: visitor.id,
      authSessionId,
      state: "c".repeat(43),
      now: NOW,
      requestedHost,
      contentDomain: CONTENT,
    });
    expect(await readEntryConfirmation(db(), input(hostname, false))).toBe(hostname);
    const missing = await issueReadHandoff(db(), {
      ...input(null, false),
      artifactId: "abcdefghij",
    });
    expect(await issueReadHandoff(db(), input(hostname, false))).toEqual(missing);
    expect(
      await db().select().from(schema.readHandoffs).where(eq(schema.readHandoffs.host, hostname)),
    ).toEqual([]);
    expect(value(await issueReadHandoff(db(), input(hostname, true))).host).toBe(hostname);
    // The `.dev` entry is as before: no confirmation, no read.
    expect(await readEntryConfirmation(db(), input(null, false))).toBeNull();
    expect(value(await issueReadHandoff(db(), input(null, false))).host).toBe(dev);
    // Off, or for a host that is not the artifact's, there is nothing to confirm.
    expect(
      await readEntryConfirmation(db(), { ...input(hostname, false), customDomains: false }),
    ).toBeNull();
    expect(await readEntryConfirmation(db(), input("evil.example.com", false))).toBeNull();
  });

  it("keeps the viewer's frame and review codes on `.dev`, which open with no click", async () => {
    const { artifactId, visitor, dev } = await authenticated();
    const review = value(
      await issueReviewHandoff(db(), {
        customDomains: true,
        artifactId,
        userId: visitor.id,
        authSessionId: await session(visitor.id),
        now: NOW,
        contentDomain: CONTENT,
      }),
    );
    expect(review.host).toBe(dev);
    const viewer = value(
      await getViewerArtifact(db(), {
        customDomains: true,
        artifactId,
        userId: visitor.id,
        now: NOW,
      }),
    );
    expect(viewer.customHost).toBeNull();
  });

  it("asks nothing of a reader of a restricted artifact, whom the owner chose", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    expect(
      await readEntryConfirmation(db(), {
        customDomains: true,
        artifactId,
        userId: owner.id,
        now: NOW,
        requestedHost: hostname,
        contentDomain: CONTENT,
      }),
    ).toBeNull();
  });
});

describe("activation never shows a half state", () => {
  it("makes the row active before the artifact names the host", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    // Records the row's state at the moment the artifact takes the host.
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS seen_on_bind (state text); DELETE FROM seen_on_bind; CREATE TRIGGER record_bind AFTER UPDATE OF custom_host ON artifacts WHEN NEW.custom_host IS NOT NULL BEGIN INSERT INTO seen_on_bind SELECT state FROM custom_domains WHERE hostname = NEW.custom_host; END",
    );
    try {
      await attach(fake, owner.id, artifactId);
      const seen = await env.DB.prepare("SELECT state FROM seen_on_bind").all<{ state: string }>();
      expect(seen.results.map((row) => row.state)).toEqual(["active"]);
    } finally {
      await env.DB.exec("DROP TRIGGER record_bind; DROP TABLE seen_on_bind");
    }
  });

  it("binds an active row whose artifact never took the host, at the daily check", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    // A Worker stopped between the two writes.
    await db()
      .update(schema.artifacts)
      .set({ customHost: null })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    expect(await domainRow(hostname)).toMatchObject({ state: "active" });
    expect(await activeCustomHost(db(), artifactId, true)).toBe(hostname);
  });
});

describe("where the name points", () => {
  it("activates only while the name resolves to Portifact's target", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = host();
    fake.elsewhere.add(hostname);
    const claim = value(
      await addCustomDomain(regions(), fake, {
        userId: owner.id,
        artifactId,
        hostname,
        contentDomain: CONTENT,
        now: NOW,
      }),
    );
    fake.publishTxt(txtRecordName(hostname), txtRecordValue(claim.token));
    value(await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW }));
    fake.activate(hostname);
    const waiting = value(
      await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW }),
    );
    expect(waiting).toMatchObject({ state: "provisioning", problem: "cname_elsewhere" });
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
    // DNS that cannot be asked waits too.
    fake.elsewhere.delete(hostname);
    fake.failing.txt = true;
    await checkCustomDomains(dbs(), fake, NOW + 60_000);
    expect((await domainRow(hostname))?.state).toBe("provisioning");
    fake.failing.txt = false;
    const active = value(
      await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW }),
    );
    expect(active).toMatchObject({ state: "active", problem: null });
    expect(fake.pointingAsked).toContain(hostname);
  });

  it("detaches a repointed name after three daily checks in a row, apart from the TXT", async () => {
    const fake = new FakeDomains();
    const { owner, artifactId } = await owned();
    const hostname = await attach(fake, owner.id, artifactId);
    fake.elsewhere.add(hostname);
    // "Check again" shows it at once, without counting.
    const checked = value(
      await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW }),
    );
    expect(checked).toMatchObject({ state: "active", problem: "cname_elsewhere" });
    await checkCustomDomains(dbs(), fake, NOW + DAY);
    expect(await domainRow(hostname)).toMatchObject({
      missedPointChecks: 1,
      missedChecks: 0,
      problem: "cname_elsewhere",
    });
    // Pointed back: the count resets.
    fake.elsewhere.delete(hostname);
    await checkCustomDomains(dbs(), fake, NOW + 2 * DAY);
    expect(await domainRow(hostname)).toMatchObject({ missedPointChecks: 0, problem: null });
    fake.elsewhere.add(hostname);
    fake.failing.txt = true;
    await checkCustomDomains(dbs(), fake, NOW + 3 * DAY);
    expect((await domainRow(hostname))?.missedPointChecks).toBe(0);
    fake.failing.txt = false;
    for (const day of [4, 5]) await checkCustomDomains(dbs(), fake, NOW + day * DAY);
    expect(await domainRow(hostname)).toMatchObject({ state: "active", missedPointChecks: 2 });
    await checkCustomDomains(dbs(), fake, NOW + 6 * DAY);
    expect(await domainRow(hostname)).toMatchObject({
      state: "detaching",
      detachReason: "cname_elsewhere",
    });
    expect(await activeCustomHost(db(), artifactId, true)).toBeNull();
  });
});
