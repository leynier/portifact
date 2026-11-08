// Schemas of the human check (docs/security.md, "Human check"). The constants live in
// human-check.ts, which the auth pages import without the schemas.
import { z } from "zod";
import { TURNSTILE_TOKEN_MAX_LENGTH } from "./human-check.ts";

export * from "./human-check.ts";

/** A Turnstile response token, as the widget hands it to the page. Opaque; never logged. */
export const TurnstileToken = z.string().min(1).max(TURNSTILE_TOKEN_MAX_LENGTH);
export type TurnstileToken = z.infer<typeof TurnstileToken>;

/** What the login page sends to `POST /api/auth/verify-human` before a sign-in. */
export const HumanCheckInput = z.strictObject({ token: TurnstileToken });
export type HumanCheckInput = z.infer<typeof HumanCheckInput>;
