// The consent control for a visitor without an account (decision 0026, delivery 9, "Anonymous
// writers"): drawn by Portifact like a person's, it says the page learns only an ID for this
// artifact, who reads what is saved, how long it lasts and that nothing ties it to an account, and
// it runs the human check on Allow. Portifact's notice and the sign-in-wrap statement beside Allow
// (`grant-legal.tsx`) come first: nothing is sent to Cloudflare while the visitor only reads, so
// the Turnstile widget starts invisibly ("interaction-only") when they choose Allow, and the
// challenge appears only when Cloudflare asks for an interaction. The token goes once, with the
// request for the code; verification stays on the server and fails closed.
import type { AnonymousDataGrantControl } from "@portifact/contracts";
import { Button, buttonClasses, Callout } from "@portifact/ui";
import { CircleAlert, LogIn, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type HumanGate, humanGate } from "../../auth/human-gate.ts";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { errorMessage } from "../screens/artifact-list.tsx";
import { GrantNotice, GrantTerms } from "./grant-legal.tsx";

/** The human check of an anonymous grant: started on Allow, never before, its token taken then. */
function useGrantHumanCheck(): { take(): Promise<string | undefined>; field: ReactNode } {
  const t = useT();
  const announce = useAnnounce();
  const { humanCheck } = useDashboard();
  const container = useRef<HTMLDivElement>(null);
  const gate = useRef<HumanGate | null>(null);
  const [interactive, setInteractive] = useState(false);
  // Kept in a ref: a provider may hand a new function each render, which must not restart the gate.
  const announceRef = useRef(announce);
  announceRef.current = announce;

  useEffect(() => {
    if (!container.current) return;
    let alive = true;
    const started = humanGate(humanCheck, {
      container: container.current,
      setInteractive(visible) {
        if (!alive) return;
        setInteractive(visible);
        if (visible) announceRef.current(t("dataGrant.anonymous.humanNeeded"));
      },
    });
    // Not prepared here: the challenge starts with `take()`, after the visitor chose Allow.
    gate.current = started;
    return () => {
      alive = false;
      started.stop();
      gate.current = null;
    };
  }, [humanCheck, t]);

  return {
    take: () => gate.current?.take() ?? Promise.resolve(undefined),
    // The container stays displayed: the invisible challenge needs it.
    field: (
      <div className="flex flex-col gap-2">
        {interactive ? (
          <p role="status" className="text-sm">
            {t("dataGrant.anonymous.humanNeeded")}
          </p>
        ) : null}
        <div ref={container} />
      </div>
    ),
  };
}

/** What a refused or failed anonymous Allow says. */
export function anonymousFailure(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiFailure && error.code === "human_verification_required") {
    return t("dataGrant.anonymous.humanFailed");
  }
  return errorMessage(t, error);
}

/**
 * The control for a visitor without an account. `onAllow` gets the human check's token; without
 * one (no challenge could run) nothing is asked of the server and the visitor is told so.
 */
export function AnonymousConsentControl({
  control,
  busy,
  failure,
  signInHref,
  onAllow,
  onDecline,
}: {
  control: AnonymousDataGrantControl;
  busy: boolean;
  /** The last Allow's error, if any. */
  failure: unknown;
  /** Where signing in instead goes, coming back here. */
  signInHref: string;
  onAllow: (token: string) => void;
  onDecline: () => void;
}) {
  const t = useT();
  const termsId = useId();
  const human = useGrantHumanCheck();
  const [checking, setChecking] = useState(false);
  const [noCheck, setNoCheck] = useState(false);
  const owner =
    control.owner.kind === "workspace"
      ? t("dataGrant.ownerWorkspace", { name: control.owner.name })
      : t("dataGrant.ownerPerson", { name: control.owner.name });
  const allow = async () => {
    setNoCheck(false);
    setChecking(true);
    const token = await human.take();
    setChecking(false);
    if (token === undefined) setNoCheck(true);
    else onAllow(token);
  };
  const error = noCheck ? t("dataGrant.anonymous.humanUnavailable") : null;
  return (
    <section aria-labelledby="data-grant-title" className="flex flex-col gap-4">
      <h2 id="data-grant-title" className="text-lg font-semibold">
        {t("dataGrant.anonymous.title", { host: control.host })}
      </h2>
      <p className="text-sm text-text-muted">{owner}</p>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
        <li>{t("dataGrant.anonymous.learns")}</li>
        <li>{t("dataGrant.managers")}</li>
        <li>{t("dataGrant.moves")}</li>
        <li>{t("dataGrant.anonymous.lasts", { days: control.grantDays })}</li>
        <li>{t("dataGrant.anonymous.noAccount")}</li>
      </ul>
      <GrantNotice />
      {human.field}
      {error !== null || failure ? (
        <Callout
          tone="error"
          title={t("dataGrant.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {error ?? anonymousFailure(t, failure)}
        </Callout>
      ) : null}
      <GrantTerms id={termsId} />
      <div className="flex flex-wrap gap-3">
        <Button
          intent="primary"
          aria-describedby={termsId}
          onClick={() => void allow()}
          busy={busy || checking}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        >
          {t("dataGrant.allow")}
        </Button>
        <Button intent="secondary" onClick={onDecline} disabled={busy || checking}>
          {t("dataGrant.notNow")}
        </Button>
        <a href={signInHref} className={buttonClasses({ intent: "link" })}>
          <LogIn aria-hidden="true" className="size-4" />
          {t("dataGrant.anonymous.signIn")}
        </a>
      </div>
    </section>
  );
}
