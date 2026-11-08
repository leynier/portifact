// The account screen (plan section 6, "Cuenta"): the signed-in email, the account's usage
// (quotas and this month's traffic), how the user can sign in,
// the browsers signed in, the apps (CLI and MCP clients) that hold tokens, the data export and
// account deletion.
import type { BrowserSession, ConnectedApp } from "@portifact/contracts";
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  ConfirmDialog,
  DetailList,
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextInput,
} from "@portifact/ui";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cable,
  CircleAlert,
  Download,
  LogIn,
  LogOut,
  Monitor,
  Plug,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { loginUrl } from "../../auth/query.ts";
import { ACCOUNT_EXPORT_PATH, type Account, ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { describeUserAgent } from "../user-agent.ts";
import { errorMessage } from "./artifact-list.tsx";
import { ACCOUNT_QUERY } from "./shell.tsx";
import { UsageDetails, useUsage } from "./usage.tsx";

export const SIGN_IN_METHODS_QUERY = ["account", "sign-in-methods"] as const;
export const SESSIONS_QUERY = ["account", "sessions"] as const;
export const APPS_QUERY = ["account", "apps"] as const;

const PROVIDERS = ["google", "github"] as const;
type Provider = (typeof PROVIDERS)[number];
const isProvider = (value: string): value is Provider =>
  (PROVIDERS as readonly string[]).includes(value);

export function AccountScreen() {
  const t = useT();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  useDocumentTitle(t("account.title"));
  // The shell loads the account before any screen renders.
  const account = queryClient.getQueryData<Account>(ACCOUNT_QUERY);

  return (
    <>
      <PageHeader title={t("account.title")} description={t("account.description")} />
      <Section id="profile" title={t("account.profile")}>
        <DetailList
          items={[
            { term: t("account.email"), detail: account?.email ?? "" },
            ...(account?.createdAt
              ? [{ term: t("account.memberSince"), detail: formatDate(account.createdAt) }]
              : []),
          ]}
        />
      </Section>
      <Usage />
      <SignInMethods email={account?.email ?? ""} />
      <BrowserSessions />
      <ConnectedApps />
      <AccountData />
      <DeleteAccount email={account?.email ?? ""} />
    </>
  );
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="mt-8 first-of-type:mt-0">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {title}
      </h2>
      {hint ? <p className="mt-1 text-sm text-text-muted">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The loading and error states every section shares; renders `children` with the data. */
function Loaded<T>({
  query,
  loading,
  error,
  children,
}: {
  query: UseQueryResult<T>;
  loading: string;
  error: string;
  children: (data: T) => ReactNode;
}) {
  const t = useT();
  if (query.isPending) return <LoadingState label={loading} />;
  if (query.isError && query.data === undefined) {
    return (
      <Callout
        tone="error"
        title={error}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => query.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, query.error)}
      </Callout>
    );
  }
  return <>{children(query.data as T)}</>;
}

function Usage() {
  const t = useT();
  const usage = useUsage();
  return (
    <Section id="usage" title={t("usage.title")} hint={t("usage.hint")}>
      <Loaded query={usage} loading={t("usage.loading")} error={t("usage.error")}>
        {(view) => <UsageDetails usage={view} />}
      </Loaded>
    </Section>
  );
}

function SignInMethods({ email }: { email: string }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  const methods = useQuery({ queryKey: SIGN_IN_METHODS_QUERY, queryFn: () => api.signInMethods() });

  return (
    <Section id="methods" title={t("account.methods.title")} hint={t("account.methods.hint")}>
      <Loaded
        query={methods}
        loading={t("account.methods.loading")}
        error={t("account.methods.error")}
      >
        {(list) => (
          <DetailList
            items={[
              {
                term: t("account.methods.email"),
                detail: t("account.methods.emailDetail", { email }),
              },
              ...list
                .filter((method) => isProvider(method.provider))
                .map((method) => ({
                  term: t(`provider.${method.provider as Provider}`),
                  detail: t("account.methods.connected", { date: formatDate(method.connectedAt) }),
                })),
            ]}
          />
        )}
      </Loaded>
    </Section>
  );
}

function deviceName(t: ReturnType<typeof useT>, session: BrowserSession): string {
  const { browser, system } = describeUserAgent(session.userAgent);
  if (browser && system) return t("account.sessions.device", { browser, system });
  return browser ?? system ?? t("account.sessions.unknown");
}

function BrowserSessions() {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const sessions = useQuery({
    queryKey: SESSIONS_QUERY,
    queryFn: () => api.browserSessions(),
    ...refreshOptions,
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.signOutOtherSessions(),
    onSuccess: async ({ signedOut }) => {
      setConfirming(false);
      // Tokens issued through those browsers were revoked; apps renew them on their own.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY }),
        queryClient.invalidateQueries({ queryKey: APPS_QUERY }),
      ]);
      announce(t("account.sessions.signedOut", { count: signedOut }));
    },
    onError: () => setConfirming(false),
  });

  return (
    <Section id="sessions" title={t("account.sessions.title")} hint={t("account.sessions.hint")}>
      <Loaded
        query={sessions}
        loading={t("account.sessions.loading")}
        error={t("account.sessions.error")}
      >
        {({ items }) => {
          const others = items.filter((session) => !session.current).length;
          return (
            <>
              {signOutOthers.isError ? (
                <div className="mb-4">
                  <Callout
                    tone="error"
                    title={t("account.actionFailed.title")}
                    icon={<CircleAlert className="size-5" />}
                  >
                    {errorMessage(t, signOutOthers.error)}
                  </Callout>
                </div>
              ) : null}
              <Table caption={t("account.sessions.caption")}>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t("account.sessions.column.browser")}</TableHeaderCell>
                    <TableHeaderCell>{t("account.sessions.column.lastActive")}</TableHeaderCell>
                    <TableHeaderCell>{t("account.sessions.column.expires")}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((session, index) => (
                    // Sessions carry no public ID; the order is stable between refreshes.
                    <TableRow key={index}>
                      <TableCell>
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {deviceName(t, session)}
                          {session.current ? (
                            <Badge icon={<Monitor className="size-3.5" />}>
                              {t("account.sessions.this")}
                            </Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>{formatDate(session.lastActiveAt, true)}</TableCell>
                      <TableCell>{formatDate(session.expiresAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4">
                {others === 0 ? (
                  <p className="text-sm text-text-muted">{t("account.sessions.onlyThis")}</p>
                ) : (
                  <Button
                    icon={<LogOut className="size-4" />}
                    busy={signOutOthers.isPending}
                    onClick={() => setConfirming(true)}
                  >
                    {t("account.sessions.signOutOthers")}
                  </Button>
                )}
              </div>
            </>
          );
        }}
      </Loaded>
      <ConfirmDialog
        open={confirming}
        title={t("account.sessions.confirm.title")}
        confirmLabel={t("account.sessions.confirm.confirm")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<LogOut className="size-4" />}
        busy={signOutOthers.isPending}
        onConfirm={() => signOutOthers.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("account.sessions.confirm.body")}
      </ConfirmDialog>
    </Section>
  );
}

function appName(t: ReturnType<typeof useT>, app: ConnectedApp): string {
  return app.name?.trim() || t("account.apps.unnamed");
}

function ConnectedApps() {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState<ConnectedApp | null>(null);
  const apps = useQuery({
    queryKey: APPS_QUERY,
    queryFn: () => api.connectedApps(),
    ...refreshOptions,
  });
  const disconnect = useMutation({
    mutationFn: (app: ConnectedApp) => api.disconnectApp(app.clientId),
    onSuccess: async (_, app) => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: APPS_QUERY });
      announce(t("account.apps.disconnected", { name: appName(t, app) }));
    },
    onError: () => setConfirming(null),
  });

  const scope = (name: string) =>
    name.startsWith("artifacts:") || name.startsWith("annotations:") || name === "offline_access"
      ? t(`scope.${name}` as Parameters<typeof t>[0])
      : t("scope.unknown", { name });

  return (
    <Section id="apps" title={t("account.apps.title")} hint={t("account.apps.hint")}>
      <Loaded query={apps} loading={t("account.apps.loading")} error={t("account.apps.error")}>
        {({ items }) => (
          <>
            {disconnect.isError ? (
              <div className="mb-4">
                <Callout
                  tone="error"
                  title={t("account.actionFailed.title")}
                  icon={<CircleAlert className="size-5" />}
                >
                  {errorMessage(t, disconnect.error)}
                </Callout>
              </div>
            ) : null}
            {items.length === 0 ? (
              <EmptyState title={t("account.apps.empty.title")} icon={<Cable className="size-8" />}>
                <p>{t("account.apps.empty.body")}</p>
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-4">
                {items.map((app) => (
                  <li key={app.clientId} className="rounded-md border border-border p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <h3 className="inline-flex flex-wrap items-center gap-2 text-base font-semibold">
                        <span className="break-all">{appName(t, app)}</span>
                        <Badge
                          icon={<Plug className="size-3.5" />}
                          emphasis={app.firstParty ? "normal" : "quiet"}
                        >
                          {t(
                            app.firstParty ? "account.apps.firstParty" : "account.apps.thirdParty",
                          )}
                        </Badge>
                      </h3>
                      <Button
                        size="sm"
                        icon={<Unplug className="size-4" />}
                        aria-label={t("account.apps.disconnectLabel", { name: appName(t, app) })}
                        busy={
                          disconnect.isPending && disconnect.variables?.clientId === app.clientId
                        }
                        disabled={disconnect.isPending}
                        onClick={() => setConfirming(app)}
                      >
                        {t("account.apps.disconnect")}
                      </Button>
                    </div>
                    <DetailList
                      items={[
                        {
                          term: t("account.apps.resources"),
                          detail: app.resources
                            .map((resource) => t(`account.apps.resource.${resource}`))
                            .join(", "),
                        },
                        {
                          term: t("account.apps.scopes"),
                          detail: (
                            <ul className="list-disc pl-5">
                              {app.scopes.map((name) => (
                                <li key={name}>{scope(name)}</li>
                              ))}
                            </ul>
                          ),
                        },
                        {
                          term: t("account.apps.approved"),
                          detail: formatDate(app.approvedAt, true),
                        },
                        {
                          term: t("account.apps.lastIssued"),
                          detail: formatDate(app.lastIssuedAt, true),
                        },
                        {
                          term: t("account.apps.expires"),
                          detail: app.expiresAt
                            ? formatDate(app.expiresAt, true)
                            : t("account.apps.noExpiry"),
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Loaded>
      <ConfirmDialog
        open={confirming !== null}
        title={t("account.apps.confirm.title", { name: confirming ? appName(t, confirming) : "" })}
        confirmLabel={t("account.apps.disconnect")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Unplug className="size-4" />}
        busy={disconnect.isPending}
        onConfirm={() => confirming && disconnect.mutate(confirming)}
        onCancel={() => setConfirming(null)}
      >
        {t("account.apps.confirm.body")}
      </ConfirmDialog>
    </Section>
  );
}

function AccountData() {
  const t = useT();
  return (
    <Section id="data" title={t("account.data.title")} hint={t("account.data.hint")}>
      <a href={ACCOUNT_EXPORT_PATH} download className={buttonClasses({ intent: "secondary" })}>
        <Download aria-hidden="true" className="size-4" />
        {t("account.data.download")}
      </a>
    </Section>
  );
}

function DeleteAccount({ email }: { email: string }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, leave } = useDashboard();
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(typed),
    onSuccess: () => {
      setConfirming(false);
      announce(t("account.delete.done"));
      leave("/login");
    },
    onError: () => setConfirming(false),
  });
  const reauth = useMutation({
    mutationFn: () => api.signOut(),
    onSettled: () => leave(loginUrl("/account")),
  });
  const needsSignIn =
    remove.error instanceof ApiFailure && remove.error.code === "reauthentication_required";

  return (
    <Section id="delete" title={t("account.delete.title")} hint={t("account.delete.hint")}>
      {needsSignIn ? (
        <div className="mb-4">
          <Callout
            tone="error"
            title={t("account.delete.reauth.title")}
            icon={<CircleAlert className="size-5" />}
            action={
              <Button
                icon={<LogIn className="size-4" />}
                busy={reauth.isPending}
                onClick={() => reauth.mutate()}
              >
                {t("account.delete.reauth.action")}
              </Button>
            }
          >
            {t("account.delete.reauth.body")}
          </Callout>
        </div>
      ) : remove.isError ? (
        <div className="mb-4">
          <Callout
            tone="error"
            title={t("account.actionFailed.title")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, remove.error)}
          </Callout>
        </div>
      ) : null}
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const matches = typed.trim().toLowerCase() === email.toLowerCase();
          setMismatch(!matches);
          if (matches) setConfirming(true);
        }}
      >
        <TextInput
          label={t("account.delete.confirmLabel")}
          description={t("account.delete.confirmHint", { email })}
          type="email"
          autoComplete="off"
          value={typed}
          error={mismatch ? t("account.delete.mismatch") : undefined}
          onChange={(event) => setTyped(event.target.value)}
        />
        <div>
          <Button type="submit" icon={<Trash2 className="size-4" />} busy={remove.isPending}>
            {t("account.delete.button")}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={t("account.delete.dialog.title")}
        confirmLabel={t("account.delete.dialog.confirm")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("account.delete.dialog.body")}
      </ConfirmDialog>
    </Section>
  );
}
