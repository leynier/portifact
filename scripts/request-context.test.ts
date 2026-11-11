// The request context reaches every role decision (decision 0020). The types already make a
// `GlobalDb` carry one and make every caller of `actorOn` handle a refusal; this guard checks what
// the types cannot: that each Worker builds the context from the request it answers, that the
// Workers answering clients never claim to be background work, and that no adapter builds a
// database handle around the context.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(ROOT, dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(relative(ROOT, path)));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, path));
  }
  return out;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Each Worker entry and how it must build the context for what it answers. */
const ENTRIES: Record<string, RegExp> = {
  // The app Worker: every request, from Cloudflare's CF-Connecting-IP.
  "apps/app/src/app-host.ts":
    /c\.env = withRequestContext\(c\.env, requestContextOf\(c\.req\.raw\)\)/,
  // The content Worker: every request it routes.
  "apps/content/src/index.ts": /withRequestContext\(workerEnv, requestContextOf\(request\)\)/,
  // The jobs Worker and the operator answer no client.
  "apps/jobs/src/index.ts": /withRequestContext\(env, BACKGROUND\)/,
  "apps/jobs/scripts/operator.ts": /withRequestContext\(proxy\.env, BACKGROUND\)/,
};

/** Every Worker configuration of the product and the test stack (spikes are never deployed). */
function workerConfigs(): string[] {
  // Configurations live at a package's root: each app, and the e2e stack.
  const roots = [
    ...readdirSync(join(ROOT, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`),
    "e2e",
  ];
  return roots.flatMap((root) =>
    readdirSync(join(ROOT, root))
      .filter((name) => /^([a-z.]*\.)?wrangler\.jsonc$/.test(name))
      .map((name) => `${root}/${name}`),
  );
}

/** The handlers a Worker module exports: in its default export's literal, or its factory's. */
function handlersIn(source: string): string[] {
  const literal = source.indexOf("export default {");
  const scope = literal === -1 ? source : source.slice(literal);
  return [
    // A method (`fetch(`) or a function value (`fetch: (`, `fetch: async`), never a property
    // that holds something else (`email: capturedEmail(...)` in a deps object).
    ...scope.matchAll(
      /^ {2,4}(?:async\s+)?(fetch|scheduled|queue|email|tail)\s*(?:\(|:\s*(?:\(|async\b))/gm,
    ),
  ].map((match) => match[1] as string);
}

/**
 * The entry points a configuration runs: the handlers of its `main` module (`fetch`, `scheduled`,
 * `queue`, `email`, `tail`) and its Durable Object classes, as `<config>#<name>`.
 */
function entryPoints(config: string): string[] {
  const text = read(config);
  const main = /"main"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const dir = config.slice(0, config.lastIndexOf("/"));
  const source = main ? read(`${dir}/${main}`) : "";
  const handlers = handlersIn(source);
  const classes = [...text.matchAll(/"class_name"\s*:\s*"([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  return [...new Set([...handlers, ...classes])].map((name) => `${config}#${name}`);
}

/**
 * How each entry point builds the request context. A new handler or Worker fails here until it
 * is classified: answering requests (the context from `requestContextOf`), background work
 * (`BACKGROUND`), handing every request to a classified Worker (the e2e stack), or reading no
 * product database at all.
 */
const CLASSIFIED: Record<string, { file: string; pattern: RegExp } | { noDatabase: string }> = {
  "apps/app/wrangler.jsonc#fetch": {
    file: "apps/app/src/app-host.ts",
    pattern: /c\.env = withRequestContext\(c\.env, requestContextOf\(c\.req\.raw\)\)/,
  },
  "apps/content/wrangler.jsonc#fetch": {
    file: "apps/content/src/index.ts",
    pattern: /withRequestContext\(workerEnv, requestContextOf\(request\)\)/,
  },
  "apps/content/wrangler.jsonc#TrafficLimiter": {
    noDatabase: "apps/content/src/traffic-limiter.ts",
  },
  "apps/jobs/wrangler.jsonc#scheduled": {
    file: "apps/jobs/src/index.ts",
    pattern:
      /scheduled: \(controller, workerEnv, ctx\) => \{\n\s+const env = background\(workerEnv\);/,
  },
  "apps/jobs/wrangler.jsonc#queue": {
    file: "apps/jobs/src/index.ts",
    pattern: /queue: \(batch, env\) => runQueue\(batch, background\(env\)/,
  },
  // The test stack hands every request to the app and content Workers' own entries.
  "e2e/wrangler.jsonc#fetch": {
    file: "e2e/worker/index.ts",
    pattern: /return handle\(\s*request,[\s\S]*return app\.fetch\(request, env, ctx\)/,
  },
};

describe("every Worker entry point", () => {
  it("is classified, and nothing classified is gone", () => {
    const found = workerConfigs().flatMap(entryPoints).sort();
    expect(found).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("finds a handler a Worker adds, and ignores properties that are not handlers", () => {
    const worker = `const deps = {\n  email: capturedEmail(env),\n};\nexport default {\n  fetch: (request, env) => handle(request, env),\n  async scheduled(controller, env) {},\n  queue: async (batch, env) => run(batch, env),\n};`;
    expect(handlersIn(worker)).toEqual(["fetch", "scheduled", "queue"]);
  });

  it.each(Object.entries(CLASSIFIED))("%s builds its context", (_entry, how) => {
    if ("noDatabase" in how) {
      expect(read(how.noDatabase)).not.toMatch(/@portifact\/(db|services)/);
    } else {
      expect(read(how.file)).toMatch(how.pattern);
    }
  });
});

describe("the request context", () => {
  it.each(Object.entries(ENTRIES))("is built by %s", (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  it("is never background work in the Workers that answer clients", () => {
    const offending = [...sources("apps/app/src"), ...sources("apps/content/src")].filter((file) =>
      /\bBACKGROUND\b/.test(read(file)),
    );
    expect(offending).toEqual([]);
  });

  it("is never bypassed by an adapter building its own global handle", () => {
    const offending = ["apps/app/src", "apps/content/src", "apps/jobs/src"]
      .flatMap(sources)
      .filter((file) => /\bglobalDb\(/.test(read(file)));
    expect(offending).toEqual([]);
  });

  it("is applied where the role is decided, and only there", () => {
    const actors = read("packages/services/src/actors.ts");
    // Both a member's and a token's actor pass through the policy check.
    expect(actors).toMatch(
      /return bound\(global, await tokenActorOn\(global, userId, target\), "token"\)/,
    );
    expect(actors).toMatch(/return bound\(global, memberActor\(userId, ownerId, row\), "person"\)/);
    const deciding = sources("packages/services/src").filter((file) =>
      /checkRequestPolicy\(/.test(read(file)),
    );
    // The list of workspaces marks a blocked one without a read; nothing else decides it.
    expect(deciding.sort()).toEqual([
      "packages/services/src/actors.ts",
      "packages/services/src/workspaces.ts",
    ]);
  });
});
