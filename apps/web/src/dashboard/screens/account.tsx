// Sections of the account pages (plan section 6, "Cuenta"), shared by Profile, Apps and Settings:
// how the user can sign in, the browsers signed in, the apps (CLI and MCP clients) that hold
// tokens, the data export and account deletion, with the loading and error states they share.
import {
  type BrowserSession,
  type ConnectedApp,
  CREDENTIALS_SCOPE,
  OAuthScope,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  ConfirmDialog,
  DetailList,
  Disclosure,
  EmptyState,
  LoadingState,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextInput,
} from "@portifact/ui";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Cable,
  Check,
  CircleAlert,
  Download,
  HardDriveDownload,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  Plug,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Unplug,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { loginUrl } from "../../auth/query.ts";
import { ACCOUNT_EXPORT_PATH, ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useRelativeTime, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { spaceCan, useReadySpace, useWorkspaces } from "../space.tsx";
import { describeUserAgent } from "../user-agent.ts";
import { errorMessage } from "./artifact-list.tsx";

export const SIGN_IN_METHODS_QUERY = ["account", "sign-in-methods"] as const;
export const SESSIONS_QUERY = ["account", "sessions"] as const;
export const APPS_QUERY = ["account", "apps"] as const;

const PROVIDERS = ["google", "github"] as const;
type Provider = (typeof PROVIDERS)[number];
const isProvider = (value: string): value is Provider =>
  (PROVIDERS as readonly string[]).includes(value);

export function Section({
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
    <Panel id={id} title={title} description={hint}>
      {children}
    </Panel>
  );
}

/** The loading and error states every section shares; renders `children` with the data. */
export function Loaded<T>({
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

export function SignInMethods({ email }: { email: string }) {
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
            framed={false}
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

export function BrowserSessions() {
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
              {/* Phones get one stacked card per browser; wider screens a table to scan. */}
              <Table caption={t("account.sessions.caption")} stacked>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t("account.sessions.column.browser")}</TableHeaderCell>
                    <TableHeaderCell>{t("account.sessions.column.method")}</TableHeaderCell>
                    <TableHeaderCell>{t("account.sessions.column.lastActive")}</TableHeaderCell>
                    <TableHeaderCell>{t("account.sessions.column.expires")}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((session, index) => (
                    // Sessions carry no public ID; the order is stable between refreshes.
                    <TableRow key={index}>
                      <TableCell>
                        <span className="inline-flex flex-wrap items-center gap-2 font-medium sm:font-normal">
                          {deviceName(t, session)}
                          {session.current ? (
                            <Badge icon={<Monitor className="size-3.5" />}>
                              {t("account.sessions.this")}
                            </Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell label={t("account.sessions.column.method")} stack="inline">
                        {t(`account.method.${session.signInMethod}`)}
                      </TableCell>
                      <TableCell label={t("account.sessions.column.lastActive")} stack="inline">
                        {formatDate(session.lastActiveAt, true)}
                      </TableCell>
                      <TableCell label={t("account.sessions.column.expires")} stack="inline">
                        {formatDate(session.expiresAt)}
                      </TableCell>
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
        tone="danger"
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

const PERMISSIONS: readonly string[] = OAuthScope.options;

/**
 * What an app may do, in a few words: every permission, only reading, or how many of them.
 * Staying connected (`offline_access`) is how long, not what, so it does not count.
 */
function permissionSummary(t: ReturnType<typeof useT>, scopes: readonly string[]): string {
  const granted = PERMISSIONS.filter((name) => scopes.includes(name));
  if (granted.length === PERMISSIONS.length) return t("account.apps.access.full");
  if (granted.length > 0 && granted.every((name) => name.endsWith(":read"))) {
    return t("account.apps.access.readOnly");
  }
  return t("account.apps.access.partial", {
    count: granted.length,
    total: PERMISSIONS.length,
  });
}

function scopeLabel(t: ReturnType<typeof useT>, name: string): string {
  return name.startsWith("artifacts:") ||
    name.startsWith("annotations:") ||
    name === CREDENTIALS_SCOPE ||
    name === "offline_access"
    ? t(`scope.${name}` as Parameters<typeof t>[0])
    : t("scope.unknown", { name });
}

export function ConnectedApps() {
  const t = useT();
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
              // One card per app; two side by side once the column is wide enough.
              <ul className="grid items-start gap-4 2xl:grid-cols-2">
                {items.map((app) => (
                  <AppCard
                    key={app.clientId}
                    app={app}
                    busy={disconnect.isPending && disconnect.variables?.clientId === app.clientId}
                    disabled={disconnect.isPending}
                    onDisconnect={() => setConfirming(app)}
                  />
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
        tone="danger"
        busy={disconnect.isPending}
        onConfirm={() => confirming && disconnect.mutate(confirming)}
        onCancel={() => setConfirming(null)}
      >
        {t("account.apps.confirm.body")}
      </ConfirmDialog>
    </Section>
  );
}

/**
 * One connected app at a glance: what it is, who made it, what it reaches, how much it may do
 * and when it was last used, with the full permissions and exact dates behind "Details".
 */
function AppCard({
  app,
  busy,
  disabled,
  onDisconnect,
}: {
  app: ConnectedApp;
  busy: boolean;
  disabled: boolean;
  onDisconnect(): void;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const relative = useRelativeTime();
  const name = appName(t, app);
  const resources = app.resources
    .map((resource) => t(`account.apps.resource.${resource}`))
    .join(", ");
  const usesMcp = app.resources.includes("mcp");

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-text"
        >
          {usesMcp ? <Bot className="size-5" /> : <SquareTerminal className="size-5" />}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="text-base font-semibold break-words">{name}</h3>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge
              icon={
                app.firstParty ? (
                  <ShieldCheck className="size-3.5" />
                ) : (
                  <Plug className="size-3.5" />
                )
              }
              emphasis={app.firstParty ? "normal" : "quiet"}
            >
              {t(app.firstParty ? "account.apps.firstParty" : "account.apps.thirdParty")}
            </Badge>
            <Badge emphasis="subtle" icon={<KeyRound className="size-3.5" />}>
              {permissionSummary(t, app.scopes)}
            </Badge>
          </div>
        </div>
        <Button
          intent="danger"
          size="sm"
          icon={<Unplug className="size-4" />}
          aria-label={t("account.apps.disconnectLabel", { name })}
          busy={busy}
          disabled={disabled}
          onClick={onDisconnect}
        >
          {t("account.apps.disconnect")}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text-muted">
        {resources ? <li>{t("account.apps.connectsTo", { resources })}</li> : null}
        <li>
          <time dateTime={app.lastIssuedAt} title={formatDate(app.lastIssuedAt, true)}>
            {t("account.apps.lastUsed", { when: relative(app.lastIssuedAt) })}
          </time>
        </li>
        <li>
          {app.expiresAt ? (
            <time dateTime={app.expiresAt} title={formatDate(app.expiresAt, true)}>
              {t("account.apps.expiresOn", { date: formatDate(app.expiresAt) })}
            </time>
          ) : (
            t("account.apps.noExpiry")
          )}
        </li>
      </ul>
      <div className="border-t border-border pt-2">
        <Disclosure
          appearance="inline"
          summary={t("account.apps.details")}
          label={t("account.apps.detailsOf", { name })}
        >
          <DetailList
            framed={false}
            layout="stacked"
            items={[
              {
                term: t("account.apps.scopes"),
                detail: (
                  <ul className="flex flex-col gap-1">
                    {app.scopes.map((scope) => (
                      <li key={scope} className="flex items-start gap-2">
                        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                        <span className="min-w-0 break-words">{scopeLabel(t, scope)}</span>
                      </li>
                    ))}
                  </ul>
                ),
              },
              { term: t("account.apps.approved"), detail: formatDate(app.approvedAt, true) },
              { term: t("account.apps.method"), detail: t(`account.method.${app.signInMethod}`) },
              { term: t("account.apps.lastIssued"), detail: formatDate(app.lastIssuedAt, true) },
              {
                term: t("account.apps.expires"),
                detail: app.expiresAt
                  ? formatDate(app.expiresAt, true)
                  : t("account.apps.noExpiry"),
              },
            ]}
          />
        </Disclosure>
      </div>
    </li>
  );
}

/**
 * The account's own data (its JSON export) and, for the space's admins, the way to the space's
 * data: the "Download your data" page (`/data`, decision 0022), which is not in the side menu. The
 * root route keeps `?workspace=<slug>` on the link, so it opens the space being looked at.
 */
export function AccountData() {
  const t = useT();
  const space = useReadySpace();
  return (
    <Section id="data" title={t("account.data.title")} hint={t("account.data.hint")}>
      <div className="flex flex-col items-start gap-4">
        {/* No `download` attribute: WebKit then names the file after the URL ("export.json") and
            ignores the response's Content-Disposition, which names it portifact-export-<date>.json. */}
        <a href={ACCOUNT_EXPORT_PATH} className={buttonClasses({ intent: "secondary" })}>
          <Download aria-hidden="true" className="size-4" />
          {t("account.data.download")}
        </a>
        {spaceCan(space, "plan") ? (
          <>
            <p className="text-sm text-text-muted">
              {space.kind === "workspace"
                ? t("account.data.spaceWorkspace", { workspace: space.name })
                : t("account.data.spacePersonal")}
            </p>
            <Link to="/data" className={buttonClasses({ intent: "secondary" })}>
              <HardDriveDownload aria-hidden="true" className="size-4" />
              {t("account.data.spaceLink")}
            </Link>
          </>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Why the account cannot be deleted while it is the only admin of a workspace, and what to do:
 * the workspaces where it is an admin, each linking to its members to make someone else an admin.
 */
function SoleAdminNotice() {
  const t = useT();
  const admin = (useWorkspaces().data?.items ?? []).filter((w) => w.role === "admin");
  return (
    <Callout
      tone="error"
      title={t("account.delete.soleAdmin.title")}
      icon={<CircleAlert className="size-5" />}
    >
      <p>{t("account.delete.soleAdmin.body")}</p>
      {admin.length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {admin.map((workspace) => (
            <li key={workspace.slug}>
              <Link to="/members" search={{ workspace: workspace.slug }}>
                {t("account.delete.soleAdmin.members", { workspace: workspace.name })}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Callout>
  );
}

export function DeleteAccount({ email }: { email: string }) {
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
    onSettled: () => leave(loginUrl("/settings")),
  });
  const needsSignIn =
    remove.error instanceof ApiFailure && remove.error.code === "reauthentication_required";
  const soleAdmin =
    remove.error instanceof ApiFailure && remove.error.code === "sole_workspace_admin";

  return (
    <Section id="delete" title={t("settings.danger.title")} hint={t("settings.danger.hint")}>
      <h3 className="text-sm font-semibold">{t("account.delete.title")}</h3>
      <p className="mt-1 mb-4 max-w-3xl text-sm text-text-muted">{t("account.delete.hint")}</p>
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
      ) : soleAdmin ? (
        <div className="mb-4">
          <SoleAdminNotice />
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
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("account.delete.dialog.body")}
      </ConfirmDialog>
    </Section>
  );
}
