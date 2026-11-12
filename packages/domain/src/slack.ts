// Slack connection rules (premium plan T7, decision 0025): the manifest of the app a workspace's
// admin creates in their own Slack workspace, the shapes of what the admin pastes, the events
// endpoint's path, and the checks of an inbound request before and after its signature. Pure: the
// services verify the signature with Web Crypto, read and write the connection, and call Slack.
import { REGIONS, type Region, SLACK_LIMITS, SLACK_MANIFEST_VERSION } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const refuse = (message: string) => fail<never>("invalid_input", message);

/** Where Slack sends a connection's events: one path per connection, under its region. */
export const SLACK_EVENTS_PREFIX = "/integrations/slack/events/";

/** The events endpoint's path for a connection in a region. */
export function slackEventsPath(region: Region, connectionId: string): string {
  return `${SLACK_EVENTS_PREFIX}${region}/${connectionId}`;
}

const EVENTS_PATH = /^\/integrations\/slack\/events\/([a-z]{1,16})\/(ic_[0-9a-f]{32})$/;

/** The region and connection an events path names, or null for any other path. */
export function parseSlackEventsPath(
  pathname: string,
): { region: Region; connectionId: string } | null {
  const match = EVENTS_PATH.exec(pathname);
  const region = match?.[1];
  const connectionId = match?.[2];
  if (!region || !connectionId) return null;
  if (!(REGIONS as readonly string[]).includes(region)) return null;
  return { region: region as Region, connectionId };
}

export interface SlackManifestInput {
  /** The events endpoint's full URL. */
  requestUrl: string;
  /** The deployment's content domain (`portifact.dev`) and app host (`app.portifact.com`). */
  unfurlDomains: readonly string[];
}

/**
 * The manifest of the Slack app an admin creates (decision 0025, "The manifest"): two link
 * scopes, three events, no organization-wide install, no Socket Mode and no token rotation.
 * Built only from the deployment's own URLs; nothing from input.
 */
