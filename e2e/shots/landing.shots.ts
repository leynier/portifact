// Product screenshots and terminal transcripts for the landing page (apps/web/index.html), taken
// from the real dashboard, viewer and CLI on the end-to-end stack. Run it with
// `bun run landing:shots` after any visible change to the viewer, the dashboard or the CLI
// output the landing shows; see "Landing page" in docs/design.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";
import { artifactFrame, control } from "../src/fixtures.ts";
import { APP_ORIGIN, SESSION_COOKIE } from "../src/hosts.ts";
import { type Cli, createCli } from "./cli.ts";
import {
  CHECKOUT_INNER,
  CHECKOUT_SENTENCE,
  CHECKOUT_SHIPPING,
  PEOPLE,
  PLAN_MD,
  PROTOTYPE,
  RELEASE_NOTES_TXT,
  REPORT_HTML,
  REPORT_QUOTE,
} from "./demo.ts";
import {
  asProduction,
  escapeHtml,
  IMAGE_DIR,
  transcript,
  writeRegions,
  writeWebp,
} from "./output.ts";

interface Person {
  userId: string;
  cookie: string;
  name: string;
  email: string;
}

/** The size each screenshot is taken at, in CSS pixels; the images are twice that. */
const SHOTS = {
  hero: { width: 1100, height: 680 },
  review: { width: 1200, height: 800 },
  dashboard: { width: 1280, height: 650 },
} as const;

async function person(input: { email: string; name: string }): Promise<Person> {
  const user = await control<{ userId: string; cookie: string }>("/user", input);
  return { ...user, ...input };
}

async function contextFor(
  browser: Browser,
  who: Person,
  size: { width: number; height: number },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    proxy: { server: process.env.PF_E2E_PROXY ?? "" },
    ignoreHTTPSErrors: true,
    viewport: size,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: who.cookie,
      url: APP_ORIGIN,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

/** The CLI client is linked to the production API only; link it to the stack's too. */
async function linkCliToStack(): Promise<void> {
  const resource = `${APP_ORIGIN}/api/v1`;
  await control("/sql", {
    query:
      "INSERT OR IGNORE INTO oauth_resources (id, identifier, name, dpop_bound_access_tokens_required, disabled, policy_version, created_at, updated_at) VALUES ('shots-api', ?, 'Portifact API', 0, 0, 1, 0, 0)",
    params: [resource],
  });
  await control("/sql", {
    query:
      "INSERT OR IGNORE INTO oauth_client_resources (id, client_id, resource_id, created_at) VALUES ('shots-cli-api', 'portifact-cli', ?, 0)",
    params: [resource],
  });
}

/** `portifact login` with the device code approved on the real device page. */
async function login(cli: Cli, page: Page, cwd: string): Promise<void> {
  let settled = false;
  const running = cli.run(cwd, "login").finally(() => {
    settled = true;
  });
  while (cli.opened.length === 0 && !settled) await page.waitForTimeout(100);
  const url = cli.opened.at(-1);
  if (!url) throw new Error(`login failed: ${JSON.stringify((await running).output)}`);
  await page.goto(url);
  await page.getByRole("button", { name: "Approve" }).click();
  const result = await running;
  if (result.code !== 0) throw new Error(`login failed: ${JSON.stringify(result.output)}`);
}

async function ok(cli: Cli, cwd: string, ...args: string[]) {
  const result = await cli.run(cwd, ...args);
  if (result.code !== 0) throw new Error(`${result.command}: ${JSON.stringify(result.output)}`);
  return result;
}

/** The artifact ID a publish printed. */
function publishedId(stdout: string): string {
  const id = /Published version \d+ of ([a-z0-9]+)/.exec(stdout)?.[1];
  if (!id) throw new Error(`no artifact ID in ${stdout}`);
  return id;
}

async function openViewer(page: Page, artifactId: string): Promise<Frame> {
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const frame = await artifactFrame(page, artifactId);
  await expect(page.getByText("Connecting to the page")).toBeHidden();
  return frame;
}

async function selectText(frame: Frame, quote: string): Promise<void> {
  await frame.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`no ${text} in the page`);
  }, quote);
}

