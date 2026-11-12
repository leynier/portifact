// Slack connections (decision 0025, delivery 1): starting a pending connection, completing it with
// the bot token and signing secret checked by `auth.test`, testing, removing with `auth.revoke`,
// the pending scan, the inbound signature check and the uninstall events, every refusal and the
// permission boundaries, against the real D1 schema in workerd and the fake Slack in
// @portifact/services/testing. Nothing here reaches Slack.
import { env } from "cloudflare:test";
import { type JobMessage, SLACK_LIMITS, SLACK_MANIFEST_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import {
  type Actor,
  openSlackCredential,
  personalActor,
  SLACK_ROTATING_TOKEN,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount } from "../src/account-data.ts";
import { actorOn } from "../src/actors.ts";
import { createAnnotationThread } from "../src/annotations.ts";
import { integrationKeys, openCredential } from "../src/integration-keys.ts";
import {
  applySlackEvent,
  createIntegrationConnection,
  type IntegrationDeps,
  listIntegrationChoices,
  listIntegrationConnections,
  prunePendingConnections,
  removeIntegrationConnection,
  rewrapIntegrationKeys,
  SLACK_UNAVAILABLE,
  testIntegrationConnection,
  updateIntegrationConnection,
  verifySlackRequest,
} from "../src/integrations.ts";
import { runJob } from "../src/outbox.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";
import { FakeSlack } from "../src/testing/fake-slack.ts";
import { requestThreadIssue } from "../src/thread-issues.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, racing, value } from "./fixtures.ts";

const KEY_TEXT = "test-only integrations sealing key, long enough to use";
const OTHER_KEY = "another test-only integrations key, long enough too";
const ON = { enabled: true, slack: true };

async function deps(fake: FakeSlack, service = ON, key = KEY_TEXT): Promise<IntegrationDeps> {
  return { keys: await integrationKeys({ current: key }), service, fetch: fake.fetch };
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

async function workspace(members: [string, "admin" | "editor" | "member"][]) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .global.insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: "x", updatedAt: NOW });
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

async function auditOf(ownerId: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.ownerId, ownerId))
    .orderBy(schema.auditEvents.at, sql`rowid`);
}

async function row(id: string) {
  const [found] = await db()
    .select()
    .from(schema.integrationConnections)
    .where(eq(schema.integrationConnections.id, id));
  return found;
}

async function start(actor: Actor, fake: FakeSlack, service = ON) {
  return createIntegrationConnection(db(), {
    actor,
    connection: { service: "slack", label: "Acme Slack" },
    deps: await deps(fake, service),
    now: NOW,
  });
}

async function complete(
  actor: Actor,
  connectionId: string,
  fake: FakeSlack,
  credential: { botToken: string; signingSecret: string },
  now = NOW,
) {
  return updateIntegrationConnection(db(), {
    actor,
    connectionId,
    update: credential,
    deps: await deps(fake),
    now,
  });
}

/** An owner on Team with a completed Slack connection. */
async function connected() {
  const owner = await person();
  await grantPlan(owner.id, "team");
  const actor = personalActor(owner.id);
  const botToken = FakeSlack.botToken();
  const signingSecret = FakeSlack.signingSecret();
  const fake = new FakeSlack().bot(botToken, "Acme", "T0ACME01");
  const pending = value(await start(actor, fake));
  const done = value(await complete(actor, pending.id, fake, { botToken, signingSecret }));
  return { owner, actor, fake, botToken, signingSecret, connection: done };
}

