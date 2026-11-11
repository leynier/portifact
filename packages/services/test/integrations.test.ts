// Issue integrations (decision 0018): connections managed by admins with the plan gate and the
// switch, the issue request with every role, comment scope, idempotency and caps, the job that
// creates the issue (each failure class, retries, a lost answer, a revoked credential, redirects,
// oversized and slow answers), deletion and tombstones and the audit events, against the real D1
// schema in workerd and the fake GitHub and Linear in @portifact/services/testing. Nothing here
// reaches a real service.
import { env } from "cloudflare:test";
import { type AnnotationTarget, INTEGRATION_LIMITS, type JobMessage } from "@portifact/contracts";
import { globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { exportAccount, requestAccountDeletion } from "../src/account-data.ts";
import { actorOn } from "../src/actors.ts";
import {
  createAnnotationThread,
  getAnnotationThread,
  type HumanCheck,
} from "../src/annotations.ts";
import { applyIntegrationTombstones, applyTombstones, exportTombstones } from "../src/backups.ts";
import { integrationKeys, openCredential } from "../src/integration-keys.ts";
import {
  checkProblemMessage,
  createIntegrationConnection,
  type IntegrationDeps,
  listIntegrationChoices,
  listIntegrationConnections,
  removeIntegrationConnection,
  rewrapIntegrationKeys,
  storedTargets,
  testIntegrationConnection,
  updateIntegrationConnection,
} from "../src/integrations.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";
import {
  requestThreadIssue,
  requeueThreadIssues,
  type ThreadIssueDeps,
} from "../src/thread-issues.ts";
import { transferArtifact } from "../src/transfer.ts";
import { advanceWorkspaceDeletion, deleteWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, session, value } from "./fixtures.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const KEY_TEXT = "test-only integrations sealing key, long enough to use";
const OTHER_KEY_TEXT = "another test-only integrations key for the rotation";
const TOKEN =
  "github_pat_11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LINEAR_KEY = "test-only-linear-key-not-a-real-one-0123";
const TEAM = "6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f";
const HOSTILE =
  "@octocat see #1 ![x](https://evil.test/a.png) <img src=x onerror=alert(1)> [click](https://evil.test)\n```\n# heading‮​hidden";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ON = { enabled: true };

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function person(verified = true) {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .global.insert(schema.users)
    .values({
      id,
      name: `Name ${id.slice(2, 6)}`,
      email,
      emailVerified: verified,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

async function workspace(members: [string, "admin" | "editor" | "member"][]) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .global.insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: members[0]?.[0] ?? "x",
      updatedAt: NOW,
    });
  for (const [userId, role] of members) {
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  return id;
}

async function actorIn(userId: string, ownerId: string): Promise<Actor> {
  const actor = await actorOn(db().global, userId, ownerId);
  if (!actor.ok || !actor.value) throw new Error("no role");
  return actor.value;
}

interface Artifact {
  id: string;
  version: string;
}

async function artifact(
  ownerId: string,
  readers: string[] = [],
  visibility: "owner" | "everyone" = "everyone",
): Promise<Artifact> {
  const id = artifactId();
  const version = `${id}_v1`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Q3 plan `final`",
      state: "active",
      annotations: "open",
      commentVisibility: visibility,
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
  for (const email of readers) {
    await db().insert(schema.artifactReaders).values({ artifactId: id, email });
  }
  return { id, version };
}

async function thread(a: Artifact, userId: string, body = HOSTILE, target: AnnotationTarget = DOC) {
  return value(
    await createAnnotationThread(db(), {
      humanCheck: HUMAN,
      userId,
      artifactId: a.id,
      versionId: a.version,
      target,
      body,
      now: NOW,
    }),
  ).id;
}

const QUOTED: AnnotationTarget = {
  schema: 1,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact: "Ship @team on Friday", prefix: "", suffix: "" },
    position: { start: 0, end: 20 },
  },
};

async function deps(trackers: FakeIssueTrackers, extra: Partial<IntegrationDeps> = {}) {
  return {
    keys: await integrationKeys({ current: KEY_TEXT }),
    service: ON,
    fetch: trackers.fetch,
    ...extra,
  } satisfies IntegrationDeps;
}

async function jobDeps(trackers: FakeIssueTrackers, extra: Partial<ThreadIssueDeps> = {}) {
  return {
    keys: await integrationKeys({ current: KEY_TEXT }),
    fetch: trackers.fetch,
    appOrigin: "https://app.portifact.test",
    enabled: true,
    ...extra,
  } satisfies ThreadIssueDeps;
}

function trackers() {
  return new FakeIssueTrackers()
    .github(TOKEN, "octo-bot", [
      "acme/site",
      "acme/docs",
      { name: "acme/closed", hasIssues: false },
    ])
    .linear(LINEAR_KEY, "Lin Bot", [{ id: TEAM, name: "Engineering", key: "ENG" }]);
}

async function connectGitHub(actor: Actor, fake = trackers(), targets = ["acme/site"]) {
  return value(
    await createIntegrationConnection(db(), {
      actor,
      connection: { service: "github", label: "Product repo", credential: TOKEN, targets },
      deps: await deps(fake),
      now: NOW,
    }),
  );
}

/** A Team owner with a connection, an artifact, a reader and a thread the reader started. */
async function world(options: { body?: string; target?: AnnotationTarget } = {}) {
  const owner = await person();
  const reader = await person();
  await grantPlan(owner.id, "team");
  const fake = trackers();
  const connection = await connectGitHub(personalActor(owner.id), fake);
  const a = await artifact(owner.id, [reader.email]);
  const threadId = await thread(a, reader.id, options.body, options.target);
  return { owner, reader, fake, connection, a, threadId };
}

function ask(
  w: { a: Artifact; threadId: string; connection: { id: string } },
  userId: string,
  extra: {
    key?: string;
    threadId?: string;
    target?: string;
    include?: { link: boolean; artifactName: boolean; quote: boolean; message: boolean };
    service?: { enabled: boolean };
    now?: number;
    database?: ReturnType<typeof db>;
  } = {},
) {
  return requestThreadIssue(extra.database ?? db(), {
    userId,
    artifactId: w.a.id,
    threadId: extra.threadId ?? w.threadId,
    request: {
      connectionId: w.connection.id,
      target: extra.target ?? "acme/site",
      title: "Fix the header",
      include: extra.include ?? { link: true, artifactName: true, quote: false, message: false },
    },
    idempotencyKey: extra.key ?? crypto.randomUUID(),
    service: extra.service ?? ON,
    now: extra.now ?? NOW,
  });
}

async function jobFor(issueId: string) {
  const [row] = await db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "thread_issue"), eq(schema.outbox.subject, issueId)));
  return row;
}

async function run(issueId: string, now: number, issueDeps: ThreadIssueDeps) {
  const job = await jobFor(issueId);
  if (!job) return "none";
  const message: JobMessage = { id: job.id, topic: "thread_issue" };
  return runJob(db(), env.ARTIFACTS, message, now, { issues: issueDeps });
}

async function issueRow(id: string) {
  const [row] = await db().select().from(schema.threadIssues).where(eq(schema.threadIssues.id, id));
  return row;
}

async function connectionRow(id: string) {
  const [row] = await db()
    .select()
    .from(schema.integrationConnections)
    .where(eq(schema.integrationConnections.id, id));
  return row;
}

async function auditOf(ownerId: string) {
  return (
    db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, ownerId))
      // Events written at the same time keep the order they were inserted in.
      .orderBy(schema.auditEvents.at, sql`rowid`)
  );
}

