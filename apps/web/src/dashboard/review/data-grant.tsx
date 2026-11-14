// The viewer's side of an artifact data grant in its frame (decision 0026, "The grant", flow 1).
// The page asks (`portifact:data-grant-request`), which is only a hint: the viewer draws the
// consent control itself and nothing happens without the person's Allow. Then the viewer sends
// its frame to `grant/begin?flow=frame`, takes the nonce's hash the artifact origin posts back,
// asks the app for a code bound to it and sends the frame to redeem it. Where the browser refuses
// the partitioned cookie the frame says so, and the viewer offers the artifact in a top-level tab,
// where the page starts the grant itself. Messages count only from the frame's own window and the
// artifact's exact origin, and each only in the step that expects it. A visitor without an account
// (delivery 9) gets the anonymous control with the human check where the artifact is open to
// anyone, and is asked to sign in otherwise.
import { Button, buttonClasses, Callout, LoadingState } from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, LogIn, Unplug } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { loginUrl } from "../../auth/query.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import {
  anonymousGrantControlQuery,
  ConsentControl,
  dataGrantControlQuery,
} from "../screens/data-grant.tsx";
import { AnonymousConsentControl, anonymousFailure } from "./anonymous-grant.tsx";

type Phase =
  | { kind: "idle" }
  | { kind: "asking"; to: string }
  | { kind: "beginning"; to: string }
  | { kind: "redeeming" }
  | { kind: "unavailable"; to: string };

/** A path on the artifact's origin, or `/` for anything else the page sent. */
function samePath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value.slice(0, 1024)
    : "/";
}

export function useDataGrant({
  artifactId,
  origin,
  frame,
  anonymous = false,
}: {
  artifactId: string;
  origin: string;
  frame: RefObject<HTMLIFrameElement | null>;
  /**
   * A visitor without an account (delivery 9): the anonymous control and code, with the human
   * check's token taken on Allow and sent once with the code's request.
   */
  anonymous?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const { api } = useDashboard();
  const announce = useAnnounce();
  const t = useT();
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  const issue = useMutation({
    mutationFn: (nonceHash: string) => {
      if (!anonymous) {
        return api.issueDataGrant({ artifactId, nonceHash, host: null, flow: "frame" });
      }
      const turnstileToken = token.current ?? "";
      token.current = null;
      return api.issueAnonymousDataGrant({
        artifactId,
        nonceHash,
        host: null,
        flow: "frame",
        turnstileToken,
      });
    },
    onSuccess: (code) => {
      setPhase({ kind: "redeeming" });
      if (frame.current) frame.current.src = code.redeemUrl;
    },
    onError: () => setPhase({ kind: "idle" }),
  });

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data = (event.data ?? {}) as { type?: unknown; nonceHash?: unknown; to?: unknown };
      const current = phaseRef.current;
      switch (data.type) {
        case "portifact:data-grant-request":
          if (current.kind === "idle" || current.kind === "unavailable") {
            setPhase({ kind: "asking", to: samePath(data.to) });
          }
          return;
        case "portifact:data-grant-begin":
          if (
            current.kind === "beginning" &&
            typeof data.nonceHash === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(data.nonceHash)
          ) {
            issue.mutate(data.nonceHash);
          }
          return;
        case "portifact:data-granted":
          if (current.kind === "redeeming") {
            setPhase({ kind: "idle" });
            announce(t("dataGrant.frame.granted"));
            void queryClient.invalidateQueries({ queryKey: dataGrantStatusQuery(artifactId) });
          }
          return;
        case "portifact:data-grant-unavailable":
          if (current.kind === "beginning" || current.kind === "redeeming") {
            setPhase({ kind: "unavailable", to: samePath(data.to) });
          }
          return;
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [origin, frame, issue, announce, t, queryClient, artifactId]);

  const allow = (turnstileToken?: string) => {
    if (phase.kind !== "asking") return;
    token.current = turnstileToken ?? null;
    issue.reset();
    setPhase({ kind: "beginning", to: phase.to });
    if (frame.current) {
      frame.current.src = `${origin}/__portifact/data/grant/begin?${new URLSearchParams({
        flow: "frame",
        to: phase.to,
      })}`;
    }
  };
  return {
    phase,
    allow,
    decline: () => setPhase({ kind: "idle" }),
    failed: issue.isError,
    error: issue.error,
    anonymous,
  };
}

export const dataGrantStatusQuery = (artifactId: string) =>
  ["data-grant-status", artifactId] as const;

/**
 * While the person's grant on the artifact is open: a note that the page saves as them, and a
 * way to stop it here (decision 0026, "Revocation from the dashboard, the viewer or sign-out").
 * Off, or on an error, nothing is shown.
 */
function OpenGrantNotice({ artifactId }: { artifactId: string }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: dataGrantStatusQuery(artifactId),
    queryFn: () => api.dataGrantStatus(artifactId),
    retry: false,
    staleTime: 60_000,
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeDataGrants(artifactId),
    onSuccess: () => {
      announce(t("dataGrant.viewer.stopped"));
      void queryClient.invalidateQueries({ queryKey: dataGrantStatusQuery(artifactId) });
    },
  });
  if (!status.data || status.data.openGrants === 0) return null;
  return (
    <Callout
      title={t("dataGrant.viewer.saving")}
      action={
        <Button
          intent="danger"
          icon={<Unplug className="size-4" />}
          busy={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          {t("dataGrant.viewer.stop")}
        </Button>
      }
    >
      {t("dataGrant.viewer.savingHint")}
    </Callout>
  );
}

