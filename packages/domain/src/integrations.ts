// Issue integration rules (premium plan T7, decision 0018): which targets a connection may name,
// which URLs Portifact calls and accepts back, how a call's answer is classified and retried, and
// exactly what an issue created from a comment thread says. Pure: the services seal, call, store.
//
// Comment text is untrusted. It leaves Portifact only as plain text: for GitHub and Linear inside
// a fenced code block longer than any run of backticks in it, for Jira as the only text of an
// Atlassian Document Format `codeBlock` (which allows no marks), after control, bidi and invisible
// characters are removed, so no mention, link, image, HTML, heading or macro in it is ever
// rendered by the service.
import {
  GitHubRepo,
  INTEGRATION_API,
  INTEGRATION_LIMITS,
  INTEGRATION_WEB_HOSTS,
  type IntegrationService,
  type IntegrationTarget,
  type IssueParts,
  type IssueSource,
  JiraCloudId,
  JiraProjectKey,
  JiraSiteName,
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
  if (raw.length === 0) return refuse("Choose at least one repository, team or project.");
  if (raw.length > INTEGRATION_LIMITS.targetsPerConnection) {
    return refuse(
      `A connection can allow at most ${INTEGRATION_LIMITS.targetsPerConnection} repositories, teams or projects.`,
    );
  }
  const out: string[] = [];
  for (const value of raw) {
    // Jira project keys are upper case; one typed in lower case means the same project.
    const target = service === "jira" ? value.trim().toUpperCase() : value.trim();
    const parsed =
      service === "github"
        ? GitHubRepo.safeParse(target)
        : service === "linear"
          ? LinearTeamId.safeParse(target)
          : JiraProjectKey.safeParse(target);
    if (!parsed.success) {
      return refuse(
        service === "github"
          ? `"${target.slice(0, 140)}" is not a repository. Use owner/repository.`
          : service === "linear"
            ? `"${target.slice(0, 140)}" is not a Linear team ID.`
            : `"${target.slice(0, 140)}" is not a Jira project key.`,
      );
    }
    // GitHub names are case-insensitive and Linear IDs are UUIDs: compare in lower case.
    const normalized = service === "linear" ? target.toLowerCase() : target;
    if (out.some((seen) => seen.toLowerCase() === normalized.toLowerCase())) {
      return refuse("List each repository, team or project once.");
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

/** The path of a Jira call on Atlassian's gateway: one site's REST API version 3. */
const JIRA_API_PATH =
  /^\/ex\/jira\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/rest\/api\/3\/[A-Za-z0-9_/-]+$/;

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
  // Atlassian's gateway serves every product: a Jira call names one site by its cloud ID and only
  // Jira's REST API version 3 under it.
  if (service === "jira" && !JIRA_API_PATH.test(checked.value.url.pathname)) {
    return refuse("Calls for jira go only to a site's Jira REST API on the Atlassian gateway.");
  }
  return ok(checked.value.url);
}

// Jira Cloud (decision 0018, "Jira")

/** Where a Jira connection's calls go and its links point: the site and its cloud ID. */
export interface JiraSite {
  /** `acme` for `acme.atlassian.net`. */
  name: string;
  cloudId: string;
}

/**
 * The site name an admin typed, as `acme`, `acme.atlassian.net` or a URL on it (a link copied from
 * the browser); only `*.atlassian.net` sites with one label before the suffix. Never called.
 */
export function jiraSiteName(raw: string): Result<string> {
  let text = raw.trim().toLowerCase();
  if (/^https?:\/\//.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return refuse("That is not a Jira site. Use its name, such as acme.atlassian.net.");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return refuse("That is not a Jira site. Use its name, such as acme.atlassian.net.");
    }
    text = url.hostname;
  }
  const suffix = `.${INTEGRATION_WEB_HOSTS.jira}`;
  const name = text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
  const parsed = JiraSiteName.safeParse(name);
  return parsed.success
    ? ok(parsed.data)
    : refuse("That is not a Jira Cloud site. Use its name, such as acme.atlassian.net.");
}

/** A cloud ID as the gateway takes it, in lower case. */
export function jiraCloudId(raw: string): Result<string> {
  const parsed = JiraCloudId.safeParse(raw.trim().toLowerCase());
  return parsed.success ? ok(parsed.data) : refuse("That is not an Atlassian cloud ID.");
}

/**
 * Whether the `baseUrl` Jira's `serverInfo` reported for a cloud ID is exactly the named site:
 * the proof that the links Portifact builds point at the Jira the calls go to.
 */
export function jiraBaseUrlIsSite(baseUrl: unknown, site: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length > 300) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === `${site}.${INTEGRATION_WEB_HOSTS.jira}` &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * A Jira REST call on the gateway: `/ex/jira/<cloudId>/rest/api/3/<path>`. `path` is built by the
 * services from constants and validated keys; each segment is encoded again here.
 */
export function jiraApiUrl(cloudId: string, path: string, query?: URLSearchParams): string {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  const search = query && [...query].length > 0 ? `?${query}` : "";
  return `${INTEGRATION_API.jira}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/${segments}${search}`;
}

/** The browse link of a Jira issue: built from the confirmed site and the validated key. */
export function jiraIssueUrl(site: string, key: string): string {
  return `https://${site}.${INTEGRATION_WEB_HOSTS.jira}/browse/${key}`;
}

/**
 * A JQL string literal: double quotes around the value, with backslashes and double quotes
 * escaped, and refused when it holds a control character or is longer than 200 characters. The
 * only way a value enters a JQL query Portifact sends.
 */
export function jqlString(value: string): Result<string> {
  const control = [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (value.length > 200 || control) {
    return refuse("That value cannot go into a Jira search.");
  }
  return ok(`"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`);
}

/**
 * The search that finds an issue an earlier attempt created whose answer was lost (decision 0018,
 * "Jira"): issues of the project created by the connection's own account (`creator`, which nobody
 * can change, unlike the reporter) in the last day, newest first. The caller reads at most
 * `recentIssuesChecked` of them and matches the reference line in their description.
 */
export function jiraFindJql(project: string): Result<string> {
  const key = JiraProjectKey.safeParse(project);
  if (!key.success) return refuse("That is not a Jira project key.");
  const literal = jqlString(key.data);
  if (!literal.ok) return literal;
  return ok(
    `project = ${literal.value} AND creator = currentUser() AND created >= -1d ORDER BY created DESC`,
  );
}

/**
 * A Jira timestamp (`2026-11-08T12:00:00.000+0000`, an offset without a colon) as epoch
 * milliseconds, or null when it is anything else.
 */
export function jiraTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:?\d{2})$/.exec(
    raw,
  );
  if (!match) return null;
  const zone = match[2] === "Z" ? "Z" : (match[2] ?? "").replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const at = Date.parse(`${match[1]}${zone}`);
  return Number.isNaN(at) ? null : at;
}

