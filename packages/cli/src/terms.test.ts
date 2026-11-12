// A person's token whose account has not accepted the current terms (docs/legal.md, "API and MCP
// clients"): the CLI prints the server's instruction, does not retry, and exits 9.
import { termsRefusalMessage } from "@portifact/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { error } from "./testing/fake-api.ts";
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

describe("terms_not_accepted", () => {
  it("prints where to accept the terms, once, and exits 9", async () => {
    h.signIn();
    const message = termsRefusalMessage(server.origin);
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/artifacts$/,
      reply: error("terms_not_accepted", message),
    });
    const plain = await h.invoke("list");
    expect(plain.code).toBe(EXIT.termsNotAccepted);
    expect(plain.code).toBe(9);
    expect(plain.stdout).toBe("");
    expect(plain.stderr.endsWith(`Error: ${message}\n`)).toBe(true);
    // Not a transient failure: the CLI asked once.
    expect(server.requests.filter((r) => r.path === "/api/v1/artifacts")).toHaveLength(1);
  });

  it("reports the code and the message with --json", async () => {
    h.signIn();
    const message = termsRefusalMessage(server.origin);
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/artifacts$/,
      reply: error("terms_not_accepted", message),
    });
    const result = await h.invoke("list", "--json");
    expect(result.code).toBe(9);
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: "terms_not_accepted", message } });
  });
});
