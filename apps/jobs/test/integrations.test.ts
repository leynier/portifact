// The jobs Worker's side of issue integrations (decision 0018): the queue consumer creates the
// issue through the network it is given (fake GitHub here; nothing leaves the test), without
// logging the credential, the title or the body; switched off it sends nothing; the schedule
// re-seals credentials of a rotated key.
import { createMessageBatch, env } from "cloudflare:test";
import type { JobMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { personalActor } from "@portifact/domain";
import {
  createIntegrationConnection,
  integrationKeys,
  requestThreadIssue,
} from "@portifact/services";
import { FakeIssueTrackers } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { runQueue, runScheduled } from "../src/index.ts";
import { integrationsEnabled, issueDepsFromEnv } from "../src/integrations.ts";

const NOW = Date.UTC(2026, 10, 10, 9);
const KEY = "test-only jobs integrations sealing key, long enough";
const NEXT_KEY = "the next test-only jobs integrations sealing key";
const TOKEN = "github_pat_jobs_suite_0123456789abcdefghijkl";
const db = () => regionsFromEnv(env).get("default").db;
const keyed = { ...env, INTEGRATIONS_KEY: KEY, INTEGRATIONS_ENABLED: "true" };

const GITHUB = {
  connection: {
    service: "github" as const,
    label: "Repo",
    credential: TOKEN,
    targets: ["acme/site"],
  },
  target: "acme/site",
};
const JIRA_ACCOUNT = "jira-bot@acme.example";
const JIRA_TOKEN = "ATATT3x-jobs-suite-test-only-jira-token-0123";
const CLOUD = "11223344-5566-4778-899a-abbccddeeff0";
const JIRA = {
  connection: {
    service: "jira" as const,
    label: "Jira",
    credential: JIRA_TOKEN,
    targets: ["ENG"],
    account: JIRA_ACCOUNT,
    site: "acme",
    cloudId: CLOUD,
  },
  target: "ENG",
};

async function requested(fake: FakeIssueTrackers, spec: typeof GITHUB | typeof JIRA = GITHUB) {
  const ownerId = `u_${crypto.randomUUID()}`;
  await db()
    .insert(schema.users)
    .values({
      id: ownerId,
      name: "Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan: "team", seats: 1, grantedBy: "test", updatedAt: NOW });
  const connection = await createIntegrationConnection(db(), {
    actor: personalActor(ownerId),
    connection: spec.connection,
    deps: {
      keys: await integrationKeys({ current: KEY }),
      service: { enabled: true },
      fetch: fake.fetch,
    },
    now: NOW,
  });
  if (!connection.ok) throw new Error(connection.message);
  const artifactId = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32],
  ).join("");
  const versionId = `ver_${crypto.randomUUID()}`;
  await db()
    .insert(schema.artifacts)
    .values({
      id: artifactId,
      ownerId,
      type: "site",
      name: "Plan",
      state: "active",
      annotations: "open",
      accessMode: "restricted",
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: versionId,
    artifactId,
    number: 1,
    authorId: ownerId,
    state: "committed",
    entrypoint: "index.html",
    publishedBytes: 10,
    committedAt: NOW,
  });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: versionId })
    .where(eq(schema.artifacts.id, artifactId));
  const threadId = crypto.randomUUID();
  const target = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });
  await db().insert(schema.annotationThreads).values({
    id: threadId,
    artifactId,
    versionId,
    ownerId,
    authorId: ownerId,
    target,
    targetBytes: target.length,
    path: "index.html",
    updatedAt: NOW,
  });
  const issue = await requestThreadIssue(db(), {
    userId: ownerId,
    artifactId,
    threadId,
    request: {
      connectionId: connection.value.id,
      target: spec.target,
      title: "A title that is never logged",
      include: { link: true, artifactName: true, quote: false, message: false },
    },
    idempotencyKey: crypto.randomUUID(),
    service: { enabled: true },
    now: NOW,
  });
  if (!issue.ok) throw new Error(issue.message);
  const [job] = await db()
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.subject, issue.value.id));
  if (!job) throw new Error("no job");
  return { issueId: issue.value.id, job, connectionId: connection.value.id };
}

