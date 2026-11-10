import { PLANS } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "./artifacts.ts";
import type { FakeArtifact } from "./testing/fake-api.ts";
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

const NOW = Date.parse("2026-11-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function seed(overrides: Partial<FakeArtifact> = {}) {
  return server.api.seed({ createdAt: NOW - DAY, updatedAt: NOW - DAY, ...overrides });
}

function requests(method: string, path: RegExp) {
  return server.requests.filter((r) => r.method === method && path.test(r.path));
}

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

describe("portifact list", () => {
  it("lists artifacts as a table and points to the next page", async () => {
    h.signIn();
    const first = seed({ name: "Launch plan", expiresAt: NOW + 30 * DAY });
    seed({ name: "Old notes", type: "text", state: "archived", expiresAt: null });

    const result = await h.invoke("list", "--limit", "1");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "ID          STATE   ACCESS      TYPE  EXPIRES     NAME",
        `${first.id}  active  restricted  site  2026-12-08  Launch plan`,
        "",
      ].join("\n"),
    );
    expect(result.stderr).toContain("More artifacts: run `portifact list --cursor c1`.");
    expect(requests("GET", /^\/api\/v1\/artifacts$/)[0]?.headers).toMatchObject({
      accept: "application/json",
    });

    const next = await h.invoke("list", "--cursor", "c1", "--limit", "1");
    expect(next.stdout).toContain("archived");
    expect(next.stdout).toContain("never");
    expect(next.stderr).not.toContain("More artifacts");
  });

  it("prints the API page unchanged with --json", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("list", "--json");

    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      items: [
        {
          id: artifact.id,
          name: "Seeded report",
          type: "site",
          state: "active",
          accessMode: "restricted",
          annotations: "off",
          currentVersionId: artifact.currentVersionId,
          url: `https://${artifact.id}.portifact.dev/`,
          owner: { kind: "personal" },
          expiresAt: "2026-12-08T12:00:00.000Z",
          archivedAt: null,
          purgeAt: null,
          pinned: false,
          key: null,
          createdAt: "2026-11-07T12:00:00.000Z",
          updatedAt: "2026-11-07T12:00:00.000Z",
          // The fake seeds no versions or threads for this artifact.
          activity: { versions: 0, currentBytes: null, openThreads: 0, lastAnnotationAt: null },
          review: { status: "none", reviewers: 0, required: 0, approvals: 0, changesRequested: 0 },
        },
      ],
      nextCursor: null,
    });
  });

  it("says when there is nothing to list", async () => {
    h.signIn();
    const result = await h.invoke("list");
    expect(result).toMatchObject({
      code: 0,
      stdout: "No artifacts yet. Publish one with `portifact publish <path>`.\n",
    });
  });

  it("rejects a page size outside 1 to 100 before any request", async () => {
    h.signIn();
    for (const limit of ["0", "101", "2.5", "many"]) {
      const result = await h.invoke("list", "--limit", limit);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Use a whole number from 1 to 100.");
    }
    expect(server.requests).toHaveLength(0);
  });

  it("searches and filters on the server, and repeats the filters for the next page", async () => {
    h.signIn();
    const plan = seed({ name: "Launch plan", updatedAt: NOW - DAY });
    const rollout = seed({ name: "Launch rollout", updatedAt: NOW - 2 * DAY });
    seed({ name: "Old launch notes", type: "text", state: "archived", updatedAt: NOW - 3 * DAY });
    seed({ name: "Budget", updatedAt: NOW - 4 * DAY });

    const result = await h.invoke(
      "list",
      "--search",
      "  LAUNCH ",
      "--state",
      "active",
      "--type",
      "site",
      "--access",
      "restricted",
      "--annotations",
      "off",
      "--limit",
      "1",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(plan.id);
    expect(result.stdout).not.toContain(rollout.id);
    expect(result.stderr).toContain(
      "More artifacts: run `portifact list --cursor c1 --search LAUNCH --state active --type site --access restricted --annotations off`.",
    );

    const next = await h.invoke("list", "--search", "launch", "--state", "active", "--json");
    expect(json(next).items.map((item: { id: string }) => item.id)).toEqual([plan.id, rollout.id]);

    const spaced = await h.invoke("list", "--search", "it's launch", "--limit", "1");
    expect(spaced.stdout).toBe("No artifacts match these filters.\n");
    seed({ name: "it's launch day" });
    seed({ name: "it's launch eve" });
    const quoted = await h.invoke("list", "--search", "it's launch", "--limit", "1");
    expect(quoted.stderr).toContain("--cursor c1 --search 'it'\\''s launch'`.");
  });

  it("refuses an unknown filter value or an empty search before any request", async () => {
    h.signIn();
    for (const args of [
      ["--state", "deleted"],
      ["--type", "pdf"],
      ["--access", "private"],
      ["--annotations", "on"],
      ["--search", "   "],
      ["--search", "x".repeat(201)],
    ]) {
      const result = await h.invoke("list", ...args);
      expect(result.code, args.join(" ")).toBe(2);
    }
    const search = await h.invoke("list", "--search", "");
    expect(search.stderr).toContain("Search for 1 to 200 characters.");
    expect(server.requests).toHaveLength(0);
  });

  it("reports a cursor the server refuses as invalid input", async () => {
    h.signIn();
    const result = await h.invoke("list", "--cursor", "bogus", "--json");
    expect(result.code).toBe(2);
    expect(json(result).error.code).toBe("invalid_input");
  });

  it("refreshes a token the API refuses and retries the request once", async () => {
    h.signIn();
    for (const access of server.accessTokens.values()) access.revoked = true;
    seed();

    const result = await h.invoke("list", "--json");

    expect(result.code).toBe(0);
    expect(requests("GET", /^\/api\/v1\/artifacts$/)).toHaveLength(2);
    expect(requests("POST", /\/oauth2\/token$/)).toHaveLength(1);
  });

  it("refreshes an expired access token and retries the request", async () => {
    h.signIn();
    h.advance(2 * 60 * 60 * 1000);
    seed();

    const result = await h.invoke("list", "--json");

    expect(result.code).toBe(0);
    expect(json(result).items).toHaveLength(1);
    expect(requests("POST", /\/oauth2\/token$/)).toHaveLength(1);
  });
});

