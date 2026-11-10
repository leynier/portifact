// PORTIFACT_TOKEN and publish keys in the CLI (decision 0011): a workspace's service token is used
// instead of a stored login, never written or printed, and `publish --key` / `delete --key` let
// a CI job keep one artifact per key.
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

// Built at run time so nothing committed matches the secret scanner's rule for the prefix.
const secret = (fill: string) => ["pf", "st_", fill.repeat(43)].join("").slice(0, 48);
const TOKEN = secret("Q");
const SCOPES = ["artifacts:read", "artifacts:write", "artifacts:delete"];

let server: FakeServer;
let h: Harness;

async function harness(
  env: Record<string, string> = { PORTIFACT_TOKEN: TOKEN },
  answers?: string[],
) {
  h = await createHarness({ server, env, ...(answers ? { answers } : {}) });
  return h;
}

beforeEach(async () => {
  server = await startFakeServer();
  server.api.workspaces = [{ slug: "acme", name: "Acme Docs", role: "editor" }];
  server.serviceTokens.set(TOKEN, { workspace: "acme", scopes: SCOPES });
});

afterEach(async () => {
  await h?.cleanup();
  await server.close();
});

function expectNoSecret(result: { stdout: string; stderr: string }) {
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(TOKEN.slice(5));
}

describe("PORTIFACT_TOKEN", () => {
  it("publishes into the token's workspace with --key twice, one artifact and two versions", async () => {
    await harness();
    const folder = await h.files("site", { "index.html": "<h1>Preview</h1>" });
    const first = await h.invoke("publish", folder, "--key", "pr-12", "--json");
    expect(first.code).toBe(0);
    expectNoSecret(first);
    const a = JSON.parse(first.stdout);
    expect(a.versionNumber).toBe(1);

    await h.files("site", { "index.html": "<h1>Preview 2</h1>" });
    const second = await h.invoke("publish", folder, "--key", "pr-12", "--json");
    expect(second.code).toBe(0);
    const b = JSON.parse(second.stdout);
    const listed = JSON.parse((await h.invoke("list", "--key", "pr-12", "--json")).stdout);
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([a.artifactId]);
    expect(b.artifactId).toBe(a.artifactId);
    expect(b.versionNumber).toBe(2);
    const artifact = server.api.artifacts.get(a.artifactId);
    expect(artifact?.workspace).toBe("acme");
    expect(artifact?.key).toBe("pr-12");
    // The stored login and the default workspace were never touched.
    expect(h.secrets?.entries.size).toBe(0);
    const written = await readdir(h.configDir).catch(() => []);
    expect(written).toEqual([]);
    expect(server.api.workspaceParams.every((param) => param.endsWith(" acme"))).toBe(true);
  });

  it("deletes by key, does nothing for a key nobody holds, and asks for --yes without a terminal", async () => {
    await harness();
    const folder = await h.files("site", { "index.html": "<h1>Preview</h1>" });
    const published = JSON.parse(
      (await h.invoke("publish", folder, "--key", "pr-3", "--json")).stdout,
    );
    const unconfirmed = await h.invoke("delete", "--key", "pr-3");
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain("portifact delete --key pr-3 --yes");
    const deleted = await h.invoke("delete", "--key", "pr-3", "--yes", "--json");
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      key: "pr-3",
      artifactId: published.artifactId,
      deleted: true,
      state: "deleted",
    });
    const again = await h.invoke("delete", "--key", "pr-3", "--yes");
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("No artifact has the key pr-3, so nothing was deleted.\n");
    // Released: the next publish with the key creates a new artifact.
    const next = JSON.parse((await h.invoke("publish", folder, "--key", "pr-3", "--json")).stdout);
    expect(next.artifactId).not.toBe(published.artifactId);
  });

  it("says why the server refused the token, without printing it", async () => {
    server.serviceTokens.set(TOKEN, {
      workspace: "acme",
      scopes: SCOPES,
      refusal: {
        status: 401,
        body: {
          error: {
            code: "unauthenticated",
            message:
              "This service token expired on 2026-11-01. Ask a workspace admin for a new one.",
          },
        },
      },
    });
    await harness();
    const result = await h.invoke("list");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("This service token expired on 2026-11-01.");
    expectNoSecret(result);

    server.serviceTokens.delete(TOKEN);
    const revoked = await h.invoke("list");
    expect(revoked.code).toBe(3);
    expect(revoked.stderr).toContain("It may have been revoked.");
  });

  it("refuses a malformed token before any request, without printing it", async () => {
    const malformed = `${TOKEN.slice(0, 20)}`;
    await harness({ PORTIFACT_TOKEN: malformed });
    const result = await h.invoke("list");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("PORTIFACT_TOKEN does not hold a Portifact service token");
    expect(result.stderr).not.toContain(malformed);
    expect(server.requests).toEqual([]);
  });

  it("is held to the workspace's plan and its scopes", async () => {
    server.serviceTokens.set(TOKEN, {
      workspace: "acme",
      scopes: SCOPES,
      refusal: {
        status: 403,
        body: {
          error: {
            code: "plan_required",
            message: "Using service tokens is part of the Team plan.",
          },
        },
      },
    });
    await harness();
    const lapsed = await h.invoke("list");
    expect(lapsed.code).toBe(7);
    expect(lapsed.stderr).toContain("Using service tokens is part of the Team plan.");

    server.serviceTokens.set(TOKEN, { workspace: "acme", scopes: ["artifacts:read"] });
    const folder = await h.files("site", { "index.html": "<p>x</p>" });
    const scoped = await h.invoke("publish", folder, "--key", "pr-1");
    expect(scoped.code).toBe(5);
    expect(scoped.stderr).toContain("does not have the artifacts:write scope");
  });

  it("acts only on its workspace", async () => {
    server.api.workspaces.push({ slug: "other", name: "Other", role: "editor" });
    await harness();
    const elsewhere = await h.invoke("list", "--workspace", "other");
    expect(elsewhere.code).toBe(5);
    const used = await h.invoke("workspaces", "use", "other");
    expect(used.code).toBe(2);
    expect(used.stderr).toContain("A service token always acts on its own workspace");
  });

  it("never signs in or out while set, and whoami names the workspace", async () => {
    await harness();
    for (const command of ["login", "logout"]) {
      const result = await h.invoke(command);
      expect(result.code, command).toBe(2);
      expect(result.stderr).toContain("PORTIFACT_TOKEN is set");
    }
    const who = await h.invoke("whoami", "--json");
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toEqual({
      server: server.origin,
      serviceToken: true,
      workspace: "acme",
      role: "editor",
    });
    expectNoSecret(who);
  });
});

