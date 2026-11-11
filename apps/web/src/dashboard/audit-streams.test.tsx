// @vitest-environment happy-dom
// The Stream section of the audit log page (decision 0019): nothing while switched off; for admins
// with the plan, adding a stream shows its secret once with the signature check, and each stream
// shows its state, how far it delivered, a gap, and can be tested, paused, given a new secret and
// removed after a confirmation; the EU note; axe clean in both themes.
import type { AuditEventView, AuditStreamView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeServer, fakeServer, renderDashboard, workspace } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.audit[""] = [EVENT];
  server.auditExportable.add("");
});

const EVENT: AuditEventView = {
  id: "ae_000000000000000000000001",
  at: new Date(Date.now() - 3_600_000).toISOString(),
  kind: "audit_stream.created",
  actor: { type: "member", id: "u_ada", name: "Ada" },
  target: { type: "audit_stream", id: `as_${"1".repeat(32)}` },
  artifact: null,
  detail: { host: "siem.example.com", start: "oldest" },
};

function stream(overrides: Partial<AuditStreamView> = {}): AuditStreamView {
  return {
    id: `as_${"1".repeat(32)}`,
    label: "Splunk",
    host: "siem.example.com",
    state: "active",
    pausedReason: null,
    pausedAt: null,
    deliveredThrough: new Date(Date.now() - 25 * 60_000).toISOString(),
    lagMs: 25 * 60_000,
    failures: 0,
    failingSince: null,
    lastAttempt: {
      at: new Date(Date.now() - 60_000).toISOString(),
      outcome: "delivered",
      source: "regional",
      events: 12,
      statusClass: "2xx",
      error: null,
    },
    lastGap: null,
    testPending: false,
    createdAt: "2026-11-10T09:00:00.000Z",
    createdBy: "Ada",
    ...overrides,
  };
}

async function section() {
  return screen.findByRole("region", { name: "Stream to your SIEM" });
}

