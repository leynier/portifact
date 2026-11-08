// Email delivery for sign-in codes. Delivery sits behind `EmailSender` so tests use a fake and
// a fallback provider can be added without touching the auth configuration. Every code sent is
// counted for the budget, and a refusal because of Email Service's suppression list is recorded
// in Portifact's own list (docs/security.md, "Identity").
import { OTP_LIMITS } from "@portifact/contracts";
import type { Db } from "@portifact/db";
import { recordEmailsSent, suppressEmail } from "@portifact/services";

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

/** Email Service refused the send because its suppression list holds the recipient. */
export class RecipientSuppressedError extends Error {
  constructor() {
    super("email recipient suppressed");
    this.name = "RecipientSuppressedError";
  }
}

/** Cloudflare's binding rejects with `E_RECIPIENT_SUPPRESSED`, as a code or in the message. */
function isRecipientSuppressed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "E_RECIPIENT_SUPPRESSED" ||
    (typeof message === "string" && message.includes("E_RECIPIENT_SUPPRESSED"))
  );
}

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
  db: Db,
  sender: EmailSender,
  input: { email: string; code: string; now: () => number },
): Promise<void> {
  try {
    await sender.send(signInCodeEmail(input.email, input.code));
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(db, { email: input.email, reason: "provider", now: input.now() });
    }
    throw error;
  }
  await recordEmailsSent(db, input.now());
}

/** The sign-in code email: plain, monochrome and readable without HTML. */
export function signInCodeEmail(to: string, code: string): EmailMessage {
  const minutes = Math.round(OTP_LIMITS.codeTtlSeconds / 60);
  const subject = "Your Portifact sign-in code";
  const expiry = `The code expires in ${minutes} minutes and works once.`;
  const ignore = "If you did not try to sign in to Portifact, you can ignore this email.";
  const text = [
    `Your Portifact sign-in code is ${code}`,
    "",
    expiry,
    ignore,
    "",
    "Portifact",
    "https://portifact.com",
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${subject}</title></head>`,
    "<body>",
    `<h1>${subject}</h1>`,
    "<p>Enter this code on the sign-in page:</p>",
    `<p><strong>${code}</strong></p>`,
    `<p>${expiry}</p>`,
    `<p>${ignore}</p>`,
    '<p>Portifact, <a href="https://portifact.com">portifact.com</a></p>',
    "</body>",
    "</html>",
  ].join("\n");
  return { to, subject, text, html };
}
