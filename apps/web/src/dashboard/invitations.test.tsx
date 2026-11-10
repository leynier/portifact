// @vitest-environment happy-dom
// The invitation page (premium plan T1): the token taken out of the address bar and kept for the
// tab, the signed-out explanation, the invitee's answer, another account and a link that no
// longer works, and the account's own invitations.
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetInvitationToken,
  INVITATION_TOKEN_KEY,
  stashedInvitationToken,
  stashInvitationToken,
} from "./screens/invitations.tsx";
import { type FakeServer, fakeServer, renderDashboard } from "./test-support.tsx";

const TOKEN = "T".repeat(43);
const INVITATION = {
  id: `inv_${"a".repeat(32)}`,
  workspace: { slug: "acme", name: "Acme" },
  role: "editor" as const,
  invitedBy: "Grace",
  expiresAt: "2026-11-15T12:00:00.000Z",
};

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  window.sessionStorage.clear();
  forgetInvitationToken();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakeWindow(href: string) {
  const replaced: string[] = [];
  return {
    replaced,
    win: {
      location: { href } as Location,
      history: { replaceState: (_: unknown, __: string, url: string) => replaced.push(url) },
    } as unknown as Pick<Window, "location" | "history">,
  };
}

describe("stashInvitationToken", () => {
  it("takes the token out of the fragment and keeps it for this tab", () => {
    const { win, replaced } = fakeWindow(`https://app.portifact.com/invitations#token=${TOKEN}`);
    stashInvitationToken(win);
    expect(replaced).toEqual(["/invitations"]);
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_KEY)).toBe(TOKEN);
    expect(stashedInvitationToken()).toBe(TOKEN);
  });

  it("accepts an older link's query, keeps other parameters and drops a malformed token", () => {
    const { win, replaced } = fakeWindow(
      "https://app.portifact.com/invitations?lang=es&token=short",
    );
    stashInvitationToken(win);
    expect(replaced).toEqual(["/invitations?lang=es"]);
    expect(stashedInvitationToken()).toBe("");
  });

  it("leaves other pages and links without a token alone", () => {
    for (const href of [
      `https://app.portifact.com/view/abc#token=${TOKEN}`,
      "https://app.portifact.com/invitations",
    ]) {
      const { win, replaced } = fakeWindow(href);
      stashInvitationToken(win);
      expect(replaced).toEqual([]);
    }
    expect(stashedInvitationToken()).toBeNull();
  });

  it("keeps the token in memory when the browser blocks storage", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { win } = fakeWindow(`https://app.portifact.com/invitations#token=${TOKEN}`);
    stashInvitationToken(win);
    expect(stashedInvitationToken()).toBe(TOKEN);
    forgetInvitationToken();
    expect(stashedInvitationToken()).toBeNull();
  });
});

const stash = () => window.sessionStorage.setItem(INVITATION_TOKEN_KEY, TOKEN);
const lookups = () => server.requests.filter((r) => r.path === "/api/v1/invitations/lookup");

