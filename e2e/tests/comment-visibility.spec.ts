// Comment visibility end to end (plan section 8, decision of 2026-11-08 on visibility): by
// default each reader sees only their own threads and the owner's, the owner opens every thread
// to every reader from the dashboard, and an exception per reader narrows one of them again. See
// "Comment visibility" in docs/security.md.

import type { Page } from "@playwright/test";
import { createUser, expect, publish, signIn, sql, test, type User } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1><p>Hello brave new world</p></main></body></html>',
};
const DOC = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });

/** A thread with one message by `author`, written straight to D1 as the services write it. */
async function seedThread(
  artifactId: string,
  versionId: string,
  ownerId: string,
  author: User,
  body: string,
) {
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
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
    "INSERT INTO annotation_messages (id, thread_id, artifact_id, owner_id, author_id, body, body_bytes, state, revision, edited_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'visible', 1, NULL, ?)",
    [messageId, threadId, artifactId, ownerId, author.userId, body, body.length, now],
  );
}

async function as(page: Page, user: User) {
  await page.context().clearCookies();
  await signIn(page.context(), user);
}

/** Opens the viewer and waits for the sidebar's thread count. */
async function viewerThreads(page: Page, artifactId: string, count: number) {
  await page.goto(`${APP_ORIGIN}/view/${artifactId}`);
  await page.getByRole("heading", { level: 1, name: "Launch plan" }).waitFor();
  await expect(
    page.getByText(`${count} comment thread${count === 1 ? "" : "s"}`, { exact: true }),
  ).toBeVisible();
}

test("readers see their own threads and the owner's until the owner opens all comments, and an exception narrows one reader again", async ({
  page,
}) => {
  const owner = await createUser("Owner");
  const ana = await createUser("Ana");
  const bea = await createUser("Bea");
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    name: "Launch plan",
    files: SITE,
    readers: [ana.email, bea.email],
    annotations: "open",
  });
  await seedThread(artifactId, versionId, owner.userId, owner, "From the owner");
  await seedThread(artifactId, versionId, owner.userId, ana, "From Ana");
  await seedThread(artifactId, versionId, owner.userId, bea, "From Bea");

  // The default: Ana sees her thread and the owner's, never Bea's.
  await as(page, ana);
  await viewerThreads(page, artifactId, 2);
  await expect(page.getByText("From Ana")).toBeVisible();
  await expect(page.getByText("From the owner")).toBeVisible();
  await expect(page.getByText("From Bea")).toHaveCount(0);

  // The owner sees all three and lets every reader see every thread.
  await as(page, owner);
  await viewerThreads(page, artifactId, 3);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  const access = page.getByRole("region", { name: "Access" });
  const group = access.getByRole("group", { name: "Who sees comments" });
  await expect(
    group.getByRole("radio", { name: "Only you, and each person their own" }),
  ).toBeChecked();
  await group.getByRole("radio", { name: "Everyone who can open the artifact" }).check();
  await access.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText(/Access saved/).first()).toBeVisible();

  await as(page, ana);
  await viewerThreads(page, artifactId, 3);
  await expect(page.getByText("From Bea")).toBeVisible();

  // An exception for Ana: only her threads and the owner's, while Bea still sees all.
  await as(page, owner);
  await page.goto(`${APP_ORIGIN}/artifacts/${artifactId}`);
  await page
    .getByRole("combobox", { name: `Comments ${ana.email} sees` })
    .selectOption({ label: "Only own and yours" });
  await expect(page.getByText(`${ana.email} now sees: Only own and yours.`)).toBeVisible();

  await as(page, ana);
  await viewerThreads(page, artifactId, 2);
  await expect(page.getByText("From Bea")).toHaveCount(0);
  await as(page, bea);
  await viewerThreads(page, artifactId, 3);
});
