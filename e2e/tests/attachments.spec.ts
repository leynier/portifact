// Comment attachments and screenshots end to end (decision 0029): a file attached from the
// viewer's composer stays in the browser until Post, then goes straight to storage, shows on the thread as a checked image and downloads
// with the name its bytes allow; a reader who cannot see the thread cannot get the file; and a
// screenshot is one frame of the browser's screen capture, taken in the viewer page.
//
// Playwright's WebKit does not hand a File's bytes to request interception (`routeStorage`), so
// there the uploads stop before storage; WebKit still shows and downloads files a thread holds.

import type { Page } from "@playwright/test";
import {
  createUser,
  expect,
  publish,
  routeStorage,
  signIn,
  sql,
  storeObject,
  test,
  type User,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1><p>Hello brave new world</p></main></body></html>',
};
const DOC = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });

/** A 1 by 1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A thread by `author` whose message holds one stored PNG, written as the services write them:
 * the bytes in the bucket at the attachment's key and the row attached to the message.
 */
async function seedThreadWithFile(
  artifactId: string,
  versionId: string,
  ownerId: string,
  author: User,
  name: string,
): Promise<string> {
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const now = Date.now();
  await sql(
    "INSERT INTO annotation_events (artifact_id, thread_id, message_id, actor_id, write_id, kind, at) VALUES (?, ?, ?, ?, ?, 'thread_created', ?)",
    [artifactId, threadId, messageId, author.userId, crypto.randomUUID(), now],
  );
  const [event] = await sql<{ id: number }>(
    "SELECT id FROM annotation_events WHERE thread_id = ?",
    [threadId],
  );
  await sql(
    "INSERT INTO annotation_threads (id, artifact_id, version_id, owner_id, author_id, target, target_bytes, path, state, message_count, revision, change_seq, resolved_at, resolved_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'index.html', 'open', 1, 1, ?, NULL, NULL, ?, ?)",
    [
      threadId,
      artifactId,
      versionId,
      ownerId,
      author.userId,
      DOC,
      DOC.length,
      event?.id ?? 0,
      now,
      now,
    ],
  );
  await sql(
    "INSERT INTO annotation_messages (id, thread_id, artifact_id, owner_id, author_id, body, body_bytes, state, revision, edited_at, created_at) VALUES (?, ?, ?, ?, ?, 'See the file', 12, 'visible', 1, NULL, ?)",
    [messageId, threadId, artifactId, ownerId, author.userId, now],
  );
  await storeObject(`attachments/${artifactId}/${attachmentId}`, new Uint8Array(PNG));
  await sql(
    "INSERT INTO comment_attachments (id, artifact_id, owner_id, thread_id, message_id, uploaded_by, name, size, sha256, content_type, state, created_at, expires_at, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/png', 'attached', ?, NULL, ?)",
    [
      attachmentId,
      artifactId,
      ownerId,
      threadId,
      messageId,
      author.userId,
      name,
      PNG.length,
      hex(await crypto.subtle.digest("SHA-256", PNG)),
      now,
      now,
    ],
  );
  return attachmentId;
}

async function openComposer(page: Page, artifactId: string) {
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const sidebar = page.getByRole("complementary", { name: "Comments" });
  await sidebar.getByRole("button", { name: "Comment on the page" }).click();
  return sidebar;
}

test.beforeEach(async ({ page }) => {
  await routeStorage(page);
});

test("a file attached to a comment shows as a checked image and downloads under a safe name", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "uploads from the browser need request bodies");
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    files: SITE,
    name: "Launch plan",
    annotations: "open",
  });
  await signIn(context, owner);

  let uploadRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" || request.url().includes("/annotations/attachments")) {
      uploadRequests += 1;
    }
  });
  const sidebar = await openComposer(page, artifactId);
  await sidebar.getByLabel("Attach a file").setInputFiles({
    name: "report.html",
    mimeType: "text/html",
    buffer: PNG,
  });
  await expect(sidebar.getByText(/Uploaded when you post/)).toBeVisible();
  // Nothing leaves the browser before Post.
  expect(uploadRequests).toBe(0);
  await sidebar.getByRole("textbox", { name: "Comment" }).fill("The header is red");
  await sidebar.getByRole("button", { name: "Post comment" }).click();
  await expect(sidebar.getByText("1 comment thread")).toBeVisible();

  // Judged by its bytes: shown as an image although it was called .html.
  const image = sidebar.getByRole("img", { name: "report.html" });
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toMatch(/^blob:/);

  const download = page.waitForEvent("download");
  await sidebar
    .getByRole("list", { name: "Attached files" })
    .getByRole("button", { name: "Download report.html" })
    .last()
    .click();
  expect((await download).suggestedFilename()).toBe("report.html.png");
});