describe("portifact info", () => {
  it("shows an artifact's details", async () => {
    h.signIn();
    const artifact = seed({ name: "Launch plan" });

    const result = await h.invoke("info", artifact.id);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        `ID           ${artifact.id}`,
        "Name         Launch plan",
        "Type         site",
        "State        active",
        "Access       restricted",
        "Annotations  off",
        `URL          https://${artifact.id}.portifact.dev/`,
        "Space        Personal space",
        "Pinned       no",
        "Expires      2026-12-08 12:00 UTC",
        "Archived     never",
        "Purge        never",
        "Created      2026-11-07 12:00 UTC",
        "Updated      2026-11-07 12:00 UTC",
        "",
      ].join("\n"),
    );
  });

  it("says why a suspended artifact is suspended", async () => {
    h.signIn();
    const artifact = seed({ name: "Held", suspensionReason: "phishing" });
    const result = await h.invoke("info", artifact.id);
    expect(result.stdout).toContain("State        suspended\n");
    expect(result.stdout).toContain(
      "Suspended    phishing; write to abuse@portifact.com to appeal\n",
    );
    const asJson = json(await h.invoke("info", artifact.id, "--json"));
    expect(asJson).toMatchObject({ state: "suspended", suspension: { reason: "phishing" } });
  });

  it("prints the artifact summary with --json", async () => {
    h.signIn();
    const artifact = seed();
    const result = await h.invoke("info", artifact.id, "--json");
    expect(json(result)).toMatchObject({
      id: artifact.id,
      state: "active",
      accessMode: "restricted",
    });
  });

  it("rejects a malformed ID without a request and reports a missing artifact", async () => {
    h.signIn();

    const malformed = await h.invoke("info", "ABC/../x", "--json");
    expect(malformed.code).toBe(2);
    expect(json(malformed).error.code).toBe("invalid_input");
    expect(server.requests).toHaveLength(0);

    const missing = await h.invoke("info", "aaaaaaaaaa");
    expect(missing.code).toBe(5);
    expect(missing.stderr).toMatch(/\nError: Artifact not found\.\n$/);
  });

  it("reports an unexpected server answer without its body", async () => {
    h.signIn();
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/artifacts\//,
      reply: { status: 200, body: { leaked: "secret-detail" } },
    });
    server.faults.push({ method: "GET", path: /^\/api\/v1\/artifacts\//, reply: { status: 502 } });
    server.faults.push({ method: "GET", path: /^\/api\/v1\/artifacts\//, reply: { status: 429 } });

    const shape = await h.invoke("info", "aaaaaaaaaa", "--json");
    expect(shape.code).toBe(1);
    expect(json(shape).error.code).toBe("server_error");
    expect(shape.stdout).not.toContain("secret-detail");

    const down = await h.invoke("info", "aaaaaaaaaa", "--json");
    expect(json(down).error.code).toBe("server_error");

    const limited = await h.invoke("info", "aaaaaaaaaa", "--json");
    expect(limited.code).toBe(1);
    expect(json(limited).error.code).toBe("rate_limited");
  });

  it("reports an unreachable server as a network error", async () => {
    h.signIn();
    server.faults.push({ method: "GET", path: /^\/api\/v1\/artifacts\//, drop: "before" });
    const result = await h.invoke("info", "aaaaaaaaaa", "--json");
    expect(result.code).toBe(1);
    expect(json(result).error.code).toBe("network_error");
  });
});

describe("portifact renew, archive and restore", () => {
  it("renews an active artifact for another 30 days", async () => {
    h.signIn();
    const artifact = seed({ expiresAt: NOW + DAY });
    h.advance(DAY / 2);

    const result = await h.invoke("renew", artifact.id);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Renewed ${artifact.id}. It stays published until 2026-12-09 00:00 UTC.\n`,
    );
    expect(requests("POST", /\/renew$/)).toHaveLength(1);
  });

  it("archives and restores an artifact, with stable JSON", async () => {
    h.signIn();
    const artifact = seed();

    const archived = await h.invoke("archive", artifact.id, "--json");
    expect(archived.code).toBe(0);
    expect(json(archived)).toEqual({
      artifactId: artifact.id,
      state: "archived",
      expiresAt: null,
      purgeAt: "2027-05-09T12:00:00.000Z",
      pinned: false,
    });

    const text = await h.invoke("info", artifact.id);
    expect(text.stdout).toContain("State        archived");

    const restored = await h.invoke("restore", artifact.id);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toBe(
      `Restored ${artifact.id}. It stays published until 2026-12-08 12:00 UTC.\n`,
    );
  });

  it("explains how to restore after archiving", async () => {
    h.signIn();
    const artifact = seed();
    const result = await h.invoke("archive", artifact.id);
    expect(result.stdout).toBe(
      `Archived ${artifact.id}. Restore it with \`portifact restore ${artifact.id}\` before 2027-05-09 12:00 UTC, or it is deleted permanently.\n`,
    );
  });

  it("refuses to renew an archived artifact with the conflict exit code", async () => {
    h.signIn();
    const artifact = seed({ state: "archived", expiresAt: null });

    const result = await h.invoke("renew", artifact.id, "--json");

    expect(result.code).toBe(6);
    expect(json(result).error.code).toBe("artifact_archived");
  });
});

describe("portifact pin and unpin", () => {
  const onPro = () => {
    server.api.usage.plan = {
      ...server.api.usage.plan,
      name: "pro",
      features: [...PLANS.pro.features],
    };
  };

  it("pins an artifact on a plan with pin, and info and list show it", async () => {
    h.signIn();
    onPro();
    const artifact = seed();

    const result = await h.invoke("pin", artifact.id);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Pinned ${artifact.id}. It stays published with no expiry until you run \`portifact unpin ${artifact.id}\`.\n`,
    );
    expect(requests("POST", /\/pin$/)).toHaveLength(1);

    const info = await h.invoke("info", artifact.id);
    expect(info.stdout).toContain("Pinned       yes, no expiry");
    expect(info.stdout).toContain("Expires      never");
    const listed = await h.invoke("list");
    expect(listed.stdout).toMatch(new RegExp(`^${artifact.id} +active +\\S+ +\\S+ +pinned `, "m"));
    expect(json(await h.invoke("info", artifact.id, "--json"))).toMatchObject({
      pinned: true,
      expiresAt: null,
    });
  });

  it("pins with stable JSON, and pinning again changes nothing", async () => {
    h.signIn();
    onPro();
    const artifact = seed();
    const expected = {
      artifactId: artifact.id,
      state: "active",
      expiresAt: null,
      purgeAt: null,
      pinned: true,
    };
    expect(json(await h.invoke("pin", artifact.id, "--json"))).toEqual(expected);
    expect(json(await h.invoke("pin", artifact.id, "--json"))).toEqual(expected);
  });

  it("unpins with a fresh 30 days, on any plan", async () => {
    h.signIn();
    const artifact = seed({ pinned: true, expiresAt: null });

    const result = await h.invoke("unpin", artifact.id);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Unpinned ${artifact.id}. It stays published until 2026-12-08 12:00 UTC unless you renew it.\n`,
    );
    expect(json(await h.invoke("unpin", artifact.id, "--json"))).toEqual({
      artifactId: artifact.id,
      state: "active",
      expiresAt: "2026-12-08T12:00:00.000Z",
      purgeAt: null,
      pinned: false,
    });
  });

  it("says a pinned artifact has nothing to renew", async () => {
    h.signIn();
    const artifact = seed({ pinned: true, expiresAt: null });
    const result = await h.invoke("renew", artifact.id);
    expect(result.stdout).toBe(`${artifact.id} is pinned, so it has no expiry to renew.\n`);
  });

  it("refuses to pin an archived artifact with the conflict exit code", async () => {
    h.signIn();
    onPro();
    const artifact = seed({ state: "archived", expiresAt: null });
    const result = await h.invoke("pin", artifact.id, "--json");
    expect(result.code).toBe(6);
    expect(json(result).error.code).toBe("artifact_archived");
  });

  it("checks the ID before any request", async () => {
    h.signIn();
    const result = await h.invoke("pin", "not an id", "--json");
    expect(result.code).toBe(2);
    expect(requests("POST", /\/pin$/)).toHaveLength(0);
  });
});

describe("portifact delete", () => {
  it("deletes without a prompt when --yes is given", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("delete", artifact.id, "--yes", "--json");

    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      artifactId: artifact.id,
      state: "deleted",
      expiresAt: null,
      purgeAt: null,
      pinned: false,
    });
    expect(server.api.artifacts.get(artifact.id)?.state).toBe("deleted");
  });

  it("refuses to delete without --yes when nobody can answer a prompt", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("delete", artifact.id, "--json");

    expect(result.code).toBe(2);
    expect(json(result).error).toEqual({
      code: "invalid_input",
      message: `Deleting is permanent. Run \`portifact delete ${artifact.id} --yes\` to confirm without a prompt.`,
    });
    expect(server.requests).toHaveLength(0);
    expect(server.api.artifacts.get(artifact.id)?.state).toBe("active");
  });

  it("deletes after the person types the artifact ID", async () => {
    const prompted = await createHarness({ server, answers: [""] });
    try {
      prompted.signIn();
      const artifact = seed({ name: "Launch plan" });
      prompted.prompts.length = 0;
      (prompted.runtime.prompt as unknown) = async (question: string) => {
        prompted.prompts.push(question);
        return ` ${artifact.id.toUpperCase()} `;
      };

      const result = await prompted.invoke("delete", artifact.id);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`Deleted ${artifact.id} permanently.\n`);
      expect(prompted.prompts).toEqual([
        `This permanently deletes "Launch plan" (${artifact.id}) and every version of it. It cannot be undone.\nType the artifact ID to confirm: `,
      ]);
      expect(server.api.artifacts.get(artifact.id)?.state).toBe("deleted");
    } finally {
      await prompted.cleanup();
    }
  });

  it("keeps the artifact when the confirmation does not match", async () => {
    const prompted = await createHarness({ server, answers: ["yes"] });
    try {
      prompted.signIn();
      const artifact = seed();

      const result = await prompted.invoke("delete", artifact.id, "--json");

      expect(result.code).toBe(1);
      expect(json(result).error.code).toBe("cancelled");
      expect(requests("DELETE", /^\/api\/v1\/artifacts\//)).toHaveLength(0);
      expect(server.api.artifacts.get(artifact.id)?.state).toBe("active");
    } finally {
      await prompted.cleanup();
    }
  });

  it("needs the delete scope", async () => {
    h.signIn(["artifacts:read", "artifacts:write", "offline_access"]);
    const artifact = seed();

    const result = await h.invoke("delete", artifact.id, "--yes", "--json");

    expect(result.code).toBe(5);
    expect(json(result).error.code).toBe("forbidden");
    expect(server.api.artifacts.get(artifact.id)?.state).toBe("active");
  });
});

