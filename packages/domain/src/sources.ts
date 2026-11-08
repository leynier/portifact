// Rules for the git origin of a version's private sources (plan section 6, "Fuentes desde git").
// The origin is declarative: the server cannot verify it, so it only checks that it is well formed
// and that the remote carries no credentials, whatever client sent it.
import { fail, ok, type Result } from "./result.ts";

export interface SourceOriginInput {
  commit: string | null;
  branch: string | null;
  remote: string | null;
  dirty: boolean;
}

/** A URL scheme such as `https://` or `ssh://`; scp-like remotes (`git@host:path`) have none. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Schemes whose user name is an account name (`ssh://git@host`), not a secret. */
const USER_NAME_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"]);

/**
 * Whether a git remote can be stored as given: no password, no query or fragment (where tokens
 * travel), and no user name on schemes that put tokens there (`https://<token>@host`). Local
 * paths and scp-like remotes pass, since they hold no credentials.
 */
export function isCredentialFreeRemote(remote: string): boolean {
  const scheme = URL_SCHEME.exec(remote)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return false;
  }
  if (url.password !== "" || url.search !== "" || url.hash !== "") return false;
  return url.username === "" || USER_NAME_SCHEMES.has(scheme);
}

/**
 * Removes credentials from a git remote: the user name and password of a URL (keeping the user
 * name of ssh URLs), and its query and fragment. Returns null for a URL that cannot be parsed,
 * so a malformed remote is left out instead of stored.
 */
export function stripRemoteCredentials(remote: string): string | null {
  const scheme = URL_SCHEME.exec(remote)?.[1]?.toLowerCase();
  if (scheme === undefined) return remote;
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  url.password = "";
  if (!USER_NAME_SCHEMES.has(scheme)) url.username = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Checks a declared source origin: it needs source files, and its remote has no credentials. */
export function checkSourceOrigin(
  origin: SourceOriginInput,
  sourceFiles: number,
): Result<SourceOriginInput> {
  if (sourceFiles === 0) {
    return fail("invalid_input", "A source origin needs at least one source file.");
  }
  if (origin.remote !== null && !isCredentialFreeRemote(origin.remote)) {
    return fail(
      "invalid_input",
      "The source remote must not include a password, token, query or fragment.",
    );
  }
  return ok(origin);
}