/**
 * The issue type Portifact creates in a Jira project, from the types `GET project/{key}` lists:
 * `Task` when the project has it, otherwise its first standard type (not a subtask, hierarchy
 * level 0). Null when it has none: Portifact cannot create an issue there.
 */
export function jiraIssueType(types: unknown): string | null {
  if (!Array.isArray(types)) return null;
  const standard = types.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { id, name, subtask, hierarchyLevel } = item as Record<string, unknown>;
    return typeof id === "string" &&
      /^\d{1,18}$/.test(id) &&
      subtask !== true &&
      (hierarchyLevel === undefined || hierarchyLevel === 0)
      ? [{ id, name: typeof name === "string" ? name : "" }]
      : [];
  });
  return (standard.find((type) => type.name === "Task") ?? standard[0])?.id ?? null;
}

/**
 * The sealed form of a Jira credential: the Atlassian account's email and its API token together,
 * so the email is never stored, shown or logged in the clear.
 */
export function jiraCredential(account: string, token: string): string {
  return JSON.stringify({ account, token });
}

/** The account and token of a sealed Jira credential, or null when it does not read as one. */
export function openJiraCredential(raw: string): { account: string; token: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { account, token } = parsed as { account?: unknown; token?: unknown };
    return typeof account === "string" && typeof token === "string" ? { account, token } : null;
  } catch {
    return null;
  }
}

/**
 * Checks the issue URL a service returned: HTTPS on the service's own web host, with no user,
 * port, query or fragment; on GitHub the path is exactly the issue in the target repository.
 * Returns the URL in canonical form, or a refusal when it is anything else.
 */