describe("connections", () => {
  it("checks the credential, seals it and shows only its last four characters", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const created = await connectGitHub(personalActor(owner.id), fake);
    expect(created).toMatchObject({
      service: "github",
      label: "Product repo",
      identity: "octo-bot",
      credentialHint: `…${TOKEN.slice(-4)}`,
      targets: [{ id: "acme/site", name: "acme/site" }],
      usable: true,
      attention: null,
    });
    expect(JSON.stringify(created)).not.toContain(TOKEN.slice(0, 20));
    const row = await connectionRow(created.id);
    expect(row?.credentialBox).not.toContain(TOKEN);
    expect(
      await openCredential(
        await integrationKeys({ current: KEY_TEXT }),
        row?.keyId ?? "",
        created.id,
        row?.credentialBox ?? "",
      ),
    ).toBe(TOKEN);
    // A sealed value copied to another connection does not open there.
    expect(
      await openCredential(
        await integrationKeys({ current: KEY_TEXT }),
        row?.keyId ?? "",
        "ic_other",
        row?.credentialBox ?? "",
      ),
    ).toBeNull();
    // The credential went only to GitHub's API, as a bearer token.
    expect(fake.requests.map((r) => r.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/repos/acme/site",
    ]);
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const events = await auditOf(owner.id);
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["integration.connected", { service: "github", targets: 1 }],
    ]);
    expect(JSON.stringify(events)).not.toContain(TOKEN.slice(-8));
  });

  it("connects Linear with the teams' names as Linear reports them", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const created = value(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: {
          service: "linear",
          label: "Linear",
          credential: LINEAR_KEY,
          targets: [TEAM.toUpperCase()],
        },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    expect(created).toMatchObject({
      identity: "Lin Bot",
      targets: [{ id: TEAM, name: "Engineering" }],
    });
    expect(fake.requests[0]?.headers.authorization).toBe(LINEAR_KEY);
  });

  it("says in plain words what failed, and stores nothing", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const create = async (
      credential: string,
      targets: string[],
      service: "github" | "linear" = "github",
    ) =>
      createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: { service, label: "X", credential, targets },
        deps: await deps(trackers()),
        now: NOW,
      });
    expect(await create(`${TOKEN}x`, ["acme/site"])).toMatchObject({
      code: "invalid_input",
      message: "GitHub refused the token: it is wrong, expired or revoked.",
    });
    expect(await create(TOKEN, ["acme/other"])).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("cannot reach acme/other"),
    });
    expect(await create(TOKEN, ["acme/closed"])).toMatchObject({
      message: "Issues are turned off in acme/closed.",
    });
    expect(
      await create(LINEAR_KEY, ["00000000-0000-4000-8000-000000000000"], "linear"),
    ).toMatchObject({
      message: expect.stringContaining("cannot see the team"),
    });
    expect(await create(TOKEN, ["not a repo"])).toMatchObject({ code: "invalid_input" });
    expect(
      await listIntegrationConnections(db(), {
        actor: personalActor(owner.id),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      value: { connections: [] },
    });
  });

  it("lets only admins manage connections; editors list them to pick one, members nothing", async () => {
    const admin = await person();
    const editor = await person();
    const member = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [editor.id, "editor"],
      [member.id, "member"],
    ]);
    await grantPlan(ws, "team");
    const connection = await connectGitHub(await actorIn(admin.id, ws));
    const forbidden = { ok: false, code: "forbidden" };
    for (const userId of [editor.id, member.id]) {
      const actor = await actorIn(userId, ws);
      expect(await connectionCreate(actor)).toMatchObject(forbidden);
      expect(
        await removeIntegrationConnection(db(), { actor, connectionId: connection.id, now: NOW }),
      ).toMatchObject(forbidden);
      expect(
        await listIntegrationConnections(db(), { actor, service: ON, now: NOW }),
      ).toMatchObject(forbidden);
    }
    const choices = value(
      await listIntegrationChoices(db(), {
        actor: await actorIn(editor.id, ws),
        service: ON,
        now: NOW,
      }),
    );
    expect(choices).toEqual({
      connections: [
        {
          id: connection.id,
          service: "github",
          label: "Product repo",
          targets: [{ id: "acme/site", name: "acme/site" }],
          usable: true,
        },
      ],
      available: true,
      serviceAvailable: true,
      euResidency: false,
    });
    expect(
      await listIntegrationChoices(db(), {
        actor: await actorIn(member.id, ws),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject(forbidden);
    // A service token never reaches connections, whatever its role.
    const token: Actor = {
      ...(await actorIn(editor.id, ws)),
      userId: `st_${"a".repeat(32)}`,
      token: {
        restriction: { kind: "none" },
        scopes: ["artifacts:share"],
        createdAt: NOW,
        label: "CI",
      },
    };
    expect(
      await listIntegrationChoices(db(), { actor: token, service: ON, now: NOW }),
    ).toMatchObject(forbidden);
    expect(
      await listIntegrationConnections(db(), {
        actor: { ...token, role: "admin" },
        service: ON,
        now: NOW,
      }),
    ).toMatchObject(forbidden);

    async function connectionCreate(actor: Actor) {
      return createIntegrationConnection(db(), {
        actor,
        connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      });
    }
  });

  it("gates creating and changing on the owner's plan; removing and reading never", async () => {
    const owner = await person();
    const actor = personalActor(owner.id);
    expect(
      await createIntegrationConnection(db(), {
        actor,
        connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    await grantPlan(owner.id, "team");
    const connection = await connectGitHub(actor);
    // The plan lapses: the connection stays, and can still be read, tested and removed.
    await grantPlan(owner.id, "team", { validUntil: NOW - 1 });
    const listed = value(await listIntegrationConnections(db(), { actor, service: ON, now: NOW }));
    expect(listed.available).toBe(false);
    expect(listed.connections).toHaveLength(1);
    expect(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        update: { label: "Renamed" },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor,
          connectionId: connection.id,
          deps: await deps(trackers()),
          now: NOW,
        }),
      ).ok,
    ).toBe(true);
    expect(
      value(
        await removeIntegrationConnection(db(), { actor, connectionId: connection.id, now: NOW }),
      ),
    ).toEqual({ connectionId: connection.id });
  });

  it("answers capacity_unavailable while switched off or without a key, and lists nothing", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const connection = await connectGitHub(actor);
    const off = { enabled: false };
    for (const extra of [{ service: off }, { keys: [] }]) {
      expect(
        await createIntegrationConnection(db(), {
          actor,
          connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
          deps: await deps(trackers(), extra),
          now: NOW,
        }),
      ).toMatchObject({ ok: false, code: "capacity_unavailable" });
    }
    expect(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        deps: await deps(trackers(), { service: off }),
        now: NOW,
      }),
    ).toMatchObject({ code: "capacity_unavailable" });
    expect(
      value(await listIntegrationChoices(db(), { actor, service: off, now: NOW })),
    ).toMatchObject({
      connections: [],
      serviceAvailable: false,
    });
  });

  it("caps connections per owner", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    for (let i = 0; i < INTEGRATION_LIMITS.perOwner; i += 1) await connectGitHub(actor);
    expect(
      await createIntegrationConnection(db(), {
        actor,
        connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("checks a new credential or new targets, and a label alone calls nothing", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const connection = await connectGitHub(actor);
    const fake = trackers();
    const renamed = value(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        update: { label: "Renamed" },
        deps: await deps(fake),
        now: NOW + 1,
      }),
    );
    expect(renamed.label).toBe("Renamed");
    expect(fake.requests).toHaveLength(0);
    const second = `${TOKEN.slice(0, -4)}ZZZZ`;
    fake.github(second, "new-bot", ["acme/site", "acme/docs"]);
    const changed = value(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        update: { credential: second, targets: ["acme/site", "acme/docs"] },
        deps: await deps(fake),
        now: NOW + 2,
      }),
    );
    expect(changed).toMatchObject({ identity: "new-bot", credentialHint: "…ZZZZ" });
    expect(changed.targets.map((t) => t.id)).toEqual(["acme/site", "acme/docs"]);
    expect((await auditOf(owner.id)).map((e) => [e.kind, e.detail])).toEqual([
      ["integration.connected", { service: "github", targets: 1 }],
      ["integration.changed", { label: true }],
      ["integration.changed", { credential: true, targets: 2 }],
    ]);
    // A credential the service refuses is not saved.
    expect(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        update: { credential: `${TOKEN}nope` },
        deps: await deps(fake),
        now: NOW + 3,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect((await connectionRow(connection.id))?.credentialHint).toBe("…ZZZZ");
  });

  it("marks a refused credential as needing attention once, and a passing test clears it", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const fake = trackers();
    const connection = await connectGitHub(actor, fake);
    fake.revoke(TOKEN);
    for (let i = 0; i < 2; i += 1) {
      expect(
        value(
          await testIntegrationConnection(db(), {
            actor,
            connectionId: connection.id,
            deps: await deps(fake),
            now: NOW + i,
          }),
        ),
      ).toMatchObject({ ok: false, problem: "credential_rejected" });
    }
    expect((await connectionRow(connection.id))?.attention).toBe("credential_rejected");
    expect((await auditOf(owner.id)).filter((e) => e.kind === "integration.failing")).toHaveLength(
      1,
    );
    fake.github(TOKEN, "octo-bot", ["acme/site"]);
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor,
          connectionId: connection.id,
          deps: await deps(fake),
          now: NOW + 5,
        }),
      ),
    ).toMatchObject({ ok: true, identity: "octo-bot" });
    expect((await connectionRow(connection.id))?.attention).toBeNull();
  });

  it("answers another owner's connection exactly like a missing one", async () => {
    const owner = await person();
    const stranger = await person();
    await grantPlan(owner.id, "team");
    await grantPlan(stranger.id, "team");
    const connection = await connectGitHub(personalActor(owner.id));
    const missing = { ok: false, code: "not_found", message: "Connection not found." };
    const actor = personalActor(stranger.id);
    for (const connectionId of [connection.id, `ic_${"0".repeat(32)}`]) {
      expect(await removeIntegrationConnection(db(), { actor, connectionId, now: NOW })).toEqual(
        missing,
      );
      expect(
        await testIntegrationConnection(db(), {
          actor,
          connectionId,
          deps: await deps(trackers()),
          now: NOW,
        }),
      ).toEqual(missing);
      expect(
        await updateIntegrationConnection(db(), {
          actor,
          connectionId,
          update: { label: "X" },
          deps: await deps(trackers()),
          now: NOW,
        }),
      ).toEqual(missing);
    }
  });

  it("removes with a tombstone, and a restore cannot bring the credential back", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const connection = await connectGitHub(actor);
    const snapshot = await connectionRow(connection.id);
    if (!snapshot) throw new Error("setup");
    value(
      await removeIntegrationConnection(db(), { actor, connectionId: connection.id, now: NOW }),
    );
    expect(await connectionRow(connection.id)).toBeUndefined();
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({
      kind: "integration_connection",
      id: connection.id,
      deletedAt: NOW,
    });
    // A restore brings the row back; re-applying the tombstones deletes it again.
    await db().insert(schema.integrationConnections).values(snapshot);
    await applyTombstones(db(), markers, NOW + 1);
    const applied = await applyIntegrationTombstones(regionsFromEnv(env));
    expect(applied.integrations).toBeGreaterThanOrEqual(1);
    expect(await connectionRow(connection.id)).toBeUndefined();
    expect((await auditOf(owner.id)).map((e) => [e.kind, e.detail]).at(-1)).toEqual([
      "integration.removed",
      { service: "github" },
    ]);
  });

  it("re-seals credentials with the current key during a rotation", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const connection = await connectGitHub(personalActor(owner.id));
    const rotated = await integrationKeys({ current: OTHER_KEY_TEXT, previous: KEY_TEXT });
    const result = await rewrapIntegrationKeys(db(), rotated);
    expect(result.rewrapped).toBeGreaterThanOrEqual(1);
    const row = await connectionRow(connection.id);
    expect(row?.keyId).toBe(rotated[0]?.id);
    expect(
      await openCredential(
        await integrationKeys({ current: OTHER_KEY_TEXT }),
        row?.keyId ?? "",
        connection.id,
        row?.credentialBox ?? "",
      ),
    ).toBe(TOKEN);
  });
});

