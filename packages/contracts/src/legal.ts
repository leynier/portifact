// The legal texts on portifact.com (/terms, /privacy, /acceptable-use, /dpa) and the acceptance every
// account records at sign-up. See docs/legal.md.
import { z } from "zod";
import { TERMS_VERSION } from "./terms-version.ts";

export * from "./terms-version.ts";

/** What the login page sends when the user accepts the terms and confirms their age. */
export const TermsAcceptanceInput = z.strictObject({
  version: z.literal(TERMS_VERSION),
  acceptTerms: z.literal(true),
  confirmAdult: z.literal(true),
});
export type TermsAcceptanceInput = z.infer<typeof TermsAcceptanceInput>;
