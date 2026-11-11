// @vitest-environment happy-dom
// Issue integrations in the dashboard (decision 0018): the Integrations page for admins
// (connect, test, remove; the credential never shown again), the sidebar link only while
// Portifact offers them, and the "Create issue" dialog of a thread with its defaults and the
// exact preview of what is sent.
import type { IntegrationConnectionView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateIssueDialog } from "./review/create-issue.tsx";
import { IssueLinks } from "./review/thread-card.tsx";
import { targetLines } from "./screens/integrations.tsx";
import {
  type FakeServer,
  fakeMessage,
  fakeServer,
  fakeThread,
  renderDashboard,
  renderInDashboard,
} from "./test-support.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

let server: FakeServer;
beforeEach(() => {
  server = fakeServer([]);
  server.integrations.offered = true;
});

const TOKEN = "github_pat_dashboard_0123456789abcdefWXYZ";

function connection(overrides: Partial<IntegrationConnectionView> = {}): IntegrationConnectionView {
  return {
    id: `ic_${"a".repeat(32)}`,
    service: "github",
    label: "Product repo",
    targets: [{ id: "acme/site", name: "acme/site" }],
    usable: true,
    identity: "octo-bot",
    credentialHint: "…WXYZ",
    attention: null,
    createdAt: "2026-11-09T09:00:00.000Z",
    updatedAt: "2026-11-09T09:00:00.000Z",
    createdBy: "Ada",
    ...overrides,
  };
}

const page = async () => {
  await screen.findByRole("heading", { level: 1, name: "Integrations" });
  await waitFor(() => expect(screen.queryByText("Loading connections")).toBeNull());
  return screen.getByRole("main");
};

