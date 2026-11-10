// Comment notices end to end (premium plan P5; "Comment notices" in docs/security.md): a reader's
// comment on a Pro owner's artifact becomes one email digest with counts and a link to the viewer,
// never the comment's text, and the email's unsubscribe link turns the notices off only after a
// click on its page, without a session.

import { axeViolations } from "../src/axe.ts";
import { control, createUser, expect, lastEmail, publish, sql, test } from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SITE = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launch plan</title></head><body><main><h1>Launch plan</h1></main></body></html>',
};
const BODY = "Only for the viewer, never for an inbox";

test("a Pro owner gets a digest of a reader's comment and can unsubscribe from its link", async ({
  page,
}) => {
  const owner = await createUser("Owner");
  const reader = await createUser("Reader");
  await sql(
    "INSERT INTO owner_plans (owner_id, plan, seats, granted_by, updated_at) VALUES (?, 'pro', 1, 'e2e', ?)",
    [owner.userId, Date.now()],
  );
  const name = `Launch plan ${crypto.randomUUID().slice(0, 6)}`;
  const { artifactId, versionId } = await publish({
    ownerId: owner.userId,
    name,
    files: SITE,
    accessMode: "restricted",
    readers: [reader.email],
    annotations: "open",
  });
  // Written eleven minutes ago, so the activity has settled for its digest.
  await control("/thread", {
    userId: reader.userId,
    artifactId,
    versionId,
    path: "index.html",
    body: BODY,
    agoMs: 11 * 60_000,
  });
  await control("/comment-notices", {});

  const email = await lastEmail(owner.email);
  expect(email.subject).toBe("New comments on a Portifact artifact");
  expect(email.text).toContain(`- ${name}\n  1 new thread\n`);
  expect(email.text).toContain(`Open comments: ${APP_ORIGIN}/view/${artifactId}`);
  expect(`${email.subject}${email.text}${email.html}`).not.toContain(BODY);
  expect(`${email.text}${email.html}`).not.toContain(reader.email);
  const link = /https:\/\/\S+\/unsubscribe\?token=\S+/.exec(email.text)?.[0] ?? "";
  expect(link.startsWith(`${APP_ORIGIN}/unsubscribe?token=`)).toBe(true);
  // The reader wrote it: they get nothing about their own comment.
  await expect(control("/mail", { to: reader.email })).rejects.toThrow("no email");

  const setting = async () =>
    (
      await sql<{ comment_notices: number | null }>(
        "SELECT (SELECT comment_notices FROM account_settings WHERE user_id = ?) AS comment_notices",
        [owner.userId],
      )
    )[0]?.comment_notices ?? 1;

  // Opening the link, as a mail scanner does, changes nothing; the click does.
  await page.goto(link);
  await expect(
    page.getByRole("heading", { level: 1, name: "Turn off comment notices" }),
  ).toBeVisible();
  expect(await setting()).toBe(1);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Turn off comment notices" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Comment notices are off" }),
  ).toBeFocused();
  expect(await setting()).toBe(0);
});