describe("signed out", () => {
  it("explains the invitation and sends the person to sign in and back, without the token", async () => {
    server.email = null;
    stash();
    const { container, left } = renderDashboard("/invitations", server);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Workspace invitation" }),
    ).toBeTruthy();
    expect(screen.getByText(/Someone invited you to a workspace on Portifact/)).toBeTruthy();
    const signIn = screen.getByRole("link", { name: "Sign in to answer" });
    expect(signIn.getAttribute("href")).toBe("/login?next=%2Finvitations");
    expect(signIn.getAttribute("href")).not.toContain(TOKEN);
    expect(lookups()).toEqual([]);
    expect(left).toEqual([]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("asks to sign in to see invitations when there is no link", async () => {
    server.email = null;
    renderDashboard("/invitations", server);
    expect(await screen.findByText(/Sign in to see the invitations/)).toBeTruthy();
  });
});

describe("signed in with a link", () => {
  it("shows the invitation to its address, and accepting opens the workspace", async () => {
    stash();
    server.links[TOKEN] = { status: "invited", invitation: INVITATION };
    const { container, router } = renderDashboard("/invitations", server);
    const card = await screen.findByRole("region", { name: "Acme" });
    expect(card.textContent).toContain("Grace invited you to Acme as Editor.");
    expect(card.textContent).toContain("publishes and manages the workspace's artifacts");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(card).getByRole("button", { name: "Accept the invitation to Acme" }));
    expect(await screen.findByText("You joined Acme.")).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "acme" }));
    expect(router.state.location.pathname).toBe("/");
    expect(server.bodies).toContainEqual({ token: TOKEN });
    expect(stashedInvitationToken()).toBeNull();
    // The workspace is in the menu now.
    expect(
      await screen.findAllByRole("button", { name: /^Space Acme/, hidden: true }),
    ).toBeTruthy();
  });

  it("declines after a confirmation", async () => {
    stash();
    server.links[TOKEN] = { status: "invited", invitation: { ...INVITATION, invitedBy: null } };
    const { container } = renderDashboard("/invitations", server);
    const card = await screen.findByRole("region", { name: "Acme" });
    expect(card.textContent).toContain("You are invited to Acme as Editor.");
    fireEvent.click(within(card).getByRole("button", { name: "Decline the invitation to Acme" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Decline the invitation to Acme?",
    });
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline invitation" }));
    expect(await screen.findByText("You declined the invitation to Acme.")).toBeTruthy();
    expect(stashedInvitationToken()).toBeNull();
  });

  it("explains a refused accept, such as no free seat", async () => {
    stash();
    server.links[TOKEN] = { status: "invited", invitation: INVITATION };
    server.fail("POST", "/api/v1/invitations/accept", { status: 409, code: "seats_exhausted" });
    renderDashboard("/invitations", server);
    const card = await screen.findByRole("region", { name: "Acme" });
    fireEvent.click(within(card).getByRole("button", { name: "Accept the invitation to Acme" }));
    expect(await within(card).findByText(/The workspace uses all of its seats/)).toBeTruthy();
  });

  it("names only the invited address to another account, and offers to switch", async () => {
    stash();
    server.links[TOKEN] = { status: "other_account", email: "grace@elsewhere.test" };
    const { container, left } = renderDashboard("/invitations", server);
    const panel = await screen.findByRole("region", {
      name: "This invitation is for another address",
    });
    expect(panel.textContent).toContain(
      "It was sent to grace@elsewhere.test, and you are signed in as ada@example.test.",
    );
    expect(panel.textContent).not.toContain("Acme");
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(within(panel).getByRole("button", { name: "Sign in with another account" }));
    await waitFor(() => expect(left).toEqual(["/login?next=%2Finvitations"]));
    expect(server.requests).toContainEqual({ method: "POST", path: "/api/auth/sign-out" });
    // The link stays in the tab for the account that signs in next.
    expect(stashedInvitationToken()).toBe(TOKEN);
  });

  it("asks the invited address to verify itself when the account has it unverified", async () => {
    stash();
    server.links[TOKEN] = { status: "other_account", email: "ada@example.test" };
    renderDashboard("/invitations", server);
    expect(await screen.findByText(/which is not verified yet/)).toBeTruthy();
  });

  it("answers a link that no longer works with one page, and forgets it", async () => {
    stash();
    const { container } = renderDashboard("/invitations", server);
    expect(
      await screen.findByRole("region", { name: "This invitation no longer works" }),
    ).toBeTruthy();
    expect(screen.getByText(/It expired, was revoked or was already used/)).toBeTruthy();
    await waitFor(() => expect(stashedInvitationToken()).toBeNull());
    expect(await axeViolations(container)).toEqual([]);
  });

  it("never sends a malformed token", async () => {
    window.sessionStorage.setItem(INVITATION_TOKEN_KEY, "");
    renderDashboard("/invitations", server);
    expect(
      await screen.findByRole("region", { name: "This invitation no longer works" }),
    ).toBeTruthy();
    expect(lookups()).toEqual([]);
  });
});

describe("the account's invitations", () => {
  it("lists them with accept and decline", async () => {
    server.incoming = [
      INVITATION,
      { ...INVITATION, id: `inv_${"b".repeat(32)}`, workspace: { slug: "beta", name: "Beta" } },
    ];
    const { container, router } = renderDashboard("/invitations", server);
    expect(await screen.findByRole("region", { name: "Acme" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Beta" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Accept the invitation to Beta" }));
    expect(await screen.findByText("You joined Beta.")).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: "POST",
      path: `/api/v1/account/invitations/inv_${"b".repeat(32)}/accept`,
    });
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "beta" }));
  });

  it("says there are none", async () => {
    const { container } = renderDashboard("/invitations", server);
    expect(await screen.findByText("No pending invitations")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });
});
