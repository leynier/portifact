// Issue integration rules (premium plan T7, decision 0018): which targets a connection may name,
// which URLs Portifact calls and accepts back, how a call's answer is classified and retried, and
// exactly what an issue created from a comment thread says. Pure: the services seal, call, store.
//
// Comment text is untrusted. It leaves Portifact only as plain text inside a fenced code block
// longer than any run of backticks in it, after control, bidi and invisible characters are
// removed, so no mention, link, image, HTML or heading in it is ever rendered by GitHub or Linear.
import {
  GitHubRepo,
  INTEGRATION_API,
  INTEGRATION_LIMITS,
  INTEGRATION_WEB_HOSTS,
  type IntegrationService,
  type IntegrationTarget,
  type IssueParts,
  type IssueSource,
  LinearTeamId,
  type ThreadIssueFailure,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";
import { viewerPath } from "./viewer.ts";
import { checkPublicHttpsUrl } from "./webhooks.ts";

const refuse = (message: string) => fail<never>("invalid_input", message);

/** Normalizes and checks a connection's targets for its service: `owner/repo` or team IDs. */
export function checkIntegrationTargets(
  service: IntegrationService,
  raw: readonly string[],
): Result<string[]> {
  if (raw.length === 0) return refuse("Choose at least one repository or team.");
  if (raw.length > INTEGRATION_LIMITS.targetsPerConnection) {
    return refuse(
      `A connection can allow at most ${INTEGRATION_LIMITS.targetsPerConnection} repositories or teams.`,
    );
  }
  const out: string[] = [];
  for (const value of raw) {
    const target = value.trim();
    const parsed =
      service === "github" ? GitHubRepo.safeParse(target) : LinearTeamId.safeParse(target);
    if (!parsed.success) {
      return refuse(
        service === "github"
          ? `"${target.slice(0, 140)}" is not a repository. Use owner/repository.`
          : `"${target.slice(0, 140)}" is not a Linear team ID.`,
      );
    }
    // GitHub names are case-insensitive and Linear IDs are UUIDs: compare in lower case.
    const normalized = service === "linear" ? target.toLowerCase() : target;
    if (out.some((seen) => seen.toLowerCase() === normalized.toLowerCase())) {
      return refuse("List each repository or team once.");
    }
    out.push(normalized);
  }
  return ok(out);
}

/** The target of a request, if the connection allows it (case-insensitive for GitHub). */
export function allowedTarget(
  targets: readonly IntegrationTarget[],
  requested: string,
): IntegrationTarget | undefined {
  const wanted = requested.trim().toLowerCase();
  return targets.find((target) => target.id.toLowerCase() === wanted);
}

/**
 * Checks a URL Portifact is about to call: a public HTTPS URL (the same rules as webhooks) whose
 * origin is exactly the service's fixed API origin. Run before every call, even though the URLs
 * are built from constants, so a mistake in building one can never reach another host.
 */
export function checkIntegrationCall(service: IntegrationService, raw: string): Result<URL> {
  const checked = checkPublicHttpsUrl(raw, 2_048);
  if (!checked.ok) return checked;
  const api = new URL(INTEGRATION_API[service]);
  if (checked.value.url.origin !== api.origin) {
    return refuse(`Calls for ${service} go only to ${api.origin}.`);
  }
  return ok(checked.value.url);
}

/**
 * Checks the issue URL a service returned: HTTPS on the service's own web host, with no user,
 * port, query or fragment; on GitHub the path is exactly the issue in the target repository.
 * Returns the URL in canonical form, or a refusal when it is anything else.
 */
export function checkIssueUrl(
  service: IntegrationService,
  raw: unknown,
  /** GitHub: the target repository and the number returned; Linear: the identifier returned. */
  expect: { target: string; number?: number; key?: string },
): Result<string> {
  if (typeof raw !== "string" || raw.length > 2_048) return refuse("No issue URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("The issue URL is not valid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== INTEGRATION_WEB_HOSTS[service] ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return refuse("The issue URL is not on the service's own site.");
  }
  if (service === "github") {
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d{1,12})$/.exec(url.pathname);
    if (
      !match ||
      `${match[1]}/${match[2]}`.toLowerCase() !== expect.target.toLowerCase() ||
      (expect.number !== undefined && Number(match[3]) !== expect.number)
    ) {
      return refuse("The issue URL is not an issue of the chosen repository.");
    }
  } else {
    const match =
      /^\/[A-Za-z0-9_-]{1,100}\/issue\/([A-Za-z0-9-]{1,40})(?:\/[A-Za-z0-9_-]{0,200})?$/.exec(
        url.pathname,
      );
    if (!match || (expect.key !== undefined && match[1] !== expect.key)) {
      return refuse("The issue URL is not the Linear issue that was created.");
    }
  }
  return ok(url.href);
}

/** A GitHub issue number as `#123`, or a Linear identifier such as `ENG-42`. */
export function checkIssueKey(service: IntegrationService, raw: unknown): Result<string> {
  if (service === "github") {
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
      ? ok(`#${raw}`)
      : refuse("No issue number.");
  }
  return typeof raw === "string" && /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/.test(raw)
    ? ok(raw)
    : refuse("No issue identifier.");
}

