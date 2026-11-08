// Email delivery shapes: the suppression reasons Portifact records and the Cloudflare Email
// Service events (`message.bounced`, `message.complained`) the jobs Worker consumes from the
// `portifact-email-events` queue (docs/releasing.md). Events come from Cloudflare, but they are
// still validated: only the fields Portifact acts on are required, the rest pass through.
import { z } from "zod";

export * from "./email-delivery.ts";

/**
 * Why an address is suppressed: a hard bounce or a spam complaint reported by an Email Service
 * event, or `provider` when Email Service refused a send because its own suppression list
 * already holds the address.
 */
export const EmailSuppressionReason = z.enum(["hard_bounce", "complaint", "provider"]);
export type EmailSuppressionReason = z.infer<typeof EmailSuppressionReason>;

/** One Email Sending event as Cloudflare publishes it to a queue subscription. */
export const EmailSendingEvent = z.looseObject({
  type: z.string().min(1).max(200),
  payload: z.looseObject({
    eventId: z.string().max(200).optional(),
    recipient: z.string().min(3).max(320),
    bounce: z.looseObject({ type: z.string().max(50).optional() }).optional(),
  }),
});
export type EmailSendingEvent = z.infer<typeof EmailSendingEvent>;
