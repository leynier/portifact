// @vitest-environment happy-dom
// Issue integrations in the dashboard (decision 0018): the Integrations page for admins
// (connect, test, remove; the credential never shown again), the sidebar link only while
// Portifact offers them, and the "Create issue" dialog of a thread with its defaults and the
// exact preview of what is sent.
import type { IntegrationConnectionView } from "@portifact/contracts";
import { axeViolations } from "@portifact/ui/testing";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateIssueDialog, usableConnections } from "./review/create-issue.tsx";
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
    site: null,
    targets: [{ id: "acme/site", name: "acme/site" }],
    usable: true,
    identity: "octo-bot",
    credentialHint: "…WXYZ",
    attention: null,
    slack: null,
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

describe("Slack on the integrations page (decision 0025)", () => {
  // Built at run time: no committed literal looks like a real token.
  const BOT = `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"c".repeat(24)}`;
  const SECRET = "d".repeat(32);

  it("is offered only while Slack is switched on", async () => {
    renderDashboard("/integrations", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Connect a service" });
    expect(within(form).queryByLabelText("Slack")).toBeNull();
    cleanup();
    server.integrations.slackOffered = true;
    renderDashboard("/integrations", server);
    const again = await page();
    expect(
      within(within(again).getByRole("region", { name: "Connect a service" })).getByLabelText(
        "Slack",
      ),
    ).toBeTruthy();
  });

  it.each(["light", "dark"])(
    "starts with a label, shows the manifest and Request URL, and finishes with the bot token and signing secret (%s theme)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      server.integrations.slackOffered = true;
      renderDashboard("/integrations", server);
      const main = await page();
      const form = within(main).getByRole("region", { name: "Connect a service" });
      fireEvent.click(within(form).getByLabelText("Slack"));
      // No credential or target fields for Slack at this step; the notices go through webhooks.
      expect(within(form).queryByLabelText("Fine-grained personal access token")).toBeNull();
      expect(within(form).getByRole("link", { name: "Open Webhooks" })).toBeTruthy();
      // What previews send, before anything is connected.
      expect(within(form).getByText(/shows the artifact's name and type under it/)).toBeTruthy();
      fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "Acme Slack" } });
      fireEvent.click(within(form).getByRole("button", { name: "Start" }));
      const list = within(main).getByRole("region", { name: "Connections" });
      expect(await within(list).findByRole("heading", { name: "Acme Slack" })).toBeTruthy();
      expect(server.bodies.at(-1)).toEqual({ service: "slack", label: "Acme Slack" });
      expect(within(list).getByText("Not finished")).toBeTruthy();
      expect(within(list).getByText("Finish connecting Slack")).toBeTruthy();
      // The app's name is fixed; two spaces in one Slack workspace are told apart in Slack.
      expect(within(list).getByText(/rename the app in its settings in Slack/)).toBeTruthy();
      const create = within(list).getByRole("link", { name: /Create the app in Slack/ });
      expect(create.getAttribute("href")).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1/);
      expect(create.getAttribute("rel")).toBe("noopener noreferrer");
      expect(within(list).getByRole("button", { name: "Copy Request URL" })).toBeTruthy();
      expect(within(list).getByRole("button", { name: "Test Acme Slack" })).toHaveProperty(
        "disabled",
        true,
      );
      expect(await axeViolations(document.body)).toEqual([]);
      const finish = within(list).getByRole("form", { name: "Finish connecting Slack" });
      fireEvent.change(within(finish).getByLabelText(/^Bot User OAuth Token/), {
        target: { value: BOT },
      });
      fireEvent.change(within(finish).getByLabelText(/^Signing Secret/), {
        target: { value: SECRET },
      });
      fireEvent.click(within(finish).getByRole("button", { name: "Finish connecting" }));
      expect(await within(list).findByText("Slack workspace Acme")).toBeTruthy();
      expect(server.bodies.at(-1)).toEqual({ botToken: BOT, signingSecret: SECRET });
      expect(within(list).getByText(/click Verify next to the Request URL/)).toBeTruthy();
      expect(within(list).getByText(/rename the app in its settings in Slack/)).toBeTruthy();
      // And what stays in Slack after an artifact stops being public.
      expect(within(list).getByText(/earlier previews still show its name and type/)).toBeTruthy();
      expect(document.body.innerHTML).not.toContain(BOT.slice(0, 20));
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(await axeViolations(document.body)).toEqual([]);
    },
  );

  it("says what Slack refused and clears both secrets", async () => {
    server.integrations.slackOffered = true;
    renderDashboard("/integrations", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Connect a service" });
    fireEvent.click(within(form).getByLabelText("Slack"));
    fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "Acme Slack" } });
    fireEvent.click(within(form).getByRole("button", { name: "Start" }));
    const list = within(main).getByRole("region", { name: "Connections" });
    await within(list).findByRole("heading", { name: "Acme Slack" });
    const finish = within(list).getByRole("form", { name: "Finish connecting Slack" });
    const token = within(finish).getByLabelText(/^Bot User OAuth Token/) as HTMLInputElement;
    const secret = within(finish).getByLabelText(/^Signing Secret/) as HTMLInputElement;
    fireEvent.change(token, { target: { value: "xoxp-not-a-bot-token-at-all" } });
    fireEvent.change(secret, { target: { value: SECRET } });
    fireEvent.click(within(finish).getByRole("button", { name: "Finish connecting" }));
    expect(await within(finish).findByText(/starts with xoxb-/)).toBeTruthy();
    expect(token.value).toBe("");
    expect(secret.value).toBe("");
  });

  it("shows the EU note to an EU workspace's admins, and a different removal warning", async () => {
    server.integrations.slackOffered = true;
    server.integrations.connections = [
      connection({
        service: "slack",
        label: "Acme Slack",
        targets: [],
        identity: "Acme",
        slack: {
          requestUrl: `https://app.portifact.com/integrations/slack/events/default/ic_${"a".repeat(32)}`,
          manifest: "{}",
          createUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
          manifestVersion: 0,
          outdated: true,
        },
      }),
    ];
    renderDashboard("/integrations", server);
    const main = await page();
    expect(within(main).getByText("Older manifest")).toBeTruthy();
    fireEvent.click(within(main).getByRole("button", { name: "Remove Acme Slack" }));
    expect(
      await screen.findByText(
        /Portifact revokes the bot token at Slack\. Delete the app in Slack too\./,
      ),
    ).toBeTruthy();
  });
});

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
        "Product repo works. It acts as octo-bot, and every repository, team or project is reachable.",
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

  it("connects Jira with its site, cloud ID and account email, and shows the site, never the email", async () => {
    renderDashboard("/integrations", server);
    const main = await page();
    const form = within(main).getByRole("region", { name: "Connect a service" });
    fireEvent.click(within(form).getByLabelText("Jira"));
    fireEvent.click(within(form).getByText("Create a least-privilege Jira token"));
    expect(
      within(form).getByText(/read:jira-user, read:jira-work and write:jira-work/),
    ).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/^Label/), { target: { value: "Jira" } });
    fireEvent.change(within(form).getByLabelText(/^Jira site/), {
      target: { value: "acme.atlassian.net" },
    });
    fireEvent.change(within(form).getByLabelText(/^Cloud ID/), {
      target: { value: "11223344-5566-4778-899a-abbccddeeff0" },
    });
    fireEvent.change(within(form).getByLabelText(/^Atlassian account email/), {
      target: { value: "bot@acme.example" },
    });
    fireEvent.change(within(form).getByLabelText("Atlassian API token with scopes"), {
      target: { value: "ATATT3x-dashboard-test-token-0123WXYZ" },
    });
    fireEvent.change(within(form).getByLabelText(/^Project keys/), {
      target: { value: "ENG" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Connect" }));
    const list = within(main).getByRole("region", { name: "Connections" });
    expect(await within(list).findByRole("heading", { name: "Jira" })).toBeTruthy();
    expect(server.bodies.at(-1)).toEqual({
      service: "jira",
      label: "Jira",
      credential: "ATATT3x-dashboard-test-token-0123WXYZ",
      targets: ["ENG"],
      account: "bot@acme.example",
      site: "acme.atlassian.net",
      cloudId: "11223344-5566-4778-899a-abbccddeeff0",
    });
    expect(within(list).getByText("Site acme.atlassian.net")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("bot@acme.example");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("leaves out a connection of a service this version does not know", () => {
    const list = {
      connections: [
        connection(),
        { ...connection({ id: `ic_${"c".repeat(32)}` }), service: "youtrack" },
      ],
      available: true,
      serviceAvailable: true,
      euResidency: false,
    };
    expect(usableConnections(list).map((one) => one.service)).toEqual(["github"]);
  });

  it("shows a Jira connection whose site moved as needing attention, with what to do", async () => {
    server.integrations.connections = [
      connection({ service: "jira", site: "acme", label: "Jira", attention: "site_mismatch" }),
    ];
    renderDashboard("/integrations", server);
    const main = await page();
    expect(
      await within(main).findByText(/the site changed its address\. Remove this connection/),
    ).toBeTruthy();
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

  it("previews a Jira issue from the Atlassian document it sends", async () => {
    dialog({
      connections: [
        connection({
          service: "jira",
          site: "acme",
          targets: [{ id: "ENG", name: "Engineering" }],
        }),
      ],
    });
    const sheet = await screen.findByRole("dialog", { name: "Create an issue from thread 3" });
    fireEvent.click(within(sheet).getByLabelText("The thread's first message"));
    const preview = (within(sheet).getByLabelText(/^Exactly what is sent/) as HTMLTextAreaElement)
      .value;
    expect(preview).toContain("Artifact: Launch plan");
    expect(preview).toContain(
      "First message:\n\n```\nSee ![x](https://evil.test/p.png) @octocat\n```",
    );
    expect(preview).toContain("---\n\nSent from Portifact. Reference: ti_…");
    expect(
      within(sheet).getByRole("combobox", { name: "Repository, team or project" }),
    ).toBeTruthy();
  });

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
        /No connection can be used\. Ask an admin to connect GitHub, Linear or Jira/,
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
          {
            id: `ti_${"4".repeat(32)}`,
            service: "jira",
            target: "Engineering",
            state: "failed",
            key: null,
            url: null,
            failure: "site_changed",
            own: true,
            createdAt: "2026-11-09T09:00:00.000Z",
          },
          {
            // A newer server's service and reason: a neutral sentence, never a missing message.
            id: `ti_${"5".repeat(32)}`,
            service: "youtrack",
            target: "Project",
            state: "failed",
            key: null,
            url: null,
            failure: "tracker_moved",
            own: true,
            createdAt: "2026-11-09T09:00:00.000Z",
          },
        ]}
      />,
      server,
    );
    expect(
      await screen.findByText(
        "Issue in Engineering was not created: the Jira site's address changed.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Issue in Project was not created: it could not be created."),
    ).toBeTruthy();
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