describe("asking for an issue", () => {
  it("writes the request and its job in one batch, and a retry with the same key is the same request", async () => {
    const w = await world();
    const key = crypto.randomUUID();
    const first = value(await ask(w, w.owner.id, { key }));
    expect(first).toMatchObject({
      service: "github",
      target: "acme/site",
      state: "pending",
      own: true,
    });
    const again = value(await ask(w, w.owner.id, { key }));
    expect(again.id).toBe(first.id);
    expect(
      await db()
        .select()
        .from(schema.threadIssues)
        .where(eq(schema.threadIssues.threadId, w.threadId)),
    ).toHaveLength(1);
    expect(await jobFor(first.id)).toBeDefined();
    // The same key on another thread is refused.
    const other = await thread(w.a, w.reader.id);
    expect(await ask(w, w.owner.id, { key, threadId: other })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    // Nothing is sent and nothing is recorded until the job creates the issue.
    expect(w.fake.issues).toHaveLength(0);
    expect((await auditOf(w.owner.id)).some((e) => e.kind === "issue.created")).toBe(false);
  });

  it("is for the owner side only; a reader gets forbidden, a stranger and a token a missing artifact", async () => {
    const w = await world();
    const stranger = await person();
    expect(await ask(w, w.reader.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await ask(w, stranger.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await ask(w, `st_${"b".repeat(32)}`)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("lets a workspace's editors ask, never its members, and uses the workspace's plan", async () => {
    const admin = await person();
    const editor = await person();
    const member = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [editor.id, "editor"],
      [member.id, "member"],
    ]);
    await grantPlan(ws, "team");
    const connection = await connectGitHub(await actorIn(admin.id, ws));
    const a = await artifact(ws, [member.email]);
    const threadId = await thread(a, member.id);
    const w = { a, threadId, connection };
    expect(value(await ask(w, editor.id)).state).toBe("pending");
    expect(await ask(w, member.id)).toMatchObject({ ok: false, code: "forbidden" });
    // The editor's own plan does not count: only the workspace's.
    await grantPlan(ws, "free");
    await grantPlan(editor.id, "team");
    expect(await ask(w, editor.id)).toMatchObject({ ok: false, code: "plan_required" });
  });

  it("answers a thread outside the caller's comment scope like a missing one", async () => {
    const owner = await person();
    const reader = await person();
    const other = await person();
    await grantPlan(owner.id, "team");
    const connection = await connectGitHub(personalActor(owner.id));
    // Readers see only their own and the owner's threads.
    const a = await artifact(owner.id, [reader.email, other.email], "owner");
    const theirs = await thread(a, other.id);
    const mine = await thread(a, reader.id);
    const w = { a, threadId: theirs, connection };
    expect(await ask(w, reader.id)).toMatchObject({
      ok: false,
      code: "not_found",
      message: "Thread not found.",
    });
    expect(await ask(w, reader.id, { threadId: mine })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // With every thread visible the reader sees it, and still may not send it.
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: a.id,
        change: { commentVisibility: "everyone" },
        now: NOW,
      }),
    );
    expect(await ask(w, reader.id)).toMatchObject({ ok: false, code: "forbidden" });
    // The owner side always sees every thread.
    expect(value(await ask(w, owner.id)).state).toBe("pending");
  });

  it("refuses a connection that needs attention, another owner's, or a target it does not allow", async () => {
    const w = await world();
    expect(await ask(w, w.owner.id, { target: "acme/other" })).toMatchObject({
      code: "invalid_input",
      message: "The connection does not allow that repository or team.",
    });
    const stranger = await person();
    await grantPlan(stranger.id, "team");
    const theirs = await connectGitHub(personalActor(stranger.id));
    expect(await ask({ ...w, connection: theirs }, w.owner.id)).toMatchObject({
      code: "not_found",
    });
    await db()
      .update(schema.integrationConnections)
      .set({ attention: "credential_rejected" })
      .where(eq(schema.integrationConnections.id, w.connection.id));
    expect(await ask(w, w.owner.id)).toMatchObject({ code: "invalid_input" });
  });

  it("is gated on the plan and the switch", async () => {
    const w = await world();
    expect(await ask(w, w.owner.id, { service: { enabled: false } })).toMatchObject({
      code: "capacity_unavailable",
    });
    await grantPlan(w.owner.id, "team", { validUntil: NOW - 1 });
    expect(await ask(w, w.owner.id)).toMatchObject({ code: "plan_required" });
  });

  it("caps issues per thread and per owner and day", async () => {
    const w = await world();
    for (let i = 0; i < INTEGRATION_LIMITS.issuesPerThread; i += 1) value(await ask(w, w.owner.id));
    expect(await ask(w, w.owner.id)).toMatchObject({ code: "quota_exceeded" });
    const owner = await person();
    await grantPlan(owner.id, "team");
    const connection = await connectGitHub(personalActor(owner.id));
    const a = await artifact(owner.id);
    const threadId = await thread(a, owner.id);
    await db()
      .global.insert(schema.rateLimits)
      .values({
        key: `integration:issues:${owner.id}:${Date.UTC(2026, 10, 8)}`,
        windowStart: NOW,
        count: INTEGRATION_LIMITS.issuesPerOwnerPerDay,
      });
    expect(await ask({ a, threadId, connection }, owner.id)).toMatchObject({
      code: "rate_limited",
    });
  });

  it("makes a bounded number of D1 calls", async () => {
    const w = await world();
    const counted = counting();
    value(await ask(w, w.owner.id, { database: counted.database }));
    // With one database: the artifact joined with its owner's plan, the thread, the connection,
    // the daily count and the batch that writes the request and its job.
    expect(counted.calls.roundTrips).toBe(5);
    expect(counted.calls.batchSizes).toEqual([2]);
  });
});

describe("the job", () => {
  it("creates the issue with only the link and the name by default, and the thread shows it", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("done");
    expect(w.fake.issues).toHaveLength(1);
    const sent = w.fake.issues[0];
    expect(sent?.title).toBe("Fix the header");
    expect(sent?.body).toContain(`/view/${w.a.id}?path=%2Findex.html&thread=${w.threadId}`);
    expect(sent?.body).toContain("Artifact: `` Q3 plan `final` ``");
    expect(sent?.body).toContain(`Reference: ${issue.id}`);
    // The comment, the reader's address and anything else of the thread stay in Portifact.
    expect(sent?.body).not.toContain("octocat");
    expect(sent?.body).not.toContain(w.reader.email);
    const row = await issueRow(issue.id);
    expect(row).toMatchObject({ state: "created", issueKey: "#1", title: null });
    expect(row?.issueUrl).toBe("https://github.com/acme/site/issues/1");
    expect(await jobFor(issue.id)).toBeUndefined();
    // Whoever sees the thread sees the link.
    for (const userId of [w.owner.id, w.reader.id]) {
      const view = value(
        await getAnnotationThread(db(), {
          userId,
          artifactId: w.a.id,
          threadId: w.threadId,
          now: NOW,
        }),
      );
      expect(view.issues).toEqual([
        {
          id: issue.id,
          service: "github",
          target: "acme/site",
          state: "created",
          key: "#1",
          url: "https://github.com/acme/site/issues/1",
          failure: null,
          own: userId === w.owner.id,
          createdAt: new Date(NOW).toISOString(),
        },
      ]);
    }
    const [event] = (await auditOf(w.owner.id)).filter((e) => e.kind === "issue.created");
    expect(event).toMatchObject({
      actorType: "user",
      actorId: w.owner.id,
      targetId: w.a.id,
      detail: {
        service: "github",
        target: "acme/site",
        link: true,
        artifactName: true,
        quote: false,
        message: false,
      },
    });
    // A second run finds it done and sends nothing.
    expect(await run(issue.id, NOW + 1, await jobDeps(w.fake))).toBe("none");
  });

  it("sends the quote and the first message only when asked, as inert text", async () => {
    const w = await world({ target: QUOTED });
    const issue = value(
      await ask(w, w.owner.id, {
        include: { link: false, artifactName: false, quote: true, message: true },
      }),
    );
    await run(issue.id, NOW, await jobDeps(w.fake));
    const body = w.fake.issues[0]?.body ?? "";
    expect(body).not.toContain("/view/");
    expect(body).not.toContain("Q3 plan");
    expect(body).toContain("Quoted text:\n\n```text\nShip @team on Friday\n```");
    // The hostile message: inside a fence longer than its backticks, without invisible characters.
    expect(body).toContain("````text\n@octocat see #1");
    expect(body).not.toContain("‮");
    expect(body).not.toContain("​");
  });

  it("creates a Linear issue", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const connection = value(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: { service: "linear", label: "Linear", credential: LINEAR_KEY, targets: [TEAM] },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    const a = await artifact(owner.id);
    const threadId = await thread(a, owner.id, "Words");
    const issue = value(await ask({ a, threadId, connection }, owner.id, { target: TEAM }));
    expect(issue.target).toBe("Engineering");
    await run(issue.id, NOW, await jobDeps(fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "created",
      issueKey: "ENG-1",
      issueUrl: "https://linear.app/acme/issue/ENG-1/from-portifact",
    });
  });

  it("finds an issue whose creation answer was lost instead of creating a second one", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next("lose");
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("kept");
    expect(w.fake.issues).toHaveLength(1);
    expect(await issueRow(issue.id)).toMatchObject({ state: "pending", attempts: 1 });
    // The retry waits for its backoff, then looks before creating.
    expect(await run(issue.id, NOW + 1_000, await jobDeps(w.fake))).toBe("kept");
    expect(
      await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], await jobDeps(w.fake)),
    ).toBe("done");
    expect(w.fake.issues).toHaveLength(1);
    expect(await issueRow(issue.id)).toMatchObject({ state: "created", issueKey: "#1" });
    expect(w.fake.requests.at(-1)?.url).toContain("/repos/acme/site/issues?state=all");
  });

  it("finds a lost Linear issue by its reference", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const connection = value(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: { service: "linear", label: "Linear", credential: LINEAR_KEY, targets: [TEAM] },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    const a = await artifact(owner.id);
    const threadId = await thread(a, owner.id, "Words");
    const issue = value(await ask({ a, threadId, connection }, owner.id, { target: TEAM }));
    fake.next("lose");
    await run(issue.id, NOW, await jobDeps(fake));
    await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], await jobDeps(fake));
    expect(fake.issues).toHaveLength(1);
    expect(await issueRow(issue.id)).toMatchObject({ state: "created", issueKey: "ENG-1" });
  });

  it("retries a server error with backoff, and fails after the last attempt", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    let now = NOW;
    const busy = () => new Response("busy", { status: 503 });
    for (let attempt = 1; attempt <= INTEGRATION_LIMITS.retryDelaysMs.length + 1; attempt += 1) {
      // From the second attempt the job looks for a lost issue first: two calls.
      w.fake.next(...(attempt === 1 ? [busy()] : [busy()]));
      const outcome = await run(issue.id, now, await jobDeps(w.fake));
      const delay = INTEGRATION_LIMITS.retryDelaysMs[attempt - 1];
      expect(outcome).toBe(delay === undefined ? "done" : "kept");
      if (delay !== undefined) now += delay;
    }
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "service_unavailable",
    });
    expect(w.fake.issues).toHaveLength(0);
  });

  it("fails on a revoked credential and marks the connection for the admins", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.revoke(TOKEN);
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "credential_rejected",
    });
    expect((await connectionRow(w.connection.id))?.attention).toBe("credential_rejected");
    const failing = (await auditOf(w.owner.id)).filter((e) => e.kind === "integration.failing");
    expect(failing).toMatchObject([
      { actorType: "system", detail: { service: "github", reason: "credential_rejected" } },
    ]);
    // The failure is shown to the person who asked, not to the reader.
    const own = value(
      await getAnnotationThread(db(), {
        userId: w.owner.id,
        artifactId: w.a.id,
        threadId: w.threadId,
        now: NOW,
      }),
    );
    expect(own.issues?.[0]).toMatchObject({ state: "failed", failure: "credential_rejected" });
    const theirs = value(
      await getAnnotationThread(db(), {
        userId: w.reader.id,
        artifactId: w.a.id,
        threadId: w.threadId,
        now: NOW,
      }),
    );
    expect(theirs.issues).toBeUndefined();
  });

  it("never follows a redirect, and refuses oversized or unusable answers", async () => {
    for (const answer of [
      new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
      new Response("x".repeat(INTEGRATION_LIMITS.responseReadBytes + 10), { status: 201 }),
      Response.json(
        { number: 1, html_url: "https://evil.test/acme/site/issues/1" },
        { status: 201 },
      ),
      Response.json(
        { number: 1, html_url: "https://github.com/other/repo/issues/1" },
        { status: 201 },
      ),
      new Response("not json", { status: 201 }),
    ]) {
      const w = await world();
      const issue = value(await ask(w, w.owner.id));
      w.fake.next(answer);
      expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("done");
      expect(await issueRow(issue.id)).toMatchObject({
        state: "failed",
        failure: "invalid_response",
        issueUrl: null,
      });
      expect(w.fake.requests.filter((r) => r.url.startsWith("https://evil.test"))).toHaveLength(0);
    }
  });

  it("gives up on a slow answer at the timeout and tries again later", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next("hang");
    expect(await run(issue.id, NOW, await jobDeps(w.fake, { timeoutMs: 20 }))).toBe("kept");
    expect(await issueRow(issue.id)).toMatchObject({
      state: "pending",
      startedAt: null,
      attempts: 1,
    });
  });

  it("refuses a missing target with a plain reason", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next(Response.json({ message: "Not Found" }, { status: 404 }));
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "target_unreachable",
    });
    expect((await connectionRow(w.connection.id))?.attention).toBeNull();
  });

  it("sends nothing when switched off, the plan lapsed or the connection is gone", async () => {
    const off = await world();
    const a = value(await ask(off, off.owner.id));
    await run(a.id, NOW, await jobDeps(off.fake, { enabled: false }));
    expect(await issueRow(a.id)).toMatchObject({ state: "failed", failure: "unavailable" });

    const lapsed = await world();
    const b = value(await ask(lapsed, lapsed.owner.id));
    await grantPlan(lapsed.owner.id, "free");
    await run(b.id, NOW, await jobDeps(lapsed.fake));
    expect(await issueRow(b.id)).toMatchObject({ state: "failed", failure: "plan_lapsed" });

    const removed = await world();
    const c = value(await ask(removed, removed.owner.id));
    value(
      await removeIntegrationConnection(db(), {
        actor: personalActor(removed.owner.id),
        connectionId: removed.connection.id,
        now: NOW,
      }),
    );
    await run(c.id, NOW, await jobDeps(removed.fake));
    expect(await issueRow(c.id)).toMatchObject({ state: "failed", failure: "connection_removed" });
    for (const w of [off, lapsed, removed]) expect(w.fake.issues).toHaveLength(0);
  });

  it("waits for the next day past the owner's daily attempts", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .global.insert(schema.rateLimits)
      .values({
        key: `integration:attempts:${w.owner.id}:${Date.UTC(2026, 10, 8)}`,
        windowStart: NOW,
        count: INTEGRATION_LIMITS.attemptsPerOwnerPerDay,
      });
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("kept");
    expect(await issueRow(issue.id)).toMatchObject({ state: "pending", attempts: 0 });
    expect((await jobFor(issue.id))?.availableAt).toBe(Date.UTC(2026, 10, 9));
    expect(w.fake.requests).toHaveLength(2);
  });

  it("takes the job back from the safety-net scan when its outbox row was lost", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, issue.id));
    const result = await runMaintenance(db(), env.ARTIFACTS, NOW + 2 * 3_600_000);
    expect(result.threadIssues).toBeGreaterThanOrEqual(1);
    expect(await jobFor(issue.id)).toBeDefined();
  });
});