describe("the audit stream section", () => {
  it("shows nothing while the deployment does not offer streams", async () => {
    renderDashboard("/audit", server);
    await screen.findByRole("table", { name: "Changes in this space, newest first" });
    await waitFor(() =>
      expect(server.requests.some((r) => r.path.startsWith("/api/v1/audit/streams"))).toBe(true),
    );
    expect(screen.queryByRole("heading", { name: "Stream to your SIEM" })).toBeNull();
  });

  it("adds a stream, shows its secret and the signature check once, axe clean in both themes", async () => {
    server.auditStreams.offered = true;
    const { container } = renderDashboard("/audit", server);
    const found = await section();
    expect(
      within(found).getByText(/as signed JSON Lines, in order and at least once/),
    ).toBeTruthy();
    const form = within(found).getByRole("region", { name: "Add a stream" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Splunk" } });
    fireEvent.change(within(form).getByLabelText(/Endpoint URL/), {
      target: { value: "https://siem.example.com/collect?token=abc" },
    });
    fireEvent.click(within(form).getByLabelText(/The oldest event kept/));
    fireEvent.click(within(form).getByRole("button", { name: "Add stream" }));
    await screen.findByText("Copy the signing secret now");
    expect(server.bodies.at(-1)).toEqual({
      label: "Splunk",
      url: "https://siem.example.com/collect?token=abc",
      start: "oldest",
    });
    expect(screen.getByText("whsec_sample-stream-secret-for-tests")).toBeTruthy();
    const sample = screen.getByRole("region", { name: "Signature check in Node.js" });
    expect(sample.textContent).toContain("timingSafeEqual");
    expect(sample.tabIndex).toBe(0);
    expect(await axeViolations(container)).toEqual([]);
    document.documentElement.dataset.theme = "dark";
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    await waitFor(() =>
      expect(screen.queryByText("whsec_sample-stream-secret-for-tests")).toBeNull(),
    );
    const list = within(await section()).getByRole("region", { name: "Your audit streams" });
    expect(within(list).getByRole("heading", { name: "Splunk" })).toBeTruthy();
    expect(list.textContent).not.toContain("token=abc");
  });

  it("shows state, delivery, failures and a gap, and tests, pauses, rotates and removes", async () => {
    server.auditStreams.offered = true;
    server.auditStreams.bySpace[""] = [
      stream({
        failures: 2,
        lastGap: {
          source: "regional",
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
        },
      }),
    ];
    const { container } = renderDashboard("/audit", server);
    const found = await section();
    await within(found).findByRole("heading", { name: "Splunk" });
    expect(found.textContent).toContain("Delivered through");
    expect(found.textContent).toContain("2 requests failed in a row");
    expect(found.textContent).toContain("delivered (2xx)");
    expect(within(found).getByText("Some events never reached this endpoint")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.click(within(found).getByRole("button", { name: "Send test to Splunk" }));
    await waitFor(() => expect(server.auditStreams.tests).toEqual([`as_${"1".repeat(32)}`]));

    fireEvent.click(within(found).getByRole("button", { name: "Pause the stream Splunk" }));
    await within(found).findByText("Paused by an admin.");
    expect(within(found).getByRole("button", { name: "Resume the stream Splunk" })).toBeTruthy();

    fireEvent.click(within(found).getByRole("button", { name: "New secret for Splunk" }));
    await screen.findByText("whsec_rotated-stream-secret-for-tests");
    expect(screen.getByText(/keeps signing next to the new one for 24 hours/)).toBeTruthy();

    fireEvent.click(within(found).getByRole("button", { name: "Remove the stream Splunk" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the stream Splunk?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await within(found).findByText("No stream yet");
  });

  it("opens a stream's requests in a captioned table", async () => {
    server.auditStreams.offered = true;
    server.auditStreams.bySpace[""] = [stream()];
    server.auditStreams.attempts[`as_${"1".repeat(32)}`] = [
      {
        at: new Date(Date.now() - 60_000).toISOString(),
        outcome: "failed",
        source: "global",
        events: 3,
        statusClass: "5xx",
        error: "refused",
      },
    ];
    renderDashboard("/audit", server);
    const found = await section();
    fireEvent.click(await within(found).findByText("Requests"));
    const table = await within(found).findByRole("table", {
      name: "Requests of the stream Splunk",
    });
    expect(table.textContent).toContain("failed (5xx, refused)");
  });

  it("tells an EU workspace's admins the endpoint may be outside the EU, and a lapsed plan why", async () => {
    server.workspaces.acme = workspace("acme", "admin", { name: "Acme" });
    server.audit.acme = [EVENT];
    server.auditExportable.add("acme");
    server.auditStreams.offered = true;
    server.auditStreams.euOwner = true;
    server.auditStreams.available = false;
    server.auditStreams.bySpace.acme = [stream({ state: "paused", pausedReason: "plan" })];
    renderDashboard("/audit?workspace=acme", server);
    const found = await section();
    expect(within(found).getByText("Your endpoint may be outside the EU")).toBeTruthy();
    expect(within(found).getByText(/part of the Enterprise plan/)).toBeTruthy();
    expect(found.textContent).toContain("the plan no longer includes audit streaming");
    expect(within(found).getByRole("button", { name: "Add stream" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(server.requests.some((r) => r.path === "/api/v1/audit/streams?workspace=acme")).toBe(
      true,
    );
  });

  it("describes stream events in the log in plain words", async () => {
    server.audit[""] = [
      EVENT,
      {
        ...EVENT,
        id: "ae_000000000000000000000002",
        kind: "audit_stream.paused",
        actor: { type: "system" },
        detail: { host: "siem.example.com", reason: "failures" },
      },
      {
        ...EVENT,
        id: "ae_000000000000000000000003",
        kind: "audit_stream.changed",
        detail: { host: "siem.example.com", secret: true },
      },
    ];
    renderDashboard("/audit", server);
    const table = await screen.findByRole("table", { name: "Changes in this space, newest first" });
    expect(table.textContent).toContain(
      "Started streaming the log to siem.example.com from the oldest kept event",
    );
    expect(table.textContent).toContain(
      "Paused the stream to siem.example.com: the endpoint kept failing",
    );
    expect(table.textContent).toContain("Gave the stream to siem.example.com a new signing secret");
  });
});