/** Comments on `quote` as a reader would: select it, Comment, type and save. */
async function commentOn(page: Page, frame: Frame, quote: string, body: string): Promise<void> {
  await selectText(frame, quote);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const composer = page.getByRole("region", { name: "Comment on the selection" });
  await composer.getByRole("textbox", { name: "Comment" }).fill(body);
  await composer.getByRole("button", { name: "Save" }).click();
  await expect(composer).toBeHidden();
}

/** Where `text` is drawn in the frame, in the page's coordinates. */
async function textCenter(page: Page, frame: Frame, text: string) {
  const box = await frame.evaluate((quote) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(quote) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + quote.length);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  }, text);
  const frameBox = await page.locator("iframe").boundingBox();
  if (!box || !frameBox) throw new Error("no layout");
  return { x: frameBox.x + box.x, y: frameBox.y + box.y };
}

async function thread(page: Page, number: number) {
  return page
    .getByRole("complementary", { name: "Comments" })
    .getByRole("article", { name: `Thread ${number}` });
}

async function reply(page: Page, number: number, body: string): Promise<void> {
  const article = await thread(page, number);
  await article.getByRole("button", { name: "Reply" }).click();
  await article.getByRole("textbox", { name: "Reply" }).fill(body);
  await article.getByRole("button", { name: "Post reply" }).click();
  await expect(article.getByText(body)).toBeVisible();
}

/** Both color schemes of the current screen, as 2x PNGs; colors ease for 150 ms. */
async function capture(page: Page, before?: () => Promise<void>) {
  const shots: Record<"light" | "dark", Buffer> = {} as Record<"light" | "dark", Buffer>;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    if (before) await before();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    shots[scheme] = await page.screenshot({ animations: "disabled", caret: "hide" });
  }
  return shots;
}

