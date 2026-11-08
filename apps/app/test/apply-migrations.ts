import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.ACCESS_DB, env.TEST_ACCESS_MIGRATIONS);
