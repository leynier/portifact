import type { Page } from "@playwright/test";
import {
  type Answer,
  artifactPageInFrame,
  CLAIMS_MS,
  expect,
  grantInThisTab,
  me,
  signIn,
  test,
  write,
} from "../src/fixtures.ts";
import { APP_ORIGIN, artifactOrigin, bounced, CONTENT_SITE, GRANT_COOKIE } from "../src/hosts.ts";
import type { GrantServer } from "../src/server.ts";

// Decision 0026, delivery 2, experiment 1. Each test prints one observation line per flow, so a
// run is the evidence for the record's results table.
function report(name: string, value: unknown): void {
  console.log(`[${test.info().project.name}] ${name}: ${JSON.stringify(value)}`);
}

const NOT_GRANTED: Answer = { status: 200, body: JSON.stringify({ granted: false }) };

/**
 * Navigates the page by its own script (a page-initiated navigation, as a link or an attacker's
 * script would), and answers the status of the redemption request it reaches.
 */
async function navigateFrom(page: Page, url: string): Promise<number> {
  const start = page.url();
  const redemption = page.waitForResponse((response) =>
    response.url().includes("/__portifact/data/grant?"),
  );
  await page.evaluate((target) => {
    location.href = target;
  }, url);
  const response = await redemption;
  // Wait until the navigation committed and loaded wherever it ended.
  await page.waitForURL((current) => current.href !== start, { waitUntil: "load" });
  return response.status();
}

/** Runs the direct-visit flow up to Allow and returns the code's URL, not yet redeemed. */
async function heldCode(page: Page, server: GrantServer): Promise<string> {
  await page.goto(`${artifactOrigin("art1")}/`);
  await page.click("#save-here");
  await page.waitForURL(`${APP_ORIGIN}/data/consent?**`);
  server.holdNextCode = true;
  await page.click("#allow");
  const href = await page.locator("#held").getAttribute("href");
  if (href === null) throw new Error("no held code");
  return href;
}

function visitorOf(answer: Answer): string {
  const body = JSON.parse(answer.body) as { granted: boolean; visitor?: string };
  if (!body.granted || !body.visitor) throw new Error(`not granted: ${answer.body}`);
  return body.visitor;
}

test("flow 1, the viewer's frame: the grant arrives and a write as the visitor succeeds, or the viewer falls back", async ({
  page,
  context,
  engine,
  grantServer,
}) => {
  await signIn(context, "alice");
  await page.goto(`${APP_ORIGIN}/view/art1`);
  const before = await me(await artifactPageInFrame(page, "art1"));
  expect(before).toEqual(NOT_GRANTED);
  await page.click("#start");
  await page.locator("#allow").waitFor();
  await page.click("#allow");
  if (!engine.frameWorks) {
    await page.locator("#unavailable").waitFor();
    const events = await page.evaluate(
      () => (window as unknown as { viewerEvents: string[] }).viewerEvents,
    );
    report("frame flow", { granted: false, viewerEvents: events });
    expect(events).toContain("grant-unavailable");
    expect(grantServer.writes.filter((w) => w.artifact === "art1")).toHaveLength(0);
    return;
  }
  const frame = await artifactPageInFrame(page, "art1");
  const granted = await me(frame);
  const visitor = visitorOf(granted);
  const wrote = await write(frame, "from the frame");
  report("frame flow", { granted: true, write: wrote.status });
  expect(wrote.status).toBe(201);
  expect(JSON.parse(wrote.body)).toEqual({ by: visitor });
  expect(grantServer.writes.at(-1)).toEqual({ artifact: "art1", visitor, text: "from the frame" });
  // The partitioned grant stays in the viewer's partition: a top-level visit knows nobody.
  const top = await context.newPage();
  await top.goto(`${artifactOrigin("art1")}/`);
  expect(await me(top)).toEqual(NOT_GRANTED);
  expect((await write(top, "top level")).status).toBe(403);
});

