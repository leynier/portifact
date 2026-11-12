// Fake GitHub, Linear and Jira Cloud APIs for tests and the e2e stack (decision 0018): never the
// real services. One `fetch` answers GitHub's REST endpoints Portifact uses (`/user`, a
// repository, creating and listing its issues), Linear's GraphQL operations (`PortifactCheck`,
// `PortifactIssue`, `PortifactFind`) and Jira's REST API on Atlassian's gateway
// (`/ex/jira/<cloudId>/rest/api/3/`: `serverInfo`, `myself`, a project, creating an issue and
// `search/jql`, with Basic authentication by email and token), checks the credential like the
// services do, and keeps the
// issues it created. A test can script the next answers (a status, a redirect, a slow or huge
// answer, a network error), lose the answer of a create, or revoke a credential. Never imported
// by a deployed Worker.

export interface FakeIssue {
  service: "github" | "linear" | "jira";
  target: string;
  title: string;
  /** Markdown on GitHub and Linear; the JSON of the Atlassian document on Jira. */
  body: string;
  key: string;
  url: string;
  /** Who opened it: the credential's account, or someone else for an issue a test plants. */
  author: string;
  /** A pull request, which GitHub lists among issues. */
  pullRequest?: boolean;
  /** Jira: when it was created, as Jira writes it (`…T12:00:00.000+0000`). */
  created?: string;
}

/** A time as Jira writes it: milliseconds and an offset without a colon. */
function jiraTime(at: number): string {
  return new Date(at).toISOString().replace("Z", "+0000");
}

export interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Scripted =
  | Response
  /** The fake's own answer, to script a later call. */
  | "pass"
  | "network"
  | "hang"
  | "lose"
  | ((url: string, init: RequestInit) => Response | Promise<Response>);

interface GitHubCredential {
  service: "github";
  login: string;
  repos: Map<string, { fullName: string; hasIssues: boolean }>;
}

interface LinearCredential {
  service: "linear";
  name: string;
  teams: Map<string, { id: string; name: string; key: string }>;
}

export interface FakeJiraProject {
  key: string;
  name: string;
  /** The project's issue types; a `Task` (ID 10001) and a subtask type by default. */
  issueTypes?: { id: string; name: string; subtask?: boolean; hierarchyLevel?: number }[];
}

export interface FakeJiraSite {
  /** `acme` for `acme.atlassian.net`. */
  site: string;
  cloudId: string;
}

