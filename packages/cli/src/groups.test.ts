// Workspace groups in the CLI (premium plan T3, decision 0014): listing a workspace's groups and
// listing or unlisting them on an artifact through `portifact access`. Managing groups has no
// command: it is the dashboard's.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeArtifact } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

const DESIGN = `wg_${"1".repeat(32)}`;
const RESEARCH = `wg_${"2".repeat(32)}`;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.api.workspaces = [
    { slug: "acme", name: "Acme Docs", role: "editor" },
    { slug: "readers", name: "Readers", role: "member" },
  ];
  server.api.groups.set("acme", [
    { id: DESIGN, name: "Design", members: 3, createdAt: "2026-11-01T00:00:00.000Z" },
    { id: RESEARCH, name: "Research‮", members: 1, createdAt: "2026-11-01T00:00:00.000Z" },
  ]);
  server.api.usage.plan.features = [...server.api.usage.plan.features, "workspaces"];
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const seed = (overrides: Partial<FakeArtifact> = {}) =>
  server.api.seed({ workspace: "acme", ...overrides });
const patches = () =>
  server.requests.filter((r) => r.method === "PATCH" && /\/access$/.test(r.path));

describe("portifact workspaces groups", () => {
  it("lists IDs, member counts and names, never members, with terminal-safe names", async () => {
    h.signIn();
    const result = await h.invoke("workspaces", "groups", "acme");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "ID                                   MEMBERS  NAME",
        `${DESIGN}  3        Design`,
        `${RESEARCH}  1        Research`,
        "",
      ].join("\n"),
    );
    const json = await h.invoke("workspaces", "groups", "acme", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ available: true, items: [{ id: DESIGN }, {}] });
  });

  it("says when there are none, when the plan lapsed, and passes the server's refusals on", async () => {
    h.signIn();
    server.api.groups.set("acme", []);
    server.api.usage.plan.features = [];
    const empty = await h.invoke("workspaces", "groups", "acme");
    expect(empty.stdout).toContain("acme has no groups.");
    expect(empty.stderr).toContain("groups let nobody read until it does again");
    const member = await h.invoke("workspaces", "groups", "readers");
    expect(member.code).not.toBe(0);
    expect(member.stderr).toContain("Your role on this workspace does not allow this.");
    const bad = await h.invoke("workspaces", "groups", "Not A Slug");
    expect(bad.code).toBe(2);
  });
});

describe("portifact access group", () => {
  it("adds and removes groups by ID and shows them with their exceptions", async () => {
    h.signIn();
    const artifact = seed();
    const added = await h.invoke("access", "group", "add", artifact.id, DESIGN, RESEARCH);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(`Groups         Design (${DESIGN}, 3 members)`);
    expect(JSON.parse(patches()[0]?.body ?? "")).toEqual({ addGroups: [DESIGN, RESEARCH] });

    const exception = await h.invoke("access", "group-comments", artifact.id, DESIGN, "all");
    expect(exception.stdout).toContain(`Design (${DESIGN}, 3 members, sees all comments)`);
    expect(JSON.parse(patches()[1]?.body ?? "")).toEqual({
      groupCommentVisibility: [{ group: DESIGN, commentVisibility: "all" }],
    });

    const removed = await h.invoke("access", "group", "remove", artifact.id, RESEARCH, "--json");
    expect(JSON.parse(removed.stdout).groups).toEqual([
      { id: DESIGN, name: "Design", members: 3, commentVisibility: "all" },
    ]);
  });

  it("notes that groups grant only in restricted mode", async () => {
    h.signIn();
    const artifact = seed();
    if (artifact.access) artifact.access.mode = "authenticated";
    const added = await h.invoke("access", "group", "add", artifact.id, DESIGN);
    expect(added.stderr).toContain("groups let their members read only after");
  });

  it("refuses anything but group IDs and a known visibility before any request", async () => {
    h.signIn();
    const artifact = seed();
    const name = await h.invoke("access", "group", "add", artifact.id, "Design");
    expect(name.code).toBe(2);
    expect(name.stderr).toContain('"Design" is not a group ID.');
    const many = await h.invoke(
      "access",
      "group",
      "add",
      artifact.id,
      ...Array.from({ length: 21 }, () => DESIGN),
    );
    expect(many.code).toBe(2);
    expect(many.stderr).toContain("at most 20 groups");
    const visibility = await h.invoke("access", "group-comments", artifact.id, DESIGN, "some");
    expect(visibility.code).toBe(2);
    expect(patches()).toHaveLength(0);
  });

  it("passes the server's refusal for a group of another workspace on", async () => {
    h.signIn();
    const artifact = seed();
    const foreign = `wg_${"9".repeat(32)}`;
    const result = await h.invoke("access", "group", "add", artifact.id, foreign);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${foreign} is not a group of this workspace.`);
  });
});