describe("starting a Slack connection", () => {
  it("stores a pending row that holds nothing, calls nobody and records nothing", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = new FakeSlack();
    const started = value(await start(personalActor(owner.id), fake));
    expect(started).toMatchObject({
      service: "slack",
      label: "Acme Slack",
      attention: "pending",
      usable: false,
      targets: [],
      identity: "",
      credentialHint: "",
      manifestVersion: null,
    });
    expect(fake.requests).toEqual([]);
    const stored = await row(started.id);
    expect(stored).toMatchObject({ keyId: "", credentialBox: "", externalId: null });
    // No key opens it.
    const keys = await integrationKeys({ current: KEY_TEXT });
    expect(await openCredential(keys, "", started.id, "")).toBeNull();
    expect(await auditOf(owner.id)).toEqual([]);
  });

  it("counts against the five connections and the daily creates like any connection", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    for (let i = 0; i < 5; i += 1) value(await start(actor, new FakeSlack()));
    expect(await start(actor, new FakeSlack())).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("is refused while Slack is off, without the plan, and to anyone but an admin", async () => {
    const admin = await person();
    const editor = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [editor.id, "editor"],
    ]);
    const fake = new FakeSlack();
    expect(await start(await actorIn(admin.id, ws), fake)).toMatchObject({
      ok: false,
      code: "plan_required",
    });
    await grantPlan(ws, "team");
    expect(await start(await actorIn(admin.id, ws), fake, { enabled: true, slack: false })).toEqual(
      { ok: false, code: "capacity_unavailable", message: SLACK_UNAVAILABLE },
    );
    expect(
      await start(await actorIn(admin.id, ws), fake, { enabled: false, slack: true }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(await start(await actorIn(editor.id, ws), fake)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    value(await start(await actorIn(admin.id, ws), fake));
  });
});

describe("completing a Slack connection", () => {
  it("checks the token with one auth.test, seals the pair and records integration.connected", async () => {
    const { owner, fake, botToken, signingSecret, connection } = await connected();
    expect(connection).toMatchObject({
      attention: null,
      usable: true,
      identity: "Acme",
      credentialHint: `…${botToken.slice(-4)}`,
      manifestVersion: SLACK_MANIFEST_VERSION,
    });
    expect(fake.requests.map((r) => r.url)).toEqual(["https://slack.com/api/auth.test"]);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${botToken}` },
    });
    const stored = await row(connection.id);
    expect(stored?.externalId).toBe("T0ACME01");
    const keys = await integrationKeys({ current: KEY_TEXT });
    const opened = await openCredential(
      keys,
      String(stored?.keyId),
      connection.id,
      String(stored?.credentialBox),
    );
    expect(openSlackCredential(String(opened))).toEqual({ botToken, signingSecret });
    const events = await auditOf(owner.id);
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["integration.connected", { service: "slack", targets: 0 }],
    ]);
    // Nothing of the Slack workspace or the credential in the event.
    expect(JSON.stringify(events)).not.toContain("T0ACME01");
    expect(JSON.stringify(events)).not.toContain(botToken);
  });

  it("refuses rotating, user and wrong tokens and bad secrets, each with its own message", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const user = FakeSlack.userToken();
    const fake = new FakeSlack().user(user);
    const pending = value(await start(actor, fake));
    const secret = FakeSlack.signingSecret();
    expect(
      await complete(actor, pending.id, fake, {
        botToken: FakeSlack.rotatingToken(),
        signingSecret: secret,
      }),
    ).toEqual({ ok: false, code: "invalid_input", message: SLACK_ROTATING_TOKEN });
    expect(
      await complete(actor, pending.id, fake, { botToken: user, signingSecret: secret }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/starts with xoxb-/) });
    expect(
      await complete(actor, pending.id, fake, {
        botToken: FakeSlack.botToken(),
        signingSecret: "not hex",
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Signing Secret/) });
    // Nothing reached Slack so far.
    expect(fake.requests).toEqual([]);
    expect(
      await complete(actor, pending.id, fake, {
        botToken: FakeSlack.botToken(),
        signingSecret: secret,
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/refused the bot token/) });
    // A user token that passed the shape check (an xoxb- token Slack answers without a bot).
    const userLike = FakeSlack.botToken();
    fake.user(userLike);
    expect(
      await complete(actor, pending.id, fake, { botToken: userLike, signingSecret: secret }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/not the app's bot token/) });
    fake.next(new Response("busy", { status: 503 }));
    const good = FakeSlack.botToken();
    fake.bot(good);
    expect(
      await complete(actor, pending.id, fake, { botToken: good, signingSecret: secret }),
    ).toMatchObject({ ok: false, message: "Slack did not answer. Try again later." });
    fake.next(new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
    expect(
      await complete(actor, pending.id, fake, { botToken: good, signingSecret: secret }),
    ).toMatchObject({ ok: false, message: "Slack did not answer. Try again later." });
    fake.next(Response.json({ ok: false, error: "ratelimited" }));
    expect(
      await complete(actor, pending.id, fake, { botToken: good, signingSecret: secret }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/limiting/) });
    expect((await row(pending.id))?.attention).toBe("pending");
  });

  it("takes only the bot token and the secret, and nothing for a pending row without them", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const fake = new FakeSlack();
    const pending = value(await start(actor, fake));
    const update = (u: Record<string, unknown>) =>
      deps(fake).then((d) =>
        updateIntegrationConnection(db(), {
          actor,
          connectionId: pending.id,
          update: u,
          deps: d,
          now: NOW,
        }),
      );
    for (const u of [
      { credential: FakeSlack.botToken() },
      { targets: ["acme/site"] },
      { label: "Renamed" },
    ]) {
      expect(await update(u)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(await auditOf(owner.id)).toEqual([]);
  });

  it("is refused while Slack is off, to an editor and without the plan; a removed admin stores nothing", async () => {
    const admin = await person();
    const other = await person();
    const editor = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [other.id, "admin"],
      [editor.id, "editor"],
    ]);
    await grantPlan(ws, "team");
    const botToken = FakeSlack.botToken();
    const fake = new FakeSlack().bot(botToken);
    const pending = value(await start(await actorIn(admin.id, ws), fake));
    const credential = { botToken, signingSecret: FakeSlack.signingSecret() };
    expect(
      await updateIntegrationConnection(db(), {
        actor: await actorIn(admin.id, ws),
        connectionId: pending.id,
        update: credential,
        deps: await deps(fake, { enabled: true, slack: false }),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(
      await complete(await actorIn(editor.id, ws), pending.id, fake, credential),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const actor = await actorIn(admin.id, ws);
    await db()
      .global.update(schema.workspaceMembers)
      .set({ role: "editor" })
      .where(eq(schema.workspaceMembers.userId, admin.id));
    // Decided again after the call to Slack: the demoted admin stores nothing.
    expect(await complete(actor, pending.id, fake, credential)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect((await row(pending.id))?.attention).toBe("pending");
    await db()
      .global.update(schema.workspaceMembers)
      .set({ role: "admin" })
      .where(eq(schema.workspaceMembers.userId, admin.id));
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, ws));
    expect(await complete(actor, pending.id, fake, credential)).toMatchObject({
      ok: false,
      code: "plan_required",
    });
  });

  it("replaces the credential of a completed connection and records integration.changed", async () => {
    const { owner, actor, connection } = await connected();
    const next = FakeSlack.botToken();
    const fake = new FakeSlack().bot(next, "Acme", "T0ACME01");
    const changed = value(
      await complete(actor, connection.id, fake, {
        botToken: next,
        signingSecret: FakeSlack.signingSecret(),
        // A label in the same change.
        ...({ label: "Renamed" } as object),
      }),
    );
    expect(changed).toMatchObject({ label: "Renamed", credentialHint: `…${next.slice(-4)}` });
    const events = await auditOf(owner.id);
    expect(events.at(-1)).toMatchObject({
      kind: "integration.changed",
      detail: { label: true, credential: true },
    });
    // The label alone needs no call.
    const renamed = value(
      await updateIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        update: { label: "Again" },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    expect(renamed.label).toBe("Again");
    expect(fake.requests.length).toBe(1);
  });
});

describe("testing a Slack connection", () => {
  it("passes with auth.test, marks a revoked token and clears the mark once it works again", async () => {
    const { owner, actor, fake, botToken, connection } = await connected();
    const test = async () =>
      testIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        deps: await deps(fake),
        now: NOW,
      });
    expect(value(await test())).toMatchObject({ ok: true, identity: "Acme" });
    fake.revoked.add(botToken);
    expect(value(await test())).toMatchObject({ ok: false, problem: "credential_rejected" });
    expect((await row(connection.id))?.attention).toBe("credential_rejected");
    expect((await auditOf(owner.id)).at(-1)).toMatchObject({
      kind: "integration.failing",
      detail: { service: "slack", reason: "credential_rejected" },
    });
    fake.revoked.delete(botToken);
    expect(value(await test())).toMatchObject({ ok: true });
    expect((await row(connection.id))?.attention).toBeNull();
  });

  it("has nothing to test while pending, and marks a credential no key opens", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const fake = new FakeSlack();
    const pending = value(await start(actor, fake));
    expect(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: pending.id,
        deps: await deps(fake),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const done = await connected();
    expect(
      value(
        await testIntegrationConnection(db(), {
          actor: done.actor,
          connectionId: done.connection.id,
          deps: await deps(done.fake, ON, OTHER_KEY),
          now: NOW,
        }),
      ),
    ).toMatchObject({ ok: false });
    expect((await row(done.connection.id))?.attention).toBe("key_unavailable");
  });
});

describe("removing a Slack connection", () => {
  it("writes the tombstone, deletes the row, then revokes the token at Slack after the answer", async () => {
    const { actor, fake, botToken, connection } = await connected();
    const deferred: Promise<unknown>[] = [];
    value(
      await removeIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        now: NOW,
        slack: {
          enabled: true,
          keys: await integrationKeys({ current: KEY_TEXT }),
          fetch: fake.fetch,
          defer: (task) => deferred.push(task),
        },
      }),
    );
    expect(await row(connection.id)).toBeUndefined();
    const [tombstone] = await db()
      .global.select()
      .from(schema.tombstones)
      .where(
        and(
          eq(schema.tombstones.kind, "integration_connection"),
          eq(schema.tombstones.id, connection.id),
        ),
      );
    expect(tombstone).toBeDefined();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(fake.requests.at(-1)?.url).toBe("https://slack.com/api/auth.revoke");
    expect(fake.revoked.has(botToken)).toBe(true);
  });

  it("calls nobody while Slack is off, for a pending row, or without the hook", async () => {
    for (const enabled of [false, true]) {
      const { actor, fake, connection } = await connected();
      const before = fake.requests.length;
      const deferred: Promise<unknown>[] = [];
      value(
        await removeIntegrationConnection(db(), {
          actor,
          connectionId: connection.id,
          now: NOW,
          ...(enabled
            ? {}
            : {
                slack: {
                  enabled,
                  keys: await integrationKeys({ current: KEY_TEXT }),
                  fetch: fake.fetch,
                  defer: (task: Promise<unknown>) => deferred.push(task),
                },
              }),
        }),
      );
      expect(deferred).toEqual([]);
      expect(fake.requests.length).toBe(before);
    }
    const owner = await person();
    await grantPlan(owner.id, "team");
    const fake = new FakeSlack();
    const pending = value(await start(personalActor(owner.id), fake));
    const deferred: Promise<unknown>[] = [];
    value(
      await removeIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connectionId: pending.id,
        now: NOW,
        slack: {
          enabled: true,
          keys: await integrationKeys({ current: KEY_TEXT }),
          fetch: fake.fetch,
          defer: (task) => deferred.push(task),
        },
      }),
    );
    expect(deferred).toEqual([]);
  });
});

describe("where a Slack connection never counts as an issue tracker", () => {
  it("is left out of the owner side's choices and refused like a missing connection for an issue", async () => {
    const { owner, actor, connection } = await connected();
    const choices = value(await listIntegrationChoices(db(), { actor, service: ON, now: NOW }));
    expect(choices.connections).toEqual([]);
    const admin = value(await listIntegrationConnections(db(), { actor, service: ON, now: NOW }));
    expect(admin.connections.map((c) => c.service)).toEqual(["slack"]);
    const asked = await requestThreadIssue(db(), {
      userId: owner.id,
      artifactId: "aaaaaaaaaaaaaaaa",
      threadId: "t_missing",
      request: {
        connectionId: connection.id,
        target: "x",
        title: "x",
        include: {
          link: true,
          artifactName: true,
          quote: false,
          message: false,
        },
      },
      idempotencyKey: crypto.randomUUID(),
      service: ON,
      now: NOW,
    });
    expect(asked).toMatchObject({ ok: false, code: "not_found" });
  });

  it("leaves pending rows out of the export and the key rotation", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    value(await start(personalActor(owner.id), new FakeSlack()));
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(exported.account.integrations).toEqual([]);
    const keys = await integrationKeys({ current: OTHER_KEY, previous: KEY_TEXT });
    const rotated = await rewrapIntegrationKeys(db(), keys);
    expect(rotated.left).toBe(0);
  });
});

describe("the pending scan", () => {
  it("deletes pending rows older than a day, with no tombstone, and keeps the rest", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const old = value(await start(actor, new FakeSlack()));
    const fresh = value(await start(actor, new FakeSlack()));
    await db()
      .update(schema.integrationConnections)
      .set({ createdAt: NOW - SLACK_LIMITS.pendingMs - 1 })
      .where(eq(schema.integrationConnections.id, old.id));
    const { connection } = await connected();
    await db()
      .update(schema.integrationConnections)
      .set({ createdAt: NOW - 10 * DAY })
      .where(eq(schema.integrationConnections.id, connection.id));
    expect(await prunePendingConnections(db(), NOW)).toBeGreaterThanOrEqual(1);
    expect(await row(old.id)).toBeUndefined();
    expect(await row(fresh.id)).toBeDefined();
    expect(await row(connection.id)).toBeDefined();
    const tombstones = await db()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, old.id));
    expect(tombstones).toEqual([]);
  });
});

describe("an inbound request", () => {
  const body = new TextEncoder().encode('{"type":"url_verification","challenge":"c"}');
  const stamp = String(Math.floor(NOW / 1000));

  async function signed(secret: string, bytes = body) {
    const header = await FakeSlack.signature(secret, stamp, new TextDecoder().decode(bytes));
    const hex = header.slice(3);
    const signature = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) signature[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return signature;
  }

  async function verify(connectionId: string, signature: Uint8Array<ArrayBuffer>, key = KEY_TEXT) {
    return verifySlackRequest(db(), {
      connectionId,
      timestamp: stamp,
      signature,
      body,
      keys: await integrationKeys({ current: key }),
      now: NOW,
    });
  }

  it("verifies only with the connection's own signing secret", async () => {
    const { connection, signingSecret } = await connected();
    expect(await verify(connection.id, await signed(signingSecret))).toMatchObject({
      id: connection.id,
      externalId: "T0ACME01",
    });
    expect(await verify(connection.id, await signed(FakeSlack.signingSecret()))).toBeNull();
    // The signature covers the body: another body with the same signature fails.
    expect(
      await verifySlackRequest(db(), {
        connectionId: connection.id,
        timestamp: stamp,
        signature: await signed(signingSecret),
        body: new TextEncoder().encode('{"type":"url_verification","challenge":"d"}'),
        keys: await integrationKeys({ current: KEY_TEXT }),
        now: NOW,
      }),
    ).toBeNull();
    // And the timestamp.
    expect(
      await verifySlackRequest(db(), {
        connectionId: connection.id,
        timestamp: String(Number(stamp) + 1),
        signature: await signed(signingSecret),
        body,
        keys: await integrationKeys({ current: KEY_TEXT }),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("refuses a missing, a pending and another service's connection the same way", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const pending = value(await start(personalActor(owner.id), new FakeSlack()));
    const secret = FakeSlack.signingSecret();
    expect(await verify(`ic_${"9".repeat(32)}`, await signed(secret))).toBeNull();
    expect(await verify(pending.id, await signed(secret))).toBeNull();
    expect((await row(pending.id))?.attention).toBe("pending");
  });

  it("marks a connection whose key the Worker lost, once, and refuses", async () => {
    const { owner, connection, signingSecret } = await connected();
    const before = (await auditOf(owner.id)).length;
    expect(await verify(connection.id, await signed(signingSecret), OTHER_KEY)).toBeNull();
    expect(await verify(connection.id, await signed(signingSecret), OTHER_KEY)).toBeNull();
    expect((await row(connection.id))?.attention).toBe("key_unavailable");
    const events = (await auditOf(owner.id)).slice(before);
    expect(events.map((e) => [e.kind, e.actorType, e.detail])).toEqual([
      ["integration.failing", "system", { service: "slack", reason: "key_unavailable" }],
    ]);
  });
});

describe("a verified event", () => {
  it("marks the connection app_uninstalled once for its own Slack workspace, and ignores the rest", async () => {
    const { owner, connection } = await connected();
    const read = async () => {
      const found = await row(connection.id);
      if (!found) throw new Error("gone");
      return found;
    };
    const apply = async (eventType: string | null, teamMatches = true) =>
      applySlackEvent(db(), { connection: await read(), teamMatches, eventType, now: NOW });
    expect(await apply("app_uninstalled", false)).toBe("team_mismatch");
    expect(await apply("link_shared")).toBe("ignored");
    expect(await apply(null)).toBe("ignored");
    expect((await read()).attention).toBeNull();
    expect(await apply("tokens_revoked")).toBe("uninstalled");
    expect(await apply("app_uninstalled")).toBe("ignored");
    expect((await read()).attention).toBe("app_uninstalled");
    const failing = (await auditOf(owner.id)).filter((e) => e.kind === "integration.failing");
    expect(failing.map((e) => e.detail)).toEqual([{ service: "slack", reason: "app_uninstalled" }]);
  });

  it("writes nothing when the row read is stale (a new credential was pasted meanwhile)", async () => {
    const { actor, connection } = await connected();
    const [stale] = await db()
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connection.id));
    if (!stale) throw new Error("gone");
    const next = FakeSlack.botToken();
    value(
      await complete(actor, connection.id, new FakeSlack().bot(next, "Acme", "T0ACME01"), {
        botToken: next,
        signingSecret: FakeSlack.signingSecret(),
      }),
    );
    await applySlackEvent(db(), {
      connection: stale,
      teamMatches: true,
      eventType: "app_uninstalled",
      now: NOW,
    });
    expect((await row(connection.id))?.attention).toBeNull();
  });
});

describe("removing a pending Slack connection", () => {
  it("records nothing about removing a pending row that never held anything", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const pending = value(await start(actor, new FakeSlack()));
    value(await removeIntegrationConnection(db(), { actor, connectionId: pending.id, now: NOW }));
    expect((await auditOf(owner.id)).map((e) => [e.kind, e.detail])).toEqual([]);
    expect(await row(pending.id)).toBeUndefined();
    const tombstones = await db()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, pending.id));
    expect(tombstones).toEqual([]);
  });

  it("removes a connection completed meanwhile as a real one: event, tombstone and revoke", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const botToken = FakeSlack.botToken();
    const fake = new FakeSlack().bot(botToken, "Acme", "T0ACME01");
    const pending = value(await start(actor, fake));
    // The admin's other tab completes the connection between this removal's read and its delete.
    const raced = racing(async () => {
      value(
        await complete(actor, pending.id, fake, {
          botToken,
          signingSecret: FakeSlack.signingSecret(),
        }),
      );
    });
    const deferred: Promise<unknown>[] = [];
    value(
      await removeIntegrationConnection(raced, {
        actor,
        connectionId: pending.id,
        now: NOW,
        slack: {
          enabled: true,
          keys: await integrationKeys({ current: KEY_TEXT }),
          fetch: fake.fetch,
          defer: (task) => deferred.push(task),
        },
      }),
    );
    await Promise.all(deferred);
    expect(await row(pending.id)).toBeUndefined();
    expect((await auditOf(owner.id)).map((e) => e.kind)).toEqual([
      "integration.connected",
      "integration.removed",
    ]);
    const [tombstone] = await db()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, pending.id));
    expect(tombstone?.kind).toBe("integration_connection");
    expect(fake.revoked.has(botToken)).toBe(true);
  });

  it("never deletes a credential pasted meanwhile as the one it read", async () => {
    const { owner, actor, connection } = await connected();
    const next = FakeSlack.botToken();
    const fake = new FakeSlack().bot(next, "Acme", "T0ACME01");
    const raced = racing(async () => {
      value(
        await complete(actor, connection.id, fake, {
          botToken: next,
          signingSecret: FakeSlack.signingSecret(),
        }),
      );
    });
    const deferred: Promise<unknown>[] = [];
    value(
      await removeIntegrationConnection(raced, {
        actor,
        connectionId: connection.id,
        now: NOW,
        slack: {
          enabled: true,
          keys: await integrationKeys({ current: KEY_TEXT }),
          fetch: fake.fetch,
          defer: (task) => deferred.push(task),
        },
      }),
    );
    await Promise.all(deferred);
    // The retry removed the connection as it was then, and revoked the token it held then.
    expect(await row(connection.id)).toBeUndefined();
    expect(fake.revoked.has(next)).toBe(true);
    expect((await auditOf(owner.id)).filter((e) => e.kind === "integration.removed")).toHaveLength(
      1,
    );
  });
});

describe("the guarded writes of completing a Slack connection", () => {
  it("answers a conflict when the connection changed between auth.test and the write", async () => {
    const owner = await person();
    await grantPlan(owner.id, "team");
    const actor = personalActor(owner.id);
    const botToken = FakeSlack.botToken();
    const fake = new FakeSlack().bot(botToken, "Acme", "T0ACME01");
    const pending = value(await start(actor, fake));
    const raced = racing(() =>
      db()
        .update(schema.integrationConnections)
        .set({ label: "Renamed elsewhere", revision: sql`revision + 1` })
        .where(eq(schema.integrationConnections.id, pending.id)),
    );
    expect(
      await updateIntegrationConnection(raced, {
        actor,
        connectionId: pending.id,
        update: { botToken, signingSecret: FakeSlack.signingSecret() },
        deps: await deps(fake),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "version_conflict" });
    expect(await row(pending.id)).toMatchObject({
      attention: "pending",
      keyId: "",
      label: "Renamed elsewhere",
    });
    expect(await auditOf(owner.id)).toEqual([]);
  });

  it("stores nothing for an admin demoted while Slack was asked, with a separate regional database", async () => {
    const admin = await person();
    const other = await person();
    const created = await createWorkspace(regionsFromEnv(env).global, {
      slug: `slack-${crypto.randomUUID().slice(0, 8)}`,
      name: "EU",
      adminUserId: admin.id,
      now: NOW,
      region: "eu",
    });
    if (!created.ok) throw new Error(created.message);
    const ws = created.value.id;
    await regionsFromEnv(env)
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws, userId: other.id, role: "admin", updatedAt: NOW });
    await grantPlan(ws, "team");
    const euDb = regionsFromEnv(env).get("eu").db;
    const actor = await actorIn(admin.id, ws);
    const botToken = FakeSlack.botToken();
    const fake = new FakeSlack().bot(botToken, "Acme", "T0ACME01");
    const pending = value(
      await createIntegrationConnection(euDb, {
        actor,
        connection: { service: "slack", label: "Acme" },
        deps: await deps(fake),
        now: NOW,
      }),
    );
    // Demoted while auth.test runs: no write condition reaches the global table from the EU
    // database, so only the re-check after the call stops the write.
    fake.next({
      before: () =>
        regionsFromEnv(env)
          .global.update(schema.workspaceMembers)
          .set({ role: "editor" })
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, ws),
              eq(schema.workspaceMembers.userId, admin.id),
            ),
          ),
    });
    expect(
      await updateIntegrationConnection(euDb, {
        actor,
        connectionId: pending.id,
        update: { botToken, signingSecret: FakeSlack.signingSecret() },
        deps: await deps(fake),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const [stored] = await euDb
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, pending.id));
    expect(stored).toMatchObject({ attention: "pending", keyId: "", credentialBox: "" });
  });

  it("fails Test without marking when the token now answers for another Slack workspace", async () => {
    const { actor, botToken, connection } = await connected();
    const moved = new FakeSlack().bot(botToken, "Elsewhere", "T0OTHER01");
    const tested = value(
      await testIntegrationConnection(db(), {
        actor,
        connectionId: connection.id,
        deps: await deps(moved),
        now: NOW,
      }),
    );
    expect(tested).toMatchObject({ ok: false, problem: "credential_rejected" });
    expect(tested.message).toMatch(/another Slack workspace/);
    expect(await row(connection.id)).toMatchObject({ attention: null, identity: "Acme" });
  });
});

describe("a Slack connection in the issue job", () => {
  it("fails a request whose connection turns out to be a Slack connection, sending nothing", async () => {
    const { owner, connection } = await connected();
    const trackers = new FakeIssueTrackers().github(GITHUB_TOKEN, "octo-bot", ["acme/site"]);
    const issueConnection = value(
      await createIntegrationConnection(db(), {
        actor: personalActor(owner.id),
        connection: {
          service: "github",
          label: "Repo",
          credential: GITHUB_TOKEN,
          targets: ["acme/site"],
        },
        deps: {
          keys: await integrationKeys({ current: KEY_TEXT }),
          service: ON,
          fetch: trackers.fetch,
        },
        now: NOW,
      }),
    );
    const { artifactId, threadId } = await artifactWithThread(owner.id);
    const issue = value(
      await requestThreadIssue(db(), {
        userId: owner.id,
        artifactId,
        threadId,
        request: {
          connectionId: issueConnection.id,
          target: "acme/site",
          title: "Fix it",
          include: { link: true, artifactName: true, quote: false, message: false },
        },
        idempotencyKey: crypto.randomUUID(),
        service: ON,
        now: NOW,
      }),
    );
    // The request names the Slack connection, as a forged or corrupted row would.
    await db()
      .update(schema.threadIssues)
      .set({ connectionId: connection.id })
      .where(eq(schema.threadIssues.id, issue.id));
    const before = trackers.requests.length;
    const [job] = await db()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "thread_issue"), eq(schema.outbox.subject, issue.id)));
    if (!job) throw new Error("no job");
    const message: JobMessage = { id: job.id, topic: "thread_issue" };
    await runJob(db(), env.ARTIFACTS, message, NOW, {
      issues: {
        keys: await integrationKeys({ current: KEY_TEXT }),
        fetch: trackers.fetch,
        appOrigin: "https://app.portifact.test",
        enabled: true,
      },
    });
    const [after] = await db()
      .select()
      .from(schema.threadIssues)
      .where(eq(schema.threadIssues.id, issue.id));
    expect(after).toMatchObject({ state: "failed", failure: "connection_removed" });
    expect(trackers.requests.length).toBe(before);
  });
});

const GITHUB_TOKEN = `github_pat_slack_suite_${"0123456789".repeat(2)}`;

async function artifactWithThread(ownerId: string) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const artifactId = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (b) => alphabet[b % 32],
  ).join("");
  const version = `${artifactId}_v1`;
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
      expiresAt: NOW + 30 * DAY,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.versions).values({
    id: version,
    artifactId,
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
    .where(eq(schema.artifacts.id, artifactId));
  const thread = value(
    await createAnnotationThread(db(), {
      humanCheck: { token: "solved", verify: async () => "passed" },
      userId: ownerId,
      artifactId,
      versionId: version,
      target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
      body: "A thread",
      now: NOW,
    }),
  );
  return { artifactId, threadId: thread.id };
}
