// @vitest-environment happy-dom
// Every auth page and the report page, in each state a visitor can reach, checked with axe.
// happy-dom has no layout, so contrast is left to the token tests and the end-to-end suite.
import { TERMS_VERSION } from "@portifact/contracts/terms-version";
import { axeViolations } from "@portifact/ui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanCheckCallbacks, HumanCheckWidget } from "../human-check/turnstile.ts";
import { setupReport } from "../report/report.ts";
import { setupConsent } from "./consent.ts";
import { setupDevice } from "./device.ts";
import { en } from "./i18n/en.ts";
import { localizeAuthPage } from "./i18n/i18n.ts";
import { setupLogin } from "./login.ts";
import { messages } from "./messages.ts";
import {
  element,
  type FakeApi,
  fakeApi,
  fakeLocation,
  loadPage,
  ORIGIN,
  pageEnv,
  session,
  settle,
  submit,
} from "./test-page.ts";

let api: FakeApi;

async function expectAccessible() {
  expect(document.querySelector("main")).not.toBeNull();
  expect(await axeViolations(document.body)).toEqual([]);
}

function open(name: "login" | "device" | "consent" | "report") {
  document.documentElement.lang = "en";
  document.title = "Portifact";
  loadPage(name);
}

beforeEach(() => {
  api = fakeApi();
  api.on("GET", "/get-session", { status: 200, body: null });
  api.on("POST", "/accept-terms", { status: 200, body: { version: TERMS_VERSION } });
  api.on("POST", "/email-otp/send-verification-otp", { status: 200, body: { success: true } });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("login page accessibility", () => {
  it("has no violations when offering the sign-in methods", async () => {
    open("login");
    await setupLogin(document, pageEnv(api, fakeLocation()));
    await expectAccessible();
  });

  it("has no violations with an invalid email and a provider error", async () => {
    open("login");
    await setupLogin(document, pageEnv(api, fakeLocation("?error=state_mismatch")));
    element<HTMLInputElement>("email").value = "nope";
    submit(element<HTMLFormElement>("email-form"));
    await settle();
    await expectAccessible();
  });

  it("has no violations on the code step, with an error, and with the human check shown", async () => {
    let callbacks: HumanCheckCallbacks | undefined;
    const widget: HumanCheckWidget = {
      render(container, given) {
        callbacks = given;
        const frame = document.createElement("p");
        frame.textContent = "Challenge";
        container.append(frame);
        return () => frame.remove();
      },
    };
    open("login");
    await setupLogin(document, { ...pageEnv(api, fakeLocation()), humanCheck: widget });
    callbacks?.onToken("t");
    api.on("POST", "/verify-human", { status: 200, body: { verified: true } });
    element<HTMLInputElement>("email").value = "ada@example.test";
    submit(element<HTMLFormElement>("email-form"));
    await settle();
    element<HTMLInputElement>("code").value = "1";
    submit(element<HTMLFormElement>("code-form"));
    await settle();
    expect(element("code-form").hidden).toBe(false);
    await expectAccessible();

    callbacks?.onInteractive?.(true);
    expect(element("human-check-copy").hidden).toBe(false);
    await expectAccessible();
  });

  it("has no violations for a signed-in account and for the terms review", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("GET", "/list-accounts", { status: 200, body: [{ providerId: "github" }] });
    open("login");
    await setupLogin(document, pageEnv(api, fakeLocation()));
    expect(element("signed-in").hidden).toBe(false);
    await expectAccessible();

    api.on("GET", "/get-session", session("ada@example.test", null));
    open("login");
    await setupLogin(document, pageEnv(api, fakeLocation()));
    expect(element("terms-update").hidden).toBe(false);
    await expectAccessible();
  });
});

describe("localized pages accessibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(messages, en);
  });

  it("has no violations on the Spanish login page with its language switcher", async () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => undefined);
    open("login");
    const shown = await localizeAuthPage(document, {
      url: `${ORIGIN}/login?lang=es`,
      storage: () => null,
      languages: [],
    });
    expect(shown).toBe("es");
    expect(document.querySelector('[data-locale-link="es"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    await setupLogin(document, pageEnv(api, fakeLocation()));
    await expectAccessible();

    element<HTMLInputElement>("email").value = "nope";
    submit(element<HTMLFormElement>("email-form"));
    await settle();
    expect(element("email-error").textContent).toBe(messages.emailInvalid);
    expect(messages.emailInvalid).not.toBe(en.emailInvalid);
    await expectAccessible();
  });
});

describe("device page accessibility", () => {
  beforeEach(() => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("GET", "/device?user_code=ABCDEFGH", {
      status: 200,
      body: {
        user_code: "ABCDEFGH",
        status: "pending",
        client_id: "portifact-cli",
        scope: "artifacts:read offline_access",
        resource: `${ORIGIN}/api/v1`,
      },
    });
    api.on("GET", "/oauth2/public-client?client_id=portifact-cli", {
      status: 200,
      body: { client_id: "portifact-cli", client_name: "Portifact CLI" },
    });
    api.on("POST", "/device/approve", { status: 200, body: { success: true } });
  });

  it("has no violations when asking for the code, reviewing it and after approving", async () => {
    open("device");
    await setupDevice(document, pageEnv(api, fakeLocation()));
    await expectAccessible();

    submit(element<HTMLFormElement>("code-form"));
    await settle();
    await expectAccessible();

    element<HTMLInputElement>("user-code").value = "ABCDEFGH";
    submit(element<HTMLFormElement>("code-form"));
    await settle();
    expect(element("review").hidden).toBe(false);
    await expectAccessible();

    element("approve").click();
    await settle();
    expect(element("done").hidden).toBe(false);
    await expectAccessible();
  });
});

describe("consent page accessibility", () => {
  it("has no violations for a request and for a missing one", async () => {
    api.on("GET", "/get-session", session("ada@example.test"));
    api.on("GET", "/oauth2/public-client?client_id=dcr-client", {
      status: 200,
      body: { client_id: "dcr-client", client_name: "Example client" },
    });
    const values = {
      client_id: "dcr-client",
      redirect_uri: "http://127.0.0.1:53111/callback",
      scope: "artifacts:read offline_access",
      resource: `${ORIGIN}/mcp`,
      state: "s",
    };
    const params = new URLSearchParams({ ...values, sig: "s1" });
    for (const name of [...Object.keys(values), "ba_param"]) params.append("ba_param", name);
    open("consent");
    await setupConsent(document, pageEnv(api, fakeLocation(`?${params}`)));
    expect(element("request").hidden).toBe(false);
    await expectAccessible();

    open("consent");
    await setupConsent(document, pageEnv(api, fakeLocation("")));
    expect(element("error-summary").hidden).toBe(false);
    await expectAccessible();
  });
});

describe("report page accessibility", () => {
  it("has no violations empty, with errors and after sending", async () => {
    open("report");
    setupReport(document, {
      send: async () => ({ status: 202, body: { received: true } }),
      location: fakeLocation(),
    });
    await expectAccessible();

    submit(element<HTMLFormElement>("report-form"));
    await settle();
    await expectAccessible();

    element<HTMLInputElement>("artifact").value = "k7d2qm4xab";
    element<HTMLSelectElement>("reason").value = "spam";
    submit(element<HTMLFormElement>("report-form"));
    await settle();
    expect(element("done").hidden).toBe(false);
    await expectAccessible();
  });
});
