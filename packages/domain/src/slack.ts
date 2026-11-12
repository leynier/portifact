// Slack connection rules (premium plan T7, decision 0025): the manifest of the app a workspace's
// admin creates in their own Slack workspace, the shapes of what the admin pastes, the events
// endpoint's path, and the checks of an inbound request before and after its signature. Pure: the
// services verify the signature with Web Crypto, read and write the connection, and call Slack.
import {
  type ArtifactType,
  REGIONS,
  type Region,
  SLACK_LIMITS,
  SLACK_MANIFEST_VERSION,
} from "@portifact/contracts";
import { plainLine } from "./integrations.ts";
import { noticeNames } from "./notices.ts";
import { fail, ok, type Result } from "./result.ts";
import { slackEscape } from "./webhooks.ts";

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
      /** `link_shared` only: the posted URLs, as Slack sent them (strings, at most `urlMax`). */
      links: string[];
      /** `link_shared` only: the unfurl's ID and source, when their shape is Slack's. */
      unfurlId: string | null;
      source: SlackUnfurlSource | null;
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
  const event = record(body.event);
  const eventType = typeof event?.type === "string" ? event.type : null;
  const shared = eventType === "link_shared" && event ? sharedLinks(event) : null;
  return {
    kind: "event",
    teamId,
    authorizationsAgree,
    eventType,
    links: shared?.links ?? [],
    unfurlId: shared?.unfurlId ?? null,
    source: shared?.source ?? null,
  };
}

/** Where Slack shows an unfurl: a posted message, or the composer while someone types. */
export type SlackUnfurlSource = "conversations_history" | "composer";
const UNFURL_SOURCES: readonly string[] = ["conversations_history", "composer"];
const UNFURL_ID = /^[A-Za-z0-9._-]{1,255}$/;