describe("deletion and export", () => {
  it("deletes an account's connections, clears who asked for issues, and exports no credential", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    const exported = value(await exportAccount(db(), { userId: w.owner.id, now: NOW }));
    expect(exported.account.integrations).toEqual([
      {
        id: w.connection.id,
        service: "github",
        label: "Product repo",
        identity: "octo-bot",
        targets: ["acme/site"],
        createdAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain(TOKEN.slice(-12));
    // A workspace admin who asked for an issue: their account goes, the issue keeps no trace.
    const sessionId = await session(w.owner.id);
    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: w.owner.id,
        sessionId,
        confirmEmail: w.owner.email,
        now: NOW,
      }),
    );
    expect(await connectionRow(w.connection.id)).toBeUndefined();
    const row = await issueRow(issue.id);
    expect(row?.requestedBy ?? null).toBeNull();
  });

  it("deletes a workspace's connections with the workspace, and keeps a member's own", async () => {
    const admin = await person();
    const ws = await workspace([[admin.id, "admin"]]);
    await grantPlan(ws, "team");
    await grantPlan(admin.id, "team");
    const theirs = await connectGitHub(await actorIn(admin.id, ws));
    const mine = await connectGitHub(personalActor(admin.id));
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws, now: NOW }));
    expect(await connectionRow(theirs.id)).toBeUndefined();
    expect(await connectionRow(mine.id)).toBeDefined();
    await advanceWorkspaceDeletion(regionsFromEnv(env), ws, NOW + 1);
    expect(await connectionRow(mine.id)).toBeDefined();
  });
});

