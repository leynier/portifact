// Audit streams end to end (premium plan E3, decision 0019): an Enterprise owner adds a stream to a
// collector from the keyboard on the Audit page, copies its signing secret (shown once), pauses
// and resumes it (both audited), and the jobs Worker posts the events to a collector inside the
// stack, signed the Standard Webhooks way, oldest first, as the export's JSON Lines. Nothing
// leaves the machine.

import { createHmac, timingSafeEqual } from "node:crypto";
import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const COLLECTOR = "https://siem.collector-e2e.example.com/ingest?token=e2e";

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The documented check: HMAC-SHA-256 over `<id>.<timestamp>.<body>` with the secret's bytes. */
function verify(secret: string, request: Received): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = request.headers["webhook-id"] ?? "";
  const timestamp = request.headers["webhook-timestamp"] ?? "";
  const expected = Buffer.from(
    `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${request.body}`).digest("base64")}`,
  );
  return (request.headers["webhook-signature"] ?? "").split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

test("an owner streams the audit log to a collector and gets every event, signed and in order", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'enterprise', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  await signIn(context, owner);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${APP_ORIGIN}/audit`);
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  const section = page.getByRole("region", { name: "Stream to your SIEM" });
  const form = section.getByRole("region", { name: "Add a stream" });

  // From the keyboard: the name, the URL, then the button.
  await form.getByLabel("Name").focus();
  await page.keyboard.type("Collector");
  await form.getByLabel(/Endpoint URL/).focus();
  await page.keyboard.type(COLLECTOR);
  await form.getByRole("button", { name: "Add stream" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Copy the signing secret now")).toBeVisible();
  const secret = (await page.getByText(/^whsec_/).textContent())?.trim() ?? "";
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  await expect(page.getByRole("region", { name: "Signature check in Node.js" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  const list = section.getByRole("region", { name: "Your audit streams" });
  await expect(list.getByRole("heading", { name: "Collector" })).toBeVisible();
  await expect(page.getByText("token=e2e")).toHaveCount(0);

  // Something audited: pause it, then resume it.
  await list.getByRole("button", { name: "Pause the stream Collector" }).click();
  await expect(list.getByText("Paused by an admin.")).toBeVisible();
  await list.getByRole("button", { name: "Resume the stream Collector" }).click();
  await expect(list.getByRole("button", { name: "Pause the stream Collector" })).toBeVisible();

  // The jobs Worker runs later (its own clock); the e2e control runs it without a settle window.
  const [stream] = await sql<{ id: string }>("SELECT id FROM audit_streams WHERE owner_id = ?", [
    owner.userId,
  ]);
  const { received } = await control<{ received: Received[] }>("/audit-streams", {
    laterMs: 25 * 60_000,
  });
  const mine = received.filter(
    (request) => request.headers["portifact-audit-stream"] === stream?.id,
  );
  expect(mine.length).toBeGreaterThan(0);
  for (const request of mine) {
    expect(request.url).toBe(COLLECTOR);
    expect(request.headers["content-type"]).toBe("application/jsonl; charset=utf-8");
    expect(verify(secret, request)).toBe(true);
    expect(verify(secret, { ...request, body: `${request.body}x` })).toBe(false);
  }
  const events = mine
    .filter((request) => request.headers["portifact-audit-source"] === "regional")
    .flatMap((request) =>
      request.body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; at: string; detail: unknown }),
    );
  expect(events.map((event) => event.kind)).toEqual([
    "audit_stream.created",
    "audit_stream.changed",
    "audit_stream.changed",
  ]);
  expect(events.map((event) => event.at)).toEqual([...events.map((event) => event.at)].sort());
  expect(events[1]?.detail).toEqual({ host: "siem.collector-e2e.example.com", state: "paused" });
  // Never the URL's path or query, nor the secret.
  expect(JSON.stringify(mine.map((request) => request.body))).not.toMatch(/token=e2e|whsec_/);

  await page.reload();
  await expect(list.getByText(/Last request .*delivered \(2xx\)/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
