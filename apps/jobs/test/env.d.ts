import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARTIFACTS: R2Bucket;
      JOBS: Queue<import("@portifact/contracts").JobMessage>;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