/** A database over a D1 binding that counts round trips and the statements of each batch. */
function counting() {
  const calls = { roundTrips: 0, batchSizes: [] as number[] };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const real = Reflect.get(target, property, receiver);
        if (typeof real !== "function") return real;
        if (property === "bind") {
          return (...args: unknown[]) => wrapStatement(real.apply(target, args));
        }
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
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
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

/** A database whose every D1 batch first runs `before` (a write that races the request). */
function racingBatch(before: () => Promise<unknown>) {
  let armed = true;
  const d1 = new Proxy(env.DB, {
    get(target, property, receiver) {
      const real = Reflect.get(target, property, receiver);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (armed) {
            armed = false;
            await before();
          }
          return target.batch(statements);
        };
      }
      return typeof real === "function" ? real.bind(target) : real;
    },
  });
  return regionalDb(d1, globalDb(d1));
}

async function teamWorld() {
  const admin = await person();
  const editor = await person();
  // A second admin, so the first can be removed (the last admin never can).
  const other = await person();
  const ws = await workspace([
    [admin.id, "admin"],
    [editor.id, "editor"],
    [other.id, "admin"],
  ]);
  await grantPlan(ws, "team");
  const fake = trackers();
  const connection = await connectGitHub(await actorIn(admin.id, ws), fake);
  const a = await artifact(ws);
  const threadId = await thread(a, editor.id, "Words of the editor");
  return { admin, editor, ws, fake, connection, a, threadId };
}

const removeMember = (ws: string, userId: string) =>
  db()
    .global.delete(schema.workspaceMembers)
    .where(
      and(eq(schema.workspaceMembers.workspaceId, ws), eq(schema.workspaceMembers.userId, userId)),
    );