describe("portifact access", () => {
  it("shows who can open an artifact", async () => {
    h.signIn();
    const artifact = seed({
      access: {
        mode: "restricted",
        readers: ["ana@example.test", "bo@example.test"],
        indexable: false,
        embeddable: true,
        bar: true,
        commentVisibility: "owner",
        readerCommentVisibility: [{ email: "bo@example.test", commentVisibility: "all" }],
      },
    });

    const text = await h.invoke("access", artifact.id);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(
      [
        "Access         restricted",
        "Readers        ana@example.test, bo@example.test (sees all comments)",
        "Comments       owner (each reader sees their own threads and yours)",
        "Indexable      no",
        "Embeddable     yes",
        "Portifact bar  on",
        "",
      ].join("\n"),
    );

    const output = await h.invoke("access", artifact.id, "--json");
    expect(json(output)).toEqual({
      artifactId: artifact.id,
      mode: "restricted",
      readers: ["ana@example.test", "bo@example.test"],
      indexable: false,
      embeddable: true,
      bar: true,
      commentVisibility: "owner",
      readerCommentVisibility: [{ email: "bo@example.test", commentVisibility: "all" }],
      policyGeneration: 1,
      audience: null,
    });
  });

  it("shows who a workspace artifact reaches, and says when a lapsed plan leaves members only", async () => {
    h.signIn();
    const artifact = seed();
    const stored = server.api.artifacts.get(artifact.id);
    if (!stored) throw new Error("seeded");
    stored.access.mode = "domain";
    stored.audience = { members: 3, domains: ["acme.com"], featureAvailable: true };
    const text = await h.invoke("access", artifact.id);
    expect(text.stdout).toContain("Workspace      3 members; verified domains acme.com\n");
    expect(text.stdout).not.toContain("only its members");

    stored.audience = { members: 1, domains: [], featureAvailable: false };
    const lapsed = await h.invoke("access", artifact.id);
    expect(lapsed.stdout).toContain("Workspace      1 member; no verified email domain\n");
    expect(lapsed.stdout).toContain(
      "Note: the workspace's plan does not include workspace sharing now, so only its members read this artifact until it does again.",
    );
    stored.access.mode = "workspace";
    expect((await h.invoke("access", artifact.id)).stdout).not.toContain("Note:");
  });

  it("chooses who sees comments and rejects anything but owner or everyone", async () => {
    h.signIn();
    const artifact = seed();

    const everyone = await h.invoke("access", "comments", artifact.id, "everyone");
    expect(everyone.code).toBe(0);
    expect(everyone.stdout).toContain("Comments       everyone (every reader sees every thread)\n");
    expect(JSON.parse(requests("PATCH", /\/access$/)[0]?.body ?? "")).toEqual({
      commentVisibility: "everyone",
    });
    expect(server.api.artifacts.get(artifact.id)?.access.commentVisibility).toBe("everyone");

    const wrong = await h.invoke("access", "comments", artifact.id, "readers", "--json");
    expect(wrong.code).toBe(2);
    expect(json(wrong).error.message).toContain("Use owner or everyone.");
    expect(requests("PATCH", /\/access$/)).toHaveLength(1);
  });

  it("sets and clears one reader's exception, refusing a bad value or address before any request", async () => {
    h.signIn();
    const artifact = seed();
    await h.invoke("access", "add", artifact.id, "ana@example.test");

    const all = await h.invoke("access", "reader-comments", artifact.id, "Ana@Example.test", "all");
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("Readers        ana@example.test (sees all comments)\n");
    expect(JSON.parse(requests("PATCH", /\/access$/)[1]?.body ?? "")).toEqual({
      readerCommentVisibility: [{ email: "ana@example.test", commentVisibility: "all" }],
    });
    const own = await h.invoke(
      "access",
      "reader-comments",
      artifact.id,
      "ana@example.test",
      "own",
      "--json",
    );
    expect(json(own)).toMatchObject({
      readerCommentVisibility: [{ email: "ana@example.test", commentVisibility: "own" }],
    });
    const inherit = await h.invoke(
      "access",
      "reader-comments",
      artifact.id,
      "ana@example.test",
      "inherit",
    );
    expect(inherit.stdout).toContain("Readers        ana@example.test\n");

    const before = requests("PATCH", /\/access$/).length;
    const bad = await h.invoke(
      "access",
      "reader-comments",
      artifact.id,
      "ana@example.test",
      "some",
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Use all, own or inherit.");
    const badEmail = await h.invoke("access", "reader-comments", artifact.id, "ana", "all");
    expect(badEmail.code).toBe(2);
    expect(requests("PATCH", /\/access$/)).toHaveLength(before);
  });

  it("turns the Portifact bar off and on", async () => {
    h.signIn();
    const artifact = seed();

    const off = await h.invoke("access", "bar", artifact.id, "off");
    expect(off.code).toBe(0);
    expect(off.stdout).toContain(`Updated access to ${artifact.id}.\n`);
    expect(off.stdout).toContain("Portifact bar  off\n");
    expect(JSON.parse(requests("PATCH", /\/access$/)[0]?.body ?? "")).toEqual({ bar: false });
    expect(server.api.artifacts.get(artifact.id)?.access.bar).toBe(false);

    const on = await h.invoke("access", "bar", artifact.id, "on", "--json");
    expect(json(on)).toMatchObject({ artifactId: artifact.id, bar: true });
  });

  it("rejects a bar state other than on or off before any request", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("access", "bar", artifact.id, "yes", "--json");

    expect(result.code).toBe(2);
    expect(json(result).error.message).toContain("Use on or off.");
    expect(server.requests).toHaveLength(0);
  });

  it("sets the access mode", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("access", "set", artifact.id, "authenticated");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Updated access to ${artifact.id}.\nAccess         authenticated\n`,
    );
    expect(JSON.parse(requests("PATCH", /\/access$/)[0]?.body ?? "")).toEqual({
      mode: "authenticated",
    });
    expect(server.api.artifacts.get(artifact.id)?.access.mode).toBe("authenticated");
  });

  it("rejects an unknown mode before any request", async () => {
    h.signIn();
    const artifact = seed();

    const result = await h.invoke("access", "set", artifact.id, "everyone", "--json");

    expect(result.code).toBe(2);
    expect(json(result).error.message).toContain(
      "Use restricted, authenticated, public, workspace or domain.",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("reports an account too new to make an artifact public", async () => {
    h.signIn();
    server.api.tooNewForPublic = true;
    const artifact = seed();

    const result = await h.invoke("access", "set", artifact.id, "public", "--json");

    expect(result.code).toBe(7);
    expect(json(result).error.code).toBe("account_too_new_for_public");
    expect(server.api.artifacts.get(artifact.id)?.access.mode).toBe("restricted");
  });

  it("adds and removes readers, lowercasing their addresses", async () => {
    h.signIn();
    const artifact = seed();

    const added = await h.invoke(
      "access",
      "add",
      artifact.id,
      "Ana@Example.TEST",
      "bo@example.test",
      "--json",
    );
    expect(added.code).toBe(0);
    expect(json(added).readers).toEqual(["ana@example.test", "bo@example.test"]);
    expect(added.stderr).not.toContain("Note:");

    const removed = await h.invoke("access", "remove", artifact.id, "bo@example.test");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Readers        ana@example.test\n");
    expect(JSON.parse(requests("PATCH", /\/access$/)[1]?.body ?? "")).toEqual({
      removeReaders: ["bo@example.test"],
    });
  });

  it("notes that readers apply only while access is restricted", async () => {
    h.signIn();
    const artifact = seed({
      access: {
        mode: "authenticated",
        readers: [],
        indexable: false,
        embeddable: false,
        bar: true,
        commentVisibility: "owner",
        readerCommentVisibility: [],
      },
    });

    const result = await h.invoke("access", "add", artifact.id, "ana@example.test");

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Note: access is authenticated");
  });

  it("rejects invalid addresses and too many readers before any request", async () => {
    h.signIn();
    const artifact = seed();

    const invalid = await h.invoke(
      "access",
      "add",
      artifact.id,
      "ana@example.test",
      "not-an-email",
    );
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('"not-an-email" is not a valid email address.');

    const many = Array.from({ length: 101 }, (_, i) => `r${i}@example.test`);
    const tooMany = await h.invoke("access", "add", artifact.id, ...many);
    expect(tooMany.code).toBe(2);
    expect(tooMany.stderr).toContain("at most 100 readers");
    expect(server.requests).toHaveLength(0);
  });

  it("needs the share scope to change access", async () => {
    h.signIn(["artifacts:read", "artifacts:write", "offline_access"]);
    const artifact = seed();

    const shown = await h.invoke("access", artifact.id);
    expect(shown.code).toBe(0);

    const result = await h.invoke("access", "set", artifact.id, "public", "--json");
    expect(result.code).toBe(5);
    expect(json(result).error.code).toBe("forbidden");
  });
});

describe("table", () => {
  it("pads every column but the last", () => {
    expect(
      table([
        ["a", "bb", "c"],
        ["ddd", "e", "ffff"],
      ]),
    ).toBe("a    bb  c\nddd  e   ffff\n");
  });
});
