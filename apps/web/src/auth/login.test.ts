// @vitest-environment happy-dom

import { OTP_LIMITS } from "@portifact/contracts";
import { HUMAN_VERIFICATION_REQUIRED } from "@portifact/contracts/human-check";
import { TERMS_NOT_ACCEPTED, TERMS_VERSION } from "@portifact/contracts/terms-version";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HumanCheckCallbacks,
  HumanCheckOptions,
  HumanCheckWidget,
} from "../human-check/turnstile.ts";
import { HUMAN_CHECK_WAIT_MS } from "./human-gate.ts";
import { RESEND_COOLDOWN_SECONDS, setupLogin } from "./login.ts";
import { messages } from "./messages.ts";
import {
  element,
  type FakeApi,
  type FakeLocation,
  fakeApi,
  fakeLocation,
  loadPage,
  pageEnv,
  session,
  settle,
  submit,
} from "./test-page.ts";

const OAUTH_SEARCH =
  "?client_id=c1&response_type=code&sig=s1&ba_param=client_id&ba_param=response_type&ba_param=ba_param";
const OAUTH_QUERY =
  "client_id=c1&response_type=code&sig=s1&ba_param=client_id&ba_param=response_type&ba_param=ba_param";

let api: FakeApi;
let location: FakeLocation;

async function open(search = "") {
  location = fakeLocation(search);
  await setupLogin(document, pageEnv(api, location));
}

const ACCEPTANCE = { version: TERMS_VERSION, acceptTerms: true, confirmAdult: true };

async function requestCode(email: string) {
  element<HTMLInputElement>("email").value = email;
  submit(element<HTMLFormElement>("email-form"));
  await settle();
}

async function enterCode(code: string) {
  element<HTMLInputElement>("code").value = code;
  submit(element<HTMLFormElement>("code-form"));
  await settle();
}

beforeEach(() => {
  loadPage("login");
  api = fakeApi();
  api.on("GET", "/get-session", { status: 200, body: null });
  api.on("POST", "/email-otp/send-verification-otp", { status: 200, body: { success: true } });
  api.on("POST", "/accept-terms", { status: 200, body: { version: TERMS_VERSION } });
});

