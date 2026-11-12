// Jira Cloud connections and issues (decision 0018, "Jira"): the check on Atlassian's gateway (the
// site proven by serverInfo, the identity, each project and its issue type), the email sealed with
// the token and never shown, the Atlassian document the job sends, the browse link Portifact
// builds, the lookup of a lost issue by JQL, every refusal, and the calls each step costs, against
// the real D1 schema in workerd and the fake Jira in @portifact/services/testing. Nothing here
// reaches Atlassian.
import { env } from "cloudflare:test";
import { type AnnotationTarget, INTEGRATION_LIMITS, type JobMessage } from "@portifact/contracts";
import { globalDb, regionalDb, schema } from "@portifact/db";
import { type Actor, openJiraCredential, personalActor } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount } from "../src/account-data.ts";
import { createAnnotationThread, type HumanCheck } from "../src/annotations.ts";
import { integrationKeys, openCredential } from "../src/integration-keys.ts";
import {
  createIntegrationConnection,
  type IntegrationDeps,
  listIntegrationChoices,
  storedTargets,
  testIntegrationConnection,
  updateIntegrationConnection,
} from "../src/integrations.ts";
import { runJob } from "../src/outbox.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";
import { requestThreadIssue, type ThreadIssueDeps } from "../src/thread-issues.ts";
import { DAY, db, grantPlan, NOW, value } from "./fixtures.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const QUOTED: AnnotationTarget = {
  schema: 1,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact: "Ship [~accountid:1] on {panel}Friday{panel}", prefix: "", suffix: "" },
    position: { start: 0, end: 20 },
  },
};
const KEY_TEXT = "test-only integrations sealing key, long enough to use";
const ACCOUNT = "jira-bot@acme.example";
const TOKEN = "ATATT3xFfGF0-test-only-jira-token-not-real-0123456789";
const CLOUD = "11223344-5566-4778-899a-abbccddeeff0";
const OTHER_CLOUD = "99999999-5566-4778-899a-abbccddeeff0";
const HOSTILE =
  "@[Admin] [~accountid:5b10] [click|https://evil.test] !https://evil.test/a.png! {code}x{code}\n```\nh1. heading";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ON = { enabled: true };

function trackers() {
  return new FakeIssueTrackers()
    .jiraSite({ site: "acme", cloudId: CLOUD })
    .jiraSite({ site: "other", cloudId: OTHER_CLOUD })
    .jira(ACCOUNT, TOKEN, {
      displayName: "Jira Bot",
      cloudId: CLOUD,
      projects: [
        { key: "ENG", name: "Engineering" },
        {
          key: "EPIC",
          name: "Only epics",
          issueTypes: [{ id: "1", name: "Epic", hierarchyLevel: 1 }],
        },
      ],
    });
}

async function deps(fake: FakeIssueTrackers): Promise<IntegrationDeps> {
  return { keys: await integrationKeys({ current: KEY_TEXT }), service: ON, fetch: fake.fetch };
}

async function jobDeps(fake: FakeIssueTrackers): Promise<ThreadIssueDeps> {
  return {
    keys: await integrationKeys({ current: KEY_TEXT }),
    fetch: fake.fetch,
    appOrigin: "https://app.portifact.test",
    enabled: true,
  };
}

async function person() {
  const id = `u_${crypto.randomUUID()}`;
  await db()
    .global.insert(schema.users)
    .values({
      id,
      name: `Name ${id.slice(2, 6)}`,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id };
}

async function artifact(ownerId: string) {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  const version = `${id}_v1`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Q3 plan {color:red}x{color}",
      state: "active",
      annotations: "open",
      commentVisibility: "everyone",
      accessMode: "restricted",
      expiresAt: NOW + 30 * DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: version,
    artifactId: id,
    number: 1,
    authorId: ownerId,
    state: "committed",
    entrypoint: "index.html",
    publishedBytes: 10,
    committedAt: NOW,
  });
  await db()
    .insert(schema.versionFiles)
    .values({
      versionId: version,
      kind: "published",
      path: "index.html",
      ownerId,
      sha256: "a".repeat(64),
      size: 10,
      contentType: "text/html",
    });
  await db()
    .update(schema.artifacts)
    .set({ currentVersionId: version })
    .where(eq(schema.artifacts.id, id));
  return { id, version };
}

