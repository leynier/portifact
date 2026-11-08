// Email delivery rules (plan sections 2, 12 and 17): the global monthly budget of sign-in codes and
// the suppression of addresses whose mail bounced permanently or was reported as spam. Sending
// to such addresses again hurts the sending domain's reputation, which every sign-in depends on.
import type { EmailSendingEvent, EmailSuppressionReason } from "@portifact/contracts";
import { ADMISSION_LIMITS } from "./budget.ts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Emails of the cycle kept for the operator's budget alerts. Sign-in codes stop before the
 * admission limit, so codes alone never reach it and never stop publishing.
 */
export const EMAIL_RESERVE = 100;

/** Sign-in codes Portifact sends in one cycle (the UTC calendar month) at most. */
export const SIGN_IN_EMAILS_PER_CYCLE = ADMISSION_LIMITS.emails - EMAIL_RESERVE;

/**
 * How long each kind of suppression is kept. Cloudflare keeps its own list (complaints and
 * missing mailboxes forever), so an expired row only means the next refused send records a
 * `provider` suppression again.
 */
export const SUPPRESSION_TTL_MS: Record<EmailSuppressionReason, number> = {
  hard_bounce: 30 * DAY_MS,
  complaint: 180 * DAY_MS,
  provider: 7 * DAY_MS,
};

/** Whether the cycle still has room for another sign-in code. */
export function checkEmailCapacity(sentThisCycle: number): Result<true> {
  return sentThisCycle >= SIGN_IN_EMAILS_PER_CYCLE
    ? fail(
        "capacity_unavailable",
        "Portifact sent all the sign-in emails it can this month. Sign in with Google or GitHub, or try again next month.",
      )
    : ok(true);
}

/** Why a sign-in code was not sent to a suppressed address, and what to do instead. */
export const EMAIL_SUPPRESSED_MESSAGE =
  "Portifact cannot send email to this address because earlier messages to it bounced or were reported as spam. Sign in with Google or GitHub, or write to privacy@portifact.com to have it reviewed.";

/** Addresses compare lowercase and without surrounding spaces, like `Email` in contracts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A masked form the operator can recognize without the full address: `a***@example.com`. */
export function emailHint(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${normalized[0]}***${normalized.slice(at)}`;
}

/**
 * The suppression an Email Service event asks for: every complaint, and bounces only when hard.
 * Soft bounces, deferrals and deliveries suppress nothing; Cloudflare retries those itself.
 */
export function suppressionForEvent(event: EmailSendingEvent): EmailSuppressionReason | null {
  if (event.type.endsWith("message.complained")) return "complaint";
  if (event.type.endsWith("message.bounced") && event.payload.bounce?.type === "hard") {
    return "hard_bounce";
  }
  return null;
}

/** When a suppression recorded at `now` for `reason` ends. */
export function suppressionExpiry(reason: EmailSuppressionReason, now: number): number {
  return now + SUPPRESSION_TTL_MS[reason];
}

/** The UTC day that contains `now`, the unit of the email counters. */
export function emailDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}