describe("checked again when the job sends", () => {
  it("never writes to a repository an admin removed from the connection after the request", async () => {
    const w = await world();
    const issue = value(
      await ask(w, w.owner.id, {
        include: { link: true, artifactName: true, quote: false, message: true },
      }),
    );
    value(
      await updateIntegrationConnection(db(), {
        actor: personalActor(w.owner.id),
        connectionId: w.connection.id,
        update: { targets: ["acme/docs"] },
        deps: await deps(w.fake),
        now: NOW + 1,
      }),
    );
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW + 2, await jobDeps(w.fake))).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "target_removed" });
    expect(w.fake.requests).toHaveLength(before);
    expect(w.fake.issues).toHaveLength(0);
  });

  it("fails the artifact's pending requests in the transfer's batch, and never sends them", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const ws = await workspace([[owner.id, "admin"]]);
    await grantPlan(ws, "team");
    const fake = trackers();
    const connection = await connectGitHub(personalActor(owner.id), fake);
    const a = await artifact(owner.id);
    const threadId = await thread(a, owner.id, "Words");
    const issue = value(await ask({ a, threadId, connection }, owner.id));
    const slug = ws.slice(3, 23);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId: a.id,
        workspace: slug,
        now: NOW + 1,
      }),
    );
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "artifact_moved" });
    expect(await run(issue.id, NOW + 2, await jobDeps(fake))).toBe("done");
    expect(fake.issues).toHaveLength(0);
  });

  it("fails a request whose artifact changed owner without a transfer, before any call", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    const other = await person();
    await db()
      .update(schema.artifacts)
      .set({ ownerId: other.id })
      .where(eq(schema.artifacts.id, w.a.id));
    const before = w.fake.requests.length;
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "artifact_moved" });
    expect(w.fake.requests).toHaveLength(before);
  });

  it("fails a request whose thread went away while a lost issue was looked for, on its claim", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next(new Response("busy", { status: 503 }));
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("kept");
    // During the lookup of the second attempt the artifact goes to someone else.
    const other = await person();
    w.fake.next(async () => {
      await db()
        .update(schema.artifacts)
        .set({ ownerId: other.id })
        .where(eq(schema.artifacts.id, w.a.id));
      return Response.json([]);
    });
    expect(
      await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], await jobDeps(w.fake)),
    ).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "thread_gone",
      startedAt: null,
    });
    expect(w.fake.issues).toHaveLength(0);
    // Never requeued again.
    expect(await requeueThreadIssues(db(), NOW + 2 * 86_400_000)).toBe(0);
  });

  it("fails a request whose artifact was deleted, without calling the service", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .update(schema.artifacts)
      .set({ state: "deleted" })
      .where(eq(schema.artifacts.id, w.a.id));
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "thread_gone" });
    const gone = await world();
    const lost = value(await ask(gone, gone.owner.id));
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, gone.a.id));
    // The row went with the artifact; the job finds nothing.
    expect(await issueRow(lost.id)).toBeUndefined();
  });

  it("caps attempts in the claim, whatever brings the job back", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .update(schema.threadIssues)
      .set({ attempts: 5 })
      .where(eq(schema.threadIssues.id, issue.id));
    const before = w.fake.requests.length;
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "service_unavailable",
      attempts: 5,
    });
    expect(w.fake.requests).toHaveLength(before);
  });

  it("does not send for an editor who left the workspace, nor for a deleted account", async () => {
    const t = await teamWorld();
    const w = { a: t.a, threadId: t.threadId, connection: t.connection };
    const issue = value(
      await ask(w, t.editor.id, {
        include: { link: true, artifactName: true, quote: false, message: true },
      }),
    );
    await removeMember(t.ws, t.editor.id);
    expect(await run(issue.id, NOW, await jobDeps(t.fake))).toBe("done");
    expect(await issueRow(issue.id)).toMatchObject({ state: "failed", failure: "requester_left" });
    expect(t.fake.issues).toHaveLength(0);
    expect((await auditOf(t.ws)).some((e) => e.kind === "issue.created")).toBe(false);
    const again = value(await ask(w, t.admin.id));
    await db()
      .update(schema.threadIssues)
      .set({ requestedBy: null })
      .where(eq(schema.threadIssues.id, again.id));
    await run(again.id, NOW, await jobDeps(t.fake));
    expect(await issueRow(again.id)).toMatchObject({ state: "failed", failure: "requester_left" });
  });

  it("sends for an editor who is still one, under their name", async () => {
    const t = await teamWorld();
    const issue = value(
      await ask({ a: t.a, threadId: t.threadId, connection: t.connection }, t.editor.id),
    );
    await run(issue.id, NOW, await jobDeps(t.fake));
    expect(await issueRow(issue.id)).toMatchObject({ state: "created" });
    const [event] = (await auditOf(t.ws)).filter((e) => e.kind === "issue.created");
    expect(event?.actorId).toBe(t.editor.id);
  });
});

