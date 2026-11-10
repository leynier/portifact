import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSince } from "./logs.ts";
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
const HOUR = 3_600_000;

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

function logRequests() {
  return server.requests.filter((r) => r.method === "GET" && /\/access-log$/.test(r.path));
}

/** No issued token may appear in what the CLI printed. */
function expectNoTokens(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens) {
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  }
}

/** `count` openings, one hour apart, newest first. */
function seedLog(artifactId: string, count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    email: `visitor${i}@example.test`,
    openedAt: new Date(NOW - i * HOUR).toISOString(),
  }));
  server.api.accessLogs.set(artifactId, entries);
  return entries;
}

describe("portifact logs", () => {
  it("lists every opening as a table, following the cursor, with what the log leaves out", async () => {
    h.signIn();
    const artifact = server.api.seed();
    seedLog(artifact.id, 101);
    const result = await h.invoke("logs", artifact.id);
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^OPENED\s+VISITOR$/);
    expect(lines[1]).toMatch(/^2026-11-08 12:00 UTC\s+visitor0@example\.test$/);
    expect(lines[101]).toMatch(/^2026-11-04 08:00 UTC\s+visitor100@example\.test$/);
    expect(lines.at(-1)).toBe(
      "One entry per visitor every 30 minutes, kept 30 days. Only artifacts restricted to listed readers record signed-in openings, share link openings name only the link, your own visits are not recorded, and some openings may be missing.",
    );
    expect(logRequests()).toHaveLength(2);
    expectNoTokens(result);
  });

  it("prints every entry as JSON with --json and says when nobody opened the artifact", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const entries = seedLog(artifact.id, 3);
    const result = await h.invoke("logs", artifact.id, "--json");
    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      artifactId: artifact.id,
      entries,
      nextCursor: null,
      windowMinutes: 30,
      retentionDays: 30,
    });
    const empty = server.api.seed();
    const none = await h.invoke("logs", empty.id);
    expect(none.stdout.split("\n")[0]).toBe(
      `No signed-in visitor opened ${empty.id} in the last 30 days.`,
    );
  });

  it("sends --since as an ISO date, from a duration or a date", async () => {
    h.signIn();
    const artifact = server.api.seed();
    seedLog(artifact.id, 5);
    const recent = await h.invoke("logs", artifact.id, "--since", "2h", "--json");
    // The fake API filters by the date it was sent, like the Worker: 12:00, 11:00 and 10:00.
    expect(json(recent).entries).toHaveLength(3);
    const dated = await h.invoke("logs", artifact.id, "--since", "2026-11-08T11:00:00Z", "--json");
    expect(json(dated).entries).toHaveLength(2);
  });

  it("refuses a bad time or ID before any request, and reports another user's artifact", async () => {
    h.signIn();
    for (const args of [
      ["logs", "nope"],
      ["logs", "abcdefghij", "--since", "yesterday"],
      ["logs", "abcdefghij", "--since", "7w"],
    ]) {
      const result = await h.invoke(...args, "--json");
      expect(result.code).toBe(2);
      expect(json(result).error.code).toBe("invalid_input");
    }
    expect(logRequests()).toEqual([]);
    const missing = await h.invoke("logs", "abcdefghij");
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain("Artifact not found.");
  });

  it("needs artifacts:read", async () => {
    h.signIn(["annotations:read", "offline_access"]);
    const artifact = server.api.seed();
    const result = await h.invoke("logs", artifact.id, "--json");
    expect(result.code).not.toBe(0);
    expect(json(result).error.code).toBe("forbidden");
  });
});

describe("parseSince", () => {
  it("reads minutes, hours, days and ISO dates", () => {
    expect(parseSince("30m", NOW)).toBe("2026-11-08T11:30:00.000Z");
    expect(parseSince(" 12h ", NOW)).toBe("2026-11-08T00:00:00.000Z");
    expect(parseSince("7d", NOW)).toBe("2026-11-01T12:00:00.000Z");
    expect(parseSince("2026-11-01", NOW)).toBe("2026-11-01T00:00:00.000Z");
    expect(parseSince("2026-11-01T08:30:00+02:00", NOW)).toBe("2026-11-01T06:30:00.000Z");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "7", "d7", "1y", "12345d", "Nov 1", "2026-13-40"]) {
      expect(() => parseSince(bad, NOW), bad).toThrow(/is not a time/);
    }
  });
});
