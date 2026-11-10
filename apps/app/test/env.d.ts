import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as AppEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      DB_EU: D1Database;
      ACCESS_DB_EU: D1Database;
      ARTIFACTS_EU: R2Bucket;
      REGION_GUARD: string;
      TEST_MIGRATIONS: D1Migration[];
      TEST_ACCESS_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index.ts");
    }
  }
}
