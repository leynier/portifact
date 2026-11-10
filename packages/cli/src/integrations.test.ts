// portifact integrations and portifact issue (decision 0018) against the fake server: what the
// CLI sends (only the parts the flags turn on, one Idempotency-Key for every retry), what it
// prints (labels shown safely, never a credential), and that the thread shows its issue links.
import { join } from "node:path";
import type { AnnotationThreadView } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatThread } from "./annotations.ts";
import type { FakeArtifact } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  h.signIn();
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const CONNECTION = `ic_${"a".repeat(32)}`;

function reviewed(): FakeArtifact {
  const artifact = server.api.seed({ currentVersionId: null, versions: 0 });
  server.api.seedVersion(artifact, { published: { "index.html": "<h1>Hi</h1>" } });
  server.annotations.modes.set(artifact.id, "open");
  return artifact;
}

async function startThread(artifact: FakeArtifact) {
  const folder = await h.files("input", { "c.txt": "First" });
  const result = await h.invoke(
    "annotations",
    "create",
    artifact.id,
    "--body-file",
    join(folder, "c.txt"),
    "--json",
  );
  expect(result.code, result.stdout).toBe(0);
  return JSON.parse(result.stdout) as AnnotationThreadView;
}

function issueRequests() {
  return server.requests.filter((r) => r.method === "POST" && /\/issue$/.test(r.path));
}

describe("portifact integrations", () => {
  it("lists labels and targets, never a credential, and says what is missing", async () => {
    server.api.integrations.set("personal", {
      connections: [
        {
          id: CONNECTION,
          service: "linear",
          label: "Eng\u001b[31m board",
          targets: [{ id: "6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f", name: "Engineering" }],
          usable: false,
        },
      ],
      available: false,
      serviceAvailable: true,
      euResidency: true,
    });
    const result = await h.invoke("integrations");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ID\s+SERVICE\s+LABEL\s+STATE\s+TARGETS$/m);
    expect(result.stdout).toContain("Eng[31m board");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).toContain("needs an admin");
    expect(result.stdout).toContain("Engineering (6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f)");
    expect(result.stdout).toContain("does not include integrations");
    expect(result.stdout).toContain("leaves the EU");
    const json = await h.invoke("integrations", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ connections: [{ id: CONNECTION }] });
  });

  it("says where connections are added when there are none, and when the server offers none", async () => {
    const result = await h.invoke("integrations");
    expect(result.stdout).toContain("Integrations page");
    expect(result.stdout).toContain("does not offer integrations yet");
  });
});

describe("portifact issue", () => {
  it("sends only the link and the name unless --quote or --message, with one Idempotency-Key", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    const result = await h.invoke(
      "issue",
      artifact.id,
      thread.id,
      "--connection",
      CONNECTION,
      "--target",
      "acme/site",
      "--title",
      "Fix the header",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Issue requested in acme/site (ti_${"0".repeat(32)})`);
    const [sent] = issueRequests();
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      connectionId: CONNECTION,
      target: "acme/site",
      title: "Fix the header",
      include: { link: true, artifactName: true, quote: false, message: false },
    });
    expect(sent?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    const opted = await h.invoke(
      "issue",
      artifact.id,
      thread.id,
      "--connection",
      CONNECTION,
      "--target",
      "acme/site",
      "--title",
      "T",
      "--quote",
      "--message",
      "--no-link",
      "--no-name",
      "--json",
    );
    expect(JSON.parse(opted.stdout)).toMatchObject({ state: "pending" });
    expect(JSON.parse(issueRequests()[1]?.body ?? "{}").include).toEqual({
      link: false,
      artifactName: false,
      quote: true,
      message: true,
    });
  });

  it("refuses a connection ID that is not one before calling, and shows the API's refusal", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    const bad = await h.invoke(
      "issue",
      artifact.id,
      thread.id,
      "--connection",
      "github",
      "--target",
      "a/b",
      "--title",
      "T",
    );
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not a connection ID");
    expect(issueRequests()).toHaveLength(0);
    server.annotations.role = "participant";
    const refused = await h.invoke(
      "issue",
      artifact.id,
      thread.id,
      "--connection",
      CONNECTION,
      "--target",
      "a/b",
      "--title",
      "T",
      "--json",
    );
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toEqual({
      error: {
        code: "forbidden",
        message: "Only the artifact's admins and editors can create issues.",
      },
    });
  });

  it("shows a thread's issues: created with its link, pending, and failed with the reason", () => {
    const thread: AnnotationThreadView = {
      id: "t1",
      versionId: "ver_1",
      current: true,
      path: "index.html",
      target: { schema: 1, path: "index.html", anchor: { kind: "document" } },
      state: "open",
      author: null,
      own: false,
      byOwner: true,
      revision: 1,
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T10:00:00.000Z",
      resolvedAt: null,
      messages: [],
      issues: [
        {
          id: `ti_${"1".repeat(32)}`,
          service: "github",
          target: "acme/site",
          state: "created",
          key: "#12",
          url: "https://github.com/acme/site/issues/12",
          failure: null,
          own: false,
          createdAt: "2026-11-07T10:00:00.000Z",
        },
        {
          id: `ti_${"2".repeat(32)}`,
          service: "linear",
          target: "Engineering",
          state: "pending",
          key: null,
          url: null,
          failure: null,
          own: true,
          createdAt: "2026-11-07T10:00:00.000Z",
        },
        {
          id: `ti_${"3".repeat(32)}`,
          service: "github",
          target: "acme/site",
          state: "failed",
          key: null,
          url: null,
          failure: "credential_rejected",
          own: true,
          createdAt: "2026-11-07T10:00:00.000Z",
        },
      ],
    };
    const text = formatThread(thread);
    expect(text).toContain("Issue #12 in acme/site: https://github.com/acme/site/issues/12");
    expect(text).toContain("Issue in Engineering: being created");
    expect(text).toContain(
      "Issue in acme/site failed: The service refused the connection's credential.",
    );
  });
});
