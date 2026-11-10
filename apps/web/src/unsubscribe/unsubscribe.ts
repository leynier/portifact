// The unsubscribe page of comment notices (app.portifact.com/unsubscribe?token=...), linked from
// every comment notice email. Opening it changes nothing: link scanners that prefetch the email's
// links must not unsubscribe anyone, so the page waits for a click and then posts the signed token
// to `/api/v1/notices/unsubscribe` on this origin. No session is needed.
import type { ApiResponse, PageLocation } from "../auth/api.ts";
import { byId, showSummary, whileBusy } from "../auth/dom.ts";
import { messages } from "../auth/messages.ts";

export interface UnsubscribeEnv {
  /** Posts the token as JSON to the unsubscribe endpoint on this origin. */
  send(token: string): Promise<ApiResponse>;
  location: PageLocation;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{10,400}$/;

export function setupUnsubscribe(doc: Document, env: UnsubscribeEnv): void {
  const form = byId<HTMLFormElement>(doc, "unsubscribe-form");
  const summary = byId(doc, "error-summary");
  const status = byId(doc, "status");
  const button = byId<HTMLButtonElement>(doc, "confirm");
  const token = new URLSearchParams(env.location.search).get("token") ?? "";

  if (!TOKEN_PATTERN.test(token)) {
    form.hidden = true;
    showSummary(summary, messages.unsubscribe.missing);
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void whileBusy(button, async () => {
      const response = await env.send(token);
      if (response.status === 200) {
        form.hidden = true;
        byId(doc, "done").hidden = false;
        status.textContent = messages.unsubscribe.done;
        byId(doc, "done-heading").focus();
        return;
      }
      if (response.status === 0) return showSummary(summary, messages.unsubscribe.network);
      if (response.status === 429) return showSummary(summary, messages.unsubscribe.rateLimited);
      if (response.status === 400) {
        form.hidden = true;
        return showSummary(summary, messages.unsubscribe.invalid);
      }
      showSummary(summary, messages.unsubscribe.failed);
    });
  });
}

/** Posts the token to the unsubscribe endpoint on this origin; a network failure answers status 0. */
export function unsubscribeSender(
  fetchImpl: typeof fetch,
): (token: string) => Promise<ApiResponse> {
  return async (token) => {
    try {
      const response = await fetchImpl("/api/v1/notices/unsubscribe", {
        method: "POST",
        credentials: "omit",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      let body: unknown = null;
      try {
        body = JSON.parse(await response.text());
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };
}
