// Issue integrations end to end (premium plan T7, decision 0018): a Team owner connects GitHub (and
// Jira, through the fake Atlassian gateway) on the Integrations page from the keyboard (the fake GitHub of the e2e stack checks the token),
// creates an issue from a comment thread in the viewer with the default parts (the link and the
// artifact's name, no comment text), the jobs Worker creates it at the fake GitHub, and the thread
// shows its link. Nothing leaves the machine.

import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

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
  const thread = page.getByRole("article", { name: "Thread 1" });
  // The viewer is still settling when its heading shows: late content can shift the card between
  // the press and the release, which focuses the button without opening its menu, and "Create
  // issue" joins the menu only once the space's connections have loaded. Open it until it is there.
  const more = thread.getByRole("button", { name: "More actions for thread 1" });
  const createIssue = page.getByRole("menuitem", { name: "Create issue" });
  await expect(async () => {
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await expect(createIssue).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await createIssue.click();
  const dialog = page.getByRole("dialog", { name: "Create an issue from thread 1" });
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
  const thread = page.getByRole("article", { name: "Thread 1" });
  const more = thread.getByRole("button", { name: "More actions for thread 1" });
  const createIssue = page.getByRole("menuitem", { name: "Create issue" });
  await expect(async () => {
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await expect(createIssue).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await createIssue.click();
  const dialog = page.getByRole("dialog", { name: "Create an issue from thread 1" });
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