/** What the viewer draws above its frame for the grant: the control, progress or the fallback. */
export function DataGrantPanel({
  artifactId,
  origin,
  grant,
  signInPath = "/",
}: {
  artifactId: string;
  origin: string;
  grant: ReturnType<typeof useDataGrant>;
  /** Where signing in comes back to, for a visitor without an account. */
  signInPath?: string;
}) {
  const t = useT();
  const { api } = useDashboard();
  const asking = grant.phase.kind === "asking";
  const control = useQuery({
    queryKey: dataGrantControlQuery(artifactId, null),
    queryFn: () => api.dataGrantControl(artifactId, null),
    enabled: asking && !grant.anonymous,
    retry: false,
  });
  const anonymousControl = useQuery({
    queryKey: anonymousGrantControlQuery(artifactId, null),
    queryFn: () => api.anonymousDataGrantControl(artifactId, null),
    enabled: asking && grant.anonymous,
    retry: false,
  });
  const { phase } = grant;
  if (phase.kind === "idle") {
    if (grant.failed) {
      return (
        <Callout
          tone="error"
          title={t("dataGrant.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {grant.anonymous ? anonymousFailure(t, grant.error) : t("dataGrant.unavailableHint")}
        </Callout>
      );
    }
    // "Data you shared" is a person's: a visitor without an account has nothing to stop here.
    return grant.anonymous ? null : <OpenGrantNotice artifactId={artifactId} />;
  }
  if (phase.kind === "beginning" || phase.kind === "redeeming") {
    return <LoadingState label={t("dataGrant.frame.saving")} />;
  }
  if (phase.kind === "unavailable") {
    return (
      <Callout
        title={t("dataGrant.frame.unavailable")}
        icon={<CircleAlert className="size-5" />}
        action={
          <a
            href={`${origin}${phase.to}`}
            target="_blank"
            rel="noopener"
            className={buttonClasses({ intent: "secondary" })}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {t("dataGrant.frame.openTab")}
          </a>
        }
      >
        {t("dataGrant.frame.unavailableHint")}
      </Callout>
    );
  }
  if (grant.anonymous) {
    // The page's request is only a hint: an artifact not open to people without an account asks
    // them to sign in instead.
    if (anonymousControl.isError) {
      return (
        <Callout
          title={t("dataGrant.anonymous.signInTitle")}
          icon={<LogIn className="size-5" />}
          action={
            <div className="flex flex-wrap gap-2">
              <a href={loginUrl(signInPath)} className={buttonClasses({ intent: "primary" })}>
                <LogIn aria-hidden="true" className="size-4" />
                {t("dataGrant.anonymous.signIn")}
              </a>
              <Button intent="secondary" onClick={grant.decline}>
                {t("dataGrant.notNow")}
              </Button>
            </div>
          }
        >
          {t("dataGrant.anonymous.closed")}
        </Callout>
      );
    }
    if (!anonymousControl.data) return <LoadingState label={t("dataGrant.loading")} />;
    return (
      <div className="rounded-lg border border-border bg-canvas p-4 shadow-sm">
        <AnonymousConsentControl
          control={anonymousControl.data}
          busy={false}
          failure={null}
          signInHref={loginUrl(signInPath)}
          onAllow={(token) => grant.allow(token)}
          onDecline={grant.decline}
        />
      </div>
    );
  }
  if (control.isError) {
    return (
      <Callout
        tone="error"
        title={t("dataGrant.unavailable")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button intent="secondary" onClick={grant.decline}>
            {t("dataGrant.notNow")}
          </Button>
        }
      >
        {t("dataGrant.unavailableHint")}
      </Callout>
    );
  }
  if (!control.data) return <LoadingState label={t("dataGrant.loading")} />;
  return (
    <div className="rounded-lg border border-border bg-canvas p-4 shadow-sm">
      <ConsentControl
        control={control.data}
        busy={false}
        onAllow={() => grant.allow()}
        onDecline={grant.decline}
      />
    </div>
  );
}
