// What the jobs Worker gives issue integrations (decision 0018): the sealing keys, the network
// (global `fetch`, which `global_fetch_strictly_public` in wrangler.jsonc routes like any outside
// client) and the origin thread links use. Calls go only to GitHub's, Linear's and Atlassian's fixed
// API hosts.
// Nothing here logs a credential, a title or a body: the consumer logs only the job's ID, topic
// and outcome.
import { integrationKeys, type ThreadIssueDeps } from "@portifact/services";

export interface IntegrationEnv {
  APP_ORIGIN: string;
  /** Seals and opens connection credentials; shared with the app Worker (docs/releasing.md). */
  INTEGRATIONS_KEY?: string | undefined;
  /** The key being rotated out: opened, and re-sealed with `INTEGRATIONS_KEY` by the schedule. */
  INTEGRATIONS_KEY_PREVIOUS?: string | undefined;
  /**
   * Exactly `"true"` turns issue creation on. Unset in the deployed configuration until the
   * checks in docs/releasing.md ("Integrations") pass; without it nothing is sent (decision 0018).
   */
  INTEGRATIONS_ENABLED?: string | undefined;
}

/** Whether issues are sent at all: the explicit switch and a key. */
export function integrationsEnabled(
  env: Pick<IntegrationEnv, "INTEGRATIONS_ENABLED" | "INTEGRATIONS_KEY">,
) {
  return env.INTEGRATIONS_ENABLED === "true" && typeof env.INTEGRATIONS_KEY === "string";
}

export function integrationKeysFromEnv(env: IntegrationEnv) {
  return integrationKeys({
    current: env.INTEGRATIONS_KEY,
    previous: env.INTEGRATIONS_KEY_PREVIOUS,
  });
}

export async function issueDepsFromEnv(
  env: IntegrationEnv,
  fetcher: ThreadIssueDeps["fetch"] = (url, init) => fetch(url, init),
): Promise<ThreadIssueDeps> {
  const keys = await integrationKeysFromEnv(env);
  return {
    keys,
    fetch: fetcher,
    appOrigin: env.APP_ORIGIN,
    enabled: integrationsEnabled(env) && keys.length > 0,
  };
}
