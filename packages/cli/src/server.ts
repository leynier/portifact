import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";

export const DEFAULT_APP_ORIGIN = "https://app.portifact.com";

/** Overrides the server for tests and staging. Production users never need it. */
export const ORIGIN_ENV = "PORTIFACT_APP_ORIGIN";

export interface Server {
  origin: string;
  /** Base of the OAuth endpoints; Better Auth's issuer. */
  authBase: string;
  /** Resource indicator (RFC 8707) the CLI requests tokens for. */
  apiResource: string;
  overridden: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveServer(env: Readonly<Record<string, string | undefined>>): Server {
  const value = env[ORIGIN_ENV]?.trim();
  const origin = value ? parseOrigin(value) : DEFAULT_APP_ORIGIN;
  return {
    origin,
    authBase: `${origin}/api/auth`,
    apiResource: `${origin}/api/v1`,
    overridden: origin !== DEFAULT_APP_ORIGIN,
  };
}

// Tokens are sent to this origin, so plain http is accepted only on the local machine, and a
// URL with credentials or a path is refused rather than silently trimmed.
function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid_input", messages.errors.invalidOrigin);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  const bare =
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "";
  if (!secure || !bare) throw new CliError("invalid_input", messages.errors.invalidOrigin);
  return url.origin;
}
