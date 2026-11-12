// Issue integrations end to end (premium plan T7, decision 0018): a Team owner connects GitHub (and
// Jira, through the fake Atlassian gateway) on the Integrations page from the keyboard (the fake GitHub of the e2e stack checks the token),
// creates an issue from a comment thread in the viewer with the default parts (the link and the
// artifact's name, no comment text), the jobs Worker creates it at the fake GitHub, and the thread
// shows its link. Nothing leaves the machine.

import type { Locator, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_HOST, APP_ORIGIN, CONTENT_SITE } from "../src/hosts.ts";

const TOKEN = "github_pat_e2e_fake_token_0123456789abcdef";
// The fake Jira the e2e stack's gateway accepts (e2e/worker/integrations.ts). Not secrets.
const JIRA = {
  site: "acme-e2e",
  cloudId: "0e2e0e2e-5566-4778-899a-abbccddeeff0",
  account: "e2e-jira-bot@example.test",
  token: "ATATT3x-e2e-fake-jira-token-0123456789",
};
const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1></main></body></html>',
};
const WORDS = "Words of a reader that stay in Portifact";

/**
 * Opens thread 1's "Create issue" dialog from its menu. The viewer is still settling when its
 * heading shows: late content can shift the card between a press and its release, which focuses
 * the control without activating it (the menu's button, and the menu's item after it), and
 * "Create issue" joins the menu only once the space's connections have loaded. So the whole
 * gesture repeats until the dialog is there.
 */
async function openCreateIssue(page: Page): Promise<Locator> {
  const thread = page.getByRole("article", { name: "Thread 1" });
  const more = thread.getByRole("button", { name: "More actions for thread 1" });
  const createIssue = page.getByRole("menuitem", { name: "Create issue" });
  const dialog = page.getByRole("dialog", { name: "Create an issue from thread 1" });
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
      await createIssue.click({ timeout: 2_000 });
    }
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return dialog;
}

interface Issue {
  service: string;
  target: string;
  title: string;
  body: string;
  key: string;
  url: string;
}

test("connect GitHub, create an issue from a thread, and see its link", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const owner = await createUser("Owner");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'team', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  await signIn(context, owner);

  // Connect from the Integrations page, reached from the sidebar.
  await page.goto(`${APP_ORIGIN}/`);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Integrations" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  const form = page.getByRole("region", { name: "Connect a service" });
  await form.getByLabel(/^Label/).fill("Product repo");
  await form.getByLabel("Fine-grained personal access token").fill(TOKEN);
  await form.getByLabel(/^Repositories/).fill("acme/site");
  await form.getByRole("button", { name: "Connect" }).press("Enter");
  const list = page.getByRole("region", { name: "Connections" });
  await expect(list.getByRole("heading", { name: "Product repo" })).toBeVisible();
  await expect(list.getByText("Acts as e2e-bot")).toBeVisible();
  await expect(list.getByText(`Credential ending in …${TOKEN.slice(-4)}`)).toBeVisible();
  expect(await page.content()).not.toContain(TOKEN);
  expect(await axeViolations(page)).toEqual([]);

  // A thread on the owner's artifact.
  const name = `Launch plan ${crypto.randomUUID().slice(0, 6)}`;
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    name,
    files: SITE,
    accessMode: "restricted",
    annotations: "open",
  });
  await control("/thread", {
    userId: owner.userId,
    artifactId,
    versionId,
    path: "index.html",
    body: WORDS,
  });

  // Create the issue from the viewer.
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
  const dialog = await openCreateIssue(page);
  await expect(dialog.getByLabel("A link to this thread")).toBeChecked();
  await expect(dialog.getByLabel("The thread's first message")).not.toBeChecked();
  await expect(dialog.getByLabel(/^Exactly what is sent/)).not.toHaveValue(new RegExp(WORDS));
  await expect(dialog.getByLabel("Issue title")).toHaveValue(name);
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).toBeHidden();

  // The jobs Worker creates it at the fake GitHub; the thread then links to it.
  const { issues } = await control<{ ran: number; issues: Issue[] }>("/issues", {});
  const created = issues.find((issue) => issue.title === name);
  expect(created).toBeDefined();
  expect(created?.body).toContain(`/view/${artifactId}?path=%2Findex.html&thread=`);
  expect(created?.body).not.toContain(WORDS);
  expect(created?.body).not.toContain(owner.email);
  await page.reload();
  await page.getByRole("heading", { level: 1, name }).waitFor();
  const link = page
    .getByRole("article", { name: "Thread 1" })
    .getByRole("link", { name: `Issue ${created?.key} in acme/site` });
  await expect(link).toHaveAttribute("href", created?.url ?? "");
  expect(await axeViolations(page)).toEqual([]);
});

