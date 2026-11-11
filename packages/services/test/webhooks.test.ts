// Webhooks (decision 0009): management with roles and the plan gate, the events writes record in
// their own batch, the delivery job (signing, retries, timeouts, redirects, caps, protection,
// disabling) and erasure, against the real D1 schema in workerd. The network is a fake: nothing
// here sends a request anywhere.
import { env } from "cloudflare:test";
import {
  type AnnotationTarget,
  type JobMessage,
  planRequiredMessage,
  WEBHOOK_LIMITS,
  type WebhookDeliveryBody,
  type WebhookEventType,
} from "@portifact/contracts";
import { globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { type Actor, personalActor, utcDayStart } from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { exportAccount, requestAccountDeletion } from "../src/account-data.ts";
import { actorOn } from "../src/actors.ts";
import {
  createAnnotationThread,
  type HumanCheck,
  replyToAnnotationThread,
  setAnnotationThreadState,
} from "../src/annotations.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import { scheduleExpiryNotices } from "../src/expiry-notices.ts";
import { runMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { open, seal, webhookKeys } from "../src/webhook-keys.ts";
import {
  createWebhook,
  listWebhookDeliveries,
  listWebhooks,
  maintainWebhooks,
  removeWebhook,
  rewrapWebhookKeys,
  sendTestEvent,
  stopWebhooksWhileOff,
  updateWebhook,
  type WebhookDeps,
} from "../src/webhooks.ts";
import { advanceWorkspaceDeletion, deleteWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, MINUTE, NOW, publishSite, session, value } from "./fixtures.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const SECRET_WORDS = "Secret words that never leave";
const KEY_TEXT = "test-only webhook sealing key, long enough to use";
const OTHER_KEY_TEXT = "another test-only webhook sealing key for rotation";
const ALL: WebhookEventType[] = [
  "comment.created",
  "thread.resolved",
  "artifact.published",
  "artifact.expiring",
  "artifact.access_changed",
];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const AFTER = NOW + WEBHOOK_LIMITS.coalesceMs;

const keys = () => webhookKeys({ current: KEY_TEXT });
/** Deliveries switched on, as the tests of the delivery itself need. */
const ON = { enabled: true };

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function person(name?: string): Promise<{ id: string; email: string; name: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  const display = name ?? `Name ${id.slice(2, 6)}`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: display,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email, name: display };
}

async function proOwner(name?: string) {
  const owner = await person(name);
  await grantPlan(owner.id, "pro");
  return owner;
}

interface Artifact {
  id: string;
  version: string;
}

async function artifact(
  ownerId: string,
  readers: string[] = [],
  options: { expiresAt?: number } = {},
): Promise<Artifact> {
  const id = artifactId();
  const version = `${id}_v1`;
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Q3 plan",
      state: "active",
      annotations: "open",
      commentVisibility: "everyone",
      accessMode: "restricted",
      expiresAt: options.expiresAt ?? NOW + 30 * DAY,
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

async function comment(a: Artifact, userId: string, now = NOW, database = db()) {
  return value(
    await createAnnotationThread(database, {
      humanCheck: HUMAN,
      userId,
      artifactId: a.id,
      versionId: a.version,
      target: DOC,
      body: SECRET_WORDS,
      now,
    }),
  ).id;
}

async function addHook(
  actor: Actor,
  options: {
    events?: WebhookEventType[];
    format?: "generic" | "slack" | "discord";
    url?: string;
  } = {},
) {
  return value(
    await createWebhook(db(), {
      service: ON,
      via: "dashboard",
      actor,
      webhook: {
        url: options.url ?? "https://hooks.example.com/in?token=abc",
        format: options.format ?? "generic",
        events: options.events ?? ALL,
      },
      keys: await keys(),
      now: NOW,
    }),
  );
}

interface Sent {
  url: string;
  init: RequestInit;
  body: string;
  headers: Record<string, string>;
}

type Reply = Response | (() => Promise<Response>) | "network";

/** A fake network: records each request and answers the next scripted reply (200 otherwise). */
function network(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      init,
      body: String(init.body),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const reply = replies.shift() ?? new Response("ok");
    if (reply === "network") throw new TypeError("connection refused");
    return typeof reply === "function" ? reply() : reply;
  };
  return { sent, fetch };
}

async function deps(fetch: WebhookDeps["fetch"], extra: Partial<WebhookDeps> = {}) {
  return {
    keys: await keys(),
    fetch,
    appOrigin: "https://app.portifact.test",
    contentDomain: "portifact.test",
    enabled: true,
    ...extra,
  } satisfies WebhookDeps;
}

async function jobsOf(webhookId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "webhook_delivery"), eq(schema.outbox.subject, webhookId)))
    .orderBy(schema.outbox.id);
}

/** Runs every delivery job of the webhook that is due at `now`, once each. */
async function runDue(webhookId: string, now: number, webhookDeps: WebhookDeps) {
  const outcomes: string[] = [];
  for (const job of await jobsOf(webhookId)) {
    if (job.availableAt > now) continue;
    const message: JobMessage = { id: job.id, topic: "webhook_delivery" };
    outcomes.push(await runJob(db(), env.ARTIFACTS, message, now, { webhooks: webhookDeps }));
  }
  return outcomes;
}

async function pending(webhookId: string) {
  return db()
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.webhookId, webhookId));
}

async function log(webhookId: string) {
  return db()
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.webhookId, webhookId))
    .orderBy(schema.webhookDeliveries.id);
}

/** Sets a `rate_limits` counter as if `count` actions were already counted in the window. */
async function seedCounter(key: string, count: number, windowStart: number) {
  await db().run(
    sql`insert into rate_limits (key, window_start, count) values (${key}, ${windowStart}, ${count}) on conflict (key) do update set count = ${count}, window_start = ${windowStart}`,
  );
}

async function hookRow(webhookId: string) {
  const [row] = await db().select().from(schema.webhooks).where(eq(schema.webhooks.id, webhookId));
  return row;
}

async function workspace(members: [string, "admin" | "editor" | "member"][]) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: members[0]?.[0] ?? "x",
      updatedAt: NOW,
    });
  for (const [userId, role] of members) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId, role, updatedAt: NOW });
  }
  return id;
}

async function actorIn(userId: string, ownerId: string): Promise<Actor> {
  const actor = await actorOn(db().global, userId, ownerId);
  if (!actor) throw new Error("no role");
  return actor;
}

const generic = (url = "https://hooks.example.com/in") => ({
  url,
  format: "generic" as const,
  events: ALL,
});

