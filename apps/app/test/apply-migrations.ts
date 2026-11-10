import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.ACCESS_DB, env.TEST_ACCESS_MIGRATIONS);
await applyD1Migrations(env.DB_EU, env.TEST_MIGRATIONS);
await applyD1Migrations(env.ACCESS_DB_EU, env.TEST_ACCESS_MIGRATIONS);

import { afterAll } from "vitest";

afterAll(() => {
  const found = (globalThis as { __regionGuard?: Set<string> }).__regionGuard;
  if (found?.size) throw new Error(`REGIONGUARD\n${[...found].join("\n")}\nEND`);
});
