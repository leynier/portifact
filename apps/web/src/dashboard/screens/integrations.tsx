// The Integrations page (`/integrations`, premium plan T7, decisions 0018 and 0025): the space's
// connections to GitHub Issues, Linear, Jira Cloud or the space's own Slack app, for its admins.
// Slack is connected in two steps: a label starts it and shows the app's manifest, then the bot
// token and signing secret complete it. Connecting takes a credential the admin
// pastes (with exact steps for the least-privilege token at each service), which the server
// checks and seals; afterwards only its last four characters and the account it acts as are
// shown. Each connection can be tested, changed and removed with a confirmation. Without the
// feature in the plan it says which plan includes integrations; while Portifact does not offer
// them, the page shows nothing to do and the sidebar has no link to it.
import {
  type ConnectionService,
  DEFAULT_REGION,
  INTEGRATION_LIMITS,
  INTEGRATION_SERVICES,
  type IntegrationConnectionView,
  type IntegrationTestResult,
  isIntegrationService,
  lowestPlanWith,
  PLAN_LABELS,
  type SlackSetupView,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CopyField,
  Disclosure,
  EmptyState,
  PageHeader,
  RadioGroup,
  Sheet,
  TextArea,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Blocks,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Info,
  Pencil,
  PlugZap,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { spaceCan, spaceRegion, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { LeavesRegionNotice, SpaceBadge } from "./space-parts.tsx";

/** The connections the owner side picks from, shared by the sidebar and the issue dialog. */
export const integrationChoicesQuery = (slug: string | undefined) =>
  ["integrations", "choices", slug ?? ""] as const;
const connectionsQuery = (slug: string | undefined) =>
  ["integrations", "connections", slug ?? ""] as const;

type T = ReturnType<typeof useT>;

/**
 * A service's name as people read it; a service this build does not know (a newer server's) gets
 * a neutral label instead of a missing message.
 */
export function serviceLabel(t: T, service: string): string {
  return isIntegrationService(service) || service === "slack"
    ? t(`integrations.service.${service}`)
    : t("integrations.service.other");
}

/** The targets typed one per line, trimmed, empty lines dropped. */
export function targetLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function IntegrationsScreen() {
  const t = useT();
  const { api } = useDashboard();
  useDocumentTitle(t("integrations.title"));
  const space = useReadySpace();
  const manages = spaceCan(space, "integrations");
  const list = useQuery({
    queryKey: connectionsQuery(space.slug),
    queryFn: () => api.integrationConnections(space.slug),
    enabled: manages,
    ...refreshOptions,
  });

  if (!manages) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("integrations.title")}
          meta={space.kind === "workspace" ? <SpaceBadge owner={space} /> : undefined}
        />
        <Callout title={t("integrations.adminOnly.title")}>
          {t("integrations.adminOnly.body", {
            workspace: space.kind === "workspace" ? space.name : "",
          })}
        </Callout>
      </div>
    );
  }
  const offered = list.data?.serviceAvailable ?? true;
  const available = list.data?.available ?? true;
  const full =
    (list.data?.connections.length ?? 0) >= (list.data?.limit ?? Number.POSITIVE_INFINITY);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("integrations.title")}
        meta={space.kind === "workspace" ? <SpaceBadge owner={space} /> : undefined}
        description={t("integrations.description")}
      />
      <LeavesRegionNotice space={space} destination="integrations" />
      {list.data && offered && !available ? (
        <Callout tone="info" title={t("integrations.planTitle")} icon={<Info className="size-5" />}>
          {t("integrations.planRequired", { plan: PLAN_LABELS[lowestPlanWith("integrations")] })}
        </Callout>
      ) : null}
      {list.data && !offered ? null : (
        <div className="grid items-start gap-6 xl:grid-cols-3">
          <div className="min-w-0 xl:col-span-2">
            <Section id="connections" title={t("integrations.list.title")}>
              <Loaded
                query={list}
                loading={t("integrations.list.loading")}
                error={t("integrations.list.error")}
              >
                {(data) =>
                  data.connections.length === 0 ? (
                    <EmptyState
                      title={t("integrations.empty.title")}
                      icon={<Blocks className="size-8" />}
                    >
                      <p>{t("integrations.empty.body")}</p>
                    </EmptyState>
                  ) : (
                    <ul className="flex flex-col gap-4">
                      {data.connections.map((connection) => (
                        <ConnectionCard
                          key={connection.id}
                          slug={space.slug}
                          connection={connection}
                          available={data.available}
                          eu={space.kind === "workspace" && spaceRegion(space) !== DEFAULT_REGION}
                        />
                      ))}
                    </ul>
                  )
                }
              </Loaded>
            </Section>
          </div>
          <Connect
            slug={space.slug}
            disabled={!list.data || !available || full}
            full={full}
            limit={list.data?.limit ?? INTEGRATION_LIMITS.perOwner}
            slack={list.data?.slackAvailable ?? false}
          />
        </div>
      )}
    </div>
  );
}

