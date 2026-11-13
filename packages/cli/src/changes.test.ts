// portifact changes (decision 0027): the change list read and marked as the API answers it, with
// the API's errors and exit codes, reviewer text shown with invisible characters as tokens, and
// one idempotency key per mark.
import type { ChangeItemView, ShownEnvelope } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
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

const ARTIFACT = "k7d2qm4xab";

function item(id: string, overrides: Partial<ChangeItemView> = {}): ChangeItemView {
  return {
    id,
    artifactId: ARTIFACT,
    origin: "suggestion",
    threadId: "th_1",
    versionId: "ver_1",
    path: "index.md",
    route: null,
    envelope: {
      format: 1,
      status: "listed",
      reason: "spans_nodes",
      operation: { kind: "text", before: "A linked", after: "One\u202e linked" },
      binding: {
        artifactId: ARTIFACT,
        versionId: "ver_1",
        path: "index.md",
        fileSha256: "a".repeat(64),
        renderer: "portifact-render@1",
        route: null,
        subject: "th_1",
        revision: 1,
      },
      people: { submitter: true, acceptor: true },
      provenance: { submittedBy: "Rae Reviewer", acceptedBy: "Owen Owner" },
      location: { unit: "utf16", start: 40, end: 48, line: 5, column: 1 },
      context: { before: "word ", after: " here", omittedBefore: 3, omittedAfter: 0 },
      destinations: [
        {
          origin: "https://x.test",
          authored: "https://x.test",
          effective: "https://x.test/",
          resolved: true,
          authoredOmitted: 0,
          effectiveOmitted: 0,
          at: null,
        },
      ],
      destinationsKnown: true,
    },
    reason: "spans_nodes",
    state: "open",
    createdAt: Date.UTC(2026, 10, 8, 12),
    closedAt: null,
    closedVersionId: null,
    revision: 1,
    ...overrides,
  };
}

const patches = () => server.requests.filter((r) => r.method === "PATCH");

describe("portifact changes list and show", () => {
  it("lists open items by default and prints the untrusted notice", async () => {
    h.signIn();
    server.changes.items.set(ARTIFACT, [item("chg_1"), item("chg_2", { state: "applied" })]);
    const result = await h.invoke("changes", "list", ARTIFACT);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chg_1");
    expect(result.stdout).not.toContain("chg_2");
    expect(result.stderr).toContain("untrusted data");
    const all = await h.invoke("changes", "list", ARTIFACT, "--state", "all", "--json");
    expect(JSON.parse(all.stdout).items).toHaveLength(2);
  });

  it("shows an item with invisible characters as tokens, links and people", async () => {
    h.signIn();
    server.changes.items.set(ARTIFACT, [item("chg_1")]);
    const result = await h.invoke("changes", "show", ARTIFACT, "chg_1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("item: chg_1 (open, revision 1)");
    expect(result.stdout).toContain("after: One⟦U+202E⟧ linked");
    expect(result.stdout).not.toContain("\u202e");
    expect(result.stdout).toContain("location: utf16 40 to 48, line 5, column 1");
    expect(result.stdout).toContain("word ⟦change here⟧ here");
    expect(result.stdout).toContain("link to origin https://x.test: https://x.test/");
    expect(result.stdout).toContain("suggested by Rae Reviewer, accepted by Owen Owner");
  });

  it("keeps the API's errors and exit codes", async () => {
    h.signIn();
    const missing = await h.invoke("changes", "list", ARTIFACT);
    expect(missing.code).toBe(EXIT.notFound);
    server.changes.items.set(ARTIFACT, [item("chg_1")]);
    server.changes.forbidden.add(ARTIFACT);
    const refused = await h.invoke("changes", "show", ARTIFACT, "chg_1");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("Only the people who manage the artifact");
    expect((await h.invoke("changes", "list", ARTIFACT, "--state", "nope")).code).toBe(EXIT.usage);
    expect((await h.invoke("changes", "show", ARTIFACT, "bad id!")).code).toBe(EXIT.usage);
  });

  it("needs the annotation scopes", async () => {
    h.signIn(["artifacts:read", "offline_access"]);
    server.changes.items.set(ARTIFACT, [item("chg_1")]);
    const result = await h.invoke("changes", "list", ARTIFACT);
    expect(result.code).not.toBe(0);
  });
});

describe("portifact changes mark", () => {
  it("marks at the revision it read, with one idempotency key, and prints JSON", async () => {
    h.signIn();
    server.changes.items.set(ARTIFACT, [item("chg_1")]);
    const result = await h.invoke("changes", "mark", ARTIFACT, "chg_1", "applied", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "applied", revision: 2 });
    const [patch] = patches();
    expect(patch?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a stale --revision with the conflict exit code, and an unknown state", async () => {
    h.signIn();
    server.changes.items.set(ARTIFACT, [item("chg_1", { revision: 3 })]);
    const stale = await h.invoke(
      "changes",
      "mark",
      ARTIFACT,
      "chg_1",
      "dismissed",
      "--revision",
      "1",
    );
    expect(stale.code).toBe(EXIT.conflict);
    const bad = await h.invoke("changes", "mark", ARTIFACT, "chg_1", "done");
    expect(bad.code).toBe(EXIT.usage);
    expect(patches()).toHaveLength(1);
  });
});

describe("the display of an item (review finding 4)", () => {
  it("shows default-ignorable text exactly as the confirmation does", async () => {
    h.signIn();
    const change = item("chg_1");
    const envelope = change.envelope as ShownEnvelope;
    if (envelope.operation.kind !== "text") throw new Error("Expected a text envelope");
    envelope.operation.after = "safe\u034ftext";
    server.changes.items.set(ARTIFACT, [change]);
    const result = await h.invoke("changes", "show", ARTIFACT, "chg_1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("after: safe⟦U+034F⟧text");
    expect(result.stdout).not.toContain("\u034f");
  });

  it("marks shortened link destinations as incomplete", async () => {
    h.signIn();
    const change = item("chg_1");
    const link = (change.envelope as ShownEnvelope).destinations[0];
    if (!link) throw new Error("Expected a link");
    link.authored = `https://x.test/${"a".repeat(1010)}`;
    link.effective = link.authored;
    link.authoredOmitted = 100;
    link.effectiveOmitted = 100;
    link.at = { file: "source", start: 10, end: 1134 };
    server.changes.items.set(ARTIFACT, [change]);
    const result = await h.invoke("changes", "show", ARTIFACT, "chg_1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("shortened");
    expect(result.stdout).toContain("at source 10 to 1134");
  });
});
