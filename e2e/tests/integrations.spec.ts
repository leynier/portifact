// Issue integrations end to end (premium plan T7, decision 0018): a Team owner connects GitHub on
// the Integrations page from the keyboard (the fake GitHub of the e2e stack checks the token),
// creates an issue from a comment thread in the viewer with the default parts (the link and the
// artifact's name, no comment text), the jobs Worker creates it at the fake GitHub, and the thread
// shows its link. Nothing leaves the machine.

import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, publish, signIn, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const TOKEN = "github_pat_e2e_fake_token_0123456789abcdef";
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
