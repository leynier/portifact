// Fake GitHub and Linear APIs for tests and the e2e stack (decision 0018): never the real
// services. One `fetch` answers GitHub's REST endpoints Portifact uses (`/user`, a repository,
// creating and listing its issues) and Linear's GraphQL operations (`PortifactCheck`,
// `PortifactIssue`, `PortifactFind`), checks the credential like the services do, and keeps the
// issues it created. A test can script the next answers (a status, a redirect, a slow or huge
// answer, a network error), lose the answer of a create, or revoke a credential. Never imported
// by a deployed Worker.

export interface FakeIssue {
  service: "github" | "linear";
  target: string;
  title: string;
  body: string;
  key: string;
  url: string;
  /** Who opened it: the credential's account, or someone else for an issue a test plants. */
  author: string;
  /** A pull request, which GitHub lists among issues. */
  pullRequest?: boolean;
}

export interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Scripted =
  | Response
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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export class FakeIssueTrackers {
  readonly issues: FakeIssue[] = [];
  readonly requests: FakeRequest[] = [];
  private readonly credentials = new Map<string, GitHubCredential | LinearCredential>();
  private readonly script: Scripted[] = [];
  private counter = 0;

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
    return new Response("unknown host", { status: 404 });
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
