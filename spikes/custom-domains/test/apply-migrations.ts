import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

for (const db of [env.GLOBAL, env.DB_EU]) {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
}