test("connect Jira, create an issue from a thread with the message, and see its link", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const owner = await createUser("Jira owner");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'team', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/integrations`);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  const form = page.getByRole("region", { name: "Connect a service" });
  await form.getByLabel("Jira", { exact: true }).check();
  await form.getByLabel(/^Label/).fill("Jira");
  await form.getByLabel(/^Jira site/).fill(`https://${JIRA.site}.atlassian.net`);
  await form.getByLabel(/^Cloud ID/).fill(JIRA.cloudId);
  await form.getByLabel(/^Atlassian account email/).fill(JIRA.account);
  await form.getByLabel("Atlassian API token with scopes").fill(JIRA.token);
  await form.getByLabel(/^Project keys/).fill("eng");
  await form.getByRole("button", { name: "Connect" }).press("Enter");
  const list = page.getByRole("region", { name: "Connections" });
  await expect(list.getByRole("heading", { name: "Jira" })).toBeVisible();
  await expect(list.getByText(`Site ${JIRA.site}.atlassian.net`)).toBeVisible();
  await expect(list.getByText("Acts as E2E Jira Bot")).toBeVisible();
  const content = await page.content();
  expect(content).not.toContain(JIRA.token);
  expect(content).not.toContain(JIRA.account);
  expect(await axeViolations(page)).toEqual([]);

  const name = `Jira plan ${crypto.randomUUID().slice(0, 6)}`;
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    name,
    files: SITE,
    accessMode: "restricted",
    annotations: "open",
  });
  await control("/thread", {
    userId: owner.userId,
    artifactId,
    versionId,
    path: "index.html",
    body: "[~accountid:1] see [here|https://evil.test]",
  });
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
  const dialog = await openCreateIssue(page);
  await dialog.getByLabel("The thread's first message").check();
  await expect(dialog.getByLabel(/^Exactly what is sent/)).toHaveValue(
    /First message:\n\n```\n\[~accountid:1\] see \[here\|https:\/\/evil\.test\]\n```/,
  );
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).toBeHidden();

  const { issues } = await control<{ ran: number; issues: Issue[] }>("/issues", {});
  const created = issues.find((issue) => issue.service === "jira" && issue.title === name);
  expect(created).toBeDefined();
  // The message is the only text of a code block in the Atlassian document.
  const document = JSON.parse(created?.body ?? "{}") as {
    content: { type: string; content?: { text: string; marks?: unknown }[] }[];
  };
  const code = document.content.find((block) => block.type === "codeBlock");
  expect(code?.content).toEqual([
    { type: "text", text: "[~accountid:1] see [here|https://evil.test]" },
  ]);
  expect(created?.url).toBe(`https://${JIRA.site}.atlassian.net/browse/${created?.key}`);
  await page.reload();
  await page.getByRole("heading", { level: 1, name }).waitFor();
  const link = page
    .getByRole("article", { name: "Thread 1" })
    .getByRole("link", { name: `Issue ${created?.key} in Engineering` });
  await expect(link).toHaveAttribute("href", created?.url ?? "");
});

// Slack (decision 0025): the fake Slack app of e2e/worker/integrations.ts, assembled so no
// committed literal looks like a real token. Not secrets.
const SLACK = {
  botToken: ["xoxb", "e2e", "fake", "slack", "bot", "0123456789"].join("-"),
  signingSecret: "e2e0".repeat(8),
};

