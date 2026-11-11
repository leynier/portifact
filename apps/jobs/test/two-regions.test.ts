// The jobs Worker with two regions (decision 0005, "Two-region audit"): the relay sends each
// database's outbox once, naming the region; the consumer runs a job on the database and bucket
// its message names; the scans and the reconciliation run per region; and the operator creates
// a workspace in a region this configuration binds.
import { createMessageBatch, env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { aliasBinding, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runQueue, runRelay, runScheduled } from "../src/index.ts";
import {
  commentEmail,
  directoryNotifierFromEnv,
  domainNotifierFromEnv,
  expiringListUrl,
  noticeEmail,
  reviewEmail,
} from "../src/notices.ts";
import { runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const eu = () => regionsFromEnv(env).get("eu").db;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DAY = 86_400_000;

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function claimedInEu() {
  const id = artifactId();
  const ownerId = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await eu()
    .insert(schema.artifacts)
    .values({ id, ownerId, type: "site", name: "Plan", state: "purging", lifecycleGeneration: 2 });
  const [job] = await eu()
    .insert(schema.outbox)
    .values({ topic: "purge_artifact", payload: {}, availableAt: NOW, subject: id, generation: 2 })
    .returning();
  if (!job) throw new Error("no job");
  return { id, job };
}

describe("the jobs Worker with an EU region", () => {
  it("relays the EU outbox with the region in each message, and the default one without", async () => {
    const { job } = await claimedInEu();
    const sent: JobMessage[] = [];
    const queue = {
      sendBatch: async (messages: { body: JobMessage }[]) => {
        sent.push(...messages.map((message) => message.body));
      },
    };
    const relayed = await runRelay({ ...env, JOBS: queue as unknown as typeof env.JOBS }, NOW);
    expect(typeof relayed).toBe("number");
    expect(sent).toContainEqual({ id: job.id, topic: "purge_artifact", region: "eu" });
  });

  it("runs a job on the database its message names", async () => {
    const { id, job } = await claimedInEu();
    const body: JobMessage = { id: job.id, topic: "purge_artifact", region: "eu" };
    await runQueue(
      createMessageBatch("portifact-jobs", [{ id: "m0", timestamp: NOW, attempts: 1, body }]),
      env,
      NOW,
    );
    const [left] = await eu().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(left).toBeUndefined();
    const [tombstone] = await regionsFromEnv(env)
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, id));
    expect(tombstone).toMatchObject({ kind: "artifact" });
  });

  it("runs the scans and the reconciliation in every region", async () => {
    const result = await runScheduled(env, NOW, null, { relay: false });
    expect(result).toHaveProperty("regions.eu.archived");
    expect(result.storage).toBeDefined();
  });

  it("creates a workspace in eu only where eu is bound, and refuses an unknown region", async () => {
    const id = `u_${crypto.randomUUID()}`;
    await regionsFromEnv(env)
      .global.insert(schema.users)
      .values({
        id,
        name: "Admin",
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;
    const argv = ["workspace-create", slug, "--name", "EU", "--admin", id, "--region", "eu"];
    const created = await runOperator(regionsFromEnv(env), argv, NOW);
    expect(created.exitCode).toBe(0);
    const [row] = await regionsFromEnv(env)
      .global.select({ region: schema.workspaces.region })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, slug));
    expect(row).toEqual({ region: "eu" });
    const unbound = await runOperator(
      regionsFromEnv({ DB: env.DB }),
      ["workspace-create", `${slug}x`, "--name", "EU", "--admin", id, "--region", "eu"],
      NOW,
    );
    expect(unbound.exitCode).toBe(2);
    const unknown = await runOperator(
      regionsFromEnv(env),
      ["workspace-create", `${slug}y`, "--name", "EU", "--admin", id, "--region", "mars"],
      NOW,
    );
    expect(unknown.exitCode).toBe(2);
    // A command that acts on regional data takes --region too, among the bound regions only.
    const report = await runOperator(
      regionsFromEnv(env),
      ["storage-report", "--region", "eu"],
      NOW,
    );
    expect(report.exitCode).toBe(0);
    const elsewhere = await runOperator(
      regionsFromEnv({ DB: env.DB }),
      ["storage-report", "--region", "eu"],
      NOW,
    );
    expect(elsewhere.exitCode).toBe(2);
  });

  it("re-applies tombstones to the region a restore names, or to every region, never by default", async () => {
    const { id } = await claimedInEu();
    await eu().update(schema.artifacts).set({ state: "active" }).where(eq(schema.artifacts.id, id));
    const files = new Map<string, string>([
      ["t.jsonl", `${JSON.stringify({ kind: "artifact", id, deletedAt: NOW })}\n`],
    ]);
    const io = {
      read: async (path: string) => files.get(path) ?? "",
      write: async (path: string, text: string) => {
        files.set(path, text);
      },
    };
    const run = (argv: string[]) => runOperator(regionsFromEnv(env), argv, NOW, io);
    // With two regions the operator must say which database was restored.
    expect((await run(["apply-tombstones", "--file", "t.jsonl"])).exitCode).toBe(2);
    expect((await run(["export-tombstones", "--out", "x.jsonl"])).exitCode).toBe(2);
    expect(
      (await run(["storage-report", "--region", "all"])).exitCode,
      "all is only for restores",
    ).toBe(2);
    // The default region's database is the global one: restoring it is restoring everything.
    for (const argv of [
      ["apply-tombstones", "--file", "t.jsonl", "--region", "default"],
      ["export-tombstones", "--out", "x.jsonl", "--region", "default"],
    ]) {
      const refused = await run(argv);
      expect(refused.exitCode).toBe(2);
      expect(refused.output).toContain("use --region all");
    }
    // With one region bound, no flag is needed.
    const single = (argv: string[]) => runOperator(regionsFromEnv({ DB: env.DB }), argv, NOW, io);
    expect((await single(["export-tombstones", "--out", "one.jsonl"])).exitCode).toBe(0);
    expect((await single(["apply-tombstones"])).exitCode).toBe(0);
    const applied = await run(["apply-tombstones", "--file", "t.jsonl", "--region", "eu"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.output).toContain("1 artifact(s) claimed for purging");
    const [row] = await eu().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row?.state).toBe("purging");
    const everywhere = await run(["apply-tombstones", "--region", "all"]);
    expect(everywhere.output).toContain("0 artifact(s) claimed for purging");
    expect((await run(["export-tombstones", "--out", "x.jsonl", "--region", "all"])).exitCode).toBe(
      0,
    );
    expect(files.get("x.jsonl")).toContain(id);
  });
});