describe("managing webhooks", () => {
  it("is refused on free with plan_required and allowed on pro", async () => {
    const owner = await person();
    const refused = await createWebhook(db(), {
      service: ON,
      via: "dashboard",
      actor: personalActor(owner.id),
      webhook: generic(),
      keys: await keys(),
      now: NOW,
    });
    expect(refused).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("webhooks"),
    });
    await grantPlan(owner.id, "pro");
    const created = await addHook(personalActor(owner.id));
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(created.webhook).toEqual({
      id: expect.stringMatching(/^wh_[0-9a-f]{32}$/),
      host: "hooks.example.com",
      format: "generic",
      events: ALL,
      state: "active",
      disabledReason: null,
      disabledAt: null,
      failures: 0,
      createdAt: NOW,
      createdVia: "dashboard",
      createdBy: owner.name,
      probation: false,
      lastAttempt: null,
    });
  });

  it("stores the URL and the secret sealed, bound to their webhook and column", async () => {
    const owner = await proOwner();
    const { webhook, secret } = await addHook(personalActor(owner.id));
    const row = await hookRow(webhook.id);
    if (!row || !secret) throw new Error("setup");
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("token=abc");
    expect(stored).not.toContain("/in");
    expect(stored).not.toContain(secret.slice(6, 30));
    expect(row.host).toBe("hooks.example.com");
    const all = await keys();
    expect(await open(all, row.keyId, webhook.id, "url", row.urlBox)).toBe(
      "https://hooks.example.com/in?token=abc",
    );
    expect(await open(all, row.keyId, webhook.id, "secret", row.secretBox ?? "")).toBe(secret);
    await expect(open(all, row.keyId, `wh_${"0".repeat(32)}`, "url", row.urlBox)).rejects.toThrow();
    await expect(open(all, row.keyId, webhook.id, "secret", row.urlBox)).rejects.toThrow();
    const other = await webhookKeys({ current: OTHER_KEY_TEXT });
    await expect(open(other, row.keyId, webhook.id, "url", row.urlBox)).rejects.toThrow(
      "No webhook key",
    );
  });

  it("gives Slack and Discord webhooks no secret", async () => {
    const owner = await proOwner();
    const slack = await addHook(personalActor(owner.id), {
      format: "slack",
      url: "https://hooks.slack.com/services/T0/B0/x",
    });
    expect(slack.secret).toBeNull();
    expect((await hookRow(slack.webhook.id))?.secretBox).toBeNull();
  });

  it("refuses an invalid URL and keeps nothing", async () => {
    const owner = await proOwner();
    const result = await createWebhook(db(), {
      service: ON,
      via: "dashboard",
      actor: personalActor(owner.id),
      webhook: generic("https://169.254.169.254/latest"),
      keys: await keys(),
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    const list = value(
      await listWebhooks(db(), {
        service: ON,
        actor: personalActor(owner.id),
        now: NOW,
      }),
    );
    expect(list.webhooks).toEqual([]);
  });

  it("answers capacity_unavailable without a usable sealing key", async () => {
    const owner = await proOwner();
    const result = await createWebhook(db(), {
      service: ON,
      via: "dashboard",
      actor: personalActor(owner.id),
      webhook: generic(),
      keys: await webhookKeys({ current: "too short" }),
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "Webhooks are not available yet.",
    });
    expect(await webhookKeys({ current: undefined, previous: KEY_TEXT })).toEqual([]);
    expect(await webhookKeys({ current: KEY_TEXT, previous: "short" })).toHaveLength(1);
  });

  it("allows at most 10 per owner", async () => {
    const owner = await proOwner();
    for (let i = 0; i < WEBHOOK_LIMITS.perOwner; i += 1) await addHook(personalActor(owner.id));
    const result = await createWebhook(db(), {
      service: ON,
      via: "dashboard",
      actor: personalActor(owner.id),
      webhook: generic(),
      keys: await keys(),
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });
    const list = value(
      await listWebhooks(db(), {
        service: ON,
        actor: personalActor(owner.id),
        now: NOW,
      }),
    );
    expect(list.webhooks).toHaveLength(10);
    expect(list.limit).toBe(10);
    expect(list.available).toBe(true);
  });

  it("lets only a workspace's admins manage its webhooks", async () => {
    const admin = await person();
    const editor = await person();
    const member = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [editor.id, "editor"],
      [member.id, "member"],
    ]);
    await grantPlan(ws, "team");
    const { webhook } = await addHook(await actorIn(admin.id, ws));
    const forbidden = {
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    };
    for (const userId of [editor.id, member.id]) {
      const actor = await actorIn(userId, ws);
      const webhookId = webhook.id;
      expect(
        await listWebhooks(db(), {
          service: ON,
          actor,
          now: NOW,
        }),
      ).toEqual(forbidden);
      expect(
        await createWebhook(db(), {
          service: ON,
          via: "dashboard",
          actor,
          webhook: generic(),
          keys: await keys(),
          now: NOW,
        }),
      ).toEqual(forbidden);
      expect(await removeWebhook(db(), { actor, webhookId, now: NOW })).toEqual(forbidden);
      expect(
        await sendTestEvent(db(), {
          service: ON,
          actor,
          webhookId,
          now: NOW,
        }),
      ).toEqual(forbidden);
      expect(await listWebhookDeliveries(db(), { actor, webhookId, now: NOW })).toEqual(forbidden);
      expect(
        await updateWebhook(db(), {
          service: ON,
          actor,
          webhookId,
          update: { enabled: false },
          now: NOW,
        }),
      ).toEqual(forbidden);
    }
    expect(await hookRow(webhook.id)).toMatchObject({ disabledAt: null });
  });

  it("counts a workspace's limits under the workspace, not its admins' personal spaces", async () => {
    const admin = await person();
    const other = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [other.id, "admin"],
    ]);
    await grantPlan(ws, "team");
    await grantPlan(admin.id, "pro");
    await seedCounter(`webhook:create:${ws}`, WEBHOOK_LIMITS.createsPerOwnerPerDay, NOW);
    const create = async (actor: Actor) =>
      createWebhook(db(), {
        service: ON,
        via: "dashboard",
        actor,
        webhook: generic(),
        keys: await keys(),
        now: NOW,
      });
    // Both admins share the workspace's count: another admin cannot reset it.
    for (const userId of [admin.id, other.id]) {
      expect(await create(await actorIn(userId, ws))).toMatchObject({ code: "rate_limited" });
    }
    // The admin's personal space keeps its own count.
    expect((await create(personalActor(admin.id))).ok).toBe(true);
  });

  it("deletes a workspace's webhooks with the workspace, and keeps a member's own", async () => {
    const admin = await person();
    const ws = await workspace([[admin.id, "admin"]]);
    await grantPlan(ws, "team");
    await grantPlan(admin.id, "pro");
    const { webhook } = await addHook(await actorIn(admin.id, ws));
    const mine = (await addHook(personalActor(admin.id))).webhook;
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: ws, now: NOW }));
    expect(await hookRow(webhook.id)).toBeUndefined();
    expect(await hookRow(mine.id)).toBeDefined();
    // Finishing the deletion leaves the member's personal webhook alone too.
    await advanceWorkspaceDeletion(regionsFromEnv(env), ws, NOW + 1);
    expect(await hookRow(mine.id)).toBeDefined();
  });

  it("answers another owner's webhook exactly like a missing one", async () => {
    const owner = await proOwner();
    const stranger = await proOwner();
    const { webhook } = await addHook(personalActor(owner.id));
    const missing = { ok: false, code: "not_found", message: "Webhook not found." };
    const actor = personalActor(stranger.id);
    for (const webhookId of [webhook.id, `wh_${"0".repeat(32)}`]) {
      expect(await removeWebhook(db(), { actor, webhookId, now: NOW })).toEqual(missing);
      expect(
        await sendTestEvent(db(), {
          service: ON,
          actor,
          webhookId,
          now: NOW,
        }),
      ).toEqual(missing);
      expect(await listWebhookDeliveries(db(), { actor, webhookId, now: NOW })).toEqual(missing);
      expect(
        await updateWebhook(db(), {
          service: ON,
          actor,
          webhookId,
          update: { enabled: false },
          now: NOW,
        }),
      ).toEqual(missing);
    }
    expect(
      value(
        await listWebhooks(db(), {
          service: ON,
          actor,
          now: NOW,
        }),
      ).webhooks,
    ).toEqual([]);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledAt: null });
    expect(await exportTombstones(regionsFromEnv(env))).not.toContainEqual(
      expect.objectContaining({ id: webhook.id }),
    );
  });

  it("disables without the plan, and needs it to enable again", async () => {
    const owner = await proOwner();
    const actor = personalActor(owner.id);
    const { webhook } = await addHook(actor);
    const webhookId = webhook.id;
    await db()
      .update(schema.webhooks)
      .set({ failures: 3 })
      .where(eq(schema.webhooks.id, webhookId));
    await grantPlan(owner.id, "free");
    const listed = value(
      await listWebhooks(db(), {
        service: ON,
        actor,
        now: NOW,
      }),
    );
    expect(listed.available).toBe(false);
    expect(listed.webhooks[0]?.state).toBe("paused");
    const disabled = value(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId,
        update: { enabled: false },
        now: NOW,
      }),
    );
    expect(disabled).toMatchObject({
      state: "disabled",
      disabledReason: "manual",
      disabledAt: NOW,
    });
    // Changing the events of a disabled webhook is not gated either.
    const narrowed = await updateWebhook(db(), {
      service: ON,
      actor,
      webhookId,
      update: { events: ["artifact.published"] },
      now: NOW,
    });
    expect(value(narrowed).events).toEqual(["artifact.published"]);
    expect(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId,
        update: { enabled: true },
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "plan_required", message: planRequiredMessage("webhooks") });
    await grantPlan(owner.id, "pro");
    const enabled = value(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId,
        update: { enabled: true },
        now: NOW,
      }),
    );
    expect(enabled).toMatchObject({
      state: "active",
      disabledReason: null,
      disabledAt: null,
      failures: 0,
    });
    // Nothing to change answers the webhook as it is.
    expect(
      value(
        await updateWebhook(db(), {
          service: ON,
          actor,
          webhookId,
          update: { enabled: true },
          now: NOW,
        }),
      ),
    ).toEqual(enabled);
  });

  it("removes a webhook with its tombstone, its pending events and its jobs", async () => {
    const owner = await proOwner();
    const actor = personalActor(owner.id);
    const { webhook } = await addHook(actor);
    value(
      await sendTestEvent(db(), {
        service: ON,
        actor,
        webhookId: webhook.id,
        now: NOW,
      }),
    );
    expect(await jobsOf(webhook.id)).toHaveLength(1);
    expect(await removeWebhook(db(), { actor, webhookId: webhook.id, now: NOW })).toEqual({
      ok: true,
      value: { webhookId: webhook.id },
    });
    expect(await hookRow(webhook.id)).toBeUndefined();
    expect(await pending(webhook.id)).toEqual([]);
    expect(await jobsOf(webhook.id)).toEqual([]);
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(and(eq(schema.tombstones.kind, "webhook"), eq(schema.tombstones.id, webhook.id)));
    expect(tombstone).toEqual({ kind: "webhook", id: webhook.id, deletedAt: NOW });
  });

  it("queues a test only for an enabled webhook on a plan with the feature", async () => {
    const owner = await proOwner();
    const actor = personalActor(owner.id);
    const { webhook } = await addHook(actor);
    const webhookId = webhook.id;
    value(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId,
        update: { enabled: false },
        now: NOW,
      }),
    );
    expect(
      await sendTestEvent(db(), {
        service: ON,
        actor,
        webhookId,
        now: NOW,
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    await grantPlan(owner.id, "free");
    expect(
      await sendTestEvent(db(), {
        service: ON,
        actor,
        webhookId,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("webhooks"),
    });
    expect(await pending(webhookId)).toEqual([]);
  });
});

