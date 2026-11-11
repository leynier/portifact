// An EU workspace end to end (premium plan E5, decision 0005, step E5.8): created by the operator
// in the EU region, a member publishes a site and a Markdown document into it from the dashboard
// (the uploads go to the EU bucket), a visitor opens the public site and a listed reader the
// restricted document on the artifact origin, the reader comments in the viewer and the owner
// side resolves the thread, a share link opens, a move to the personal space is refused because
// it would cross regions, an artifact is deleted and the operator deletes the workspace. After
// each stage the e2e Worker's `/where` says where the rows and objects are: the artifacts,
// versions, objects, threads, access log rows and bytes in the EU database, access log and bucket
// and never in the default ones; only the directory, the workspace, its members and its plan in
// the global database. The stack runs with REGION_GUARD=strict (e2e/wrangler.jsonc), so a
// statement that crosses databases on any of these paths fails the request it is part of.

import type { Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  artifactFrame,
  control,
  createShareLink,
  createUser,
  expect,
  routeStorage,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin } from "../src/hosts.ts";

const QUOTE = "Residency stays in the EU";
const SITE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EU site</title></head><body><main><h1>EU site</h1><p>${QUOTE}</p></main></body></html>`;
const NOTES = `# EU notes\n\n${QUOTE}, and so do the comments.\n`;

interface Counts {
  artifacts: number;
  versions: number;
  versionFiles: number;
  objects: number;
  usage: number;
  threads: number;
  messages: number;
  shareLinks: number;
  accessEvents: number;
  traffic: number;
  views: number;
  r2Objects: number;
}

interface Where {
  default: Counts;
  eu: Counts;
  global: {
    directory: { id: string; region: string }[];
    workspaces: number;
    members: number;
    plans: number;
    tombstones: { id: string; kind: string }[];
  };
  euGlobalCopies: { workspaces: number; directory: number; tombstones: number };
}

const NOTHING: Counts = {
  artifacts: 0,
  versions: 0,
  versionFiles: 0,
  objects: 0,
  usage: 0,
  threads: 0,
  messages: 0,
  shareLinks: 0,
  accessEvents: 0,
  traffic: 0,
  views: 0,
  r2Objects: 0,
};

function where(ownerId: string, artifactIds: string[]): Promise<Where> {
  return control<Where>("/where", { ownerId, artifactIds });
}

/** Nothing of the owner in the default region, and no global table copied into the EU one. */
async function onlyInEu(ownerId: string, artifactIds: string[]): Promise<Where> {
  const found = await where(ownerId, artifactIds);
  expect(found.default).toEqual(NOTHING);
  expect(found.euGlobalCopies).toEqual({ workspaces: 0, directory: 0, tombstones: 0 });
  return found;
}

function operator(...argv: string[]) {
  return control<{ exitCode: number; output: string }>("/operator", { argv });
}

/** Runs every job waiting in each region's outbox through the jobs Worker's consumer. */
function runJobs() {
  return control<{ ran: { region: string; topic: string; acked: boolean }[] }>("/jobs", {});
}

async function euId(ownerId: string, type: string): Promise<string> {
  const [row] = await control<{ id: string }[]>("/sql", {
    query: "select id from artifacts where owner_id = ? and type = ? and state = 'active'",
    params: [ownerId, type],
    region: "eu",
  });
  expect(row?.id).toBeDefined();
  return row?.id as string;
}

/** Selects `quote` in the artifact frame, as a reader would. */
async function selectQuote(frame: Awaited<ReturnType<typeof artifactFrame>>, quote: string) {
  await frame.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
  }, quote);
}

