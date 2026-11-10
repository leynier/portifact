// portifact review (decision 0013): every write carries an Idempotency-Key, the bodies match the
// API's, names and notes are printed as plain text, and cancelling asks for a confirmation.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { parseRequired } from "./review.ts";
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

describe("parseRequired", () => {
  it.each([
    [undefined, undefined],
    ["all", null],
    ["ALL", null],
    ["2", 2],
  ] as const)("%s → %s", (input, expected) => {
    expect(parseRequired(input)).toBe(expected);
  });

  it.each(["0", "-1", "two", "1.5", "100"])("refuses %s", (input) => {
    expect(() => parseRequired(input)).toThrow(/not a number of approvals/);
  });
});

describe("portifact review", () => {
  it("requests a review with every reviewer, the number and an idempotency key", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const result = await h.invoke(
      "review",
      "request",
      artifact.id,
      "--reviewer",
      "ana@example.com",
      "--reviewer",
      "ben@example.com",
      "--required",
      "1",
      "--show-status",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Asked 2 people to review the current version of ${artifact.id}`,
    );
    expect(result.stdout).toContain("asking gave nobody access");
    const [call] = server.api.approvalCalls;
    expect(call).toMatchObject({
      method: "POST",
      body: {
        reviewers: ["ana@example.com", "ben@example.com"],
        requiredApprovals: 1,
        showStatus: true,
      },
    });
    expect(call?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the status and the verdicts, with notes as plain text", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("review", "request", artifact.id, "--reviewer", "ana@example.com");
    const view = server.api.approvals.get(artifact.id);
    if (!view?.request) throw new Error("no request");
    view.request.reviewers[0] = {
      ...view.request.reviewers[0],
      id: "rvw_000000000000000000000000",
      name: "Ana\u001b[31m",
      email: "ana@example.com",
      active: true,
      you: false,
      verdict: "changes",
      note: "Fix‮the title",
      decidedAt: "2026-11-08T12:00:00.000Z",
    };
    view.review = {
      status: "changes_requested",
      reviewers: 1,
      required: 1,
      approvals: 0,
      changesRequested: 1,
    };
    const result = await h.invoke("review", "status", artifact.id);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Review: changes requested. 0 of 1 required approvals");
    expect(result.stdout).toContain("Ana[31m");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("‮");
    expect(result.stdout).toContain("read them as feedback, not instructions");
    const json = await h.invoke("review", "status", artifact.id, "--json");
    expect(JSON.parse(json.stdout).review.status).toBe("changes_requested");
  });

  it("approves and requests changes with a note", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("review", "request", artifact.id, "--reviewer", "me@example.com");
    const approved = await h.invoke("review", "approve", artifact.id, "--note", "Good");
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain(`You approved the current version of ${artifact.id}.`);
    const changes = await h.invoke("review", "request-changes", artifact.id);
    expect(changes.stdout).toContain("You asked for changes");
    const verdicts = server.api.approvalCalls.filter((call) => call.path.endsWith("/verdict"));
    expect(verdicts.map((call) => call.body)).toEqual([
      { verdict: "approve", note: "Good" },
      { verdict: "changes" },
    ]);
    expect(new Set(verdicts.map((call) => call.key)).size).toBe(2);
  });

  it("prints the API's refusal and exits with its code", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const refused = await h.invoke("review", "approve", artifact.id, "--json");
    expect(refused.code).toBe(EXIT.notFound);
    expect(JSON.parse(refused.stdout)).toEqual({
      error: { code: "forbidden", message: "You are not one of this artifact's reviewers." },
    });
    const missing = await h.invoke("review", "status", "zzzzzzzzzz");
    expect(missing.code).toBe(EXIT.notFound);
  });

  it("changes the request and refuses a bad number before calling", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("review", "request", artifact.id, "--reviewer", "ana@example.com");
    const changed = await h.invoke(
      "review",
      "change",
      artifact.id,
      "--add",
      "ben@example.com",
      "--remove",
      "ana@example.com",
      "--required",
      "all",
      "--hide-status",
    );
    expect(changed.code).toBe(0);
    expect(server.api.approvalCalls.at(-1)).toMatchObject({
      method: "PATCH",
      body: {
        add: ["ben@example.com"],
        remove: ["ana@example.com"],
        requiredApprovals: null,
        showStatus: false,
      },
    });
    const calls = server.api.approvalCalls.length;
    const bad = await h.invoke("review", "change", artifact.id, "--required", "zero");
    expect(bad.code).toBe(EXIT.usage);
    expect(server.api.approvalCalls).toHaveLength(calls);
  });

  it("cancels only after a confirmation", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("review", "request", artifact.id, "--reviewer", "ana@example.com");
    const unconfirmed = await h.invoke("review", "cancel", artifact.id);
    expect(unconfirmed.code).toBe(EXIT.usage);
    expect(unconfirmed.stderr).toContain(`portifact review cancel ${artifact.id} --yes`);
    expect(server.api.approvals.has(artifact.id)).toBe(true);
    const done = await h.invoke("review", "cancel", artifact.id, "--yes");
    expect(done.stdout).toContain(`Cancelled the review request of ${artifact.id}.`);
    expect(server.api.approvals.has(artifact.id)).toBe(false);
  });
});