test("start a Slack connection, finish it, answer Slack's verification and preview a public link", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const owner = await createUser("Owner");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'team', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  await signIn(context, owner);
  await page.goto(`${APP_ORIGIN}/integrations`);
  const form = page.getByRole("region", { name: "Connect a service" });
  await form.getByLabel("Slack").check();
  await form.getByLabel(/^Label/).fill("Acme Slack");
  await form.getByRole("button", { name: "Start" }).press("Enter");
  const list = page.getByRole("region", { name: "Connections" });
  await expect(list.getByRole("heading", { name: "Acme Slack" })).toBeVisible();
  await expect(list.getByText("Not finished", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: /Create the app in Slack/ })).toHaveAttribute(
    "href",
    /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/,
  );
  const requestUrl = await list
    .getByText(/\/integrations\/slack\/events\/default\/ic_[0-9a-f]{32}/)
    .first()
    .textContent();
  const path = /\/integrations\/slack\/events\/default\/ic_[0-9a-f]{32}/.exec(
    String(requestUrl),
  )?.[0];
  expect(path).toBeTruthy();
  expect(await axeViolations(page)).toEqual([]);

  const finish = list.getByRole("form", { name: "Finish connecting Slack" });
  await finish.getByLabel(/^Bot User OAuth Token/).fill(SLACK.botToken);
  await finish.getByLabel(/^Signing Secret/).fill(SLACK.signingSecret);
  await finish.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(list.getByText("Slack workspace E2E Slack")).toBeVisible();
  await expect(list.getByText(/click Verify next to the Request URL/)).toBeVisible();
  expect(await page.content()).not.toContain(SLACK.botToken);

  // Slack's "Verify": a signed url_verification answers the challenge; an unsigned one is refused.
  const body = JSON.stringify({ type: "url_verification", challenge: "e2eChallenge_1" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHmac } = await import("node:crypto");
  const signature = `v0=${createHmac("sha256", SLACK.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const verified = await page.request.post(`${APP_ORIGIN}${path}`, {
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    data: body,
  });
  expect(verified.status()).toBe(200);
  expect(await verified.json()).toEqual({ challenge: "e2eChallenge_1" });
  const forged = await page.request.post(`${APP_ORIGIN}${path}`, {
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${"0".repeat(64)}`,
    },
    data: body,
  });
  expect(forged.status()).toBe(401);
  expect(await forged.text()).toBe("");

  // A link to the owner's public artifact posted in Slack: one chat.unfurl with its name and
  // type, after the answer; a private artifact's link in the same message gets nothing.
  const open = await publish({
    ownerId: owner.userId,
    type: "markdown",
    name: "E2E <!channel> plan",
    files: { "index.md": "# Plan" },
    accessMode: "public",
  });
  const closed = await publish({
    ownerId: owner.userId,
    name: "Private plan",
    files: { "index.html": "<p>private</p>" },
  });
  const openUrl = `https://${open.artifactId}.${CONTENT_SITE}/`;
  const closedUrl = `https://${APP_HOST}/view/${closed.artifactId}`;
  const shared = JSON.stringify({
    type: "event_callback",
    team_id: "T0E2E0001",
    api_app_id: "A0E2E",
    event: {
      type: "link_shared",
      channel: "C0E2E",
      user: "U0E2E",
      message_ts: "1700000000.000100",
      unfurl_id: "C0E2E.1700000000.000100.e2e",
      source: "conversations_history",
      links: [
        { domain: CONTENT_SITE, url: openUrl },
        { domain: APP_HOST, url: closedUrl },
      ],
    },
    authorizations: [{ team_id: "T0E2E0001", is_bot: true, is_enterprise_install: false }],
    is_enterprise_install: false,
  });
  const before = (await control<{ unfurls: unknown[] }>("/slack-unfurls", {})).unfurls.length;
  const posted = await page.request.post(`${APP_ORIGIN}${path}`, {
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", SLACK.signingSecret).update(`v0:${timestamp}:${shared}`).digest("hex")}`,
    },
    data: shared,
  });
  expect(posted.status()).toBe(200);
  expect(await posted.text()).toBe("");
  let sent: { unfurl_id: string; unfurls: Record<string, unknown> } | undefined;
  await expect
    .poll(async () => {
      const { unfurls } = await control<{ unfurls: (typeof sent)[] }>("/slack-unfurls", {});
      sent = unfurls.slice(before).find((one) => one?.unfurl_id === "C0E2E.1700000000.000100.e2e");
      return sent !== undefined;
    })
    .toBe(true);
  expect(Object.keys(sent?.unfurls ?? {})).toEqual([openUrl]);
  expect(sent?.unfurls[openUrl]).toEqual({
    blocks: [
      {
        type: "section",
        text: { type: "plain_text", text: "E2E &lt;!channel&gt; plan", emoji: false },
      },
      {
        type: "context",
        elements: [{ type: "plain_text", text: "Markdown document on Portifact", emoji: false }],
      },
    ],
  });
});
