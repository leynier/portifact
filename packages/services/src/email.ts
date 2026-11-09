// Email delivery use cases (plan sections 12 and 17): count every email Portifact sends, so the
// budget run measures them and sign-in codes stop at the monthly cap, and keep the suppression
// list of addresses whose mail bounced permanently or was reported as spam.
import {
  EMAIL_SUPPRESSED,
  type EmailSendingEvent,
  type EmailSuppressionReason,
} from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  budgetCycle,
  checkEmailCapacity,
  EMAIL_SUPPRESSED_MESSAGE,
  emailDay,
  emailHint,
  normalizeEmail,
  suppressionExpiry,
  suppressionForEvent,
} from "@portifact/domain";
import { and, desc, eq, gt, gte, lt, lte, type SQLWrapper, sql, sum } from "drizzle-orm";

/** Email Service refused the send because its suppression list holds the recipient. */
export class RecipientSuppressedError extends Error {
  constructor() {
    super("email recipient suppressed");
    this.name = "RecipientSuppressedError";
  }
}

/** Cloudflare's binding rejects with `E_RECIPIENT_SUPPRESSED`, as a code or in the message. */
export function isRecipientSuppressed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "E_RECIPIENT_SUPPRESSED" ||
    (typeof message === "string" && message.includes("E_RECIPIENT_SUPPRESSED"))
  );
}

// The hash only keys the list; it is unkeyed so the operator tool can look an address up without
// the Worker's secrets. The prefix keeps it apart from any other hash of an address.
const HASH_PREFIX = "portifact:email-suppression:v1:";

