// Calls to GitHub and Linear (decision 0018). Every call goes to the service's fixed API origin
// (`INTEGRATION_API`), checked again right before it is sent, with `redirect: "manual"` (any 3xx
// is a failure), a timeout and a bounded read of the answer. Nothing of an answer is kept but what
// the caller extracts: the identity, team names, an issue's key and URL. Credentials and bodies
// are never logged.
import {
  INTEGRATION_API,
  INTEGRATION_LIMITS,
  type IntegrationCheckProblem,
  type IntegrationService,
  type IntegrationTarget,
} from "@portifact/contracts";
import {
  checkIntegrationCall,
  checkIssueKey,
  checkIssueUrl,
  classifyIntegrationCall,
  type IntegrationCallResult,
  type IntegrationVerdict,
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

function headersFor(service: IntegrationService, credential: string): Record<string, string> {
  const common = {
    "user-agent": "Portifact-Integrations/1 (+https://portifact.com)",
    "content-type": "application/json",
  };
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
  const remaining = response.headers.get("x-ratelimit-remaining");
  const rateLimited =
    (response.status === 403 || response.status === 429) &&
    (remaining === "0" || response.headers.has("retry-after"));
  return { kind: "answer", status: response.status, json, rateLimited };
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
      return `${extensions?.code ?? ""} ${extensions?.type ?? ""}`;
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
  return answer.kind === "answer" ? record(record(answer.json)?.data) : null;
}

// Checking a credential

export type CredentialCheck =
  | { ok: true; identity: string; targets: IntegrationTarget[] }
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
): Promise<CredentialCheck> {
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
    const identity = identityOf(record(user.kind === "answer" ? user.json : null)?.login);
    if (identity === null) return { ok: false, problem: "service_unavailable", target: null };
    const reached: IntegrationTarget[] = [];
    for (const target of targets) {
      const [owner, name] = target.split("/");
      const repo = await call(
        service,
        credential,
        `${INTEGRATION_API.github}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`,
        { method: "GET" },
        options,
      );
      const repoResult = resultOf(repo, service);
      if (classifyIntegrationCall(repoResult).outcome !== "ok") {
        const problem = problemOf(repoResult);
        return {
          ok: false,
          problem:
            problem === "credential_rejected"
              ? problem
              : problem === "service_unavailable" || problem === "rate_limited"
                ? problem
                : "target_unreachable",
          target,
        };
      }
      const body = record(repo.kind === "answer" ? repo.json : null);
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

// Creating an issue

export type IssueCallOutcome =
  | { kind: "created"; key: string; url: string }
  | { kind: "absent" }
  | { kind: "failed"; verdict: IntegrationVerdict };

function failedOf(result: IntegrationCallResult): IssueCallOutcome {
  return { kind: "failed", verdict: classifyIntegrationCall(result) };
}

const invalid = (): IssueCallOutcome => failedOf({ kind: "invalid_response" });

/** The created issue's key and URL from GitHub's answer, validated, or an invalid response. */
function githubIssue(json: unknown, target: string): IssueCallOutcome {
  const body = record(json);
  const key = checkIssueKey("github", body?.number);
  if (!key.ok) return invalid();
  const url = checkIssueUrl("github", body?.html_url, {
    target,
    number: body?.number as number,
  });
  return url.ok ? { kind: "created", key: key.value, url: url.value } : invalid();
}

function linearIssue(issue: unknown): IssueCallOutcome {
  const body = record(issue);
  const key = checkIssueKey("linear", body?.identifier);
  const url = checkIssueUrl("linear", body?.url, { target: "" });
  return key.ok && url.ok ? { kind: "created", key: key.value, url: url.value } : invalid();
}

/** Creates the issue. */
export async function createIssue(
  service: IntegrationService,
  credential: string,
  input: { target: string; title: string; body: string },
  options: CallOptions,
): Promise<IssueCallOutcome> {
  if (service === "github") {
    const [owner, name] = input.target.split("/");
    const answer = await call(
      service,
      credential,
      `${INTEGRATION_API.github}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/issues`,
      { method: "POST", body: JSON.stringify({ title: input.title, body: input.body }) },
      options,
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    return githubIssue(answer.kind === "answer" ? answer.json : null, input.target);
  }
  const answer = await linear(
    credential,
    "mutation PortifactIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
    { input: { teamId: input.target, title: input.title, description: input.body } },
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
  input: { target: string; reference: string },
  options: CallOptions,
): Promise<IssueCallOutcome> {
  const marker = `Reference: ${input.reference}`;
  if (service === "github") {
    const [owner, name] = input.target.split("/");
    const answer = await call(
      service,
      credential,
      `${INTEGRATION_API.github}/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/issues?state=all&sort=created&direction=desc&per_page=${INTEGRATION_LIMITS.recentIssuesChecked}`,
      { method: "GET" },
      // Recent issues carry their bodies: allow more than a single issue's answer.
      { ...options, readBytes: options.readBytes ?? 4 * INTEGRATION_LIMITS.responseReadBytes },
    );
    const result = resultOf(answer, service);
    if (classifyIntegrationCall(result).outcome !== "ok") return failedOf(result);
    const list = answer.kind === "answer" ? answer.json : null;
    if (!Array.isArray(list)) return invalid();
    const match = list.find((item) => {
      const body = record(item)?.body;
      return typeof body === "string" && body.includes(marker);
    });
    return match ? githubIssue(match, input.target) : { kind: "absent" };
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