function connect(actor: Actor, fake: FakeIssueTrackers, overrides: Record<string, unknown> = {}) {
  return deps(fake).then((d) =>
    createIntegrationConnection(db(), {
      actor,
      connection: {
        service: "jira",
        label: "Jira",
        credential: TOKEN,
        targets: ["eng"],
        account: ACCOUNT,
        site: "https://acme.atlassian.net",
        cloudId: CLOUD,
        ...overrides,
      },
      deps: d,
      now: NOW,
    }),
  );
}

async function world(target?: AnnotationTarget) {
  const owner = await person();
  await grantPlan(owner.id, "team");
  const fake = trackers();
  const connection = value(await connect(personalActor(owner.id), fake));
  const a = await artifact(owner.id);
  const threadId = value(
    await createAnnotationThread(db(), {
      humanCheck: HUMAN,
      userId: owner.id,
      artifactId: a.id,
      versionId: a.version,
      target: target ?? { schema: 1, path: "index.html", anchor: { kind: "document" } },
      body: HOSTILE,
      now: NOW,
    }),
  ).id;
  return { owner, fake, connection, a, threadId };
}

type World = Awaited<ReturnType<typeof world>>;

function ask(w: World, include = { link: true, artifactName: true, quote: true, message: true }) {
  return requestThreadIssue(db(), {
    userId: w.owner.id,
    artifactId: w.a.id,
    threadId: w.threadId,
    request: {
      connectionId: w.connection.id,
      target: "ENG",
      title: "Fix `the` #1 header",
      include,
    },
    idempotencyKey: crypto.randomUUID(),
    service: ON,
    now: NOW,
  });
}

async function run(issueId: string, now: number, fake: FakeIssueTrackers) {
  const [job] = await db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "thread_issue"), eq(schema.outbox.subject, issueId)));
  if (!job) return "none";
  const message: JobMessage = { id: job.id, topic: "thread_issue" };
  return runJob(db(), env.ARTIFACTS, message, now, { issues: await jobDeps(fake) });
}

async function issueRow(id: string) {
  const [found] = await db()
    .select()
    .from(schema.threadIssues)
    .where(eq(schema.threadIssues.id, id));
  return found;
}

async function connectionRow(id: string) {
  const [found] = await db()
    .select()
    .from(schema.integrationConnections)
    .where(eq(schema.integrationConnections.id, id));
  return found;
}

const decoded = (header: string | undefined) => atob(String(header).replace(/^Basic /, ""));

