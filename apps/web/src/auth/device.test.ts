// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { setupDevice } from "./device.ts";
import { messages } from "./messages.ts";
import {
  element,
  type FakeApi,
  type FakeLocation,
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
let location: FakeLocation;

const PENDING = {
  status: 200,
  body: {
    user_code: "ABCDEFGH",
    status: "pending",
    client_id: "portifact-cli",
    scope: "artifacts:read offline_access",
    resource: `${ORIGIN}/api/v1`,
  },
};

async function open(search = "") {
  location = fakeLocation(search);
  await setupDevice(document, pageEnv(api, location));
}

async function enter(code: string) {
  element<HTMLInputElement>("user-code").value = code;
  submit(element<HTMLFormElement>("code-form"));
  await settle();
}

beforeEach(() => {
  loadPage("device");
  api = fakeApi();
  api.on("GET", "/get-session", session("ada@example.test"));
  api.on("GET", "/device?user_code=ABCDEFGH", PENDING);
  api.on("GET", "/oauth2/public-client?client_id=portifact-cli", {
    status: 200,
    body: { client_id: "portifact-cli", client_name: "Portifact CLI" },
  });
  api.on("POST", "/device/approve", { status: 200, body: { success: true } });
  api.on("POST", "/device/deny", { status: 200, body: { success: true } });
});

describe("device page", () => {
  it("sends a visitor without a session to the login page and back with the code", async () => {
    api.on("GET", "/get-session", { status: 200, body: null });
    await open("?user_code=ABCDEFGH");
    expect(location.assigned).toEqual(["/login?next=%2Fdevice%3Fuser_code%3DABCDEFGH"]);
    await open();
    expect(location.assigned).toEqual(["/login?next=%2Fdevice"]);
  });

  it("shows what the CLI asks for when the link carries the code, then approves", async () => {
    await open("?user_code=ABCDEFGH");
    expect(element("code-form").hidden).toBe(true);
    expect(element("review").hidden).toBe(false);
    expect(document.activeElement).toBe(element("review-heading"));
    expect(element("client-name").textContent).toBe("Portifact CLI");
    expect(element("review-code").textContent).toBe("ABCDEFGH");
    expect(element("resource").textContent).toBe("Portifact API");
    expect([...element("scopes").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "See your artifacts, their settings and their versions",
      "Stay connected until you revoke access",
    ]);
    expect(element("signed-in-email").textContent).toBe(messages.signedInAs("ada@example.test"));

    element("approve").click();
    await settle();
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/device/approve",
      body: { userCode: "ABCDEFGH" },
    });
    expect(element("review").hidden).toBe(true);
    expect(element("done").hidden).toBe(false);
    expect(element("done-message").textContent).toBe(messages.deviceApproved);
    expect(element("status").textContent).toBe(messages.deviceApproved);
  });

  it("lets the user type the code and deny the request", async () => {
    await open();
    expect(element("code-form").hidden).toBe(false);
    await enter(" ABCDEFGH ");
    element("deny").click();
    await settle();
    expect(api.calls.at(-1)).toEqual({
      method: "POST",
      path: "/device/deny",
      body: { userCode: "ABCDEFGH" },
    });
    expect(element("done-message").textContent).toBe(messages.deviceDenied);
  });

  it("asks for a code when the field is empty", async () => {
    await open();
    await enter("");
    expect(element("user-code-error").textContent).toBe(messages.deviceCodeRequired);
    expect(element<HTMLInputElement>("user-code").getAttribute("aria-describedby")).toBe(
      "user-code-error",
    );
  });

  it("explains an unknown or expired code", async () => {
    await open();
    await enter("WRONGONE");
    expect(element("user-code-error").textContent).toBe(messages.deviceCodeInvalid);
    expect(element("review").hidden).toBe(true);
  });

  it("explains a code someone else is reviewing, without showing its details", async () => {
    api.on("GET", "/device?user_code=TAKEN123", {
      status: 200,
      body: { user_code: "TAKEN123", status: "pending" },
    });
    await open();
    await enter("TAKEN123");
    expect(element("user-code-error").textContent).toBe(messages.deviceCodeTaken);
    expect(element("review").hidden).toBe(true);
  });

  it("explains a code that was already used", async () => {
    api.on("GET", "/device?user_code=USED1234", {
      status: 200,
      body: { user_code: "USED1234", status: "approved", client_id: "portifact-cli" },
    });
    await open();
    await enter("USED1234");
    expect(element("user-code-error").textContent).toBe(messages.deviceProcessed);
  });

  it("explains when Portifact cannot be reached", async () => {
    api.on("GET", "/device?user_code=ABCDEFGH", { status: 0, body: null });
    await open();
    await enter("ABCDEFGH");
    expect(element("error-summary").textContent).toBe(messages.network);
  });

  it("falls back to the client ID and lists every resource", async () => {
    api.on("GET", "/oauth2/public-client?client_id=portifact-cli", { status: 404, body: null });
    api.on("GET", "/device?user_code=ABCDEFGH", {
      status: 200,
      body: { ...PENDING.body, resource: [`${ORIGIN}/api/v1`, 7] },
    });
    await open("?user_code=ABCDEFGH");
    expect(element("client-name").textContent).toBe("portifact-cli");
    expect(element("resource").textContent).toBe("Portifact API");
  });

  it("shows no resource when the request has none", async () => {
    api.on("GET", "/device?user_code=ABCDEFGH", {
      status: 200,
      body: { status: "pending", client_id: "portifact-cli" },
    });
    await open("?user_code=ABCDEFGH");
    expect(element("resource").textContent).toBe("");
    expect(element("review-code").textContent).toBe("ABCDEFGH");
  });

  it("keeps the review open when the decision fails", async () => {
    api.on("POST", "/device/approve", { status: 400, body: null });
    await open("?user_code=ABCDEFGH");
    element("approve").click();
    await settle();
    expect(element("review").hidden).toBe(false);
    expect(element("error-summary").textContent).toBe(messages.deviceProcessed);

    api.on("POST", "/device/approve", { status: 0, body: null });
    element("approve").click();
    await settle();
    expect(element("error-summary").textContent).toBe(messages.network);
  });
});
