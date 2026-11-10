import type { ArtifactStatsView } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { statsQuery } from "./stats.ts";
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

const NOW = Date.UTC(2026, 10, 8, 12);

function body(artifactId: string, visitors: boolean): ArtifactStatsView {
  return {
    artifactId,
    from: "2026-11-07",
    to: "2026-11-08",
    days: [
      { date: "2026-11-07", views: 12, signedInViews: 3, visitors: visitors ? 2 : null },
      { date: "2026-11-08", views: 0, signedInViews: 0, visitors: visitors ? 0 : null },
    ],
    totals: { views: 12, signedInViews: 3, visitors: visitors ? 2 : null },
    retentionDays: 365,
  };
}

function statsRequests() {
  return server.requests.filter((r) => r.method === "GET" && /\/stats(\?|$)/.test(r.path));
}

describe("portifact stats", () => {
  it("prints the series and the totals as a table, with visitors for restricted artifacts", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.stats.set(artifact.id, body(artifact.id, true));
    const result = await h.invoke("stats", artifact.id);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^DAY\s+VIEWS\s+SIGNED IN\s+VISITORS$/);
    expect(lines[1]).toMatch(/^2026-11-07\s+12\s+3\s+2$/);
    expect(lines[2]).toMatch(/^2026-11-08\s+0\s+0\s+0$/);
    expect(lines[3]).toMatch(/^TOTAL\s+12\s+3\s+2$/);
    expect(lines[4]).toContain("VISITORS counts distinct signed-in readers");
    expect(lines[4]).toContain("Kept 365 days.");
  });

  it("leaves the visitors column out where the artifact keeps no log", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.stats.set(artifact.id, body(artifact.id, false));
    const result = await h.invoke("stats", artifact.id);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^DAY\s+VIEWS\s+SIGNED IN$/);
    expect(lines[3]).toMatch(/^TOTAL\s+12\s+3$/);
    expect(lines[4]).toContain("only for artifacts restricted to listed readers");
  });

  it("prints the API's body as it came with --json", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.stats.set(artifact.id, body(artifact.id, true));
    const result = await h.invoke("stats", artifact.id, "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(body(artifact.id, true));
  });

  it("asks the API for the range the options name", async () => {
    h.signIn();
    const artifact = server.api.seed();
    server.api.stats.set(artifact.id, body(artifact.id, false));
    const ranged = await h.invoke(
      "stats",
      artifact.id,
      "--from",
      "2026-11-01",
      "--to",
      "2026-11-03",
      "--json",
    );
    expect(JSON.parse(ranged.stdout)).toMatchObject({ from: "2026-11-01", to: "2026-11-03" });
    const days = await h.invoke("stats", artifact.id, "--days", "7", "--json");
    expect(JSON.parse(days.stdout)).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
    expect(statsRequests()).toHaveLength(2);
  });

  it("refuses bad options before any request", async () => {
    h.signIn();
    const artifact = server.api.seed();
    for (const args of [
      ["--days", "0"],
      ["--days", "367"],
      ["--days", "7", "--from", "2026-11-01"],
      ["--from", "yesterday"],
    ]) {
      const result = await h.invoke("stats", artifact.id, ...args);
      expect(result.code, args.join(" ")).toBe(EXIT.usage);
    }
    expect(statsRequests()).toHaveLength(0);
  });

  it("answers not_found like the API for an unknown artifact", async () => {
    h.signIn();
    const result = await h.invoke("stats", "zzzzzzzzzz", "--json");
    expect(result.code).toBe(EXIT.notFound);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "not_found", message: "Artifact not found." },
    });
  });
});

describe("statsQuery", () => {
  it("counts --days back from today in UTC", () => {
    expect(String(statsQuery({ days: "1", json: false }, NOW))).toBe("from=2026-11-08");
    expect(String(statsQuery({ days: "30", json: false }, NOW))).toBe("from=2026-10-10");
    expect(String(statsQuery({ days: "366", json: false }, NOW))).toBe("from=2025-11-08");
  });

  it("passes --from and --to as they are", () => {
    expect(String(statsQuery({ from: "2026-01-02", json: false }, NOW))).toBe("from=2026-01-02");
    expect(String(statsQuery({ to: "2026-01-02", json: false }, NOW))).toBe("to=2026-01-02");
    expect(String(statsQuery({ json: false }, NOW))).toBe("");
  });
});