/** A database over the D1 binding that counts round trips and the statements of each batch. */
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
      if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
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

describe("recording events", () => {
  it("records nothing for a free owner, even with a webhook left from a lapsed plan", async () => {
    const owner = await proOwner();
    const reader = await person();
    const a = await artifact(owner.id, [reader.email]);
    const { webhook } = await addHook(personalActor(owner.id));
    await grantPlan(owner.id, "free");
    await comment(a, reader.id);
    expect(await pending(webhook.id)).toEqual([]);
    expect(await jobsOf(webhook.id)).toEqual([]);
  });

  it("adds no round trip, and a free write carries no webhook statement", async () => {
    const free = await person();
    const bare = await proOwner();
    const hooked = await proOwner();
    const reader = await person();
    const { webhook } = await addHook(personalActor(hooked.id));
    const freeArtifact = await artifact(free.id, [reader.email]);
    const bareArtifact = await artifact(bare.id, [reader.email]);
    const hookedArtifact = await artifact(hooked.id, [reader.email]);
    const onFree = counting();
    await comment(freeArtifact, reader.id, NOW, onFree.database);
    const onBare = counting();
    await comment(bareArtifact, reader.id, NOW, onBare.database);
    const onHooked = counting();
    await comment(hookedArtifact, reader.id, NOW, onHooked.database);
    expect(onBare.calls.roundTrips).toBe(onFree.calls.roundTrips);
    expect(onHooked.calls.roundTrips).toBe(onFree.calls.roundTrips);
    expect(onHooked.calls.batchSizes).toEqual(onBare.calls.batchSizes);
    // A paid write carries the comment notice mark and the two webhook statements.
    // Then the thread view's one read of its messages and issue links (decision 0018).
    expect(onBare.calls.batchSizes).toEqual([(onFree.calls.batchSizes[0] ?? 0) + 3, 2]);
    expect(await pending(webhook.id)).toHaveLength(1);
  });

  it("coalesces a burst into one job with a count, naming nobody when people differ", async () => {
    const owner = await proOwner("Ada Owner");
    const reader = await person();
    const a = await artifact(owner.id, [reader.email]);
    const { webhook } = await addHook(personalActor(owner.id));
    const first = await comment(a, reader.id);
    for (let i = 1; i <= 3; i += 1) {
      value(
        await replyToAnnotationThread(db(), {
          humanCheck: HUMAN,
          userId: i === 2 ? owner.id : reader.id,
          artifactId: a.id,
          threadId: first,
          body: SECRET_WORDS,
          now: NOW + i * 1000,
        }),
      );
    }
    expect(await pending(webhook.id)).toEqual([
      {
        webhookId: webhook.id,
        artifactId: a.id,
        type: "comment.created",
        count: 4,
        firstAt: NOW,
        lastAt: NOW + 3000,
        actorId: null,
        version: null,
        access: null,
        expiresAt: null,
        review: null,
      },
    ]);
    const jobs = await jobsOf(webhook.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.availableAt).toBe(AFTER);
    expect(jobs[0]?.payload).toEqual({});
  });

  it("names a member of the owner side, and never a reader", async () => {
    const owner = await proOwner("Ada Owner");
    const reader = await person("Reader Rita");
    const a = await artifact(owner.id, [reader.email]);
    const { webhook } = await addHook(personalActor(owner.id));
    await comment(a, owner.id);
    await comment(a, owner.id, NOW + 1);
    const net = network();
    await runDue(webhook.id, AFTER, await deps(net.fetch));
    const body = JSON.parse(net.sent[0]?.body ?? "{}") as WebhookDeliveryBody;
    expect(body.events[0]).toMatchObject({ count: 2, actor: { name: "Ada Owner" } });

    await comment(a, reader.id, AFTER + 1);
    await runDue(webhook.id, AFTER * 2, await deps(net.fetch));
    const second = JSON.parse(net.sent[1]?.body ?? "{}") as WebhookDeliveryBody;
    expect(second.events[0]?.actor).toBeNull();
    expect(net.sent[1]?.body).not.toContain("Rita");
    expect(net.sent[1]?.body).not.toContain(reader.email);
  });

  it("sends exactly the generic shape of each event, without comment text or reader emails", async () => {
    const owner = await person("Ada Owner");
    const reader = await person("Reader Rita");
    const site = await publishSite(owner.id);
    await grantPlan(owner.id, "pro");
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: site.artifactId, email: reader.email });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open", commentVisibility: "everyone", accessMode: "restricted" })
      .where(eq(schema.artifacts.id, site.artifactId));
    const { webhook } = await addHook(personalActor(owner.id));
    const a = { id: site.artifactId, version: site.versionId };
    const threadId = await comment(a, reader.id);
    value(
      await setAnnotationThreadState(db(), {
        userId: owner.id,
        artifactId: a.id,
        threadId,
        state: "resolved",
        now: NOW + 1,
      }),
    );
    await publishSite(owner.id, { "index.html": "<p>two</p>" }, NOW + 2, site);
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: a.id,
        change: { mode: "authenticated", removeReaders: [reader.email] },
        now: NOW + 3,
      }),
    );
    const net = network();
    expect(await runDue(webhook.id, AFTER + 2, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(1);
    const request = net.sent[0];
    const body = JSON.parse(request?.body ?? "{}") as WebhookDeliveryBody;
    const iso = (ms: number) => new Date(ms).toISOString();
    const ref = {
      id: a.id,
      name: "Plan",
      url: `https://${a.id}.portifact.test/`,
      viewUrl: `https://app.portifact.test/view/${a.id}`,
    };
    const ada = { name: "Ada Owner" };
    const at = (ms: number) => ({ firstAt: iso(ms), lastAt: iso(ms) });
    expect(body).toEqual({
      id: expect.stringMatching(/^whd_[0-9a-f]{32}$/),
      webhookId: webhook.id,
      createdAt: iso(AFTER + 2),
      test: false,
      events: [
        { type: "comment.created", artifact: ref, count: 1, ...at(NOW), actor: null },
        { type: "thread.resolved", artifact: ref, count: 1, ...at(NOW + 1), actor: ada },
        {
          type: "artifact.published",
          artifact: ref,
          count: 1,
          ...at(NOW + 2),
          actor: ada,
          version: 2,
        },
        {
          type: "artifact.access_changed",
          artifact: ref,
          count: 1,
          ...at(NOW + 3),
          actor: ada,
          access: "authenticated",
        },
      ],
    });
    for (const leak of [SECRET_WORDS, reader.email, "Rita", threadId]) {
      expect(request?.body).not.toContain(leak);
    }
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toMatch(/^Portifact-Webhooks\/1/);
    expect(request?.init.redirect).toBe("manual");
    expect(request?.init.method).toBe("POST");
    expect(request?.url).toBe("https://hooks.example.com/in?token=abc");
  });

  it("treats a rollback as a new version and the bar as no access change", async () => {
    const owner = await proOwner();
    const site = await publishSite(owner.id);
    const second = await publishSite(owner.id, { "index.html": "<p>b</p>" }, NOW, site);
    const { webhook } = await addHook(personalActor(owner.id));
    value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: site.artifactId,
        versionId: site.versionId,
        baseVersionId: second.versionId,
        now: NOW + 5,
      }),
    );
    value(
      await updateAccess(db(), {
        userId: owner.id,
        artifactId: site.artifactId,
        change: { bar: false },
        now: NOW + 6,
      }),
    );
    const rows = await pending(webhook.id);
    expect(rows.map((row) => [row.type, row.version])).toEqual([["artifact.published", 3]]);
  });

  it("schedules artifact.expiring with the expiry notice, even when its emails are off", async () => {
    const owner = await proOwner();
    const free = await person();
    const soon = NOW + 3 * DAY;
    const a = await artifact(owner.id, [], { expiresAt: soon });
    await artifact(free.id, [], { expiresAt: soon });
    await db()
      .insert(schema.accountSettings)
      .values({ userId: owner.id, expiryNotices: false, updatedAt: NOW });
    const { webhook } = await addHook(personalActor(owner.id), { events: ["artifact.expiring"] });
    await scheduleExpiryNotices(db(), NOW);
    expect(await pending(webhook.id)).toEqual([
      {
        webhookId: webhook.id,
        artifactId: a.id,
        type: "artifact.expiring",
        count: 1,
        firstAt: NOW,
        lastAt: NOW,
        actorId: null,
        version: null,
        access: null,
        expiresAt: soon,
        review: null,
      },
    ]);
    // Once per expiry.
    await scheduleExpiryNotices(db(), NOW + MINUTE);
    expect((await pending(webhook.id))[0]?.count).toBe(1);
    const net = network();
    await runDue(webhook.id, AFTER, await deps(net.fetch));
    const body = JSON.parse(net.sent[0]?.body ?? "{}") as WebhookDeliveryBody;
    expect(body.events[0]?.expiresAt).toBe(new Date(soon).toISOString());
  });

  it("sends only subscribed types, nothing to a disabled webhook, and a workspace's events only to it", async () => {
    const admin = await proOwner();
    const reader = await person();
    const ws = await workspace([[admin.id, "admin"]]);
    await grantPlan(ws, "team");
    const wsActor = await actorIn(admin.id, ws);
    const personal = await artifact(admin.id, [reader.email]);
    const shared = await artifact(ws, [reader.email]);
    const mine = await addHook(personalActor(admin.id), { events: ["artifact.published"] });
    const theirs = await addHook(wsActor);
    const stopped = await addHook(wsActor);
    value(
      await updateWebhook(db(), {
        service: ON,
        actor: wsActor,
        webhookId: stopped.webhook.id,
        update: { enabled: false },
        now: NOW,
      }),
    );
    await comment(personal, reader.id);
    await comment(shared, reader.id);
    expect(await pending(mine.webhook.id)).toEqual([]);
    expect((await pending(theirs.webhook.id)).map((row) => row.artifactId)).toEqual([shared.id]);
    expect(await pending(stopped.webhook.id)).toEqual([]);
    expect(await jobsOf(stopped.webhook.id)).toEqual([]);
  });
});