describe("login page", () => {
  it("offers Google, GitHub and an email code to a visitor without a session", async () => {
    await open();
    expect(element("sign-in").hidden).toBe(false);
    expect(element("signed-in").hidden).toBe(true);
    const providers = [...document.querySelectorAll<HTMLButtonElement>("button[data-provider]")];
    expect(providers.map((button) => button.textContent?.trim())).toEqual([
      "Continue with Google",
      "Continue with GitHub",
    ]);
    expect(document.querySelector('label[for="email"]')?.textContent).toBe("Email address");
  });

  it("signs in with an email code and returns to the login page", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    await open();
    await requestCode("  ada@example.test ");
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/email-otp/send-verification-otp",
      body: { email: "ada@example.test", type: "sign-in" },
    });
    expect(element("methods").hidden).toBe(true);
    expect(element("code-form").hidden).toBe(false);
    expect(element("code-sent").textContent).toBe(messages.codeSent("ada@example.test"));
    expect(element("status").textContent).toBe(messages.codeSentStatus);
    expect(document.activeElement).toBe(element("code"));
    // The legal notice stays above the code step, whose button is described by it.
    expect(element("terms-notice").hidden).toBe(false);
    expect(element("verify-code").getAttribute("aria-describedby")).toBe("terms-notice");

    await enterCode("123 456");
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/sign-in/email-otp",
      body: { email: "ada@example.test", otp: "123456" },
    });
    expect(location.assigned).toEqual(["/"]);
    expect(element("status").textContent).toBe(messages.redirecting);
  });

  it("links an invalid email error to the field and moves focus to it", async () => {
    await open();
    await requestCode("not-an-email");
    const input = element<HTMLInputElement>("email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
    expect(element("email-error").textContent).toBe(messages.emailInvalid);
    expect(element("email-error").hidden).toBe(false);
    // One field: focus goes to it, and its linked error is read with it (docs/accessibility.md).
    expect(element("error-summary").hidden).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(api.calls.filter((call) => call.path === "/email-otp/send-verification-otp")).toEqual(
      [],
    );

    await requestCode("");
    expect(element("email-error").textContent).toBe(messages.emailRequired);

    await requestCode("ada@example.test");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(element("email-error").hidden).toBe(true);
  });

  it("explains when too many codes were requested", async () => {
    api.on("POST", "/email-otp/send-verification-otp", { status: 429, body: null });
    await open();
    await requestCode("ada@example.test");
    expect(element("error-summary").textContent).toBe(messages.rateLimited);
    expect(element("code-form").hidden).toBe(true);
  });

  it("explains why no code goes to a suppressed address", async () => {
    api.on("POST", "/email-otp/send-verification-otp", {
      status: 403,
      body: { error: { code: "email_suppressed", message: "x" } },
    });
    await open();
    await requestCode("bounced@example.test");
    expect(element("error-summary").textContent).toBe(messages.emailSuppressed);
    expect(element("code-form").hidden).toBe(true);
  });

  it("explains when the monthly email limit is reached", async () => {
    api.on("POST", "/email-otp/send-verification-otp", {
      status: 503,
      body: { error: { code: "capacity_unavailable", message: "x" } },
    });
    await open();
    await requestCode("ada@example.test");
    expect(element("error-summary").textContent).toBe(messages.emailCapacity);
    expect(element("code-form").hidden).toBe(true);
  });

  it("explains when Portifact cannot be reached", async () => {
    api.on("POST", "/email-otp/send-verification-otp", { status: 0, body: null });
    await open();
    await requestCode("ada@example.test");
    expect(element("error-summary").textContent).toBe(messages.network);
  });

  it("rejects a code that is not six digits before sending it", async () => {
    await open();
    await requestCode("ada@example.test");
    await enterCode("12");
    expect(element("code-error").textContent).toBe(messages.codeRequired);
    expect(element<HTMLInputElement>("code").getAttribute("aria-describedby")).toBe(
      "code-hint code-error",
    );
    expect(document.activeElement).toBe(element("code"));
    expect(api.calls.some((call) => call.path === "/sign-in/email-otp")).toBe(false);
  });

  it("shows a wrong or expired code next to the field", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 400, body: { code: "INVALID_OTP" } });
    await open();
    await requestCode("ada@example.test");
    await enterCode("000000");
    expect(element("code-error").textContent).toBe(messages.codeInvalid);
    expect(location.assigned).toEqual([]);
  });

  it("reports other failures when verifying a code", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 500, body: null });
    await open();
    await requestCode("ada@example.test");
    await enterCode("000000");
    expect(element("error-summary").textContent).toBe(messages.unexpected);
  });

  describe("sending a new code", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits out the Worker's one-code-a-minute limit with a countdown", async () => {
      expect(RESEND_COOLDOWN_SECONDS).toBe(OTP_LIMITS.perEmailCooldown.windowSeconds);
      await open();
      await requestCode("ada@example.test");
      const resend = element<HTMLButtonElement>("resend-code");
      expect(resend.disabled).toBe(true);
      expect(resend.textContent).toBe(messages.resendIn(60));
      vi.advanceTimersByTime(15_000);
      expect(resend.textContent).toBe(messages.resendIn(45));
      vi.advanceTimersByTime(45_000);
      expect(resend.disabled).toBe(false);
      expect(resend.textContent).toBe(messages.resendCode);

      resend.click();
      await settle();
      expect(element("status").textContent).toBe(messages.codeResent);
      expect(
        api.calls.filter((call) => call.path === "/email-otp/send-verification-otp"),
      ).toHaveLength(2);
      expect(resend.disabled).toBe(true);
      vi.advanceTimersByTime(60_000);

      api.on("POST", "/email-otp/send-verification-otp", { status: 429, body: null });
      resend.click();
      await settle();
      expect(element("error-summary").textContent).toBe(messages.rateLimited);
      expect(resend.disabled).toBe(false);
    });

    it("lets the user change the address", async () => {
      await open();
      await requestCode("ada@example.test");
      element("change-email").click();
      expect(element("code-form").hidden).toBe(true);
      expect(element("methods").hidden).toBe(false);
      expect(document.activeElement).toBe(element("email"));
    });
  });

  it("starts a provider sign-in and follows the provider URL", async () => {
    api.on("POST", "/sign-in/social", {
      status: 200,
      body: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", redirect: true },
    });
    await open();
    element("sign-in").querySelector<HTMLButtonElement>('[data-provider="github"]')?.click();
    await settle();
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/sign-in/social",
      body: { provider: "github", callbackURL: "/", errorCallbackURL: "/login" },
    });
    expect(location.assigned).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?x=1"]);
  });

  it("reports a provider sign-in that could not start", async () => {
    api.on("POST", "/sign-in/social", { status: 403, body: null });
    await open();
    element("sign-in").querySelector<HTMLButtonElement>('[data-provider="google"]')?.click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.unexpected);
    expect(location.assigned).toEqual([]);
  });

  it("explains a provider error without echoing the URL's text", async () => {
    await open("?error=account_not_linked&error_description=%3Cscript%3E");
    expect(element("error-summary").textContent).toBe(messages.providerErrors.account_not_linked);
    loadPage("login");
    await open("?error=%3Cimg%20src%3Dx%3E");
    expect(element("error-summary").textContent).toBe(messages.providerErrorFallback);
    expect(document.querySelector("#error-summary img")).toBeNull();
  });

  it("sends the signed authorization request with the sign-in and follows the consent URL", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("POST", "/sign-in/email-otp", {
      status: 200,
      body: { redirect: true, url: "/consent?client_id=c1&sig=x" },
    });
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    await open(OAUTH_SEARCH);
    // A client asked for a sign-in: the form is offered even with a session.
    expect(element("sign-in").hidden).toBe(false);
    expect(api.calls.some((call) => call.path === "/get-session")).toBe(false);

    await requestCode("ada@example.test");
    await enterCode("123456");
    expect(api.calls.at(-1)?.body).toEqual({
      email: "ada@example.test",
      otp: "123456",
      oauth_query: OAUTH_QUERY,
    });
    expect(location.assigned).toEqual(["/consent?client_id=c1&sig=x"]);

    element("sign-in").querySelector<HTMLButtonElement>('[data-provider="google"]')?.click();
    await settle();
    expect(api.calls.at(-1)?.body).toMatchObject({ provider: "google", oauth_query: OAUTH_QUERY });
  });

  it("goes back to the device page after signing in from it", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    await open("?next=%2Fdevice%3Fuser_code%3DABCDEFGH");
    element("sign-in").querySelector<HTMLButtonElement>('[data-provider="github"]')?.click();
    await settle();
    expect(api.calls.at(-1)?.body).toMatchObject({ callbackURL: "/device?user_code=ABCDEFGH" });
    await requestCode("ada@example.test");
    await enterCode("123456");
    expect(location.assigned.at(-1)).toBe("/device?user_code=ABCDEFGH");
  });

  it("continues to a protected artifact after signing in", async () => {
    const next = `/read/k7d2qm4xab?state=${"n".repeat(43)}`;
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    await open(`?${new URLSearchParams({ next })}`);
    await requestCode("ada@example.test");
    await enterCode("123456");
    expect(location.assigned.at(-1)).toBe(next);
  });

  it("explains that an artifact cannot be opened with the signed-in account", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    await open("?error=artifact_unavailable");
    expect(element("error-summary").textContent).toBe(messages.providerErrors.artifact_unavailable);
    expect(element("signed-in").hidden).toBe(false);
    expect(location.assigned).toEqual([]);
  });

  it("explains that too many artifacts were opened in a short time", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    await open("?error=read_rate_limited");
    expect(element("error-summary").textContent).toBe(messages.providerErrors.read_rate_limited);
    expect(location.assigned).toEqual([]);
  });

  it("forwards a signed-in user straight to the next page", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    await open("?next=%2Fdevice");
    expect(location.assigned).toEqual(["/device"]);
  });

  it("shows who is signed in and signs out", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("POST", "/sign-out", { status: 200, body: { success: true } });
    await open();
    expect(element("signed-in").hidden).toBe(false);
    expect(element("sign-in").hidden).toBe(true);
    expect(element("signed-in-email").textContent).toBe(messages.signedInAs("ada@example.test"));
    expect(element("intro").hidden).toBe(true);
    expect(document.querySelector<HTMLAnchorElement>('#signed-in a[href="/"]')?.textContent).toBe(
      "Open your dashboard",
    );
    element("sign-out").click();
    await settle();
    expect(element("signed-in").hidden).toBe(true);
    expect(element("sign-in").hidden).toBe(false);
    expect(element("intro").hidden).toBe(false);
    expect(element("status").textContent).toBe(messages.signedOut);
  });

  it("keeps the session shown when signing out fails", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("POST", "/sign-out", { status: 500, body: null });
    await open();
    element("sign-out").click();
    await settle();
    expect(element("signed-in").hidden).toBe(false);
    expect(element("error-summary").textContent).toBe(messages.unexpected);
  });

  it("disables a button while its request runs", async () => {
    let release: () => void = () => {};
    api.on(
      "POST",
      "/email-otp/send-verification-otp",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: { success: true } });
        }),
    );
    await open();
    element<HTMLInputElement>("email").value = "ada@example.test";
    submit(element<HTMLFormElement>("email-form"));
    await settle();
    const button = element<HTMLButtonElement>("send-code");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    // Another method chosen meanwhile is ignored: one sign-in at a time.
    element("sign-in").querySelector<HTMLButtonElement>('[data-provider="google"]')?.click();
    await settle();
    expect(api.calls.some((call) => call.path === "/sign-in/social")).toBe(false);
    release();
    await settle();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("sign-in methods of a signed-in user", () => {
  beforeEach(() => {
    api.on("GET", "/get-session", session("ada@example.test"));
  });

  it("shows which providers already sign in to the account", async () => {
    api.on("GET", "/list-accounts", {
      status: 200,
      body: [{ providerId: "google" }, { providerId: "credential" }],
    });
    await open();
    expect(element("method-google").textContent).toBe(messages.methodConnected);
    expect(element("method-github").textContent).toBe(messages.methodNotUsed);
    expect(document.querySelector("button[data-link-provider]")).toBeNull();
  });

  it("keeps the default text when the list cannot be loaded", async () => {
    api.on("GET", "/list-accounts", { status: 500, body: null });
    await open();
    expect(element("method-google").textContent).toBe("Not used yet");
    expect(element("method-github").textContent).toBe("Not used yet");
  });

  it("explains a provider sign-in refused because the provider did not verify the email", async () => {
    api.on("GET", "/get-session", { status: 200, body: null });
    await open("?error=account_not_linked");
    expect(element("error-summary").textContent).toBe(messages.providerErrors.account_not_linked);
    expect(element("error-summary").textContent).toContain("has not verified");
  });
});

