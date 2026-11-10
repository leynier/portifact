// portifact share (decision 0008): the link's URL is printed once, by create, and never again;
// a password comes from a file, never the command line; revoking asks for a confirmation.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { parseExpiry } from "./share.ts";
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

function bodies(path: RegExp) {
  return server.requests.filter((r) => r.method === "POST" && path.test(r.path));
}

describe("portifact share create", () => {
  it("prints the URL once with what it grants, and sends the label and expiry", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const result = await h.invoke(
      "share",
      "create",
      artifact.id,
      "--label",
      "For Ana",
      "--expires",
      "7d",
    );
    expect(result.code).toBe(0);
    const token = server.api.shareTokens.at(-1) as string;
    expect(result.stdout).toContain(`/s#${token}`);
    expect(result.stdout).toContain(
      "Anyone with this link can read the artifact without an account",
    );
    expect(result.stdout).toContain("It is shown only this once");
    const [link] = server.api.shareLinks.get(artifact.id) ?? [];
    expect(link).toMatchObject({ label: "For Ana", hasPassword: false });
    expect(link?.expiresAt).toBe(new Date(NOW + 7 * 86_400_000).toISOString());
    expect(bodies(/share-links$/)).toHaveLength(1);
  });

  it("reads the password from the first line of a file, never the command line", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const folder = await h.files("secret", { "password.txt": "correct horse\nignored\n" });
    const result = await h.invoke(
      "share",
      "create",
      artifact.id,
      "--label",
      "Board",
      "--password-file",
      join(folder, "password.txt"),
      "--json",
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).link.hasPassword).toBe(true);
    expect(result.stdout).not.toContain("correct horse");

    const empty = await h.files("empty", { "password.txt": "\n" });
    const refused = await h.invoke(
      "share",
      "create",
      artifact.id,
      "--label",
      "Board",
      "--password-file",
      join(empty, "password.txt"),
    );
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("The password file is empty.");
    const missing = await h.invoke(
      "share",
      "create",
      artifact.id,
      "--label",
      "Board",
      "--password-file",
      join(folder, "nope.txt"),
    );
    expect(missing.code).toBe(EXIT.usage);
  });

  it("shows the API's plan_required and exits 7 when the plan has no share links", async () => {
    h.signIn();
    server.api.shareLinksEnabled = false;
    const artifact = server.api.seed();
    const result = await h.invoke("share", "create", artifact.id, "--label", "x");
    expect(result.code).toBe(EXIT.limit);
    expect(result.stderr).toContain("Sharing with links is part of the Pro plan.");
  });

  it("refuses a bad expiry before calling the API", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const result = await h.invoke(
      "share",
      "create",
      artifact.id,
      "--label",
      "x",
      "--expires",
      "soon",
    );
    expect(result.code).toBe(EXIT.usage);
    expect(bodies(/share-links$/)).toHaveLength(0);
  });
});

describe("portifact share list and revoke", () => {
  it("lists links without their URLs and says when the plan pauses them", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("share", "create", artifact.id, "--label", "Board");
    const token = server.api.shareTokens.at(-1) as string;
    const result = await h.invoke("share", "list", artifact.id);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /^ID\s+LABEL\s+STATE\s+PASSWORD\s+EXPIRES\s+LAST USED\s+CREATED$/m,
    );
    expect(result.stdout).toContain("Board");
    expect(result.stdout).not.toContain(token);
    server.api.shareLinksEnabled = false;
    const paused = await h.invoke("share", "list", artifact.id);
    expect(paused.stdout).toContain("so these links do not open");
    const json = JSON.parse((await h.invoke("share", "list", artifact.id, "--json")).stdout);
    expect(json).toMatchObject({ enabled: false, links: [{ label: "Board" }] });
    const none = server.api.seed();
    expect((await h.invoke("share", "list", none.id)).stdout).toContain("has no share links.");
  });

  it("revokes only with --yes or a typed confirmation", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("share", "create", artifact.id, "--label", "Board");
    const [link] = server.api.shareLinks.get(artifact.id) ?? [];
    const id = link?.id as string;
    const refused = await h.invoke("share", "revoke", artifact.id, id);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("--yes");
    const done = await h.invoke("share", "revoke", artifact.id, id, "--yes");
    expect(done.code).toBe(0);
    expect(done.stdout).toContain(`Revoked share link ${id}`);
    expect(server.api.shareLinks.get(artifact.id)).toEqual([]);
    const again = await h.invoke("share", "revoke", artifact.id, id, "--yes", "--json");
    expect(again.code).toBe(EXIT.notFound);
    expect(JSON.parse(again.stdout)).toEqual({
      error: { code: "not_found", message: "Share link not found." },
    });
    expect((await h.invoke("share", "revoke", artifact.id, "nope", "--yes")).code).toBe(EXIT.usage);
  });

  it("asks at the terminal and cancels unless the answer is revoke", async () => {
    const prompted = await createHarness({ server, answers: ["no", "revoke"] });
    prompted.signIn();
    const artifact = server.api.seed();
    await prompted.invoke("share", "create", artifact.id, "--label", "Board");
    const id = (server.api.shareLinks.get(artifact.id) ?? [])[0]?.id as string;
    expect((await prompted.invoke("share", "revoke", artifact.id, id)).code).toBe(EXIT.failure);
    expect((await prompted.invoke("share", "revoke", artifact.id, id)).code).toBe(0);
    expect(prompted.prompts[0]).toContain(`Anyone with share link ${id} loses access`);
    await prompted.cleanup();
  });
});

describe("parseExpiry", () => {
  it("takes hours, days or an ISO date", () => {
    expect(parseExpiry("12h", NOW)).toBe(new Date(NOW + 12 * 3_600_000).toISOString());
    expect(parseExpiry(" 30d ", NOW)).toBe(new Date(NOW + 30 * 86_400_000).toISOString());
    expect(parseExpiry("2026-12-01T00:00:00Z", NOW)).toBe("2026-12-01T00:00:00.000Z");
    for (const bad of ["7w", "tomorrow", "12", ""]) expect(() => parseExpiry(bad, NOW)).toThrow();
  });
});