// Text that leaves Portifact

/**
 * Code points removed from text that leaves Portifact: C0 and C1 controls (the line feed is kept;
 * tabs and other line breaks are turned into spaces and line feeds first), bidi controls,
 * zero-width and other invisible formatting characters, variation selectors and tag characters.
 */
const REMOVED: readonly (readonly [number, number])[] = [
  [0x0000, 0x0009],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe0fff],
];

/** Whether a code point is removed (`REMOVED`). */
export function isRemovedCodePoint(code: number): boolean {
  return REMOVED.some(([from, to]) => code >= from && code <= to);
}

/** Line separators other than the line feed: vertical tab, form feed, NEL, LS and PS. */
const LINE_BREAKS: ReadonlySet<number> = new Set([0x0b, 0x0c, 0x85, 0x2028, 0x2029]);

/** Every line break as a line feed, tabs as two spaces, and the `REMOVED` code points gone. */
function withoutRemoved(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09) out += "  ";
    else if (LINE_BREAKS.has(code)) out += "\n";
    else if (!isRemovedCodePoint(code)) out += ch;
  }
  return out;
}

/**
 * Plain text safe to place in a fenced block: normalized (NFC), line endings unified, tabs turned
 * into spaces, every control, bidi and invisible character removed, at most `max` characters (by
 * code point) with an ellipsis when cut. Whitespace-only text is null.
 */
