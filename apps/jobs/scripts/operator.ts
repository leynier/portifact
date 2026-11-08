// The operator tool: runs one command from src/operator.ts against the production D1 database
// through a Wrangler remote binding, authenticated with the deploy credentials (a Cloudflare API
// token with D1 edit access in CLOUDFLARE_API_TOKEN, or `wrangler login`). `--local` uses the
// local D1 state of `wrangler dev` in apps/app instead. See docs/operations.md.
import { resolve } from "node:path";
import { createDb } from "@portifact/db";
import { getPlatformProxy } from "wrangler";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const argv = process.argv.slice(2);
const local = argv.includes("--local");
const args = argv.filter((arg) => arg !== "--local");
if (args.length === 0 || args.includes("--help")) {
  console.log(OPERATOR_USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}

const here = (path: string) => resolve(import.meta.dir, path);
const proxy = await getPlatformProxy<{ DB: D1Database }>(
  local
    ? {
        configPath: here("../wrangler.jsonc"),
        persist: { path: here("../../app/.wrangler/state/v3") },
        remoteBindings: false,
      }
    : { configPath: here("../operator.wrangler.jsonc"), persist: false, remoteBindings: true },
);
try {
  const result = await runOperator(createDb(proxy.env.DB), args, Date.now());
  console.log(result.output);
  process.exitCode = result.exitCode;
} finally {
  await proxy.dispose();
}