export function checkIssueUrl(
  service: IntegrationService,
  raw: unknown,
  /**
   * GitHub: the target repository and the number returned; Linear: the identifier returned; Jira:
   * the project, the key returned and the site.
   */
  expect: { target: string; number?: number; key?: string; site?: string },
): Result<string> {
  if (typeof raw !== "string" || raw.length > 2_048) return refuse("No issue URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("The issue URL is not valid.");
  }
  const host =
    service === "jira"
      ? `${expect.site ?? ""}.${INTEGRATION_WEB_HOSTS.jira}`
      : INTEGRATION_WEB_HOSTS[service];
  if (
    (service === "jira" && !JiraSiteName.safeParse(expect.site).success) ||
    url.protocol !== "https:" ||
    url.hostname !== host ||
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
  } else if (service === "linear") {
    const match =
      /^\/[A-Za-z0-9_-]{1,100}\/issue\/([A-Za-z0-9-]{1,40})(?:\/[A-Za-z0-9_-]{0,200})?$/.exec(
        url.pathname,
      );
    if (!match || (expect.key !== undefined && match[1] !== expect.key)) {
      return refuse("The issue URL is not the Linear issue that was created.");
    }
  } else {
    const match = /^\/browse\/([A-Z][A-Z0-9_]{1,9})-(\d{1,9})$/.exec(url.pathname);
    if (
      !match ||
      match[1] !== expect.target ||
      (expect.key !== undefined && `${match[1]}-${match[2]}` !== expect.key)
    ) {
      return refuse("The issue URL is not the Jira issue that was created.");
    }
  }
  return ok(url.href);
}

/**
 * A GitHub issue number as `#123`, a Linear identifier such as `ENG-42`, or a Jira key in the
 * target project (`project`), such as `ENG-42`.
 */
