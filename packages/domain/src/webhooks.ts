// Webhook rules (premium plan P6, decision 0009): which URLs a webhook may point at, which events
// it subscribes to, how an attempt's answer is classified and retried, and what each format's body
// says. Pure: the services seal, sign, send and store.
import {
  WEBHOOK_EVENTS,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  type WebhookDeliveryBody,
  type WebhookEventBody,
  type WebhookEventType,
  type WebhookFormat,
} from "@portifact/contracts";
import { isCloudflareHost } from "./cloudflare-hosts.ts";
import { fail, ok, type Result } from "./result.ts";

/** The bit of each event type in `webhooks.events`. */
export function eventBit(type: WebhookEventType): number {
  return 1 << WEBHOOK_EVENTS.indexOf(type);
}

export function eventsToBits(types: readonly WebhookEventType[]): number {
  return types.reduce((bits, type) => bits | eventBit(type), 0);
}

export function bitsToEvents(bits: number): WebhookEventType[] {
  return WEBHOOK_EVENTS.filter((type) => (bits & eventBit(type)) !== 0);
}

/** Top-level labels and suffixes that never name a public host. */
const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "onion",
  "alt",
  "example",
];

/** Portifact's own hosts, with every subdomain. Cloudflare's are in cloudflare-hosts.ts. */
const PORTIFACT_DOMAINS = ["portifact.com", "portifact.dev", "portifact.test"];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const refuse = (message: string) => fail<never>("invalid_input", message);

/**
 * Validates a webhook URL and returns it in canonical form with its host. Runs at creation and
 * again before every delivery attempt, so a tightened rule also stops stored webhooks.
 */
export function checkWebhookUrl(
  raw: string,
  format: WebhookFormat,
): Result<{ url: string; host: string }> {
  if (raw.length > WEBHOOK_LIMITS.urlMaxLength) {
    return refuse(`The URL can be at most ${WEBHOOK_LIMITS.urlMaxLength} characters.`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse("The URL is not valid.");
  }
  if (url.protocol !== "https:") return refuse("The URL must start with https://.");
  if (url.username !== "" || url.password !== "") {
    return refuse("The URL cannot hold a user name or password.");
  }
  if (url.port !== "") return refuse("The URL must use the standard HTTPS port (443).");
  if (url.hash !== "") return refuse("The URL cannot have a fragment (#).");
  const host = url.hostname;
  if (host.startsWith("[") || host.includes(":")) {
    return refuse("Use a host name, not an IP address.");
  }
  if (host.endsWith(".")) return refuse("The host cannot end with a dot.");
  if (host.length > 253) return refuse("The host name is too long.");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return refuse("The host must be a public DNS name.");
  }
  // The WHATWG parser reads a host whose last label is a number as IPv4 in any notation.
  // A top-level label that does not start with a letter is an address (the parser already
  // turned decimal, hex and octal forms into dotted IPv4), never a public name.
  if (!/^[a-z]/.test(labels.at(-1) ?? "")) return refuse("Use a host name, not an IP address.");
  if (RESERVED_SUFFIXES.some((suffix) => under(host, suffix))) {
    return refuse("The host must be a public DNS name, not a local or reserved one.");
  }
  if (PORTIFACT_DOMAINS.some((domain) => under(host, domain)) || isCloudflareHost(host)) {
    return refuse("Webhooks cannot point at Portifact or Cloudflare service hosts.");
  }
  if (
    format === "slack" &&
    !(host === "hooks.slack.com" && url.pathname.startsWith("/services/"))
  ) {
    return refuse("A Slack webhook URL starts with https://hooks.slack.com/services/.");
  }
  if (
    format === "discord" &&
    !(
      (host === "discord.com" || host === "discordapp.com") &&
      url.pathname.startsWith("/api/webhooks/")
    )
  ) {
    return refuse("A Discord webhook URL starts with https://discord.com/api/webhooks/.");
  }
  return ok({ url: url.href, host });
}

/** How one attempt ended, from the receiver's answer or the error that stopped it. */
export type AttemptResult =
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "network" };

export interface AttemptVerdict {
  outcome: "delivered" | "failed";
  status: number | null;
  error: string | null;
  /** Whether a later attempt may succeed. */
  retryable: boolean;
  /** Whether the receiver said the webhook is gone for good (410). */
  gone: boolean;
}

export function classifyAttempt(result: AttemptResult): AttemptVerdict {
  if (result.kind !== "status") {
    return { outcome: "failed", status: null, error: result.kind, retryable: true, gone: false };
  }
  const { status } = result;
  if (status >= 200 && status < 300) {
    return { outcome: "delivered", status, error: null, retryable: false, gone: false };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "failed", status, error: "redirect", retryable: false, gone: false };
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return { outcome: "failed", status, error: null, retryable, gone: status === 410 };
}

/** When the next attempt runs after attempt `attempt` failed, or null when none is left. */
export function nextAttemptAt(attempt: number, now: number): number | null {
  const delay = WEBHOOK_LIMITS.retryDelaysMs[attempt - 1];
  return delay === undefined ? null : now + delay;
}

