// Calls to Slack's Web API (decision 0025, "Calls to Slack"): only `https://slack.com/api/` and
// only the methods `checkIntegrationCall` allows, checked again right before each call, `POST`
// with the bot token as a bearer, `redirect: "manual"` (a 3xx is a failure), a 5-second timeout
// and at most 16 KiB of the answer read, parsed only for the few fields used. Never retried. The
// app Worker makes these calls; the jobs Worker never calls Slack. Tokens and answers are never
// logged.
import { INTEGRATION_API, SLACK_LIMITS } from "@portifact/contracts";
import {
  checkIntegrationCall,
  plainLine,
  SLACK_REJECTING_ERRORS,
  SLACK_TEAM_ID,
} from "@portifact/domain";
import { type IntegrationFetch, readBounded } from "./integration-clients.ts";

export interface SlackCallOptions {
  fetch: IntegrationFetch;
  timeoutMs?: number | undefined;
}

/** What a call to Slack came to, as the callers act on it. */
export type SlackAnswer =
  | { kind: "ok"; json: Record<string, unknown> }
  /** Slack refused the token: it is revoked, expired or wrong. */
  | { kind: "rejected" }
  | { kind: "rate_limited" }
  /** Any other `ok: false`, a timeout, a redirect, a non-JSON or oversized answer, a 5xx. */
  | { kind: "failed" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One call to a Web API method with a bot token. */
export async function slackCall(
  method: "auth.test" | "auth.revoke",
  token: string,
  body: Record<string, unknown>,
  options: SlackCallOptions,
): Promise<SlackAnswer> {
  const checked = checkIntegrationCall("slack", `${INTEGRATION_API.slack}/api/${method}`);
  if (!checked.ok) return { kind: "failed" };
  const signal = AbortSignal.timeout(options.timeoutMs ?? SLACK_LIMITS.timeoutMs);
  let response: Response;
  try {
    response = await options.fetch(checked.value.href, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": "Portifact-Integrations/1 (+https://portifact.com)",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    return { kind: "rate_limited" };
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    return { kind: "failed" };
  }
  let text: string | null;
  try {
    text = await readBounded(response, SLACK_LIMITS.responseReadBytes, signal);
  } catch {
    return { kind: "failed" };
  }
  if (text === null) return { kind: "failed" };
  let json: Record<string, unknown> | null;
  try {
    json = record(JSON.parse(text));
  } catch {
    return { kind: "failed" };
  }
  if (!json) return { kind: "failed" };
  if (json.ok === true) return { kind: "ok", json };
  const error = typeof json.error === "string" ? json.error : "";
  if (error === "ratelimited") return { kind: "rate_limited" };
  return SLACK_REJECTING_ERRORS.has(error) ? { kind: "rejected" } : { kind: "failed" };
}

/** Who a bot token acts for, from `auth.test`. */
export type SlackIdentity =
  | { ok: true; team: string; teamId: string }
  | {
      ok: false;
      problem: "credential_rejected" | "not_bot" | "rate_limited" | "service_unavailable";
    };

/**
 * Checks a bot token with `auth.test`: Slack must answer `ok: true` with a `bot_id` (a user
 * token is refused) and the Slack workspace's `team_id` and name.
 */
export async function slackAuthTest(
  token: string,
  options: SlackCallOptions,
): Promise<SlackIdentity> {
  const answer = await slackCall("auth.test", token, {}, options);
  if (answer.kind === "rejected") return { ok: false, problem: "credential_rejected" };
  if (answer.kind === "rate_limited") return { ok: false, problem: "rate_limited" };
  if (answer.kind === "failed") return { ok: false, problem: "service_unavailable" };
  const { bot_id: botId, team_id: teamId, team } = answer.json;
  if (typeof botId !== "string" || botId === "") return { ok: false, problem: "not_bot" };
  if (typeof teamId !== "string" || !SLACK_TEAM_ID.test(teamId)) {
    return { ok: false, problem: "service_unavailable" };
  }
  const name = typeof team === "string" ? plainLine(team, 100) : null;
  return { ok: true, team: name ?? teamId, teamId };
}

/** Revokes a bot token at Slack (`auth.revoke`): the bot user is deactivated, the app stays. */
export async function slackRevoke(token: string, options: SlackCallOptions): Promise<SlackAnswer> {
  return slackCall("auth.revoke", token, {}, options);
}
