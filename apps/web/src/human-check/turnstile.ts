// The human check widget (Cloudflare Turnstile) for the login page and the review viewer. The
// app host gives each page its public site key in a <meta>; without one no challenge is shown,
// and the server refuses what needs a check. Tokens are handed to the caller, which sends them
// with the request; they are single use and never stored or logged.
import { TURNSTILE_SCRIPT_URL, TURNSTILE_SITE_KEY_META } from "@portifact/contracts/human-check";

export interface HumanCheckCallbacks {
  /** A solved challenge: send this token with the next request that needs a check. */
  onToken(token: string): void;
  /** The token expired before it was used, or the challenge failed to run. */
  onReset(): void;
}

export interface HumanCheckWidget {
  /** Renders a challenge into `container` and returns a function that removes it. */
  render(container: HTMLElement, callbacks: HumanCheckCallbacks): () => void;
}

/** The part of Turnstile's script API the widget uses. */
export interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | null | undefined;
  remove(widgetId: string): void;
}

interface TurnstileWindow {
  turnstile?: TurnstileApi;
}

/** The site key the app host put in the page, if any. */
export function siteKeyOf(doc: Document): string | undefined {
  const value = doc
    .querySelector(`meta[name="${TURNSTILE_SITE_KEY_META}"]`)
    ?.getAttribute("content")
    ?.trim();
  return value ? value : undefined;
}

/** Loads Turnstile's script once per page; resolves with its API. */
export function loadTurnstile(doc: Document, win: TurnstileWindow): Promise<TurnstileApi> {
  const existing = win.turnstile;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let script = doc.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    if (!script) {
      script = doc.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      doc.head.append(script);
    }
    script.addEventListener("load", () => {
      if (win.turnstile) resolve(win.turnstile);
      else reject(new Error("Turnstile did not load"));
    });
    script.addEventListener("error", () => reject(new Error("Turnstile did not load")));
  });
}

/**
 * A Turnstile widget for `action`, or null when the page has no site key. `load` defaults to
 * the real script; tests pass a fake API.
 */
export function turnstileWidget(
  doc: Document,
  action: string,
  load: () => Promise<TurnstileApi> = () => loadTurnstile(doc, window as TurnstileWindow),
): HumanCheckWidget | null {
  const sitekey = siteKeyOf(doc);
  if (!sitekey) return null;
  return {
    render(container, callbacks) {
      let removed = false;
      let widgetId: string | null | undefined;
      let api: TurnstileApi | undefined;
      load().then(
        (loaded) => {
          if (removed) return;
          api = loaded;
          widgetId = loaded.render(container, {
            sitekey,
            action,
            theme: "auto",
            "response-field": false,
            callback: (token: string) => callbacks.onToken(token),
            "expired-callback": () => callbacks.onReset(),
            "error-callback": () => callbacks.onReset(),
          });
        },
        () => callbacks.onReset(),
      );
      return () => {
        removed = true;
        if (api && widgetId) api.remove(widgetId);
      };
    },
  };
}
