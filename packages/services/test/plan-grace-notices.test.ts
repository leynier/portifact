// The grace emails (decision 0022, third delivery): the scan schedules one `plan_grace_notice`
// job per owner and moment in the owner's region and marks it on the plan row, at most once under
// concurrent scans; the job claims its row, checks the email is still due, and sends past
// suppressions and the notices' capacity. The EU cases run with a separate regional database
// under the strict region guard.
import { env } from "cloudflare:test";
import {
  GRACE_NOTICE_MARK_WAITS,
  type GraceNoticeMark,
  type GraceNoticeMoment,
  type GraceSlot,
  type JobMessage,
  PLAN_GRACE_MS,
  PLANS,
} from "@portifact/contracts";
import {
  aliasBinding,
  createAccessDb,
  globalDb,
  regionalDb,
  regionsFromEnv,
  schema,
} from "@portifact/db";
import { graceNoticeDue, NOTICE_EMAILS_PER_CYCLE } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { requestAccountDeletion } from "../src/account-data.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "../src/email.ts";
import { runMaintenance, runRegionalMaintenance } from "../src/maintenance.ts";
import { runJob } from "../src/outbox.ts";
import {
  GRACE_NOTICE_CAPACITY_RETRY_MS,
  GRACE_NOTICE_MARK_DELAY_MS,
  GRACE_NOTICE_MARK_WAIT_MS,
  GRACE_NOTICE_OWNERS_PER_RUN,
  type GraceNotifier,
  scheduleGraceNotices,
} from "../src/plan-grace-notices.ts";
import { applyOwnerPlans, exportOwnerPlans, removeOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { DAY, db, MINUTE, NOW, racing, session, user, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const regions = () => regionsFromEnv(env);

/**
 * A D1 binding whose statements matching `pattern` fail (alone or in a batch), the way a Worker
 * dying or a database error stops a write: `times` failures, then it works again.
 */
function failing(binding: D1Database, pattern: RegExp, times = 1): D1Database {
  let left = times;
  const fail = () => {
    if (left <= 0) return false;
    left -= 1;
    return true;
  };
  const bad = new WeakSet<object>();
  const proxy = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!pattern.test(query)) return statement;
          const wrap = (inner: D1PreparedStatement): D1PreparedStatement => {
            const wrapped = new Proxy(inner, {
              get(t, prop) {
                if (prop === "bind") return (...values: unknown[]) => wrap(t.bind(...values));
                if (prop === "run" || prop === "all" || prop === "raw" || prop === "first") {
                  return async (...args: unknown[]) => {
                    if (fail()) throw new Error("worker died");
                    // biome-ignore lint/suspicious/noExplicitAny: forwarding the D1 call as is
                    return (t as any)[prop](...args);
                  };
                }
                const value = Reflect.get(t, prop);
                return typeof value === "function" ? value.bind(t) : value;
              },
            });
            bad.add(wrapped);
            return wrapped;
          };
          return wrap(statement);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => bad.has(statement)) && fail()) {
            throw new Error("worker died");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return aliasBinding(proxy, binding);
}
const eu = () => regions().get("eu");
const access = () => createAccessDb(env.ACCESS_DB);
const euAccess = () => createAccessDb(env.ACCESS_DB_EU);
const HOUR = 3_600_000;

function slot(from: number, until = from + PLAN_GRACE_MS): GraceSlot {
  return {
    plan: "pro",
    reason: "lowered",
    from,
    until,
    limits: {
      archiveMonths: PLANS.pro.limits.archiveMonths,
      retainedPreviousVersions: PLANS.pro.limits.retainedPreviousVersions,
      previousVersionRetentionDays: PLANS.pro.limits.previousVersionRetentionDays,
      accessLogRetentionDays: PLANS.pro.limits.accessLogRetentionDays,
      auditRetentionDays: PLANS.pro.limits.auditRetentionDays,
    },
    features: ["pin"],
  };
}

/** A hold of the Team plan's values, which keep more than Pro's. */
function teamSlot(from: number, until = from + PLAN_GRACE_MS): GraceSlot {
  const { limits } = PLANS.team;
  return {
    ...slot(from, until),
    plan: "team",
    limits: {
      archiveMonths: limits.archiveMonths,
      retainedPreviousVersions: limits.retainedPreviousVersions,
      previousVersionRetentionDays: limits.previousVersionRetentionDays,
      accessLogRetentionDays: limits.accessLogRetentionDays,
      auditRetentionDays: limits.auditRetentionDays,
    },
    features: ["pin", "audit"],
  };
}

/** Writes an owner's plan row directly: free, holding `slots`, with `marks`. */
async function holding(ownerId: string, slots: GraceSlot[] | string, marks: unknown = null) {
  await regions()
    .global.insert(schema.ownerPlans)
    .values({
      ownerId,
      plan: "free",
      seats: 1,
      grantedBy: "test",
      updatedAt: NOW,
      grace: typeof slots === "string" ? slots : JSON.stringify(slots),
      graceNotices: marks === null ? null : JSON.stringify(marks),
    })
    .onConflictDoUpdate({
      target: schema.ownerPlans.ownerId,
      set: {
        grace: typeof slots === "string" ? slots : JSON.stringify(slots),
        graceNotices: marks === null ? null : JSON.stringify(marks),
      },
    });
}

async function planRow(ownerId: string) {
  const [row] = await regions()
    .global.select()
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId));
  return row;
}

async function marksOf(ownerId: string): Promise<GraceNoticeMark[]> {
  const row = await planRow(ownerId);
  return row?.graceNotices ? (JSON.parse(row.graceNotices) as GraceNoticeMark[]) : [];
}

async function jobsFor(ownerId: string, database = db()) {
  return database
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, "plan_grace_notice"), eq(schema.outbox.subject, ownerId)));
}