function batchOf(job: { id: number }) {
  const body: JobMessage = { id: job.id, topic: "thread_issue" };
  return createMessageBatch("portifact-jobs", [{ id: "m0", timestamp: NOW, attempts: 1, body }]);
}

async function issueRow(id: string) {
  const [row] = await db().select().from(schema.threadIssues).where(eq(schema.threadIssues.id, id));
  return row;
}

describe("issues in the jobs Worker", () => {
  it("creates the issue through the given network, logging only the job", async () => {
    const fake = new FakeIssueTrackers().github(TOKEN, "octo-bot", ["acme/site"]);
    const { issueId, job } = await requested(fake);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), keyed, NOW, undefined, fake.fetch);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();
    expect(fake.issues).toHaveLength(1);
    expect(await issueRow(issueId)).toMatchObject({ state: "created", issueKey: "#1" });
    expect(lines).toContain("thread_issue");
    for (const secret of [TOKEN, "never logged", "github.com"]) expect(lines).not.toContain(secret);
  });

  it("creates a Jira issue through the gateway, logging no email, token or site", async () => {
    const fake = new FakeIssueTrackers()
      .jiraSite({ site: "acme", cloudId: CLOUD })
      .jira(JIRA_ACCOUNT, JIRA_TOKEN, {
        displayName: "Jira Bot",
        cloudId: CLOUD,
        projects: [{ key: "ENG", name: "Engineering" }],
      });
    const { issueId, job } = await requested(fake, JIRA);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), keyed, NOW, undefined, fake.fetch);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();
    expect(await issueRow(issueId)).toMatchObject({
      state: "created",
      issueKey: "ENG-1",
      issueUrl: "https://acme.atlassian.net/browse/ENG-1",
    });
    expect(fake.requests.at(-1)?.url).toBe(
      `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`,
    );
    for (const secret of [JIRA_TOKEN, JIRA_ACCOUNT, "never logged", "atlassian"]) {
      expect(lines).not.toContain(secret);
    }
  });

  it("sends nothing while switched off, and the request fails with a plain reason", async () => {
    const fake = new FakeIssueTrackers().github(TOKEN, "octo-bot", ["acme/site"]);
    const { issueId, job } = await requested(fake);
    const before = fake.requests.length;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runQueue(batchOf(job), { ...env, INTEGRATIONS_KEY: KEY }, NOW, undefined, fake.fetch);
    log.mockRestore();
    expect(fake.requests).toHaveLength(before);
    expect(await issueRow(issueId)).toMatchObject({ state: "failed", failure: "unavailable" });
  });

  it("is on only with the switch and a key", async () => {
    expect(integrationsEnabled({ INTEGRATIONS_ENABLED: "true", INTEGRATIONS_KEY: KEY })).toBe(true);
    for (const value of [undefined, "", "1", "TRUE"]) {
      expect(integrationsEnabled({ INTEGRATIONS_ENABLED: value, INTEGRATIONS_KEY: KEY })).toBe(
        false,
      );
    }
    expect(integrationsEnabled({ INTEGRATIONS_ENABLED: "true" })).toBe(false);
    const short = await issueDepsFromEnv({
      APP_ORIGIN: "https://app.portifact.test",
      INTEGRATIONS_ENABLED: "true",
      INTEGRATIONS_KEY: "too short",
    });
    expect(short.enabled).toBe(false);
    expect((await issueDepsFromEnv(keyed)).enabled).toBe(true);
  });

  it("re-seals credentials of a rotated key in the maintenance run", async () => {
    const fake = new FakeIssueTrackers().github(TOKEN, "octo-bot", ["acme/site"]);
    const { connectionId } = await requested(fake);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runScheduled(
      { ...env, INTEGRATIONS_KEY: NEXT_KEY, INTEGRATIONS_KEY_PREVIOUS: KEY },
      NOW,
      null,
      { relay: false },
    );
    log.mockRestore();
    expect(result.integrationKeysRewrapped).toBeGreaterThanOrEqual(1);
    const [row] = await db()
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId));
    expect(row?.keyId).toBe((await integrationKeys({ current: NEXT_KEY }))[0]?.id);
  });
});
