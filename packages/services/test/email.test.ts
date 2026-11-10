// Email delivery: the day counters the budget reads, the monthly cap of sign-in codes and the
// suppression list fed by Email Service events and refused sends.
import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { SIGN_IN_EMAILS_PER_CYCLE } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { measurePlatformUsage } from "../src/budget.ts";
import {
  checkSignInEmail,
  emailHash,
  emailsSentInCycle,
  isEmailSuppressed,
  liftEmailSuppression,
  listEmailSuppressions,
  pruneEmailCounters,
  pruneEmailSuppressions,
  recordEmailEvent,
  recordEmailsSent,
  suppressEmail,
} from "../src/email.ts";
import { runMaintenance } from "../src/maintenance.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const db = () => regionsFromEnv(env).get("default").db;

const bounced = (recipient: string, type = "hard", eventId = "evt-1") => ({
  type: "cf.email.sending.message.bounced",
  payload: { eventId, recipient, bounce: { type } },
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM email_counters; DELETE FROM email_suppressions");
});

describe("email counters", () => {
  it("adds sends per UTC day and sums only the current cycle", async () => {
    await recordEmailsSent(db(), NOW);
    await recordEmailsSent(db(), NOW + 1_000, 2);
    await recordEmailsSent(db(), NOW + DAY);
    await recordEmailsSent(db(), Date.UTC(2026, 9, 31, 23));
    await recordEmailsSent(db(), Date.UTC(2026, 11, 1));
    await recordEmailsSent(db(), NOW, 0);
    expect(await emailsSentInCycle(db(), NOW)).toBe(4);
    const rows = await db().select().from(schema.emailCounters);
    expect(rows).toContainEqual({ day: Date.UTC(2026, 10, 20), sent: 3 });
  });

  it("are the budget's email metric, so emails are no longer unmeasured", async () => {
    expect((await measurePlatformUsage(db(), NOW)).emails).toBe(0);
    await recordEmailsSent(db(), NOW, 7);
    expect((await measurePlatformUsage(db(), NOW)).emails).toBe(7);
  });

  it("are pruned before the previous cycle", async () => {
    await recordEmailsSent(db(), Date.UTC(2026, 8, 30));
    await recordEmailsSent(db(), Date.UTC(2026, 9, 1));
    await recordEmailsSent(db(), NOW);
    expect(await pruneEmailCounters(db(), NOW)).toBe(1);
    const days = (await db().select().from(schema.emailCounters)).map((row) => row.day).sort();
    expect(days).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 20)]);
  });
});

describe("checkSignInEmail", () => {
  it("allows an address with no suppression while the cycle has room", async () => {
    expect(await checkSignInEmail(db(), "ok@example.test", NOW)).toEqual({ ok: true });
  });

  it("refuses a suppressed address with an explanation", async () => {
    await suppressEmail(db(), { email: "Gone@Example.test", reason: "hard_bounce", now: NOW });
    const check = await checkSignInEmail(db(), " gone@example.TEST ", NOW + 1);
    expect(check).toMatchObject({ ok: false, code: "email_suppressed" });
    expect(check.ok ? "" : check.message).toContain("bounced or were reported as spam");
  });

  it("refuses every address once the cycle's sign-in emails are spent", async () => {
    await recordEmailsSent(db(), NOW, SIGN_IN_EMAILS_PER_CYCLE - 1);
    expect((await checkSignInEmail(db(), "a@example.test", NOW)).ok).toBe(true);
    await recordEmailsSent(db(), NOW);
    expect(await checkSignInEmail(db(), "a@example.test", NOW)).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
    });
    // The next cycle starts empty.
    expect((await checkSignInEmail(db(), "a@example.test", Date.UTC(2026, 11, 1))).ok).toBe(true);
  });

  it("explains a suppression before the full cycle", async () => {
    await recordEmailsSent(db(), NOW, SIGN_IN_EMAILS_PER_CYCLE);
    await suppressEmail(db(), { email: "b@example.test", reason: "complaint", now: NOW });
    expect(await checkSignInEmail(db(), "b@example.test", NOW)).toMatchObject({
      code: "email_suppressed",
    });
  });
});

