import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ACCESS_DB: D1Database;
      MIGRATION_DB: D1Database;
      DB_EU: D1Database;
      ACCESS_DB_EU: D1Database;
      ARTIFACTS: R2Bucket;
      ARTIFACTS_EU: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
      TEST_ACCESS_MIGRATIONS: D1Migration[];
    }
  }
}
