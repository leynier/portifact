// @vitest-environment happy-dom
import { TERMS_NOT_ACCEPTED, TERMS_VERSION } from "@portifact/contracts/terms-version";
import { beforeEach, describe, expect, it } from "vitest";
import { setupLogin } from "./login.ts";
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

/** Opens the page; the user checks the terms box unless `acceptTerms` is false. */
async function open(search = "", acceptTerms = true) {
  location = fakeLocation(search);
  await setupLogin(document, pageEnv(api, location));
  element<HTMLInputElement>("terms-accept").checked = acceptTerms;
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
    expect(providers.map((button) => button.textContent)).toEqual([
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
    expect(element("email-form").hidden).toBe(true);
    expect(element("code-form").hidden).toBe(false);
    expect(element("code-sent").textContent).toBe(messages.codeSent("ada@example.test"));
    expect(document.activeElement).toBe(element("code"));

    await enterCode("123 456");
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/sign-in/email-otp",
      body: { email: "ada@example.test", otp: "123456" },
    });
    expect(location.assigned).toEqual(["/"]);
    expect(element("status").textContent).toBe(messages.redirecting);
  });

  it("links an invalid email error to the field and moves focus to the summary", async () => {
    await open();
    await requestCode("not-an-email");
    const input = element<HTMLInputElement>("email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
    expect(element("email-error").textContent).toBe(messages.emailInvalid);
    expect(element("email-error").hidden).toBe(false);
    expect(element("error-summary").textContent).toBe(messages.emailInvalid);
    expect(document.activeElement).toBe(element("error-summary"));
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
    expect(element<HTMLInputElement>("code").getAttribute("aria-describedby")).toBe("code-error");
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

  it("sends a new code and lets the user change the address", async () => {
    await open();
    await requestCode("ada@example.test");
    element("resend-code").click();
    await settle();
    expect(element("status").textContent).toBe(messages.codeResent);
    expect(
      api.calls.filter((call) => call.path === "/email-otp/send-verification-otp"),
    ).toHaveLength(2);

    api.on("POST", "/email-otp/send-verification-otp", { status: 429, body: null });
    element("resend-code").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.rateLimited);

    element("change-email").click();
    expect(element("code-form").hidden).toBe(true);
    expect(element("email-form").hidden).toBe(false);
    expect(document.activeElement).toBe(element("email"));
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
    element("sign-out").click();
    await settle();
    expect(element("signed-in").hidden).toBe(true);
    expect(element("sign-in").hidden).toBe(false);
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

  it("links every legal page from the box's label", async () => {
    await open();
    const label = document.querySelector('label[for="terms-accept"]');
    expect(label?.textContent).toContain("I am 18 or older");
    const links = [...(label?.querySelectorAll("a") ?? [])].map((link) => link.href);
    expect(links).toEqual([
      "https://portifact.com/terms",
      "https://portifact.com/acceptable-use",
      "https://portifact.com/privacy",
    ]);
  });

  it("does not start any method until the box is checked", async () => {
    await open("", false);
    for (const start of [
      () => requestCode("ada@example.test"),
      async () => {
        providerButton("google")?.click();
        await settle();
      },
      async () => {
        providerButton("github")?.click();
        await settle();
      },
    ]) {
      await start();
      expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
      const box = element<HTMLInputElement>("terms-accept");
      expect(box.getAttribute("aria-invalid")).toBe("true");
      expect(box.getAttribute("aria-describedby")).toBe("terms-accept-error");
      expect(element("terms-accept-error").textContent).toBe(messages.termsRequired);
      expect(element("error-summary").textContent).toBe(messages.termsRequired);
      expect(document.activeElement).toBe(element("error-summary"));
    }
    expect(element("code-form").hidden).toBe(true);

    element<HTMLInputElement>("terms-accept").checked = true;
    await requestCode("ada@example.test");
    expect(element<HTMLInputElement>("terms-accept").hasAttribute("aria-invalid")).toBe(false);
    expect(element("terms-accept-error").hidden).toBe(true);
  });

  it("records the acceptance before sending a code and before a provider sign-in", async () => {
    api.on("POST", "/sign-in/social", { status: 200, body: { url: "https://github.com/x" } });
    await open();
    await requestCode("ada@example.test");
    providerButton("github")?.click();
    await settle();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([
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
      api.calls.filter((call) => call.path !== "/accept-terms" && call.method === "POST"),
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

  it("needs the box checked, then records the acceptance and continues", async () => {
    await open("?next=%2Fdevice");
    element("terms-update-continue").click();
    await settle();
    expect(api.calls.some((call) => call.path === "/accept-terms")).toBe(false);
    expect(element("terms-update-accept-error").textContent).toBe(messages.termsRequired);
    expect(element("error-summary").textContent).toBe(messages.termsRequired);

    element<HTMLInputElement>("terms-update-accept").checked = true;
    element("terms-update-continue").click();
    await settle();
    expect(api.calls.at(-1)).toEqual({ method: "POST", path: "/accept-terms", body: ACCEPTANCE });
    expect(location.assigned).toEqual(["/device"]);
    expect(element("status").textContent).toBe(messages.redirecting);
  });

  it("opens the dashboard after accepting when nothing else was asked", async () => {
    await open();
    element<HTMLInputElement>("terms-update-accept").checked = true;
    element("terms-update-continue").click();
    await settle();
    expect(location.assigned).toEqual(["/"]);
  });

  it("reports an acceptance that could not be recorded", async () => {
    api.on("POST", "/accept-terms", { status: 500, body: null });
    await open();
    element<HTMLInputElement>("terms-update-accept").checked = true;
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
