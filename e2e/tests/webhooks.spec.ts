// Webhooks end to end (premium plan P6, decision 0009): on a free plan the page says webhooks are
// part of a paid plan and offers no checkout; on Pro an owner adds a webhook from the keyboard,
// copies its signing secret (shown once), sends a test event that the jobs Worker delivers to a
// receiver inside the stack, verifies its Standard Webhooks signature, reads the delivery log,
// disables it and removes it after a confirmation. Nothing leaves the machine.

import { createHmac, timingSafeEqual } from "node:crypto";
import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const RECEIVER = "https://hooks.receiver-e2e.example.com/in?token=e2e";

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

test("an owner adds a webhook, gets a signed test event, reads the log and removes it", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  await signIn(context, owner);

  // Free: the page says which plan includes webhooks and offers no way to add one.
  await page.goto(`${APP_ORIGIN}/webhooks`);
  await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
  await expect(page.getByText(/Webhooks are part of the Pro plan/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add webhook" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /upgrade|checkout|buy/i })).toHaveCount(0);

  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'pro', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  await page.reload();
  const form = page.getByRole("region", { name: "Add a webhook" });
  await expect(form.getByRole("button", { name: "Add webhook" })).toBeEnabled();

  // From the keyboard: the URL, then the events, then the button.
  await form.getByLabel("URL").focus();
  await page.keyboard.type(RECEIVER);
  await form.getByLabel("New versions").focus();
  await page.keyboard.press("Space");
  await form.getByRole("button", { name: "Add webhook" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Copy the signing secret now")).toBeVisible();
  const secret = (await page.getByText(/^whsec_/).textContent())?.trim() ?? "";
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "I saved it" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  const list = page.getByRole("region", { name: "Your webhooks" });
  await expect(list.getByRole("heading", { name: "hooks.receiver-e2e.example.com" })).toBeVisible();
  // Only the host is shown, never the path or the query.
  await expect(page.getByText("token=e2e")).toHaveCount(0);

  await list.getByRole("button", { name: "Send test to hooks.receiver-e2e.example.com" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test event queued" })).toHaveCount(1);
  const { received } = await control<{ received: Received[] }>("/webhooks", {});
  // The receiver keeps every project's deliveries; this run's carry its own webhook's ID.
  const [hook] = await sql<{ id: string }>("SELECT id FROM webhooks WHERE owner_id = ?", [
    owner.userId,
  ]);
  const delivery = received.find(
    (request) =>
      request.url === RECEIVER &&
      (JSON.parse(request.body) as { webhookId?: string }).webhookId === hook?.id,
  );
  if (!delivery) throw new Error("the receiver got nothing");
  expect(verify(secret, delivery)).toBe(true);
  expect(verify(secret, { ...delivery, body: delivery.body.replace("true", "false") })).toBe(false);
  expect(JSON.parse(delivery.body)).toMatchObject({
    test: true,
    events: [{ type: "webhook.test", artifact: null, count: 1, actor: { name: "Owner" } }],
  });

  await page.reload();
  await list.getByText("Deliveries").click();
  const log = list.getByRole("region", {
    name: "Deliveries of the webhook for hooks.receiver-e2e.example.com",
  });
  await expect(log.getByText("delivered (200)")).toBeVisible();

  await list
    .getByRole("button", { name: "Disable the webhook for hooks.receiver-e2e.example.com" })
    .click();
  await expect(list.getByText("Disabled by an admin")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await list
    .getByRole("button", { name: "Remove the webhook for hooks.receiver-e2e.example.com" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Remove the webhook/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(list.getByText("No webhooks yet")).toBeVisible();
  const left = await sql<{ n: number }>("SELECT count(*) AS n FROM webhooks WHERE owner_id = ?", [
    owner.userId,
  ]);
  expect(left[0]?.n).toBe(0);
});
