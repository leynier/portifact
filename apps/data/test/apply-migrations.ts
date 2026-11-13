import { applyD1Migrations, env } from "cloudflare:test";
import { afterAll } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_EU, env.TEST_MIGRATIONS);

afterAll(() => {
  const found = (globalThis as { __regionGuard?: Set<string> }).__regionGuard;
  if (found?.size) throw new Error(`REGIONGUARD\n${[...found].join("\n")}\nEND`);
});
