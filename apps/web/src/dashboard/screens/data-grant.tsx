// The consent control of artifact data (decision 0026, "The grant"): drawn by Portifact on the
// app, never by the artifact. It says whose page asks, what it will learn (the display name and an
// ID for this artifact, never the email), who reads what is saved and how long the grant lasts.
// `ConsentControl` is the control itself, shared by the viewer (the frame flow) and the grant page
// (`/data/grant`, the top-level tab and popup flows), which redeems the code by sending the browser
// to the artifact's origin. Names and hosts are untrusted text, rendered as text only.
import type { DataGrantControl, DataGrantFlow } from "@portifact/contracts";
import {
  Button,
  buttonClasses,
  Callout,
  LoadingState,
  PageHeader,
  ThemedImage,
} from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { CircleAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { useDashboard, useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";

/** What the grant page reads from its address; anything malformed counts as missing. */
export interface DataGrantSearch {
  artifact?: string;
  nonce?: string;
  host?: string;
}

export function parseDataGrantSearch(search: Record<string, unknown>): DataGrantSearch {
  const text = (value: unknown, pattern: RegExp) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;
  const artifact = text(search.artifact, /^[a-z2-7]{10}$/);
  const nonce = text(search.nonce, /^[A-Za-z0-9_-]{43}$/);
  const host = text(search.host, /^[a-z0-9.-]{1,253}$/);
  return {
    ...(artifact ? { artifact } : {}),
    ...(nonce ? { nonce } : {}),
    ...(host ? { host } : {}),
  };
}

export const dataGrantControlQuery = (artifactId: string, host: string | null) =>
  ["data-grant-control", artifactId, host] as const;

/**
 * The control: the facts the person decides on, then "Allow" and "Not now". `onAllow` asks the app
 * for the code; the caller decides where it goes.
 */
export function ConsentControl({
  control,
  busy,
  onAllow,
  onDecline,
}: {
  control: DataGrantControl;
  busy: boolean;
  onAllow: () => void;
  onDecline: () => void;
}) {
  const t = useT();
  const owner =
    control.owner.kind === "workspace"
      ? t("dataGrant.ownerWorkspace", { name: control.owner.name })
      : t("dataGrant.ownerPerson", { name: control.owner.name });
  return (
    <section aria-labelledby="data-grant-title" className="flex flex-col gap-4">
      <h2 id="data-grant-title" className="text-lg font-semibold">
        {t("dataGrant.title", { host: control.host })}
      </h2>
      <p className="text-sm text-text-muted">{owner}</p>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
        <li>{t("dataGrant.learns", { name: control.displayName })}</li>
        <li>{t("dataGrant.managers")}</li>
        <li>{t("dataGrant.moves")}</li>
        <li>{t("dataGrant.deletion")}</li>
        <li>{t("dataGrant.lasts", { days: control.grantDays })}</li>
      </ul>
      <p className="text-sm">
        <Link to="/shared-data" className={buttonClasses({ intent: "link" })}>
          {t("dataGrant.rights")}
        </Link>
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          intent="primary"
          onClick={onAllow}
          busy={busy}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        >
          {t("dataGrant.allow")}
        </Button>
        <Button intent="secondary" onClick={onDecline} disabled={busy}>
          {t("dataGrant.notNow")}
        </Button>
      </div>
    </section>
  );
}

/**
 * `/data/grant?artifact=…&nonce=…&host=…`: where the artifact's `grant/begin` sends a top-level
 * visit. Allow sends the browser to the artifact's origin with the code; Not now returns to the
 * artifact (or closes the popup that the page opened).
 */
export function DataGrantScreen() {
  const t = useT();
  const { api, leave } = useDashboard();
  const search = useSearch({ strict: false }) as DataGrantSearch;
  useDocumentTitle(t("dataGrant.pageTitle"));
  const artifact = search.artifact;
  const nonce = search.nonce;
  const host = search.host ?? null;
  const control = useQuery({
    queryKey: dataGrantControlQuery(artifact ?? "", host),
    queryFn: () => api.dataGrantControl(artifact as string, host),
    enabled: artifact !== undefined && nonce !== undefined,
    retry: false,
  });
  const allow = useMutation({
    mutationFn: () =>
      api.issueDataGrant({
        artifactId: artifact as string,
        nonceHash: nonce as string,
        host,
        flow: "top" satisfies DataGrantFlow,
      }),
    onSuccess: (code) => leave(code.redeemUrl),
  });
  const decline = () => {
    if (window.opener) window.close();
    else if (control.data) leave(`https://${control.data.host}/`);
  };

  let body: ReactNode;
  if (artifact === undefined || nonce === undefined || control.isError) {
    body = (
      <Callout
        tone="error"
        title={t("dataGrant.unavailable")}
        icon={<CircleAlert className="size-5" />}
      >
        {t("dataGrant.unavailableHint")}
      </Callout>
    );
  } else if (!control.data) {
    body = <LoadingState label={t("dataGrant.loading")} />;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <ConsentControl
          control={control.data}
          busy={allow.isPending}
          onAllow={() => allow.mutate()}
          onDecline={decline}
        />
        {allow.isError ? (
          <Callout
            tone="error"
            title={t("dataGrant.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, allow.error)}
          </Callout>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-backdrop px-4 py-10 text-text">
      <div className="mx-auto flex max-w-xl flex-col gap-8">
        <header>
          <ThemedImage
            src={wordmark}
            darkSrc={wordmarkDark}
            alt="Portifact"
            width={148}
            height={40}
            className="h-8 w-auto"
          />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-col gap-6 rounded-lg border border-border bg-canvas p-5 shadow-sm focus:outline-none sm:p-6"
        >
          <PageHeader title={t("dataGrant.pageTitle")} />
          {body}
        </main>
      </div>
    </div>
  );
}
