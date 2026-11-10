declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BETTER_AUTH_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** PEM key and certificate of the fake SAML identity provider, made per run. */
    IDP_KEY: string;
    IDP_CERT: string;
  }
}

type Env = Cloudflare.Env;
