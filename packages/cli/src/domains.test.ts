// portifact domains (decision 0006): what each command sends, how it shows the DNS records and
// the state, the confirmation before removing, and that the CLI adds no rule of its own.
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

const posts = (path: RegExp) =>
  server.requests.filter((r) => r.method === "POST" && path.test(r.path));

describe("portifact domains add", () => {
  it("sends the hostname with an idempotency key and prints the records and the bar note", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const result = await h.invoke("domains", "add", artifact.id, "Docs.Example.com.");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `docs.example.com is waiting for its DNS records (artifact ${artifact.id}).`,
    );
    expect(result.stdout).toContain("_portifact.docs.example.com");
    expect(result.stdout).toContain("portifact-verify=0123456789abcdef0123456789abcdef");
    expect(result.stdout).toContain("domains.portifact.dev");
    expect(result.stdout).toContain("portifact domains verify docs.example.com");
    expect(result.stdout).toContain("portifact access bar <id> off");
    const [sent] = posts(/\/domain$/);
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ hostname: "docs.example.com" });
    expect(sent?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prints the API's body with --json and refuses bad input before any request", async () => {
    h.signIn();
    const artifact = server.api.seed();
    const json = await h.invoke("domains", "add", artifact.id, "docs.example.com", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({
      hostname: "docs.example.com",
      state: "pending",
    });
    const before = server.requests.length;
    expect((await h.invoke("domains", "add", "nope", "docs.example.com")).code).toBe(EXIT.usage);
    expect((await h.invoke("domains", "add", artifact.id, "")).code).toBe(EXIT.usage);
    expect(server.requests.length).toBe(before);
  });
});

describe("portifact domains verify, info and list", () => {
  it("shows the state, the problem and the plan", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("domains", "add", artifact.id, "docs.example.com");
    const view = server.api.domains.get("docs.example.com");
    if (!view) throw new Error("no domain");
    server.api.domains.set("docs.example.com", { ...view, problem: "txt_missing" });
    const pending = await h.invoke("domains", "verify", "docs.example.com");
    expect(pending.stdout).toContain("The TXT record does not hold this value yet");
    expect(posts(/\/domains\/docs\.example\.com\/verify$/)).toHaveLength(1);

    server.api.domains.set("docs.example.com", {
      ...view,
      state: "active",
      problem: null,
      verifiedAt: "2026-11-08T12:00:00.000Z",
      missedChecks: 2,
    });
    const info = await h.invoke("domains", "info", "docs.example.com");
    expect(info.stdout).toContain(`docs.example.com serves artifact ${artifact.id}.`);
    expect(info.stdout).toContain("missing at 2 daily checks in a row");
    expect(info.stdout).not.toContain("_portifact");

    const list = await h.invoke("domains", "list");
    expect(list.stdout).toMatch(/docs\.example\.com\s+\S+\s+active/);
    expect(list.stdout).toContain("Your plan allows 1 custom domain; 1 in use.");
    const other = server.api.seed();
    await h.invoke("domains", "add", other.id, "other.example.com");
    const filtered = await h.invoke("domains", "list", "--artifact", artifact.id, "--json");
    expect(
      JSON.parse(filtered.stdout).domains.map((d: { hostname: string }) => d.hostname),
    ).toEqual(["docs.example.com"]);
    server.api.domains.clear();
    expect((await h.invoke("domains", "list")).stdout).toContain("No custom domains.");
    expect((await h.invoke("domains", "info", "gone.example.com")).code).toBe(EXIT.notFound);
  });
});

describe("portifact domains remove", () => {
  it("refuses without a terminal and removes with --yes", async () => {
    h.signIn();
    const artifact = server.api.seed();
    await h.invoke("domains", "add", artifact.id, "docs.example.com");
    const refused = await h.invoke("domains", "remove", "docs.example.com");
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("portifact domains remove docs.example.com --yes");
    expect(server.api.domains.get("docs.example.com")?.state).toBe("pending");
    const json = await h.invoke("domains", "remove", "docs.example.com", "--yes", "--json");
    expect(JSON.parse(json.stdout)).toEqual({ hostname: "docs.example.com", removed: true });
    expect(server.api.domains.get("docs.example.com")?.state).toBe("removing");
  });

  it("asks for the hostname at the terminal and cancels on anything else", async () => {
    const prompted = await createHarness({ server, answers: ["nope", "docs.example.com"] });
    prompted.signIn();
    const artifact = server.api.seed();
    await prompted.invoke("domains", "add", artifact.id, "docs.example.com");
    expect((await prompted.invoke("domains", "remove", "docs.example.com")).code).toBe(
      EXIT.failure,
    );
    expect(server.api.domains.get("docs.example.com")?.state).toBe("pending");
    const removed = await prompted.invoke("domains", "remove", "docs.example.com");
    expect(removed.stdout).toContain("Removed docs.example.com.");
    expect(prompted.prompts[0]).toContain("Type the hostname to confirm");
    await prompted.cleanup();
  });
});
