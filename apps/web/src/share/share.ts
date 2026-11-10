// The entry of share links (app.portifact.com/s#<token>, decision 0008). The token is in the
// fragment, so no server, log or link preview ever sees it in a URL. Before anything else the page
// takes it and removes it from the address bar and the session history entry; then it asks
// `POST /api/v1/share/open` and sends the visitor to the artifact origin with the one-use code it
// gets back. A password form and the human check appear only when the answer asks for them.
import type { ApiResponse } from "../auth/api.ts";
import { byId, hideSummary, setFieldError, showSummary, whileBusy } from "../auth/dom.ts";
import { messages } from "../auth/messages.ts";
import type { HumanCheckWidget } from "../human-check/turnstile.ts";

/** The shape of a token: 32 random bytes in unpadded base64url (`OpaqueToken`). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface FragmentLocation {
  hash: string;
  pathname: string;
  search: string;
}

/**
 * Takes the token from the fragment and removes the fragment from the address bar, so it is not
 * left in the session history or on screen. Returns null without a well-formed token.
 */
export function takeToken(
  location: FragmentLocation,
  history: Pick<History, "replaceState">,
): string | null {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (raw !== "") {
    try {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch {
      // A browser that refuses still opens the link; the fragment just stays visible.
    }
  }
  return TOKEN.test(raw) ? raw : null;
}

export interface ShareEnv {
  token: string | null;
  /** Posts JSON to `/api/v1/share/open` on this origin; a network failure answers status 0. */
  send(body: unknown): Promise<ApiResponse>;
  /** Replaces this page with the artifact, so it does not stay in history. */
  navigate(url: string): void;
  humanCheck: HumanCheckWidget | null;
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : undefined;
}

function locationOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { location?: unknown }).location;
  return typeof value === "string" && value.startsWith("https://") ? value : undefined;
}

export function setupShare(doc: Document, env: ShareEnv): void {
  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const form = byId<HTMLFormElement>(doc, "password-form");
  const password = byId<HTMLInputElement>(doc, "password");
  const passwordError = byId(doc, "password-error");
  const button = byId<HTMLButtonElement>(doc, "open");
  const human = byId(doc, "human-check");
  const widgetBox = byId(doc, "human-check-widget");
  let removeWidget: (() => void) | undefined;
  let humanToken: string | undefined;

  const show = (id: "unavailable" | "incomplete") => {
    form.hidden = true;
    status.textContent = "";
    const section = byId(doc, id);
    section.hidden = false;
    byId(doc, `${id}-heading`).focus();
  };

  const stopHumanCheck = () => {
    removeWidget?.();
    removeWidget = undefined;
    humanToken = undefined;
    human.hidden = true;
  };

  /** Shows the challenge; a solved one retries the password at once. */
  const startHumanCheck = () => {
    if (!env.humanCheck) {
      showSummary(summary, messages.share.humanCheckUnavailable);
      return;
    }
    stopHumanCheck();
    human.hidden = false;
    status.textContent = messages.share.humanCheckShown;
    removeWidget = env.humanCheck.render(widgetBox, {
      onToken: (token) => {
        humanToken = token;
        form.requestSubmit();
      },
      onReset: () => {
        humanToken = undefined;
      },
      onError: () => showSummary(summary, messages.share.humanCheckUnavailable),
    });
  };

  /** One attempt; true when the visitor is on the way to the artifact. */
  const attempt = async (secret?: string): Promise<void> => {
    if (env.token === null) return;
    const turnstileToken = humanToken;
    humanToken = undefined;
    const response = await env.send({
      token: env.token,
      ...(secret === undefined ? {} : { password: secret }),
      ...(turnstileToken === undefined ? {} : { turnstileToken }),
    });
    const target = response.status === 200 ? locationOf(response.body) : undefined;
    if (target) {
      stopHumanCheck();
      status.textContent = messages.share.opening;
      env.navigate(target);
      return;
    }
    const code = errorCode(response.body);
    if (response.status === 0) return showSummary(summary, messages.share.network);
    if (code === "unauthenticated") {
      status.textContent = "";
      form.hidden = false;
      password.focus();
      return;
    }
    if (code === "not_found") return show("unavailable");
    if (code === "forbidden" && secret !== undefined) {
      setFieldError(password, passwordError, messages.share.refused);
      showSummary(summary, messages.share.refused);
      return;
    }
    if (code === "human_verification_required") return startHumanCheck();
    if (code === "rate_limited") return showSummary(summary, messages.share.rateLimited);
    showSummary(summary, messages.share.failed);
  };

  if (env.token === null) {
    show("incomplete");
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    hideSummary(summary);
    setFieldError(password, passwordError, undefined);
    if (password.value === "") {
      setFieldError(password, passwordError, messages.share.passwordRequired);
      showSummary(summary, messages.share.passwordRequired);
      return;
    }
    void whileBusy(button, () => attempt(password.value));
  });

  status.textContent = messages.share.checking;
  void attempt();
}

/** Posts JSON to the open endpoint on this origin; a network failure answers status 0. */
export function shareSender(fetchImpl: typeof fetch): (body: unknown) => Promise<ApiResponse> {
  return async (body) => {
    try {
      const response = await fetchImpl("/api/v1/share/open", {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    } catch {
      return { status: 0, body: null };
    }
  };
}