describe("terms acceptance at sign-in", () => {
  const providerButton = (name: string) =>
    element("sign-in").querySelector<HTMLButtonElement>(`[data-provider="${name}"]`);

  it("shows the notice with every legal page before any method, and describes each button by it", async () => {
    await open();
    const notice = element("terms-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("By continuing with Google, GitHub or an email code");
    expect(notice.textContent).toContain("18 or older");
    const links = [...notice.querySelectorAll("a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://portifact.com/terms",
      "https://portifact.com/acceptable-use",
      "https://portifact.com/privacy",
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      "Terms of Service",
      "Acceptable Use Policy",
      "Privacy Policy",
    ]);
    // Right above the methods: nothing to act on comes before it.
    const methods = element("methods");
    expect(notice.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const button of [
      providerButton("google"),
      providerButton("github"),
      element("send-code"),
      element("verify-code"),
    ]) {
      expect(button?.getAttribute("aria-describedby")).toBe("terms-notice");
    }
    // No checkbox to tick: choosing a method is the acceptance.
    expect(document.querySelector('#sign-in input[type="checkbox"]')).toBeNull();
  });

  it("records the acceptance before sending a code and before a provider sign-in", async () => {
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    await open();
    await requestCode("ada@example.test");
    providerButton("github")?.click();
    await settle();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([
      // The lookup for single sign-on comes first and accepts nothing.
      { method: "POST", path: "/sso/lookup", body: { email: "ada@example.test" } },
      { method: "POST", path: "/accept-terms", body: ACCEPTANCE },
      {
        method: "POST",
        path: "/email-otp/send-verification-otp",
        body: { email: "ada@example.test", type: "sign-in" },
      },
      { method: "POST", path: "/accept-terms", body: ACCEPTANCE },
      {
        method: "POST",
        path: "/sign-in/social",
        body: { provider: "github", callbackURL: "/", errorCallbackURL: "/login" },
      },
    ]);
  });

  it("stops when the acceptance cannot be recorded", async () => {
    api.on("POST", "/accept-terms", { status: 0, body: null });
    await open();
    await requestCode("ada@example.test");
    expect(element("error-summary").textContent).toBe(messages.network);
    providerButton("google")?.click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.network);
    expect(
      api.calls.filter(
        (call) =>
          call.path !== "/accept-terms" && call.path !== "/sso/lookup" && call.method === "POST",
      ),
    ).toEqual([]);
  });

  it("explains a sign-in the server refused for lack of acceptance", async () => {
    api.on("POST", "/sign-in/email-otp", {
      status: 403,
      body: { code: TERMS_NOT_ACCEPTED, message: "x" },
    });
    await open();
    await requestCode("ada@example.test");
    await enterCode("123456");
    expect(element("error-summary").textContent).toBe(messages.providerErrors[TERMS_NOT_ACCEPTED]);
    expect(element("code-error").hidden).toBe(true);
    expect(location.assigned).toEqual([]);

    loadPage("login");
    await open(`?error=${TERMS_NOT_ACCEPTED}`);
    expect(element("error-summary").textContent).toBe(messages.providerErrors[TERMS_NOT_ACCEPTED]);
  });
});

