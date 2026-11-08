// The sign-in code email. The code is the whole point, so it comes first, large and in one
// piece; the expiry and the "you can ignore this" line follow. The code never goes in the subject
// or the preview text, which lock screens and notifications show.
import { renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface SignInCodeInput {
  /** The address the code was requested for, shown so the reader knows which account. */
  email: string;
  code: string;
  expiresInMinutes: number;
}

export const SIGN_IN_SUBJECT = "Your Portifact sign-in code";

export function signInCodeEmail(input: SignInCodeInput): EmailContent {
  const minutes = `${input.expiresInMinutes} minute${input.expiresInMinutes === 1 ? "" : "s"}`;
  const expiry = `It expires in ${minutes} and works once.`;
  const share = "Never share this code. Portifact will never ask you for it.";
  const ignore =
    "If you did not try to sign in, you can ignore this email. Nobody can sign in without the code.";
  const reason =
    "You received this email because someone asked to sign in to Portifact with this address.";

  const html = renderEmail({
    title: SIGN_IN_SUBJECT,
    preheader: `Enter it on the sign-in page. ${expiry}`,
    heading: "Your sign-in code",
    blocks: [
      {
        kind: "paragraph",
        content: [
          "Enter this code on the sign-in page to continue as ",
          { strong: input.email },
          ".",
        ],
      },
      { kind: "code", label: "Sign-in code", value: input.code },
      { kind: "paragraph", content: [`${expiry} ${share}`] },
      { kind: "divider" },
      { kind: "paragraph", content: [ignore], muted: true },
    ],
    footer: reason,
  });

  const text = [
    SIGN_IN_SUBJECT,
    "",
    input.code,
    "",
    `Enter this code on the sign-in page to continue as ${input.email}.`,
    `${expiry} ${share}`,
    "",
    ignore,
    "",
    reason,
    "Portifact, https://portifact.com",
  ].join("\n");

  return { subject: SIGN_IN_SUBJECT, text, html };
}
