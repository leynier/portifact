// The invitation page (`/invitations`, premium plan T1), where an invitation email's link lands
// with its token in the fragment (`#token=…`). `stashInvitationToken` takes the token out of the
// address bar before the router starts and keeps it for this tab only (sessionStorage, or memory
// where storage is blocked), so it never reaches a log, an error message, a `Referer` or the
// login page's `next`. Signed out, the page explains the invitation and sends the person to sign
// in and back. Signed in with the invited verified address, it offers accept and decline; with
// another account, it names only the invited address and offers to switch accounts; a missing,
// expired, revoked or used invitation gets one page. Without a token it lists the invitations
// addressed to the account, which the shell also announces on every screen.
import {
  type IncomingInvitationView,
  InvitationToken,
  type WorkspaceRole,
} from "@portifact/contracts";
import {
  Button,
  buttonClasses,
  Callout,
  ConfirmDialog,
  DetailList,
  EmptyState,
  LoadingState,
  PageHeader,
  Panel,
  ThemedImage,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, CircleAlert, Inbox, LogIn, MailX, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import wordmark from "../../../../../assets/brand/wordmark.svg";
import wordmarkDark from "../../../../../assets/brand/wordmark-dark.svg";
import { loginUrl } from "../../auth/query.ts";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import { ROLE_LABELS, WORKSPACES_QUERY } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";
import { ACCOUNT_QUERY, Shell } from "./shell.tsx";

export const INCOMING_QUERY = ["account", "invitations"] as const;
const LINK_QUERY = ["invitation", "link"] as const;

/** Where this tab keeps the token of the invitation link it opened. */
export const INVITATION_TOKEN_KEY = "portifact.invitation";

let memoryToken: string | null = null;

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Takes an invitation link's token out of the address bar (the fragment, or `?token=` from older
 * links) and keeps it for this tab. Runs before the router reads the location.
 */
export function stashInvitationToken(win: Pick<Window, "location" | "history">): void {
  const url = new URL(win.location.href);
  if (url.pathname !== "/invitations") return;
  const fragment = new URLSearchParams(url.hash.slice(1)).get("token");
  const query = url.searchParams.get("token");
  const raw = fragment ?? query;
  if (raw === null) return;
  url.hash = "";
  url.searchParams.delete("token");
  win.history.replaceState(null, "", `${url.pathname}${url.search}`);
  const token = InvitationToken.safeParse(raw);
  // A malformed token is dropped like a used one: the page then says the link does not work.
  rememberToken(token.success ? token.data : "");
}

function rememberToken(token: string): void {
  memoryToken = token;
  try {
    sessionStore()?.setItem(INVITATION_TOKEN_KEY, token);
  } catch {
    // Blocked storage: the token lives in memory until the page is left.
  }
}

/** The token this tab opened, if any; an empty string stands for a malformed one. */
export function stashedInvitationToken(): string | null {
  try {
    const stored = sessionStore()?.getItem(INVITATION_TOKEN_KEY);
    if (stored !== null && stored !== undefined) return stored;
  } catch {
    // Fall back to memory.
  }
  return memoryToken;
}

export function forgetInvitationToken(): void {
  memoryToken = null;
  try {
    sessionStore()?.removeItem(INVITATION_TOKEN_KEY);
  } catch {
    // Nothing kept.
  }
}

/** The invitations addressed to the signed-in account's verified email. */
export function useIncomingInvitations() {
  const { api } = useDashboard();
  return useQuery({
    queryKey: INCOMING_QUERY,
    queryFn: () => api.incomingInvitations(),
    ...refreshOptions,
  });
}

const ROLE_HINTS: Record<WorkspaceRole, MessageId> = {
  admin: "role.admin.hint",
  editor: "role.editor.hint",
  member: "role.member.hint",
};

/**
 * The invitation page's frame: the dashboard shell once signed in, and a page of its own while
 * signed out, since the shell would send the person to sign in before they can read why.
 */
export function InvitationFrame() {
  const { api } = useDashboard();
  const account = useQuery({ queryKey: ACCOUNT_QUERY, queryFn: () => api.account() });
  if (account.isPending) return null;
  if (account.data) return <Shell />;
  return <SignedOut />;
}