async function onlyJob(ownerId: string, database = db()) {
  const jobs = await jobsFor(ownerId, database);
  expect(jobs).toHaveLength(1);
  return jobs[0] as (typeof jobs)[number];
}

const message = (row: { id: number }, region?: "eu"): JobMessage => ({
  id: row.id,
  topic: "plan_grace_notice",
  ...(region ? { region } : {}),
});

function fakeNotifier(error?: Error) {
  const sent: Parameters<GraceNotifier["send"]>[0][] = [];
  const graceNotifier: GraceNotifier = {
    async send(notice) {
      if (error) throw error;
      sent.push(notice);
    },
  };
  return { graceNotifier, sent };
}

function run(job: { id: number }, now: number, notifier: GraceNotifier, database = db()) {
  return runJob(database, env.ARTIFACTS, message(job), now, {
    access: access(),
    graceNotifier: notifier,
  });
}

/** A Pro account whose plan the operator removed at NOW: one 60-day hold. */
async function removedPro() {
  const owner = await user("Owner");
  value(
    await setOwnerPlan(db(), {
      ownerId: owner.id,
      plan: "pro",
      seats: 1,
      validUntil: null,
      overrides: null,
      grantedBy: "operator",
      note: null,
      now: NOW - DAY,
    }),
  );
  value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
  return owner;
}

beforeEach(async () => {
  // Every test starts with nothing held by earlier tests, nothing queued and nothing sent.
  await env.DB.exec(
    "UPDATE owner_plans SET grace = NULL, grace_notices = NULL; DELETE FROM outbox; DELETE FROM email_counters; DELETE FROM email_suppressions",
  );
  await env.DB_EU.exec("DELETE FROM outbox");
});

