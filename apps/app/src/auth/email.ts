// Email delivery for sign-in codes. Delivery sits behind `EmailSender` so tests use a fake and
// a fallback provider can be added without touching the auth configuration. Every code sent is
// counted for the budget, and a refusal because of Email Service's suppression list is recorded
// in Portifact's own list (docs/security.md, "Identity").
import { OTP_LIMITS } from "@portifact/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import type { GlobalDb } from "@portifact/db";
import { negotiateLocale, parseAcceptLanguage } from "@portifact/domain/locale";
import { signInCodeEmail as renderSignInCode } from "@portifact/emails";
import {
  isRecipientSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "@portifact/services";

export { RecipientSuppressedError };

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const SENDER = { email: "noreply@portifact.com", name: "Portifact" } as const;

/** Sends through Cloudflare Email Service (the `send_email` binding). */
export function cloudflareEmailSender(binding: SendEmail): EmailSender {
  return {
    async send(message) {
      try {
        await binding.send({
          from: SENDER,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        // The provider error can echo the message, which holds the code and the address.
        // Replace it so nothing downstream logs either.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * Sends a sign-in code and counts it. A refusal for a suppressed recipient also suppresses the
 * address here, so the next request gets an explanation instead of a code that never arrives.
 * Better Auth swallows the error (it answers the same either way), so it must hold no secret.
 */
export async function deliverSignInCode(
  db: GlobalDb,
  sender: EmailSender,
  input: { email: string; code: string; now: () => number; locale?: LocaleCode | undefined },
): Promise<void> {
  try {
    await sender.send(signInCodeEmail(input.email, input.code, input.locale));
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(db, { email: input.email, reason: "provider", now: input.now() });
    }
    throw error;
  }
  await recordEmailsSent(db, input.now());
}

/**
 * The sign-in code email (packages/emails): the code, its expiry and the "ignore it" line, in
 * the language of the sign-in page that asked for it.
 */
export function signInCodeEmail(to: string, code: string, locale?: LocaleCode): EmailMessage {
  const expiresInMinutes = Math.round(OTP_LIMITS.codeTtlSeconds / 60);
  return { to, ...renderSignInCode({ email: to, code, expiresInMinutes, locale }) };
}

/**
 * The language of a sign-in email: the login page sends its own language as `Accept-Language`,
 * and any other client gets its browser's first supported language, or English.
 */
export function emailLocale(headers: Headers | undefined): LocaleCode {
  return negotiateLocale(parseAcceptLanguage(headers?.get("accept-language"))) ?? DEFAULT_LOCALE;
}
