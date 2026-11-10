// The operator tool: runs one command from src/operator.ts against the production D1 database
// through a Wrangler remote binding, authenticated with the deploy credentials (a Cloudflare API
// token with D1 edit access in CLOUDFLARE_API_TOKEN, or `wrangler login`). `--local` uses the
// local D1 state of `wrangler dev` in apps/app instead, and `--config <file>` the DB binding of
// another Wrangler configuration (a scratch database for a backup drill). See
// docs/operations.md.
// It runs on Node, not Bun: Wrangler refuses remote bindings under Bun, whose fetch ignores the
// dispatcher Miniflare routes them through.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "@portifact/db";
import { domainDepsFromEnv } from "@portifact/services";
import { getPlatformProxy } from "wrangler";
import { OPERATOR_USAGE, operatorTarget, runOperator } from "../src/operator.ts";

const target = operatorTarget(process.argv.slice(2));
if (!target.ok) {
  console.log(`${target.message}\n\n${OPERATOR_USAGE}`);
  process.exit(2);
}
const { args } = target;
if (args.length === 0 || args.includes("--help")) {
  console.log(OPERATOR_USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}

const here = (path: string) => resolve(import.meta.dirname, path);
const proxy = await getPlatformProxy<{ DB: D1Database }>(
  target.target === "local"
    ? {
        configPath: here("../wrangler.jsonc"),
        persist: { path: here("../../app/.wrangler/state/v3") },
        remoteBindings: false,
      }
    : {
        configPath:
          target.config === null ? here("../operator.wrangler.jsonc") : resolve(target.config),
        persist: false,
        remoteBindings: true,
      },
);
try {
  // Only reconcile-domains calls Cloudflare, with the zone and token from this shell's
  // environment; no other command builds the client.
  const domains =
    args[0] === "reconcile-domains"
      ? domainDepsFromEnv(
          {
            CUSTOM_DOMAINS_ENABLED: "true",
            CF_CONTENT_ZONE_ID: process.env.CF_CONTENT_ZONE_ID,
            CF_HOSTNAMES_TOKEN: process.env.CF_HOSTNAMES_TOKEN,
          },
          (input, init) => fetch(input, init),
        )
      : null;
  const result = await runOperator(
    createDb(proxy.env.DB),
    args,
    Date.now(),
    {
      read: (path) => readFile(path, "utf8"),
      write: (path, text) => writeFile(path, text),
    },
    domains,
  );
  console.log(result.output);
  process.exitCode = result.exitCode;
} finally {
  await proxy.dispose();
}
