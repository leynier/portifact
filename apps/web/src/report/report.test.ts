// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiResponse } from "../auth/api.ts";
import { element, fakeLocation, loadPage, settle, submit } from "../auth/test-page.ts";
import { reportMessages, reportSender, setupReport } from "./report.ts";

let sent: unknown[];
let answer: ApiResponse;

function open(search = "") {
  loadPage("report");
  sent = [];
  setupReport(document, {
    send: async (body) => {
      sent.push(body);
      return answer;
    },
    location: fakeLocation(search),
  });
}

function fill(values: { artifact?: string; reason?: string; details?: string; email?: string }) {
  if (values.artifact !== undefined) element<HTMLInputElement>("artifact").value = values.artifact;
  if (values.reason !== undefined) element<HTMLSelectElement>("reason").value = values.reason;
  if (values.details !== undefined) element<HTMLTextAreaElement>("details").value = values.details;
  if (values.email !== undefined) element<HTMLInputElement>("email").value = values.email;
}

async function send() {
  submit(element<HTMLFormElement>("report-form"));
  await settle();
}

beforeEach(() => {
  answer = { status: 202, body: { received: true } };
});

describe("report page", () => {
  it("fills the artifact from the link and sends the report", async () => {
    open("?artifact=k7d2qm4xab");
    expect(element<HTMLInputElement>("artifact").value).toBe("k7d2qm4xab");
    fill({ reason: "phishing", details: "  Fake bank login  ", email: "me@example.test" });
    await send();
    expect(sent).toEqual([
      {
        artifact: "k7d2qm4xab",
        reason: "phishing",
        details: "Fake bank login",
        email: "me@example.test",
      },
    ]);
    expect(element("report-form").hidden).toBe(true);
    expect(element("done").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("done-heading");
    expect(element("status").textContent).toBe(reportMessages.sent);
  });

  it("ignores an artifact parameter that is not an ID and leaves optional fields out", async () => {
    open("?artifact=<script>");
    expect(element<HTMLInputElement>("artifact").value).toBe("");
    fill({ artifact: "https://k7d2qm4xab.portifact.dev/", reason: "spam" });
    await send();
    expect(sent).toEqual([{ artifact: "https://k7d2qm4xab.portifact.dev/", reason: "spam" }]);
  });

  it("checks required fields and the email before sending", async () => {
    open();
    await send();
    expect(sent).toEqual([]);
    expect(element("artifact-error").textContent).toBe(reportMessages.artifactRequired);
    expect(element("artifact").getAttribute("aria-invalid")).toBe("true");
    expect(element("error-summary").hidden).toBe(false);

    fill({ artifact: "k7d2qm4xab" });
    await send();
    expect(element("reason-error").textContent).toBe(reportMessages.reasonRequired);
    expect(element("artifact").getAttribute("aria-invalid")).toBeNull();

    fill({ reason: "spam", email: "nope" });
    await send();
    expect(element("email-error").textContent).toBe(reportMessages.emailInvalid);
    expect(sent).toEqual([]);
  });

  it("maps the server's validation errors to their fields", async () => {
    for (const [field, message, target] of [
      ["artifact", reportMessages.artifactInvalid, "artifact"],
      ["details", reportMessages.detailsInvalid, "details"],
      ["email", reportMessages.emailInvalid, "email"],
      ["reason", reportMessages.reasonRequired, "reason"],
    ] as const) {
      open();
      answer = {
        status: 400,
        body: { error: { code: "invalid_input", message: `${field}: bad` } },
      };
      fill({ artifact: "k7d2qm4xab", reason: "spam" });
      await send();
      expect(element(`${target}-error`).textContent).toBe(message);
    }
    open();
    answer = { status: 400, body: null };
    fill({ artifact: "k7d2qm4xab", reason: "spam" });
    await send();
    expect(element("artifact-error").textContent).toBe(reportMessages.artifactInvalid);
  });

  it("explains rate limits, network failures and other errors", async () => {
    for (const [status, message] of [
      [429, reportMessages.rateLimited],
      [0, reportMessages.network],
      [500, reportMessages.failed],
    ] as const) {
      open();
      answer = { status, body: null };
      fill({ artifact: "k7d2qm4xab", reason: "spam" });
      await send();
      expect(element("error-summary").textContent).toBe(message);
      expect(element("report-form").hidden).toBe(false);
      expect(element<HTMLButtonElement>("send").disabled).toBe(false);
    }
  });
});

describe("report sender", () => {
  it("posts JSON without credentials and reads the answer", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const send = reportSender(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('{"received":true}', { status: 202 });
    });
    expect(await send({ artifact: "k7d2qm4xab" })).toEqual({
      status: 202,
      body: { received: true },
    });
    expect(requests[0]?.url).toBe("/api/v1/reports");
    expect(requests[0]?.init).toMatchObject({ method: "POST", credentials: "omit" });
  });

  it("answers status 0 when the network fails and null for a body that is not JSON", async () => {
    expect(await reportSender(async () => Promise.reject(new Error("offline")))({})).toEqual({
      status: 0,
      body: null,
    });
    expect(await reportSender(async () => new Response("oops", { status: 502 }))({})).toEqual({
      status: 502,
      body: null,
    });
  });
});
