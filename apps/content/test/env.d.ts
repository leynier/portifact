import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ACCESS_DB: D1Database;
      ARTIFACTS: R2Bucket;
      CONTENT_DOMAIN: string;
      APP_ORIGIN: string;
      READ_SESSION_SECRET: string;
      TRAFFIC_LIMITER: DurableObjectNamespace<import("../src/traffic-limiter.ts").TrafficLimiter>;
      DB_EU: D1Database;
      ACCESS_DB_EU: D1Database;
      ARTIFACTS_EU: R2Bucket;
      REGION_GUARD: string;
      TEST_MIGRATIONS: D1Migration[];
      TEST_ACCESS_MIGRATIONS: D1Migration[];
    }
  }
}
