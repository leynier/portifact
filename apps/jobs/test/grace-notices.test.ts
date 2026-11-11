// Grace emails on the jobs Worker (decision 0022, third delivery): the email links the space's
// "Download your data" page, the `portifact export` command and the plan request, names the
// workspace only in the default region (decision 0005), carries no unsubscribe link, and the queue
// runs a `plan_grace_notice` job end to end, once, in each region.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { PLAN_GRACE_MS, PLANS } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace, RecipientSuppressedError } from "@portifact/services";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { graceEmail, graceNotifierFromEnv, NOTICE_SENDER } from "../src/notices.ts";

const DAY = 86_400_000;
const UNTIL = Date.UTC(2027, 0, 10, 12);
const regions = () => regionsFromEnv(env);

type Sent = Parameters<SendEmail["send"]>[0] & { headers?: Record<string, string> };

function fakeEmail(error?: unknown) {
  const sent: Sent[] = [];
  const binding = {
    async send(message: Sent) {
      if (error) throw error;
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

const notice = {
  locale: null,
  moment: "two_weeks" as const,
  until: UNTIL,
  plan: "team" as const,
  kinds: [{ kind: "versions" as const, count: 12, from: UNTIL }],
  space: { slug: "engines", name: "Analytical Engines" },
};

describe("grace email", () => {
  it("names the workspace in the default region and links its data page, export and request", () => {
    const email = graceEmail(env, notice);
    expect(email.text).toContain("Space: Analytical Engines");
    expect(email.text).toContain("https://app.portifact.com/data?workspace=engines");
    expect(email.text).toContain("portifact export ./portifact-export --workspace engines");
    expect(email.text).toContain(
      "mailto:hello@portifact.com?subject=Portifact%20Team%20plan%20request",
    );
    expect(email.html).toContain("Ask for Team again");
    expect(email).not.toHaveProperty("headers");
  });

  it("never names an EU workspace, the subject included, and still links it", () => {
    const email = graceEmail(env, notice, "eu");
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("Analytical Engines");
    }
    expect(email.text).toContain("Space: One of your workspaces");
    expect(email.text).toContain("https://app.portifact.com/data?workspace=engines");
  });

  it("links a personal space's page and export without a workspace", () => {
    const email = graceEmail(env, { ...notice, space: null, locale: "es" });
    expect(email.text).toContain("https://app.portifact.com/data\n");
    expect(email.text).toContain("  portifact export ./portifact-export\n");
    expect(email.html).toContain('lang="es"');
  });

  it("never copies a slug that is not one into the command", () => {
    const email = graceEmail(env, { ...notice, space: { slug: "x; rm -rf ~", name: "X" } });
    expect(email.text).not.toContain("rm -rf");
    expect(email.text).toContain("--workspace <slug>");
  });
});

describe("graceNotifierFromEnv", () => {
  it("sends from the no-reply address and hides provider errors", async () => {
    const { binding, sent } = fakeEmail();
    await graceNotifierFromEnv({ ...env, EMAIL: binding }).send({
      to: "ada@example.com",
      ...notice,
    });
    expect(sent[0]?.from).toEqual(NOTICE_SENDER);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.headers).toBeUndefined();
    const refused = fakeEmail({ code: "E_RECIPIENT_SUPPRESSED" });
    await expect(
      graceNotifierFromEnv({ ...env, EMAIL: refused.binding }).send({ to: "a@b.c", ...notice }),
    ).rejects.toBeInstanceOf(RecipientSuppressedError);
    const failing = fakeEmail(new Error("rate limited for ada@example.com"));
    await expect(
      graceNotifierFromEnv({ ...env, EMAIL: failing.binding }).send({ to: "a@b.c", ...notice }),
    ).rejects.toThrow(/^email delivery failed$/);
  });
});

describe("grace emails end to end", () => {
  async function admin() {
    const id = `u_${crypto.randomUUID()}`;
    await regions()
      .global.insert(schema.users)
      .values({
        id,
        name: "Ada",
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(Date.now() - 60 * DAY),
        updatedAt: new Date(),
      });
    return { id, email: `${id}@example.test` };
  }

  /** A workspace holding a Team plan's drop since yesterday, with its start email queued. */
  async function holdingWorkspace(region: "default" | "eu") {
    const person = await admin();
    const ws = await createWorkspace(regions().global, {
      slug: `g-${crypto.randomUUID().slice(0, 8)}`,
      name: "Grace team",
      adminUserId: person.id,
      now: Date.now(),
      region,
    });
    if (!ws.ok) throw new Error(ws.message);
    const from = Date.now() - DAY;
    const until = from + PLAN_GRACE_MS;
    const { limits } = PLANS.team;
    await regions()
      .global.insert(schema.ownerPlans)
      .values({
        ownerId: ws.value.id,
        plan: "free",
        seats: 1,
        grantedBy: "test",
        updatedAt: from,
        grace: JSON.stringify([
          {
            plan: "team",
            reason: "removed",
            from,
            until,
            limits: {
              archiveMonths: limits.archiveMonths,
              retainedPreviousVersions: limits.retainedPreviousVersions,
              previousVersionRetentionDays: limits.previousVersionRetentionDays,
              accessLogRetentionDays: limits.accessLogRetentionDays,
              auditRetentionDays: limits.auditRetentionDays,
            },
            features: ["pin"],
          },
        ]),
      });
    const outbox = regions().get(region).db;
    const [job] = await outbox
      .insert(schema.outbox)
      .values({
        topic: "plan_grace_notice",
        payload: { from, until, moment: "start" },
        availableAt: from,
        subject: ws.value.id,
      })
      .returning({ id: schema.outbox.id });
    return { person, job: job as { id: number } };
  }

  async function deliver(testEnv: Env, id: number, region: "default" | "eu", messageId: string) {
    const batch = createMessageBatch("portifact-jobs", [
      {
        id: messageId,
        timestamp: new Date(),
        attempts: 1,
        body: { id, topic: "plan_grace_notice", ...(region === "eu" ? { region } : {}) },
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, testEnv);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([messageId]);
  }

  it("emails the default region's admins once, naming the workspace", async () => {
    const { person, job } = await holdingWorkspace("default");
    const { binding, sent } = fakeEmail();
    const testEnv: Env = { ...env, EMAIL: binding };
    await deliver(testEnv, job.id, "default", "g1");
    await deliver(testEnv, job.id, "default", "g2");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(person.email);
    expect(sent[0]?.text).toContain("Space: Grace team");
  });

  it("emails an EU workspace's admins from the EU outbox without its name", async () => {
    const { person, job } = await holdingWorkspace("eu");
    const { binding, sent } = fakeEmail();
    await deliver({ ...env, EMAIL: binding }, job.id, "eu", "g3");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(person.email);
    const email = sent[0] as Sent & { subject: string; text: string; html: string };
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("Grace team");
    }
    expect(email.text).toContain("Space: One of your workspaces");
  });
});
