// The human check of a visitor's first comments on other people's artifacts (docs/security.md,
// "Human check"), the same flow as the login page: the thread list says whether the visitor's
// next comment needs a check (`humanCheck`, never for the owner), and then the composer runs the
// Turnstile widget invisibly ("interaction-only", `auth/human-gate.ts`) from the moment it opens,
// so most visitors already hold a token when they save. The challenge shows inside the composer
// only when Cloudflare asks for an interaction, with calm copy, and the comment is posted as soon
// as it is solved. When the API refuses a post anyway (`human_verification_required`: the hint was
// stale, or the invisible check did not finish), the gate starts and the post is retried once
// with a fresh token under a new idempotency key, because the refused request's answer is stored
// for its key. Verification stays on the server and fails closed.
import { HUMAN_VERIFICATION_REQUIRED } from "@portifact/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type HumanGate, humanGate } from "../../auth/human-gate.ts";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";

export interface HumanCheckState {
  /**
   * Posts with a token when one is needed: waits for the invisible check (or for the visitor,
   * while the challenge asks them to interact) and retries once when the API asks for a check.
   * Resolves with undefined when the composer closed meanwhile.
   */
  post<T>(send: (key: string, token: string | undefined) => Promise<T>): Promise<T | undefined>;
  /** Whether the last post was refused for the human check even after the retry. */
  refused: boolean;
  /** The challenge's place in the form. */
  field: ReactNode;
}

const asksForCheck = (error: unknown) =>
  error instanceof ApiFailure && error.code === HUMAN_VERIFICATION_REQUIRED;

/** `needed` is the thread list's hint: whether the visitor's next comment needs a check. */
export function useHumanCheck(needed: boolean): HumanCheckState {
  const t = useT();
  const announce = useAnnounce();
  const { humanCheck } = useDashboard();
  const container = useRef<HTMLDivElement>(null);
  const gate = useRef<HumanGate | null>(null);
  const alive = useRef(true);
  const key = useRef(crypto.randomUUID());
  const [interactive, setInteractive] = useState(false);
  const [refused, setRefused] = useState(false);

  /** The gate, started on first use; the container is always rendered, so it exists by then. */
  const ensureGate = (): HumanGate | null => {
    if (gate.current) return gate.current;
    if (!container.current) return null;
    gate.current = humanGate(humanCheck, {
      container: container.current,
      setInteractive(visible) {
        if (!alive.current) return;
        setInteractive(visible);
        if (visible) announce(t("review.humanCheck.needed"));
      },
    });
    return gate.current;
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      gate.current?.stop();
      gate.current = null;
    };
  }, []);

  // Started in advance, while the visitor writes, so the token is usually ready on save.
  useEffect(() => {
    if (needed) ensureGate()?.prepare();
  }, [needed]);

  const post = async <T,>(send: (key: string, token: string | undefined) => Promise<T>) => {
    setRefused(false);
    let retried = false;
    for (;;) {
      const token = needed || retried ? await ensureGate()?.take() : undefined;
      if (!alive.current) return undefined;
      try {
        return await send(key.current, token);
      } catch (error) {
        if (!asksForCheck(error)) throw error;
        // The refusal is stored for this key: the next post needs a new one.
        key.current = crypto.randomUUID();
        if (retried) {
          setRefused(true);
          throw error;
        }
        retried = true;
      }
    }
  };

  let note: ReactNode = null;
  if (refused) {
    note = (
      <p role="status" className="text-sm">
        {humanCheck ? t("review.humanCheck.retry") : t("review.humanCheck.unavailable")}
      </p>
    );
  } else if (interactive) {
    note = (
      <p role="status" className="text-sm">
        {t("review.humanCheck.body")}
      </p>
    );
  }

  return {
    post,
    refused,
    // The container stays displayed: an invisible challenge needs it, and it stays empty unless
    // Cloudflare asks the visitor to interact.
    field: (
      <div className="flex flex-col gap-2">
        {note}
        <div ref={container} />
      </div>
    ),
  };
}
