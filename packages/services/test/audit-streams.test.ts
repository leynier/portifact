// Audit streams (decision 0019): management with roles, the plan gates and the switch; the delivery
// job against a fake collector (signing, order, positions in both databases, the settle window,
// at least once, retries, Retry-After, redirects, timeouts, oversized answers, the pause after
// days of failures, retention gaps, the daily cap, tests and a lapsed plan); and what goes with an
// owner (deletion, tombstones, a restore, the export). The network is a fake: nothing here sends a
// request anywhere.
import { env } from "cloudflare:test";
import {
  AUDIT_STREAM,
  type AuditKind,
  type JobMessage,
  planRequiredMessage,
} from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { type Actor, auditJsonLine, personalActor, utcDayStart } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAccount, requestAccountDeletion } from "../src/account-data.ts";
import { presentAuditEvents } from "../src/audit.ts";
import {
  type AuditStreamDeps,
  createAuditStream,
  deliverAuditStream,
  exportAuditStreams,
  listAuditStreamDeliveries,
  listAuditStreams,
  maintainAuditStreams,
  removeAuditStream,
  rewrapAuditStreamKeys,
  sendAuditStreamTest,
  updateAuditStream,
} from "../src/audit-streams.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { clearBudgetOverride, setBudgetOverride } from "../src/budget.ts";
import { runJob } from "../src/outbox.ts";
import { open, seal, webhookKeys } from "../src/webhook-keys.ts";
import {
  advanceWorkspaceDeletion,
  createWorkspace,
  deleteWorkspace,
  resolveOwnerScope,
} from "../src/workspaces.ts";
import { DAY, db, grantPlan, MINUTE, NOW, session, user, value } from "./fixtures.ts";

const KEY_TEXT = "test-only audit stream sealing key, long enough";
const OTHER_KEY_TEXT = "another test-only sealing key for the stream rotation";
const URL_IN = "https://siem.example.com/collect?token=abc";
const HOUR = 60 * MINUTE;
const ON = { enabled: true };
const OFF = { enabled: false };
const keys = () => webhookKeys({ current: KEY_TEXT });
const global = () => regionsFromEnv(env).global;
const SMALL = { events: 3, bytes: 64 * 1024, batchesPerRun: 4 };

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}
type Reply = Response | (() => Promise<Response>) | "network" | "certificate" | "lost";

/** A fake collector: records each request and answers the next scripted reply (200 otherwise). */
function collector(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: String(init.body),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const reply = replies.shift() ?? new Response("ok");
    if (reply === "network") throw new TypeError("connection refused");
    if (reply === "certificate") throw new Error("TLS handshake failed: certificate expired");
    // The collector got the batch, but its answer never came back.
    if (reply === "lost") throw new TypeError("connection reset");
    return typeof reply === "function" ? reply() : reply;
  };
  return { sent, fetch };
}

async function deps(
  fetch: AuditStreamDeps["fetch"],
  extra: Partial<AuditStreamDeps> = {},
): Promise<AuditStreamDeps> {
  return { keys: await keys(), fetch, enabled: true, ...extra };
}

async function enterprise(name = "Ada") {
  const owner = await user(name);
  await grantPlan(owner.id, "enterprise");
  return { ...owner, actor: personalActor(owner.id) };
}

async function addStream(
  actor: Actor,
  options: { start?: "now" | "oldest"; url?: string; now?: number; label?: string } = {},
) {
  return value(
    await createAuditStream(db(), {
      actor,
      stream: {
        label: options.label ?? "SIEM",
        url: options.url ?? URL_IN,
        start: options.start ?? "oldest",
      },
      keys: await keys(),
      service: ON,
      now: options.now ?? NOW,
    }),
  );
}

