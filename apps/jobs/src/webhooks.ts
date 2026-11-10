// What the jobs Worker gives webhook deliveries (decision 0009): the sealing keys, the network
// (global `fetch`, which `global_fetch_strictly_public` in wrangler.jsonc routes like any outside
// client), the origins links use and the emergency stop. Nothing here logs a URL, a secret or a
// body: the consumer logs only the job's ID, topic and outcome.
import { type WebhookDeps, webhookKeys } from "@portifact/services";

export interface WebhookEnv {
  APP_ORIGIN: string;
  CONTENT_DOMAIN: string;
  /** Seals and opens webhook URLs and secrets; shared with the app Worker (docs/releasing.md). */
  WEBHOOK_KEY?: string | undefined;
  /** The key being rotated out: opened, and re-sealed with `WEBHOOK_KEY` by the schedule. */
  WEBHOOK_KEY_PREVIOUS?: string | undefined;
  /** Any non-empty value stops every delivery until it is removed (docs/operations.md). */
  WEBHOOKS_PAUSED?: string | undefined;
  /**
   * Exactly `"true"` turns deliveries on. Unset in the deployed configuration until the checks in
   * docs/releasing.md ("Webhooks") pass; without it nothing is delivered (decision 0009).
   */
  WEBHOOKS_ENABLED?: string | undefined;
}

/** Whether webhooks are delivered at all: the explicit switch and a usable key. */
export function webhooksEnabled(env: Pick<WebhookEnv, "WEBHOOKS_ENABLED" | "WEBHOOK_KEY">) {
  return env.WEBHOOKS_ENABLED === "true" && typeof env.WEBHOOK_KEY === "string";
}

export type Fetch = WebhookDeps["fetch"];

export async function webhookDepsFromEnv(
  env: WebhookEnv,
  fetcher: Fetch = (url, init) => fetch(url, init),
): Promise<WebhookDeps> {
  return {
    keys: await webhookKeys({ current: env.WEBHOOK_KEY, previous: env.WEBHOOK_KEY_PREVIOUS }),
    fetch: fetcher,
    appOrigin: env.APP_ORIGIN,
    contentDomain: env.CONTENT_DOMAIN,
    paused: Boolean(env.WEBHOOKS_PAUSED),
    enabled: webhooksEnabled(env),
  };
}