test("a reader sees and downloads their own file, and a reader who cannot see the thread gets nothing", async ({
  page,
  context,
}) => {
  const owner = await createUser("Owner");
  const ana = await createUser("Ana");
  const bea = await createUser("Bea");
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    files: SITE,
    name: "Launch plan",
    accessMode: "restricted",
    readers: [ana.email, bea.email],
    annotations: "open",
  });
  const attachmentId = await seedThreadWithFile(
    artifactId,
    versionId,
    owner.userId,
    ana,
    "shot.png",
  );

  await signIn(context, ana);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  const sidebar = page.getByRole("complementary", { name: "Comments" });
  await expect(sidebar.getByRole("img", { name: "shot.png" })).toBeVisible();
  const download = page.waitForEvent("download");
  await sidebar
    .getByRole("list", { name: "Attached files" })
    .getByRole("button", { name: "Download shot.png" })
    .last()
    .click();
  expect((await download).suggestedFilename()).toBe("shot.png");

  // Comments are visible to the owner only by default: Bea sees neither the thread nor the file.
  await page.goto("about:blank");
  await context.clearCookies();
  await signIn(context, bea);
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await expect(page.getByText("No comments yet.")).toBeVisible();
  const status = await page.evaluate(
    async ([id, attachment]) =>
      (await fetch(`/api/v1/artifacts/${id}/annotations/attachments/${attachment}`)).status,
    [artifactId, attachmentId] as const,
  );
  expect(status).toBe(404);
});

test("a screenshot is one frame of the browser's screen capture, shown before it is posted", async ({
  page,
  context,
  browserName,
}) => {
  const owner = await createUser("Owner");
  const { artifactId } = await publish({
    ownerId: owner.userId,
    files: SITE,
    name: "Launch plan",
    annotations: "open",
  });
  await signIn(context, owner);
  // The browser's capture prompt cannot be driven by a test: a stand-in hands the page a stream of
  // a drawn canvas, as the real API hands a stream of what the person chose.
  await page.addInitScript(() => {
    const captures = { count: 0, stopped: 0 };
    (window as unknown as { __captures: typeof captures }).__captures = captures;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: async () => {
          captures.count += 1;
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 48;
          const context = canvas.getContext("2d");
          const draw = () => {
            if (!context) return;
            context.fillStyle = "#c00";
            context.fillRect(0, 0, 64, 48);
          };
          draw();
          const stream = canvas.captureStream(10);
          // Keep frames coming while the page reads one.
          const timer = setInterval(draw, 50);
          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              captures.stopped += 1;
              clearInterval(timer);
              stop();
            };
          }
          return stream;
        },
      },
    });
  });

  const sidebar = await openComposer(page, artifactId);
  await sidebar.getByRole("button", { name: "Attach a screenshot" }).click();
  // The warning comes first: the capture shows everything on what is shared.
  await expect(sidebar.getByText(/stays in this browser until you post/)).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __captures: { count: number } }).__captures.count,
    ),
  ).toBe(0);
  await sidebar.getByRole("button", { name: "Continue" }).click();
  await expect(
    sidebar.getByRole("img", { name: /^Preview of screenshot\.(png|jpg)$/ }),
  ).toBeVisible();
  const captures = await page.evaluate(
    () => (window as unknown as { __captures: { count: number; stopped: number } }).__captures,
  );
  // One capture, and its tracks stopped once the frame was taken.
  expect(captures).toEqual({ count: 1, stopped: 1 });
  await expect(sidebar.getByText(/Uploaded when you post/)).toBeVisible();
  if (browserName === "webkit") return;
  await sidebar.getByRole("textbox", { name: "Comment" }).fill("What I see");
  await sidebar.getByRole("button", { name: "Post comment" }).click();
  await expect(sidebar.getByRole("img", { name: /^screenshot\.(png|jpg)$/ })).toBeVisible();
});