describe("a signed-in account without the current terms", () => {
  beforeEach(() => {
    api.on("GET", "/get-session", session("ada@example.test", null));
  });

  it("is asked to accept them instead of going on", async () => {
    await open("?next=%2Fdevice");
    expect(location.assigned).toEqual([]);
    expect(element("terms-update").hidden).toBe(false);
    expect(element("sign-in").hidden).toBe(true);
    expect(element("signed-in").hidden).toBe(true);
    expect(element("terms-update-email").textContent).toBe(
      messages.termsUpdateFor("ada@example.test"),
    );
  });

  it("asks again when the account accepted an older version", async () => {
    api.on("GET", "/get-session", session("ada@example.test", "2000-01-01"));
    await open();
    expect(element("terms-update").hidden).toBe(false);
  });

  it("records the acceptance when the user agrees, and continues", async () => {
    await open("?next=%2Fdevice");
    const notice = element("terms-update-notice");
    expect(notice.textContent).toContain("By selecting Agree and continue");
    expect([...notice.querySelectorAll("a")].map((link) => link.href)).toEqual([
      "https://portifact.com/terms",
      "https://portifact.com/acceptable-use",
      "https://portifact.com/privacy",
    ]);
    expect(element("terms-update-continue").getAttribute("aria-describedby")).toBe(
      "terms-update-notice",
    );
    expect(api.calls.some((call) => call.path === "/accept-terms")).toBe(false);
    element("terms-update-continue").click();
    await settle();
    expect(api.calls.at(-1)).toEqual({ method: "POST", path: "/accept-terms", body: ACCEPTANCE });
    expect(location.assigned).toEqual(["/device"]);
    expect(element("status").textContent).toBe(messages.redirecting);
  });

  it("opens the dashboard after accepting when nothing else was asked", async () => {
    await open();
    element("terms-update-continue").click();
    await settle();
    expect(location.assigned).toEqual(["/"]);
  });

  it("reports an acceptance that could not be recorded", async () => {
    api.on("POST", "/accept-terms", { status: 500, body: null });
    await open();
    element("terms-update-continue").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.unexpected);
    expect(location.assigned).toEqual([]);

    api.on("POST", "/accept-terms", { status: 0, body: null });
    element("terms-update-continue").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.network);
  });

  it("can sign out instead", async () => {
    api.on("POST", "/sign-out", { status: 500, body: null });
    await open();
    element("terms-update-sign-out").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.unexpected);
    expect(element("terms-update").hidden).toBe(false);

    api.on("POST", "/sign-out", { status: 200, body: { success: true } });
    element("terms-update-sign-out").click();
    await settle();
    expect(element("terms-update").hidden).toBe(true);
    expect(element("sign-in").hidden).toBe(false);
    expect(element("status").textContent).toBe(messages.signedOut);
  });
});