/** A `link_shared` event's links, unfurl ID and source, each kept only in its expected shape. */
function sharedLinks(event: Record<string, unknown>) {
  const links: string[] = [];
  if (Array.isArray(event.links)) {
    for (const entry of event.links.slice(0, SLACK_LIMITS.linksScanned)) {
      const url = record(entry)?.url;
      if (typeof url === "string" && url.length <= SLACK_LIMITS.urlMax) links.push(url);
    }
  }
  const unfurlId = typeof event.unfurl_id === "string" ? event.unfurl_id : "";
  const source = typeof event.source === "string" ? event.source : "";
  return {
    links,
    unfurlId: UNFURL_ID.test(unfurlId) ? unfurlId : null,
    source: UNFURL_SOURCES.includes(source) ? (source as SlackUnfurlSource) : null,
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

/** The deployment's hosts a preview recognizes: from configuration, never a constant. */
export interface SlackLinkDomains {
  /** The content domain (`portifact.dev`): artifacts live at `<id>.<content domain>`. */
  contentDomain: string;
  /** The app's host (`app.portifact.com`), as `URL.host` gives it. */
  appHost: string;
}

const ARTIFACT_LABEL = "[a-z2-7]{10}";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** After the host: nothing, or a path, a query or a fragment (never parsed). */
const TAIL = "(?:[/?#][^\\s]*)?";

/**
 * The artifact a posted URL names, or null (decision 0025, "Which links"). Exactly two shapes,
 * matched on the URL as Slack sent it, byte for byte, with no parsing that could normalize it:
 * `https://<id>.<content domain>[:443][/…]` and `https://<app host>[:443]/view/<id>[/…]`. The
 * scheme and host are lowercase, no userinfo, no other port, no encoded or non-ASCII character
 * in the host and no trailing dot; the query and the fragment are never read. Share links
 * (`/s#…`), `/read/<id>`, the dashboard, custom domains and every other host are null.
 */
export function slackArtifactLink(url: string, domains: SlackLinkDomains): string | null {
  if (url.length > SLACK_LIMITS.urlMax || /[^\x21-\x7e]/.test(url)) return null;
  const content = new RegExp(
    `^https://(${ARTIFACT_LABEL})\\.${escapeRegExp(domains.contentDomain)}(?::443)?${TAIL}$`,
  );
  const viewer = new RegExp(
    `^https://${escapeRegExp(domains.appHost)}(?::443)?/view/(${ARTIFACT_LABEL})(?:[/?#][^\\s]*)?$`,
  );
  return content.exec(url)?.[1] ?? viewer.exec(url)?.[1] ?? null;
}

/** A link to preview: the URL exactly as Slack sent it (the unfurl's key) and the artifact. */
export interface SlackLink {
  url: string;
  artifactId: string;
}

/**
 * The links of one event worth looking up: those `slackArtifactLink` accepts, for the first
 * `SLACK_LIMITS.linksPerEvent` distinct artifacts. Every other URL is dropped unread.
 */
export function slackPreviewLinks(urls: readonly string[], domains: SlackLinkDomains): SlackLink[] {
  const ids = new Set<string>();
  const links: SlackLink[] = [];
  const seen = new Set<string>();
  for (const url of urls.slice(0, SLACK_LIMITS.linksScanned)) {
    const artifactId = slackArtifactLink(url, domains);
    if (artifactId === null || seen.has(url)) continue;
    if (!ids.has(artifactId)) {
      if (ids.size >= SLACK_LIMITS.linksPerEvent) continue;
      ids.add(artifactId);
    }
    seen.add(url);
    links.push({ url, artifactId });
  }
  return links;
}

/**
 * Whether `&`, `<` and `>` are escaped in a preview's `plain_text`. Slack documents its escapes
 * for `mrkdwn`; release check 7 shows whether `plain_text` shows them as entities, and this is
 * turned off only after that check (decision 0025, "What it shows").
 */
export const SLACK_PLAIN_TEXT_ESCAPES = true;

/** Text for a `plain_text` object: escaped as Slack's formatting rules ask, or as is. */
export function slackPlainText(text: string, escapes: boolean = SLACK_PLAIN_TEXT_ESCAPES): string {
  return escapes ? slackEscape(text) : text;
}

/**
 * Whether a preview for an owner outside the default region names the artifact. The maintainer's
 * question 2 of decision 0025, assumed yes: Slack is a destination the owner's admin chose. False
 * makes an EU preview `An artifact on Portifact` with the type line, as `noticeDetail` would.
 */
export const SLACK_PREVIEW_NAMES_OUTSIDE_DEFAULT_REGION = true;

export const SLACK_UNNAMED_ARTIFACT = "An artifact on Portifact";

/** The preview's first line: the cleaned, bounded name, `Untitled` when empty. */
export function slackPreviewTitle(
  name: string,
  region: Region,
  namesOutsideDefault: boolean = SLACK_PREVIEW_NAMES_OUTSIDE_DEFAULT_REGION,
): string {
  if (!namesOutsideDefault && !noticeNames(region)) return SLACK_UNNAMED_ARTIFACT;
  return plainLine(name, SLACK_LIMITS.nameMax) ?? "Untitled";
}

/** The preview's second line: one of three fixed English labels. */
export const SLACK_TYPE_LABELS: Record<ArtifactType, string> = {
  site: "Website on Portifact",
  markdown: "Markdown document on Portifact",
  text: "Text document on Portifact",
};

export interface SlackPreviewOptions {
  escapes?: boolean;
  namesOutsideDefault?: boolean;
}

/** The two blocks of one preview: the name, then the type. Nothing else about the artifact. */
export function slackPreviewBlocks(
  artifact: { name: string; type: ArtifactType },
  region: Region,
  options: SlackPreviewOptions = {},
) {
  const title = slackPreviewTitle(artifact.name, region, options.namesOutsideDefault);
  return [
    {
      type: "section",
      text: { type: "plain_text", text: slackPlainText(title, options.escapes), emoji: false },
    },
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: slackPlainText(SLACK_TYPE_LABELS[artifact.type], options.escapes),
          emoji: false,
        },
      ],
    },
  ];
}

/**
 * The body of one `chat.unfurl` call: the event's `unfurl_id` and `source`, and one preview per
 * URL, keyed by the URL exactly as Slack sent it. An object, serialized by the caller with
 * `JSON.stringify`.
 */
export function slackUnfurlBody(
  event: { unfurlId: string; source: SlackUnfurlSource },
  previews: readonly { url: string; name: string; type: ArtifactType }[],
  region: Region,
  options: SlackPreviewOptions = {},
) {
  const unfurls: Record<string, { blocks: ReturnType<typeof slackPreviewBlocks> }> = {};
  for (const preview of previews) {
    Object.defineProperty(unfurls, preview.url, {
      value: { blocks: slackPreviewBlocks(preview, region, options) },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { unfurl_id: event.unfurlId, source: event.source, unfurls };
}