describe("connection writes and races", () => {
  it("stores nothing when the admin is removed while the credential is checked", async () => {
    const t = await teamWorld();
    const fake = trackers();
    fake.next(async () => {
      await removeMember(t.ws, t.admin.id);
      return Response.json({ login: "octo-bot" });
    });
    const actor = {
      userId: t.admin.id,
      ownerId: t.ws,
      role: "admin" as const,
      region: "default" as const,
    };
    const created = await createIntegrationConnection(db(), {
      actor,
      connection: { service: "github", label: "Late", credential: TOKEN, targets: ["acme/site"] },
      deps: await deps(fake),
      now: NOW,
    });
    expect(created).toMatchObject({ ok: false, code: "not_found" });
    const rows = await db()
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.ownerId, t.ws),
          eq(schema.integrationConnections.label, "Late"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("refuses a change when the admin is removed while the new credential is checked", async () => {
    const t = await teamWorld();
    const fake = trackers();
    const second = `${TOKEN.slice(0, -4)}QQQQ`;
    fake.github(second, "other-bot", ["acme/site"]);
    fake.next(async () => {
      await removeMember(t.ws, t.admin.id);
      return Response.json({ login: "other-bot" });
    });
    const actor = {
      userId: t.admin.id,
      ownerId: t.ws,
      role: "admin" as const,
      region: "default" as const,
    };
    expect(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: t.connection.id,
        update: { credential: second },
        deps: await deps(fake),
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect((await connectionRow(t.connection.id))?.credentialHint).toBe(`…${TOKEN.slice(-4)}`);
  });

  it("holds the admin inside the batch with one database: a removal racing the write changes nothing", async () => {
    const t = await teamWorld();
    const actor = {
      userId: t.admin.id,
      ownerId: t.ws,
      role: "admin" as const,
      region: "default" as const,
    };
    const racing = () => racingBatch(() => removeMember(t.ws, t.admin.id));
    expect(
      await createIntegrationConnection(racing(), {
        actor,
        connection: {
          service: "github",
          label: "Raced",
          credential: TOKEN,
          targets: ["acme/site"],
        },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: t.ws, userId: t.admin.id, role: "admin", updatedAt: NOW });
    expect(
      await updateIntegrationConnection(racing(), {
        actor,
        connectionId: t.connection.id,
        update: { label: "Raced" },
        deps: await deps(trackers()),
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: t.ws, userId: t.admin.id, role: "admin", updatedAt: NOW });
    expect(
      await removeIntegrationConnection(racing(), {
        actor,
        connectionId: t.connection.id,
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await connectionRow(t.connection.id)).toMatchObject({ label: "Product repo" });
  });

  it("answers a conflict when another change landed first, and the cap when it was full", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const connection = await connectGitHub(actor);
    const raced = racingBatch(() =>
      db()
        .update(schema.integrationConnections)
        .set({ revision: 9 })
        .where(eq(schema.integrationConnections.id, connection.id)),
    );
    expect(
      await updateIntegrationConnection(raced, {
        actor,
        connectionId: connection.id,
        update: { label: "Mine" },
        deps: await deps(trackers()),
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    for (let i = 1; i < INTEGRATION_LIMITS.perOwner - 1; i += 1) await connectGitHub(actor);
    // The last slot is taken between the count and the insert.
    const full = racingBatch(() => connectGitHub(actor));
    expect(
      await createIntegrationConnection(full, {
        actor,
        connection: {
          service: "github",
          label: "One more",
          credential: TOKEN,
          targets: ["acme/site"],
        },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
    // Removing one already gone answers like a missing one.
    const gone = racingBatch(() =>
      db()
        .delete(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connection.id)),
    );
    expect(
      await removeIntegrationConnection(gone, { actor, connectionId: connection.id, now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("never writes a Test's answer over a credential pasted meanwhile", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const fake = trackers();
    const connection = await connectGitHub(actor, fake);
    const rotate = () =>
      db()
        .update(schema.integrationConnections)
        .set({
          revision: 2,
          credentialBox: "new-sealed-value",
          identity: "new-bot",
          attention: null,
        })
        .where(eq(schema.integrationConnections.id, connection.id));
    fake.next(async () => {
      await rotate();
      return Response.json({ login: "octo-bot" });
    });
    value(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        deps: await deps(fake),
        now: NOW,
      }),
    );
    expect(await connectionRow(connection.id)).toMatchObject({
      identity: "new-bot",
      credentialBox: "new-sealed-value",
    });
    // A refusal about the old credential does not mark the new one either.
    const other = await connectGitHub(actor, fake);
    fake.next(async () => {
      await db()
        .update(schema.integrationConnections)
        .set({ revision: 2, credentialBox: "rotated" })
        .where(eq(schema.integrationConnections.id, other.id));
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    });
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor,
          connectionId: other.id,
          deps: await deps(fake),
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false, problem: "credential_rejected" });
    expect((await connectionRow(other.id))?.attention).toBeNull();
  });

  it("does not mark a connection whose credential was replaced while the job's call was refused", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next(async () => {
      await db()
        .update(schema.integrationConnections)
        .set({ revision: 2, credentialBox: "rotated" })
        .where(eq(schema.integrationConnections.id, w.connection.id));
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    });
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "credential_rejected",
    });
    expect((await connectionRow(w.connection.id))?.attention).toBeNull();
  });

  it("marks a connection whose stored credential no longer opens, from a Test and from the job", async () => {
    const w = await world();
    await db()
      .update(schema.integrationConnections)
      .set({ keyId: "retired-key" })
      .where(eq(schema.integrationConnections.id, w.connection.id));
    const issue = value(await ask(w, w.owner.id));
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "credential_rejected",
    });
    expect((await connectionRow(w.connection.id))?.attention).toBe("key_unavailable");
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor: personalActor(w.owner.id),
          connectionId: w.connection.id,
          deps: await deps(w.fake),
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false, problem: "credential_rejected" });
    expect(
      await updateIntegrationConnection(db(), {
        actor: personalActor(w.owner.id),
        connectionId: w.connection.id,
        update: { targets: ["acme/docs"] },
        deps: await deps(w.fake),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("lookups, links and limits", () => {
  it("links only an issue the connection's account opened, never a copied reference or a pull request", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    const copied = `Look: Reference: ${issue.id}`;
    w.fake.next(new Response("busy", { status: 503 }));
    await run(issue.id, NOW, await jobDeps(w.fake));
    w.fake.plant("acme/site", { body: copied, author: "mallory" });
    w.fake.plant("acme/site", { body: copied, author: "octo-bot", pullRequest: true });
    await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], await jobDeps(w.fake));
    const row = await issueRow(issue.id);
    expect(row?.state).toBe("created");
    const created = w.fake.issues.find((i) => i.author === "octo-bot" && !i.pullRequest);
    expect(row?.issueUrl).toBe(created?.url);
  });

  it("links the oldest of the connection's own matches", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next("lose");
    await run(issue.id, NOW, await jobDeps(w.fake));
    const first = w.fake.issues[0];
    w.fake.plant("acme/site", { body: `Reference: ${issue.id}`, author: "octo-bot" });
    await run(issue.id, NOW + INTEGRATION_LIMITS.retryDelaysMs[0], await jobDeps(w.fake));
    expect((await issueRow(issue.id))?.issueUrl).toBe(first?.url);
  });

  it("refuses a Linear answer that links another issue than the one it named", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = trackers();
    const connection = value(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: { service: "linear", label: "Linear", credential: LINEAR_KEY, targets: [TEAM] },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    const a = await artifact(owner.id);
    const threadId = await thread(a, owner.id, "Words");
    const issue = value(await ask({ a, threadId, connection }, owner.id, { target: TEAM }));
    fake.next(
      Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-2/other" },
          },
        },
      }),
    );
    await run(issue.id, NOW, await jobDeps(fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "invalid_response",
    });
    // An answer that says it failed is refused as such.
    const again = value(await ask({ a, threadId, connection }, owner.id, { target: TEAM }));
    fake.next(Response.json({ data: { issueCreate: { success: false } } }));
    await run(again.id, NOW, await jobDeps(fake));
    expect(await issueRow(again.id)).toMatchObject({ state: "failed", failure: "rejected" });
  });

  it("retries GitHub's secondary rate limit instead of failing the target", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    w.fake.next(
      Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
    );
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("kept");
    expect(await issueRow(issue.id)).toMatchObject({ state: "pending", failure: null });
  });

  it("limits credential checks per admin across owners", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    await db()
      .global.insert(schema.rateLimits)
      .values({
        key: `integration:check:user:${owner.id}`,
        windowStart: NOW,
        count: INTEGRATION_LIMITS.checksPerAdminPerHour,
      });
    expect(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      code: "rate_limited",
      message: expect.stringContaining("per person"),
    });
  });

  it("gives the daily count back for a retried request and a refused one", async () => {
    const w = await world();
    const count = async () =>
      Number(
        (
          await db()
            .global.select({ count: schema.rateLimits.count })
            .from(schema.rateLimits)
            .where(
              eq(
                schema.rateLimits.key,
                `integration:issues:${w.owner.id}:${Date.UTC(2026, 10, 8)}`,
              ),
            )
        )[0]?.count ?? 0,
      );
    const key = crypto.randomUUID();
    value(await ask(w, w.owner.id, { key }));
    value(await ask(w, w.owner.id, { key }));
    expect(await count()).toBe(1);
    await db()
      .update(schema.integrationConnections)
      .set({ attention: "credential_rejected" })
      .where(eq(schema.integrationConnections.id, w.connection.id));
    // A connection marked between the read and the batch: nothing inserted, nothing counted.
    const raced = racingBatch(async () => {});
    await db()
      .update(schema.integrationConnections)
      .set({ attention: null })
      .where(eq(schema.integrationConnections.id, w.connection.id));
    const markLater = racingBatch(() =>
      db()
        .update(schema.integrationConnections)
        .set({ attention: "credential_rejected" })
        .where(eq(schema.integrationConnections.id, w.connection.id)),
    );
    expect(await ask(w, w.owner.id, { database: markLater })).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(await count()).toBe(1);
    void raced;
  });

  it("refuses the daily cap and keeps the count where it was", async () => {
    const w = await world();
    const key = `integration:issues:${w.owner.id}:${Date.UTC(2026, 10, 8)}`;
    await db()
      .global.insert(schema.rateLimits)
      .values({ key, windowStart: NOW, count: INTEGRATION_LIMITS.issuesPerOwnerPerDay });
    expect(await ask(w, w.owner.id)).toMatchObject({ code: "rate_limited" });
    const [row] = await db()
      .global.select()
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.key, key));
    expect(row?.count).toBe(INTEGRATION_LIMITS.issuesPerOwnerPerDay);
  });
});

describe("restores, per region", () => {
  it("deletes connections a restore brought back, paging past D1's parameter limit", async () => {
    const w = await world();
    const snapshot = await connectionRow(w.connection.id);
    if (!snapshot) throw new Error("setup");
    value(
      await removeIntegrationConnection(db(), {
        actor: personalActor(w.owner.id),
        connectionId: w.connection.id,
        now: NOW,
      }),
    );
    // More markers than one statement may bind, all sorting before the real one.
    const markers = Array.from({ length: 95 }, (_, i) => ({
      kind: "integration_connection" as const,
      id: `ic_0${String(i).padStart(3, "0")}`,
      deletedAt: NOW,
    }));
    for (let i = 0; i < markers.length; i += 30) {
      await db()
        .global.insert(schema.tombstones)
        .values(markers.slice(i, i + 30));
    }
    await db().insert(schema.integrationConnections).values(snapshot);
    const applied = await applyIntegrationTombstones(regionsFromEnv(env));
    expect(applied.integrations).toBeGreaterThanOrEqual(1);
    expect(await connectionRow(w.connection.id)).toBeUndefined();
  });

  it("deletes a deleted account's connections and forgets it as who connected a workspace's", async () => {
    const t = await teamWorld();
    await db()
      .global.insert(schema.tombstones)
      .values({ kind: "account", id: t.admin.id, deletedAt: NOW });
    await applyIntegrationTombstones(regionsFromEnv(env));
    expect((await connectionRow(t.connection.id))?.createdBy).toBeNull();
  });
});

