// @vitest-environment happy-dom
// The share link entry page (decision 0008): the token leaves the address bar before anything
// else, the page never shows or logs it, and it asks for a password and the human check only when
// the server says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "../auth/api.ts";
import { element, loadPage, settle, submit } from "../auth/test-page.ts";
import type { HumanCheckCallbacks, HumanCheckWidget } from "../human-check/turnstile.ts";
import { setupShare, shareSender, takeToken } from "./share.ts";

const TOKEN = "AbC_-1234567890abcdefghijklmnopqrstuvwxyzAB";
const TARGET = "https://k7d2qm4xab.portifact.dev/__portifact/link?code=xyz";

function sender(...answers: ApiResponse[]) {
  const bodies: unknown[] = [];
  const send = async (body: unknown) => {
    bodies.push(body);
    return answers.shift() ?? { status: 500, body: null };
  };
  return { send, bodies };
}

const opened: ApiResponse = { status: 200, body: { location: TARGET } };
const refuse = (code: string, status: number): ApiResponse => ({
  status,
  body: { error: { code, message: "x" } },
});

function widget() {
  let callbacks: HumanCheckCallbacks | undefined;
  const removed = vi.fn();
  const check: HumanCheckWidget = {
    render: (_container, given) => {
      callbacks = given;
      return removed;
    },
  };
  return { check, solve: (token: string) => callbacks?.onToken(token), removed };
}

beforeEach(() => loadPage("share"));
afterEach(() => vi.restoreAllMocks());

describe("takeToken", () => {
  it("takes a well-formed token and removes the fragment from the address bar", () => {
    const replaceState = vi.fn();
    expect(
      takeToken({ hash: `#${TOKEN}`, pathname: "/s", search: "?lang=es" }, { replaceState }),
    ).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/s?lang=es");
  });

  it("removes a malformed fragment too, and keeps nothing without one", () => {
    const replaceState = vi.fn();
    expect(takeToken({ hash: "#short", pathname: "/s", search: "" }, { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    replaceState.mockClear();
    expect(takeToken({ hash: "", pathname: "/s", search: "" }, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(
      takeToken(
        { hash: `#${TOKEN}`, pathname: "/s", search: "" },
        {
          replaceState: () => {
            throw new Error("refused");
          },
        },
      ),
    ).toBe(TOKEN);
  });
});

describe("the entry page", () => {
  it("opens a link without a password straight away, with only the token", async () => {
    const { send, bodies } = sender(opened);
    const navigate = vi.fn();
    setupShare(document, { token: TOKEN, send, navigate, humanCheck: null });
    await settle();
    expect(bodies).toEqual([{ token: TOKEN }]);
    expect(navigate).toHaveBeenCalledWith(TARGET);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("asks for the password, explains a refusal and opens with the right one", async () => {
    const { send, bodies } = sender(
      refuse("unauthenticated", 401),
      refuse("forbidden", 403),
      opened,
    );
    const navigate = vi.fn();
    setupShare(document, { token: TOKEN, send, navigate, humanCheck: null });
    await settle();
    const form = element<HTMLFormElement>("password-form");
    expect(form.hidden).toBe(false);
    const password = element<HTMLInputElement>("password");
    expect(document.activeElement).toBe(password);

    submit(form);
    await settle();
    expect(element("password-error").textContent).toBe("Enter the password.");
    expect(bodies).toHaveLength(1);

    password.value = "wrong horse";
    submit(form);
    await settle();
    expect(element("error-summary").textContent).toContain(
      "The password is wrong, or the link expired or was revoked.",
    );
    expect(password.getAttribute("aria-invalid")).toBe("true");

    password.value = "correct horse";
    submit(form);
    await settle();
    expect(bodies.at(-1)).toEqual({ token: TOKEN, password: "correct horse" });
    expect(navigate).toHaveBeenCalledWith(TARGET);
  });

  it("shows the human check when asked and retries the password with its token", async () => {
    const { send, bodies } = sender(
      refuse("unauthenticated", 401),
      refuse("human_verification_required", 403),
      opened,
    );
    const navigate = vi.fn();
    const human = widget();
    setupShare(document, { token: TOKEN, send, navigate, humanCheck: human.check });
    await settle();
    element<HTMLInputElement>("password").value = "correct horse";
    submit(element<HTMLFormElement>("password-form"));
    await settle();
    expect(element("human-check").hidden).toBe(false);
    expect(element("status").textContent).toContain("Confirm below that you are human");

    // happy-dom's requestSubmit dispatches the form's submit event.
    human.solve("turnstile-token");
    await settle();
    expect(bodies.at(-1)).toEqual({
      token: TOKEN,
      password: "correct horse",
      turnstileToken: "turnstile-token",
    });
    expect(navigate).toHaveBeenCalledWith(TARGET);
    expect(human.removed).toHaveBeenCalled();
  });

  it("says the human check is unavailable without a widget, and that the visitor is locked out", async () => {
    const { send } = sender(
      refuse("unauthenticated", 401),
      refuse("human_verification_required", 403),
      refuse("rate_limited", 429),
    );
    setupShare(document, { token: TOKEN, send, navigate: vi.fn(), humanCheck: null });
    await settle();
    element<HTMLInputElement>("password").value = "guess one";
    submit(element<HTMLFormElement>("password-form"));
    await settle();
    expect(element("error-summary").textContent).toContain("The human check could not load.");
    submit(element<HTMLFormElement>("password-form"));
    await settle();
    expect(element("error-summary").textContent).toContain("Too many attempts.");
  });

  it("shows one page for a link that does not work, and one for an incomplete link", async () => {
    const { send } = sender(refuse("not_found", 404));
    setupShare(document, { token: TOKEN, send, navigate: vi.fn(), humanCheck: null });
    await settle();
    expect(element("unavailable").hidden).toBe(false);
    expect(document.activeElement).toBe(element("unavailable-heading"));

    loadPage("share");
    const empty = sender();
    setupShare(document, { token: null, send: empty.send, navigate: vi.fn(), humanCheck: null });
    await settle();
    expect(element("incomplete").hidden).toBe(false);
    expect(empty.bodies).toEqual([]);
  });

  it("reports a network failure and an unexpected answer", async () => {
    const { send } = sender({ status: 0, body: null });
    setupShare(document, { token: TOKEN, send, navigate: vi.fn(), humanCheck: null });
    await settle();
    expect(element("error-summary").textContent).toContain("Portifact could not be reached.");
    loadPage("share");
    const other = sender({ status: 200, body: { location: "javascript:alert(1)" } });
    const navigate = vi.fn();
    setupShare(document, { token: TOKEN, send: other.send, navigate, humanCheck: null });
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    expect(element("error-summary").textContent).toContain("The link could not be opened.");
  });
});

describe("shareSender", () => {
  it("posts JSON without credentials or a referrer, and turns failures into status 0", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ location: TARGET }));
    const send = shareSender(fetchImpl as unknown as typeof fetch);
    expect(await send({ token: TOKEN })).toEqual({ status: 200, body: { location: TARGET } });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/share/open");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const failing = shareSender((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(await failing({})).toEqual({ status: 0, body: null });
    const text = shareSender(
      (async () => new Response("not json", { status: 502 })) as unknown as typeof fetch,
    );
    expect(await text({})).toEqual({ status: 502, body: null });
  });
});
