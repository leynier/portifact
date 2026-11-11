import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";
import { WORKSPACE_FILE } from "./workspaces.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.api.workspaces = [
    { slug: "acme", name: "Acme Docs", role: "editor" },
    { slug: "readers", name: "Readers", role: "member" },
  ];
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const params = () => server.api.workspaceParams;

describe("portifact workspaces", () => {
  it("lists the personal space and each workspace with the role, marking the default", async () => {
    h.signIn();
    const result = await h.invoke("workspaces");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "   SLUG      ROLE    NAME",
        "*  personal  owner   Personal space",
        "   acme      editor  Acme Docs",
        "   readers   member  Readers",
        "",
      ].join("\n"),
    );
    const json = await h.invoke("workspaces", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({
      default: null,
      items: [{ slug: "acme", role: "editor" }, { slug: "readers" }],
    });
  });

  it("remembers a default for publish, list and usage, and goes back to personal", async () => {
    h.signIn();
    const used = await h.invoke("workspaces", "use", "acme");
    expect(used.code).toBe(0);
    expect(used.stdout).toContain("now use the workspace acme");
    expect(JSON.parse(await readFile(join(h.configDir, WORKSPACE_FILE), "utf8"))).toMatchObject({
      version: 2,
      workspace: "acme",
      userId: expect.any(String),
    });
    expect((await h.invoke("workspaces")).stdout).toContain("*  acme");

    await h.invoke("list");
    await h.invoke("usage");
    await h.invoke("list", "--workspace", "personal");
    expect(params()).toEqual(["GET /artifacts acme", "GET /usage acme", "GET /artifacts personal"]);

    const back = await h.invoke("workspaces", "use", "personal");
    expect(back.stdout).toContain("now use your personal space");
    await h.invoke("list");
    expect(params().at(-1)).toBe("GET /artifacts personal");
  });

  it("refuses a workspace the user is not in, and a malformed slug", async () => {
    h.signIn();
    const missing = await h.invoke("workspaces", "use", "elsewhere");
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain("You are not a member of a workspace elsewhere.");
    const bad = await h.invoke("list", "--workspace", "Not A Slug");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not a workspace slug");
    const unknown = await h.invoke("list", "--workspace", "nowhere");
    expect(unknown.code).toBe(5);
    expect(unknown.stderr).toContain("Workspace not found.");
  });
});

describe("--workspace", () => {
  it("publishes a new artifact into the workspace and says so", async () => {
    h.signIn();
    const folder = await h.files("site", { "index.html": "<p>team</p>" });
    const result = await h.invoke("publish", folder, "--workspace", "acme", "--json");
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.workspace).toBe("acme");
    expect(params()).toEqual(["GET /usage acme", "POST /publishes acme"]);
    const info = await h.invoke("info", output.artifactId);
    expect(info.stdout).toContain("Space        Acme Docs (workspace acme)");
    const listed = await h.invoke("list", "--workspace", "acme");
    expect(listed.stdout.split("\n")[0]).toBe("Workspace: acme");
    expect(listed.stdout).toContain(output.artifactId);
    expect((await h.invoke("list")).stdout).not.toContain(output.artifactId);
  });

  it("keeps an update where the artifact is, whatever the default", async () => {
    h.signIn();
    const artifact = server.api.seed({ workspace: "acme" });
    await h.invoke("workspaces", "use", "readers");
    const folder = await h.files("v2", { "index.html": "<p>v2</p>" });
    const result = await h.invoke("publish", folder, "--artifact", artifact.id);
    expect(result.code).toBe(0);
    expect(params()).toEqual(["GET /usage acme", "POST /publishes personal"]);
    expect(result.stdout).toContain("Workspace: acme");
  });

  it("shows a workspace's usage", async () => {
    h.signIn();
    const result = await h.invoke("usage", "--workspace", "acme");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Workspace\s+acme/);
  });
});

describe("portifact transfer", () => {
  it("moves an artifact to a workspace and back to the personal space, as its admin", async () => {
    h.signIn();
    server.api.workspaces = [{ slug: "acme", name: "Acme Docs", role: "admin" }];
    const artifact = server.api.seed();
    const moved = await h.invoke("transfer", artifact.id, "--to", "acme");
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain(`${artifact.id} is now in: Acme Docs (workspace acme).`);
    expect(moved.stdout).toContain("also see who opened it before the move");
    // The expiry after the move, which a workspace's maximum life counts from it (decision 0023).
    expect(moved.stdout).toMatch(/It expires on \S+ unless it is renewed or published again\.\n/);
    const json = await h.invoke("transfer", artifact.id, "--to", "personal", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ id: artifact.id, owner: { kind: "personal" } });
    const unknown = await h.invoke("transfer", artifact.id, "--to", "nowhere");
    expect(unknown.code).toBe(5);
    const bad = await h.invoke("transfer", "nope", "--to", "acme");
    expect(bad.code).toBe(2);
  });

  it("cannot move an artifact out of a workspace where the user is only an editor", async () => {
    h.signIn();
    const artifact = server.api.seed({ workspace: "acme" });
    const refused = await h.invoke("transfer", artifact.id, "--to", "personal");
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("Your role on this workspace does not allow this.");
  });
});

describe("the default workspace", () => {
  it("belongs to the account that chose it: another account on the device never uses it", async () => {
    h.signIn();
    await h.invoke("workspaces", "use", "acme");
    const path = join(h.configDir, WORKSPACE_FILE);
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...stored, userId: "u_someone_else" }));
    await h.invoke("list");
    expect(server.api.workspaceParams.at(-1)).toBe("GET /artifacts personal");
    expect((await h.invoke("workspaces")).stdout).toContain("*  personal");
  });

  it("is forgotten on logout", async () => {
    h.signIn();
    await h.invoke("workspaces", "use", "acme");
    const path = join(h.configDir, WORKSPACE_FILE);
    await readFile(path, "utf8");
    expect((await h.invoke("logout")).code).toBe(0);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