describe("suppression list", () => {
  it("stores a hash and a masked hint, never the address", async () => {
    await suppressEmail(db(), {
      email: "private.person@example.test",
      reason: "complaint",
      now: NOW,
    });
    const rows = await env.DB.prepare("select * from email_suppressions").all();
    expect(JSON.stringify(rows.results)).not.toContain("private.person");
    expect(rows.results).toEqual([
      expect.objectContaining({
        email_hash: await emailHash("PRIVATE.PERSON@example.test"),
        hint: "p***@example.test",
        reason: "complaint",
      }),
    ]);
    expect(await emailHash("a@example.test")).toMatch(/^[0-9a-f]{64}$/);
    expect(await emailHash("a@example.test")).not.toBe(await emailHash("b@example.test"));
  });

  it("records hard bounces and complaints from events and ignores the rest", async () => {
    expect(await recordEmailEvent(db(), bounced("hard@example.test"), NOW)).toBe("suppressed");
    expect(await recordEmailEvent(db(), bounced("soft@example.test", "soft"), NOW)).toBe("ignored");
    expect(
      await recordEmailEvent(
        db(),
        {
          type: "cf.email.sending.message.complained",
          payload: { recipient: "spam@example.test" },
        },
        NOW,
      ),
    ).toBe("suppressed");
    expect(
      await recordEmailEvent(
        db(),
        { type: "cf.email.sending.message.delivered", payload: { recipient: "ok@example.test" } },
        NOW,
      ),
    ).toBe("ignored");
    expect(await isEmailSuppressed(db(), "hard@example.test", NOW)).toBe(true);
    expect(await isEmailSuppressed(db(), "spam@example.test", NOW)).toBe(true);
    expect(await isEmailSuppressed(db(), "soft@example.test", NOW)).toBe(false);
    expect(await isEmailSuppressed(db(), "ok@example.test", NOW)).toBe(false);
    const [hard] = await db()
      .select()
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.emailHash, await emailHash("hard@example.test")));
    expect(hard).toMatchObject({ reason: "hard_bounce", eventId: "evt-1" });
  });

  it("applies a repeated event once, keeping the first time", async () => {
    await recordEmailEvent(db(), bounced("dup@example.test"), NOW);
    await recordEmailEvent(db(), bounced("dup@example.test"), NOW + 1_000);
    const rows = await db().select().from(schema.emailSuppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "hard_bounce",
      eventId: "evt-1",
      createdAt: NOW,
      updatedAt: NOW + 1_000,
      expiresAt: NOW + 1_000 + 30 * DAY,
    });
  });

  it("keeps the stronger reason and the later expiry", async () => {
    const email = "mixed@example.test";
    await suppressEmail(db(), { email, reason: "complaint", now: NOW });
    await suppressEmail(db(), { email, reason: "provider", now: NOW + DAY });
    await suppressEmail(db(), { email, reason: "hard_bounce", now: NOW + 2 * DAY });
    const [row] = await db().select().from(schema.emailSuppressions);
    expect(row).toMatchObject({ reason: "complaint", createdAt: NOW, expiresAt: NOW + 180 * DAY });

    await suppressEmail(db(), { email: "up@example.test", reason: "provider", now: NOW });
    await suppressEmail(db(), { email: "up@example.test", reason: "hard_bounce", now: NOW + 1 });
    const [up] = await db()
      .select()
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.hint, "u***@example.test"));
    expect(up).toMatchObject({ reason: "hard_bounce", expiresAt: NOW + 1 + 30 * DAY });
  });

  it("starts an expired suppression again instead of reviving the old one", async () => {
    const email = "again@example.test";
    await suppressEmail(db(), { email, reason: "complaint", now: NOW });
    const later = NOW + 200 * DAY;
    expect(await isEmailSuppressed(db(), email, later)).toBe(false);
    await suppressEmail(db(), { email, reason: "provider", now: later });
    const [row] = await db().select().from(schema.emailSuppressions);
    expect(row).toMatchObject({ reason: "provider", createdAt: later, expiresAt: later + 7 * DAY });
  });

  it("lists suppressions in effect, newest first, and lifts one by address", async () => {
    await suppressEmail(db(), {
      email: "old@example.test",
      reason: "provider",
      now: NOW - 8 * DAY,
    });
    await suppressEmail(db(), { email: "first@example.test", reason: "hard_bounce", now: NOW });
    await suppressEmail(db(), { email: "second@example.test", reason: "complaint", now: NOW + 1 });
    const listed = await listEmailSuppressions(db(), { now: NOW + 2, limit: 10 });
    expect(listed.map((row) => row.hint)).toEqual(["s***@example.test", "f***@example.test"]);
    expect(listed[0]?.id).toHaveLength(12);
    expect(await listEmailSuppressions(db(), { now: NOW + 2, limit: 1 })).toHaveLength(1);

    expect(await liftEmailSuppression(db(), "First@Example.test")).toBe(true);
    expect(await liftEmailSuppression(db(), "first@example.test")).toBe(false);
    expect(await isEmailSuppressed(db(), "first@example.test", NOW + 2)).toBe(false);
  });

  it("prunes suppressions that ended, also from the maintenance run", async () => {
    await suppressEmail(db(), { email: "ended@example.test", reason: "provider", now: NOW });
    await suppressEmail(db(), { email: "kept@example.test", reason: "complaint", now: NOW });
    expect(await pruneEmailSuppressions(db(), NOW + 7 * DAY - 1)).toBe(0);
    expect(await pruneEmailSuppressions(db(), NOW + 7 * DAY)).toBe(1);
    await suppressEmail(db(), { email: "ended@example.test", reason: "provider", now: NOW });
    await recordEmailsSent(db(), Date.UTC(2026, 7, 1));
    const result = await runMaintenance(db(), env.ARTIFACTS, NOW + 8 * DAY);
    expect(result).toMatchObject({ prunedEmailSuppressions: 1, prunedEmailCounters: 1 });
    expect(await isEmailSuppressed(db(), "kept@example.test", NOW + 8 * DAY)).toBe(true);
  });
});