describe("scheduleGraceNotices", () => {
  it("schedules a new hold's start once, in the owner's outbox, and marks it", async () => {
    const owner = await removedPro();
    const [held] = JSON.parse((await planRow(owner.id))?.grace ?? "[]") as GraceSlot[];
    expect(held?.until).toBe(NOW + PLAN_GRACE_MS);

    expect(await scheduleGraceNotices(db(), NOW + MINUTE)).toEqual({ scheduled: 1 });
    const job = await onlyJob(owner.id);
    const claim = (job.payload as { claim: string }).claim;
    expect(job.payload).toEqual({ from: NOW, until: NOW + PLAN_GRACE_MS, moment: "start", claim });
    expect(claim).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.availableAt).toBe(NOW + MINUTE);
    // The mark names the token of the one job that may send.
    expect(await marksOf(owner.id)).toEqual([
      { from: NOW, until: NOW + PLAN_GRACE_MS, moment: "start", claim },
    ]);
    // The mark changes neither the grace nor `updated_at`, which other writers condition on.
    expect((await planRow(owner.id))?.updatedAt).toBe(NOW);

    expect(await scheduleGraceNotices(db(), NOW + 2 * MINUTE)).toEqual({ scheduled: 0 });
    expect(await jobsFor(owner.id)).toHaveLength(1);
  });

  it("schedules each moment once over the hold, and nothing after it ends", async () => {
    const owner = await user();
    const held = slot(NOW);
    await holding(owner.id, [held]);
    const moments: GraceNoticeMoment[] = [];
    for (let now = NOW; now <= held.until + DAY; now += 6 * 3_600_000) {
      await scheduleGraceNotices(db(), now);
      for (const job of await jobsFor(owner.id)) {
        moments.push((job.payload as { moment: GraceNoticeMoment }).moment);
        await db().delete(schema.outbox).where(eq(schema.outbox.id, job.id));
      }
    }
    expect(moments).toEqual(["start", "two_weeks", "three_days"]);
  });

  it("sends only the most urgent moment after a late scan, and never the earlier ones", async () => {
    const owner = await user();
    const held = slot(NOW);
    await holding(owner.id, [held]);
    // The scan was down for 50 days: 10 days left, so the 14-day email, never the start.
    await scheduleGraceNotices(db(), held.until - 10 * DAY);
    expect((await onlyJob(owner.id)).payload).toMatchObject({ moment: "two_weeks" });
    await db().delete(schema.outbox);
    expect(await scheduleGraceNotices(db(), held.until - 5 * DAY)).toEqual({ scheduled: 0 });
    // Down again until a day before the end: the 3-day email once.
    await scheduleGraceNotices(db(), held.until - DAY);
    await scheduleGraceNotices(db(), held.until - DAY / 2);
    expect((await onlyJob(owner.id)).payload).toMatchObject({ moment: "three_days" });
  });

  it("gives a hold shorter than 14 days no late or second 14-day email", async () => {
    const owner = await user();
    const short = slot(NOW, NOW + 10 * DAY);
    await holding(owner.id, [short]);
    await scheduleGraceNotices(db(), NOW);
    expect((await onlyJob(owner.id)).payload).toMatchObject({ moment: "two_weeks" });
    await db().delete(schema.outbox);
    for (const now of [NOW + DAY, NOW + 5 * DAY, NOW + 6 * DAY]) {
      expect(await scheduleGraceNotices(db(), now)).toEqual({ scheduled: 0 });
    }
    await scheduleGraceNotices(db(), short.until - 3 * DAY);
    expect((await onlyJob(owner.id)).payload).toMatchObject({ moment: "three_days" });
  });

  it("sends one email when two holds are due together, marking both, then each one's own moments", async () => {
    const owner = await user();
    // Team lowered to Pro, then Pro removed: the Team hold keeps more and ends first.
    const first = teamSlot(NOW - 20 * DAY);
    const second = slot(NOW);
    await holding(owner.id, [second, first]);
    await scheduleGraceNotices(db(), NOW);
    const job = await onlyJob(owner.id);
    expect(job.payload).toMatchObject({ from: first.from, moment: "start" });
    const claim = (job.payload as { claim: string }).claim;
    expect(await marksOf(owner.id)).toEqual([
      { from: first.from, until: first.until, moment: "start", claim },
      { from: second.from, until: second.until, moment: "start", claim },
    ]);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(await scheduleGraceNotices(db(), NOW + 2 * MINUTE)).toEqual({ scheduled: 0 });
    // The later hold still gets its own later moments.
    await scheduleGraceNotices(db(), second.until - 2 * DAY);
    expect((await onlyJob(owner.id)).payload).toMatchObject({
      from: second.from,
      moment: "three_days",
    });
  });

  it("matches the domain rule row for row, and skips unreadable graces", async () => {
    const now = NOW;
    const cases: [GraceSlot[] | string, GraceNoticeMark[] | null][] = [
      [[slot(NOW)], null],
      [[slot(NOW)], [{ from: NOW, until: NOW + PLAN_GRACE_MS, moment: "start" }]],
      [[slot(NOW - 50 * DAY)], [{ from: NOW - 50 * DAY, until: NOW + 10 * DAY, moment: "start" }]],
      [
        [slot(NOW - 50 * DAY)],
        [{ from: NOW - 50 * DAY, until: NOW + 10 * DAY, moment: "two_weeks" }],
      ],
      [[slot(NOW - 58 * DAY)], [{ from: NOW - 58 * DAY, until: NOW + 2 * DAY, moment: "start" }]],
      [[slot(NOW - 70 * DAY)], null],
      [[slot(NOW)], [{ from: 1, until: 2, moment: "three_days" }]],
      ["not json", null],
      // A hold the SQL reads as due (an object with a live `until`) but `readGrace` refuses.
      [
        JSON.stringify([
          { ...slot(NOW), limits: { ...slot(NOW).limits, auditRetentionDays: 999_999 } },
        ]),
        null,
      ],
      [JSON.stringify([{ plan: "pro" }]), null],
      [[slot(NOW + DAY)], null],
    ];
    const owners: string[] = [];
    for (const [slots, marks] of cases) {
      const owner = await user();
      owners.push(owner.id);
      await holding(owner.id, slots, marks);
    }
    const expected: string[] = [];
    for (const ownerId of owners) {
      const row = await planRow(ownerId);
      if (row && graceNoticeDue(row, now)) expected.push(ownerId);
    }
    expect(expected).toHaveLength(5);
    expect(await scheduleGraceNotices(db(), now)).toEqual({ scheduled: expected.length });
    const scheduled = await db()
      .select({ subject: schema.outbox.subject })
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "plan_grace_notice"));
    expect(scheduled.map((row) => row.subject).sort()).toEqual(expected.sort());
  });

  it("reads at most its page of owners per run", async () => {
    expect(GRACE_NOTICE_OWNERS_PER_RUN).toBe(100);
  });

  it("announces a moment once when two scans run at once (one database)", async () => {
    const owner = await user();
    await holding(owner.id, [slot(NOW)]);
    let inner: { scheduled: number } | null = null;
    const outer = await scheduleGraceNotices(
      racing(async () => {
        inner = await scheduleGraceNotices(db(), NOW);
      }),
      NOW,
    );
    expect(inner).toEqual({ scheduled: 1 });
    expect(outer).toEqual({ scheduled: 0 });
    expect(await jobsFor(owner.id)).toHaveLength(1);
  });

  it("writes nothing when an operator's change lands between the read and the batch", async () => {
    const owner = await removedPro();
    const outer = await scheduleGraceNotices(
      racing(async () => {
        value(
          await setOwnerPlan(db(), {
            ownerId: owner.id,
            plan: "pro",
            seats: 1,
            validUntil: null,
            overrides: null,
            grantedBy: "operator",
            note: null,
            now: NOW + MINUTE,
          }),
        );
      }),
      NOW + MINUTE,
    );
    expect(outer).toEqual({ scheduled: 0 });
    expect(await jobsFor(owner.id)).toHaveLength(0);
    expect(await marksOf(owner.id)).toEqual([]);
  });

  it("sends nothing for --no-grace and starts with the maintenance run", async () => {
    const quiet = await user();
    value(
      await setOwnerPlan(db(), {
        ownerId: quiet.id,
        plan: "pro",
        seats: 1,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        now: NOW - DAY,
      }),
    );
    value(await removeOwnerPlan(db(), { ownerId: quiet.id, now: NOW, noGrace: true }));
    const announced = await removedPro();
    const summary = await runMaintenance(db(), env.ARTIFACTS, NOW + MINUTE);
    expect(summary.graceNotices).toBe(1);
    expect(await jobsFor(quiet.id)).toHaveLength(0);
    expect(await jobsFor(announced.id)).toHaveLength(1);
  });

  it("announces a natural expiry in the same run the grace scan stores it", async () => {
    const owner = await user();
    await regions()
      .global.insert(schema.ownerPlans)
      .values({
        ownerId: owner.id,
        plan: "pro",
        seats: 1,
        validUntil: NOW,
        grantedBy: "test",
        updatedAt: NOW - DAY,
      });
    await runMaintenance(db(), env.ARTIFACTS, NOW + MINUTE);
    expect((await onlyJob(owner.id)).payload).toMatchObject({
      from: NOW,
      until: NOW + PLAN_GRACE_MS,
      moment: "start",
    });
  });
});

