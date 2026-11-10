// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiResponse } from "../auth/api.ts";
import { messages } from "../auth/messages.ts";
import { element, fakeLocation, loadPage, settle, submit } from "../auth/test-page.ts";
import { setupUnsubscribe, unsubscribeSender } from "./unsubscribe.ts";

const TOKEN = "cn1.dXNlcg.1794200000000.c2lnbmF0dXJl";
let sent: string[];
let answer: ApiResponse;

function open(search = `?token=${TOKEN}`) {
  loadPage("unsubscribe");
  sent = [];
  setupUnsubscribe(document, {
    send: async (token) => {
      sent.push(token);
      return answer;
    },
    location: fakeLocation(search),
  });
}

async function confirm() {
  submit(element<HTMLFormElement>("unsubscribe-form"));
  await settle();
}

const summary = () => element("error-summary").querySelector("[data-message]")?.textContent;

beforeEach(() => {
  answer = { status: 200, body: { unsubscribed: true } };
});

describe("unsubscribe page", () => {
  it("changes nothing until the click, then posts the token and confirms", async () => {
    open();
    expect(sent).toEqual([]);
    await confirm();
    expect(sent).toEqual([TOKEN]);
    expect(element("unsubscribe-form").hidden).toBe(true);
    expect(element("done").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("done-heading");
    expect(element("status").textContent).toBe(messages.unsubscribe.done);
  });

  it("says the link is incomplete without a usable token, and offers no button", () => {
    for (const search of ["", "?token=", "?token=<script>alert(1)</script>", "?token=short"]) {
      open(search);
      expect(element("unsubscribe-form").hidden).toBe(true);
      expect(summary()).toBe(messages.unsubscribe.missing);
    }
  });

  it("explains a link that does not work any more", async () => {
    answer = { status: 400, body: { error: { code: "invalid_input", message: "x" } } };
    open();
    await confirm();
    expect(summary()).toBe(messages.unsubscribe.invalid);
    expect(element("unsubscribe-form").hidden).toBe(true);
  });

  it("keeps the button for a retry after a limit, a network error or a failure", async () => {
    for (const [status, message] of [
      [429, messages.unsubscribe.rateLimited],
      [0, messages.unsubscribe.network],
      [503, messages.unsubscribe.failed],
    ] as const) {
      answer = { status, body: null };
      open();
      await confirm();
      expect(summary()).toBe(message);
      expect(element("unsubscribe-form").hidden).toBe(false);
    }
  });
});

describe("unsubscribeSender", () => {
  it("posts the token as JSON without credentials to the endpoint on this origin", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const send = unsubscribeSender(async (input, init) => {
      calls.push([String(input), init]);
      return new Response(JSON.stringify({ unsubscribed: true }), { status: 200 });
    });
    expect(await send(TOKEN)).toEqual({ status: 200, body: { unsubscribed: true } });
    expect(calls[0]?.[0]).toBe("/api/v1/notices/unsubscribe");
    expect(calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "omit" });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ token: TOKEN });
  });

  it("answers status 0 on a network error and a null body for anything but JSON", async () => {
    expect(
      await unsubscribeSender(async () => Promise.reject(new Error("offline")))(TOKEN),
    ).toEqual({
      status: 0,
      body: null,
    });
    expect(
      await unsubscribeSender(async () => new Response("<html>", { status: 502 }))(TOKEN),
    ).toEqual({ status: 502, body: null });
  });
});
