import { PLANS } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";
import { parseEvents, parseWebhookId } from "./webhooks.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.api.usage.plan = {
    name: "pro",
    validUntil: null,
    seats: 1,
    limits: { ...PLANS.pro.limits },
    features: [...PLANS.pro.features],
  };
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const URL = "https://hooks.example.com/in?token=abc";

function webhookRequests() {
  return server.requests.filter((r) => r.path.startsWith("/api/v1/webhooks"));
}

async function add(...extra: string[]) {
  const result = await h.invoke("webhooks", "add", URL, "--events", "all", "--json", ...extra);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).webhook.id as string;
}

describe("portifact webhooks", () => {
  it("adds a webhook and prints its secret once", async () => {
    h.signIn();
    const result = await h.invoke(
      "webhooks",
      "add",
      URL,
      "--events",
      "comment.created, artifact.published",
    );
    expect(result.code).toBe(0);
    const [webhook] = server.api.webhooks.values();
    expect(webhook).toMatchObject({
      host: "hooks.example.com",
      format: "generic",
      events: ["comment.created", "artifact.published"],
    });
    expect(result.stdout).toBe(
      `Added webhook ${webhook?.id} for hooks.example.com.\nSigning secret (shown once, keep it in your receiver's configuration): whsec_sample-for-tests\n`,
    );
    const sent = webhookRequests().find((r) => r.method === "POST");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      url: URL,
      format: "generic",
      events: ["comment.created", "artifact.published"],
    });
  });

  it("refuses unknown events before calling the server", async () => {
    h.signIn();
    const result = await h.invoke("webhooks", "add", URL, "--events", "comment.created,nope");
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain('"comment.created,nope" is not a list of events');
    expect(webhookRequests()).toEqual([]);
  });

  it("lists webhooks as a table and as JSON, saying when the plan lacks them", async () => {
    h.signIn();
    const id = await add("--format", "generic");
    const table = await h.invoke("webhooks", "list");
    expect(table.code).toBe(0);
    const lines = table.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^ID\s+HOST\s+FORMAT\s+STATE\s+FAILURES\s+EVENTS\s+VIA\s+LAST ATTEMPT$/,
    );
    expect(lines[1]).toContain("portifact-cli");
    expect(lines[1]).toMatch(
      new RegExp(`^${id}\\s+hooks\\.example\\.com\\s+generic\\s+active\\s+0\\s+`),
    );
    expect(table.stdout).not.toContain("token=abc");
    server.api.usage.plan.features = [];
    const listed = await h.invoke("webhooks", "list", "--json");
    expect(JSON.parse(listed.stdout)).toMatchObject({ available: false, limit: 10 });
    const paused = await h.invoke("webhooks", "list");
    expect(paused.stdout).toContain("Your plan does not include webhooks");
    server.api.webhooksOffered = false;
    const off = await h.invoke("webhooks", "list");
    expect(off.stdout).toContain("does not offer webhooks yet");
  });

  it("says when there are none", async () => {
    h.signIn();
    const result = await h.invoke("webhooks", "list");
    expect(result.stdout).toContain("You have no webhooks.");
  });

  it("disables, enables and changes events", async () => {
    h.signIn();
    const id = await add();
    const off = await h.invoke("webhooks", "disable", id);
    expect(off.stdout).toContain(`${id} disabled (manual)`);
    const on = await h.invoke("webhooks", "enable", id, "--json");
    expect(JSON.parse(on.stdout)).toMatchObject({ state: "active", failures: 0 });
    const events = await h.invoke("webhooks", "events", id, "thread.resolved");
    expect(events.stdout).toContain("events thread.resolved.");
  });

  it("queues a test and shows the delivery log", async () => {
    h.signIn();
    const id = await add();
    const queued = await h.invoke("webhooks", "test", id);
    expect(queued.stdout).toContain(`Queued a test event for ${id}`);
    expect(server.api.webhookTests).toEqual([id]);
    const empty = await h.invoke("webhooks", "deliveries", id);
    expect(empty.stdout).toBe("No delivery attempts in the last 7 days.\n");
    server.api.webhookAttempts.set(id, [
      {
        deliveryId: `whd_${"a".repeat(32)}`,
        attempt: 2,
        at: "2026-11-08T12:00:00.000Z",
        outcome: "failed",
        status: null,
        error: "timeout",
      },
    ]);
    const log = await h.invoke("webhooks", "deliveries", id);
    expect(log.stdout.split("\n")[1]).toMatch(
      /2026-11-08 12:00 UTC\s+whd_a+\s+2\s+failed\s+timeout/,
    );
  });

  it("removes after typing remove, refuses another answer, and needs --yes without a terminal", async () => {
    h.signIn();
    const id = await add();
    const noTerminal = await h.invoke("webhooks", "remove", id);
    expect(noTerminal.code).toBe(EXIT.usage);
    expect(noTerminal.stderr).toContain(`portifact webhooks remove ${id} --yes`);

    const declined = await createHarness({ server, answers: ["no"] });
    declined.signIn();
    const refused = await declined.invoke("webhooks", "remove", id);
    expect(refused.stderr).toContain('confirmation was not "remove"');
    expect(server.api.webhooks.has(id)).toBe(true);
    await declined.cleanup();

    const confirmed = await createHarness({ server, answers: ["remove"] });
    confirmed.signIn();
    const removed = await confirmed.invoke("webhooks", "remove", id);
    expect(removed.code).toBe(0);
    expect(confirmed.prompts[0]).toContain(`removes webhook ${id} for hooks.example.com`);
    expect(server.api.webhooks.has(id)).toBe(false);
    await confirmed.cleanup();

    const other = await add();
    const json = await h.invoke("webhooks", "remove", other, "--yes", "--json");
    expect(JSON.parse(json.stdout)).toEqual({ webhookId: other, removed: true });
  });

  it("shows the server's not_found for a missing webhook", async () => {
    h.signIn();
    const missing = `wh_${"0".repeat(32)}`;
    const result = await h.invoke("webhooks", "test", missing, "--json");
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "not_found", message: "Webhook not found." },
    });
  });

  it("acts on a workspace with --workspace on every command, and on the personal space without it", async () => {
    h.signIn();
    const id = await add("--workspace", "acme");
    for (const args of [
      ["list"],
      ["disable", id],
      ["enable", id],
      ["events", id, "review.requested,review.completed"],
      ["test", id],
      ["deliveries", id],
      ["remove", id, "--yes"],
    ]) {
      const result = await h.invoke("webhooks", ...args, "--workspace", "acme");
      expect(result.code, args.join(" ")).toBe(0);
    }
    expect(webhookRequests().map((r) => r.query)).toEqual(
      webhookRequests().map(() => "workspace=acme"),
    );
    // `personal`, or no flag, names the personal space: no query at all. The device's default
    // workspace never applies to webhooks.
    await h.invoke("webhooks", "list", "--workspace", "personal");
    await h.invoke("webhooks", "list");
    expect(
      webhookRequests()
        .slice(-2)
        .map((r) => r.query),
    ).toEqual(["", ""]);
  });

  it("names the space a removal acts on, in the prompt and in the --yes hint", async () => {
    h.signIn();
    const inWorkspace = await add("--workspace", "acme");
    const noTerminal = await h.invoke("webhooks", "remove", inWorkspace, "--workspace", "acme");
    expect(noTerminal.stderr).toContain(
      `portifact webhooks remove ${inWorkspace} --workspace acme --yes`,
    );
    const team = await createHarness({ server, answers: ["remove"] });
    team.signIn();
    expect((await team.invoke("webhooks", "remove", inWorkspace, "--workspace", "acme")).code).toBe(
      0,
    );
    expect(team.prompts[0]).toContain(
      `removes webhook ${inWorkspace} for hooks.example.com from the workspace acme`,
    );
    await team.cleanup();

    const mine = await add();
    const personal = await createHarness({ server, answers: ["remove"] });
    personal.signIn();
    expect((await personal.invoke("webhooks", "remove", mine)).code).toBe(0);
    expect(personal.prompts[0]).toContain(
      `removes webhook ${mine} for hooks.example.com from your personal space`,
    );
    await personal.cleanup();
  });

  it("refuses a malformed workspace slug before calling the server", async () => {
    h.signIn();
    const result = await h.invoke("webhooks", "list", "--workspace", "Not a slug!");
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("is not a workspace slug");
    expect(webhookRequests()).toEqual([]);
  });

  it("refuses a malformed webhook ID before calling the server", async () => {
    h.signIn();
    const result = await h.invoke("webhooks", "deliveries", "../me");
    expect(result.code).toBe(EXIT.usage);
    expect(webhookRequests()).toEqual([]);
  });
});

describe("parsing", () => {
  it("knows the review events", () => {
    expect(parseEvents("review.requested, review.completed")).toEqual([
      "review.requested",
      "review.completed",
    ]);
  });

  it("reads events as a comma-separated list or all", () => {
    expect(parseEvents("all")).toHaveLength(7);
    expect(parseEvents("comment.created,comment.created")).toEqual(["comment.created"]);
    expect(() => parseEvents("")).toThrow();
    expect(() => parseEvents("webhook.test")).toThrow();
  });

  it("accepts only webhook IDs", () => {
    expect(parseWebhookId(`wh_${"f".repeat(32)}`)).toBe(`wh_${"f".repeat(32)}`);
    expect(() => parseWebhookId("wh_x")).toThrow();
  });
});
