// Calls to GitHub, Linear and Jira Cloud (decision 0018). Every call goes to the service's fixed
// API origin (`INTEGRATION_API`; for Jira Atlassian's gateway, with the site named by its cloud ID
// in the path), checked again right before it is sent, with `redirect: "manual"` (any 3xx
// is a failure), a timeout and a bounded read of the answer. Nothing of an answer is kept but what
// the caller extracts: the identity, team names, an issue's key and URL. Credentials and bodies
// are never logged.
import {
  INTEGRATION_API,
  INTEGRATION_LIMITS,
  type IntegrationCheckProblem,
  type IntegrationService,
  type IntegrationTarget,
  type IssueSource,
} from "@portifact/contracts";
import {
  adfPlainText,
  checkIntegrationCall,
  checkIssueKey,
  checkIssueUrl,
  classifyIntegrationCall,
  type IntegrationCallResult,
  type IntegrationVerdict,
  issueBody,
  issueDocument,
  type JiraSite,
  jiraApiUrl,
  jiraBaseUrlIsSite,
  jiraFindJql,
  jiraIssueType,
  jiraIssueUrl,
  jiraTimestamp,
  openJiraCredential,
  plainLine,
} from "@portifact/domain";

/** The network, injected: the Workers' `fetch`, or a fake server in tests and the e2e stack. */
export type IntegrationFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  fetch: IntegrationFetch;
  timeoutMs?: number | undefined;
  readBytes?: number | undefined;
}

type Answer =
  | { kind: "answer"; status: number; json: unknown; rateLimited: boolean }
  | Exclude<IntegrationCallResult, { kind: "status" } | { kind: "graphql" }>;

/** Reads at most `limit` bytes of a body; null when it is larger. */
async function readBounded(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let read = 0;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      read += chunk.value.byteLength;
      if (read > limit) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Basic authentication with an Atlassian account's email and API token, UTF-8 encoded. */
function basicAuth(account: string, token: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(`${account}:${token}`)) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}

function headersFor(service: IntegrationService, credential: string): Record<string, string> {
  const common = {
    "user-agent": "Portifact-Integrations/1 (+https://portifact.com)",
    "content-type": "application/json",
  };
  if (service === "jira") {
    // A sealed value that does not read as a Jira credential sends none: Jira answers 401.
    const jira = openJiraCredential(credential);
    return {
      ...common,
      accept: "application/json",
      ...(jira ? { authorization: basicAuth(jira.account, jira.token) } : {}),
    };
  }
  return service === "github"
    ? {
        ...common,
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "x-github-api-version": "2022-11-28",
      }
    : // Linear's personal API keys go in the header as they are, without a scheme.
      { ...common, accept: "application/json", authorization: credential };
}

/** One call to the service's API: checked, bounded and never following a redirect. */
async function call(
  service: IntegrationService,
  credential: string,
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  options: CallOptions,
): Promise<Answer> {
  const checked = checkIntegrationCall(service, url);
  // Built from constants, so this never happens; if it did, nothing is sent.
  if (!checked.ok) return { kind: "invalid_response" };
  const signal = AbortSignal.timeout(options.timeoutMs ?? INTEGRATION_LIMITS.timeoutMs);
  let response: Response;
  try {
    response = await options.fetch(checked.value.href, {
      method: init.method,
      headers: headersFor(service, credential),
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "manual",
      signal,
    });
  } catch {
    return signal.aborted ? { kind: "timeout" } : { kind: "network" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return { kind: "redirect" };
  }
  let text: string | null;
  try {
    text = await readBounded(
      response,
      options.readBytes ?? INTEGRATION_LIMITS.responseReadBytes,
      signal,
    );
  } catch {
    return signal.aborted ? { kind: "timeout" } : { kind: "network" };
  }
  if (text === null) return { kind: "too_large" };
  let json: unknown = null;
  if (text !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      if (response.status >= 200 && response.status < 300) return { kind: "invalid_response" };
    }
  }
  // GitHub's primary limit says so in its headers; its secondary limit answers 403 (or 429),
  // sometimes without `Retry-After`, with a message that names the rate limit.
  const remaining = response.headers.get("x-ratelimit-remaining");
  const message = record(json)?.message;
  const rateLimited =
    (response.status === 403 || response.status === 429) &&
    (remaining === "0" ||
      response.headers.has("retry-after") ||
      (typeof message === "string" && /rate limit/i.test(message)));
  return { kind: "answer", status: response.status, json, rateLimited };
}