export function plainText(raw: string, max: number): string | null {
  const cleaned = withoutRemoved(raw.normalize("NFC"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned === "") return null;
  const points = [...cleaned];
  return points.length <= max
    ? cleaned
    : `${points
        .slice(0, max - 1)
        .join("")
        .trimEnd()}${ELLIPSIS}`;
}

const ELLIPSIS = String.fromCodePoint(0x2026);

/** One line of plain text (every line break becomes a space), for titles and names. */
export function plainLine(raw: string, max: number): string | null {
  const text = plainText(withoutRemoved(raw).replace(/\n+/g, " "), max);
  return text === null ? null : text.replace(/\s+/g, " ");
}

/** The longest run of `char` in `text`. */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === char ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Untrusted text as a fenced code block: GitHub and Linear render its content literally, so no
 * mention, issue reference, link, image, HTML or Markdown in it does anything. The fence is longer
 * than any run of backticks inside, so the text can never close it.
 */
export function inertBlock(text: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Untrusted text on one line as a code span, which renders literally too. */
export function inertSpan(text: string): string {
  const ticks = "`".repeat(longestRun(text, "`") + 1);
  // A span whose text starts or ends with a backtick needs a space inside the delimiters.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * The title as sent: one plain line the person wrote, made inert like the other untrusted
 * fields. GitHub renders code spans and issue references in titles, so a backtick becomes a
 * modifier grave accent (U+02CB), `#` before a digit a full-width number sign (U+FF03, which
 * ends `#123` and `owner/repo#1`), `@` before a name character a full-width at sign (U+FF20) and
 * the hyphen of `GH-123` a non-breaking hyphen (U+2011). Linear shows titles as text; the same
 * title goes to both, and the dashboard previews exactly this.
 */
export function issueTitle(raw: string): Result<string> {
  const line = plainLine(raw, INTEGRATION_LIMITS.titleMax);
  if (line === null) return refuse("Write a title.");
  const title = line
    .replaceAll("`", String.fromCodePoint(0x02cb))
    .replace(/#(?=\d)/g, String.fromCodePoint(0xff03))
    .replace(/@(?=[A-Za-z0-9_-])/g, String.fromCodePoint(0xff20))
    .replace(/\b(GH)-(?=\d)/gi, `$1${String.fromCodePoint(0x2011)}`);
  return ok(title);
}

/**
 * The thread in the viewer, built only from IDs and the thread's validated page path: the one
 * link an issue's body holds.
 */
export function threadLink(
  appOrigin: string,
  artifactId: string,
  path: string,
  threadId: string,
): string {
  const page = viewerPath(`/${path}`) ?? "/";
  const query = new URLSearchParams({ path: page, thread: threadId });
  return `${appOrigin}/view/${encodeURIComponent(artifactId)}?${query}`;
}

/** The quoted text of a thread's anchor, when it quotes text; null for elements and documents. */
export function anchorQuote(target: unknown): string | null {
  if (typeof target !== "object" || target === null) return null;
  const anchor = (target as { anchor?: unknown }).anchor;
  if (typeof anchor !== "object" || anchor === null) return null;
  const { kind, quote } = anchor as { kind?: unknown; quote?: { exact?: unknown } };
  return kind === "text" && typeof quote?.exact === "string" ? quote.exact : null;
}

/** The line every issue ends with: how Portifact finds an issue whose creation answer was lost. */
export function issueReferenceLine(reference: string): string {
  return `Sent from Portifact. Reference: ${reference}`;
}

/**
 * The body of an issue created from a thread (decision 0018, "What is sent"): only the parts the
 * person left on, each from Portifact's own data or as inert text. Never reader emails, the
 * artifact's content, review notes or other messages of the thread.
 */
export function issueBody(source: IssueSource, parts: IssueParts): string {
  const sections: string[] = ["A comment thread on Portifact."];
  const facts: string[] = [];
  if (parts.artifactName) {
    const name = plainLine(source.artifactName, 200);
    if (name !== null) facts.push(`Artifact: ${inertSpan(name)}`);
  }
  // Portifact's own URL, built from IDs: the one link in the body.
  if (parts.link) facts.push(`Thread: <${source.link}>`);
  if (facts.length > 0) sections.push(facts.join("\n"));
  if (parts.quote && source.quote !== null) {
    const quote = plainText(source.quote, INTEGRATION_LIMITS.quoteMax);
    if (quote !== null) sections.push(`Quoted text:\n\n${inertBlock(quote)}`);
  }
  if (parts.message && source.message !== null) {
    const message = plainText(source.message, INTEGRATION_LIMITS.messageMax);
    if (message !== null) sections.push(`First message:\n\n${inertBlock(message)}`);
  }
  sections.push(`---\n${issueReferenceLine(source.reference)}`);
  return sections.join("\n\n");
}

// Calls and their answers

/** How one call ended, from the service's answer or the error that stopped it. */
export type IntegrationCallResult =
  | { kind: "status"; status: number; rateLimited?: boolean }
  /** A Linear GraphQL answer whose `errors` name this type. */
  | {
      kind: "graphql";
      type: "authentication" | "forbidden" | "invalid_input" | "rate_limited" | "other";
    }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "redirect" }
  | { kind: "too_large" }
  | { kind: "invalid_response" };

export interface IntegrationVerdict {
  outcome: "ok" | "failed";
  retryable: boolean;
  /** Why it failed, as the person who asked reads it; null on success. */
  failure: ThreadIssueFailure | null;
}

/**
 * Classifies a call: 401 (or Linear's authentication error) means the credential no longer works
 * and is never retried; 403 and 404 mean the target is out of the credential's reach, unless the
 * service said it was a rate limit; 408, 429, 5xx, timeouts and network errors are retried; a
 * redirect, an oversized or unreadable answer and anything else are not.
 */
export function classifyIntegrationCall(result: IntegrationCallResult): IntegrationVerdict {
  const failed = (failure: ThreadIssueFailure, retryable = false): IntegrationVerdict => ({
    outcome: "failed",
    retryable,
    failure,
  });
  switch (result.kind) {
    case "status": {
      const { status } = result;
      if (status >= 200 && status < 300) return { outcome: "ok", retryable: false, failure: null };
      if (result.rateLimited || status === 408 || status === 429 || status >= 500) {
        return failed("service_unavailable", true);
      }
      if (status === 401) return failed("credential_rejected");
      if (status === 403 || status === 404 || status === 410) return failed("target_unreachable");
      return failed("rejected");
    }
    case "graphql":
      if (result.type === "authentication") return failed("credential_rejected");
      if (result.type === "forbidden") return failed("target_unreachable");
      if (result.type === "rate_limited") return failed("service_unavailable", true);
      return failed("rejected");
    case "timeout":
    case "network":
      return failed("service_unavailable", true);
    case "redirect":
    case "too_large":
    case "invalid_response":
      return failed("invalid_response");
  }
}

/** When the next attempt of an issue is due, or null after the last one. */
export function nextIssueAttemptAt(attempt: number, now: number): number | null {
  const delay = INTEGRATION_LIMITS.retryDelaysMs[attempt - 1];
  return delay === undefined ? null : now + delay;
}

/** The last four characters of a credential, which is all Portifact ever shows of it. */
export function credentialHint(credential: string): string {
  return `\u2026${credential.slice(-4)}`;
}

/** Plain words for the person who asked, by failure. English: the CLI, MCP and the API's text. */
export const ISSUE_FAILURE_MESSAGES: Readonly<Record<ThreadIssueFailure, string>> = {
  credential_rejected:
    "The service refused the connection's credential. An admin needs to paste a new one.",
  target_unreachable:
    "The credential cannot create issues there. Check the repository or team and its permissions.",
  rejected: "The service refused the issue.",
  connection_removed: "The connection was removed before the issue was created.",
  unavailable: "Integrations are not available right now.",
  plan_lapsed: "The plan no longer includes integrations.",
  service_unavailable: "The service did not answer after several attempts.",
  invalid_response: "The service answered in a way Portifact could not use.",
  target_removed: "An admin removed that repository or team from the connection.",
  artifact_moved: "The artifact moved to another space before the issue was created.",
  requester_left: "The person who asked can no longer create issues for this space.",
  thread_gone: "The thread was deleted before the issue was created.",
};

/** The most attempts one issue gets: the first and one after each retry delay. */
export const MAX_ISSUE_ATTEMPTS = INTEGRATION_LIMITS.retryDelaysMs.length + 1;
