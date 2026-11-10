declare namespace Cloudflare {
  interface Env {
    GLOBAL: D1Database;
    DB_EU: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

type Env = Cloudflare.Env;