/**
 * Failed attempts in a row that disable a webhook: fewer while it is on probation (enabled again
 * after a disable, without a success since).
 */
export function disableThreshold(probation: boolean): number {
  return probation ? WEBHOOK_LIMITS.probationFailures : WEBHOOK_LIMITS.disableAfterFailures;
}

/** Whether `failures` failed attempts in a row disable the webhook. */
export function disablesAfter(failures: number, probation = false): boolean {
  return failures >= disableThreshold(probation);
}

/** Reasons the platform disabled a webhook on its own, which keep it off for a cooldown. */
const AUTOMATIC_DISABLES = new Set(["failures", "gone"]);

/**
 * Whether a disabled webhook may be enabled again now: not within `reenableCooldownMs` of an
 * automatic disable, and at most `reenablesPerDay` times a UTC day. `reenablesToday` is the
 * count already used today.
 */
export function checkReenable(input: {
  disabledReason: string | null;
  disabledAt: number | null;
  reenablesToday: number;
  now: number;
}): Result<true> {
  if (
    input.disabledReason !== null &&
    AUTOMATIC_DISABLES.has(input.disabledReason) &&
    input.disabledAt !== null &&
    input.now < input.disabledAt + WEBHOOK_LIMITS.reenableCooldownMs
  ) {
    const at = new Date(input.disabledAt + WEBHOOK_LIMITS.reenableCooldownMs).toISOString();
    return fail(
      "rate_limited",
      `This webhook was disabled after failing; it can be enabled again from ${at}. Fix the receiver first.`,
    );
  }
  if (input.reenablesToday >= WEBHOOK_LIMITS.reenablesPerDay) {
    return fail(
      "rate_limited",
      `A webhook can be enabled again at most ${WEBHOOK_LIMITS.reenablesPerDay} times a day.`,
    );
  }
  return ok(true);
}

const DAY_MS = 86_400_000;

/** The start of the UTC day of `now`, from which the daily attempt cap counts. */
export function utcDayStart(now: number): number {
  return now - (now % DAY_MS);
}

export function dailyCapReached(attemptsToday: number): boolean {
  return attemptsToday >= WEBHOOK_LIMITS.attemptsPerOwnerPerDay;
}

/** The Standard Webhooks signed content: `<id>.<timestamp>.<body>`. */
export function signedContent(id: string, timestampSeconds: number, body: string): string {
  return `${id}.${timestampSeconds}.${body}`;
}

/** One line per event for the chat formats, in English (decision 0009). */
function eventLine(event: WebhookEventBody, link: (name: string, url: string) => string): string {
  const on = event.artifact ? ` ${link(event.artifact.name, event.artifact.viewUrl)}` : "";
  const n = event.count;
  switch (event.type) {
    case "comment.created":
      return `${n === 1 ? "1 new comment" : `${n} new comments`} on${on}`;
    case "thread.resolved":
      return `${n === 1 ? "1 thread resolved" : `${n} threads resolved`} on${on}`;
    case "artifact.published":
      return `New version${event.version === undefined ? "" : ` ${event.version}`} of${on}`;
    case "artifact.expiring":
      return `${on.trim()} expires ${event.expiresAt?.slice(0, 10) ?? "soon"}`;
    case "artifact.access_changed":
      return `Access to${on} changed${event.access ? ` (now ${event.access})` : ""}`;
    case WEBHOOK_TEST_EVENT:
      return "Test event from Portifact: this webhook works.";
  }
}

/** Removes control characters and caps a name before it goes into a chat message. */
function plainName(name: string): string {
  const clean = [...name]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      const control =
        code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
      return control ? " " : char;
    })
    .join("")
    .trim();
  return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean || "Untitled";
}

/** Slack mrkdwn: `&`, `<` and `>` are the only control characters; escaping them stops links and mentions. */
export function slackEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Discord Markdown: backslash every character that formats, links or mentions. */
export function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#@:<!-]/g, (char) => `\\${char}`);
}

function lines(
  body: WebhookDeliveryBody,
  link: (name: string, url: string) => string,
  max: number,
) {
  const all = body.events.map((event) => eventLine(event, link));
  const kept: string[] = [];
  let size = 0;
  for (const line of all) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length < all.length) kept.push(`and ${all.length - kept.length} more`);
  return kept.join("\n");
}

const SLACK_MAX = 3_000;
const DISCORD_MAX = 1_900;

/** The request body a format sends for a delivery. */
export function renderDelivery(format: WebhookFormat, body: WebhookDeliveryBody): string {
  switch (format) {
    case "generic":
      return JSON.stringify(body);
    case "slack":
      return JSON.stringify({
        text: lines(
          body,
          (name, url) => `<${slackEscape(url)}|${slackEscape(plainName(name))}>`,
          SLACK_MAX,
        ),
      });
    case "discord":
      return JSON.stringify({
        content: lines(
          body,
          (name, url) => `${discordEscape(plainName(name))} (<${url}>)`,
          DISCORD_MAX,
        ),
        allowed_mentions: { parse: [] },
      });
  }
}
