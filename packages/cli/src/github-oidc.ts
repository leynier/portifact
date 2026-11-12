// GitHub Actions OIDC federation for the CLI (decision 0024): inside a workflow run, with
// `PORTIFACT_GITHUB_OIDC` naming a workspace and no `PORTIFACT_TOKEN`, the CLI asks GitHub for an
// ID token with the workspace's audience, exchanges it for a short-lived service token and keeps
// that token in this process's memory only: never on disk, never printed, never in a child's
// environment (`childEnvironment` also withholds GitHub's request variables). Nothing happens
// unless the variable is set: a job that grants `id-token: write` for another purpose never talks
// to Portifact.
import { GitHubTokenExchanged, githubAudience, WorkspaceSlug } from "@portifact/contracts";
import {
  GITHUB_OIDC_ENV,
  ID_TOKEN_REQUEST_TOKEN_ENV,
  ID_TOKEN_REQUEST_URL_ENV,
  SERVICE_TOKEN_ENV,
} from "./child-env.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Runtime } from "./runtime.ts";
import type { Server } from "./server.ts";

export { GITHUB_OIDC_ENV };

/** A credential this close to its expiry is exchanged again before use. */
const RENEW_MARGIN_MS = 60_000;

/** Credentials of this process, by origin and workspace. Memory only. */
const credentials = new Map<string, { token: string; expiresAt: number }>();

/** Forgets the process's credentials; tests use it between cases. */
export function forgetGitHubCredentials(): void {
  credentials.clear();
}

/**
 * The workspace the GitHub OIDC mode is asked for, or undefined when it is not: it needs
 * `PORTIFACT_GITHUB_OIDC` and no `PORTIFACT_TOKEN` (a service token always wins).
 */
export function githubOidcWorkspace(runtime: Pick<Runtime, "env">): string | undefined {
  if (runtime.env[SERVICE_TOKEN_ENV]?.trim()) return undefined;
  const value = runtime.env[GITHUB_OIDC_ENV]?.trim();
  if (!value) return undefined;
  const slug = WorkspaceSlug.safeParse(value);
  if (!slug.success) throw new CliError("invalid_input", messages.errors.githubOidcWorkspace);
  return slug.data;
}

/** A credential for `workspace`: the one in memory while it lasts, or a new exchange. */
export async function githubCredential(
  runtime: Runtime,
  server: Server,
  workspace: string,
  fresh: boolean,
): Promise<string> {
  const key = `${server.origin} ${workspace}`;
  const held = credentials.get(key);
  if (!fresh && held && held.expiresAt - runtime.now() > RENEW_MARGIN_MS) return held.token;
  const idToken = await requestIdToken(runtime, githubAudience(server.origin, workspace));
  let response: Response;
  try {
    response = await runtime.fetch(`${server.apiResource}/github/token`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ workspace, token: idToken }),
    });
  } catch {
    throw new CliError("network_error", messages.errors.network(server.origin));
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 429) {
      throw new CliError("rate_limited", messages.errors.githubOidcLimited(server.origin));
    }
    throw new CliError(
      "unauthenticated",
      messages.errors.githubOidcRefused(
        server.origin,
        workspace,
        runtime.env.GITHUB_REPOSITORY_ID,
        runtime.env.GITHUB_REPOSITORY_OWNER_ID,
      ),
    );
  }
  const parsed = GitHubTokenExchanged.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new CliError("server_error", messages.errors.server(server.origin));
  credentials.set(key, {
    token: parsed.data.token,
    expiresAt: Date.parse(parsed.data.expiresAt),
  });
  return parsed.data.token;
}

/** Asks the runner for an ID token with `audience`, as GitHub documents it. */
async function requestIdToken(runtime: Runtime, audience: string): Promise<string> {
  const url = runtime.env[ID_TOKEN_REQUEST_URL_ENV];
  const bearer = runtime.env[ID_TOKEN_REQUEST_TOKEN_ENV];
  if (!url || !bearer) throw new CliError("unauthenticated", messages.errors.githubOidcNoRequest);
  let request: URL;
  try {
    request = new URL(url);
  } catch {
    throw new CliError("unauthenticated", messages.errors.githubOidcNoRequest);
  }
  // The runner's endpoint is https; plain http only on this machine, for tests.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname);
  if (request.protocol !== "https:" && !(request.protocol === "http:" && local)) {
    throw new CliError("unauthenticated", messages.errors.githubOidcNoRequest);
  }
  request.searchParams.set("audience", audience);
  let response: Response;
  try {
    response = await runtime.fetch(request.toString(), {
      redirect: "manual",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
  } catch {
    throw new CliError("network_error", messages.errors.githubOidcUnreachable);
  }
  const body = (await response.json().catch(() => null)) as { value?: unknown } | null;
  if (!response.ok || typeof body?.value !== "string" || body.value.length === 0) {
    throw new CliError("unauthenticated", messages.errors.githubOidcUnreachable);
  }
  return body.value;
}