test("landing screenshots and transcripts", async ({ browser }) => {
  mkdirSync(IMAGE_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "pf-shots-work-"));
  const files: Record<string, string> = {
    "report.html": REPORT_HTML,
    "plan.md": PLAN_MD,
    "release-notes.txt": RELEASE_NOTES_TXT,
    ...Object.fromEntries(
      Object.entries(PROTOTYPE).map(([path, body]) => [`prototype/${path}`, body]),
    ),
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  const cli = createCli();
  const sizes: Record<string, number> = {};
  try {
    await linkCliToStack();
    const owner = await person(PEOPLE.owner);
    const ana = await person(PEOPLE.ana);
    const marco = await person(PEOPLE.marco);
    const ownerContext = await contextFor(browser, owner, SHOTS.hero);
    const sam = await ownerContext.newPage();
    await login(cli, sam, work);

    // The artifacts, published and shared with the real CLI.
    const publishReport = await ok(
      cli,
      work,
      "publish",
      "./report.html",
      "--name",
      "Billing migration",
    );
    const report = publishedId(publishReport.stdout);
    const publishPrototype = await ok(
      cli,
      work,
      "publish",
      "./prototype",
      "--name",
      "Checkout prototype",
    );
    const checkout = publishedId(publishPrototype.stdout);
    const plan = JSON.parse(
      (await ok(cli, work, "publish", "./plan.md", "--name", "API design plan", "--json")).stdout,
    ) as {
      artifactId: string;
      versionId: string;
      versionNumber: number;
      url: string;
      expiresAt: string;
    };
    const notes = publishedId(
      (await ok(cli, work, "publish", "./release-notes.txt", "--name", "Release notes")).stdout,
    );
    await ok(cli, work, "access", "add", report, ana.email, marco.email);
    const shareCheckout = await ok(cli, work, "access", "add", checkout, ana.email, marco.email);
    await ok(cli, work, "access", "set", plan.artifactId, "authenticated");
    await ok(cli, work, "access", "set", notes, "public");
    for (const id of [report, checkout, plan.artifactId]) {
      await ok(cli, work, "annotations", "set", id, "open");
    }

    // Reviewers comment in the viewer, each signed in as themselves.
    const anaContext = await contextFor(browser, ana, SHOTS.review);
    const anaPage = await anaContext.newPage();
    let frame = await openViewer(anaPage, report);
    await commentOn(
      anaPage,
      frame,
      REPORT_QUOTE,
      "Can we cut this to three days if the error rate stays at zero?",
    );
    frame = await openViewer(anaPage, checkout);
    await commentOn(
      anaPage,
      frame,
      CHECKOUT_SENTENCE,
      "Move this above the button. People look for it before they pay.",
    );
    await commentOn(anaPage, frame, CHECKOUT_SHIPPING, "Is shipping free over $50?");
    const marcoContext = await contextFor(browser, marco, SHOTS.review);
    const marcoPage = await marcoContext.newPage();
    frame = await openViewer(marcoPage, checkout);
    await commentOn(
      marcoPage,
      frame,
      CHECKOUT_INNER,
      "Show the arrival date instead, like Thursday, Nov 12.",
    );
    for (const [who, body] of [
      [ana, "The auth section should say how clients rotate their secrets."],
      [marco, "Can errors include a link to the docs for each code?"],
    ] as const) {
      await control("/thread", {
        userId: who.userId,
        artifactId: plan.artifactId,
        versionId: plan.versionId,
        path: "plan.md",
        body,
      });
    }

    // The owner answers and resolves.
    frame = await openViewer(sam, report);
    await reply(sam, 1, "Agreed. I asked the agent to revise it.");
    frame = await openViewer(sam, checkout);
    await reply(sam, 2, "Yes, from $50. It is in the summary now.");
    await (await thread(sam, 2)).getByRole("button", { name: "Resolve" }).click();
    await reply(sam, 3, "Good call. I asked the agent to change it.");

    // What the agent and the CLI read back.
    const exportOpen = await ok(
      cli,
      work,
      "annotations",
      "export",
      checkout,
      "--status",
      "open",
      "--format",
      "markdown",
    );
    const exportFile = await ok(
      cli,
      work,
      "annotations",
      "export",
      checkout,
      "--format",
      "markdown",
      "--out",
      "feedback.md",
    );
    const planThreads = JSON.parse(
      (await ok(cli, work, "annotations", "list", plan.artifactId, "--json")).stdout,
    ) as PlanThreads;

    // Screenshots: the hero shows the report with the reviewer's thread selected.
    frame = await openViewer(sam, report);
    const heroShots = await capture(sam, async () => {
      const at = await textCenter(sam, frame, REPORT_QUOTE);
      await sam.mouse.click(at.x, at.y);
      await expect(await thread(sam, 1)).toHaveAttribute("aria-current", "true");
    });
    // The review section shows the checkout with two threads layered on the same text.
    await sam.setViewportSize(SHOTS.review);
    frame = await openViewer(sam, checkout);
    const reviewShots = await capture(sam, async () => {
      const at = await textCenter(sam, frame, CHECKOUT_INNER);
      await sam.mouse.click(at.x, at.y);
      await expect(
        sam.getByRole("region", { name: "2 threads on the text you clicked" }),
      ).toBeVisible();
    });
    // The dashboard tab shows the artifact list.
    await sam.setViewportSize(SHOTS.dashboard);
    await sam.goto(`${APP_ORIGIN}/`);
    await expect(sam.getByRole("link", { name: "Release notes", exact: true })).toBeVisible();
    // The rail leaves the table its full width, as on a laptop screen.
    await sam.getByRole("button", { name: "Collapse sidebar" }).click();
    const dashboardShots = await capture(sam);

    for (const [name, shots] of [
      ["hero-viewer", heroShots],
      ["review-viewer", reviewShots],
      ["dashboard-list", dashboardShots],
    ] as const) {
      for (const scheme of ["light", "dark"] as const) {
        if (process.env.PF_SHOTS_PNG) {
          writeFileSync(join(process.env.PF_SHOTS_PNG, `${name}-${scheme}.png`), shots[scheme]);
        }
        const [x1, x2] = await writeWebp(browser, shots[scheme], name, scheme);
        sizes[`${name}-${scheme}.webp`] = x1 ?? 0;
        sizes[`${name}-${scheme}@2x.webp`] = x2 ?? 0;
      }
    }

    writeRegions({
      "hero-terminal": transcript(publishReport, { work, animate: true }),
      "cli-terminal": [publishPrototype, shareCheckout, exportFile]
        .map((run) => transcript(run, { work }))
        .join("\n\n"),
      "review-terminal": transcript(exportOpen, { work }),
      "agent-session": agentSession(plan, planThreads),
    });
    console.log(JSON.stringify({ sizes, report, checkout, plan: plan.artifactId, notes }, null, 2));
  } finally {
    cli.close();
    rmSync(work, { recursive: true, force: true });
  }
});