function SignedOut() {
  const t = useT();
  useDocumentTitle(t("invitation.title"));
  const hasLink = stashedInvitationToken() !== null;
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
          className="rounded-lg border border-border bg-canvas p-5 shadow-sm focus:outline-none sm:p-6"
        >
          <PageHeader
            title={t("invitation.title")}
            description={t(hasLink ? "invitation.signedOut.body" : "invitations.signedOut.body")}
          />
          <a href={loginUrl("/invitations")} className={buttonClasses({ intent: "primary" })}>
            <LogIn aria-hidden="true" className="size-4" />
            {t("invitation.signIn")}
          </a>
        </main>
      </div>
    </div>
  );
}

/** What the link's token names, for the signed-in account. */
function useLinkLookup(token: string | null) {
  const { api } = useDashboard();
  return useQuery({
    queryKey: LINK_QUERY,
    // A malformed token never leaves the page: it answers like a missing invitation.
    queryFn: () =>
      token ? api.lookupInvitation(token) : Promise.reject(new ApiFailure("not_found", 404)),
    enabled: token !== null,
    retry: (count, error) =>
      !(error instanceof ApiFailure && error.code === "not_found") && count < 1,
  });
}

export function InvitationScreen() {
  const t = useT();
  useDocumentTitle(t("invitations.title"));
  const [token] = useState(stashedInvitationToken);
  const lookup = useLinkLookup(token);
  // The link's own invitation is shown on its own; the list waits for it and holds the others.
  const linkedId = lookup.data?.status === "invited" ? lookup.data.invitation.id : undefined;
  return (
    <>
      <PageHeader title={t("invitations.title")} description={t("invitations.description")} />
      <div className="flex flex-col gap-6">
        {token !== null ? <LinkInvitation token={token} lookup={lookup} /> : null}
        {token === null || !lookup.isPending ? (
          <IncomingList hasLink={token !== null} linkedId={linkedId} />
        ) : null}
      </div>
    </>
  );
}

/** After an answer: the workspaces and invitations change, and the link is spent. */
function useAnswered() {
  const queryClient = useQueryClient();
  return async () => {
    forgetInvitationToken();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY }),
      queryClient.invalidateQueries({ queryKey: INCOMING_QUERY }),
    ]);
  };
}

function LinkInvitation({
  token,
  lookup,
}: {
  token: string;
  lookup: ReturnType<typeof useLinkLookup>;
}) {
  const t = useT();
  const missing = lookup.error instanceof ApiFailure && lookup.error.code === "not_found";
  // A link that does not work is not kept: the next visit lists the account's invitations.
  useEffect(() => {
    if (missing) forgetInvitationToken();
  }, [missing]);
  if (lookup.isPending) return <LoadingState label={t("invitation.loading")} />;
  if (lookup.isError) {
    if (missing) return <MissingInvitation />;
    return (
      <Callout
        tone="error"
        title={t("invitation.loadFailed")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => lookup.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, lookup.error)}
      </Callout>
    );
  }
  const standing = lookup.data;
  if (standing.status === "other_account") return <OtherAccount email={standing.email} />;
  return <InvitationCard invitation={standing.invitation} token={token} />;
}

function MissingInvitation() {
  const t = useT();
  return (
    <Panel id="invitation" title={t("invitation.missing.title")}>
      <div className="flex items-start gap-3">
        <MailX aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <p className="max-w-3xl text-sm">{t("invitation.missing.body")}</p>
      </div>
    </Panel>
  );
}

