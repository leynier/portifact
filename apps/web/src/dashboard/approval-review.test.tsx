// @vitest-environment happy-dom
// The artifact page's Reviews section (decision 0012): requesting with reviewers and a number,
// the reviewers with their verdicts and notes as text, changing and cancelling after a
// confirmation, and an explanation instead of the form when the owner's plan lacks reviews.
import type { ApprovalReviewView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReviewers } from "./screens/approval-review.tsx";
import { artifact, type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

const ID = "k7d2qm4xab";
const PATH = `/artifacts/${ID}`;

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([artifact(ID, { name: "Launch plan" })]);
});

const region = () => screen.findByRole("region", { name: "Approval reviews" }, { timeout: 10_000 });

function open(
  overrides: Partial<NonNullable<ApprovalReviewView["request"]>> = {},
): ApprovalReviewView {
  return {
    artifactId: ID,
    role: "owner",
    available: true,
    review: {
      status: "changes_requested",
      reviewers: 2,
      required: 2,
      approvals: 1,
      changesRequested: 1,
    },
    request: {
      id: `ar_${"1".repeat(32)}`,
      versionId: "v2",
      requiredApprovals: null,
      showStatus: false,
      requestedAt: "2026-11-08T12:00:00.000Z",
      updatedAt: "2026-11-08T12:00:00.000Z",
      requestedBy: "Owner",
      reviewers: [
        {
          id: `rvw_${"0".repeat(24)}`,
          name: "Ana",
          email: "ana@example.com",
          active: true,
          you: false,
          verdict: "approve",
          note: null,
          decidedAt: "2026-11-08T12:10:00.000Z",
        },
        {
          id: `rvw_${"1".repeat(24)}`,
          name: "Ben",
          email: "ben@example.com",
          active: false,
          you: false,
          verdict: "changes",
          note: "<script>alert(1)</script> Fix the title",
          decidedAt: "2026-11-08T12:20:00.000Z",
        },
      ],
      history: [
        {
          reviewer: `rvw_${"0".repeat(24)}`,
          name: "Ana",
          versionId: "v1",
          verdict: "changes",
          note: "Old note",
          decidedAt: "2026-11-07T12:00:00.000Z",
        },
      ],
      ...overrides,
    },
  };
}

describe("parseReviewers", () => {
  it("splits on lines and commas, lowercases and drops repeats", () => {
    expect(parseReviewers("Ana@Example.com, ben@example.com\nana@example.com")).toEqual([
      "ana@example.com",
      "ben@example.com",
    ]);
  });
  it("refuses an empty list, an invalid address and too many", () => {
    expect(parseReviewers(" ")).toBeNull();
    expect(parseReviewers("ana@example.com nope")).toBeNull();
    expect(
      parseReviewers(Array.from({ length: 11 }, (_, i) => `p${i}@x.org`).join(",")),
    ).toBeNull();
  });
});

describe("the Reviews section", () => {
  it("requests a review with the reviewers, the number and the status setting", async () => {
    server.approvalReply = open();
    const { container } = renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Reviewers" }), {
      target: { value: "ana@example.com, ben@example.com" },
    });
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Show the status/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Request review" }));
    await screen.findByText("Review requested");
    expect(server.bodies.at(-1)).toEqual({
      reviewers: ["ana@example.com", "ben@example.com"],
      requiredApprovals: null,
      showStatus: true,
    });
    const request = server.requests.find((r) => r.path.endsWith("/review/request"));
    expect(request?.method).toBe("POST");
    await within(panel).findByRole("list", { name: "Reviewers and their verdicts" });
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container)).toEqual([]);
    }
  });

  it("refuses an invalid list before sending", async () => {
    renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Reviewers" }), {
      target: { value: "not an address" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Request review" }));
    await within(panel).findByText("Enter between 1 and 10 valid email addresses.");
    expect(server.requests.some((r) => r.path.endsWith("/review/request"))).toBe(false);
  });

  it("shows each verdict, notes as text, who lost access and the history", async () => {
    server.approvals[ID] = open();
    const { container } = renderDashboard(PATH, server);
    const panel = await region();
    const list = await within(panel).findByRole("list", { name: "Reviewers and their verdicts" });
    expect(within(panel).getAllByText("Changes requested").length).toBeGreaterThan(0);
    expect(panel.textContent).toContain("1 of 2 required approvals, 1 asks for changes");
    expect(list.textContent).toContain("<script>alert(1)</script> Fix the title");
    expect(list.querySelector("script")).toBeNull();
    expect(list.textContent).toContain("Can no longer open it, so it does not count");
    expect(panel.textContent).toContain("Earlier versions");
    expect(panel.textContent).toContain("Old note");
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.theme = theme;
      expect(await axeViolations(container)).toEqual([]);
    }
  });

  it("removes a reviewer and cancels only after the confirmation", async () => {
    server.approvals[ID] = open();
    renderDashboard(PATH, server);
    const panel = await region();
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Remove Ben from the reviewers" }),
    );
    await screen.findByText("Review changed");
    expect(server.bodies.at(-1)).toEqual({ remove: ["ben@example.com"] });

    fireEvent.click(within(panel).getByRole("button", { name: "Cancel review" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this review?" });
    expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel review" }));
    await screen.findByText("Review cancelled");
    expect(
      server.requests.some((r) => r.method === "DELETE" && r.path.endsWith("/review/request")),
    ).toBe(true);
  });

  it("explains the plan instead of the form, and keeps a lapsed request cancellable", async () => {
    server.approvals[ID] = {
      ...open(),
      request: null,
      review: { status: "none", reviewers: 0, required: 0, approvals: 0, changesRequested: 0 },
      available: false,
    };
    renderDashboard(PATH, server);
    let panel = await region();
    await within(panel).findByText("Requesting reviews is part of the Team plan.");
    expect(within(panel).queryByRole("button", { name: "Request review" })).toBeNull();
    cleanup();

    server.approvals[ID] = { ...open(), available: false };
    renderDashboard(PATH, server);
    panel = await region();
    await within(panel).findByText(/no longer includes reviews/);
    expect(
      (
        within(panel).getByRole("button", {
          name: "Remove Ana from the reviewers",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (within(panel).getByRole("button", { name: "Cancel review" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
