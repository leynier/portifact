// The human check of new accounts on the login page (docs/security.md, "Human check"). The
// Turnstile widget runs invisibly ("interaction-only") as soon as the page opens, so most visitors
// never see it and already hold a token when they choose a method. Only when Cloudflare needs an
// interaction does the challenge appear, below the sign-in methods, with copy that says why.
// Existing accounts do not need the check, so a missing token never blocks a sign-in here: the
// Worker refuses only a new account without one, and the page explains that refusal.
import type { HumanCheckWidget } from "../human-check/turnstile.ts";

/** How long a sign-in waits for an invisible challenge still running before going on without it. */
export const HUMAN_CHECK_WAIT_MS = 8_000;

export interface HumanGateView {
  /** Where the widget renders; it must stay displayed for the invisible challenge to run. */
  container: HTMLElement;
  /** Shows or hides the explanation next to a visible challenge. */
  setInteractive(visible: boolean): void;
}

export interface HumanGate {
  /** Starts the invisible challenge, once, when the sign-in methods are shown. */
  prepare(): void;
  /**
   * The token for the sign-in about to start, or undefined when there is none: no site key, the
   * challenge failed, or it is still running invisibly after `HUMAN_CHECK_WAIT_MS`. While the
   * challenge asks the visitor to interact, it waits for them. A token is used once; the next
   * call starts a fresh challenge.
   */
  take(): Promise<string | undefined>;
}

export function humanGate(
  widget: HumanCheckWidget | null | undefined,
  view: HumanGateView,
): HumanGate {
  let token: string | undefined;
  let failed = false;
  let interactive = false;
  let remove: (() => void) | undefined;
  const waiting = new Set<(token: string | undefined) => void>();

  const settleAll = (value: string | undefined) => {
    for (const resolve of [...waiting]) resolve(value);
  };

  const showInteractive = (visible: boolean) => {
    interactive = visible;
    view.setInteractive(visible);
  };

  const start = () => {
    if (!widget) return;
    token = undefined;
    failed = false;
    remove = widget.render(
      view.container,
      {
        onToken: (value) => {
          showInteractive(false);
          if (waiting.size > 0) settleAll(value);
          else token = value;
        },
        onReset: () => {
          token = undefined;
        },
        onError: () => {
          failed = true;
          token = undefined;
          showInteractive(false);
          settleAll(undefined);
        },
        onInteractive: showInteractive,
      },
      { appearance: "interaction-only" },
    );
  };

  /** Drops the used challenge; the next sign-in renders a fresh one. */
  const spend = () => {
    remove?.();
    remove = undefined;
    token = undefined;
    showInteractive(false);
  };

  return {
    prepare() {
      if (!remove) start();
    },
    take() {
      if (!widget) return Promise.resolve(undefined);
      if (token !== undefined) {
        const value = token;
        spend();
        return Promise.resolve(value);
      }
      // A spent or failed challenge starts again; a script that is still blocked fails fast.
      if (!remove || failed) {
        spend();
        start();
      }
      return new Promise((resolve) => {
        const done = (value: string | undefined) => {
          clearTimeout(timer);
          waiting.delete(done);
          if (value !== undefined) spend();
          resolve(value);
        };
        // An invisible challenge that takes too long is skipped; a visible one waits for the
        // visitor, however long they take.
        const expire = () => {
          if (interactive) timer = setTimeout(expire, HUMAN_CHECK_WAIT_MS);
          else done(undefined);
        };
        let timer = setTimeout(expire, HUMAN_CHECK_WAIT_MS);
        waiting.add(done);
      });
    },
  };
}