let sequence = 0;
/** An audit event written directly, in its home database, at `at`. */
async function event(ownerId: string, at: number, kind: AuditKind = "artifact.archived") {
  sequence += 1;
  const id = `ae_${String(sequence).padStart(4, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const isGlobal = kind === "plan.granted";
  await (isGlobal ? global() : db()).insert(schema.auditEvents).values({
    id,
    ownerId,
    at,
    kind,
    actorType: isGlobal ? "operator" : "user",
    actorId: isGlobal ? null : ownerId,
    targetId: isGlobal ? ownerId : null,
    artifactId: null,
    detail: isGlobal ? { plan: "enterprise", seats: 1 } : {},
  });
  return id;
}

async function jobOf(streamId: string) {
  const [row] = await db()
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "audit_stream"), eq(schema.outbox.subject, streamId)));
  return row;
}

async function run(streamId: string, now: number, streamDeps: AuditStreamDeps) {
  const job = await jobOf(streamId);
  if (!job) return "no job";
  const message: JobMessage = { id: job.id, topic: "audit_stream" };
  return runJob(db(), env.ARTIFACTS, message, now, { auditStreams: streamDeps });
}

async function stream(id: string) {
  const [row] = await db().select().from(schema.auditStreams).where(eq(schema.auditStreams.id, id));
  return row;
}

async function kindsOf(ownerId: string) {
  return (
    await db()
      .select({ kind: schema.auditEvents.kind })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, ownerId))
  ).map((row) => row.kind);
}

/** The documented check: Standard Webhooks, any of the space-separated signatures. */
async function verifies(secret: string, request: Sent): Promise<boolean> {
  const bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const content = `${request.headers["webhook-id"]}.${request.headers["webhook-timestamp"]}.${request.body}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  const expected = `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  return (request.headers["webhook-signature"] ?? "").split(" ").includes(expected);
}

const lines = (body: string) =>
  body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function team() {
  const admin = await user("Ada");
  const editor = await user("Ed");
  const member = await user("Mia");
  const outsider = await user("Otto");
  const slug = `s-${crypto.randomUUID().slice(0, 8)}`;
  const ws = value(
    await createWorkspace(global(), { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  await global()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: ws.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(ws.id, "enterprise", { seats: 5 });
  const scope = async (userId: string) => resolveOwnerScope(global(), userId, slug);
  return { ws, slug, admin, editor, member, outsider, scope };
}

describe("managing streams", () => {
  it("lets a workspace's admins create one, refuses editors, members, outsiders and tokens", async () => {
    const t = await team();
    const admin = value(await t.scope(t.admin.id));
    const created = await addStream(admin);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(created.stream).toMatchObject({
      label: "SIEM",
      host: "siem.example.com",
      state: "active",
    });
    expect(JSON.stringify(created.stream)).not.toContain("token=abc");
    // The URL and secret are sealed, bound to the stream.
    const row = await stream(created.stream.id);
    expect(row?.urlBox).not.toContain("siem");
    expect(
      await open(await keys(), row?.keyId ?? "", created.stream.id, "url", row?.urlBox ?? ""),
    ).toBe(URL_IN);
    expect(await jobOf(created.stream.id)).toBeDefined();
    expect(await kindsOf(t.ws.id)).toContain("audit_stream.created");
    const [recorded] = await db()
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.ownerId, t.ws.id),
          eq(schema.auditEvents.kind, "audit_stream.created"),
        ),
      );
    expect(recorded?.detail).toEqual({ host: "siem.example.com", start: "oldest" });

    for (const who of [t.editor.id, t.member.id]) {
      const actor = value(await t.scope(who));
      const refused = await createAuditStream(db(), {
        actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: await keys(),
        service: ON,
        now: NOW,
      });
      expect(refused).toMatchObject({ ok: false, code: "forbidden" });
      expect(await listAuditStreams(db(), { actor, service: ON, now: NOW })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
    expect(await t.scope(t.outsider.id)).toMatchObject({ ok: false, code: "not_found" });
    // A service token never reaches the `audit` action, whatever its role.
    const token: Actor = {
      ...admin,
      userId: `st_${"1".repeat(32)}`,
      role: "admin",
      token: {
        restriction: { kind: "none" },
        scopes: ["artifacts:read"],
        createdAt: NOW,
        label: "CI",
      },
    };
    expect(
      await createAuditStream(db(), {
        actor: token,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    // Another owner's stream answers like a missing one.
    const other = await enterprise("Other");
    expect(
      await removeAuditStream(db(), { actor: other.actor, streamId: created.stream.id, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("gates creating, a new URL, resuming and testing on auditExport then audit; never reading, pausing or removing", async () => {
    const free = await user("Free");
    const freeActor = personalActor(free.id);
    const create = (actor: Actor) =>
      createAuditStream(db(), {
        actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: [] as never,
        service: ON,
        now: NOW,
      });
    expect(await create(freeActor)).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("auditExport"),
    });
    // Team has the log but not its export: the export's feature is named.
    const teamOwner = await user("Team");
    await grantPlan(teamOwner.id, "team");
    expect(await create(personalActor(teamOwner.id))).toMatchObject({
      ok: false,
      message: planRequiredMessage("auditExport"),
    });

    const owner = await enterprise();
    const { stream: s } = await addStream(owner.actor);
    // The plan lapses: the list, a pause and a removal still work; a resume, a URL and a test do not.
    await grantPlan(owner.id, "enterprise", { validUntil: NOW - DAY });
    const listed = value(
      await listAuditStreams(db(), { actor: owner.actor, service: ON, now: NOW }),
    );
    expect(listed).toMatchObject({ available: false, serviceAvailable: true, limit: 2 });
    const paused = value(
      await updateAuditStream(db(), {
        actor: owner.actor,
        streamId: s.id,
        update: { state: "paused", label: "Renamed" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    );
    expect(paused.stream).toMatchObject({
      state: "paused",
      pausedReason: "manual",
      label: "Renamed",
    });
    for (const update of [{ state: "active" as const }, { url: "https://other.example.com/in" }]) {
      expect(
        await updateAuditStream(db(), {
          actor: owner.actor,
          streamId: s.id,
          update,
          keys: await keys(),
          service: ON,
          now: NOW,
        }),
      ).toMatchObject({ ok: false, code: "plan_required" });
    }
    expect(
      await sendAuditStreamTest(db(), {
        actor: owner.actor,
        streamId: s.id,
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    expect(await removeAuditStream(db(), { actor: owner.actor, streamId: s.id, now: NOW })).toEqual(
      {
        ok: true,
        value: { streamId: s.id },
      },
    );
  });

  it("answers capacity_unavailable while switched off, and lists serviceAvailable false", async () => {
    const owner = await enterprise();
    expect(
      await createAuditStream(db(), {
        actor: owner.actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: await keys(),
        service: OFF,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
    expect(
      value(await listAuditStreams(db(), { actor: owner.actor, service: OFF, now: NOW })),
    ).toMatchObject({ serviceAvailable: false, streams: [] });
    // Without a key it is off too.
    expect(
      await createAuditStream(db(), {
        actor: owner.actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: [],
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "capacity_unavailable" });
  });

  it.each([
    ["http://siem.example.com/in"],
    ["https://127.0.0.1/in"],
    ["https://localhost/in"],
    ["https://app.portifact.com/in"],
    ["https://x.workers.dev/in"],
  ])("refuses %s like a webhook URL", async (url) => {
    const owner = await enterprise();
    expect(
      await createAuditStream(db(), {
        actor: owner.actor,
        stream: { label: "x", url, start: "now" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("keeps at most two streams per owner and counts creations per owner", async () => {
    const owner = await enterprise();
    await addStream(owner.actor);
    await addStream(owner.actor);
    expect(
      await createAuditStream(db(), {
        actor: owner.actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
    // Removing and creating again never resets the daily count.
    const listed = value(
      await listAuditStreams(db(), { actor: owner.actor, service: ON, now: NOW }),
    );
    for (let i = 0; i < AUDIT_STREAM.createsPerOwnerPerDay; i += 1) {
      const [first] = (await listAuditStreams(db(), { actor: owner.actor, service: ON, now: NOW }))
        .ok
        ? listed.streams
        : [];
      if (first)
        await removeAuditStream(db(), { actor: owner.actor, streamId: first.id, now: NOW });
      listed.streams.shift();
      const again = await createAuditStream(db(), {
        actor: owner.actor,
        stream: { label: "x", url: URL_IN, start: "now" },
        keys: await keys(),
        service: ON,
        now: NOW,
      });
      if (!again.ok) {
        expect(again.code).toBe("rate_limited");
        return;
      }
      listed.streams.push(again.value.stream);
    }
    throw new Error("the daily create limit never applied");
  });

  it("rotates the secret: shown once, and the old one signs next to it for a day", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const rotated = value(
      await updateAuditStream(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        update: { rotateSecret: true },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    );
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    await event(owner.id, NOW - HOUR);
    const net = collector();
    await run(created.stream.id, NOW, await deps(net.fetch));
    const [request] = net.sent;
    if (!request) throw new Error("nothing sent");
    expect(request.headers["webhook-signature"]?.split(" ")).toHaveLength(2);
    expect(await verifies(rotated.secret as string, request)).toBe(true);
    expect(await verifies(created.secret, request)).toBe(true);
    // A day later only the new one signs.
    await event(owner.id, NOW + DAY - HOUR);
    const later = collector();
    await run(created.stream.id, NOW + DAY + HOUR, await deps(later.fetch));
    const [next] = later.sent;
    if (!next) throw new Error("nothing sent later");
    expect(await verifies(created.secret, next)).toBe(false);
    expect(await verifies(rotated.secret as string, next)).toBe(true);
    expect(await kindsOf(owner.id)).toContain("audit_stream.changed");
  });
});

describe("delivering", () => {
  it("posts regional then global events in order, signed, as the export's JSON Lines, and moves each position", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const regional = [
      await event(owner.id, NOW - 3 * HOUR),
      await event(owner.id, NOW - 2 * HOUR),
      await event(owner.id, NOW - HOUR),
    ];
    const globalIds = [await event(owner.id, NOW - 150 * MINUTE, "plan.granted")];
    const net = collector();
    expect(await run(created.stream.id, NOW, await deps(net.fetch))).toBe("kept");
    expect(net.sent).toHaveLength(2);
    const [first, second] = net.sent as [Sent, Sent];
    expect(first.url).toBe(URL_IN);
    expect(first.headers).toMatchObject({
      "content-type": "application/jsonl; charset=utf-8",
      "portifact-audit-stream": created.stream.id,
      "portifact-audit-source": "regional",
    });
    expect(first.headers["idempotency-key"]).toBe(first.headers["webhook-id"]);
    expect(first.headers["webhook-id"]).toMatch(/^asb_[0-9a-f]{32}$/);
    expect(await verifies(created.secret, first)).toBe(true);
    // Exactly what the export writes for the same rows.
    const rows = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, owner.id))
      .orderBy(schema.auditEvents.at);
    const presented = await presentAuditEvents(
      db(),
      owner.id,
      rows.filter((row) => regional.includes(row.id)),
    );
    expect(first.body).toBe(presented.map(auditJsonLine).join(""));
    expect(lines(first.body).map((line) => line.id)).toEqual(regional);
    expect(second.headers["portifact-audit-source"]).toBe("global");
    expect(lines(second.body).map((line) => line.id)).toEqual(globalIds);
    // Nothing but the presented view: no URL, secret or address.
    expect(first.body).not.toContain("@example.test");
    const row = await stream(created.stream.id);
    expect(row).toMatchObject({ regionalId: "", globalId: "" });
    // Caught up: both positions moved to the settled time, and the job waits `idleMs`.
    expect(row?.regionalAt).toBe(NOW - AUDIT_STREAM.settleMs);
    expect(row?.globalAt).toBe(NOW - AUDIT_STREAM.settleMs);
    expect((await jobOf(created.stream.id))?.availableAt).toBe(NOW + AUDIT_STREAM.idleMs);
    // Delivering recorded no audit event.
    expect((await kindsOf(owner.id)).filter((kind) => kind.startsWith("audit_stream."))).toEqual([
      "audit_stream.created",
    ]);
    // A second run finds nothing to send.
    const again = collector();
    await run(created.stream.id, NOW + AUDIT_STREAM.idleMs, await deps(again.fetch));
    expect(again.sent).toEqual([]);
  });

  it("waits for an event to settle, and starts from now unless asked for the oldest", async () => {
    const owner = await enterprise();
    await event(owner.id, NOW - DAY);
    const created = await addStream(owner.actor, { start: "now" });
    const fresh = await event(owner.id, NOW + MINUTE);
    const net = collector();
    await run(created.stream.id, NOW + 10 * MINUTE, await deps(net.fetch));
    expect(net.sent).toEqual([]);
    await run(created.stream.id, NOW + 30 * MINUTE, await deps(net.fetch));
    const sent = net.sent.flatMap((r) => lines(r.body));
    // The stream's own creation is part of the log; the event from before it is not sent.
    expect(sent.map((line) => line.id)).toContain(fresh);
    expect(sent.map((line) => line.kind)).toEqual(["audit_stream.created", "artifact.archived"]);
  });

  it("sends in batches of at most `events`, oldest first, across runs", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const ids: string[] = [];
    for (let i = 0; i < 14; i += 1) ids.push(await event(owner.id, NOW - 10 * HOUR + i * MINUTE));
    const net = collector();
    const bounded = await deps(net.fetch, { bounds: SMALL });
    expect(await run(created.stream.id, NOW, bounded)).toBe("kept");
    // Four requests a run, then the job comes back at once for the rest.
    expect(net.sent).toHaveLength(4);
    expect((await jobOf(created.stream.id))?.availableAt).toBe(NOW);
    await run(created.stream.id, NOW, bounded);
    const got = net.sent.flatMap((r) => lines(r.body).map((l) => l.id as string));
    expect(got).toEqual(ids);
    expect(net.sent.every((r) => lines(r.body).length <= 3)).toBe(true);
  });

  it("re-sends the same batch with the same key when the answer is lost", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await event(owner.id, NOW - HOUR);
    const net = collector("lost");
    expect(await run(created.stream.id, NOW, await deps(net.fetch))).toBe("kept");
    const row = await stream(created.stream.id);
    expect(row).toMatchObject({ failures: 1, regionalAt: null });
    expect(row?.nextAttemptAt).toBe(NOW + AUDIT_STREAM.retryDelaysMs[0]);
    // Before its time the job does nothing; then the same batch goes again.
    expect(await run(created.stream.id, NOW + 30_000, await deps(net.fetch))).toBe("kept");
    expect(net.sent).toHaveLength(1);
    await run(created.stream.id, NOW + MINUTE, await deps(net.fetch));
    expect(net.sent).toHaveLength(2);
    const [lost, resent] = net.sent as [Sent, Sent];
    expect(resent.headers["webhook-id"]).toBe(lost.headers["webhook-id"]);
    expect(resent.body).toBe(lost.body);
    expect((await stream(created.stream.id))?.failures).toBe(0);
  });

  it.each([
    [new Response("no", { status: 500 }), "5xx", "refused", AUDIT_STREAM.retryDelaysMs[0]],
    [new Response("no", { status: 404 }), "4xx", "refused", AUDIT_STREAM.retryDelaysMs[0]],
    [
      new Response("", { status: 302, headers: { location: "https://elsewhere.example.com/" } }),
      "3xx",
      "redirect",
      AUDIT_STREAM.retryDelaysMs[0],
    ],
    [
      new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
      "4xx",
      "refused",
      120_000,
    ],
    ["network" as const, null, "unreachable", AUDIT_STREAM.retryDelaysMs[0]],
    ["certificate" as const, null, "certificate", AUDIT_STREAM.retryDelaysMs[0]],
  ])(
    "records %s as a failure the admin can read, never its body",
    async (reply, cls, error, delay) => {
      const owner = await enterprise();
      const created = await addStream(owner.actor);
      await event(owner.id, NOW - HOUR);
      const net = collector(reply);
      await run(created.stream.id, NOW, await deps(net.fetch));
      const [attempt] = value(
        await listAuditStreamDeliveries(db(), {
          actor: owner.actor,
          streamId: created.stream.id,
          now: NOW,
        }),
      );
      expect(attempt).toMatchObject({ outcome: "failed", statusClass: cls, error, events: 1 });
      expect(JSON.stringify(attempt)).not.toContain("slow down");
      expect((await stream(created.stream.id))?.nextAttemptAt).toBe(NOW + delay);
      expect((await jobOf(created.stream.id))?.availableAt).toBe(NOW + delay);
      // A redirect is never followed.
      expect(net.sent).toHaveLength(1);
    },
  );

  it("times out a slow endpoint and reads at most a few bytes of a huge answer", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await event(owner.id, NOW - HOUR);
    const slow = collector(
      () => new Promise<Response>(() => {}), // never answers
    );
    await run(created.stream.id, NOW, await deps(slow.fetch, { timeoutMs: 20 }));
    expect((await stream(created.stream.id))?.failures).toBe(1);
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const big = collector(new Response(huge, { status: 200 }));
    await run(created.stream.id, NOW + MINUTE, await deps(big.fetch));
    expect((await stream(created.stream.id))?.failures).toBe(0);
    expect(pulled).toBeLessThan(10);
  });

  it("pauses with attention after failing for three days, with an audit event, and ends its job", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await event(owner.id, NOW - HOUR);
    const failing = async () => new Response("down", { status: 503 });
    let now = NOW;
    for (let i = 0; i < 40; i += 1) {
      const outcome = await run(created.stream.id, now, await deps(collector(failing).fetch));
      if (outcome !== "kept") break;
      now = (await jobOf(created.stream.id))?.availableAt ?? now;
    }
    const row = await stream(created.stream.id);
    expect(row).toMatchObject({ state: "attention", pausedReason: "failures" });
    expect((row?.pausedAt ?? 0) - NOW).toBeGreaterThanOrEqual(AUDIT_STREAM.attentionAfterMs);
    expect(await jobOf(created.stream.id)).toBeUndefined();
    const [paused] = await db()
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.ownerId, owner.id),
          eq(schema.auditEvents.kind, "audit_stream.paused"),
        ),
      );
    expect(paused).toMatchObject({
      actorType: "system",
      detail: { host: "siem.example.com", reason: "failures" },
    });
    // The admin fixes it and resumes: the job comes back and the same event goes.
    value(
      await updateAuditStream(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        update: { state: "active" },
        keys: await keys(),
        service: ON,
        now,
      }),
    );
    const net = collector();
    await run(created.stream.id, now, await deps(net.fetch));
    expect(net.sent).toHaveLength(1);
  });

  it("reports a gap when retention passed the position, and the dashboard shows it", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await db()
      .update(schema.auditStreams)
      .set({ regionalAt: NOW - 200 * DAY })
      .where(eq(schema.auditStreams.id, created.stream.id));
    // Still in the table (the sweep has not run) but past retention: never sent.
    await event(owner.id, NOW - 150 * DAY);
    const kept = await event(owner.id, NOW - DAY);
    const net = collector();
    await run(created.stream.id, NOW, await deps(net.fetch));
    const [regional] = net.sent as [Sent];
    const [gap, ...events] = lines(regional.body);
    expect(gap).toMatchObject({
      record: "gap",
      source: "regional",
      from: new Date(NOW - 200 * DAY).toISOString(),
      reason: "retention",
    });
    expect(Date.parse(gap?.to as string)).toBeLessThanOrEqual(NOW - 90 * DAY);
    expect(events.map((line) => line.id)).toEqual([kept]);
    const listed = value(
      await listAuditStreams(db(), { actor: owner.actor, service: ON, now: NOW }),
    );
    expect(listed.streams[0]?.lastGap).toMatchObject({ source: "regional" });
  });

  it("pauses on a lapsed plan with an event, keeps the position, and resumes from it", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await grantPlan(owner.id, "enterprise", { validUntil: NOW - DAY });
    await event(owner.id, NOW - HOUR);
    const net = collector();
    expect(await run(created.stream.id, NOW, await deps(net.fetch))).toBe("stale");
    expect(net.sent).toEqual([]);
    expect(await stream(created.stream.id)).toMatchObject({
      state: "paused",
      pausedReason: "plan",
    });
    expect(await kindsOf(owner.id)).toContain("audit_stream.paused");
    await grantPlan(owner.id, "enterprise");
    value(
      await updateAuditStream(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        update: { state: "active" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    );
    await run(created.stream.id, NOW, await deps(net.fetch));
    expect(net.sent).toHaveLength(1);
  });

  it("sends nothing while switched off, and waits while deliveries are paused", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await event(owner.id, NOW - HOUR);
    const net = collector();
    await run(created.stream.id, NOW, await deps(net.fetch, { paused: true }));
    expect((await jobOf(created.stream.id))?.availableAt).toBe(NOW + AUDIT_STREAM.pausedRetryMs);
    await setBudgetOverride(global(), {
      level: "protect100",
      steps: 1,
      until: null,
      note: null,
      now: NOW,
    });
    try {
      await run(created.stream.id, NOW + AUDIT_STREAM.pausedRetryMs, await deps(net.fetch));
      expect((await jobOf(created.stream.id))?.availableAt).toBe(
        NOW + 2 * AUDIT_STREAM.pausedRetryMs,
      );
    } finally {
      await clearBudgetOverride(global(), NOW);
    }
    expect(net.sent).toEqual([]);
    expect(await run(created.stream.id, NOW + DAY, await deps(net.fetch, { enabled: false }))).toBe(
      "stale",
    );
    expect(net.sent).toEqual([]);
    expect(await jobOf(created.stream.id)).toBeUndefined();
  });

  it("stops at the owner's daily cap, once a day in the log, and goes on the next day", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await event(owner.id, NOW - HOUR);
    const day = utcDayStart(NOW);
    await global()
      .insert(schema.rateLimits)
      .values({
        key: `audit-stream:attempts:${owner.id}:${day}`,
        windowStart: NOW,
        count: AUDIT_STREAM.attemptsPerOwnerPerDay,
      });
    const net = collector();
    await run(created.stream.id, NOW, await deps(net.fetch));
    expect(net.sent).toEqual([]);
    expect((await jobOf(created.stream.id))?.availableAt).toBe(day + DAY);
    const log = value(
      await listAuditStreamDeliveries(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        now: NOW,
      }),
    );
    expect(log).toMatchObject([{ outcome: "skipped", error: "daily_cap" }]);
    await run(created.stream.id, day + DAY, await deps(net.fetch));
    expect(net.sent).toHaveLength(1);
  });

  it("sends a marked test record without moving a position, even while paused", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    value(
      await updateAuditStream(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        update: { state: "paused" },
        keys: await keys(),
        service: ON,
        now: NOW,
      }),
    );
    value(
      await sendAuditStreamTest(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        service: ON,
        now: NOW,
      }),
    );
    await event(owner.id, NOW - HOUR);
    const net = collector();
    expect(await run(created.stream.id, NOW, await deps(net.fetch))).toBe("stale");
    const [test] = net.sent as [Sent];
    expect(lines(test.body)).toEqual([
      {
        record: "test",
        id: test.headers["webhook-id"],
        at: new Date(NOW).toISOString(),
        stream: created.stream.id,
      },
    ]);
    expect(test.headers["portifact-audit-source"]).toBeUndefined();
    expect(await verifies(created.secret, test)).toBe(true);
    expect(await stream(created.stream.id)).toMatchObject({
      regionalAt: null,
      testRequestedAt: null,
    });
    const [attempt] = value(
      await listAuditStreamDeliveries(db(), {
        actor: owner.actor,
        streamId: created.stream.id,
        now: NOW,
      }),
    );
    expect(attempt).toMatchObject({ outcome: "test", statusClass: "2xx", events: 0 });
  });

  it("stops a stream whose URL no longer passes or whose key is gone", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const [key] = await keys();
    if (!key) throw new Error("no key");
    await db()
      .update(schema.auditStreams)
      .set({ urlBox: await seal(key, created.stream.id, "url", "https://127.0.0.1/in") })
      .where(eq(schema.auditStreams.id, created.stream.id));
    expect(await run(created.stream.id, NOW, await deps(collector().fetch))).toBe("stale");
    expect(await stream(created.stream.id)).toMatchObject({
      state: "attention",
      pausedReason: "invalid_url",
    });
    const second = await addStream(owner.actor);
    const other = await webhookKeys({ current: OTHER_KEY_TEXT });
    expect(
      await deliverAuditStream(
        db(),
        (await jobOf(second.stream.id)) as never,
        NOW,
        await deps(collector().fetch, { keys: other }),
      ),
    ).toBe("stale");
    expect(await stream(second.stream.id)).toMatchObject({ pausedReason: "key_unavailable" });
  });
});

describe("maintenance", () => {
  it("gives an active stream without a job one, prunes the old log and re-seals with a new key", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    await db()
      .delete(schema.outbox)
      .where(
        and(eq(schema.outbox.topic, "audit_stream"), eq(schema.outbox.subject, created.stream.id)),
      );
    await db()
      .insert(schema.auditStreamDeliveries)
      .values({
        streamId: created.stream.id,
        ownerId: owner.id,
        at: NOW - 30 * DAY,
        outcome: "delivered",
        events: 1,
      });
    const done = await maintainAuditStreams(db(), NOW);
    expect(done.armed).toBeGreaterThanOrEqual(1);
    expect(done.prunedDeliveries).toBeGreaterThanOrEqual(1);
    expect(await jobOf(created.stream.id)).toBeDefined();
    // A rotation of WEBHOOK_KEY: the new key re-seals, the old one still opens until then.
    const rotated = await webhookKeys({ current: OTHER_KEY_TEXT, previous: KEY_TEXT });
    const { rewrapped } = await rewrapAuditStreamKeys(db(), rotated);
    expect(rewrapped).toBeGreaterThanOrEqual(1);
    const row = await stream(created.stream.id);
    expect(row?.keyId).toBe(rotated[0]?.id);
    expect(await open(rotated, row?.keyId ?? "", created.stream.id, "url", row?.urlBox ?? "")).toBe(
      URL_IN,
    );
  });
});

describe("what goes with the owner", () => {
  it("lists streams in the account export without URL, secret or position", async () => {
    const owner = await enterprise();
    await addStream(owner.actor);
    const exported = await exportAuditStreams(db(), owner.id);
    expect(exported).toEqual([
      expect.objectContaining({ label: "SIEM", host: "siem.example.com", state: "active" }),
    ]);
    expect(JSON.stringify(exported)).not.toMatch(/token=abc|whsec_|urlBox|regional/);
    const account = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(JSON.stringify(account)).toContain("siem.example.com");
  });

  it("deletes an account's streams and a workspace's streams", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(regionsFromEnv(env), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    expect(await stream(created.stream.id)).toBeUndefined();
    const t = await team();
    const ws = await addStream(value(await t.scope(t.admin.id)));
    value(await deleteWorkspace(regionsFromEnv(env), { workspaceId: t.ws.id, now: NOW }));
    await advanceWorkspaceDeletion(regionsFromEnv(env), t.ws.id, NOW);
    expect(await stream(ws.stream.id)).toBeUndefined();
  });

  it("keeps a removed stream removed through a restore", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const before = await stream(created.stream.id);
    value(
      await removeAuditStream(db(), { actor: owner.actor, streamId: created.stream.id, now: NOW }),
    );
    expect(await kindsOf(owner.id)).toContain("audit_stream.removed");
    expect(await jobOf(created.stream.id)).toBeUndefined();
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "audit_stream", id: created.stream.id, deletedAt: NOW });
    // A Time Travel restore brings the row back; the tombstones take it away again.
    await db()
      .insert(schema.auditStreams)
      .values(before as typeof schema.auditStreams.$inferInsert);
    const applied = await applyTombstones(db(), markers, NOW);
    expect(applied.auditStreams).toBe(1);
    expect(await stream(created.stream.id)).toBeUndefined();
  });

  it("re-sends after a restore rewinds a position, never skips", async () => {
    const owner = await enterprise();
    const created = await addStream(owner.actor);
    const first = await event(owner.id, NOW - 2 * HOUR);
    await run(created.stream.id, NOW, await deps(collector().fetch));
    // A restore to before the delivery: the position is back where it started.
    await db()
      .update(schema.auditStreams)
      .set({ regionalAt: null, regionalId: "" })
      .where(eq(schema.auditStreams.id, created.stream.id));
    const second = await event(owner.id, NOW - HOUR);
    const net = collector();
    await run(created.stream.id, NOW + AUDIT_STREAM.idleMs, await deps(net.fetch));
    expect(lines((net.sent[0] as Sent).body).map((line) => line.id)).toEqual([first, second]);
  });
});
