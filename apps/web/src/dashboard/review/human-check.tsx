// The human check of a visitor's first comments on other people's artifacts (docs/security.md,
// "Human check"). The viewer does not know in advance whether a comment needs one: it posts,
// and when the API answers `human_verification_required` it shows the challenge. The next post
// carries the solved token under a new idempotency key, because the refused request's answer
// is stored for its key.
import { HUMAN_VERIFICATION_REQUIRED } from "@portifact/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useDashboard, useT } from "../context.tsx";

export interface HumanCheckState {
  /** The challenge is shown: the API asked for it. */
  needed: boolean;
  /** The solved token to send with the next post, if any. */
  token: string | undefined;
  /** The idempotency key of the next post. */
  key: string;
  /** Call with the error of a failed post; returns whether it asked for the check. */
  failed(error: unknown): boolean;
  /** Whether a post may go now; if the check is shown but unsolved, says so and returns false. */
  ready(): boolean;
  /** The challenge, to render in the form while it is needed. */
  field: ReactNode;
}

export function useHumanCheck(): HumanCheckState {
  const [needed, setNeeded] = useState(false);
  const [token, setTokenState] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const setToken = (value: string | undefined) => {
    setTokenState(value);
    if (value) setMissing(false);
  };
  // A new widget instance after every refusal, so a spent token is never offered again.
  const [round, setRound] = useState(0);
  const key = useRef(crypto.randomUUID());
  const failed = (error: unknown) => {
    const asked = error instanceof ApiFailure && error.code === HUMAN_VERIFICATION_REQUIRED;
    if (asked || (needed && error instanceof ApiFailure && error.status === 503)) {
      key.current = crypto.randomUUID();
      setToken(undefined);
      setNeeded(true);
      setRound((value) => value + 1);
    }
    return asked;
  };
  const ready = () => {
    if (needed && !token) {
      setMissing(true);
      return false;
    }
    return true;
  };
  return {
    needed,
    token,
    key: key.current,
    failed,
    ready,
    field: needed ? <HumanCheckField key={round} missing={missing} onToken={setToken} /> : null,
  };
}

function HumanCheckField({
  missing,
  onToken,
}: {
  missing: boolean;
  onToken(token: string | undefined): void;
}) {
  const t = useT();
  const { humanCheck } = useDashboard();
  const container = useRef<HTMLDivElement>(null);
  // The widget is rendered once per instance; a new round mounts a new instance.
  useEffect(() => {
    if (!humanCheck || !container.current) return;
    return humanCheck.render(container.current, {
      onToken: (token) => onToken(token),
      onReset: () => onToken(undefined),
    });
  }, []);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t("review.humanCheck.label")}</legend>
      <p className="text-sm text-text-muted">
        {humanCheck ? t("review.humanCheck.body") : t("review.humanCheck.unavailable")}
      </p>
      <div ref={container} />
      {missing ? (
        <p role="alert" className="border-l-2 border-border-strong pl-2 text-sm font-medium">
          {t("review.humanCheck.missing")}
        </p>
      ) : null}
    </fieldset>
  );
}
