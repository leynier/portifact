import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.CONTROL, env.CONTROL_MIGRATIONS);
await applyD1Migrations(env.ACCESS, env.ACCESS_MIGRATIONS);