describe("delivering", () => {
  async function ready() {
    const owner = await proOwner();
    const reader = await person();
    const a = await artifact(owner.id, [reader.email]);
    const created = await addHook(personalActor(owner.id));
    await comment(a, reader.id);
    return { owner, a, webhook: created.webhook, secret: created.secret ?? "" };
  }

  it("signs the Standard Webhooks way, and the documented check fails on any change", async () => {
    const { webhook, secret } = await ready();
    const net = network();
    await runDue(webhook.id, AFTER, await deps(net.fetch));
    const request = net.sent[0];
    if (!request) throw new Error("nothing sent");
    const id = request.headers["webhook-id"] ?? "";
    const timestamp = request.headers["webhook-timestamp"] ?? "";
    expect(id).toBe((JSON.parse(request.body) as WebhookDeliveryBody).id);
    expect(timestamp).toBe(String(Math.floor(AFTER / 1000)));
    // The recipe in the skill: HMAC-SHA-256 of `<id>.<timestamp>.<body>`, keyed with the bytes
    // the base64 after `whsec_` encodes, compared with each `v1,` signature of the header.
    async function verify(body: string, ts: string) {
      const raw = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const content = new TextEncoder().encode(`${id}.${ts}.${body}`);
      const mac = await crypto.subtle.sign("HMAC", key, content);
      const expected = `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
      return (request?.headers["webhook-signature"] ?? "").split(" ").includes(expected);
    }
    expect(await verify(request.body, timestamp)).toBe(true);
    expect(await verify(request.body.replace('"count":1', '"count":2'), timestamp)).toBe(false);
    expect(await verify(request.body, String(Number(timestamp) + 1))).toBe(false);
  });

  it("records a success, closes the job and resets the failures", async () => {
    const { webhook, owner } = await ready();
    await db()
      .update(schema.webhooks)
      .set({ failures: 4 })
      .where(eq(schema.webhooks.id, webhook.id));
    const net = network(new Response(null, { status: 204 }));
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(await jobsOf(webhook.id)).toEqual([]);
    expect(await pending(webhook.id)).toEqual([]);
    expect((await hookRow(webhook.id))?.failures).toBe(0);
    const actor = personalActor(owner.id);
    const entries = value(
      await listWebhookDeliveries(db(), { actor, webhookId: webhook.id, now: AFTER }),
    );
    expect(entries).toEqual([
      {
        deliveryId: expect.stringMatching(/^whd_/),
        attempt: 1,
        at: AFTER,
        outcome: "delivered",
        status: 204,
        error: null,
      },
    ]);
    const list = value(
      await listWebhooks(db(), {
        service: ON,
        actor,
        now: AFTER,
      }),
    );
    expect(list.webhooks[0]?.lastAttempt).toEqual(entries[0]);
    // The log keeps 7 days.
    expect(
      value(
        await listWebhookDeliveries(db(), { actor, webhookId: webhook.id, now: AFTER + 8 * DAY }),
      ),
    ).toEqual([]);
  });

  it("does not retry a 4xx and counts the failure", async () => {
    const { webhook } = await ready();
    const net = network(new Response("no", { status: 400 }));
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(await jobsOf(webhook.id)).toEqual([]);
    expect((await hookRow(webhook.id))?.failures).toBe(1);
    expect((await log(webhook.id)).map((row) => [row.outcome, row.status, row.error])).toEqual([
      ["failed", 400, null],
    ]);
  });

  it("retries a 5xx with backoff and the same delivery ID, then gives up after six attempts", async () => {
    const { webhook } = await ready();
    const net = network(...Array.from({ length: 6 }, () => new Response("down", { status: 503 })));
    let at = AFTER;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(await runDue(webhook.id, at, await deps(net.fetch))).toEqual([
        attempt < 6 ? "kept" : "done",
      ]);
      const jobs = await jobsOf(webhook.id);
      if (attempt === 6) {
        expect(jobs).toEqual([]);
        break;
      }
      const delay = WEBHOOK_LIMITS.retryDelaysMs[attempt - 1] ?? 0;
      expect(jobs[0]).toMatchObject({ availableAt: at + delay, dispatchedAt: null });
      expect(await runDue(webhook.id, at + delay - 1, await deps(net.fetch))).toEqual([]);
      at += delay;
    }
    expect(net.sent).toHaveLength(6);
    expect(new Set(net.sent.map((request) => request.headers["webhook-id"])).size).toBe(1);
    expect((await log(webhook.id)).map((row) => row.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await hookRow(webhook.id))?.failures).toBe(6);
  });

  it("times out a receiver that never answers and retries it", async () => {
    const { webhook } = await ready();
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    expect(await runDue(webhook.id, AFTER, await deps(hang, { timeoutMs: 20 }))).toEqual(["kept"]);
    expect((await log(webhook.id)).map((row) => [row.outcome, row.status, row.error])).toEqual([
      ["failed", null, "timeout"],
    ]);
  });

  it("stops reading a body that never ends once the timeout passes", async () => {
    const { webhook } = await ready();
    const stalled = () =>
      Promise.resolve(new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
    expect(
      await runDue(webhook.id, AFTER, await deps(network(stalled).fetch, { timeoutMs: 20 })),
    ).toEqual(["done"]);
    expect((await log(webhook.id))[0]).toMatchObject({ outcome: "delivered", status: 200 });
  });

  it("retries a network error", async () => {
    const { webhook } = await ready();
    expect(await runDue(webhook.id, AFTER, await deps(network("network").fetch))).toEqual(["kept"]);
    expect((await log(webhook.id))[0]?.error).toBe("network");
  });

  it("does not follow a redirect", async () => {
    const { webhook } = await ready();
    const net = network(
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
    );
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]?.init.redirect).toBe("manual");
    expect((await log(webhook.id)).map((row) => [row.status, row.error])).toEqual([
      [302, "redirect"],
    ]);
  });

  it("reads at most a few KiB of a huge response", async () => {
    const { webhook } = await ready();
    let pulled = 0;
    const huge = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1024;
              controller.enqueue(new Uint8Array(1024));
              if (pulled > 50 * 1024 * 1024) controller.close();
            },
          }),
        ),
      );
    expect(await runDue(webhook.id, AFTER, await deps(network(huge).fetch))).toEqual(["done"]);
    expect(pulled).toBeLessThanOrEqual(WEBHOOK_LIMITS.responseReadBytes + 4 * 1024);
    expect((await log(webhook.id))[0]?.outcome).toBe("delivered");
  });

  it("sends an attempt once when the same job is delivered twice at once", async () => {
    const { webhook } = await ready();
    let release: (response: Response) => void = () => {};
    const net = network(() => new Promise<Response>((resolve) => (release = resolve)));
    const [job] = await jobsOf(webhook.id);
    const message: JobMessage = { id: job?.id ?? 0, topic: "webhook_delivery" };
    const webhooks = await deps(net.fetch);
    const first = runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks });
    while (net.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks })).toBe("kept");
    release(new Response("ok"));
    expect(await first).toBe("done");
    expect(net.sent).toHaveLength(1);
    // Delivered again after it finished: the job is gone, so nothing is sent.
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks })).toBe("done");
    expect(net.sent).toHaveLength(1);
  });

  it("takes over an attempt that started long ago without a result", async () => {
    const { webhook } = await ready();
    const [job] = await jobsOf(webhook.id);
    const message: JobMessage = { id: job?.id ?? 0, topic: "webhook_delivery" };
    // A run that claimed the delivery and died before recording its attempt.
    const dying = network(() => new Promise<Response>(() => {}));
    void runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks: await deps(dying.fetch) });
    while (dying.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const net = network();
    const webhooks = await deps(net.fetch);
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER + MINUTE, { webhooks })).toBe("kept");
    expect(net.sent).toHaveLength(0);
    const later = AFTER + WEBHOOK_LIMITS.attemptStaleMs + 1;
    expect(await runJob(db(), env.ARTIFACTS, message, later, { webhooks })).toBe("done");
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0]?.headers["webhook-id"]).toBe(dying.sent[0]?.headers["webhook-id"]);
  });

  it("disables after repeated failures, keeps the reason, and enabling after the cooldown resets it", async () => {
    const { webhook, owner } = await ready();
    await db()
      .update(schema.webhooks)
      .set({ failures: WEBHOOK_LIMITS.disableAfterFailures - 1 })
      .where(eq(schema.webhooks.id, webhook.id));
    const net = network(new Response("down", { status: 500 }));
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(await hookRow(webhook.id)).toMatchObject({
      disabledReason: "failures",
      disabledAt: AFTER,
      failures: 15,
    });
    // Writes record nothing while it is disabled.
    await comment(await artifact(owner.id), owner.id, AFTER + 1);
    expect(await pending(webhook.id)).toEqual([]);
    const enable = (now: number) =>
      updateWebhook(db(), {
        service: ON,
        actor: personalActor(owner.id),
        webhookId: webhook.id,
        update: { enabled: true },
        now,
      });
    // Not right away: an automatic disable holds for the cooldown.
    expect(await enable(AFTER + 2)).toMatchObject({ ok: false, code: "rate_limited" });
    const enabled = value(await enable(AFTER + WEBHOOK_LIMITS.reenableCooldownMs));
    expect(enabled).toMatchObject({
      state: "active",
      failures: 0,
      disabledReason: null,
      probation: true,
    });
  });

  it("disables a re-enabled webhook again after a few failures, until it has a success", async () => {
    const { webhook, owner, a } = await ready();
    const actor = personalActor(owner.id);
    const update = (enabled: boolean, now: number) =>
      updateWebhook(db(), { service: ON, actor, webhookId: webhook.id, update: { enabled }, now });
    value(await update(false, NOW));
    value(await update(true, NOW + 1));
    let at = AFTER;
    for (let i = 1; i <= WEBHOOK_LIMITS.probationFailures; i += 1) {
      await comment(a, owner.id, at - WEBHOOK_LIMITS.coalesceMs);
      await runDue(webhook.id, at, await deps(network(new Response("no", { status: 400 })).fetch));
      at += DAY;
    }
    expect(await hookRow(webhook.id)).toMatchObject({
      disabledReason: "failures",
      failures: WEBHOOK_LIMITS.probationFailures,
      probation: true,
    });
    // A success ends the probation.
    const day = at + WEBHOOK_LIMITS.reenableCooldownMs;
    value(await update(true, day));
    await comment(a, owner.id, day);
    await runDue(webhook.id, day + WEBHOOK_LIMITS.coalesceMs, await deps(network().fetch));
    expect(await hookRow(webhook.id)).toMatchObject({ probation: false, failures: 0 });
  });

  it("caps re-enables of one webhook a day", async () => {
    const { webhook, owner } = await ready();
    const actor = personalActor(owner.id);
    const update = (enabled: boolean, now: number) =>
      updateWebhook(db(), { service: ON, actor, webhookId: webhook.id, update: { enabled }, now });
    for (let i = 0; i < WEBHOOK_LIMITS.reenablesPerDay; i += 1) {
      value(await update(false, NOW + i * 10));
      value(await update(true, NOW + i * 10 + 1));
    }
    value(await update(false, NOW + 100));
    expect(await update(true, NOW + 101)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await hookRow(webhook.id)).toMatchObject({ disabledReason: "manual" });
    value(await update(true, NOW + DAY));
  });

  it("decides the disable from the count its own update writes, not the one read before", async () => {
    const { webhook } = await ready();
    await db()
      .update(schema.webhooks)
      .set({ failures: WEBHOOK_LIMITS.disableAfterFailures - 2 })
      .where(eq(schema.webhooks.id, webhook.id));
    // While this attempt waits, another failure of the same webhook is recorded.
    const net = network(async () => {
      await db()
        .update(schema.webhooks)
        .set({ failures: WEBHOOK_LIMITS.disableAfterFailures - 1 })
        .where(eq(schema.webhooks.id, webhook.id));
      return new Response("down", { status: 503 });
    });
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(await hookRow(webhook.id)).toMatchObject({
      failures: WEBHOOK_LIMITS.disableAfterFailures,
      disabledReason: "failures",
    });
    expect(await jobsOf(webhook.id)).toEqual([]);
  });

  it("disables at once on 410 Gone", async () => {
    const { webhook } = await ready();
    const net = network(new Response(null, { status: 410 }));
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledReason: "gone", failures: 1 });
  });

  it("validates the URL again before every attempt", async () => {
    const { webhook } = await ready();
    const [key] = await keys();
    if (!key) throw new Error("setup");
    await db()
      .update(schema.webhooks)
      .set({ urlBox: await seal(key, webhook.id, "url", "https://localhost/in") })
      .where(eq(schema.webhooks.id, webhook.id));
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(0);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledReason: "invalid_url" });
    expect((await log(webhook.id)).map((entry) => entry.error)).toEqual(["invalid_url"]);
  });

  it("drops pending events and sends nothing when the plan lapsed, keeping the webhook", async () => {
    const { webhook, owner } = await ready();
    await grantPlan(owner.id, "free");
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["stale"]);
    expect(net.sent).toHaveLength(0);
    expect(await pending(webhook.id)).toEqual([]);
    expect(await jobsOf(webhook.id)).toEqual([]);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledAt: null });
  });

  it("defers while protection blocks uploads or deliveries are paused, never refusing the write", async () => {
    const { webhook, owner, a } = await ready();
    await setBudgetOverride(db().global, {
      level: "protect100",
      steps: 1,
      until: null,
      note: null,
      now: NOW,
    });
    const later = AFTER + WEBHOOK_LIMITS.pausedRetryMs;
    try {
      // The write still succeeds and records its event.
      await comment(a, owner.id, NOW + 1);
      expect((await pending(webhook.id))[0]?.count).toBe(2);
      const blocked = network();
      expect(await runDue(webhook.id, AFTER, await deps(blocked.fetch))).toEqual(["kept"]);
      expect(blocked.sent).toHaveLength(0);
      expect((await jobsOf(webhook.id))[0]?.availableAt).toBe(later);
    } finally {
      await clearBudgetOverride(db().global, NOW);
    }
    // The override ended; the emergency stop still holds them.
    const paused = network();
    expect(await runDue(webhook.id, later, await deps(paused.fetch, { paused: true }))).toEqual([
      "kept",
    ]);
    expect(paused.sent).toHaveLength(0);
    const resumed = network();
    const end = later + WEBHOOK_LIMITS.pausedRetryMs;
    expect(await runDue(webhook.id, end, await deps(resumed.fetch))).toEqual(["done"]);
    expect(resumed.sent).toHaveLength(1);
  });

  it("caps attempts per owner and UTC day, deferring to the next day with one note", async () => {
    const { webhook, owner } = await ready();
    const actor = personalActor(owner.id);
    const day = utcDayStart(AFTER);
    await seedCounter(
      `webhook:attempts:${owner.id}:${day}`,
      WEBHOOK_LIMITS.attemptsPerOwnerPerDay - 1,
      AFTER,
    );
    // The last attempt of the day still goes.
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(1);
    value(await sendTestEvent(db(), { service: ON, actor, webhookId: webhook.id, now: AFTER }));
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["kept"]);
    expect(net.sent).toHaveLength(1);
    const [job] = await jobsOf(webhook.id);
    expect(job).toMatchObject({ availableAt: day + DAY, dispatchedAt: null });
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual([]);
    const notes = (await log(webhook.id)).filter((row) => row.outcome === "skipped");
    expect(notes.map((row) => row.error)).toEqual(["daily_cap"]);
    expect(await runDue(webhook.id, day + DAY, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(2);
    expect(JSON.parse(net.sent[1]?.body ?? "{}")).toMatchObject({ test: true });
  });

  it("keeps counting the day's attempts when a webhook is removed and created again", async () => {
    const { webhook, owner } = await ready();
    const actor = personalActor(owner.id);
    const day = utcDayStart(AFTER);
    await seedCounter(
      `webhook:attempts:${owner.id}:${day}`,
      WEBHOOK_LIMITS.attemptsPerOwnerPerDay,
      AFTER,
    );
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["kept"]);
    value(await removeWebhook(db(), { actor, webhookId: webhook.id, now: AFTER }));
    const fresh = await addHook(actor);
    value(
      await sendTestEvent(db(), { service: ON, actor, webhookId: fresh.webhook.id, now: AFTER }),
    );
    expect(await runDue(fresh.webhook.id, AFTER, await deps(net.fetch))).toEqual(["kept"]);
    expect(net.sent).toHaveLength(0);
  });

  it("limits creates, tests and enables per owner, whatever the webhooks", async () => {
    const owner = await proOwner();
    const actor = personalActor(owner.id);
    const { webhook } = await addHook(actor);
    await seedCounter(`webhook:test:${owner.id}`, WEBHOOK_LIMITS.testsPerOwnerPerHour, NOW);
    expect(
      await sendTestEvent(db(), { service: ON, actor, webhookId: webhook.id, now: NOW }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    await seedCounter(`webhook:create:${owner.id}`, WEBHOOK_LIMITS.createsPerOwnerPerDay, NOW);
    expect(
      await createWebhook(db(), {
        service: ON,
        via: "dashboard",
        actor,
        webhook: generic(),
        keys: await keys(),
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    value(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId: webhook.id,
        update: { enabled: false },
        now: NOW,
      }),
    );
    await seedCounter(`webhook:enable:${owner.id}`, WEBHOOK_LIMITS.enablesPerOwnerPerDay, NOW);
    expect(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId: webhook.id,
        update: { enabled: true },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    // Once the window ends, it counts again from one.
    value(
      await updateWebhook(db(), {
        service: ON,
        actor,
        webhookId: webhook.id,
        update: { enabled: true },
        now: NOW + DAY,
      }),
    );
  });

  it("sends a test event with no artifact, unsigned in a chat format", async () => {
    const owner = await proOwner("Ada Owner");
    const { webhook } = await addHook(personalActor(owner.id), {
      format: "discord",
      url: "https://discord.com/api/webhooks/1/x",
    });
    value(
      await sendTestEvent(db(), {
        service: ON,
        actor: personalActor(owner.id),
        webhookId: webhook.id,
        now: NOW,
      }),
    );
    const net = network();
    expect(await runDue(webhook.id, NOW, await deps(net.fetch))).toEqual(["done"]);
    expect(JSON.parse(net.sent[0]?.body ?? "{}")).toEqual({
      content: "Test event from Portifact: this webhook works.",
      allowed_mentions: { parse: [] },
    });
    expect(net.sent[0]?.headers["webhook-signature"]).toBeUndefined();
  });

  it("leaves out events of artifacts that are gone and still clears them", async () => {
    const { webhook, a } = await ready();
    await db()
      .update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, a.id));
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(0);
    expect(await pending(webhook.id)).toEqual([]);
    expect(await jobsOf(webhook.id)).toEqual([]);
  });

  it("gives activity that arrives after the claim a job of its own", async () => {
    const { webhook, owner, a } = await ready();
    const net = network(async () => {
      await comment(a, owner.id, AFTER);
      return new Response("ok");
    });
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect((await pending(webhook.id)).map((row) => row.count)).toEqual([1]);
    const [job] = await jobsOf(webhook.id);
    expect(job?.payload).toEqual({});
    const next = AFTER + WEBHOOK_LIMITS.coalesceMs;
    expect(await runDue(webhook.id, next, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(2);
  });

  it("throws without keys, so the job waits where they are", async () => {
    const { webhook } = await ready();
    const [job] = await jobsOf(webhook.id);
    const message: JobMessage = { id: job?.id ?? 0, topic: "webhook_delivery" };
    await expect(runJob(db(), env.ARTIFACTS, message, AFTER, {})).rejects.toThrow(
      "webhook_delivery needs the webhook keys",
    );
    expect(await jobsOf(webhook.id)).toHaveLength(1);
  });

  it("ends a job whose webhook is gone", async () => {
    const { webhook } = await ready();
    const [job] = await jobsOf(webhook.id);
    await db().delete(schema.webhooks).where(eq(schema.webhooks.id, webhook.id));
    const message: JobMessage = { id: job?.id ?? 0, topic: "webhook_delivery" };
    const webhooks = await deps(network().fetch);
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks })).toBe("done");
  });
});

describe("maintenance, keys and erasure", () => {
  it("prunes the log after 7 days and requeues pending events whose job was lost", async () => {
    const owner = await proOwner();
    const { webhook } = await addHook(personalActor(owner.id));
    const entry = (deliveryId: string, at: number) => ({
      webhookId: webhook.id,
      ownerId: owner.id,
      deliveryId,
      attempt: 1,
      at,
      outcome: "delivered" as const,
      status: 200,
      error: null,
    });
    await db()
      .insert(schema.webhookDeliveries)
      .values([entry("old", NOW - 8 * DAY), entry("new", NOW - DAY)]);
    value(
      await sendTestEvent(db(), {
        service: ON,
        actor: personalActor(owner.id),
        webhookId: webhook.id,
        now: NOW,
      }),
    );
    await db().delete(schema.outbox).where(eq(schema.outbox.subject, webhook.id));
    const result = await maintainWebhooks(db(), NOW);
    expect(result.prunedDeliveries).toBeGreaterThanOrEqual(1);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect((await log(webhook.id)).map((row) => row.deliveryId)).toEqual(["new"]);
    expect(await jobsOf(webhook.id)).toHaveLength(1);
    await maintainWebhooks(db(), NOW);
    expect(await jobsOf(webhook.id)).toHaveLength(1);
    // Part of the scheduled maintenance run.
    const run = await runMaintenance(db(), env.ARTIFACTS, NOW);
    expect(run.webhooks).toEqual({ prunedDeliveries: 0, requeued: 0 });
  });

  it("re-seals webhooks of the previous key with the current one", async () => {
    const owner = await proOwner();
    const { webhook } = await addHook(personalActor(owner.id));
    const rotated = await webhookKeys({ current: OTHER_KEY_TEXT, previous: KEY_TEXT });
    expect(rotated).toHaveLength(2);
    const result = await rewrapWebhookKeys(db(), rotated, 1_000);
    expect(result.rewrapped).toBeGreaterThanOrEqual(1);
    expect(result.left).toBe(0);
    const row = await hookRow(webhook.id);
    if (!row) throw new Error("setup");
    expect(row.keyId).toBe(rotated[0]?.id);
    const onlyNew = await webhookKeys({ current: OTHER_KEY_TEXT });
    expect(await open(onlyNew, row.keyId, webhook.id, "url", row.urlBox)).toBe(
      "https://hooks.example.com/in?token=abc",
    );
    expect(await open(onlyNew, row.keyId, webhook.id, "secret", row.secretBox ?? "")).toMatch(
      /^whsec_/,
    );
    expect(await rewrapWebhookKeys(db(), [], 10)).toEqual({ rewrapped: 0, left: 0 });
    // Back on the suite's key for the other tests.
    const back = await webhookKeys({ current: KEY_TEXT, previous: OTHER_KEY_TEXT });
    expect((await rewrapWebhookKeys(db(), back, 1_000)).left).toBe(0);
  });

  it("deletes an account's webhooks with the deletion request, and exports them without URL or secret", async () => {
    const owner = await proOwner();
    const { webhook } = await addHook(personalActor(owner.id), { events: ["artifact.published"] });
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    const json = JSON.stringify(exported);
    expect(json).not.toContain("token=abc");
    expect(json).not.toContain("whsec_");
    expect(exported.account.webhooks).toEqual([
      {
        id: webhook.id,
        host: "hooks.example.com",
        format: "generic",
        events: ["artifact.published"],
        disabled: false,
        disabledReason: null,
        createdAt: new Date(NOW).toISOString(),
        createdVia: "dashboard",
      },
    ]);
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    expect(await hookRow(webhook.id)).toBeUndefined();
  });

  it("removes again, after a restore, a webhook that was removed before it", async () => {
    const owner = await proOwner();
    const { webhook } = await addHook(personalActor(owner.id));
    const snapshot = await hookRow(webhook.id);
    if (!snapshot) throw new Error("setup");
    value(
      await removeWebhook(db(), {
        actor: personalActor(owner.id),
        webhookId: webhook.id,
        now: NOW,
      }),
    );
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "webhook", id: webhook.id, deletedAt: NOW });
    // The restore rewinds the webhook and its tombstone.
    await db().delete(schema.tombstones).where(eq(schema.tombstones.id, webhook.id));
    await db().insert(schema.webhooks).values(snapshot);
    const applied = await applyTombstones(db(), markers, NOW + DAY);
    expect(applied.webhooks).toBeGreaterThanOrEqual(1);
    expect(await hookRow(webhook.id)).toBeUndefined();
  });
});

describe("review fixes", () => {
  async function ready() {
    const owner = await proOwner();
    const reader = await person();
    const a = await artifact(owner.id, [reader.email]);
    const created = await addHook(personalActor(owner.id));
    await comment(a, reader.id);
    return { owner, a, webhook: created.webhook };
  }

  it("does not send a retry early when the same message is delivered again", async () => {
    const { webhook } = await ready();
    const net = network(new Response("down", { status: 503 }), new Response("ok"));
    const [job] = await jobsOf(webhook.id);
    const message: JobMessage = { id: job?.id ?? 0, topic: "webhook_delivery" };
    const webhooks = await deps(net.fetch);
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER, { webhooks })).toBe("kept");
    // A duplicate of the message one second later: the retry is not due for a minute.
    expect(await runJob(db(), env.ARTIFACTS, message, AFTER + 1_000, { webhooks })).toBe("kept");
    expect(net.sent).toHaveLength(1);
    const due = AFTER + (WEBHOOK_LIMITS.retryDelaysMs[0] ?? 0);
    expect(await runJob(db(), env.ARTIFACTS, message, due, { webhooks })).toBe("done");
    expect(net.sent).toHaveLength(2);
  });

  it("stops a webhook sealed with a key the Worker no longer holds, instead of failing forever", async () => {
    const { webhook, owner } = await ready();
    await db()
      .update(schema.webhooks)
      .set({ keyId: "f".repeat(16) })
      .where(eq(schema.webhooks.id, webhook.id));
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch))).toEqual(["done"]);
    expect(net.sent).toHaveLength(0);
    expect(await jobsOf(webhook.id)).toEqual([]);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledReason: "key_unavailable" });
    expect((await log(webhook.id)).map((row) => row.error)).toEqual(["key_unavailable"]);
    const list = value(
      await listWebhooks(db(), { service: ON, actor: personalActor(owner.id), now: AFTER }),
    );
    expect(list.webhooks[0]).toMatchObject({
      state: "disabled",
      disabledReason: "key_unavailable",
    });
  });

  it("refuses create, enable and test and sends nothing while deliveries are switched off", async () => {
    const OFF = { enabled: false };
    const owner = await proOwner();
    const actor = personalActor(owner.id);
    const refused = {
      ok: false,
      code: "capacity_unavailable",
      message: "Webhooks are not available yet.",
    };
    expect(
      await createWebhook(db(), {
        service: OFF,
        via: "dashboard",
        actor,
        webhook: generic(),
        keys: await keys(),
        now: NOW,
      }),
    ).toEqual(refused);
    const { webhook } = await addHook(actor);
    expect(
      await sendTestEvent(db(), { service: OFF, actor, webhookId: webhook.id, now: NOW }),
    ).toEqual(refused);
    value(
      await updateWebhook(db(), {
        service: OFF,
        actor,
        webhookId: webhook.id,
        update: { enabled: false },
        now: NOW,
      }),
    );
    expect(
      await updateWebhook(db(), {
        service: OFF,
        actor,
        webhookId: webhook.id,
        update: { enabled: true },
        now: NOW,
      }),
    ).toEqual(refused);
    const listed = value(await listWebhooks(db(), { service: OFF, actor, now: NOW }));
    expect(listed.serviceAvailable).toBe(false);
  });

  it("drops what is pending without sending while switched off, and stops webhooks so writes record nothing", async () => {
    const { webhook, owner, a } = await ready();
    const net = network();
    expect(await runDue(webhook.id, AFTER, await deps(net.fetch, { enabled: false }))).toEqual([
      "stale",
    ]);
    expect(net.sent).toHaveLength(0);
    expect(await pending(webhook.id)).toEqual([]);
    expect(await stopWebhooksWhileOff(db(), AFTER)).toBeGreaterThanOrEqual(1);
    expect(await hookRow(webhook.id)).toMatchObject({ disabledReason: "unavailable" });
    await comment(a, owner.id, AFTER + 1);
    expect(await pending(webhook.id)).toEqual([]);
    expect(await jobsOf(webhook.id)).toEqual([]);
  });

  it("records who created a webhook and clears it with their account", async () => {
    const admin = await proOwner("Ada Admin");
    // A second admin stays: a workspace never loses its last one, so the first can leave.
    const other = await person();
    const ws = await workspace([
      [admin.id, "admin"],
      [other.id, "admin"],
    ]);
    await grantPlan(ws, "team");
    const wsActor = await actorIn(admin.id, ws);
    const created = value(
      await createWebhook(db(), {
        service: ON,
        via: "portifact-cli",
        actor: wsActor,
        webhook: generic(),
        keys: await keys(),
        now: NOW,
      }),
    );
    expect(created.webhook).toMatchObject({ createdVia: "portifact-cli", createdBy: "Ada Admin" });
    expect(await hookRow(created.webhook.id)).toMatchObject({ createdBy: admin.id });
    await db().delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, admin.id));
    const sessionId = await session(admin.id);
    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: admin.id,
        sessionId,
        confirmEmail: admin.email,
        now: NOW,
      }),
    );
    expect(await hookRow(created.webhook.id)).toMatchObject({
      createdBy: null,
      createdVia: "portifact-cli",
    });
  });
});

describe("service tokens in deliveries (decision 0011)", () => {
  it("names a service token of the owner by its label when it acted alone", async () => {
    const admin = await person("Ada Admin");
    const ws = await workspace([[admin.id, "admin"]]);
    await grantPlan(ws, "team", { seats: 3 });
    const a = await artifact(ws);
    const tokenId = `st_${"e".repeat(32)}`;
    await db()
      .insert(schema.serviceTokens)
      .values({
        id: tokenId,
        workspaceId: ws,
        label: "CI previews",
        role: "editor",
        scopes: "artifacts:share",
        tokenHash: "f".repeat(64),
        createdBy: admin.id,
        createdAt: NOW - DAY,
        expiresAt: NOW + DAY,
      });
    const { webhook } = await addHook(await actorIn(admin.id, ws), {
      events: ["artifact.access_changed"],
    });
    value(
      await updateAccess(db(), {
        userId: tokenId,
        artifactId: a.id,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    );
    const net = network();
    await runDue(webhook.id, AFTER, await deps(net.fetch));
    const body = JSON.parse(net.sent[0]?.body ?? "{}") as WebhookDeliveryBody;
    expect(body.events[0]).toMatchObject({
      type: "artifact.access_changed",
      actor: { name: "CI previews (service token)" },
    });
  });
});
