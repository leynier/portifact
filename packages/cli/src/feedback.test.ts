import type { FeedbackItem } from "@portifact/contracts";
import { planRequiredMessage, UNTRUSTED_ANNOTATIONS_NOTICE } from "@portifact/contracts";
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

const NOW = Date.UTC(2026, 10, 8, 12);

function item(
  artifactId: string,
  threadId: string,
  body: string | null,
  extra: Partial<FeedbackItem["thread"]> = {},
): FeedbackItem {
  return {
    artifact: {
      id: artifactId,
      name: "Plan",
      type: "markdown",
      url: `https://${artifactId}.portifact.dev/`,
    },
    thread: {
      id: threadId,
      versionId: "ver_1",
      current: true,
      path: "index.md",
      target: { schema: 1, path: "index.md", anchor: { kind: "document" } },
      state: "open",
      author: { id: "u_2", name: "Rev\u001b[31miewer", image: null },
      own: false,
      byOwner: false,
      revision: 1,
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T11:30:00.000Z",
      resolvedAt: null,
      messages: [
        {
          id: "m1",
          author: { id: "u_2", name: "Reviewer", image: null },
          own: false,
          state: body === null ? "hidden" : "visible",
          body,
          revision: 1,
          createdAt: "2026-11-07T10:00:00.000Z",
          editedAt: null,
        },
      ],
      ...extra,
    },
    counts: { messages: 1, artifactOpenThreads: 2 },
  };
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function feedbackRequests() {
  return server.requests.filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/feedback"));
}

describe("portifact feedback", () => {
  it("prints the open threads as a table, with reviewer text made plain, and the notice", async () => {
    h.signIn();
    server.api.feedback.set("personal", [
      item(
        "abcdefghij",
        T1,
        "Please fix\nthe \u001b[2Jintro paragraph, it repeats the title and then the title again",
      ),
      item("bcdefghijk", T2, null),
    ]);
    const result = await h.invoke("feedback");
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^UPDATED\s+ARTIFACT\s+THREAD\s+MESSAGES\s+AUTHOR\s+FIRST MESSAGE$/);
    expect(lines[1]).toMatch(
      new RegExp(
        `^2026-11-07 11:30 UTC\\s+abcdefghij\\s+${T1}\\s+1\\s+Rev\\[31miewer\\s+Please fix the \\[2Jintro`,
      ),
    );
    expect(lines[1]?.endsWith("...")).toBe(true);
    expect(lines[2]).toMatch(/\(hidden\)$/);
    // No terminal control character from a reviewer reaches the output.
    expect(result.stdout).not.toContain(String.fromCharCode(27));
    expect(result.stderr).toContain(UNTRUSTED_ANNOTATIONS_NOTICE);
  });

  it("prints the API's body with --json, and says when there is nothing open", async () => {
    h.signIn();
    server.api.feedback.set("personal", [item("abcdefghij", T1, "Hi")]);
    const json = await h.invoke("feedback", "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      notice: UNTRUSTED_ANNOTATIONS_NOTICE,
      owner: { kind: "personal" },
      items: [{ thread: { id: T1 }, counts: { messages: 1, artifactOpenThreads: 2 } }],
      nextCursor: null,
    });
    server.api.feedback.set("personal", []);
    const empty = await h.invoke("feedback");
    expect(empty.stdout).toContain("No open feedback");
  });

  it("sends the space, the page and the filters, and tells how to continue", async () => {
    h.signIn();
    server.api.workspaces = [{ slug: "acme", name: "Acme", role: "member" }];
    server.api.usage.plan = { ...server.api.usage.plan, features: ["workspaces"] };
    server.api.feedback.set("acme", [item("abcdefghij", T1, "One"), item("abcdefghij", T2, "Two")]);
    const result = await h.invoke(
      "feedback",
      "--workspace",
      "acme",
      "--limit",
      "1",
      "--since",
      "7d",
      "--mine",
    );
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("Workspace: acme\n")).toBe(true);
    const [request] = feedbackRequests();
    const query = new URLSearchParams(request?.query);
    expect(Object.fromEntries(query)).toEqual({
      limit: "1",
      since: new Date(NOW - 7 * 86_400_000).toISOString(),
      mine: "true",
      workspace: "acme",
    });
    expect(result.stderr).toContain(
      `portifact feedback --cursor 1 --workspace acme --limit 1 --since ${new Date(NOW - 7 * 86_400_000).toISOString()} --mine`,
    );
    const next = await h.invoke("feedback", "--workspace", "acme", "--limit", "1", "--cursor", "1");
    expect(next.stdout).toContain(T2);
    expect(next.stderr).not.toContain("--cursor");
  });

  it("refuses a bad limit or since before calling the API", async () => {
    h.signIn();
    for (const args of [
      ["--limit", "0"],
      ["--limit", "51"],
      ["--since", "yesterday"],
    ]) {
      const result = await h.invoke("feedback", ...args);
      expect(result.code, args.join(" ")).not.toBe(0);
    }
    expect(feedbackRequests()).toEqual([]);
  });

  it("shows a workspace's plan_required and exits 7", async () => {
    h.signIn();
    server.api.workspaces = [{ slug: "acme", name: "Acme", role: "member" }];
    const result = await h.invoke("feedback", "--workspace", "acme", "--json");
    expect(result.code).toBe(EXIT.limit);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("workspaces") },
    });
  });

  it("needs annotations:read", async () => {
    h.signIn(["artifacts:read"]);
    const result = await h.invoke("feedback");
    expect(result.code).not.toBe(0);
  });
});