describe("publish keys for people", () => {
  it("works with a login too, in the personal space", async () => {
    await harness({});
    h.signIn();
    const folder = await h.files("doc", { "index.html": "<p>1</p>" });
    const first = JSON.parse(
      (await h.invoke("publish", folder, "--key", "notes", "--json")).stdout,
    );
    const second = JSON.parse(
      (await h.invoke("publish", folder, "--key", "notes", "--json")).stdout,
    );
    expect(second.artifactId).toBe(first.artifactId);
    expect(server.api.artifacts.get(first.artifactId)?.workspace).toBeUndefined();
  });

  it("refuses a bad key, a key with --artifact, and delete without a target", async () => {
    await harness({});
    h.signIn();
    const folder = await h.files("doc", { "index.html": "<p>1</p>" });
    for (const args of [
      ["publish", folder, "--key", "has space"],
      ["publish", folder, "--key", "-x"],
      ["publish", folder, "--key", "pr-1", "--artifact", "abcdefghij"],
      ["delete"],
      ["delete", "abcdefghij", "--key", "pr-1"],
      ["delete", "--key", "bad key", "--yes"],
      ["list", "--key", "bad key"],
    ]) {
      const result = await h.invoke(...args);
      expect(result.code, args.join(" ")).toBe(2);
    }
  });
});