async function open(page: Page, path: string, title: string) {
  await page.goto(`${APP_ORIGIN}${path}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function publishFromDashboard(
  page: Page,
  slug: string,
  file: { name: string; mimeType: string; body: string },
  type: "Site" | "Markdown",
  name: string,
) {
  await open(page, `/publish?workspace=${slug}`, "Publish");
  if (type === "Markdown") {
    await page.getByRole("radio", { name: /^Markdown/ }).check();
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByLabel("Choose a file").setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.body),
    });
  } else {
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByLabel("Choose files").setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.body),
    });
  }
  await page.getByRole("heading", { name: "Review before publishing" }).waitFor();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published version 1", { exact: true })).toBeVisible();
}

test("an EU workspace keeps its artifacts, comments, logs and bytes in the EU, from creation to deletion", async ({
  page,
  context,
  browser,
  browserName,
  engine,
}) => {
  test.setTimeout(240_000);
  // Playwright's WebKit does not hand a File's bytes to request interception (`routeStorage`),
  // so the dashboard's upload cannot reach the stand-in there; the other engines cover it.
  test.skip(browserName === "webkit", "uploads from the browser need request bodies");
  const admin = await createUser("Admin");
  const reader = await createUser("Reader");
  const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;

  // 1. The operator creates the workspace in the EU with a Team plan (docs/operations.md).
  const created = await operator(
    "workspace-create",
    slug,
    "--name",
    "Residency team",
    "--admin",
    admin.userId,
    "--region",
    "eu",
    "--plan",
    "team",
    "--seats",
    "5",
  );
  expect(created.exitCode, created.output).toBe(0);
  const [workspace] = await sql<{ id: string; region: string }>(
    "select id, region from workspaces where slug = ?",
    [slug],
  );
  expect(workspace?.region).toBe("eu");
  const ownerId = workspace?.id as string;
  {
    const found = await onlyInEu(ownerId, []);
    expect(found.global).toMatchObject({ workspaces: 1, members: 1, plans: 1, directory: [] });
    // The plan's limit columns live with the owner's usage, in its region.
    expect(found.eu.usage).toBe(1);
  }

  // 2. A member publishes a site and a Markdown document from the dashboard.
  await signIn(context, admin);
  await routeStorage(page);
  await publishFromDashboard(
    page,
    slug,
    { name: "index.html", mimeType: "text/html", body: SITE },
    "Site",
    "EU site",
  );
  const siteId = await euId(ownerId, "site");
  await publishFromDashboard(
    page,
    slug,
    { name: "notes.md", mimeType: "text/markdown", body: NOTES },
    "Markdown",
    "EU notes",
  );
  const notesId = await euId(ownerId, "markdown");
  const ids = [siteId, notesId];
  {
    const found = await onlyInEu(ownerId, ids);
    expect(found.eu).toMatchObject({ artifacts: 2, versions: 2, usage: 1 });
    expect(found.eu.objects).toBeGreaterThanOrEqual(2);
    expect(found.eu.versionFiles).toBeGreaterThanOrEqual(2);
    // The uploaded bytes and the rendered document are in the EU bucket only.
    expect(found.eu.r2Objects).toBeGreaterThanOrEqual(3);
    expect(found.global.directory).toEqual(
      ids.map((id) => ({ id, region: "eu" })).sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  // 3. The site is public, the document restricted to a listed reader.
  for (const [artifactId, change] of [
    [siteId, { mode: "public" }],
    [notesId, { addReaders: [reader.email] }],
  ] as const) {
    const changed = await control<{ ok: boolean }>("/access", {
      ownerId: admin.userId,
      artifactId,
      region: "eu",
      ...change,
    });
    expect(changed.ok).toBe(true);
  }

  // Comments are off on a new artifact; the owner opens them on the document, from its session.
  const opened = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/artifacts/${id}/annotations/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "open" }),
    });
    return response.status;
  }, notesId);
  expect(opened).toBe(200);

  // A visitor without an account opens the public site by its link: the viewer frames it.
  const visitor = await browser.newContext();
  try {
    const visit = await visitor.newPage();
    await visit.goto(`${artifactOrigin(siteId)}/`);
    const frame = await artifactFrame(visit, siteId);
    await expect(frame.getByRole("heading", { name: "EU site" })).toBeVisible();
  } finally {
    await visitor.close();
  }

  // 4. The reader opens the restricted document and comments on it in the viewer.
  const readerContext = await browser.newContext();
  try {
    await signIn(readerContext, reader);
    const readerPage = await readerContext.newPage();
    await readerPage.goto(`${artifactOrigin(notesId)}/`);
    await readerPage.waitForURL(`${APP_ORIGIN}/view/${notesId}**`);
    if (engine.reviewWorks) {
      const frame = await artifactFrame(readerPage, notesId);
      await expect(frame.getByText(QUOTE).first()).toBeVisible();
      await expect(readerPage.getByText("Connecting to the page")).toBeHidden();
      await selectQuote(frame, QUOTE);
      await readerPage.getByRole("button", { name: "Comment", exact: true }).click();
      const composer = readerPage.getByRole("region", { name: "Comment on the selection" });
      await composer.getByRole("textbox", { name: "Comment" }).fill("Kept in the EU?");
      await composer.getByRole("button", { name: "Save" }).click();
      await expect(composer).toBeHidden();
      await expect(readerPage.getByText("1 comment thread")).toBeVisible();
    } else {
      // No session in the frame: the reader reaches the document without the bar, through the
      // read handoff, and the comment goes through the same service the viewer calls.
      await readerPage.getByRole("link", { name: "Open without the Portifact bar" }).click();
      await readerPage.waitForURL(`${artifactOrigin(notesId)}/**`);
      await expect(readerPage.getByText(QUOTE).first()).toBeVisible();
      const [version] = await control<{ id: string }[]>("/sql", {
        query: "select current_version_id as id from artifacts where id = ?",
        params: [notesId],
        region: "eu",
      });
      await control("/thread", {
        region: "eu",
        userId: reader.userId,
        artifactId: notesId,
        versionId: version?.id,
        body: "Kept in the EU?",
        path: "notes.md",
      });
    }
  } finally {
    await readerContext.close();
  }
  // The reader's opening is in the EU access log (written in a 5-second batch).
  await expect(async () => {
    const found = await onlyInEu(ownerId, ids);
    expect(found.eu.accessEvents).toBeGreaterThanOrEqual(1);
    expect(found.eu).toMatchObject({ threads: 1, messages: 1 });
    // Traffic and page views are counted in the EU too (5-second batches).
    expect(found.eu.traffic).toBe(1);
    expect(found.eu.views).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 20_000 });

  // 5. The owner side resolves the thread from the viewer's sidebar.
  await page.goto(`${APP_ORIGIN}/view/${notesId}`);
  await page.getByRole("heading", { level: 1, name: "EU notes" }).waitFor();
  const thread = page.getByRole("article", { name: "Thread 1" });
  await thread.getByRole("button", { name: "Resolve" }).click();
  await expect(thread.getByText("Resolved")).toBeVisible();
  const [resolved] = await control<{ state: string }[]>("/sql", {
    query: "select state from annotation_threads where artifact_id = ?",
    params: [notesId],
    region: "eu",
  });
  expect(resolved?.state).toBe("resolved");
  await onlyInEu(ownerId, ids);

  // 6. A share link of the restricted document opens it without an account.
  const link = await createShareLink({ ownerId: admin.userId, artifactId: notesId, region: "eu" });
  const stranger = await browser.newContext();
  try {
    const shared = await stranger.newPage();
    await shared.goto(link.url);
    await shared.waitForURL(`${artifactOrigin(notesId)}/`);
    await expect(shared.getByRole("heading", { name: "EU notes" })).toBeVisible();
  } finally {
    await stranger.close();
  }
  await expect(async () => {
    const found = await onlyInEu(ownerId, ids);
    expect(found.eu.shareLinks).toBe(1);
    // The link's opening is logged for the link, in the EU access log.
    expect(found.eu.accessEvents).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 20_000 });

  // 7. Moving the site to the personal space would cross regions: the dashboard offers no
  // destination, and the API refuses it as web, CLI and MCP do.
  await open(page, `/artifacts/${siteId}?workspace=${slug}`, "EU site");
  const move = page.getByRole("region", { name: "Move to another space" });
  await expect(
    move.getByText("This space keeps its data in the EU, so the artifact can only move"),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await axeViolations(page)).toEqual([]);
  const refused = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/artifacts/${id}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ workspace: null }),
    });
    return { status: response.status, body: await response.json() };
  }, siteId);
  expect(refused).toMatchObject({
    status: 400,
    body: { error: { code: "invalid_input", message: "An artifact cannot move between regions." } },
  });
  expect((await onlyInEu(ownerId, ids)).eu.artifacts).toBe(2);

  // 8. The member deletes the site; the purge runs from the EU outbox.
  const danger = page.getByRole("region", { name: "Danger zone" });
  await danger.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete EU site?" })
    .getByRole("button", { name: "Delete artifact" })
    .click();
  await expect(async () => {
    const [state] = await control<{ state: string }[]>("/sql", {
      query: "select state from artifacts where id = ?",
      params: [siteId],
      region: "eu",
    });
    expect(state?.state ?? "gone").not.toBe("active");
  }).toPass();
  await runJobs();
  {
    const found = await onlyInEu(ownerId, ids);
    expect(found.eu.artifacts).toBe(1);
    expect(found.eu.versions).toBe(1);
    expect(found.global.tombstones).toContainEqual({ id: siteId, kind: "artifact" });
    // The directory keeps the ID for good, so it is never handed out again.
    expect(found.global.directory).toContainEqual({ id: siteId, region: "eu" });
  }

  // 9. The operator deletes the workspace; its jobs finish the EU half.
  const deleted = await operator("workspace-delete", slug, "--confirm", slug);
  expect(deleted.exitCode, deleted.output).toBe(0);
  await expect(async () => {
    await runJobs();
    const found = await where(ownerId, ids);
    expect(found.eu).toEqual(NOTHING);
    expect(found.default).toEqual(NOTHING);
    expect(found.global).toMatchObject({ workspaces: 0, members: 0, plans: 0 });
    expect(found.global.tombstones).toEqual(
      expect.arrayContaining([
        { id: ownerId, kind: "workspace" },
        { id: siteId, kind: "artifact" },
        { id: notesId, kind: "artifact" },
      ]),
    );
    expect(found.euGlobalCopies).toEqual({ workspaces: 0, directory: 0, tombstones: 0 });
  }).toPass({ timeout: 30_000 });
});