test("flow 2, the top-level tab the viewer offers: the grant arrives and a write succeeds", async ({
  page,
  context,
  grantServer,
}) => {
  await signIn(context, "bea");
  await page.goto(`${APP_ORIGIN}/view/art1`);
  await artifactPageInFrame(page, "art1");
  // The viewer's link is always there for the fallback; the tab drops its opener.
  await page.evaluate(() => {
    const link = document.getElementById("unavailable");
    if (link) link.hidden = false;
  });
  const [tab] = await Promise.all([context.waitForEvent("page"), page.click("#open-tab")]);
  await tab.waitForURL(`${artifactOrigin("art1")}/`);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.click("#save-here");
  await tab.waitForURL(`${APP_ORIGIN}/data/consent?**`);
  await tab.click("#allow");
  await tab.waitForURL(`${artifactOrigin("art1")}/`);
  const visitor = visitorOf(await me(tab));
  const wrote = await write(tab, "from the tab");
  report("tab flow", { granted: true, write: wrote.status });
  expect(wrote.status).toBe(201);
  expect(grantServer.writes.at(-1)).toEqual({ artifact: "art1", visitor, text: "from the tab" });
});

test("flow 3, a direct visit in the same tab and in a popup: the grant arrives and a write succeeds", async ({
  page,
  context,
}) => {
  await signIn(context, "cai");
  await grantInThisTab(page, "art1");
  const visitor = visitorOf(await me(page));
  const wrote = await write(page, "direct");
  expect(wrote.status).toBe(201);

  await page.goto(`${artifactOrigin("art2")}/`);
  const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#save-popup")]);
  await popup.waitForURL(`${APP_ORIGIN}/data/consent?**`);
  await popup.click("#allow");
  await page.waitForFunction(
    () => (window as unknown as { spike: { popupGranted: boolean } }).spike.popupGranted,
  );
  const second = visitorOf(await me(page));
  const wrotePopup = await write(page, "popup");
  report("direct flows", { sameTab: wrote.status, popup: wrotePopup.status });
  expect(wrotePopup.status).toBe(201);
  // Two artifacts get unrelated IDs for the same person.
  expect(second).not.toBe(visitor);
});

test("before a grant the page learns nothing: `me` is the same for signed-in and signed-out visitors", async ({
  page,
  context,
  openBrowser,
}) => {
  await signIn(context, "dee");
  await page.goto(`${artifactOrigin("art1")}/`);
  const signedIn = await page.evaluate(async () => {
    const response = await fetch("/__portifact/data/me");
    const headers = [...response.headers].filter(([name]) => !["date"].includes(name));
    return { status: response.status, body: await response.text(), headers };
  });
  const other = await openBrowser();
  const anonymous = await other.newPage();
  await anonymous.goto(`${artifactOrigin("art1")}/`);
  const signedOut = await anonymous.evaluate(async () => {
    const response = await fetch("/__portifact/data/me");
    const headers = [...response.headers].filter(([name]) => !["date"].includes(name));
    return { status: response.status, body: await response.text(), headers };
  });
  report("me before a grant", { signedIn: signedIn.body, signedOut: signedOut.body });
  expect(signedIn).toEqual(signedOut);
  expect({ status: signedIn.status, body: signedIn.body }).toEqual(NOT_GRANTED);
  // And a write without a grant is refused for both.
  expect((await write(page, "x")).status).toBe(403);
  expect((await write(anonymous, "x")).status).toBe(403);
});

