// Workspace policies in the CLI (decision 0015): `portifact workspaces` shows each workspace's
// policies so a refusal can be explained before trying, and a `policy_refused` answer is shown as
// the API sent it and exits 7, like every limit. The CLI never changes a policy: that is the
// dashboard's alone, so no command reaches the `policies` plan feature and the GATED table in
// plan-gates.test.ts has no line for it (the API side is apps/app/test/plan-gates.test.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, exitCodeFor } from "./errors.ts";
import { error } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.api.workspaces = [
    {
      slug: "acme",
      name: "Acme Docs",
      role: "editor",
      policy: {
        publicAccess: "forbidden",
        defaultAccess: "workspace",
        readerDomains: ["acme.example"],
        shareLinks: "password_required",
        shareLinkMaxDays: 30,
      },
    },
    { slug: "readers", name: "Readers", role: "member" },
  ];
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const PUBLIC_FORBIDDEN =
  "The workspace's policy forbids public access. Share it with the workspace, an email domain or named readers instead.";

describe("portifact workspaces", () => {
  it("lists the policies of each workspace that has any", async () => {
    h.signIn();
    const result = await h.invoke("workspaces");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Policies of acme: public access forbidden; new artifacts start as workspace; readers only at acme.example; share links need a password; share links last at most 30 days.\n",
    );
    expect(result.stdout).not.toContain("Policies of readers");
    const json = JSON.parse((await h.invoke("workspaces", "--json")).stdout);
    expect(json.items[0].policy.publicAccess).toBe("forbidden");
    expect(json.items[1].policy).toEqual({
      publicAccess: "allowed",
      defaultAccess: "restricted",
      readerDomains: null,
      shareLinks: "allowed",
      shareLinkMaxDays: null,
    });
  });
});

describe("a policy refusal", () => {
  it.each([
    [["access", "set", "ID", "public"], "PATCH", /^\/api\/v1\/artifacts\/[^/]+\/access$/],
    [
      ["share", "create", "ID", "--label", "Ana"],
      "POST",
      /^\/api\/v1\/artifacts\/[^/]+\/share-links$/,
    ],
  ])("prints the API's body for %j and exits 7", async (argv, method, path) => {
    h.signIn();
    const artifact = server.api.seed();
    const args = argv.map((arg) => (arg === "ID" ? artifact.id : arg));
    server.faults.push({ method, path, reply: error("policy_refused", PUBLIC_FORBIDDEN) });
    const json = await h.invoke(...args, "--json");
    expect(json.code).toBe(EXIT.limit);
    expect(JSON.parse(json.stdout)).toEqual({
      error: { code: "policy_refused", message: PUBLIC_FORBIDDEN },
    });
    server.faults.push({ method, path, reply: error("policy_refused", PUBLIC_FORBIDDEN) });
    const plain = await h.invoke(...args);
    expect(plain.code).toBe(7);
    expect(plain.stdout).toBe("");
    expect(plain.stderr.endsWith(`Error: ${PUBLIC_FORBIDDEN}\n`)).toBe(true);
  });

  it("maps to the limit exit code", () => {
    expect(exitCodeFor("policy_refused")).toBe(EXIT.limit);
  });
});
