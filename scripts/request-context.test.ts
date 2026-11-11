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
