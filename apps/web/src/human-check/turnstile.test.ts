// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// The script never really loads: tests dispatch its load and error events themselves.
import { TURNSTILE_SCRIPT_URL } from "@portifact/contracts/human-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTurnstile, siteKeyOf, type TurnstileApi, turnstileWidget } from "./turnstile.ts";

function withSiteKey(value: string | null) {
  document.head.innerHTML =
    value === null ? "" : `<meta name="portifact-turnstile-site-key" content="${value}">`;
}

function fakeApi() {
  const options: Record<string, unknown>[] = [];
  const removed: string[] = [];
  const api: TurnstileApi = {
    render: (_container, given) => {
      options.push(given);
      return `w${options.length}`;
    },
    remove: (id) => removed.push(id),
  };
  return { api, options, removed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.head.innerHTML = "";
  delete (window as { turnstile?: unknown }).turnstile;
});

describe("human check widget", () => {
  it("reads the site key from the page, and has none without it", () => {
    withSiteKey(" 0x4AAA ");
    expect(siteKeyOf(document)).toBe("0x4AAA");
    withSiteKey("");
    expect(siteKeyOf(document)).toBeUndefined();
    withSiteKey(null);
    expect(siteKeyOf(document)).toBeUndefined();
    expect(turnstileWidget(document, "sign-up")).toBeNull();
  });

  it("renders the challenge with the site key and action and forwards its callbacks", async () => {
    withSiteKey("0x4AAA");
    const fake = fakeApi();
    const widget = turnstileWidget(document, "comment", async () => fake.api);
    const onToken = vi.fn();
    const onReset = vi.fn();
    const remove = widget?.render(document.body, { onToken, onReset });
    await settle();
    expect(fake.options[0]).toMatchObject({
      sitekey: "0x4AAA",
      action: "comment",
      theme: "auto",
      "response-field": false,
    });
    const given = fake.options[0] ?? {};
    (given.callback as (token: string) => void)("t1");
    (given["expired-callback"] as () => void)();
    (given["error-callback"] as () => void)();
    expect(onToken).toHaveBeenCalledWith("t1");
    expect(onReset).toHaveBeenCalledTimes(2);
    remove?.();
    expect(fake.removed).toEqual(["w1"]);
  });

  it("renders nothing when removed before the script loaded, and resets when it fails", async () => {
    withSiteKey("0x4AAA");
    const fake = fakeApi();
    const widget = turnstileWidget(document, "comment", async () => fake.api);
    widget?.render(document.body, { onToken: vi.fn(), onReset: vi.fn() })();
    await settle();
    expect(fake.options).toEqual([]);

    const onReset = vi.fn();
    turnstileWidget(document, "comment", () => Promise.reject(new Error("blocked")))?.render(
      document.body,
      { onToken: vi.fn(), onReset },
    );
    await settle();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("loads Turnstile's script once and resolves with its API", async () => {
    const win: { turnstile?: TurnstileApi } = {};
    const first = loadTurnstile(document, win);
    const second = loadTurnstile(document, win);
    const scripts = document.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).async).toBe(true);
    win.turnstile = fakeApi().api;
    scripts[0]?.dispatchEvent(new Event("load"));
    expect(await first).toBe(win.turnstile);
    expect(await second).toBe(win.turnstile);
    expect(await loadTurnstile(document, win)).toBe(win.turnstile);
  });

  it("fails when the script is blocked or loads without the API", async () => {
    const failed = loadTurnstile(document, {});
    document.querySelector("script")?.dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow("did not load");
    document.head.innerHTML = "";
    const empty = loadTurnstile(document, {});
    document.querySelector("script")?.dispatchEvent(new Event("load"));
    await expect(empty).rejects.toThrow("did not load");
  });
});
