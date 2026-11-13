import type { D1Migration } from "@cloudflare/vitest-plugin";

// What the lifecycle tests bind besides the Worker's configuration (vitest.config.ts).
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      DB_EU: D1Database;
      ARTIFACTS: R2Bucket;
      ARTIFACTS_EU: R2Bucket;
      REGION_GUARD: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
