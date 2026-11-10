// SCIM provisioning for a workspace (premium plan E2, decision 0017), end to end: an admin of an
// Enterprise workspace with a verified email domain creates a SCIM token in the Directory sync
// section of the Members page and copies its secret; the test plays the directory against
// /scim/v2 with it (the request shapes Okta sends), provisioning a person who has no account; the
// person signs in with an email code and is a member at once; the directory deactivates them and
// their session ends. No real directory is involved.

import type { APIRequestContext, Page } from "@playwright/test";
import { axeViolations } from "../src/axe.ts";
import {
  createUser,
  createWorkspace,
  expect,
  lastEmail,
  signIn,
  sql,
  test,
} from "../src/fixtures.ts";
import { APP_ORIGIN } from "../src/hosts.ts";

const SCIM = `${APP_ORIGIN}/scim/v2`;
const TYPE = "application/scim+json";

/** Types the address, asks for a code and signs in with it, from the keyboard. */
async function signInWithCode(page: Page, email: string) {
  await page.goto(`${APP_ORIGIN}/login`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const message = await lastEmail(email);
  const code = /^\d{6}$/m.exec(message.text)?.[0];
  if (!code) throw new Error("no code in the email");
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function directory(request: APIRequestContext, secret: string) {
  const headers = { authorization: `Bearer ${secret}`, "content-type": TYPE };
  return {
    get: (path: string) => request.get(`${SCIM}${path}`, { headers }),
    post: (path: string, data: unknown) =>
      request.post(`${SCIM}${path}`, { headers, data: JSON.stringify(data) }),
    patch: (path: string, data: unknown) =>
      request.patch(`${SCIM}${path}`, { headers, data: JSON.stringify(data) }),
  };
}

test("a directory provisions a person with a token from the dashboard, and deactivating them ends their session", async ({
  page,
  context,
  browser,
}) => {
  const domain = `dir-${crypto.randomUUID().slice(0, 8)}.com`;
  const admin = await createUser("Admin");
  const workspace = await createWorkspace({
    slug: `d-${crypto.randomUUID().slice(0, 8)}`,
    name: "Directory team",
    admin,
  });
  await sql("update owner_plans set plan = 'enterprise' where owner_id = ?", [workspace.id]);
  await sql(
    "insert into workspace_domains (id, workspace_id, domain, token, state, created_at, expires_at, verified_at) values (?, ?, ?, ?, 'verified', ?, ?, ?)",
    [
      `wd_${crypto.randomUUID().replaceAll("-", "")}`,
      workspace.id,
      domain,
      "t".repeat(32),
      Date.now(),
      Date.now() + 86_400_000,
      Date.now(),
    ],
  );

  await signIn(context, admin);
  await page.goto(`${APP_ORIGIN}/members?workspace=${workspace.slug}`);
  const section = page.getByRole("region", { name: "Directory sync (SCIM)" });
  await expect(section.getByText(`${APP_ORIGIN}/scim/v2`)).toBeVisible();
  await section.getByRole("textbox", { name: /^Label/ }).fill("Okta");
  await section.getByRole("button", { name: "Create a SCIM token" }).click();
  await expect(section.getByText("Copy the token now")).toBeVisible();
  const secret = (await section.getByText(/^pfsc_/).textContent())?.trim() ?? "";
  expect(secret).toMatch(/^pfsc_[A-Za-z0-9_-]{43}$/);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    expect(await axeViolations(page), colorScheme).toEqual([]);
  }
  await section.getByRole("button", { name: "I saved it" }).click();

  // The directory looks the person up, then creates them (Okta's sequence).
  const scim = directory(page.request, secret);
  const email = `grace-${crypto.randomUUID().slice(0, 8)}@${domain}`;
  const lookup = await scim.get(`/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`);
  expect(lookup.status()).toBe(200);
  expect(lookup.headers()["content-type"]).toContain(TYPE);
  expect(await lookup.json()).toMatchObject({ totalResults: 0 });
  const created = await scim.post("/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: email,
    name: { givenName: "Grace", familyName: "Hopper" },
    emails: [{ primary: true, value: email, type: "work" }],
    externalId: "00u-grace",
    active: true,
  });
  expect(created.status()).toBe(201);
  const user = (await created.json()) as { id: string; active: boolean };
  expect(user.active).toBe(true);

  // The admin sees the person waiting to sign in, listed with the pending invitations.
  await page.reload();
  const pending = page.getByRole("list", { name: "Pending invitations" });
  await expect(pending.getByText(email)).toBeVisible();
  await expect(pending.getByText("From the directory")).toBeVisible();

  // The person signs in for the first time and is a member at once.
  const guest = await browser.newContext();
  try {
    const login = await guest.newPage();
    await signInWithCode(login, email);
    await expect(login.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    const [account] = await sql<{ id: string }>("select id from users where email = ?", [email]);
    const [membership] = await sql<{ role: string }>(
      "select role from workspace_members where workspace_id = ? and user_id = ?",
      [workspace.id, account?.id ?? ""],
    );
    expect(membership?.role).toBe("member");

    // The directory deactivates them: out of the workspace, and their session ends.
    const off = await scim.patch(`/Users/${user.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.status()).toBe(200);
    expect(await off.json()).toMatchObject({ active: false });
    expect(
      await sql("select 1 from workspace_members where workspace_id = ? and user_id = ?", [
        workspace.id,
        account?.id ?? "",
      ]),
    ).toEqual([]);
    expect(await sql("select 1 from sessions where user_id = ?", [account?.id ?? ""])).toEqual([]);
    await login.goto(`${APP_ORIGIN}/`);
    await expect(login).toHaveURL(/\/login\?next=/);
  } finally {
    await guest.close();
  }
});