describe("every refusal of the connection paths", () => {
  async function owner() {
    const who = await person();
    await grantPlan(who.id, "team");
    return { who, actor: personalActor(who.id) };
  }

  it("reads stored targets that are not a list as none", () => {
    expect(storedTargets("not json")).toEqual([]);
    expect(storedTargets("{}")).toEqual([]);
    expect(storedTargets('[{"id":1,"name":"x"},{"id":"a/b","name":"a/b"}]')).toEqual([
      { id: "a/b", name: "a/b" },
    ]);
  });

  it.each([
    [
      "github",
      "credential_rejected",
      null,
      "GitHub refused the token: it is wrong, expired or revoked.",
    ],
    ["linear", "credential_rejected", null, "Linear refused the API key: it is wrong or revoked."],
    [
      "github",
      "missing_permission",
      null,
      "GitHub accepted the credential but it cannot read its own account.",
    ],
    ["github", "target_unreachable", null, expect.stringContaining("cannot reach a repository")],
    [
      "linear",
      "target_unreachable",
      null,
      "The API key cannot see the team. Check the team ID and that the key's account is in that team.",
    ],
    ["github", "issues_disabled", null, "Issues are turned off in the repository."],
    [
      "linear",
      "rate_limited",
      null,
      "Linear is limiting requests from this credential. Try again later.",
    ],
    ["github", "service_unavailable", null, "GitHub did not answer. Try again later."],
  ] as const)("words %s %s", (service, problem, target, message) => {
    expect(checkProblemMessage(service, problem, target)).toEqual(message);
  });

  it("names nobody as who connected once that account is gone", async () => {
    const { who, actor } = await owner();
    const connection = await connectGitHub(actor);
    await db()
      .update(schema.integrationConnections)
      .set({ createdBy: null })
      .where(eq(schema.integrationConnections.id, connection.id));
    const listed = value(await listIntegrationConnections(db(), { actor, service: ON, now: NOW }));
    expect(listed.connections[0]?.createdBy).toBeNull();
    void who;
  });

  it("refuses creating past the daily creates, and checking past the owner's hourly checks", async () => {
    const { who, actor } = await owner();
    await db()
      .global.insert(schema.rateLimits)
      .values({
        key: `integration:create:${who.id}`,
        windowStart: NOW,
        count: INTEGRATION_LIMITS.createsPerOwnerPerDay,
      });
    const create = async () =>
      createIntegrationConnection(db(), {
        actor,
        connection: { service: "github", label: "X", credential: TOKEN, targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      });
    expect(await create()).toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("created a day"),
    });
    const other = await owner();
    const connection = await connectGitHub(other.actor);
    await db()
      .global.insert(schema.rateLimits)
      .values({
        key: `integration:check:${other.who.id}`,
        windowStart: NOW,
        count: INTEGRATION_LIMITS.checksPerOwnerPerHour,
      })
      .onConflictDoUpdate({
        target: schema.rateLimits.key,
        set: { count: INTEGRATION_LIMITS.checksPerOwnerPerHour, windowStart: NOW },
      });
    expect(
      await updateIntegrationConnection(db(), {
        actor: other.actor,
        connectionId: connection.id,
        update: { targets: ["acme/docs"] },
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ code: "rate_limited" });
    expect(
      await testIntegrationConnection(db(), {
        actor: other.actor,
        connectionId: connection.id,
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("refuses changing for an editor, while switched off, without a key, and with bad targets", async () => {
    const t = await teamWorld();
    const editor = await actorIn(t.editor.id, t.ws);
    const update = async (
      actor: Actor,
      extra: Partial<IntegrationDeps> = {},
      targets = ["acme/docs"],
    ) =>
      updateIntegrationConnection(db(), {
        actor,
        connectionId: t.connection.id,
        update: { targets },
        deps: await deps(trackers(), extra),
        now: NOW,
      });
    expect(await update(editor)).toMatchObject({ code: "forbidden" });
    const admin = await actorIn(t.admin.id, t.ws);
    expect(await update(admin, { service: { enabled: false } })).toMatchObject({
      code: "capacity_unavailable",
    });
    expect(await update(admin, { keys: [] })).toMatchObject({ code: "capacity_unavailable" });
    expect(await update(admin, {}, ["not a repo"])).toMatchObject({ code: "invalid_input" });
    expect(
      await testIntegrationConnection(db(), {
        actor: editor,
        connectionId: t.connection.id,
        deps: await deps(trackers()),
        now: NOW,
      }),
    ).toMatchObject({ code: "forbidden" });
    // The same label and targets change nothing and record nothing.
    const same = value(
      await updateIntegrationConnection(db(), {
        actor: admin,
        connectionId: t.connection.id,
        update: { label: "Product repo", targets: ["acme/site"] },
        deps: await deps(trackers()),
        now: NOW,
      }),
    );
    expect(same.label).toBe("Product repo");
    expect((await auditOf(t.ws)).filter((e) => e.kind === "integration.changed")).toHaveLength(0);
  });

  it("keeps a connection's state when a Test finds a repository unreachable", async () => {
    const { actor } = await owner();
    const fake = trackers();
    const connection = await connectGitHub(actor, fake);
    fake.next(
      Response.json({ login: "octo-bot" }),
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor,
          connectionId: connection.id,
          deps: await deps(fake),
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false, problem: "target_unreachable", target: "acme/site" });
    expect((await connectionRow(connection.id))?.attention).toBeNull();
  });

  it("re-seals nothing without a key, and skips a credential no key opens", async () => {
    const { actor } = await owner();
    const connection = await connectGitHub(actor);
    expect(await rewrapIntegrationKeys(db(), [])).toEqual({ rewrapped: 0, left: 0 });
    const keys = await integrationKeys({ current: OTHER_KEY_TEXT, previous: KEY_TEXT });
    await db()
      .update(schema.integrationConnections)
      .set({ credentialBox: "AAAA" })
      .where(eq(schema.integrationConnections.id, connection.id));
    const result = await rewrapIntegrationKeys(db(), keys);
    expect((await connectionRow(connection.id))?.credentialBox).toBe("AAAA");
    expect(result.left).toBeGreaterThanOrEqual(1);
  });
});

describe("every refusal of the request and the job", () => {
  it("refuses an empty title", async () => {
    const w = await world();
    expect(
      await requestThreadIssue(db(), {
        userId: w.owner.id,
        artifactId: w.a.id,
        threadId: w.threadId,
        request: {
          connectionId: w.connection.id,
          target: "acme/site",
          title: " \u200b ",
          include: { link: true, artifactName: true, quote: false, message: false },
        },
        idempotencyKey: crypto.randomUUID(),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input", message: "Write a title." });
  });

  it("answers the per-thread cap when the last slot is taken in a race", async () => {
    const w = await world();
    for (let i = 1; i < INTEGRATION_LIMITS.issuesPerThread; i += 1) value(await ask(w, w.owner.id));
    const raced = racingBatch(() => ask(w, w.owner.id));
    expect(await ask(w, w.owner.id, { database: raced })).toMatchObject({ code: "quota_exceeded" });
  });

  it("fails a request whose connection needs attention by the time the job runs", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .update(schema.integrationConnections)
      .set({ attention: "credential_rejected" })
      .where(eq(schema.integrationConnections.id, w.connection.id));
    await run(issue.id, NOW, await jobDeps(w.fake));
    expect(await issueRow(issue.id)).toMatchObject({
      state: "failed",
      failure: "credential_rejected",
    });
  });

  it("leaves an attempt another run holds alone", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .update(schema.threadIssues)
      .set({ startedAt: NOW })
      .where(eq(schema.threadIssues.id, issue.id));
    expect(await run(issue.id, NOW + 1_000, await jobDeps(w.fake))).toBe("kept");
    expect(await issueRow(issue.id)).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("does nothing for a duplicate message before the retry is due", async () => {
    const w = await world();
    const issue = value(await ask(w, w.owner.id));
    await db()
      .update(schema.outbox)
      .set({ availableAt: NOW + 60_000 })
      .where(eq(schema.outbox.subject, issue.id));
    expect(await run(issue.id, NOW, await jobDeps(w.fake))).toBe("kept");
    expect(w.fake.issues).toHaveLength(0);
  });
});
