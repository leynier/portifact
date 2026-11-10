// @vitest-environment happy-dom
import type { WebhookView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(cleanup);

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
});

function hook(overrides: Partial<WebhookView> = {}): WebhookView {
  return {
    id: `wh_${"a".repeat(32)}`,
    host: "hooks.example.com",
    format: "generic",
    events: ["comment.created", "artifact.published"],
    state: "active",
    disabledReason: null,
    disabledAt: null,
    failures: 0,
    createdAt: "2026-11-09T09:00:00.000Z",
    lastAttempt: null,
    ...overrides,
  };
}

/** The page once the list has loaded, which enables the form. */
const page = async () => {
  await screen.findByRole("heading", { level: 1, name: "Webhooks" });
  await waitFor(() => expect(screen.queryByText("Loading your webhooks")).toBeNull());
  return screen.getByRole("main");
};

describe("webhooks page", () => {
  it("is reached from the navigation and says when there are none", async () => {
    renderDashboard("/webhooks", server);
    const main = await page();
    expect(await within(main).findByText("No webhooks yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Webhooks" }).getAttribute("href")).toBe("/webhooks");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("adds a webhook and shows its secret once", async () => {
    renderDashboard("/webhooks", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Add a webhook" });
    fireEvent.change(within(form).getByLabelText(/^URL/), {
      target: { value: " https://hooks.example.com/in?token=abc " },
    });
    fireEvent.click(within(form).getByLabelText("New versions"));
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    const secret = await screen.findByText("Copy the signing secret now");
    expect(secret).toBeTruthy();
    expect(screen.getByText("whsec_sample-secret-for-tests")).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({
      url: "https://hooks.example.com/in?token=abc",
      format: "generic",
      events: ["comment.created", "thread.resolved", "artifact.published"],
    });
    const list = within(main).getByRole("region", { name: "Your webhooks" });
    expect(await within(list).findByRole("heading", { name: "hooks.example.com" })).toBeTruthy();
    // The URL's path and query are never shown after creation.
    expect(document.body.textContent).not.toContain("token=abc");
    expect(await axeViolations(document.body)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    await waitFor(() => expect(screen.queryByText("whsec_sample-secret-for-tests")).toBeNull());
  });

  it("asks for at least one event, and shows the server's refusal", async () => {
    renderDashboard("/webhooks", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Add a webhook" });
    fireEvent.click(within(form).getByLabelText("New comments and replies"));
    fireEvent.click(within(form).getByLabelText("Resolved threads"));
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    expect(await within(form).findByText("Choose at least one event.")).toBeTruthy();
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);
    fireEvent.click(within(form).getByLabelText("Access changes"));
    fireEvent.change(within(form).getByLabelText(/^URL/), {
      target: { value: "http://hooks.example.com/" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    expect(await within(form).findByText("That did not work")).toBeTruthy();
  });

  it("says webhooks are part of a paid plan, without a checkout, and keeps existing ones paused", async () => {
    server.webhooks = {
      list: [hook({ state: "paused" })],
      available: false,
      attempts: {},
    };
    renderDashboard("/webhooks", server);
    const main = await page();
    expect(await within(main).findByText(/Webhooks are part of the Pro plan/)).toBeTruthy();
    expect(within(main).getByText("Paused by plan")).toBeTruthy();
    expect(within(main).getByRole("button", { name: "Add webhook" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      within(main)
        .getByRole("button", { name: "Send test to hooks.example.com" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(within(main).queryByRole("link", { name: /upgrade|checkout/i })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("sends a test, disables, enables and shows the delivery log", async () => {
    const webhook = hook({
      failures: 2,
      lastAttempt: {
        deliveryId: `whd_${"b".repeat(32)}`,
        attempt: 2,
        at: "2026-11-10T09:00:00.000Z",
        outcome: "failed",
        status: null,
        error: "timeout",
      },
    });
    server.webhooks = {
      list: [webhook],
      available: true,
      attempts: { [webhook.id]: [webhook.lastAttempt as NonNullable<WebhookView["lastAttempt"]>] },
    };
    renderDashboard("/webhooks", server);
    const main = await page();
    expect(await within(main).findByText("2 failed attempts in a row")).toBeTruthy();
    expect(within(main).getByText(/failed \(timed out\)/)).toBeTruthy();
    fireEvent.click(within(main).getByRole("button", { name: "Send test to hooks.example.com" }));
    await waitFor(() => expect(server.webhookTests).toEqual([webhook.id]));

    fireEvent.click(
      within(main).getByRole("button", { name: "Disable the webhook for hooks.example.com" }),
    );
    expect(await within(main).findByText("Disabled by an admin")).toBeTruthy();
    fireEvent.click(
      await within(main).findByRole("button", { name: "Enable the webhook for hooks.example.com" }),
    );
    await waitFor(() => expect(within(main).queryByText("Disabled by an admin")).toBeNull());

    fireEvent.click(within(main).getByText("Deliveries"));
    const table = await within(main).findByRole("region", {
      name: "Deliveries of the webhook for hooks.example.com",
    });
    expect(within(table).getByText("failed (timed out)")).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("removes a webhook only after the confirmation", async () => {
    server.webhooks = { list: [hook()], available: true, attempts: {} };
    renderDashboard("/webhooks", server);
    const main = await page();
    fireEvent.click(
      await within(main).findByRole("button", { name: "Remove the webhook for hooks.example.com" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Remove the webhook for hooks.example.com/,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.webhooks.list).toHaveLength(1);
    fireEvent.click(
      within(main).getByRole("button", { name: "Remove the webhook for hooks.example.com" }),
    );
    const again = await screen.findByRole("dialog", {
      name: /Remove the webhook for hooks.example.com/,
    });
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    expect(await within(main).findByText("No webhooks yet")).toBeTruthy();
    expect(server.webhooks.list).toEqual([]);
  });
});