export function slackManifest(input: SlackManifestInput) {
  return {
    _metadata: { major_version: 2 },
    display_information: { name: "Portifact" },
    features: {
      bot_user: { display_name: "Portifact", always_online: false },
      unfurl_domains: [...input.unfurlDomains],
    },
    oauth_config: { scopes: { bot: ["links:read", "links:write"] } },
    settings: {
      event_subscriptions: {
        request_url: input.requestUrl,
        bot_events: ["link_shared", "app_uninstalled", "tokens_revoked"],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's prefilled "create an app from this manifest" link. */
export function slackCreateUrl(manifest: object): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** Whether a connection completed with `version` runs an older manifest than the one shown. */
export function slackManifestOutdated(version: number | null): boolean {
  return version !== null && version < SLACK_MANIFEST_VERSION;
}

export const SLACK_ROTATING_TOKEN =
  "That token expires: token rotation is on for the app. Create the app from Portifact's manifest, which leaves rotation off, and paste its bot token.";

/**
 * A pasted bot token: `xoxb-` and printable ASCII. A rotating token (`xoxe.`, or its refresh
 * token `xoxe-`) is refused with its own message: it expires in 12 hours and only the app's client
 * secret, which Portifact never holds, refreshes it.
 */
export function checkSlackBotToken(raw: string): Result<string> {
  const token = raw.trim();
  if (token.startsWith("xoxe.") || token.startsWith("xoxe-")) return refuse(SLACK_ROTATING_TOKEN);
  if (!token.startsWith("xoxb-")) {
    return refuse("Paste the app's Bot User OAuth Token, which starts with xoxb-.");
  }
  if (token.length < 20 || token.length > SLACK_LIMITS.tokenMax || !/^[\x21-\x7e]+$/.test(token)) {
    return refuse("That does not look like a bot token.");
  }
  return ok(token);
}

/** A pasted signing secret, as Slack shows it: hexadecimal. */
export function checkSlackSigningSecret(raw: string): Result<string> {
  const secret = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{32,64}$/.test(secret)) {
    return refuse("Paste the app's Signing Secret from Basic Information in Slack.");
  }
  return ok(secret);
}

/** The bot token and the signing secret, sealed together as one value. */
export function slackCredential(botToken: string, signingSecret: string): string {
  return JSON.stringify({ botToken, signingSecret });
}

/** The sealed pair, opened; null when the value is not one. */
export function openSlackCredential(
  raw: string,
): { botToken: string; signingSecret: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { botToken, signingSecret } = parsed as Record<string, unknown>;
    if (typeof botToken !== "string" || typeof signingSecret !== "string") return null;
    if (botToken === "" || signingSecret === "") return null;
    return { botToken, signingSecret };
  } catch {
    return null;
  }
}

/**
 * `X-Slack-Request-Timestamp`, accepted only as decimal digits within five minutes of `now`
 * (milliseconds); null otherwise.
 */
export function slackTimestamp(header: string | null, now: number): string | null {
  if (header === null || !/^[0-9]{1,12}$/.test(header)) return null;
  const skew = Math.abs(now / 1000 - Number(header));
  return skew <= SLACK_LIMITS.timestampSkewSeconds ? header : null;
}

/** The bytes of `X-Slack-Signature` (`v0=` and 64 hexadecimal characters); null otherwise. */
export function slackSignatureBytes(header: string | null): Uint8Array<ArrayBuffer> | null {
  const match = header === null ? null : /^v0=([0-9a-f]{64})$/.exec(header);
  const hex = match?.[1];
  if (!hex) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** What the signature covers: `v0:<timestamp>:<raw body>` (Slack, "Verifying requests"). */
export function slackBaseString(timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/** Slack's `url_verification` challenge, accepted only as 1 to 100 safe characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{1,100}$/;

/** A verified request's envelope, reduced to what Portifact uses. */
export type SlackEnvelope =
  | { kind: "url_verification"; challenge: string | null }
  | {
      kind: "event";
      teamId: string | null;
      /** Every `authorizations` entry is for the same team and not an organization-wide install. */
      authorizationsAgree: boolean;
      eventType: string | null;
    }
  | { kind: "other" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads a verified body's envelope; anything unexpected is `other`, which Portifact ignores. */
export function parseSlackEnvelope(text: string): SlackEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "other" };
  }
  const body = record(json);
  if (!body) return { kind: "other" };
  if (body.type === "url_verification") {
    const challenge = body.challenge;
    return {
      kind: "url_verification",
      challenge: typeof challenge === "string" && CHALLENGE.test(challenge) ? challenge : null,
    };
  }
  if (body.type !== "event_callback") return { kind: "other" };
  const teamId = typeof body.team_id === "string" ? body.team_id : null;
  const authorizations = body.authorizations;
  const authorizationsAgree =
    body.is_enterprise_install !== true &&
    (authorizations === undefined ||
      (Array.isArray(authorizations) &&
        authorizations.every((entry) => {
          const one = record(entry);
          return one !== null && one.team_id === teamId && one.is_enterprise_install === false;
        })));
  const eventType = record(body.event)?.type;
  return {
    kind: "event",
    teamId,
    authorizationsAgree,
    eventType: typeof eventType === "string" ? eventType : null,
  };
}

/** The event comes from the Slack workspace the connection's token belongs to. */
export function slackTeamMatches(
  envelope: Extract<SlackEnvelope, { kind: "event" }>,
  externalId: string | null,
): boolean {
  return (
    externalId !== null &&
    envelope.teamId !== null &&
    envelope.teamId === externalId &&
    envelope.authorizationsAgree
  );
}

/** Slack's `team_id` as `auth.test` answers it: an uppercase ID. */
export const SLACK_TEAM_ID = /^[A-Z0-9]{2,32}$/;

/** Errors of Slack's Web API that mean the token no longer works (decision 0025, "Disabling"). */
export const SLACK_REJECTING_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
]);