/** A refused check of the credential or the targets says what to look at; anything else, the code. */
function connectError(t: T, error: unknown): string {
  return error instanceof ApiFailure && error.code === "invalid_input"
    ? t("integrations.add.failed")
    : errorMessage(t, error);
}

/** Exact steps for the least-privilege credential at each service. */
function HowTo({ service }: { service: ConnectionService }) {
  const t = useT();
  const steps =
    service === "slack"
      ? ([1, 2, 3, 4] as const).map((n) => t(`integrations.howto.slack.${n}`))
      : service === "github"
        ? ([1, 2, 3, 4, 5] as const).map((n) => t(`integrations.howto.github.${n}`))
        : service === "jira"
          ? ([1, 2, 3, 4, 5] as const).map((n) => t(`integrations.howto.jira.${n}`))
          : ([1, 2, 3] as const).map((n) => t(`integrations.howto.linear.${n}`));
  return (
    <Disclosure appearance="inline" summary={t(`integrations.howto.${service}.title`)}>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-text-muted">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Disclosure>
  );
}

function Connect({
  slug,
  disabled,
  full,
  limit,
  slack,
}: {
  slug: string | undefined;
  disabled: boolean;
  full: boolean;
  limit: number;
  /** Slack connections are offered (`slackAvailable`). */
  slack: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [service, setService] = useState<ConnectionService>("github");
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState("");
  const [targets, setTargets] = useState("");
  // Jira only: the token's account email (sealed with it), the site and its cloud ID.
  const [account, setAccount] = useState("");
  const [site, setSite] = useState("");
  const [cloudId, setCloudId] = useState("");
  const jira = service === "jira";
  const create = useMutation({
    mutationFn: () =>
      api.createIntegration(
        service === "slack"
          ? { service, label: label.trim() }
          : {
              service,
              label: label.trim(),
              credential: credential.trim(),
              targets: targetLines(targets),
              ...(jira
                ? { account: account.trim(), site: site.trim(), cloudId: cloudId.trim() }
                : {}),
            },
        slug,
      ),
    onSuccess: async (created) => {
      setLabel("");
      setCredential("");
      setTargets("");
      setAccount("");
      setSite("");
      setCloudId("");
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      announce(
        t(created.service === "slack" ? "integrations.slack.started" : "integrations.connected", {
          label: created.label,
        }),
      );
    },
    // The credential never stays in the form after a failed attempt either.
    onError: () => setCredential(""),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Section id="connect" title={t("integrations.add.title")} hint={t("integrations.add.hint")}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {full ? (
          <p className="text-sm text-text-muted">{t("integrations.add.limit", { limit })}</p>
        ) : null}
        <RadioGroup<ConnectionService>
          legend={t("integrations.add.service")}
          name="integration-service"
          value={service}
          disabled={disabled}
          onChange={setService}
          options={[...INTEGRATION_SERVICES, ...(slack ? (["slack"] as const) : [])].map(
            (value) => ({ value, label: t(`integrations.service.${value}`) }),
          )}
        />
        <HowTo service={service} />
        <TextInput
          label={t("integrations.add.label")}
          description={t("integrations.add.labelHint")}
          required
          maxLength={INTEGRATION_LIMITS.labelMax}
          value={label}
          disabled={disabled}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        {service === "slack" ? (
          <p className="text-sm text-text-muted">{t("integrations.slack.previews")}</p>
        ) : null}
        {service === "slack" ? (
          <p className="text-sm text-text-muted">
            {t("integrations.slack.notices")}{" "}
            <Link to="/webhooks">{t("integrations.slack.noticesLink")}</Link>
          </p>
        ) : null}
        {jira ? (
          <>
            <TextInput
              label={t("integrations.add.site")}
              description={t("integrations.add.siteHint")}
              required
              spellCheck={false}
              value={site}
              disabled={disabled}
              onChange={(event) => setSite(event.currentTarget.value)}
            />
            <TextInput
              label={t("integrations.add.cloudId")}
              description={t("integrations.add.cloudIdHint")}
              required
              spellCheck={false}
              value={cloudId}
              disabled={disabled}
              onChange={(event) => setCloudId(event.currentTarget.value)}
            />
            <TextInput
              label={t("integrations.add.account")}
              description={t("integrations.add.accountHint")}
              type="email"
              autoComplete="off"
              spellCheck={false}
              required
              value={account}
              disabled={disabled}
              onChange={(event) => setAccount(event.currentTarget.value)}
            />
          </>
        ) : null}
        {service === "slack" ? null : (
          <>
            <TextInput
              label={t(`integrations.add.credential.${service}`)}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={credential}
              disabled={disabled}
              onChange={(event) => setCredential(event.currentTarget.value)}
            />
            <TextArea
              label={t(`integrations.add.targets.${service}`)}
              description={t(`integrations.add.targetsHint.${service}`, {
                limit: INTEGRATION_LIMITS.targetsPerConnection,
              })}
              compact
              code
              rows={3}
              value={targets}
              disabled={disabled}
              onChange={(event) => setTargets(event.currentTarget.value)}
            />
          </>
        )}
        {create.isError ? (
          <Callout
            tone="error"
            title={t("integrations.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {connectError(t, create.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<PlugZap className="size-4" />}
            busy={create.isPending}
            disabled={disabled}
          >
            {t(service === "slack" ? "integrations.slack.start" : "integrations.add.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function testMessage(t: T, label: string, result: IntegrationTestResult): string {
  if (result.ok) {
    const passed = t("integrations.testPassed", { label, identity: result.identity ?? "" });
    return result.refreshed.length === 0
      ? passed
      : `${passed} ${t("integrations.testRefreshed", { targets: result.refreshed.join(", ") })}`;
  }
  return t(`integrations.problem.${result.problem ?? "service_unavailable"}`, {
    target: result.target ?? "",
  });
}

function ConnectionCard({
  slug,
  connection,
  available,
  eu,
}: {
  slug: string | undefined;
  connection: IntegrationConnectionView;
  available: boolean;
  /** The space keeps its data in the EU: say what a Slack app sends outside it. */
  eu: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const label = connection.label;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["integrations"] });
  const test = useMutation({
    mutationFn: () => api.testIntegration(connection.id, slug),
    onSuccess: async (result) => {
      await refresh();
      announce(testMessage(t, label, result));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeIntegration(connection.id, slug),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      announce(t("integrations.removed", { label }));
    },
    onError: () => setConfirming(false),
  });
  const failed = test.error ?? remove.error;
  const busy = test.isPending || remove.isPending;
  const pending = connection.attention === "pending";

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-base font-semibold break-words">{label}</h3>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {pending ? (
              <Badge emphasis="strong" icon={<Info className="size-3.5" />}>
                {t("integrations.state.pending")}
              </Badge>
            ) : connection.attention ? (
              <Badge emphasis="strong" icon={<TriangleAlert className="size-3.5" />}>
                {t("integrations.state.attention")}
              </Badge>
            ) : (
              <Badge icon={<CircleCheck className="size-3.5" />}>
                {t("integrations.state.ready")}
              </Badge>
            )}
            <Badge emphasis="subtle">{t(`integrations.service.${connection.service}`)}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<PlugZap className="size-4" />}
            aria-label={t("integrations.testLabel", { label })}
            busy={test.isPending}
            disabled={busy || pending}
            onClick={() => test.mutate()}
          >
            {t("integrations.test")}
          </Button>
          <Button
            size="sm"
            icon={<Pencil className="size-4" />}
            aria-label={t("integrations.editLabel", { label })}
            disabled={busy || !available || pending}
            onClick={() => setEditing(true)}
          >
            {t("integrations.edit")}
          </Button>
          <Button
            size="sm"
            intent="danger"
            icon={<Trash2 className="size-4" />}
            aria-label={t("integrations.removeLabel", { label })}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("integrations.remove")}
          </Button>
        </div>
      </div>
      {pending ? null : (
        <ul className="flex flex-col gap-1 text-sm text-text-muted">
          {connection.site ? (
            <li>{t("integrations.site", { site: `${connection.site}.atlassian.net` })}</li>
          ) : null}
          <li>
            {connection.service === "slack"
              ? t("integrations.slack.team", { team: connection.identity })
              : t("integrations.identity", { identity: connection.identity })}
          </li>
          <li>{t("integrations.credential", { hint: connection.credentialHint })}</li>
          {connection.service === "slack" ? null : (
            <li>{connection.targets.map((target) => target.name).join(", ")}</li>
          )}
        </ul>
      )}
      {connection.slack ? (
        <SlackSetup
          slug={slug}
          connection={connection}
          setup={connection.slack}
          available={available}
          eu={eu}
        />
      ) : null}
      {connection.attention && !pending ? (
        <Callout
          tone="error"
          title={t("integrations.state.attention")}
          icon={<TriangleAlert className="size-5" />}
        >
          {t(`integrations.attention.${connection.attention}`)}
        </Callout>
      ) : null}
      {test.data ? (
        <p role="status" className="text-sm">
          {testMessage(t, label, test.data)}
        </p>
      ) : null}
      {failed ? (
        <Callout
          tone="error"
          title={t("integrations.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, failed)}
        </Callout>
      ) : null}
      <EditConnection
        open={editing}
        slug={slug}
        connection={connection}
        onClose={() => setEditing(false)}
      />
      <ConfirmDialog
        open={confirming}
        title={t("integrations.confirm.title", { label })}
        confirmLabel={t("integrations.remove")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t(
          connection.service === "slack"
            ? "integrations.confirm.slackBody"
            : "integrations.confirm.body",
        )}
      </ConfirmDialog>
    </li>
  );
}

/** Changes the label, the credential (checked again) or the targets (checked again). */
function EditConnection({
  open,
  slug,
  connection,
  onClose,
}: {
  open: boolean;
  slug: string | undefined;
  connection: IntegrationConnectionView;
  onClose(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [label, setLabel] = useState(connection.label);
  const [credential, setCredential] = useState("");
  const [account, setAccount] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const jira = connection.service === "jira";
  const service = connection.service;
  const [targets, setTargets] = useState(connection.targets.map((target) => target.id).join("\n"));
  const save = useMutation({
    mutationFn: () => {
      const lines = targetLines(targets);
      const sameTargets =
        lines.length === connection.targets.length &&
        lines.every((line, i) => line.toLowerCase() === connection.targets[i]?.id.toLowerCase());
      const renamed = label.trim() !== connection.label ? { label: label.trim() } : {};
      if (service === "slack") {
        return api.updateIntegration(
          connection.id,
          {
            ...renamed,
            ...(credential.trim() !== "" || signingSecret.trim() !== ""
              ? { botToken: credential.trim(), signingSecret: signingSecret.trim() }
              : {}),
          },
          slug,
        );
      }
      return api.updateIntegration(
        connection.id,
        {
          ...renamed,
          ...(credential.trim() !== "" ? { credential: credential.trim() } : {}),
          ...(jira && credential.trim() !== "" ? { account: account.trim() } : {}),
          ...(sameTargets ? {} : { targets: lines }),
        },
        slug,
      );
    },
    onSuccess: async (saved) => {
      setCredential("");
      setAccount("");
      setSigningSecret("");
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      announce(t("integrations.saved", { label: saved.label }));
      onClose();
    },
    onError: () => {
      setCredential("");
      setSigningSecret("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const formId = `edit-${connection.id}`;
  return (
    <Sheet
      open={open}
      title={t("integrations.edit.title", { label: connection.label })}
      closeLabel={t("issues.dialog.close")}
      onClose={onClose}
      footer={
        <Button type="submit" form={formId} intent="primary" busy={save.isPending}>
          {t("integrations.edit.save")}
        </Button>
      }
    >
      <form id={formId} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <TextInput
          label={t("integrations.add.label")}
          required
          maxLength={INTEGRATION_LIMITS.labelMax}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        {service === "slack" ? (
          <>
            <TextInput
              label={t("integrations.slack.botToken")}
              description={t("integrations.edit.slackHint")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={credential}
              onChange={(event) => setCredential(event.currentTarget.value)}
            />
            <TextInput
              label={t("integrations.slack.signingSecret")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={signingSecret}
              onChange={(event) => setSigningSecret(event.currentTarget.value)}
            />
          </>
        ) : (
          <TextInput
            label={t(`integrations.add.credential.${service}`)}
            description={t("integrations.edit.credentialHint")}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={credential}
            onChange={(event) => setCredential(event.currentTarget.value)}
          />
        )}
        {jira ? (
          <TextInput
            label={t("integrations.add.account")}
            description={t("integrations.edit.accountHint")}
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={account}
            onChange={(event) => setAccount(event.currentTarget.value)}
          />
        ) : null}
        {service === "slack" ? null : (
          <TextArea
            label={t(`integrations.add.targets.${service}`)}
            description={t(`integrations.add.targetsHint.${service}`, {
              limit: INTEGRATION_LIMITS.targetsPerConnection,
            })}
            compact
            code
            rows={3}
            value={targets}
            onChange={(event) => setTargets(event.currentTarget.value)}
          />
        )}
        {save.isError ? (
          <Callout
            tone="error"
            title={t("integrations.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {connectError(t, save.error)}
          </Callout>
        ) : null}
      </form>
    </Sheet>
  );
}

/**
 * A Slack connection's setup (decision 0025): while pending, the steps, Slack's prefilled
 * "create from manifest" link, the manifest and the Request URL to copy, and the form for the bot
 * token and signing secret; once completed, the "Verify" instruction, and a note when the app runs
 * an older manifest. The EU note says what the app sends outside the EU.
 */
function SlackSetup({
  slug,
  connection,
  setup,
  available,
  eu,
}: {
  slug: string | undefined;
  connection: IntegrationConnectionView;
  setup: SlackSetupView;
  available: boolean;
  eu: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const pending = connection.attention === "pending";
  const complete = useMutation({
    mutationFn: () =>
      api.updateIntegration(
        connection.id,
        { botToken: botToken.trim(), signingSecret: signingSecret.trim() },
        slug,
      ),
    onSuccess: async (saved) => {
      setBotToken("");
      setSigningSecret("");
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      announce(t("integrations.connected", { label: saved.label }));
    },
    // Neither secret stays in the form after a failed attempt.
    onError: () => {
      setBotToken("");
      setSigningSecret("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    complete.mutate();
  };
  const copied = () => announce(t("integrations.slack.copied"));
  const copyFields = (
    <>
      <CopyField
        label={t("integrations.slack.requestUrl")}
        value={setup.requestUrl}
        copyLabel={t("integrations.slack.copyRequestUrl")}
        copiedLabel={t("integrations.slack.copied")}
        onCopied={copied}
      />
      <Disclosure appearance="inline" summary={t("integrations.slack.manifest")}>
        <CopyField
          label={t("integrations.slack.manifest")}
          value={setup.manifest}
          copyLabel={t("integrations.slack.copyManifest")}
          copiedLabel={t("integrations.slack.copied")}
          onCopied={copied}
        />
      </Disclosure>
    </>
  );
  return (
    <div className="flex flex-col gap-4">
      {eu ? (
        <Callout tone="info" title={t("region.leaves.title")} icon={<Info className="size-5" />}>
          {t("integrations.slack.eu")}
        </Callout>
      ) : null}
      <p className="text-sm text-text-muted">
        {t("integrations.slack.previews")} {t("integrations.slack.previewsStay")}
      </p>
      {pending ? (
        <>
          <Callout tone="info" title={t("integrations.slack.pending.title")}>
            {t("integrations.slack.pending.body")}
          </Callout>
          <HowTo service="slack" />
          <p className="text-sm text-text-muted">{t("integrations.slack.rename")}</p>
          <div>
            <a
              href={setup.createUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium underline"
            >
              {t("integrations.slack.create")}
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          </div>
          {copyFields}
          <form
            className="flex flex-col gap-4"
            aria-label={t("integrations.slack.pending.title")}
            onSubmit={submit}
            noValidate
          >
            <TextInput
              label={t("integrations.slack.botToken")}
              description={t("integrations.slack.botTokenHint")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={botToken}
              disabled={!available}
              onChange={(event) => setBotToken(event.currentTarget.value)}
            />
            <TextInput
              label={t("integrations.slack.signingSecret")}
              description={t("integrations.slack.signingSecretHint")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={signingSecret}
              disabled={!available}
              onChange={(event) => setSigningSecret(event.currentTarget.value)}
            />
            {complete.isError ? (
              <Callout
                tone="error"
                title={t("integrations.actionFailed")}
                icon={<CircleAlert className="size-5" />}
              >
                {errorMessage(t, complete.error)}
              </Callout>
            ) : null}
            <div>
              <Button
                type="submit"
                intent="primary"
                icon={<PlugZap className="size-4" />}
                busy={complete.isPending}
                disabled={!available}
              >
                {t("integrations.slack.finish")}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p className="text-sm text-text-muted">{t("integrations.slack.verify")}</p>
          <p className="text-sm text-text-muted">{t("integrations.slack.rename")}</p>
          {setup.outdated ? (
            <Callout tone="info" title={t("integrations.slack.outdatedTitle")}>
              {t("integrations.slack.outdated")}
            </Callout>
          ) : null}
          <Disclosure appearance="inline" summary={t("integrations.slack.setup")}>
            <div className="flex flex-col gap-4">{copyFields}</div>
          </Disclosure>
        </>
      )}
    </div>
  );
}
