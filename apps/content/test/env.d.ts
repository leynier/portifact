import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARTIFACTS: R2Bucket;
      CONTENT_DOMAIN: string;
      APP_ORIGIN: string;
      READ_SESSION_SECRET: string;
      PUBLIC_TRAFFIC_LIMIT: RateLimit;
      PROTECTED_TRAFFIC_LIMIT: RateLimit;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
