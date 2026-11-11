// The environment of the programs the CLI starts (git, gh). A workspace's service token
// (decision 0011) is for Portifact's API only, so it never reaches a child process, and neither do
// the OIDC federation's switch and GitHub's ID token request variables (decision 0024): a child
// could otherwise mint ID tokens for any audience.

/** The variable a CI job puts a service token in. */
export const SERVICE_TOKEN_ENV = "PORTIFACT_TOKEN";
/** The variable that asks for GitHub Actions OIDC federation, naming the workspace. */
export const GITHUB_OIDC_ENV = "PORTIFACT_GITHUB_OIDC";
/** What GitHub sets in a job that grants `id-token: write`. */
export const ID_TOKEN_REQUEST_URL_ENV = "ACTIONS_ID_TOKEN_REQUEST_URL";
export const ID_TOKEN_REQUEST_TOKEN_ENV = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

/** `env` without the credentials only the CLI itself may read. */
export function childEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const {
    [SERVICE_TOKEN_ENV]: _token,
    [GITHUB_OIDC_ENV]: _oidc,
    [ID_TOKEN_REQUEST_URL_ENV]: _url,
    [ID_TOKEN_REQUEST_TOKEN_ENV]: _request,
    ...rest
  } = env;
  return rest;
}