export function checkIssueKey(
  service: IntegrationService,
  raw: unknown,
  project?: string,
): Result<string> {
  if (service === "github") {
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
      ? ok(`#${raw}`)
      : refuse("No issue number.");
  }
  if (service === "jira") {
    const match = typeof raw === "string" ? /^([A-Z][A-Z0-9_]{1,9})-\d{1,9}$/.exec(raw) : null;
    return match && match[1] === project ? ok(match[0]) : refuse("No issue key in the project.");
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
 * One part of what an issue says, in order. Decided once by `issueSections` from the parts the
 * person left on; `issueBody` writes them as Markdown and `issueDocument` as Atlassian Document
 * Format, so the two formats can never say different things.
 */
export type IssueSection =
  | { kind: "intro"; text: string }
  /** The artifact's name, plain, on one line: always written as inline code. */
  | { kind: "artifact"; name: string }
  /** Portifact's own URL to the thread, built from IDs: the one link an issue holds. */
  | { kind: "link"; href: string }
  /** Untrusted text: always written as a code block. */
  | { kind: "quote"; text: string }
  | { kind: "message"; text: string }
  | { kind: "reference"; text: string };

/**
 * What an issue created from a thread says (decision 0018, "What is sent"): only the parts the
 * person left on, each from Portifact's own data or as plain text. Never reader emails, the
 * artifact's content, review notes or other messages of the thread.
 */
export function issueSections(source: IssueSource, parts: IssueParts): IssueSection[] {
  const sections: IssueSection[] = [{ kind: "intro", text: "A comment thread on Portifact." }];
  if (parts.artifactName) {
    const name = plainLine(source.artifactName, 200);
    if (name !== null) sections.push({ kind: "artifact", name });
  }
  if (parts.link) sections.push({ kind: "link", href: source.link });
  if (parts.quote && source.quote !== null) {
    const quote = plainText(source.quote, INTEGRATION_LIMITS.quoteMax);
    if (quote !== null) sections.push({ kind: "quote", text: quote });
  }
  if (parts.message && source.message !== null) {
    const message = plainText(source.message, INTEGRATION_LIMITS.messageMax);
    if (message !== null) sections.push({ kind: "message", text: message });
  }
  sections.push({ kind: "reference", text: issueReferenceLine(source.reference) });
  return sections;
}

/**
 * The Markdown body of an issue for GitHub and Linear: `issueSections`, with the artifact's name
 * in a code span and comment text in fenced code blocks, which both render literally.
 */
export function issueBody(source: IssueSource, parts: IssueParts): string {
  const out: string[] = [];
  const facts: string[] = [];
  const flushFacts = () => {
    if (facts.length > 0) out.push(facts.splice(0).join("\n"));
  };
  for (const section of issueSections(source, parts)) {
    if (section.kind === "artifact") facts.push(`Artifact: ${inertSpan(section.name)}`);
    else if (section.kind === "link") facts.push(`Thread: <${section.href}>`);
    else {
      flushFacts();
      if (section.kind === "intro") out.push(section.text);
      else if (section.kind === "quote") out.push(`Quoted text:\n\n${inertBlock(section.text)}`);
      else if (section.kind === "message") {
        out.push(`First message:\n\n${inertBlock(section.text)}`);
      } else out.push(`---\n${section.text}`);
    }
  }
  flushFacts();
  return out.join("\n\n");
}

/** A text node of an Atlassian document: only the two marks Portifact writes. */
export interface AdfText {
  type: "text";
  text: string;
  marks?: ({ type: "code" } | { type: "link"; attrs: { href: string } })[];
}

export type AdfBlock =
  | { type: "paragraph"; content: AdfText[] }
  | { type: "codeBlock"; attrs: { language: "text" }; content: [AdfText] }
  | { type: "rule" };

/** An Atlassian Document Format document, as Jira's `description` takes it. */
export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfBlock[];
}

const paragraph = (...content: AdfText[]): AdfBlock => ({ type: "paragraph", content });
const text = (value: string): AdfText => ({ type: "text", text: value });

/**
 * The Jira description of an issue, as Atlassian Document Format: `issueSections` built only from
 * paragraphs of plain text nodes, one `code` mark (the artifact's name), one `link` mark
 * (Portifact's own URL to the thread), code blocks and a rule. Comment text is the only text of a
 * `codeBlock`, which takes no marks, so nothing in it can become a link, mention, media, smart
 * card, macro or formatting: Jira draws it literally. No other node type is ever written.
 */
export function issueDocument(source: IssueSource, parts: IssueParts): AdfDocument {
  const content: AdfBlock[] = [];
  const codeBlock = (value: string): AdfBlock => ({
    type: "codeBlock",
    attrs: { language: "text" },
    content: [text(value)],
  });
  for (const section of issueSections(source, parts)) {
    switch (section.kind) {
      case "intro":
        content.push(paragraph(text(section.text)));
        break;
      case "artifact":
        content.push(
          paragraph(text("Artifact: "), { ...text(section.name), marks: [{ type: "code" }] }),
        );
        break;
      case "link":
        content.push(
          paragraph(text("Thread: "), {
            ...text(section.href),
            marks: [{ type: "link", attrs: { href: section.href } }],
          }),
        );
        break;
      case "quote":
        content.push(paragraph(text("Quoted text:")), codeBlock(section.text));
        break;
      case "message":
        content.push(paragraph(text("First message:")), codeBlock(section.text));
        break;
      case "reference":
        content.push({ type: "rule" }, paragraph(text(section.text)));
        break;
    }
  }
  return { version: 1, type: "doc", content };
}

/**
 * A Jira description as the dashboard previews it: each block's text, code blocks between lines
 * of backticks and the rule as `---`. Made from `issueDocument`'s output, so it shows what is sent.
 */
export function issueDocumentText(document: AdfDocument): string {
  return document.content
    .map((block) => {
      if (block.type === "rule") return "---";
      const value = block.content.map((node) => node.text).join("");
      return block.type === "codeBlock" ? `\`\`\`\n${value}\n\`\`\`` : value;
    })
    .join("\n\n");
}

/** All the text of an Atlassian document, for finding the reference line in an issue Jira lists. */
export function adfPlainText(node: unknown, budget = 200_000): string {
  const out: string[] = [];
  let left = budget;
  const walk = (value: unknown, depth: number) => {
    if (left <= 0 || depth > 32 || typeof value !== "object" || value === null) return;
    const { text: own, content } = value as { text?: unknown; content?: unknown };
    if (typeof own === "string") {
      out.push(own.slice(0, left));
      left -= own.length;
    }
    if (Array.isArray(content)) for (const child of content) walk(child, depth + 1);
  };
  walk(node, 0);
  return out.join("\n");
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
    "The credential cannot create issues there. Check the repository, team or project and its permissions.",
  rejected: "The service refused the issue.",
  connection_removed: "The connection was removed before the issue was created.",
  unavailable: "Integrations are not available right now.",
  plan_lapsed: "The plan no longer includes integrations.",
  service_unavailable: "The service did not answer after several attempts.",
  invalid_response: "The service answered in a way Portifact could not use.",
  target_removed: "An admin removed that repository, team or project from the connection.",
  artifact_moved: "The artifact moved to another space before the issue was created.",
  requester_left: "The person who asked can no longer create issues for this space.",
  thread_gone: "The thread was deleted before the issue was created.",
  site_changed:
    "The Jira site's address changed. An admin needs to connect the site again with its current name.",
};

/** The most attempts one issue gets: the first and one after each retry delay. */
export const MAX_ISSUE_ATTEMPTS = INTEGRATION_LIMITS.retryDelaysMs.length + 1;
