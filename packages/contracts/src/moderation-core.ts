// The moderation shapes other contract modules share (branding, the account), kept apart from
// moderation.ts so they import no module that imports them back.
import { z } from "zod";

/** Categories of the Acceptable Use Policy, used by reports and by suspensions. */
export const AbuseReason = z.enum([
  "phishing",
  "malware",
  "sexual_content",
  "child_safety",
  "copyright",
  "impersonation",
  "harassment",
  "private_information",
  "spam",
  "other",
]);
export type AbuseReason = z.infer<typeof AbuseReason>;

/** Whether a restriction followed a notice (a report or an email) or the operator's own review. */
export const DecisionSource = z.enum(["notice", "review"]);
export type DecisionSource = z.infer<typeof DecisionSource>;

/** The statement of reasons the managers of a suspended artifact see next to the category. */
export const SuspensionStatement = z.object({
  facts: z.string(),
  ground: z.string(),
  source: DecisionSource,
  decidedAt: z.iso.datetime(),
});
export type SuspensionStatement = z.infer<typeof SuspensionStatement>;