function OtherAccount({ email }: { email: string }) {
  const t = useT();
  const { api, leave } = useDashboard();
  const queryClient = useQueryClient();
  const current = queryClient.getQueryData<{ email: string }>(ACCOUNT_QUERY)?.email ?? "";
  const same = current.toLowerCase() === email.toLowerCase();
  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // The token stays in this tab, so the page answers again once the right account is in.
    onSettled: () => leave(loginUrl("/invitations")),
  });
  return (
    <Panel id="invitation" title={t("invitation.other.title")}>
      <div className="flex flex-col gap-4">
        <p className="max-w-3xl text-sm">
          {same
            ? t("invitation.other.unverified", { email })
            : t("invitation.other.body", { email, current })}
        </p>
        <div>
          <Button
            intent="primary"
            icon={<LogIn className="size-4" />}
            busy={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {t("invitation.switch")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** An invitation the account may answer: who invited it where, as what, and until when. */
function InvitationCard({
  invitation,
  token,
}: {
  invitation: IncomingInvitationView;
  token?: string;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const { api } = useDashboard();
  const answered = useAnswered();
  const [declining, setDeclining] = useState(false);
  const workspace = invitation.workspace.name;
  const answer = useMutation({
    mutationFn: (decision: "accept" | "decline") =>
      token === undefined
        ? api.answerInvitation(invitation.id, decision)
        : api.answerInvitationLink(token, decision),
    onSuccess: async (joined, decision) => {
      setDeclining(false);
      await answered();
      if (decision === "decline") {
        announce(t("invitation.declined", { workspace }));
        return;
      }
      announce(t("invitation.accepted", { workspace }));
      await navigate({ to: "/", search: { workspace: joined?.slug ?? invitation.workspace.slug } });
    },
    onError: () => setDeclining(false),
  });
  const missing = answer.error instanceof ApiFailure && answer.error.code === "not_found";
  if (missing) return <MissingInvitation />;
  const headingId = `invitation-${invitation.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-border bg-canvas p-5 shadow-sm"
    >
      <h2 id={headingId} className="text-base font-semibold break-words">
        {workspace}
      </h2>
      <p className="max-w-3xl text-sm">
        {invitation.invitedBy
          ? t("invitation.invited.body", {
              inviter: invitation.invitedBy,
              workspace,
              role: t(ROLE_LABELS[invitation.role]),
            })
          : t("invitation.invited.bodyNoInviter", {
              workspace,
              role: t(ROLE_LABELS[invitation.role]),
            })}
      </p>
      <DetailList
        framed={false}
        items={[
          {
            term: t("invite.role"),
            detail: `${t(ROLE_LABELS[invitation.role])}: ${t(ROLE_HINTS[invitation.role])}`,
          },
          { term: t("invitation.expiresTerm"), detail: formatDate(invitation.expiresAt, true) },
        ]}
      />
      {answer.isError ? (
        <Callout
          tone="error"
          title={t("invitation.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, answer.error)}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          intent="primary"
          icon={<Check className="size-4" />}
          aria-label={t("invitation.acceptNamed", { workspace })}
          busy={answer.isPending && answer.variables === "accept"}
          disabled={answer.isPending}
          onClick={() => answer.mutate("accept")}
        >
          {t("invitation.accept")}
        </Button>
        <Button
          icon={<X className="size-4" />}
          aria-label={t("invitation.declineNamed", { workspace })}
          disabled={answer.isPending}
          onClick={() => setDeclining(true)}
        >
          {t("invitation.decline")}
        </Button>
      </div>
      <ConfirmDialog
        open={declining}
        title={t("invitation.confirmDecline.title", { workspace })}
        confirmLabel={t("invitation.confirmDecline.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<X className="size-4" />}
        tone="danger"
        busy={answer.isPending}
        onConfirm={() => answer.mutate("decline")}
        onCancel={() => setDeclining(false)}
      >
        {t("invitation.confirmDecline.body")}
      </ConfirmDialog>
    </section>
  );
}

function IncomingList({ hasLink, linkedId }: { hasLink: boolean; linkedId: string | undefined }) {
  const t = useT();
  const incoming = useIncomingInvitations();
  if (incoming.isPending) return <LoadingState label={t("invitations.loading")} />;
  if (incoming.isError) {
    return (
      <Callout
        tone="error"
        title={t("invitations.loadFailed")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => incoming.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, incoming.error)}
      </Callout>
    );
  }
  // The link's own invitation is shown above; the list holds the others.
  const items = incoming.data.items.filter((item) => item.id !== linkedId);
  if (items.length === 0) {
    return hasLink ? null : (
      <EmptyState title={t("invitations.empty.title")} icon={<Inbox className="size-5" />}>
        <p>{t("invitations.empty.body")}</p>
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {hasLink ? <h2 className="text-base font-semibold">{t("invitations.others")}</h2> : null}
      {items.map((invitation) => (
        <InvitationCard key={invitation.id} invitation={invitation} />
      ))}
    </div>
  );
}