describe("human check of new accounts", () => {
  interface Rendered {
    container: HTMLElement;
    callbacks: HumanCheckCallbacks;
    options: HumanCheckOptions | undefined;
    removed: boolean;
  }

  /** A widget that records each challenge and lets the test solve, expire or fail it. */
  function fakeWidget() {
    const rendered: Rendered[] = [];
    const widget: HumanCheckWidget = {
      render(container, callbacks, options) {
        const entry: Rendered = { container, callbacks, options, removed: false };
        rendered.push(entry);
        return () => {
          entry.removed = true;
        };
      },
    };
    return { widget, rendered, last: () => rendered.at(-1) as Rendered };
  }

  async function openWith(widget: HumanCheckWidget | null, search = "") {
    location = fakeLocation(search);
    await setupLogin(document, { ...pageEnv(api, location), humanCheck: widget });
  }

  const paths = () => api.calls.map((call) => call.path);

  beforeEach(() => {
    api.on("POST", "/verify-human", { status: 200, body: { verified: true } });
  });

  it("runs invisibly from page load, below the methods, with no copy until it is needed", async () => {
    const fake = fakeWidget();
    await openWith(fake.widget);
    expect(fake.rendered).toHaveLength(1);
    expect(fake.last().options).toEqual({ appearance: "interaction-only" });
    expect(fake.last().container.id).toBe("human-check-widget");
    expect(element("human-check-widget").hidden).toBe(false);
    expect(element("human-check-copy").hidden).toBe(true);
    // After every way to sign in, so a challenge shows up next to the action that needs it.
    const group = element("human-check");
    expect(
      element("methods").compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(element("human-check-heading").textContent).toContain("human");
  });

  it("does not run for a signed-in visitor", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    const fake = fakeWidget();
    await openWith(fake.widget);
    expect(fake.rendered).toHaveLength(0);
  });

  it("sends a solved token once, after the acceptance and before the sign-in", async () => {
    const fake = fakeWidget();
    await openWith(fake.widget);
    fake.last().callbacks.onToken("token-1");
    await requestCode("new@example.test");
    expect(paths().slice(paths().indexOf("/accept-terms"))).toEqual([
      "/accept-terms",
      "/verify-human",
      "/email-otp/send-verification-otp",
    ]);
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/verify-human",
      body: { token: "token-1" },
    });
    // The token is single use: the challenge is removed and the next sign-in starts a new one.
    expect(fake.rendered[0]?.removed).toBe(true);
    expect(fake.rendered).toHaveLength(1);
  });

  it("waits for a challenge still running, then sends its token", async () => {
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    const fake = fakeWidget();
    await openWith(fake.widget);
    document.querySelector<HTMLButtonElement>('button[data-provider="github"]')?.click();
    await settle();
    expect(paths()).not.toContain("/sign-in/social");
    fake.last().callbacks.onToken("late-token");
    await settle();
    expect(paths().indexOf("/verify-human")).toBeLessThan(paths().indexOf("/sign-in/social"));
    expect(location.assigned).toEqual(["https://github.com/x"]);
  });

  it("shows the challenge with its explanation only when Cloudflare asks for an interaction", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = fakeWidget();
      await openWith(fake.widget);
      element<HTMLInputElement>("email").value = "new@example.test";
      submit(element<HTMLFormElement>("email-form"));
      await vi.advanceTimersByTimeAsync(0);
      fake.last().callbacks.onInteractive?.(true);
      expect(element("human-check-copy").hidden).toBe(false);
      expect(element("status").textContent).toBe(messages.humanCheckNeeded);
      // A visible challenge waits for the visitor, however long they take.
      await vi.advanceTimersByTimeAsync(HUMAN_CHECK_WAIT_MS * 3);
      expect(paths()).not.toContain("/email-otp/send-verification-otp");
      expect(element<HTMLButtonElement>("send-code").getAttribute("aria-busy")).toBe("true");

      fake.last().callbacks.onInteractive?.(false);
      fake.last().callbacks.onToken("solved");
      await vi.advanceTimersByTimeAsync(0);
      expect(element("human-check-copy").hidden).toBe(true);
      expect(api.calls).toContainEqual({
        method: "POST",
        path: "/verify-human",
        body: { token: "solved" },
      });
      expect(element("code-form").hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on without a token when an invisible challenge takes too long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = fakeWidget();
      await openWith(fake.widget);
      element<HTMLInputElement>("email").value = "ada@example.test";
      submit(element<HTMLFormElement>("email-form"));
      await vi.advanceTimersByTimeAsync(HUMAN_CHECK_WAIT_MS - 1);
      expect(paths()).not.toContain("/email-otp/send-verification-otp");
      await vi.advanceTimersByTimeAsync(1);
      expect(paths()).not.toContain("/verify-human");
      expect(paths()).toContain("/email-otp/send-verification-otp");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed challenge for the sign-in, and goes on without it when it fails again", async () => {
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    const fake = fakeWidget();
    await openWith(fake.widget);
    fake.last().callbacks.onError?.();
    await requestCode("ada@example.test");
    // The failed challenge was replaced by a new one, which the sign-in waits for.
    expect(fake.rendered).toHaveLength(2);
    expect(fake.rendered[0]?.removed).toBe(true);
    expect(paths()).not.toContain("/email-otp/send-verification-otp");
    fake.last().callbacks.onError?.();
    await settle();
    expect(paths()).not.toContain("/verify-human");
    expect(element("code-form").hidden).toBe(false);
    await enterCode("123456");
    expect(location.assigned).toEqual(["/"]);
  });

  it("does not send a token that expired", async () => {
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    const fake = fakeWidget();
    await openWith(fake.widget);
    fake.last().callbacks.onToken("expired-token");
    fake.last().callbacks.onReset();
    document.querySelector<HTMLButtonElement>('button[data-provider="github"]')?.click();
    await settle();
    fake.last().callbacks.onToken("fresh-token");
    await settle();
    expect(api.calls.filter((call) => call.path === "/verify-human")).toEqual([
      { method: "POST", path: "/verify-human", body: { token: "fresh-token" } },
    ]);
  });

  it("still signs an existing account in when the check is refused", async () => {
    api.on("POST", "/verify-human", { status: 403, body: null });
    api.on("POST", "/sign-in/email-otp", { status: 200, body: { token: "t" } });
    const fake = fakeWidget();
    await openWith(fake.widget);
    fake.last().callbacks.onToken("refused");
    await requestCode("ada@example.test");
    await enterCode("123456");
    expect(location.assigned).toEqual(["/"]);
  });

  it("explains a refused sign-up, and sends no check when the page has no site key", async () => {
    api.on("POST", "/sign-in/email-otp", {
      status: 403,
      body: { code: HUMAN_VERIFICATION_REQUIRED, message: "x" },
    });
    await openWith(null);
    expect(element("human-check-copy").hidden).toBe(true);
    await requestCode("new@example.test");
    await enterCode("123456");
    expect(element("error-summary").textContent).toBe(
      messages.providerErrors[HUMAN_VERIFICATION_REQUIRED],
    );
    expect(paths()).not.toContain("/verify-human");
  });

  it("explains a provider sign-up refused for the check", async () => {
    await open(`?error=${HUMAN_VERIFICATION_REQUIRED}`);
    expect(element("error-summary").textContent).toContain("human");
  });
});