describe("sendGraceNotice", () => {
  async function scheduled() {
    const owner = await removedPro();
    await scheduleGraceNotices(db(), NOW + MINUTE);
    return { owner, job: await onlyJob(owner.id) };
  }

  it("sends the owner what is held, until when and what goes, once", async () => {
    const { owner, job } = await scheduled();
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + 2 * MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: owner.email,
      locale: null,
      moment: "start",
      until: NOW + PLAN_GRACE_MS,
      plan: "pro",
      space: null,
    });
    expect(sent[0]?.kinds.map((kind) => kind.kind)).toEqual(
      expect.arrayContaining(["versions", "accessLog", "analytics", "pins"]),
    );
    for (const kind of sent[0]?.kinds ?? []) expect(kind.from).toBe(NOW + PLAN_GRACE_MS);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(1);
    // A second delivery of the same message finds its row claimed: nobody gets it twice.
    expect(await run(job, NOW + 3 * MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("is sent once when two deliveries of the message run at once", async () => {
    const { job } = await scheduled();
    const { graceNotifier, sent } = fakeNotifier();
    const outcomes = await Promise.all([
      run(job, NOW + 2 * MINUTE, graceNotifier),
      run(job, NOW + 2 * MINUTE, graceNotifier),
    ]);
    expect(outcomes).toEqual(["done", "done"]);
    expect(sent).toHaveLength(1);
  });

  it.each([
    [
      "the plan is granted again",
      async (ownerId: string) =>
        value(
          await setOwnerPlan(db(), {
            ownerId,
            plan: "pro",
            seats: 1,
            validUntil: null,
            overrides: null,
            grantedBy: "operator",
            note: null,
            now: NOW + 2 * MINUTE,
          }),
        ),
      NOW + 3 * MINUTE,
    ],
    [
      "the operator ends the grace with --no-grace",
      async (ownerId: string) =>
        value(await removeOwnerPlan(db(), { ownerId, now: NOW + 2 * MINUTE, noGrace: true })),
      NOW + 3 * MINUTE,
    ],
    ["a later moment is due by the time it runs", async () => {}, NOW + 50 * DAY],
    ["the hold ended", async () => {}, NOW + PLAN_GRACE_MS + MINUTE],
  ])("is moot when %s", async (_, change, at) => {
    const { owner, job } = await scheduled();
    await change(owner.id);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, at, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("is moot once the account is deleted, and leaves nothing behind", async () => {
    const { owner, job } = await scheduled();
    const sessionId = await session(owner.id, NOW + 2 * MINUTE);
    value(
      await requestAccountDeletion(regions(), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW + 2 * MINUTE,
      }),
    );
    for (let i = 0; i < 3 && (await planRow(owner.id)); i += 1) {
      await runMaintenance(db(), env.ARTIFACTS, NOW + (3 + i) * MINUTE);
    }
    expect(await planRow(owner.id)).toBeUndefined();
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + 10 * MINUTE, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("skips a suppressed address and drops the job", async () => {
    const { owner, job } = await scheduled();
    await suppressEmail(db().global, { email: owner.email, reason: "hard_bounce", now: NOW });
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + 2 * MINUTE, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(0);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("records the provider's suppression when it refuses the address", async () => {
    const { owner, job } = await scheduled();
    const { graceNotifier } = fakeNotifier(new RecipientSuppressedError());
    expect(await run(job, NOW + 2 * MINUTE, graceNotifier)).toBe("stale");
    expect(await isEmailSuppressed(db().global, owner.email, NOW + 2 * MINUTE)).toBe(true);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("stops on the expiry notices' rung and drops a start or 14-day email", async () => {
    const { owner, job } = await scheduled();
    await recordEmailsSent(db().global, NOW, NOTICE_EMAILS_PER_CYCLE);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + 2 * MINUTE, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
    expect(await emailsSentInCycle(db().global, NOW)).toBe(NOTICE_EMAILS_PER_CYCLE);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("keeps the last warning waiting for capacity, and sends it once there is room", async () => {
    const owner = await removedPro();
    const held = { from: NOW, until: NOW + PLAN_GRACE_MS };
    const at = held.until - 2 * DAY;
    await scheduleGraceNotices(db(), at);
    const job = await onlyJob(owner.id);
    expect(job.payload).toMatchObject({ moment: "three_days" });
    await recordEmailsSent(db().global, at, NOTICE_EMAILS_PER_CYCLE);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, at + MINUTE, graceNotifier)).toBe("kept");
    expect(sent).toHaveLength(0);
    const waiting = await onlyJob(owner.id);
    expect(waiting.id).not.toBe(job.id);
    expect(waiting.payload).toEqual(job.payload);
    expect(waiting.availableAt).toBe(at + MINUTE + GRACE_NOTICE_CAPACITY_RETRY_MS);
    // The scan does not schedule a second one meanwhile.
    expect(await scheduleGraceNotices(db(), at + 2 * MINUTE)).toEqual({ scheduled: 0 });
    // Still no room an hour later: it waits again.
    const later = at + MINUTE + GRACE_NOTICE_CAPACITY_RETRY_MS;
    expect(await run(waiting, later, graceNotifier)).toBe("kept");
    // Room again (the counters of a new cycle): it is sent, once.
    await env.DB.exec("DELETE FROM email_counters");
    const again = await onlyJob(owner.id);
    expect(await run(again, later + GRACE_NOTICE_CAPACITY_RETRY_MS, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("stops waiting at the hold's end: the warning is then moot", async () => {
    const owner = await removedPro();
    const until = NOW + PLAN_GRACE_MS;
    await scheduleGraceNotices(db(), until - DAY);
    const job = await onlyJob(owner.id);
    await recordEmailsSent(db().global, until - DAY, NOTICE_EMAILS_PER_CYCLE);
    const { graceNotifier } = fakeNotifier();
    expect(await run(job, until - DAY + MINUTE, graceNotifier)).toBe("kept");
    const waiting = await onlyJob(owner.id);
    expect(await run(waiting, until + MINUTE, graceNotifier)).toBe("stale");
    expect(await jobsFor(owner.id)).toHaveLength(0);
  });

  it("still sends one email below the rung", async () => {
    const { job } = await scheduled();
    await recordEmailsSent(db().global, NOW, NOTICE_EMAILS_PER_CYCLE - 1);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + 2 * MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
  });

  it("puts the job back when the first send fails, and the next delivery sends it", async () => {
    const { owner, job } = await scheduled();
    const failing = fakeNotifier(new Error("email delivery failed"));
    await expect(run(job, NOW + 2 * MINUTE, failing.graceNotifier)).rejects.toThrow(
      "email delivery failed",
    );
    const back = await onlyJob(owner.id);
    expect(back.id).not.toBe(job.id);
    expect(back.payload).toEqual(job.payload);
    // The scan does not schedule it again meanwhile: the mark stays.
    expect(await scheduleGraceNotices(db(), NOW + 3 * MINUTE)).toEqual({ scheduled: 0 });
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(back, NOW + 4 * MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
  });

  it("needs the notifier and the access log, and keeps the job without them", async () => {
    const { owner, job } = await scheduled();
    await expect(
      runJob(db(), env.ARTIFACTS, message(job), NOW, { access: access() }),
    ).rejects.toThrow("plan_grace_notice needs the grace notifier");
    await expect(
      runJob(db(), env.ARTIFACTS, message(job), NOW, {
        graceNotifier: fakeNotifier().graceNotifier,
      }),
    ).rejects.toThrow("plan_grace_notice needs the access log database");
    expect(await jobsFor(owner.id)).toHaveLength(1);
  });

  it("drops a malformed payload", async () => {
    const owner = await user();
    const [row] = await db()
      .insert(schema.outbox)
      .values({
        topic: "plan_grace_notice",
        payload: { moment: "later" },
        availableAt: NOW,
        createdAt: NOW,
        subject: owner.id,
      })
      .returning();
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(row as { id: number }, NOW, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("goes to each admin of a workspace in their language, never to its members", async () => {
    const admin = await user("Admin");
    const other = await user("Other admin");
    const member = await user("Member");
    const slug = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(regions().global, {
        slug,
        name: "Engines",
        adminUserId: admin.id,
        now: NOW,
      }),
    );
    await regions()
      .global.insert(schema.workspaceMembers)
      .values([
        { workspaceId: ws.id, userId: other.id, role: "admin", updatedAt: NOW },
        { workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW },
      ]);
    await regions()
      .global.insert(schema.accountSettings)
      .values({ userId: other.id, locale: "de", updatedAt: NOW });
    await holding(ws.id, [slot(NOW)]);
    await scheduleGraceNotices(db(), NOW);
    const job = await onlyJob(ws.id);
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + MINUTE, graceNotifier)).toBe("done");
    expect(sent.map((notice) => [notice.to, notice.locale]).sort()).toEqual(
      [
        [admin.email, null],
        [other.email, "de"],
      ].sort(),
    );
    for (const notice of sent) expect(notice.space).toEqual({ slug, name: "Engines" });
    expect(await emailsSentInCycle(db().global, NOW)).toBe(2);
  });

  it("drops the email for an admin when it failed after another admin got it", async () => {
    const admin = await user("Admin");
    const other = await user("Other admin");
    const ws = value(
      await createWorkspace(regions().global, {
        slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
        name: "Engines",
        adminUserId: admin.id,
        now: NOW,
      }),
    );
    await regions()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: other.id, role: "admin", updatedAt: NOW });
    await holding(ws.id, [slot(NOW)]);
    await scheduleGraceNotices(db(), NOW);
    const job = await onlyJob(ws.id);
    let calls = 0;
    const sent: string[] = [];
    const graceNotifier: GraceNotifier = {
      async send(notice) {
        calls += 1;
        if (calls === 2) throw new Error("email delivery failed");
        sent.push(notice.to);
      },
    };
    expect(await run(job, NOW + MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    expect(await jobsFor(ws.id)).toHaveLength(0);
  });
});

describe("an EU workspace's grace emails (separate regional database)", () => {
  async function euWorkspace() {
    const admin = await user("Admin");
    const created = value(
      await createWorkspace(regions().global, {
        slug: `eu-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU team",
        adminUserId: admin.id,
        now: NOW,
        region: "eu",
      }),
    );
    value(
      await setOwnerPlan(eu().db, {
        ownerId: created.id,
        plan: "team",
        seats: 2,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        now: NOW - DAY,
      }),
    );
    value(await removeOwnerPlan(eu().db, { ownerId: created.id, now: NOW }));
    return { admin, ws: created };
  }

  it("is scheduled by the EU region's maintenance only, in the EU outbox, and sent from it", async () => {
    const { admin, ws } = await euWorkspace();
    expect(await scheduleGraceNotices(db(), NOW + MINUTE)).toEqual({ scheduled: 0 });
    const summary = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + MINUTE, "eu");
    expect(summary.graceNotices).toBe(1);
    expect(await jobsFor(ws.id)).toHaveLength(0);
    const job = await onlyJob(ws.id, eu().db);
    expect(job.payload).toMatchObject({ moment: "start", until: NOW + PLAN_GRACE_MS });
    expect((await marksOf(ws.id)).map((mark) => mark.moment)).toEqual(["start"]);

    const { graceNotifier, sent } = fakeNotifier();
    expect(
      await runJob(eu().db, env.ARTIFACTS_EU, message(job, "eu"), NOW + 2 * MINUTE, {
        access: euAccess(),
        graceNotifier,
      }),
    ).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: admin.email, plan: "team", moment: "start" });
    expect(await scheduleGraceNotices(eu().db, NOW + 3 * MINUTE, "eu")).toEqual({ scheduled: 0 });
  });

  it("writes one job when two scans run at once: the mark first, the job only after it", async () => {
    const { ws } = await euWorkspace();
    let inner: { scheduled: number } | null = null;
    const raced = regionalDb(
      env.DB_EU,
      raceGlobalBeforeFirstWrite(async () => {
        inner = await scheduleGraceNotices(eu().db, NOW + MINUTE, "eu");
      }),
    );
    const outer = await scheduleGraceNotices(raced, NOW + MINUTE, "eu");
    expect(inner).toEqual({ scheduled: 1 });
    expect(outer).toEqual({ scheduled: 0 });
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(1);
  });
});

describe("a restore", () => {
  it("carries the marks, so an email already sent is not sent again", async () => {
    const owner = await removedPro();
    await scheduleGraceNotices(db(), NOW + MINUTE);
    const exported = await exportOwnerPlans(regions().global, NOW + 2 * MINUTE);
    const mine = exported.filter((plan) => plan.ownerId === owner.id);
    expect(mine[0]?.graceNotices).toEqual([
      { from: NOW, until: NOW + PLAN_GRACE_MS, moment: "start", claim: expect.any(String) },
    ]);
    // The restore rewinds the row to before the email.
    await regions()
      .global.update(schema.ownerPlans)
      .set({ graceNotices: null })
      .where(eq(schema.ownerPlans.ownerId, owner.id));
    await db().delete(schema.outbox);
    await applyOwnerPlans(regions(), mine, NOW + 3 * MINUTE);
    expect(await marksOf(owner.id)).toEqual(mine[0]?.graceNotices);
    expect(await scheduleGraceNotices(db(), NOW + 4 * MINUTE)).toEqual({ scheduled: 0 });
  });

  it("without marks in an older export, sends each hold's most urgent moment once", async () => {
    const owner = await removedPro();
    await scheduleGraceNotices(db(), NOW + MINUTE);
    const [plan] = (await exportOwnerPlans(regions().global, NOW)).filter(
      (row) => row.ownerId === owner.id,
    );
    if (!plan) throw new Error("no plan exported");
    const { graceNotices: _, ...older } = plan;
    await db().delete(schema.outbox);
    await applyOwnerPlans(regions(), [older], NOW + 20 * DAY);
    expect(await marksOf(owner.id)).toEqual([]);
    expect(await scheduleGraceNotices(db(), NOW + 50 * DAY)).toEqual({ scheduled: 1 });
    expect((await onlyJob(owner.id)).payload).toMatchObject({ moment: "two_weeks" });
  });
});

describe("the review's cases", () => {
  it("never lets rows it cannot announce keep later owners waiting (the cursor moves on)", async () => {
    const bad = slot(NOW);
    bad.limits.auditRetentionDays = 999_999; // above RETENTION_LIMIT_MAX: unreadable for readGrace
    for (let i = 0; i < GRACE_NOTICE_OWNERS_PER_RUN; i += 1) {
      await holding(`0000-bad-${String(i).padStart(3, "0")}`, [bad]);
    }
    const owner = await removedPro();
    for (let run = 0; run < 3; run += 1) {
      await scheduleGraceNotices(db(), NOW + MINUTE + run * 15 * MINUTE);
    }
    expect(await jobsFor(owner.id)).toHaveLength(1);
    await env.DB.exec("DELETE FROM owner_plans WHERE owner_id LIKE '0000-bad-%'");
  });

  it("dates every kind in a covering hold's email at that hold's end", async () => {
    const owner = await user("Owner");
    // Two Pro holds: the earlier one's end lets nothing go, so it is not announced.
    const a = slot(NOW - 50 * DAY);
    const b = slot(NOW);
    await holding(owner.id, [a, b]);
    await scheduleGraceNotices(db(), a.until - 10 * DAY);
    const job = await onlyJob(owner.id);
    expect(job.payload).toMatchObject({ from: b.from, until: b.until });
    const { graceNotifier, sent } = fakeNotifier();
    await run(job, a.until - 10 * DAY + MINUTE, graceNotifier);
    expect(sent).toHaveLength(1);
    for (const kind of sent[0]?.kinds ?? []) expect(kind.from).toBe(b.until);
  });
});

describe("a crash between the job and the mark", () => {
  async function euHolding(marks: GraceNoticeMark[] | null) {
    const admin = await user("Admin");
    const ws = value(
      await createWorkspace(regions().global, {
        slug: `eu-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU",
        adminUserId: admin.id,
        now: NOW,
        region: "eu",
      }),
    );
    const held = slot(NOW - 58 * DAY);
    await holding(ws.id, [held], marks);
    return { ws, held };
  }

  async function sendAll(ownerId: string, region?: "eu") {
    const database = region ? eu().db : db();
    const { graceNotifier, sent } = fakeNotifier();
    for (const job of await jobsFor(ownerId, database)) {
      await runJob(
        database,
        region ? env.ARTIFACTS_EU : env.ARTIFACTS,
        message(job, region),
        NOW + HOUR,
        {
          access: region ? euAccess() : access(),
          graceNotifier,
        },
      );
    }
    return sent;
  }

  it("before the regional job: nothing is written and the next scan schedules it", async () => {
    const { ws } = await euHolding([
      { from: NOW - 58 * DAY, until: NOW + 2 * DAY, moment: "two_weeks" },
    ]);
    const broken = regionalDb(failing(env.DB_EU, /insert into "outbox"/), regions().global);
    await expect(scheduleGraceNotices(broken, NOW, "eu")).rejects.toThrow();
    expect((await marksOf(ws.id)).map((mark) => mark.moment)).toEqual(["two_weeks"]);
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(0);
    expect(await scheduleGraceNotices(eu().db, NOW + 15 * MINUTE, "eu")).toEqual({ scheduled: 1 });
    expect((await sendAll(ws.id, "eu")).map((notice) => notice.moment)).toEqual(["three_days"]);
  });

  it("between the regional job and the global mark: that job is moot and the next scan sends once", async () => {
    const { ws } = await euHolding([
      { from: NOW - 58 * DAY, until: NOW + 2 * DAY, moment: "two_weeks" },
    ]);
    const broken = regionalDb(env.DB_EU, globalDb(failing(env.DB, /update "owner_plans"/)));
    await expect(scheduleGraceNotices(broken, NOW, "eu")).rejects.toThrow();
    // The 3-day email is not lost: the mark did not land, so the next scan schedules it again.
    expect((await marksOf(ws.id)).map((mark) => mark.moment)).toEqual(["two_weeks"]);
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(1);
    for (let i = 1; i <= 3; i += 1) {
      await scheduleGraceNotices(eu().db, NOW + i * 15 * MINUTE, "eu");
    }
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(2);
    // The stale job's token is in no mark: of the two, one email goes.
    expect((await sendAll(ws.id, "eu")).map((notice) => notice.moment)).toEqual(["three_days"]);
  });

  it("with one database: the batch is all or nothing, and the next scan sends once", async () => {
    const owner = await user();
    await holding(
      owner.id,
      [slot(NOW - 58 * DAY)],
      [{ from: NOW - 58 * DAY, until: NOW + 2 * DAY, moment: "two_weeks" }],
    );
    const binding = failing(env.DB, /update "owner_plans"/);
    const broken = regionalDb(binding, globalDb(binding));
    await expect(scheduleGraceNotices(broken, NOW)).rejects.toThrow("worker died");
    expect(await jobsFor(owner.id)).toHaveLength(0);
    expect((await marksOf(owner.id)).map((mark) => mark.moment)).toEqual(["two_weeks"]);
    await scheduleGraceNotices(db(), NOW + 15 * MINUTE);
    await scheduleGraceNotices(db(), NOW + 30 * MINUTE);
    expect((await sendAll(owner.id)).map((notice) => notice.moment)).toEqual(["three_days"]);
  });

  it("two concurrent scans with a separate database send one email", async () => {
    const { ws } = await euHolding(null);
    const raced = regionalDb(
      env.DB_EU,
      raceGlobalBeforeFirstWrite(async () => {
        await scheduleGraceNotices(eu().db, NOW, "eu");
      }),
    );
    await scheduleGraceNotices(raced, NOW, "eu");
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(1);
    expect(await sendAll(ws.id, "eu")).toHaveLength(1);
  });
});

describe("the second review's cases", () => {
  function beforeMark(before: () => Promise<void>) {
    let fired = false;
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (!/^update "owner_plans"/.test(query)) return statement;
            const wrap = (inner: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(inner, {
                get(t, k) {
                  if (k === "bind") return (...v: unknown[]) => wrap(t.bind(...v));
                  if (k === "run" || k === "all" || k === "raw" || k === "first") {
                    return async (...a: unknown[]) => {
                      if (!fired) {
                        fired = true;
                        await before();
                      }
                      // biome-ignore lint/suspicious/noExplicitAny: forwarding the D1 call as is
                      return (t as any)[k](...a);
                    };
                  }
                  const v = Reflect.get(t, k);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              });
            return wrap(statement);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return globalDb(aliasBinding(d1, env.DB));
  }

  async function euWithTwoWeeksTold() {
    const admin = await user("Admin");
    const ws = value(
      await createWorkspace(regions().global, {
        slug: `eu-${crypto.randomUUID().slice(0, 8)}`,
        name: "EU",
        adminUserId: admin.id,
        now: NOW,
        region: "eu",
      }),
    );
    const held = slot(NOW - 58 * DAY);
    await holding(ws.id, [held], [{ from: held.from, until: held.until, moment: "two_weeks" }]);
    return { ws, held };
  }

  async function runDue(ownerId: string, at: number, graceNotifier: GraceNotifier) {
    for (const job of await jobsFor(ownerId, eu().db)) {
      if (job.availableAt > at) continue;
      await runJob(eu().db, env.ARTIFACTS_EU, message(job, "eu"), at, {
        access: euAccess(),
        graceNotifier,
      });
    }
  }

  it("R1: a job that runs before its mark lands waits for it, and the last warning goes once", async () => {
    const { ws, held } = await euWithTwoWeeksTold();
    const { graceNotifier, sent } = fakeNotifier();
    // The relay and the consumer pick the job up between its insert and the global mark.
    const raced = regionalDb(
      env.DB_EU,
      beforeMark(async () => {
        for (const job of await jobsFor(ws.id, eu().db)) {
          await runJob(eu().db, env.ARTIFACTS_EU, message(job, "eu"), NOW + 1_000, {
            access: euAccess(),
            graceNotifier,
          });
        }
      }),
    );
    expect(await scheduleGraceNotices(raced, NOW, "eu")).toEqual({ scheduled: 1 });
    // It waited instead of dropping: still in the outbox, a few minutes later.
    const [waiting] = await jobsFor(ws.id, eu().db);
    expect(waiting?.availableAt).toBe(NOW + 1_000 + GRACE_NOTICE_MARK_WAIT_MS);
    expect((waiting?.payload as { waits?: number }).waits).toBe(1);
    for (let t = NOW + 5 * MINUTE; t < held.until; t += 15 * MINUTE) {
      await scheduleGraceNotices(eu().db, t, "eu");
      await runDue(ws.id, t + MINUTE, graceNotifier);
    }
    expect(sent.map((notice) => notice.moment)).toEqual(["three_days"]);
  });

  it("R1: the job is written a little in the future, so the common case never races", async () => {
    const { ws } = await euWithTwoWeeksTold();
    await scheduleGraceNotices(eu().db, NOW, "eu");
    expect((await onlyJob(ws.id, eu().db)).availableAt).toBe(NOW + GRACE_NOTICE_MARK_DELAY_MS);
  });

  it("R1: a crashed scan's job waits a bounded number of times and never sends twice", async () => {
    const { ws, held } = await euWithTwoWeeksTold();
    const broken = regionalDb(env.DB_EU, globalDb(failing(env.DB, /update "owner_plans"/)));
    await expect(scheduleGraceNotices(broken, NOW, "eu")).rejects.toThrow();
    const { graceNotifier, sent } = fakeNotifier();
    // No scan for a while: the stale job waits, then gives up once its waits are spent.
    for (let i = 0; i <= GRACE_NOTICE_MARK_WAITS + 1; i += 1) {
      await runDue(
        ws.id,
        NOW + GRACE_NOTICE_MARK_DELAY_MS + i * GRACE_NOTICE_MARK_WAIT_MS,
        graceNotifier,
      );
    }
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // The next scan schedules it again (the mark never landed), and it is sent once.
    for (let t = NOW + HOUR; t < held.until; t += 15 * MINUTE) {
      await scheduleGraceNotices(eu().db, t, "eu");
      await runDue(ws.id, t + 5 * MINUTE, graceNotifier);
    }
    expect(sent.map((notice) => notice.moment)).toEqual(["three_days"]);
  });

  it("R1: a crashed scan's job that runs after the next scan is moot: one email", async () => {
    const { ws } = await euWithTwoWeeksTold();
    const broken = regionalDb(env.DB_EU, globalDb(failing(env.DB, /update "owner_plans"/)));
    await expect(scheduleGraceNotices(broken, NOW, "eu")).rejects.toThrow();
    await scheduleGraceNotices(eu().db, NOW + 15 * MINUTE, "eu");
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(2);
    const { graceNotifier, sent } = fakeNotifier();
    await runDue(ws.id, NOW + 30 * MINUTE, graceNotifier);
    await runDue(ws.id, NOW + 45 * MINUTE, graceNotifier);
    expect(sent.map((notice) => notice.moment)).toEqual(["three_days"]);
    expect(await jobsFor(ws.id, eu().db)).toHaveLength(0);
  });

  it("R2: Enterprise lowered to Team (nothing goes at the hold's end) sends nothing", async () => {
    const owner = await user("Owner");
    for (const [name, at] of [
      ["enterprise", NOW - 10 * DAY],
      ["team", NOW],
    ] as const) {
      value(
        await setOwnerPlan(db(), {
          ownerId: owner.id,
          plan: name,
          seats: 1,
          validUntil: null,
          overrides: null,
          grantedBy: "operator",
          note: null,
          now: at,
        }),
      );
    }
    expect(JSON.parse((await planRow(owner.id))?.grace ?? "[]")).toHaveLength(1);
    const { graceNotifier, sent } = fakeNotifier();
    for (const t of [NOW + MINUTE, NOW + 47 * DAY, NOW + 58 * DAY]) {
      await scheduleGraceNotices(db(), t);
      for (const job of await jobsFor(owner.id)) await run(job, t + MINUTE, graceNotifier);
    }
    expect(sent).toEqual([]);
    // Marked covered once, so later scans do not read it again.
    expect((await marksOf(owner.id)).map((mark) => mark.covered)).toEqual([1]);
  });

  it("R3: the last warning reaches the second admin once capacity returns", async () => {
    const a1 = await user("A1");
    const a2 = await user("A2");
    const ws = value(
      await createWorkspace(regions().global, {
        slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
        name: "WS",
        adminUserId: a1.id,
        now: NOW,
      }),
    );
    await regions()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: a2.id, role: "admin", updatedAt: NOW });
    const held = slot(NOW - 58 * DAY);
    await holding(ws.id, [held], [{ from: held.from, until: held.until, moment: "two_weeks" }]);
    await scheduleGraceNotices(db(), NOW);
    // Room for exactly one more notice email.
    await recordEmailsSent(regions().global, NOW, NOTICE_EMAILS_PER_CYCLE - 1);
    const sent: string[] = [];
    const graceNotifier: GraceNotifier = {
      async send(notice) {
        sent.push(notice.to);
      },
    };
    const [first] = await jobsFor(ws.id);
    expect(await run(first as { id: number }, NOW + MINUTE, graceNotifier)).toBe("done");
    expect(sent).toHaveLength(1);
    const waiting = await onlyJob(ws.id);
    const told = sent[0] === a1.email ? a1 : a2;
    const untold = told === a1 ? a2 : a1;
    expect((waiting.payload as { recipients?: string[] }).recipients).toEqual([untold.id]);
    await env.DB.exec("DELETE FROM email_counters");
    expect(await run(waiting, NOW + MINUTE + GRACE_NOTICE_CAPACITY_RETRY_MS, graceNotifier)).toBe(
      "done",
    );
    expect(sent.sort()).toEqual([a1.email, a2.email].sort());
  });

  it("R3: an admin removed meanwhile gets nothing, and a new admin is not added", async () => {
    const a1 = await user("A1");
    const a2 = await user("A2");
    const a3 = await user("A3");
    const ws = value(
      await createWorkspace(regions().global, {
        slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
        name: "WS",
        adminUserId: a1.id,
        now: NOW,
      }),
    );
    const held = slot(NOW - 58 * DAY);
    await holding(ws.id, [held], [{ from: held.from, until: held.until, moment: "two_weeks" }]);
    await scheduleGraceNotices(db(), NOW);
    const job = await onlyJob(ws.id);
    // Put back for a2 only; a2 then leaves the admins and a3 becomes one.
    await db()
      .update(schema.outbox)
      .set({ payload: { ...(job.payload as object), recipients: [a2.id] } })
      .where(eq(schema.outbox.id, job.id));
    await regions()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: a3.id, role: "admin", updatedAt: NOW });
    const { graceNotifier, sent } = fakeNotifier();
    expect(await run(job, NOW + MINUTE, graceNotifier)).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("R4: the services never keep a covered hold: a grant that covers it ends it as renewed", async () => {
    const owner = await user("Owner");
    const t1 = NOW - 20 * DAY - 7_777;
    const grant = (name: "pro" | "team", at: number) =>
      setOwnerPlan(db(), {
        ownerId: owner.id,
        plan: name,
        seats: 1,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        now: at,
      });
    value(await grant("pro", NOW - 300 * DAY));
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: t1 }));
    value(await grant("team", t1 + DAY));
    value(await removeOwnerPlan(db(), { ownerId: owner.id, now: NOW }));
    // Only the Team hold: the Pro one ended when Team was granted (decision 0022).
    expect(JSON.parse((await planRow(owner.id))?.grace ?? "[]")).toHaveLength(1);
  });
});