describe("connecting Jira", () => {
  it("proves the site on the gateway, seals the email with the token and never shows the email", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const created = value(await connect(personalActor(owner.id), fake));
    expect(created).toMatchObject({
      service: "jira",
      site: "acme",
      identity: "Jira Bot",
      credentialHint: `…${TOKEN.slice(-4)}`,
      targets: [{ id: "ENG", name: "Engineering" }],
      usable: true,
    });
    // Three calls, all to the fixed gateway origin with the site named only by its cloud ID.
    const base = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${base}/serverInfo`,
      `GET ${base}/myself`,
      `GET ${base}/project/ENG`,
    ]);
    for (const request of fake.requests)
      expect(decoded(request.headers.authorization)).toBe(`${ACCOUNT}:${TOKEN}`);
    // The email is in the sealed credential only: not in the answer, the hint, the audit or logs.
    expect(JSON.stringify(created)).not.toContain(ACCOUNT);
    const stored = await connectionRow(created.id);
    expect(stored).toMatchObject({ site: "acme", cloudId: CLOUD });
    expect(JSON.stringify(stored)).not.toContain(ACCOUNT);
    const opened = await openCredential(
      await integrationKeys({ current: KEY_TEXT }),
      String(stored?.keyId),
      created.id,
      String(stored?.credentialBox),
    );
    expect(openJiraCredential(String(opened))).toEqual({ account: ACCOUNT, token: TOKEN });
    // The issue type checked with the project is kept for the job, never shown.
    expect(storedTargets(String(stored?.targets))).toEqual([
      { id: "ENG", name: "Engineering", issueType: "10001" },
    ]);
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, owner.id));
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["integration.connected", { service: "jira", targets: 1 }],
    ]);
    expect(JSON.stringify(events)).not.toContain(ACCOUNT);
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(exported.account.integrations).toEqual([
      {
        id: created.id,
        service: "jira",
        label: "Jira",
        site: "acme",
        identity: "Jira Bot",
        targets: ["Engineering"],
        createdAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(ACCOUNT);
    expect(JSON.stringify(exported)).not.toContain(TOKEN.slice(-12));
  });

  it("says in plain words what failed, never with the email, and stores nothing", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const cases: [Record<string, unknown>, string][] = [
      [{ site: "other.atlassian.net" }, "The cloud ID does not belong to that Jira site"],
      [{ cloudId: "00000000-0000-4000-8000-000000000000" }, "The cloud ID does not belong"],
      [{ cloudId: OTHER_CLOUD, site: "other" }, "Jira refused the email and API token"],
      [{ credential: `${TOKEN}x` }, "Jira refused the email and API token"],
      [{ account: "someone@acme.example" }, "Jira refused the email and API token"],
      [{ targets: ["OPS"] }, "cannot see the project OPS"],
      [{ targets: ["EPIC"] }, "no standard issue type"],
      [{ site: "acme.jira.com" }, "not a Jira Cloud site"],
      [{ site: "evil.com/x.atlassian.net" }, "not a Jira Cloud site"],
      [{ cloudId: "nope" }, "not an Atlassian cloud ID"],
      [{ account: undefined }, "needs the token's account email"],
      [{ targets: ["acme/site"] }, "is not a Jira project key"],
    ];
    for (const [overrides, message] of cases) {
      const result = await connect(actor, trackers(), overrides);
      expect(result).toMatchObject({ ok: false, code: "invalid_input" });
      expect(result.ok ? "" : result.message).toContain(message);
      expect(result.ok ? "" : result.message).not.toContain("@acme.example");
    }
    const rows = await db()
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.ownerId, owner.id));
    expect(rows).toEqual([]);
  });

  it("reads a gateway answer that names another site, a redirect and a slow server as failures", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const answers: [Response, string][] = [
      [Response.json({ baseUrl: "https://evil.atlassian.net" }), "does not belong"],
      [Response.json({ baseUrl: "https://jira.acme.example" }), "does not belong"],
      [
        new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
        "did not answer",
      ],
      [new Response("busy", { status: 503 }), "did not answer"],
      [Response.json({}, { status: 429, headers: { "retry-after": "5" } }), "limiting requests"],
    ];
    for (const [answer, message] of answers) {
      const fake = trackers().next(answer);
      const result = await connect(actor, fake);
      expect(result.ok ? "" : result.message).toContain(message);
      // Nothing after a failed site proof.
      expect(fake.requests).toHaveLength(1);
    }
  });

  it("changes the token only with its account's email, and re-checks new projects with the stored one", async () => {
    const w = await world();
    const actor = personalActor(w.owner.id);
    const d = await deps(w.fake);
    const update = (u: Record<string, unknown>) =>
      updateIntegrationConnection(db(), {
        actor,
        connectionId: w.connection.id,
        update: u,
        deps: d,
        now: NOW,
      });
    expect(await update({ credential: `${TOKEN}2` })).toMatchObject({
      ok: false,
      message: expect.stringContaining("email of the new token"),
    });
    w.fake.jira("second@acme.example", "ATATT-second-test-only-token-000000", {
      displayName: "Second Bot",
      cloudId: CLOUD,
      projects: [{ key: "ENG", name: "Engineering" }],
    });
    const before = w.fake.requests.length;
    expect(
      value(
        await update({
          credential: "ATATT-second-test-only-token-000000",
          account: "second@acme.example",
        }),
      ),
    ).toMatchObject({ identity: "Second Bot", credentialHint: "…0000" });
    expect(w.fake.requests.slice(before).map((r) => decoded(r.headers.authorization))).toEqual(
      Array(3).fill("second@acme.example:ATATT-second-test-only-token-000000"),
    );
    // New targets go through the stored (sealed) email and token.
    expect(await update({ targets: ["ENG", "OPS"] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("cannot see the project OPS"),
    });
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, w.owner.id));
    expect(JSON.stringify(events)).not.toContain("acme.example");
  });

  it("refuses an email for another service", async () => {
    const w = await world();
    w.fake.github("github_pat_test_only_token_for_jira_suite_0001", "octo", ["acme/site"]);
    const owner = personalActor(w.owner.id);
    const github = value(
      await createIntegrationConnection(db(), {
        actor: owner,
        connection: {
          service: "github",
          label: "GH",
          credential: "github_pat_test_only_token_for_jira_suite_0001",
          targets: ["acme/site"],
        },
        deps: await deps(w.fake),
        now: NOW,
      }),
    );
    expect(github.site).toBeNull();
    expect(
      await updateIntegrationConnection(db(), {
        actor: owner,
        connectionId: github.id,
        update: { credential: "github_pat_test_only_token_for_jira_suite_0002", account: ACCOUNT },
        deps: await deps(w.fake),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, message: "Only Jira takes an account email." });
  });

  it("stops linking issues to the stored site once serverInfo names another one", async () => {
    const w = await world();
    w.fake.jiraSite({ site: "acme-renamed", cloudId: CLOUD });
    const tested = value(
      await testIntegrationConnection(db(), {
        actor: personalActor(w.owner.id),
        connectionId: w.connection.id,
        deps: await deps(w.fake),
        now: NOW,
      }),
    );
    expect(tested).toMatchObject({ ok: false, problem: "site_mismatch" });
    expect((await connectionRow(w.connection.id))?.attention).not.toBeNull();
    expect(await connectionRow(w.connection.id)).toMatchObject({ attention: "site_mismatch" });
    // A second failing test writes no second event; a passing one clears the mark.
    await testIntegrationConnection(db(), {
      actor: personalActor(w.owner.id),
      connectionId: w.connection.id,
      deps: await deps(w.fake),
      now: NOW,
    });
    const failing = (
      await db().select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, w.owner.id))
    ).filter((e) => e.kind === "integration.failing");
    expect(failing.map((e) => e.detail)).toEqual([{ service: "jira", reason: "site_mismatch" }]);
    w.fake.jiraSite({ site: "acme", cloudId: CLOUD });
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor: personalActor(w.owner.id),
          connectionId: w.connection.id,
          deps: await deps(w.fake),
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(await connectionRow(w.connection.id)).toMatchObject({ attention: null });
  });

  it("saves a project's current issue type when the stored one is gone, and says so", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const project = {
      key: "ENG",
      name: "Engineering",
      issueTypes: [{ id: "10001", name: "Task", hierarchyLevel: 0 }],
    };
    const fake = trackers().jira(ACCOUNT, TOKEN, {
      displayName: "Jira Bot",
      cloudId: CLOUD,
      projects: [project],
    });
    const connection = value(await connect(personalActor(owner.id), fake));
    // A Jira admin replaces the project's Task type.
    project.issueTypes = [{ id: "30003", name: "Story", hierarchyLevel: 0 }];
    const tested = value(
      await testIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connectionId: connection.id,
        deps: await deps(fake),
        now: NOW,
      }),
    );
    expect(tested).toMatchObject({ ok: true, refreshed: ["ENG"] });
    expect(tested.message).toContain("The issue type of ENG was gone");
    expect(storedTargets(String((await connectionRow(connection.id))?.targets))).toEqual([
      { id: "ENG", name: "Engineering", issueType: "30003" },
    ]);
    // Nothing changed since: nothing to report.
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor: personalActor(owner.id),
          connectionId: connection.id,
          deps: await deps(fake),
          now: NOW,
        }),
      ).refreshed,
    ).toEqual([]);
  });

  it("never shows the stored issue type to the owner side", async () => {
    const w = await world();
    const listed = value(
      await listIntegrationChoices(db(), {
        actor: personalActor(w.owner.id),
        service: ON,
        now: NOW,
      }),
    );
    expect(listed.connections[0]?.targets).toEqual([{ id: "ENG", name: "Engineering" }]);
    expect(JSON.stringify(listed)).not.toContain("issueType");
    expect(JSON.stringify(w.connection)).not.toContain("issueType");
  });

  it("tests a connection, and marks it when Jira refuses the token", async () => {
    const w = await world();
    const actor = personalActor(w.owner.id);
    const tested = value(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: w.connection.id,
        deps: await deps(w.fake),
        now: NOW,
      }),
    );
    expect(tested).toMatchObject({ ok: true, identity: "Jira Bot" });
    w.fake.revoke(`${ACCOUNT}:${TOKEN}`);
    const refused = value(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: w.connection.id,
        deps: await deps(w.fake),
        now: NOW,
      }),
    );
    expect(refused).toMatchObject({ ok: false, problem: "credential_rejected" });
    expect(await connectionRow(w.connection.id)).toMatchObject({
      attention: "credential_rejected",
    });
  });
});

describe("creating a Jira issue", () => {
  it("sends one Atlassian document with comment text only in code blocks, and links the issue", async () => {
    const w = await world(QUOTED);
    const issue = value(await ask(w));
    expect(issue.target).toBe("Engineering");
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW, w.fake)).toBe("done");
    // The first attempt makes two calls: the site proved again, then the create.
    expect(
      w.fake.requests.slice(before).map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([
      `GET /ex/jira/${CLOUD}/rest/api/3/serverInfo`,
      `POST /ex/jira/${CLOUD}/rest/api/3/issue`,
    ]);
    const sent = JSON.parse(w.fake.requests.at(-1)?.body ?? "{}") as {
      fields: {
        project: unknown;
        issuetype: unknown;
        summary: string;
        description: {
          content: { type: string; content?: { text: string; marks?: unknown[] }[] }[];
        };
      };
    };
    expect(sent.fields.project).toEqual({ key: "ENG" });
    expect(sent.fields.issuetype).toEqual({ id: "10001" });
    // The title is inert as for every service.
    expect(sent.fields.summary).toBe("Fix ˋtheˋ ＃1 header");
    const blocks = sent.fields.description.content;
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "codeBlock",
      "paragraph",
      "codeBlock",
      "rule",
      "paragraph",
    ]);
    expect(blocks[4]?.content).toEqual([
      { type: "text", text: "Ship [~accountid:1] on {panel}Friday{panel}" },
    ]);
    expect(blocks[6]?.content?.[0]?.text).toContain("@[Admin] [~accountid:5b10]");
    expect(blocks[6]?.content?.[0]?.marks).toBeUndefined();
    expect(blocks[1]?.content?.[1]).toEqual({
      type: "text",
      text: "Q3 plan {color:red}x{color}",
      marks: [{ type: "code" }],
    });
    expect(JSON.stringify(blocks)).toContain(`Reference: ${issue.id}`);
    // The only link is Portifact's own.
    expect(JSON.stringify(sent).match(/"href":"[^"]*"/g)).toEqual([
      `"href":"https://app.portifact.test/view/${w.a.id}?path=%2Findex.html&thread=${w.threadId}"`,
    ]);
    // The link is built from the site and the key, never Jira's API `self`.
    expect(await issueRow(issue.id)).toMatchObject({
      state: "created",
      issueKey: "ENG-1",
      issueUrl: "https://acme.atlassian.net/browse/ENG-1",
    });
    const [event] = (
      await db().select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, w.owner.id))
    ).filter((e) => e.kind === "issue.created");
    expect(event?.detail).toEqual({
      service: "jira",
      target: "ENG",
      link: true,
      artifactName: true,
      quote: true,
      message: true,
    });
    expect(JSON.stringify(event)).not.toContain("acme");
  });

  it("finds an issue whose answer was lost with a bounded JQL search, and creates nothing twice", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next("pass", "lose");
    expect(await run(issue.id, NOW, w.fake)).toBe("kept");
    expect(w.fake.issues).toHaveLength(1);
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake)).toBe("done");
    expect(w.fake.issues).toHaveLength(1);
    // The retry makes one call: the search found it.
    const calls = w.fake.requests.slice(before);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe(`/ex/jira/${CLOUD}/rest/api/3/search/jql`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      jql: 'project = "ENG" AND creator = currentUser() AND created >= -1d ORDER BY created DESC',
      maxResults: String(INTEGRATION_LIMITS.recentIssuesChecked),
      fields: "description,created",
    });
    expect(await issueRow(issue.id)).toMatchObject({ state: "created", issueKey: "ENG-1" });
  });

  it("never links an issue someone else wrote with the reference, and creates its own", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next(new Response("busy", { status: 503 }));
    await run(issue.id, NOW, w.fake);
    w.fake.plantJira("ENG", { text: `Copied. Reference: ${issue.id}`, author: "Mallory" });
    const before = w.fake.requests.length;
    await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake);
    // The search and then the create: two calls on a retry that found nothing.
    expect(w.fake.requests.slice(before).map((r) => r.method)).toEqual(["GET", "POST"]);
    const created = await issueRow(issue.id);
    expect(created?.state).toBe("created");
    // The planted issue is ENG-1: the request links its own, ENG-2.
    expect(created?.issueKey).toBe("ENG-2");
    expect(w.fake.issues.map((one) => one.author)).toEqual(["Mallory", "Jira Bot"]);
  });

  it("does not create anything when the lookup fails", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next("pass", "lose");
    await run(issue.id, NOW, w.fake);
    w.fake.next(Response.json({ issues: "nope" }));
    expect(await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake)).toBe("done");
    expect(w.fake.issues).toHaveLength(1);
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "invalid_response",
    });
  });

  it.each([
    [Response.json({ key: "OPS-1" }, { status: 201 }), "invalid_response"],
    [Response.json({ id: "1" }, { status: 201 }), "invalid_response"],
    [Response.json({ errors: { summary: "required" } }, { status: 400 }), "rejected"],
    [Response.json({}, { status: 403 }), "target_unreachable"],
    [
      new Response(null, { status: 301, headers: { location: "https://evil.test" } }),
      "invalid_response",
    ],
  ])("ends a request whose answer is %#", async (answer, failure) => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next("pass", answer);
    expect(await run(issue.id, NOW, w.fake)).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure });
  });

  it("marks the connection when Jira refuses the token while creating", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.revoke(`${ACCOUNT}:${TOKEN}`);
    await run(issue.id, NOW, w.fake);
    expect(await issueRow(issue.id)).toMatchObject({ failure: "credential_rejected" });
    expect(await connectionRow(w.connection.id)).toMatchObject({
      attention: "credential_rejected",
    });
  });

  it("does not create an issue whose link points at a site the cloud ID no longer serves", async () => {
    const w = await world();
    w.fake.jiraSite({ site: "acme-renamed", cloudId: CLOUD });
    const issue = value(await ask(w));
    await run(issue.id, NOW, w.fake);
    expect((await issueRow(issue.id))?.issueUrl ?? "").not.toContain("https://acme.atlassian.net/");
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "site_changed" });
    expect(w.fake.issues).toHaveLength(0);
    expect(await connectionRow(w.connection.id)).toMatchObject({ attention: "site_mismatch" });
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, w.owner.id));
    expect(events.filter((e) => e.kind === "integration.failing").map((e) => e.detail)).toEqual([
      { service: "jira", reason: "site_mismatch" },
    ]);
    // The next request is refused at once, and calls nothing.
    const before = w.fake.requests.length;
    expect(await ask(w)).toMatchObject({
      ok: false,
      message: "This connection needs an admin's attention: its Jira site changed its address.",
    });
    expect(w.fake.requests.length).toBe(before);
  });

  it("ends a pending request with site_changed once a test marked the site", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.jiraSite({ site: "acme-renamed", cloudId: CLOUD });
    await testIntegrationConnection(db(), {
      actor: personalActor(w.owner.id),
      connectionId: w.connection.id,
      deps: await deps(w.fake),
      now: NOW,
    });
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW, w.fake)).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "site_changed" });
    expect(w.fake.requests.length).toBe(before);
  });

  it("retries when the first attempt cannot reach serverInfo, and then creates without it", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next(new Response("busy", { status: 503 }));
    expect(await run(issue.id, NOW, w.fake)).toBe("kept");
    expect(w.fake.issues).toHaveLength(0);
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake)).toBe("done");
    // A retry: the search, then the create; serverInfo is asked only on the first attempt.
    expect(
      w.fake.requests.slice(before).map((r) => new URL(r.url).pathname.split("/").pop()),
    ).toEqual(["jql", "issue"]);
  });

  it("uses each project's own issue type", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers().jira("two@acme.example", "ATATT-two-projects-test-only-000000", {
      displayName: "Two Bot",
      cloudId: CLOUD,
      projects: [
        { key: "ENG", name: "Engineering" },
        {
          key: "OPS",
          name: "Operations",
          issueTypes: [{ id: "20002", name: "Bug", hierarchyLevel: 0 }],
        },
      ],
    });
    const connection = value(
      await connect(personalActor(owner.id), fake, {
        account: "two@acme.example",
        credential: "ATATT-two-projects-test-only-000000",
        targets: ["ENG", "OPS"],
      }),
    );
    const a = await artifact(owner.id);
    const threadId = value(
      await createAnnotationThread(db(), {
        humanCheck: HUMAN,
        userId: owner.id,
        artifactId: a.id,
        versionId: a.version,
        target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
        body: "x",
        now: NOW,
      }),
    ).id;
    const w = { owner, fake, connection, a, threadId };
    for (const [target, type] of [
      ["OPS", "20002"],
      ["ENG", "10001"],
    ] as const) {
      const issue = value(
        await requestThreadIssue(db(), {
          userId: owner.id,
          artifactId: a.id,
          threadId,
          request: {
            connectionId: connection.id,
            target,
            title: "x",
            include: { link: true, artifactName: true, quote: false, message: false },
          },
          idempotencyKey: crypto.randomUUID(),
          service: ON,
          now: NOW,
        }),
      );
      await run(issue.id, NOW, w.fake);
      const sent = JSON.parse(w.fake.requests.at(-1)?.body ?? "{}") as {
        fields: { issuetype: unknown; project: unknown };
      };
      expect(sent.fields).toMatchObject({ project: { key: target }, issuetype: { id: type } });
    }
  });

  it("adopts the oldest issue created since the request, never one created before it", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next(new Response("busy", { status: 503 }));
    await run(issue.id, NOW, w.fake);
    const reference = `Sent from Portifact. Reference: ${issue.id}`;
    // Same account, the reference pasted in: one from before the request, two after it.
    w.fake.plantJira("ENG", { text: reference, author: "Jira Bot", created: NOW - 3_600_000 });
    w.fake.plantJira("ENG", { text: reference, author: "Jira Bot", created: NOW + 60_000 });
    w.fake.plantJira("ENG", { text: reference, author: "Jira Bot", created: NOW + 120_000 });
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake)).toBe("done");
    expect(w.fake.requests.length - before).toBe(1);
    const keys = w.fake.issues.map((one) => one.key);
    // The search lists newest first; the oldest one since the request is the second planted.
    expect(await issueRow(issue.id)).toMatchObject({ state: "created", issueKey: keys[1] });
  });

  it("does not adopt an issue created before the request, and creates its own", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next(new Response("busy", { status: 503 }));
    await run(issue.id, NOW, w.fake);
    w.fake.plantJira("ENG", {
      text: `Reference: ${issue.id}`,
      author: "Jira Bot",
      created: NOW - INTEGRATION_LIMITS.lookupSkewMs - 1,
    });
    await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake);
    expect(await issueRow(issue.id)).toMatchObject({ state: "created" });
    expect((await issueRow(issue.id))?.issueKey).not.toBe(w.fake.issues[0]?.key);
    expect(w.fake.issues).toHaveLength(2);
  });

  it("reads a search answer larger than one issue's bound", async () => {
    const w = await world();
    const issue = value(await ask(w));
    w.fake.next(new Response("busy", { status: 503 }));
    await run(issue.id, NOW, w.fake);
    // A recent issue with a long description: the search answer is over 256 KiB.
    w.fake.plantJira("ENG", { text: "x".repeat(300 * 1024), author: "Jira Bot", created: NOW + 1 });
    w.fake.plantJira("ENG", {
      text: `Reference: ${issue.id}`,
      author: "Jira Bot",
      created: NOW + 2,
    });
    expect(await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], w.fake)).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({
      state: "created",
      issueKey: w.fake.issues[1]?.key,
    });
  });

  it("refuses a project the connection no longer allows", async () => {
    const w = await world();
    expect(
      await requestThreadIssue(db(), {
        userId: w.owner.id,
        artifactId: w.a.id,
        threadId: w.threadId,
        request: {
          connectionId: w.connection.id,
          target: "OPS",
          title: "x",
          include: { link: true, artifactName: true, quote: false, message: false },
        },
        idempotencyKey: crypto.randomUUID(),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      message: "The connection does not allow that repository, team or project.",
    });
  });

  it("makes as many D1 calls for a Jira request as for any other service", async () => {
    const w = await world();
    const counted = counting();
    value(
      await requestThreadIssue(counted.database, {
        userId: w.owner.id,
        artifactId: w.a.id,
        threadId: w.threadId,
        request: {
          connectionId: w.connection.id,
          target: "ENG",
          title: "x",
          include: { link: true, artifactName: true, quote: false, message: false },
        },
        idempotencyKey: crypto.randomUUID(),
        service: ON,
        now: NOW,
      }),
    );
    expect(counted.calls.roundTrips).toBe(5);
    expect(counted.calls.batchSizes).toEqual([2]);
  });
});

/** A database that counts D1 round trips and batch sizes. */
function counting() {
  const calls = { roundTrips: 0, batchSizes: [] as number[] };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const real = Reflect.get(target, property, receiver);
        if (typeof real !== "function") return real;
        if (property === "bind") return (...args: unknown[]) => wrap(real.apply(target, args));
        if (["all", "raw", "run", "first"].includes(String(property))) {
          return (...args: unknown[]) => {
            calls.roundTrips += 1;
            return real.apply(target, args);
          };
        }
        return real.bind(target);
      },
    });
  const d1 = new Proxy(env.DB, {
    get(target, property, receiver) {
      const real = Reflect.get(target, property, receiver);
      if (property === "prepare") return (query: string) => wrap(target.prepare(query));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          calls.roundTrips += 1;
          calls.batchSizes.push(statements.length);
          return target.batch(statements);
        };
      }
      return typeof real === "function" ? real.bind(target) : real;
    },
  });
  return { database: regionalDb(d1, globalDb(d1)), calls };
}
