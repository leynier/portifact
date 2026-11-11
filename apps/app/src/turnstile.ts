// Server-side verification of Cloudflare Turnstile tokens (docs/security.md, "Human check").
// Account creation and an account's first comments on other people's artifacts need one. The
// secret is `TURNSTILE_SECRET_KEY`; without it every check fails closed, so a deployment that
// lacks it refuses new accounts and those comments instead of letting them through. Tests and
// local development use Cloudflare's documented test keys and a fake siteverify transport.

import type { HumanVerdict } from "@portifact/domain";
import { logEvent } from "@portifact/domain";
import type { HumanCheck } from "@portifact/services";
import type { FetchLike } from "./auth/deps.ts";
import type { Env } from "./env.ts";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Siteverify answers in well under a second; past this the check counts as unavailable. */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

/** Error codes that mean the secret is wrong, not the visitor: an operator problem. */
const CONFIGURATION_ERRORS = new Set(["missing-input-secret", "invalid-input-secret"]);

export interface TurnstileVerification {
  /** `TURNSTILE_SECRET_KEY`, absent when the deployment lacks it. */
  secret: string | undefined;
  token: string;
  /** The visitor's IP (`CF-Connecting-IP`), which siteverify checks against the solve. */
  remoteIp: string | undefined;
  fetch: FetchLike;
}

/**
 * Asks siteverify about one token. Tokens are single use, so a replayed token fails. Network
 * errors, timeouts, provider errors and a missing or rejected secret are `unavailable`, never
 * `passed`. Neither the token nor the secret is ever logged.
 */
export async function verifyTurnstile(input: TurnstileVerification): Promise<HumanVerdict> {
  if (!input.secret) {
    logEvent("error", "turnstile_secret_missing");
    return "unavailable";
  }
  const form = new FormData();
  form.set("secret", input.secret);
  form.set("response", input.token);
  if (input.remoteIp) form.set("remoteip", input.remoteIp);
  let body: unknown;
  try {
    const response = await input.fetch(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    body = await response.json();
  } catch {
    return "unavailable";
  }
  if (typeof body !== "object" || body === null) return "unavailable";
  const result = body as { success?: unknown; "error-codes"?: unknown };
  if (result.success === true) return "passed";
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
  if (codes.some((code) => CONFIGURATION_ERRORS.has(code))) {
    logEvent("error", "turnstile_secret_rejected");
    return "unavailable";
  }
  if (codes.includes("internal-error")) return "unavailable";
  return "failed";
}

/** The human check of one request: the token it carries, verified for its sender's IP. */
export function humanCheck(
  env: Pick<Env, "TURNSTILE_SECRET_KEY">,
  fetch: FetchLike,
  request: Request,
  token: string | undefined,
): HumanCheck {
  return {
    token,
    verify: (value) =>
      verifyTurnstile({
        secret: env.TURNSTILE_SECRET_KEY,
        token: value,
        remoteIp: request.headers.get("cf-connecting-ip") ?? undefined,
        fetch,
      }),
  };
}
