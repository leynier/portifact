// Email delivery for sign-in codes. Delivery sits behind `EmailSender` so tests use a fake and
// a fallback provider can be added without touching the auth configuration.
import { OTP_LIMITS } from "@portifact/contracts";

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
      } catch {
        // The provider error can echo the message, which holds the code. Replace it so nothing
        // downstream logs the code.
        throw new Error("email delivery failed");
      }
    },
  };
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
