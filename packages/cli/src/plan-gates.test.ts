// Paid features refused on `free` (premium plan section 10, "every paid feature has a test that
// refuses it on free, with the same error in web, CLI and MCP"). The CLI adds no rule of its
// own: it shows the API's `plan_required` body as it came and exits 7, like every limit. A
// command that reaches a paid feature adds one line to GATED; the API and MCP side of the same
// rule is apps/app/test/plan-gates.test.ts.
import type { PlanFeature } from "@portifact/contracts";
import { planRequiredMessage } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { planRequired } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

interface GatedCommand {
  feature: PlanFeature;
  /** The command's arguments; `id` is an artifact the fake server holds. */
  args: (id: string) => string[];
  /** The request the API refuses for a free owner. */
  method: string;
  path: RegExp;
}

/** One line per command that reaches a paid feature. */
const GATED: GatedCommand[] = [
  {
    feature: "pin",
    args: (id) => ["pin", id],
    method: "POST",
    path: /^\/api\/v1\/artifacts\/[^/]+\/pin$/,
  },
  {
    feature: "shareLinks",
    args: (id) => ["share", "create", id, "--label", "Gate"],
    method: "POST",
    path: /^\/api\/v1\/artifacts\/[^/]+\/share-links$/,
  },
  {
    feature: "analytics",
    args: (id) => ["stats", id],
    method: "GET",
    path: /^\/api\/v1\/artifacts\/[^/]+\/stats$/,
  },
];

describe.each(GATED)("$feature through `$method $path`", (gated) => {
  const refuse = () => {
    server.faults.push({
      method: gated.method,
      path: gated.path,
      reply: planRequired(gated.feature),
    });
  };

  it("prints the API's plan_required body with --json and exits 7", async () => {
    h.signIn();
    const artifact = server.api.seed();
    refuse();
    const result = await h.invoke(...gated.args(artifact.id), "--json");
    expect(result.code).toBe(EXIT.limit);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "plan_required", message: planRequiredMessage(gated.feature) },
    });
  });

  it("prints the message that names the plan on stderr without --json", async () => {
    h.signIn();
    const artifact = server.api.seed();
    refuse();
    const result = await h.invoke(...gated.args(artifact.id));
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr.endsWith(`Error: ${planRequiredMessage(gated.feature)}\n`)).toBe(true);
  });
});