/** The key of an address in the suppression list: SHA-256 of the normalized address, in hex. */
export async function emailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(HASH_PREFIX + normalizeEmail(email)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Counts emails sent now in the day's counter, one upsert so concurrent sends add up. */
export async function recordEmailsSent(db: Db, now: number, count = 1): Promise<void> {
  if (count <= 0) return;
  await db
    .insert(schema.emailCounters)
    .values({ day: emailDay(now), sent: count })
    .onConflictDoUpdate({
      target: schema.emailCounters.day,
      set: { sent: sql`${schema.emailCounters.sent} + excluded.sent` },
    });
}

/** Emails sent in the cycle (the UTC calendar month) that contains `now`. */
export async function emailsSentInCycle(db: Db, now: number): Promise<number> {
  const { start, end } = budgetCycle(now);
  const c = schema.emailCounters;
  const [row] = await db
    .select({ sent: sum(c.sent) })
    .from(c)
    .where(and(gte(c.day, start), lt(c.day, end)));
  return Number(row?.sent ?? 0);
}

/** Deletes day counters older than the previous cycle; the budget only reads the current one. */
export async function pruneEmailCounters(db: Db, now: number): Promise<number> {
  const previous = budgetCycle(budgetCycle(now).start - 1).start;
  const rows = await db
    .delete(schema.emailCounters)
    .where(lt(schema.emailCounters.day, previous))
    .returning({ day: schema.emailCounters.day });
  return rows.length;
}

export interface EmailSuppression {
  /** The first 12 characters of the hash, enough for the operator to tell rows apart. */
  id: string;
  hint: string;
  reason: EmailSuppressionReason;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const rank = (reason: SQLWrapper) =>
  sql`(case ${reason} when 'complaint' then 3 when 'hard_bounce' then 2 else 1 end)`;

/** Whether sign-in codes to this address are suppressed now. */
export async function isEmailSuppressed(db: Db, email: string, now: number): Promise<boolean> {
  const s = schema.emailSuppressions;
  const [row] = await db
    .select({ hash: s.emailHash })
    .from(s)
    .where(and(eq(s.emailHash, await emailHash(email)), gt(s.expiresAt, now)))
    .limit(1);
  return row !== undefined;
}

/**
 * Records a suppression. A repeat keeps the first time and extends the row to the later expiry;
 * the stronger reason wins (complaint, then hard bounce, then provider), so a later `provider`
 * refusal never hides why the address was suppressed.
 */
export async function suppressEmail(
  db: Db,
  input: { email: string; reason: EmailSuppressionReason; eventId?: string | null; now: number },
): Promise<void> {
  const s = schema.emailSuppressions;
  const expiresAt = suppressionExpiry(input.reason, input.now);
  await db
    .insert(s)
    .values({
      emailHash: await emailHash(input.email),
      hint: emailHint(input.email),
      reason: input.reason,
      eventId: input.eventId ?? null,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: s.emailHash,
      set: {
        reason: sql`case when ${s.expiresAt} > excluded.updated_at and ${rank(s.reason)} > ${rank(sql`excluded.reason`)} then ${s.reason} else excluded.reason end`,
        eventId: sql`coalesce(excluded.event_id, ${s.eventId})`,
        // An expired row starts again, so its creation time says when this suppression began.
        createdAt: sql`case when ${s.expiresAt} > excluded.updated_at then ${s.createdAt} else excluded.created_at end`,
        updatedAt: sql`excluded.updated_at`,
        expiresAt: sql`max(case when ${s.expiresAt} > excluded.updated_at then ${s.expiresAt} else 0 end, excluded.expires_at)`,
      },
    });
}

/**
 * Applies one Email Service event: complaints and hard bounces suppress the recipient, everything
 * else is ignored. Safe to apply twice: a repeat only extends the same row.
 */
export async function recordEmailEvent(
  db: Db,
  event: EmailSendingEvent,
  now: number,
): Promise<"suppressed" | "ignored"> {
  const reason = suppressionForEvent(event);
  if (!reason) return "ignored";
  await suppressEmail(db, {
    email: event.payload.recipient,
    reason,
    eventId: event.payload.eventId ?? null,
    now,
  });
  return "suppressed";
}

/** Suppressions in effect now, newest first. */
export async function listEmailSuppressions(
  db: Db,
  input: { now: number; limit: number },
): Promise<EmailSuppression[]> {
  const s = schema.emailSuppressions;
  const rows = await db
    .select()
    .from(s)
    .where(gt(s.expiresAt, input.now))
    .orderBy(desc(s.updatedAt), s.emailHash)
    .limit(input.limit);
  return rows.map((row) => ({
    id: row.emailHash.slice(0, 12),
    hint: row.hint,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  }));
}

/** Lifts the suppression of an address; false when it had none. */
export async function liftEmailSuppression(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .delete(schema.emailSuppressions)
    .where(eq(schema.emailSuppressions.emailHash, await emailHash(email)))
    .returning({ hash: schema.emailSuppressions.emailHash });
  return rows.length > 0;
}

/** Deletes suppressions that ended. */
export async function pruneEmailSuppressions(db: Db, now: number): Promise<number> {
  const rows = await db
    .delete(schema.emailSuppressions)
    .where(lte(schema.emailSuppressions.expiresAt, now))
    .returning({ hash: schema.emailSuppressions.emailHash });
  return rows.length;
}

export type SignInEmailCheck =
  | { ok: true }
  | { ok: false; code: typeof EMAIL_SUPPRESSED | "capacity_unavailable"; message: string };

/**
 * Whether a sign-in code may go to this address now: not to a suppressed address, and not once
 * the cycle's sign-in emails are spent. The suppression comes first, so its explanation shows
 * even when the cycle is full.
 */
export async function checkSignInEmail(
  db: Db,
  email: string,
  now: number,
): Promise<SignInEmailCheck> {
  if (await isEmailSuppressed(db, email, now)) {
    return { ok: false, code: EMAIL_SUPPRESSED, message: EMAIL_SUPPRESSED_MESSAGE };
  }
  const capacity = checkEmailCapacity(await emailsSentInCycle(db, now));
  return capacity.ok
    ? { ok: true }
    : { ok: false, code: "capacity_unavailable", message: capacity.message };
}