describe("integrations page", () => {
  it.each(["light", "dark"])(
    "connects GitHub with the least-privilege steps and never shows the token again (%s theme)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      renderDashboard("/integrations", server);
      const main = await page();
      expect(await within(main).findByText("No connections yet")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Integrations" }).getAttribute("href")).toBe(
        "/integrations",
      );
      const form = within(main).getByRole("region", { name: "Connect a service" });
      fireEvent.click(within(form).getByText("Create a least-privilege GitHub token"));
      expect(within(form).getByText(/set Issues to Read and write/)).toBeTruthy();
      fireEvent.change(within(form).getByLabelText(/^Label/), {
        target: { value: "Product repo" },
      });
      fireEvent.change(within(form).getByLabelText("Fine-grained personal access token"), {
        target: { value: TOKEN },
      });
      fireEvent.change(within(form).getByLabelText(/^Repositories/), {
        target: { value: " acme/site \n\nacme/docs" },
      });
      fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
      const list = within(main).getByRole("region", { name: "Connections" });
      expect(await within(list).findByRole("heading", { name: "Product repo" })).toBeTruthy();
      expect(server.bodies.at(-1)).toEqual({
        service: "github",
        label: "Product repo",
        credential: TOKEN,
        targets: ["acme/site", "acme/docs"],
      });
      expect(within(list).getByText("Acts as octo-bot")).toBeTruthy();
      expect(within(list).getByText("Credential ending in …WXYZ")).toBeTruthy();
      // The credential is gone from the page and the form once connected.
      expect(document.body.innerHTML).not.toContain(TOKEN.slice(0, 20));
      expect(await axeViolations(document.body)).toEqual([]);
    },
  );

  it("says what to check when the service refuses, and clears the credential field", async () => {
    renderDashboard("/integrations", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Connect a service" });
    fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "X" } });
    const credential = within(form).getByLabelText("Fine-grained personal access token");
    fireEvent.change(credential, { target: { value: "short" } });
    fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
    expect(
      await within(form).findByText(/did not accept the credential or one of the repositories/),
    ).toBeTruthy();
    expect((credential as HTMLInputElement).value).toBe("");
  });

  it("tests, flags attention, and removes a connection after confirming", async () => {
    server.integrations.connections = [
      connection(),
      connection({ id: `ic_${"b".repeat(32)}`, label: "Broken", attention: "credential_rejected" }),
    ];
    renderDashboard("/integrations", server);
    const main = await page();
    expect(within(main).getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(
      within(main).getByText("The service refused this credential. Paste a new one, then test it."),
    ).toBeTruthy();
    fireEvent.click(within(main).getByRole("button", { name: "Test Product repo" }));
    expect(
      await within(main).findAllByText(
        "Product repo works. It acts as octo-bot, and every repository or team is reachable.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(main).getByRole("button", { name: "Test Broken" }));
    expect(
      await within(main).findByText(
        "The service refused the credential: it is wrong, expired or revoked.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(main).getByRole("button", { name: "Remove Product repo" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Product repo?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(within(main).queryByRole("heading", { name: "Product repo" })).toBeNull(),
    );
    expect(server.requests).toContainEqual({
      method: "DELETE",
      path: `/api/v1/integrations/connections/ic_${"a".repeat(32)}`,
    });
  });

  it("says which plan includes integrations, and offers nothing while they are switched off", async () => {
    server.integrations.available = false;
    renderDashboard("/integrations", server);
    const main = await page();
    expect(await within(main).findByText(/Integrations are part of the Team plan/)).toBeTruthy();
    cleanup();
    server.integrations.offered = false;
    renderDashboard("/integrations", server);
    const off = await page();
    await waitFor(() =>
      expect(within(off).queryByRole("region", { name: "Connect a service" })).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();
  });

  it("splits the targets one per line", () => {
    expect(targetLines(" a/b \r\n\n c/d \n")).toEqual(["a/b", "c/d"]);
  });
});

describe("the create issue dialog", () => {
  const thread = fakeThread("t1", {
    path: "docs/plan.html",
    target: {
      schema: 1,
      path: "docs/plan.html",
      anchor: {
        kind: "text",
        quote: { exact: "Ship @team on Friday", prefix: "", suffix: "" },
        position: { start: 0, end: 20 },
      },
    },
    messages: [fakeMessage({ id: "m1", body: "See ![x](https://evil.test/p.png) @octocat" })],
  });
  const choices = {
    connections: [connection()],
    available: true,
    serviceAvailable: true,
    euResidency: false,
  };

  function dialog(extra: Partial<typeof choices> = {}) {
    cleanup();
    return renderInDashboard(
      <CreateIssueDialog
        open
        onClose={() => {}}
        artifactId="k7d2qm4xab"
        artifactName="Launch plan"
        thread={thread}
        number={3}
        choices={{ ...choices, ...extra }}
      />,
      server,
    );
  }

  it.each(["light", "dark"])(
    "sends the link and the name by default, and comment text only when turned on (%s theme)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      dialog();
      const sheet = await screen.findByRole("dialog", { name: "Create an issue from thread 3" });
      const link = within(sheet).getByLabelText("A link to this thread") as HTMLInputElement;
      const name = within(sheet).getByLabelText("The artifact's name") as HTMLInputElement;
      const quote = within(sheet).getByLabelText("The quoted text") as HTMLInputElement;
      const message = within(sheet).getByLabelText(
        "The thread's first message",
      ) as HTMLInputElement;
      expect([link.checked, name.checked, quote.checked, message.checked]).toEqual([
        true,
        true,
        false,
        false,
      ]);
      expect((within(sheet).getByLabelText("Issue title") as HTMLInputElement).value).toBe(
        "Launch plan",
      );
      // The preview shows the title as it is sent: inert.
      fireEvent.change(within(sheet).getByLabelText("Issue title"), {
        target: { value: "Fix #12 for @octocat" },
      });
      expect(
        (within(sheet).getByLabelText(/^Exactly what is sent/) as HTMLTextAreaElement).value.split(
          "\n",
        )[0],
      ).toBe("Fix \uff0312 for \uff20octocat");
      fireEvent.change(within(sheet).getByLabelText("Issue title"), {
        target: { value: "Launch plan" },
      });
      const preview = () =>
        (within(sheet).getByLabelText(/^Exactly what is sent/) as HTMLTextAreaElement).value;
      expect(preview()).toContain("Artifact: `Launch plan`");
      expect(preview()).toContain("/view/k7d2qm4xab?path=%2Fdocs%2Fplan.html&thread=t1");
      expect(preview()).not.toContain("octocat");
      expect(within(sheet).getByText(/Never sent: readers' email addresses/)).toBeTruthy();
      expect(
        within(sheet).getByText(
          /readers outside your team included, sees the created issue's link/,
        ),
      ).toBeTruthy();
      expect(await axeViolations(document.body)).toEqual([]);

      fireEvent.click(message);
      fireEvent.click(quote);
      expect(preview()).toContain("```text\nSee ![x](https://evil.test/p.png) @octocat\n```");
      expect(preview()).toContain("```text\nShip @team on Friday\n```");
      fireEvent.click(within(sheet).getByRole("button", { name: "Create issue" }));
      await waitFor(() => expect(server.integrations.issues).toHaveLength(1));
      const [sent] = server.integrations.issues;
      expect(sent).toMatchObject({
        artifactId: "k7d2qm4xab",
        threadId: "t1",
        body: {
          connectionId: `ic_${"a".repeat(32)}`,
          target: "acme/site",
          title: "Launch plan",
          include: { link: true, artifactName: true, quote: true, message: true },
        },
      });
      expect(sent?.key).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("says the text leaves the EU for an owner in the EU, and when no connection can be used", async () => {
    dialog({ euResidency: true });
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText(
        "This space keeps its data in the EU. What you send goes to GitHub, outside the EU.",
      ),
    ).toBeTruthy();
    dialog({ connections: [connection({ usable: false })] });
    expect(
      await screen.findByText(
        /No connection can be used\. Ask an admin to connect GitHub or Linear/,
      ),
    ).toBeTruthy();
  });
});

describe("issue links on a thread", () => {
  it("links a created issue, and shows a pending or failed one with its reason", async () => {
    renderInDashboard(
      <IssueLinks
        issues={[
          {
            id: `ti_${"1".repeat(32)}`,
            service: "github",
            target: "acme/site",
            state: "created",
            key: "#12",
            url: "https://github.com/acme/site/issues/12",
            failure: null,
            own: false,
            createdAt: "2026-11-09T09:00:00.000Z",
          },
          {
            id: `ti_${"2".repeat(32)}`,
            service: "linear",
            target: "Engineering",
            state: "pending",
            key: null,
            url: null,
            failure: null,
            own: true,
            createdAt: "2026-11-09T09:00:00.000Z",
          },
          {
            id: `ti_${"3".repeat(32)}`,
            service: "github",
            target: "acme/site",
            state: "failed",
            key: null,
            url: null,
            failure: "credential_rejected",
            own: true,
            createdAt: "2026-11-09T09:00:00.000Z",
          },
        ]}
      />,
      server,
    );
    const link = await screen.findByRole("link", { name: "Issue #12 in acme/site" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/site/issues/12");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Issue in Engineering is being created")).toBeTruthy();
    expect(
      screen.getByText(
        "Issue in acme/site was not created: the connection's credential no longer works.",
      ),
    ).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