describe("confirming an artifact on its owner's own address", () => {
  const STATE = "n".repeat(43);
  const ENTRY = `/read/k7d2qm4xab?state=${STATE}&host=docs.example.com`;
  const search = `?${new URLSearchParams({ confirm: "read", next: ENTRY })}`;

  function confirmFetch(answer: Response | Error) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { calls, fetcher };
  }

  async function openConfirm(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
    api.on("GET", "/get-session", session("ada@example.test"));
    location = fakeLocation(search);
    await setupLogin(document, { ...pageEnv(api, location), fetch: fetcher });
  }

  it("names the host and goes there only after the click, with a same-origin POST", async () => {
    const callback = "https://docs.example.com/__portifact/callback?code=c";
    const { calls, fetcher } = confirmFetch(
      new Response(JSON.stringify({ url: callback }), { status: 200 }),
    );
    await openConfirm(fetcher);
    expect(element("read-confirm").isConnected).toBe(true);
    expect(element("signed-in").hidden).toBe(true);
    expect(element("read-confirm-body").textContent).toBe(
      messages.readConfirm.body("docs.example.com"),
    );
    expect(element("read-confirm-email").textContent).toBe(messages.signedInAs("ada@example.test"));
    // Nothing is sent and nothing opens until the visitor continues.
    expect(calls).toEqual([]);
    expect(location.assigned).toEqual([]);
    element<HTMLButtonElement>("read-confirm-continue").click();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/read/k7d2qm4xab");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      state: STATE,
      host: "docs.example.com",
    });
    expect(location.assigned).toEqual([callback]);
  });

  it("says so when the answer does not come, and stays put", async () => {
    for (const answer of [new Error("offline"), new Response("{}", { status: 403 })]) {
      loadPage("login");
      const { fetcher } = confirmFetch(answer);
      await openConfirm(fetcher);
      element<HTMLButtonElement>("read-confirm-continue").click();
      await settle();
      expect(element("error-summary").hidden).toBe(false);
      expect(element("error-summary").textContent).toContain(messages.unexpected);
      expect(location.assigned).toEqual([]);
    }
  });

  it("never shows a host or state from the link that is not shaped like one", async () => {
    // The page shows the host next to the visitor's email before the server has checked
    // anything, so text in its place would be a message from whoever built the link.
    const hosts = [
      "nowhere. URGENT: your account is locked, call +1 555 0100",
      "docs.example.com/evil",
      "docs.example.com evil.example.com",
      "DOCS.EXAMPLE.COM",
      "localhost",
      "-docs.example.com",
      "docs..example.com",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(127)}com`,
      "docs.example.com.",
      "<b>docs.example.com</b>",
      "",
    ];
    const entries = [
      ...hosts.map((host) => `/read/k7d2qm4xab?${new URLSearchParams({ state: STATE, host })}`),
      `/read/k7d2qm4xab?${new URLSearchParams({ state: "short", host: "docs.example.com" })}`,
      `/read/k7d2qm4xab?${new URLSearchParams({ state: `${STATE}!`, host: "docs.example.com" })}`,
    ];
    for (const next of entries) {
      loadPage("login");
      api.on("GET", "/get-session", session("ada@example.test"));
      await open(`?${new URLSearchParams({ confirm: "read", next })}`);
      expect(element("error-summary").textContent, next).toContain(messages.readConfirm.missing);
      expect(document.getElementById("read-confirm"), next).toBeNull();
      expect(document.body.textContent, next).not.toContain("URGENT");
    }
  });

  it("refuses an incomplete entry, and signs a visitor in before confirming", async () => {
    for (const next of ["/read/k7d2qm4xab?state=x", "/device", `${ENTRY}&host=other.example.com`]) {
      loadPage("login");
      api.on("GET", "/get-session", session("ada@example.test"));
      await open(`?${new URLSearchParams({ confirm: "read", next })}`);
      expect(element("error-summary").textContent).toContain(messages.readConfirm.missing);
      expect(document.getElementById("read-confirm")).toBeNull();
      expect(location.assigned).toEqual([]);
    }
    loadPage("login");
    api.on("GET", "/get-session", { status: 200, body: null });
    await open(search);
    expect(element("sign-in").hidden).toBe(false);
    expect(document.getElementById("read-confirm")).toBeNull();
  });
});

describe("single sign-on", () => {
  const ssoOn = () => api.on("POST", "/sso/lookup", { status: 200, body: { sso: true } });

  it("offers it for an address whose domain uses it, with the notice that names it", async () => {
    ssoOn();
    await open();
    await requestCode("ada@corp.example");
    expect(element("sso-step").hidden).toBe(false);
    expect(element("methods").hidden).toBe(true);
    expect(element("terms-notice").hidden).toBe(true);
    expect(element("terms-notice-sso").hidden).toBe(false);
    expect(element("terms-notice-sso").textContent).toContain("single sign-on");
    expect(element("terms-notice-sso").textContent).toContain("18");
    expect(element("sso-for").textContent).toBe(messages.ssoFor("ada@corp.example"));
    expect(document.activeElement?.id).toBe("sso-heading");
    for (const id of ["sso-continue", "sso-code"]) {
      expect(element(id).getAttribute("aria-describedby")).toBe("terms-notice-sso");
    }
    expect(api.calls.some((call) => call.path === "/email-otp/send-verification-otp")).toBe(false);
  });

  it("records the acceptance, then starts the sign-in and follows the provider's URL", async () => {
    ssoOn();
    api.on("POST", "/sign-in/sso", { status: 200, body: { url: "https://login.corp.example/a" } });
    await open("?next=%2Fmembers");
    await requestCode("ada@corp.example");
    element("sso-continue").click();
    await settle();
    expect(api.calls.filter((call) => call.method === "POST").slice(1)).toEqual([
      { method: "POST", path: "/accept-terms", body: ACCEPTANCE },
      {
        method: "POST",
        path: "/sign-in/sso",
        body: { email: "ada@corp.example", callbackURL: "/members", errorCallbackURL: "/login" },
      },
    ]);
    expect(location.assigned).toEqual(["https://login.corp.example/a"]);
  });

  it("does not start without the acceptance, and explains a refusal", async () => {
    ssoOn();
    api.on("POST", "/accept-terms", { status: 0, body: null });
    await open();
    await requestCode("ada@corp.example");
    element("sso-continue").click();
    await settle();
    expect(api.calls.some((call) => call.path === "/sign-in/sso")).toBe(false);
    expect(element("error-summary").textContent).toBe(messages.network);

    api.on("POST", "/accept-terms", { status: 200, body: { accepted: true } });
    api.on("POST", "/sign-in/sso", { status: 404, body: { code: "sso_unavailable" } });
    element("sso-continue").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.providerErrors.sso_unavailable);
    api.on("POST", "/sign-in/sso", { status: 500, body: null });
    element("sso-continue").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.unexpected);
    expect(location.assigned).toEqual([]);
  });

  it("sends an email code instead on request, back under the usual notice", async () => {
    ssoOn();
    await open();
    await requestCode("ada@corp.example");
    element("sso-code").click();
    await settle();
    expect(element("code-form").hidden).toBe(false);
    expect(element("sso-step").hidden).toBe(true);
    expect(element("terms-notice").hidden).toBe(false);
    expect(element("terms-notice-sso").hidden).toBe(true);
    expect(api.calls.some((call) => call.path === "/email-otp/send-verification-otp")).toBe(true);
  });

  it("keeps the step when the code could not be sent", async () => {
    ssoOn();
    api.on("POST", "/email-otp/send-verification-otp", { status: 429, body: null });
    await open();
    await requestCode("ada@corp.example");
    element("sso-code").click();
    await settle();
    expect(element("sso-step").hidden).toBe(false);
    expect(element("error-summary").textContent).toBe(messages.rateLimited);
  });

  it("goes back to every method to use another address", async () => {
    ssoOn();
    await open();
    await requestCode("ada@corp.example");
    element("sso-change-email").click();
    expect(element("sso-step").hidden).toBe(true);
    expect(element("methods").hidden).toBe(false);
    expect(element("terms-notice").hidden).toBe(false);
    expect(element("terms-notice-sso").hidden).toBe(true);
    expect(document.activeElement?.id).toBe("email");
  });

  it("sends a code as before when the lookup says no or is switched off", async () => {
    for (const answer of [
      { status: 200, body: { sso: false } },
      { status: 404, body: { error: { code: "not_found" } } },
      { status: 200, body: null },
    ]) {
      loadPage("login");
      api = fakeApi();
      api.on("GET", "/get-session", { status: 200, body: null });
      api.on("POST", "/accept-terms", { status: 200, body: { accepted: true } });
      api.on("POST", "/email-otp/send-verification-otp", { status: 200, body: { success: true } });
      api.on("POST", "/sso/lookup", answer);
      await open();
      await requestCode("ada@corp.example");
      expect(element("sso-step").hidden).toBe(true);
      expect(element("code-form").hidden).toBe(false);
    }
  });

  it("explains each way a single sign-on can come back", async () => {
    for (const code of [
      "sso_unavailable",
      "sso_email_outside_domain",
      "sso_failed",
      "sso_workspace_full",
    ]) {
      loadPage("login");
      await open(`?error=${code}`);
      expect(element("error-summary").textContent).toBe(messages.providerErrors[code]);
    }
  });
});