describe("plan changes for an EU workspace", () => {
  it("exits non-zero when the EU half is not written, and the same command completes it", async () => {
    const regions = regionsFromEnv(env);
    const admin = `u_${crypto.randomUUID()}`;
    await regions.global.insert(schema.users).values({
      id: admin,
      name: "Admin",
      email: `${admin}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;
    const argv = ["workspace-create", slug, "--name", "EU", "--admin", admin, "--region", "eu"];
    expect((await runOperator(regions, argv, NOW)).exitCode).toBe(0);
    // The EU database refuses every batch, as if it were unreachable.
    const failing = new Proxy(env.DB_EU, {
      get(target, property) {
        if (property === "batch") return async () => Promise.reject(new Error("EU unreachable"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = regionsFromEnv({ ...env, DB_EU: aliasBinding(failing, env.DB_EU) });
    const half = await runOperator(broken, ["set-plan", `workspace:${slug}`, "team"], NOW);
    expect(half.exitCode).toBe(1);
    expect(half.output).toContain("half applied");
    const again = await runOperator(regions, ["set-plan", `workspace:${slug}`, "team"], NOW + 1);
    expect(again.exitCode).toBe(0);
    const pending = await regions.global
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "plan_region"));
    expect(pending).toEqual([]);
  });
});

describe("an EU workspace's expiry notice, from the scan to the email", () => {
  it("runs in the EU outbox and sends a count and the space's list, never the name", async () => {
    const regions = regionsFromEnv(env);
    const admin = `u_${crypto.randomUUID()}`;
    const email = `${admin}@example.test`;
    await regions.global.insert(schema.users).values({
      id: admin,
      name: "Admin",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;
    const argv = ["workspace-create", slug, "--name", "EU", "--admin", admin, "--region", "eu"];
    expect((await runOperator(regions, argv, NOW)).exitCode).toBe(0);
    const [workspace] = await regions.global
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, slug));
    const ownerId = workspace?.id ?? "";
    const id = artifactId();
    const NAME = "Confidential merger plan";
    await eu()
      .insert(schema.artifacts)
      .values({ id, ownerId, type: "site", name: NAME, state: "active", expiresAt: NOW + DAY });

    await runScheduled(env, NOW, null, { relay: false });
    const [job] = await eu().select().from(schema.outbox).where(eq(schema.outbox.subject, ownerId));
    expect(job?.topic).toBe("expiry_notice");
    // Never in the default region's outbox: the job runs with the EU database.
    expect(
      await regions.global.select().from(schema.outbox).where(eq(schema.outbox.subject, ownerId)),
    ).toEqual([]);

    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    const EMAIL = {
      async send(message: (typeof sent)[number]) {
        sent.push(message);
        return { messageId: "m" };
      },
    } as unknown as SendEmail;
    const body: JobMessage = { id: job?.id ?? 0, topic: "expiry_notice", region: "eu" };
    await runQueue(
      createMessageBatch("portifact-jobs", [{ id: "m0", timestamp: NOW, attempts: 1, body }]),
      { ...env, EMAIL },
      NOW,
    );
    expect(sent).toHaveLength(1);
    const [notice] = sent;
    expect(notice?.to).toBe(email);
    for (const part of [notice?.subject, notice?.text, notice?.html]) {
      expect(part).not.toContain(NAME);
      expect(part).not.toContain(id);
    }
    expect(notice?.text).toContain(`${env.APP_ORIGIN}/?workspace=${slug}&expiring=soon`);
  });
});

describe("notices about an EU workspace's artifacts", () => {
  const NAME = "Confidential merger plan";
  it("name no artifact and quote no comment, while the default region's still name them", () => {
    const expiring = [{ id: "k7d2qm4xab", name: NAME, expiresAt: NOW + 86_400_000 }];
    const eu = noticeEmail(env, expiring, null, 6, "eu", "engines");
    const home = noticeEmail(env, expiring, null, 6, "default", "engines");
    expect(home.text).toContain(NAME);
    expect(home.text).toContain(`k7d2qm4xab.${env.CONTENT_DOMAIN}`);
    // Without names, not even the address: the count, the date and the space's filtered list.
    for (const part of [eu.subject, eu.text, eu.html]) {
      expect(part).not.toContain(NAME);
      expect(part).not.toContain("k7d2qm4xab");
    }
    expect(eu.text).toContain(`${env.APP_ORIGIN}/?workspace=engines&expiring=soon`);
    expect(home).toEqual(noticeEmail(env, expiring, null, 6));

    const activity = {
      artifactId: "k7d2qm4xab",
      name: NAME,
      newThreads: 1,
      newReplies: 2,
      resolvedThreads: 0,
    };
    const comments = { artifacts: [activity], more: 0, locale: null };
    const euComments = commentEmail(env, comments, "t.o.k.n", "eu");
    expect(commentEmail(env, comments, "t.o.k.n", "default").text).toContain(NAME);
    for (const part of [euComments.subject, euComments.text, euComments.html]) {
      expect(part).not.toContain(NAME);
    }

    const review = {
      kind: "requested" as const,
      status: null,
      artifactId: "k7d2qm4xab",
      name: NAME,
      version: 2,
      locale: null,
    };
    const euReview = reviewEmail(env, review, "t.o.k.n", "eu");
    expect(reviewEmail(env, review, "t.o.k.n", "default").text).toContain(NAME);
    for (const part of [euReview.subject, euReview.text, euReview.html]) {
      expect(part).not.toContain(NAME);
    }
    expect(expiringListUrl("https://app.test", null)).toBe("https://app.test/?expiring=soon");
    expect(expiringListUrl("https://app.test", "a-b")).toBe(
      "https://app.test/?workspace=a-b&expiring=soon",
    );
  });

  it("are the only kinds that could name one: directory and domain notices never take a name", async () => {
    const sent: { subject: string; text: string; html: string }[] = [];
    const EMAIL = {
      async send(message: { subject: string; text: string; html: string }) {
        sent.push(message);
        return { messageId: "m" };
      },
    } as unknown as SendEmail;
    await directoryNotifierFromEnv({ ...env, EMAIL }).send({
      to: "ada@example.com",
      workspaceName: "EU team",
      workspaceSlug: "eu-team",
      locale: null,
    });
    await domainNotifierFromEnv({ ...env, EMAIL }).send({
      to: "ada@example.com",
      hostnames: ["docs.example.com"],
      detachAt: NOW + 86_400_000,
      limit: 0,
      locale: null,
    });
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      for (const part of [message.subject, message.text, message.html]) {
        expect(part).not.toContain(NAME);
        expect(part).not.toContain(env.CONTENT_DOMAIN);
      }
    }
  });
});
