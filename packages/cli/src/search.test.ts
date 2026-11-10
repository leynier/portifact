import type { SearchResults } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { markedSnippet } from "./search.ts";
import { type FakeArtifact, listItemOf } from "./testing/fake-api.ts";
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

function results(artifact: FakeArtifact, nextCursor: string | null = null): SearchResults {
  const listed = listItemOf(artifact);
  return {
    items: [
      {
        artifact: listed,
        path: "docs/plan.html",
        snippet: { text: "The quarterly\nroadmap for Q3", highlights: [[4, 13]] },
        partial: true,
      },
    ],
    nextCursor,
  };
}

describe("portifact search", () => {
  it("prints each artifact with its file and the snippet, highlights marked", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.search.set("personal", results(artifact));
    const result = await h.invoke("search", "quarterly");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${artifact.id}  ${artifact.name}  docs/plan.html (partly indexed)\n  The «quarterly» roadmap for Q3\n`,
    );
    expect(server.api.searchQueries).toEqual(["?q=quarterly"]);
  });

  it("passes the workspace, limit and cursor, and says how to get the next page", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.search.set("team", results(artifact, "abc"));
    const result = await h.invoke(
      "search",
      "a b",
      "--workspace",
      "team",
      "--limit",
      "5",
      "--cursor",
      "xyz",
    );
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("Workspace: team\n")).toBe(true);
    expect(result.stderr).toContain("--cursor abc --workspace team");
    expect(server.api.searchQueries).toEqual(["?q=a+b&limit=5&cursor=xyz&workspace=team"]);
  });

  it("prints the API's body with --json and says when nothing matches", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.search.set("personal", results(artifact));
    const json = await h.invoke("search", "x", "--json");
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(results(artifact))));
    server.api.search.set("personal", { items: [], nextCursor: null });
    expect((await h.invoke("search", "x")).stdout).toBe("No artifact's text matches every word.\n");
  });

  it("refuses an empty or oversized query and a bad limit before calling the API", async () => {
    h.signIn();
    for (const args of [
      ["search", "  "],
      ["search", "x".repeat(201)],
      ["search", "x", "--limit", "51"],
    ]) {
      const result = await h.invoke(...args);
      expect(result.code, args.join(" ")).toBe(EXIT.usage);
    }
    expect(server.api.searchQueries).toEqual([]);
  });

  it("answers a missing workspace like the API", async () => {
    h.signIn();
    const result = await h.invoke("search", "x", "--workspace", "nope");
    expect(result.code).toBe(EXIT.notFound);
    expect(result.stderr).toContain("Workspace not found.");
  });
});

describe("markedSnippet", () => {
  it("marks ranges, skips ranges out of order or bounds and keeps one line", () => {
    expect(
      markedSnippet({
        text: "a b c",
        highlights: [
          [0, 1],
          [4, 5],
        ],
      }),
    ).toBe("«a» b «c»");
    expect(
      markedSnippet({
        text: "abc",
        highlights: [
          [2, 3],
          [0, 1],
          [1, 9],
          [1, 1],
        ],
      }),
    ).toBe("ab«c»");
    expect(markedSnippet({ text: "x\n\ty", highlights: [] })).toBe("x y");
  });
});