/** `owner/repo` as a URL path, each part encoded. */
function repoPath(target: string): string {
  return target.split("/").map(encodeURIComponent).join("/");
}

/** The JSON of an answer the classification accepted (only a 2xx answer gets that far). */
function okJson(answer: Answer): unknown {
  return (answer as { json: unknown }).json;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The type of a Linear GraphQL error, from its extensions. */
function graphqlError(json: unknown): IntegrationCallResult | null {
  const errors = record(json)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const text = errors
    .map((error) => {
      const extensions = record(record(error)?.extensions);
      return `${String(extensions?.code)} ${String(extensions?.type)}`;
    })
    .join(" ")
    .toLowerCase();
  const type = /authenticat/.test(text)
    ? "authentication"
    : /forbidden|permission/.test(text)
      ? "forbidden"
      : /ratelimit|rate limit/.test(text)
        ? "rate_limited"
        : /invalid.input|input error|bad_user_input/.test(text)
          ? "invalid_input"
          : "other";
  return { kind: "graphql", type };
}

/** Turns an answer into the result the domain classifies. */
function resultOf(answer: Answer, service: IntegrationService): IntegrationCallResult {
  if (answer.kind !== "answer") return answer;
  if (service === "linear") {
    const graphql = graphqlError(answer.json);
    if (graphql) return graphql;
  }
  return { kind: "status", status: answer.status, rateLimited: answer.rateLimited };
}

async function linear(
  credential: string,
  query: string,
  variables: Record<string, unknown>,
  options: CallOptions,
) {
  return call(
    "linear",
    credential,
    INTEGRATION_API.linear,
    { method: "POST", body: JSON.stringify({ query, variables }) },
    options,
  );
}

function linearData(answer: Answer): Record<string, unknown> | null {
  return record(record(okJson(answer))?.data);
}

/** One call to a Jira site's REST API on Atlassian's gateway. */
async function jira(
  credential: string,
  site: JiraSite,
  path: string,
  init: { method: "GET" | "POST"; body?: string; query?: URLSearchParams },
  options: CallOptions,
) {
  return call(
    "jira",
    credential,
    jiraApiUrl(site.cloudId, path, init.query),
    { method: init.method, ...(init.body === undefined ? {} : { body: init.body }) },
    options,
  );
}

// Checking a credential

/** A target as checked: Jira projects also keep the issue type Portifact creates in them. */
export interface CheckedTarget extends IntegrationTarget {
  issueType?: string;
}

export type CredentialCheck =
  | { ok: true; identity: string; targets: CheckedTarget[] }
  | { ok: false; problem: IntegrationCheckProblem; target: string | null };

function problemOf(result: IntegrationCallResult): IntegrationCheckProblem {
  const verdict = classifyIntegrationCall(result);
  if (result.kind === "status" && result.rateLimited) return "rate_limited";
  if (result.kind === "graphql" && result.type === "rate_limited") return "rate_limited";
  switch (verdict.failure) {
    case "credential_rejected":
      return "credential_rejected";
    case "target_unreachable":
      return "target_unreachable";
    default:
      return "service_unavailable";
  }
}

/** Problems a repository check reports as they are; any other refusal means unreachable. */
const KEPT_PROBLEMS: ReadonlySet<IntegrationCheckProblem> = new Set([
  "credential_rejected",
  "service_unavailable",
  "rate_limited",
]);

const identityOf = (value: unknown) =>
  typeof value === "string" ? plainLine(value, INTEGRATION_LIMITS.identityMax) : null;

/**
 * Asks the service who the credential acts as and whether every target is reachable: GitHub's
 * `GET /user` and `GET /repos/{owner}/{repo}` (with issues turned on); Linear's `viewer` and
 * `teams`. Write access is proven only by the first issue: neither service reports what a
 * fine-grained token or an API key may write without trying.
 */
export async function checkCredential(
  service: IntegrationService,
  credential: string,
  targets: readonly string[],
  options: CallOptions,
  /** Jira: the site and cloud ID the admin gave. */
  site?: JiraSite | null,
): Promise<CredentialCheck> {
  if (service === "jira") {
    if (!site) return { ok: false, problem: "site_mismatch", target: null };
    return checkJira(credential, site, targets, options);
  }
  if (service === "github") {
    const user = await call(
      service,
      credential,
      `${INTEGRATION_API.github}/user`,
      { method: "GET" },
      options,
    );
    const userResult = resultOf(user, service);
    if (classifyIntegrationCall(userResult).outcome !== "ok") {
      const problem = problemOf(userResult);
      return {
        ok: false,
        problem: problem === "target_unreachable" ? "missing_permission" : problem,
        target: null,
      };
    }
    const identity = identityOf(record(okJson(user))?.login);
    if (identity === null) return { ok: false, problem: "service_unavailable", target: null };
    const reached: IntegrationTarget[] = [];
    for (const target of targets) {
      const repo = await call(
        service,
        credential,
        `${INTEGRATION_API.github}/repos/${repoPath(target)}`,
        { method: "GET" },
        options,
      );
      const repoResult = resultOf(repo, service);
      if (classifyIntegrationCall(repoResult).outcome !== "ok") {
        // A repository the token cannot see answers 403 or 404: unreachable, whatever else.
        const problem = problemOf(repoResult);
        return {
          ok: false,
          problem: KEPT_PROBLEMS.has(problem) ? problem : "target_unreachable",
          target,
        };
      }
      const body = record(okJson(repo));
      if (body?.has_issues === false) return { ok: false, problem: "issues_disabled", target };
      const fullName = typeof body?.full_name === "string" ? body.full_name : target;
      // GitHub's own spelling, when it is the same repository in another case.
      const id = fullName.toLowerCase() === target.toLowerCase() ? fullName : target;
      reached.push({ id, name: id });
    }
    return { ok: true, identity, targets: reached };
  }
  const answer = await linear(
    credential,
    "query PortifactCheck { viewer { name } teams(first: 250) { nodes { id name } } }",
    {},
    options,
  );
  const result = resultOf(answer, service);
  if (classifyIntegrationCall(result).outcome !== "ok") {
    const problem = problemOf(result);
    return {
      ok: false,
      problem: problem === "target_unreachable" ? "missing_permission" : problem,
      target: null,
    };
  }
  const data = linearData(answer);
  const identity = identityOf(record(data?.viewer)?.name);
  const nodes = record(data?.teams)?.nodes;
  if (identity === null || !Array.isArray(nodes)) {
    return { ok: false, problem: "service_unavailable", target: null };
  }
  const teams = new Map<string, string>();
  for (const node of nodes) {
    const team = record(node);
    const name = identityOf(team?.name);
    if (typeof team?.id === "string" && name !== null) teams.set(team.id.toLowerCase(), name);
  }
  const reached: IntegrationTarget[] = [];
  for (const target of targets) {
    const name = teams.get(target.toLowerCase());
    if (name === undefined) return { ok: false, problem: "target_unreachable", target };
    reached.push({
      id: target.toLowerCase(),
      name: name.slice(0, INTEGRATION_LIMITS.targetNameMax),
    });
  }
  return { ok: true, identity, targets: reached };
}

/**
 * Jira: `serverInfo` first (no scope needed), whose `baseUrl` must be exactly the site the admin
 * named, so issue links point at the Jira the calls go to; then `myself` (the identity, scope
 * `read:jira-user`) and each project (`read:jira-work`), keeping the issue type to create.
 */
async function checkJira(
  credential: string,
  site: JiraSite,
  targets: readonly string[],
  options: CallOptions,
): Promise<CredentialCheck> {
  const proof = await verifyJiraSite(credential, site, options);
  if (proof.kind === "failed") {
    const problem = problemOf(proof.result);
    // An unknown cloud ID answers 404 at the gateway.
    return {
      ok: false,
      problem: problem === "target_unreachable" ? "site_mismatch" : problem,
      target: null,
    };
  }
  if (proof.kind === "other") return { ok: false, problem: "site_mismatch", target: null };
  const me = await jira(credential, site, "myself", { method: "GET" }, options);
  const meResult = resultOf(me, "jira");
  if (classifyIntegrationCall(meResult).outcome !== "ok") {
    const problem = problemOf(meResult);
    return {
      ok: false,
      problem: problem === "target_unreachable" ? "missing_permission" : problem,
      target: null,
    };
  }
  const identity = identityOf(record(okJson(me))?.displayName);
  if (identity === null) return { ok: false, problem: "service_unavailable", target: null };
  const reached: CheckedTarget[] = [];
  for (const target of targets) {
    const project = await jira(credential, site, `project/${target}`, { method: "GET" }, options);
    const projectResult = resultOf(project, "jira");
    if (classifyIntegrationCall(projectResult).outcome !== "ok") {
      const problem = problemOf(projectResult);
      return {
        ok: false,
        problem: KEPT_PROBLEMS.has(problem) ? problem : "target_unreachable",
        target,
      };
    }
    const body = record(okJson(project));
    const issueType = jiraIssueType(body?.issueTypes);
    if (issueType === null) return { ok: false, problem: "issues_disabled", target };
    const name = identityOf(body?.name) ?? target;
    reached.push({ id: target, name: name.slice(0, INTEGRATION_LIMITS.targetNameMax), issueType });
  }
  return { ok: true, identity, targets: reached };
}

/**
 * Asks Jira's `serverInfo` (no scope needed) which site the cloud ID serves now: `same` when its
 * `baseUrl` is exactly the stored site, `other` when it names anything else (the site changed
 * its address, or the cloud ID is another site's), or how the call failed.
 */
export async function verifyJiraSite(
  credential: string,
  site: JiraSite,
  options: CallOptions,
): Promise<
  { kind: "same" } | { kind: "other" } | { kind: "failed"; result: IntegrationCallResult }
> {
  const info = await jira(credential, site, "serverInfo", { method: "GET" }, options);
  const result = resultOf(info, "jira");
  if (classifyIntegrationCall(result).outcome !== "ok") return { kind: "failed", result };
  return jiraBaseUrlIsSite(record(okJson(info))?.baseUrl, site.name)
    ? { kind: "same" }
    : { kind: "other" };
}

// Creating an issue

export type IssueCallOutcome =
  | { kind: "created"; key: string; url: string }
  | { kind: "absent" }
  | { kind: "failed"; verdict: IntegrationVerdict };

function failedOf(result: IntegrationCallResult): { kind: "failed"; verdict: IntegrationVerdict } {
  return { kind: "failed", verdict: classifyIntegrationCall(result) };
}

/** A failed call as the job settles it (retried, marked or ended by the classification). */
export const failedOutcome = failedOf;

const invalid = () => failedOf({ kind: "invalid_response" });

/** The created issue's key and URL from GitHub's answer, validated, or an invalid response. */
function githubIssue(json: unknown, target: string): Exclude<IssueCallOutcome, { kind: "absent" }> {
  const body = record(json);
  const key = checkIssueKey("github", body?.number);
  if (!key.ok) return invalid();
  const url = checkIssueUrl("github", body?.html_url, {
    target,
    number: body?.number as number,
  });
  return url.ok ? { kind: "created", key: key.value, url: url.value } : invalid();
}

function linearIssue(issue: unknown): Exclude<IssueCallOutcome, { kind: "absent" }> {
  const body = record(issue);
  const key = checkIssueKey("linear", body?.identifier);
  if (!key.ok) return invalid();
  // The link must be the issue Linear just named, not another one.
  const url = checkIssueUrl("linear", body?.url, { target: "", key: key.value });
  return url.ok ? { kind: "created", key: key.value, url: url.value } : invalid();
}

/** A Jira issue's key (in the target project) and the link Portifact builds for it. */
function jiraIssue(
  json: unknown,
  site: JiraSite,
  project: string,
): Exclude<IssueCallOutcome, { kind: "absent" }> {
  const key = checkIssueKey("jira", record(json)?.key, project);
  if (!key.ok) return invalid();
  // Built, never taken from the answer: Jira's `self` is an API URL, not the issue's page.
  const url = checkIssueUrl("jira", jiraIssueUrl(site.name, key.value), {
    target: project,
    key: key.value,
    site: site.name,
  });
  return url.ok ? { kind: "created", key: key.value, url: url.value } : invalid();
}

/** What a created issue says, in the format of its service: Markdown, or a Jira document. */
export interface IssueContent {
  target: string;
  title: string;
  source: IssueSource;
  parts: { link: boolean; artifactName: boolean; quote: boolean; message: boolean };
  /** Jira: the issue type checked with the project. */
  issueType?: string | undefined;
}

/** Creates the issue. */
export async function createIssue(
  service: IntegrationService,
  credential: string,
  input: IssueContent,
  options: CallOptions,
  /** Jira: the connection's site. */
  site?: JiraSite | null,
): Promise<Exclude<IssueCallOutcome, { kind: "absent" }>> {
  if (service === "jira") {
    if (!site || input.issueType === undefined) return invalid();
    const answer = await jira(
      credential,
      site,
      "issue",
      {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { key: input.target },
            issuetype: { id: input.issueType },
            summary: input.title,
            description: issueDocument(input.source, input.parts),
          },
        }),
      },
      options,
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    return jiraIssue(okJson(answer), site, input.target);
  }
  const body = issueBody(input.source, input.parts);
  if (service === "github") {
    const answer = await call(
      service,
      credential,
      `${INTEGRATION_API.github}/repos/${repoPath(input.target)}/issues`,
      { method: "POST", body: JSON.stringify({ title: input.title, body }) },
      options,
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    return githubIssue(okJson(answer), input.target);
  }
  const answer = await linear(
    credential,
    "mutation PortifactIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
    { input: { teamId: input.target, title: input.title, description: body } },
    options,
  );
  const result = resultOf(answer, service);
  if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
  const created = record(linearData(answer)?.issueCreate);
  if (created?.success !== true) return failedOf({ kind: "status", status: 422 });
  return linearIssue(created.issue);
}

