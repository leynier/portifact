// Bindings of the portifact-app Worker. Non-secret values come from `vars` in wrangler.jsonc;
// secrets are set with `wrangler secret put` (docs/releasing.md) and `.dev.vars` locally.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EMAIL: SendEmail;
  /** Origin of the identity and authorization server, for example https://app.portifact.com. */
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GITHUB_CLIENT_ID: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_SECRET: string;
}