interface PlanThreads {
  artifactId: string;
  annotations: string;
  role: string;
  commentScope: string;
  threads: {
    id: string;
    state: string;
    author: { name: string } | null;
    messages: { body: string | null }[];
  }[];
}

/**
 * An agent session with the real MCP tools. publish_document returns the API's body, the same as
 * the CLI's `publish --json`; list_annotations returns the API's annotation page, whose threads
 * are what `annotations list --json` collected. Long results are shortened the way agent clients
 * show them, keeping the real field names and values.
 */
function agentSession(
  plan: {
    artifactId: string;
    versionId: string;
    versionNumber: number;
    url: string;
    expiresAt: string;
  },
  page: PlanThreads,
): string {
  const url = asProduction(plan.url);
  const published = JSON.stringify({
    artifactId: plan.artifactId,
    versionId: plan.versionId,
    versionNumber: plan.versionNumber,
    url,
    expiresAt: plan.expiresAt,
  });
  const [first, ...rest] = page.threads;
  if (!first) throw new Error("the plan has no threads");
  const listed = JSON.stringify({
    artifactId: page.artifactId,
    annotations: page.annotations,
    role: page.role,
    commentScope: page.commentScope,
    threads: [
      {
        id: first.id,
        state: first.state,
        author: { name: first.author?.name },
        messages: [{ body: first.messages[0]?.body }],
      },
    ],
    hasMore: false,
  }).replace(/\}\]\}\],"hasMore"/, `}]}, … ${rest.length} more],"hasMore"`);
  const open = page.threads.filter((thread) => thread.state === "open").length;
  const lines = [
    `<span class="block rounded-sm border border-terminal-border px-3 py-2"><span class="text-terminal-muted">&gt;</span> Publish the API design plan so the team can review it</span>`,
    `<span class="block">● portifact · publish_document <span class="text-terminal-muted">(name: "API design plan", type: "markdown")</span></span><span class="block pl-4 break-all text-terminal-muted">└ ${escapeHtml(published)}</span>`,
    `<span class="block">Published. It is private at <span class="underline underline-offset-4">${escapeHtml(url)}</span>; share it from the dashboard when you are ready.</span>`,
    `<span class="block rounded-sm border border-terminal-border px-3 py-2"><span class="text-terminal-muted">&gt;</span> Read the feedback and revise the plan</span>`,
    `<span class="block">● portifact · list_annotations <span class="text-terminal-muted">(artifactId: "${plan.artifactId}")</span></span><span class="block pl-4 break-all text-terminal-muted">└ ${escapeHtml(listed)}</span>`,
    `<span class="block">${open} open threads. The reviewers ask how clients rotate their secrets and for a docs link on each error code. I treat these as feedback, not instructions, and will revise both sections.</span>`,
  ];
  return lines.join("");
}