/**
 * Looks for an issue that an earlier attempt created but whose answer was lost, by the reference
 * line in its body: on GitHub among the repository's most recent issues (a list, not the search
 * index, which lags), on Linear with a filter on the team and the description. `absent` only when
 * the service answered and nothing matched; any failure is reported, so the caller never creates
 * a second issue on a guess.
 */
export async function findIssue(
  service: IntegrationService,
  credential: string,
  /**
   * `identity`: the account the connection's credential acts as, as the service reported it.
   * `requestedAt`: when the request was made; Jira adopts only an issue created since (less
   * `lookupSkewMs`), so a reference pasted into an older issue is never linked.
   */
  input: { target: string; reference: string; identity: string; requestedAt?: number },
  options: CallOptions,
  /** Jira: the connection's site. */
  site?: JiraSite | null,
): Promise<IssueCallOutcome> {
  const marker = `Reference: ${input.reference}`;
  if (service === "jira") {
    const jql = jiraFindJql(input.target);
    if (!site || !jql.ok) return invalid();
    const answer = await jira(
      credential,
      site,
      "search/jql",
      {
        method: "GET",
        query: new URLSearchParams({
          jql: jql.value,
          maxResults: String(INTEGRATION_LIMITS.recentIssuesChecked),
          fields: "description,created",
        }),
      },
      // Recent issues carry their descriptions: allow more than a single issue's answer.
      { ...options, readBytes: options.readBytes ?? 4 * INTEGRATION_LIMITS.responseReadBytes },
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    const issues = record(okJson(answer))?.issues;
    if (!Array.isArray(issues)) return invalid();
    // The search names only the connection's own account as creator; newest first, so the oldest
    // match is the last one.
    const since = (input.requestedAt ?? 0) - INTEGRATION_LIMITS.lookupSkewMs;
    const matches = issues.filter((item) => {
      const fields = record(record(item)?.fields);
      const created = jiraTimestamp(fields?.created);
      return (
        created !== null && created >= since && adfPlainText(fields?.description).includes(marker)
      );
    });
    const oldest = matches.at(-1);
    return oldest ? jiraIssue(oldest, site, input.target) : { kind: "absent" };
  }
  if (service === "github") {
    const answer = await call(
      service,
      credential,
      `${INTEGRATION_API.github}/repos/${repoPath(input.target)}/issues?state=all&sort=created&direction=desc&per_page=${INTEGRATION_LIMITS.recentIssuesChecked}`,
      { method: "GET" },
      // Recent issues carry their bodies: allow more than a single issue's answer.
      { ...options, readBytes: options.readBytes ?? 4 * INTEGRATION_LIMITS.responseReadBytes },
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    const list = okJson(answer);
    if (!Array.isArray(list)) return invalid();
    // Only an issue (never a pull request) that the connection's own account opened, the oldest
    // first: someone who copies the reference into their own issue cannot get it linked.
    const matches = list.filter((item) => {
      const issue = record(item);
      const body = issue?.body;
      return (
        issue !== null &&
        issue.pull_request === undefined &&
        record(issue.user)?.login === input.identity &&
        typeof body === "string" &&
        body.includes(marker)
      );
    });
    const oldest = matches.at(-1);
    return oldest ? githubIssue(oldest, input.target) : { kind: "absent" };
  }
  const answer = await linear(
    credential,
    "query PortifactFind($team: ID!, $marker: String!) { issues(first: 1, filter: { team: { id: { eq: $team } }, description: { contains: $marker } }) { nodes { identifier url } } }",
    { team: input.target, marker },
    options,
  );
  const result = resultOf(answer, service);
  if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
  const nodes = record(linearData(answer)?.issues)?.nodes;
  if (!Array.isArray(nodes)) return invalid();
  return nodes.length === 0 ? { kind: "absent" } : linearIssue(nodes[0]);
}
