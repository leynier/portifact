declare namespace Cloudflare {
  interface Env {
    GLOBAL: D1Database;
    DB_DEFAULT: D1Database;
    DB_EU: D1Database;
    ARTIFACTS: R2Bucket;
    ARTIFACTS_EU: R2Bucket;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

type Env = Cloudflare.Env;