interface JiraCredential {
  service: "jira";
  displayName: string;
  cloudId: string;
  projects: Map<string, FakeJiraProject>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export class FakeIssueTrackers {
  readonly issues: FakeIssue[] = [];
  readonly requests: FakeRequest[] = [];
  private readonly credentials = new Map<
    string,
    GitHubCredential | LinearCredential | JiraCredential
  >();
  /** Jira sites by cloud ID: what `serverInfo` answers for each. */
  private readonly sites = new Map<string, string>();
  private readonly script: Scripted[] = [];
  private counter = 0;
  /** The clock Jira's `created` reads; the real one unless a test sets it. */
  now: () => number = () => Date.now();

  /** A GitHub token acting as `login` with these repositories (`owner/name`). */
  github(
    token: string,
    login: string,
    repos: readonly (string | { name: string; hasIssues: boolean })[],
  ) {
    this.credentials.set(token, {
      service: "github",
      login,
      repos: new Map(
        repos.map((repo) => {
          const name = typeof repo === "string" ? repo : repo.name;
          const hasIssues = typeof repo === "string" ? true : repo.hasIssues;
          return [name.toLowerCase(), { fullName: name, hasIssues }];
        }),
      ),
    });
    return this;
  }

  /** A Linear API key acting as `name` in these teams. */
  linear(key: string, name: string, teams: readonly { id: string; name: string; key: string }[]) {
    this.credentials.set(key, {
      service: "linear",
      name,
      teams: new Map(teams.map((team) => [team.id.toLowerCase(), team])),
    });
    return this;
  }

  /** A Jira Cloud site behind the gateway, by its cloud ID. */
  jiraSite(site: FakeJiraSite) {
    this.sites.set(site.cloudId, site.site);
    return this;
  }

  /**
   * A Jira API token of the Atlassian account `account` (shown as `displayName`) on one site,
   * which can browse and create issues in these projects.
   */
  jira(
    account: string,
    token: string,
    input: { displayName: string; cloudId: string; projects: readonly FakeJiraProject[] },
  ) {
    this.credentials.set(`${account}:${token}`, {
      service: "jira",
      displayName: input.displayName,
      cloudId: input.cloudId,
      projects: new Map(input.projects.map((project) => [project.key, project])),
    });
    return this;
  }

  /**
   * Plants a Jira issue as `author` created it at `created` (the fake's clock by default), for
   * example one copying a reference line, or a large one.
   */
  plantJira(project: string, input: { text: string; author: string; created?: number }) {
    this.counter += 1;
    const key = `${project}-${this.counter}`;
    this.issues.push({
      service: "jira",
      target: project,
      title: "Planted",
      body: JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: input.text }] }],
      }),
      key,
      url: `https://planted.atlassian.net/browse/${key}`,
      author: input.author,
      created: jiraTime(input.created ?? this.now()),
    });
    return this;
  }

  /**
   * Plants an issue (or a pull request) in a GitHub repository as someone else wrote it, for
   * example one that copies another issue's reference line.
   */
  plant(target: string, input: { body: string; author: string; pullRequest?: boolean }) {
    this.counter += 1;
    this.issues.push({
      service: "github",
      target,
      title: "Planted",
      body: input.body,
      key: `#${this.counter}`,
      url: `https://github.com/${target}/${input.pullRequest ? "pull" : "issues"}/${this.counter}`,
      author: input.author,
      ...(input.pullRequest ? { pullRequest: true } : {}),
    });
    return this;
  }

  /** The service stops accepting the credential, as when its owner revokes it. */
  revoke(credential: string) {
    this.credentials.delete(credential);
  }

  /**
   * Answers the next calls with these, in order, instead of the fake's own logic. `lose` runs the
   * call (an issue is created) and then fails it like a lost answer; `hang` never answers until
   * the request is aborted.
   */
  next(...answers: Scripted[]) {
    this.script.push(...answers);
    return this;
  }

  /** The network the services take (`IntegrationFetch`). */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : "";
    this.requests.push({ url, method: init.method ?? "GET", headers, body });
    const scripted = this.script.shift();
    if (scripted === "network") throw new TypeError("connection refused");
    if (scripted === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (scripted instanceof Response) return scripted;
    if (typeof scripted === "function") return scripted(url, init);
    const answer = this.answer(url, init.method ?? "GET", headers, body);
    if (scripted === "lose") throw new TypeError("connection reset");
    return answer;
  };

  private answer(url: string, method: string, headers: Record<string, string>, body: string) {
    const parsed = new URL(url);
    if (parsed.origin === "https://api.github.com")
      return this.githubAnswer(parsed, method, headers, body);
    if (parsed.href === "https://api.linear.app/graphql") return this.linearAnswer(headers, body);
    if (parsed.origin === "https://api.atlassian.com") {
      return this.jiraAnswer(parsed, method, headers, body);
    }
    return new Response("unknown host", { status: 404 });
  }

  private jiraAnswer(url: URL, method: string, headers: Record<string, string>, body: string) {
    const match = /^\/ex\/jira\/([^/]+)\/rest\/api\/3\/(.+)$/.exec(url.pathname);
    const site = match ? this.sites.get(match[1] ?? "") : undefined;
    if (!match || site === undefined) return json({ message: "Not Found" }, 404);
    const cloudId = match[1] ?? "";
    const path = match[2] ?? "";
    const basic = /^Basic (.+)$/.exec(headers.authorization ?? "");
    let pair = "";
    try {
      pair = basic
        ? new TextDecoder().decode(Uint8Array.from(atob(basic[1] ?? ""), (ch) => ch.charCodeAt(0)))
        : "";
    } catch {
      pair = "";
    }
    const credential = this.credentials.get(pair);
    // Atlassian answers 401 to wrong credentials, even where anonymous access would work.
    if (!credential || credential.service !== "jira" || credential.cloudId !== cloudId) {
      return json({ errorMessages: ["Client must be authenticated"] }, 401);
    }
    if (path === "serverInfo" && method === "GET") {
      return json({ baseUrl: `https://${site}.atlassian.net`, deploymentType: "Cloud" });
    }
    if (path === "myself" && method === "GET") {
      return json({ accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: credential.displayName });
    }
    const projectMatch = /^project\/([^/]+)$/.exec(path);
    if (projectMatch && method === "GET") {
      const project = credential.projects.get(decodeURIComponent(projectMatch[1] ?? ""));
      if (!project) return json({ errorMessages: ["No project could be found"] }, 404);
      return json({
        key: project.key,
        name: project.name,
        issueTypes: project.issueTypes ?? [
          { id: "10002", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
          { id: "10001", name: "Task", subtask: false, hierarchyLevel: 0 },
        ],
      });
    }
    if (path === "issue" && method === "POST") {
      const input = JSON.parse(body) as {
        fields?: {
          project?: { key?: string };
          issuetype?: { id?: string };
          summary?: string;
          description?: unknown;
        };
      };
      const project = credential.projects.get(String(input.fields?.project?.key));
      if (!project) return json({ errorMessages: ["No project could be found"] }, 404);
      if (!input.fields?.summary || !input.fields.issuetype?.id) {
        return json({ errors: { summary: "You must specify a summary of the issue." } }, 400);
      }
      this.counter += 1;
      const key = `${project.key}-${this.counter}`;
      this.issues.push({
        service: "jira",
        target: project.key,
        title: input.fields.summary,
        body: JSON.stringify(input.fields.description ?? null),
        key,
        url: `https://${site}.atlassian.net/browse/${key}`,
        author: credential.displayName,
        created: jiraTime(this.now()),
      });
      return json(
        {
          id: String(10_000 + this.counter),
          key,
          self: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${10_000 + this.counter}`,
        },
        201,
      );
    }
    if (path === "search/jql" && method === "GET") {
      const jql = url.searchParams.get("jql") ?? "";
      const project = /^project = "([A-Z][A-Z0-9_]*)" AND creator = currentUser\(\)/.exec(jql)?.[1];
      if (!project) return json({ errorMessages: ["Unsupported JQL in the fake"] }, 400);
      const issues = this.issues
        .filter(
          (issue) =>
            issue.service === "jira" &&
            issue.target === project &&
            issue.author === credential.displayName,
        )
        .reverse()
        .slice(0, Number(url.searchParams.get("maxResults") ?? 50))
        .map((issue) => ({
          key: issue.key,
          fields: { description: JSON.parse(issue.body), created: issue.created },
        }));
      return json({ issues, isLast: true });
    }
    return json({ errorMessages: ["Not Found"] }, 404);
  }

  private githubAnswer(url: URL, method: string, headers: Record<string, string>, body: string) {
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    const credential = this.credentials.get(token);
    if (!credential || credential.service !== "github") {
      return json({ message: "Bad credentials" }, 401);
    }
    if (url.pathname === "/user" && method === "GET") return json({ login: credential.login });
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(url.pathname);
    const repo = match
      ? credential.repos.get(
          `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`.toLowerCase(),
        )
      : undefined;
    if (!match || !repo) return json({ message: "Not Found" }, 404);
    if (!match[3] && method === "GET") {
      return json({ full_name: repo.fullName, has_issues: repo.hasIssues });
    }
    if (match[3] && method === "GET") {
      const list = this.issues
        .filter(
          (issue) =>
            issue.service === "github" &&
            issue.target.toLowerCase() === repo.fullName.toLowerCase(),
        )
        .reverse()
        .slice(0, Number(url.searchParams.get("per_page") ?? 30))
        .map((issue) => ({
          number: Number(issue.key.slice(1)),
          html_url: issue.url,
          body: issue.body,
          title: issue.title,
          user: { login: issue.author },
          ...(issue.pullRequest ? { pull_request: { url: issue.url } } : {}),
        }));
      return json(list);
    }
    if (match[3] && method === "POST") {
      if (!repo.hasIssues) return json({ message: "Issues are disabled for this repo" }, 410);
      const input = JSON.parse(body) as { title?: string; body?: string };
      if (!input.title) return json({ message: "Validation Failed" }, 422);
      this.counter += 1;
      const number = this.counter;
      const issue: FakeIssue = {
        service: "github",
        target: repo.fullName,
        title: input.title,
        body: input.body ?? "",
        key: `#${number}`,
        url: `https://github.com/${repo.fullName}/issues/${number}`,
        author: credential.login,
      };
      this.issues.push(issue);
      return json({ number, html_url: issue.url }, 201);
    }
    return json({ message: "Not Found" }, 404);
  }

  private linearAnswer(headers: Record<string, string>, body: string) {
    const credential = this.credentials.get(headers.authorization ?? "");
    if (!credential || credential.service !== "linear") {
      return json(
        {
          errors: [
            {
              message: "Authentication required",
              extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR" },
            },
          ],
        },
        400,
      );
    }
    const request = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    if (request.query.includes("PortifactCheck")) {
      return json({
        data: {
          viewer: { name: credential.name },
          teams: { nodes: [...credential.teams.values()].map(({ id, name }) => ({ id, name })) },
        },
      });
    }
    if (request.query.includes("PortifactIssue")) {
      const input = request.variables.input as {
        teamId: string;
        title: string;
        description: string;
      };
      const team = credential.teams.get(String(input.teamId).toLowerCase());
      if (!team) {
        return json({
          errors: [{ message: "Forbidden", extensions: { type: "forbidden", code: "FORBIDDEN" } }],
        });
      }
      this.counter += 1;
      const key = `${team.key}-${this.counter}`;
      const issue: FakeIssue = {
        service: "linear",
        target: team.id,
        title: input.title,
        body: input.description,
        key,
        url: `https://linear.app/acme/issue/${key}/from-portifact`,
        author: credential.name,
      };
      this.issues.push(issue);
      return json({
        data: { issueCreate: { success: true, issue: { identifier: key, url: issue.url } } },
      });
    }
    if (request.query.includes("PortifactFind")) {
      const team = String(request.variables.team).toLowerCase();
      const marker = String(request.variables.marker);
      const nodes = this.issues
        .filter(
          (issue) =>
            issue.service === "linear" &&
            issue.target.toLowerCase() === team &&
            issue.body.includes(marker),
        )
        .slice(0, 1)
        .map((issue) => ({ identifier: issue.key, url: issue.url }));
      return json({ data: { issues: { nodes } } });
    }
    return json(
      { errors: [{ message: "Unknown query", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] },
      400,
    );
  }
}