test("a sibling cannot make someone an author: planted cookies and codes grant nothing", async ({
  page,
  context,
  openBrowser,
  grantServer,
}) => {
  // Mallory holds a real grant for art1 in her own browser and knows her own cookie and a code.
  const mallory = await openBrowser();
  await signIn(mallory, "mallory");
  const malloryPage = await mallory.newPage();
  await grantInThisTab(malloryPage, "art1");
  const grantCookie = (await mallory.cookies()).find((c) => c.name === GRANT_COOKIE)?.value ?? "";
  expect(grantCookie).not.toBe("");
  // A second code, issued for Mallory's own transaction and held before it is redeemed.
  const caught = await heldCode(malloryPage, grantServer);

  // The victim, signed in to the app, visits art2, Mallory's sibling artifact.
  await signIn(context, "victim");
  await page.goto(`${artifactOrigin("art2")}/`);
  const planted = await page.evaluate(
    ({ value, site }) => {
      const attempts = [
        `__Host-pf_grant=${value}; Path=/; Secure; Domain=${site}`,
        `__Host-pf_grant=${value}; Path=/; Secure; Domain=${site}; SameSite=None; Partitioned`,
        `__host-pf_grant=${value}; Path=/; Secure; Domain=${site}`,
        `pf_grant=${value}; Path=/; Secure; Domain=${site}`,
        `=__Host-pf_grant=${value}; Path=/; Secure; Domain=${site}`,
      ];
      for (const attempt of attempts) {
        // biome-ignore lint/suspicious/noDocumentCookie: the attack under test is document.cookie.
        document.cookie = attempt;
      }
      return document.cookie.split("; ").map((pair) => pair.split("=")[0]);
    },
    { value: grantCookie, site: CONTENT_SITE },
  );
  // From art2's own script: a same-site navigation to the redemption, then one bounced through
  // another site so it arrives cross-site and passes the redeem gate.
  const direct = await navigateFrom(page, caught);
  await page.goto(`${artifactOrigin("art2")}/`);
  const viaRedirect = await navigateFrom(page, bounced(caught));
  await page.goto(`${artifactOrigin("art1")}/`);
  const victim = await me(page);
  const victimWrite = await write(page, "as mallory?");
  const sent = (await context.cookies(artifactOrigin("art1"))).map((c) => c.name);
  report("sibling attacks", {
    plantedNamesSeenByArt2: planted,
    cookiesForArt1: sent,
    sameSiteRedeem: direct,
    bouncedRedeem: viaRedirect,
    redemptions: grantServer.redemptions.slice(-2).map((r) => r.outcome),
    victimMe: victim.body,
    victimWrite: victimWrite.status,
  });
  expect(direct).toBe(403);
  expect(viaRedirect).toBe(403);
  // The same-site one fails at the gate. The bounced one fails at the gate where the engine
  // reports the chain as same-site (Firefox), and otherwise passes it and fails the nonce binding.
  const [sameSite, bouncedOutcome] = grantServer.redemptions.slice(-2).map((r) => r.outcome);
  expect(sameSite).toBe("gate_refused");
  expect(["gate_refused", "code_refused"]).toContain(bouncedOutcome);
  expect(victim).toEqual(NOT_GRANTED);
  expect(victimWrite.status).toBe(403);
  expect(grantServer.writes.some((w) => w.text === "as mallory?")).toBe(false);
});

test("a code is used once, and only in the browser that asked for it", async ({
  page,
  context,
  openBrowser,
  grantServer,
}) => {
  await signIn(context, "erin");
  const caught = await heldCode(page, grantServer);

  // Another browser, even signed in as the same person, cannot redeem it: it arrives from the
  // app like the real redirect, but without the transaction cookie of the browser that began.
  const other = await openBrowser();
  await signIn(other, "erin");
  const otherPage = await other.newPage();
  await otherPage.goto(`${APP_ORIGIN}/`);
  const elsewhere = await navigateFrom(otherPage, caught);
  await otherPage.goto(`${artifactOrigin("art1")}/`);
  expect(await me(otherPage)).toEqual(NOT_GRANTED);
  // The browser that began follows the app's link and redeems it.
  const first = await navigateFrom(page, caught);
  await page.waitForURL(`${artifactOrigin("art1")}/`);
  const granted = await me(page);
  // A second use fails, in the same browser too.
  await page.goto(`${APP_ORIGIN}/`);
  const again = await navigateFrom(page, caught);
  report("one use, one browser", { otherBrowser: elsewhere, firstUse: first, secondUse: again });
  expect(elsewhere).toBe(403);
  expect(first).toBe(303);
  expect(visitorOf(granted)).toMatch(/^v_/);
  expect(again).toBe(403);
  expect(grantServer.redemptions.slice(-3).map((r) => r.outcome)).toEqual([
    "code_refused",
    "redeemed",
    "code_refused",
  ]);
});

test("revoking ends writes within one renewal period", async ({ page, context }) => {
  await signIn(context, "finn");
  await grantInThisTab(page, "art1");
  expect((await write(page, "before")).status).toBe(201);
  const app = await context.newPage();
  await app.goto(`${APP_ORIGIN}/`);
  const revokedAt = Date.now();
  const revoked = await app.evaluate(async () => {
    const response = await fetch("/api/data/grants/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: "art1" }),
    });
    return response.json();
  });
  expect(revoked).toEqual({ revoked: 1 });
  let refusedAfter = -1;
  while (Date.now() - revokedAt < CLAIMS_MS * 3) {
    if ((await write(page, "after")).status === 403) {
      refusedAfter = Date.now() - revokedAt;
      break;
    }
    await page.waitForTimeout(200);
  }
  report("revocation", { refusedAfterMs: refusedAfter, renewalPeriodMs: CLAIMS_MS });
  expect(refusedAfter).toBeGreaterThanOrEqual(0);
  expect(refusedAfter).toBeLessThanOrEqual(CLAIMS_MS + 1_000);
  expect(await me(page)).toEqual(NOT_GRANTED);
});
