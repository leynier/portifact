// The environment of the programs the CLI starts (git, gh). A workspace's service token
// (decision 0011) is for Portifact's API only, so it never reaches a child process.

/** The variable a CI job puts a service token in. */
export const SERVICE_TOKEN_ENV = "PORTIFACT_TOKEN";

/** `env` without the credentials only the CLI itself may read. */
export function childEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const { [SERVICE_TOKEN_ENV]: _withheld, ...rest } = env;
  return rest;
}
