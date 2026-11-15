// The Service tokens page of a workspace (`/service-tokens?workspace=<slug>`, premium plan T4,
// decision 0011). Only admins manage tokens, and only here: creating one (label, role, scopes,
// expiry and an optional restriction) shows its secret once with a copy button; the list shows
// each token's role, scopes, restriction, expiry and last use; revoking asks for a confirmation.
// The API decides every write again; without the feature in the plan, creating is not offered.
// Below them, the GitHub Actions section trusts repositories instead of tokens (decision 0024).
import {
  lowestPlanWith,
  PLAN_LABELS,
  PublishKey,
  SERVICE_TOKEN_SCOPES,
  SERVICE_TOKENS,
  type ServiceTokenCreated,
  type ServiceTokenScope,
  type ServiceTokenView,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  CopyField,
  EmptyState,
  FieldError,
  PageHeader,
  RadioGroup,
  Select,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info, KeyRound, KeySquare, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useRelativeTime, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import { type Space, spaceCan, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { GitHubTrust } from "./github-trust.tsx";
import { SpaceBadge } from "./space-parts.tsx";

export const serviceTokensQuery = (slug: string) => ["workspace", slug, "service-tokens"] as const;

type T = ReturnType<typeof useT>;
type Workspace = Extract<Space, { kind: "workspace" }>;
type Restriction = "none" | "own" | "key";

const EXPIRY_DAYS = ["7", "30", "90", "180", "366"] as const;

const SCOPE_LABELS: Record<ServiceTokenScope, MessageId> = {
  "artifacts:read": "tokens.scope.read",
  "artifacts:write": "tokens.scope.write",
  "artifacts:share": "tokens.scope.share",
  "artifacts:delete": "tokens.scope.delete",
  "data:read": "tokens.scope.dataRead",
  "data:write": "tokens.scope.dataWrite",
};
const SCOPE_HINTS: Record<ServiceTokenScope, MessageId> = {
  "artifacts:read": "tokens.scope.readHint",
  "artifacts:write": "tokens.scope.writeHint",
  "artifacts:share": "tokens.scope.shareHint",
  "artifacts:delete": "tokens.scope.deleteHint",
  "data:read": "tokens.scope.dataReadHint",
  "data:write": "tokens.scope.dataWriteHint",
};

export function ServiceTokensScreen() {
  const t = useT();
  useDocumentTitle(t("tokens.title"));
  const space = useReadySpace();
  if (space.kind === "personal") {
    return (
      <>
        <PageHeader title={t("tokens.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("tokens.personal.title")}>{t("tokens.personal.body")}</Callout>
      </>
    );
  }
  if (!spaceCan(space, "tokens")) {
    return (
      <>
        <PageHeader title={t("tokens.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("tokens.adminOnly.title")}>{t("tokens.adminOnly.body")}</Callout>
      </>
    );
  }
  return <WorkspaceTokens space={space} />;
}

function WorkspaceTokens({ space }: { space: Workspace }) {
  const t = useT();
  const { api } = useDashboard();
  const list = useQuery({
    queryKey: serviceTokensQuery(space.slug),
    queryFn: () => api.serviceTokens(space.slug),
    ...refreshOptions,
  });
  const [created, setCreated] = useState<ServiceTokenCreated | null>(null);
  const available = list.data?.available ?? true;
  const full = (list.data?.items.length ?? 0) >= (list.data?.limit ?? Number.POSITIVE_INFINITY);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("tokens.title")}
        meta={<SpaceBadge owner={space} />}
        description={t("tokens.description", { workspace: space.name })}
      />
      {list.data && !available ? (
        <Callout tone="info" title={t("tokens.planTitle")} icon={<Info className="size-5" />}>
          {t("tokens.planRequired", { plan: PLAN_LABELS[lowestPlanWith("serviceTokens")] })}
        </Callout>
      ) : null}
      {created ? <SecretOnce created={created} onDone={() => setCreated(null)} /> : null}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <Section id="tokens" title={t("tokens.list.title")}>
            <Loaded query={list} loading={t("tokens.loading")} error={t("tokens.loadFailed")}>
              {(data) =>
                data.items.length === 0 ? (
                  <EmptyState
                    title={t("tokens.empty.title")}
                    icon={<KeySquare className="size-8" />}
                  >
                    <p>{t("tokens.empty.body")}</p>
                  </EmptyState>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {data.items.map((token) => (
                      <TokenCard key={token.id} space={space} token={token} />
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </Section>
        </div>
        <CreateToken
          space={space}
          disabled={!list.data || !available || full}
          full={full}
          onCreated={setCreated}
        />
      </div>
      <GitHubTrust space={space} available={available} />
    </div>
  );
}

/** The secret, shown once after creation; nothing can show it again. */
function SecretOnce({ created, onDone }: { created: ServiceTokenCreated; onDone(): void }) {
  const t = useT();
  const announce = useAnnounce();
  return (
    <Callout
      tone="info"
      title={t("tokens.secret.title")}
      icon={<KeyRound className="size-5" />}
      action={<Button onClick={onDone}>{t("tokens.secret.done")}</Button>}
    >
      <div className="flex flex-col gap-3">
        <p>{t("tokens.secret.body")}</p>
        <CopyField
          label={t("tokens.secret.label", { label: created.token.label })}
          value={created.secret}
          copyLabel={t("tokens.secret.copy")}
          copiedLabel={t("copy.copied")}
          onCopied={() => announce(t("copy.done"))}
          onCopyFailed={() => announce(t("copy.failed"))}
        />
      </div>
    </Callout>
  );
}

function CreateToken({
  space,
  disabled,
  full,
  onCreated,
}: {
  space: Workspace;
  disabled: boolean;
  full: boolean;
  onCreated(created: ServiceTokenCreated): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const scopesError = useId();
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ServiceTokenScope[]>(["artifacts:read", "artifacts:write"]);
  const [days, setDays] = useState<(typeof EXPIRY_DAYS)[number]>("90");
  const [restriction, setRestriction] = useState<Restriction>("none");
  const [prefix, setPrefix] = useState("");
  const [problems, setProblems] = useState<{ label?: boolean; scopes?: boolean; prefix?: boolean }>(
    {},
  );
  const create = useMutation({
    mutationFn: () =>
      api.createServiceToken(space.slug, {
        label: label.trim(),
        role: "editor",
        scopes,
        expiresInDays: Number(days),
        restriction:
          restriction === "key" ? { kind: "key", prefix: prefix.trim() } : { kind: restriction },
      }),
    onSuccess: async (result) => {
      setLabel("");
      setPrefix("");
      onCreated(result);
      await queryClient.invalidateQueries({ queryKey: serviceTokensQuery(space.slug) });
      announce(t("tokens.created", { label: result.token.label }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = {
      label: label.trim().length === 0 || label.trim().length > SERVICE_TOKENS.labelMaxLength,
      scopes: scopes.length === 0,
      prefix: restriction === "key" && !PublishKey.safeParse(prefix.trim()).success,
    };
    setProblems(next);
    if (next.label || next.scopes || next.prefix) return;
    create.mutate();
  };
  const toggle = (scope: ServiceTokenScope, on: boolean) => {
    setProblems((current) => ({ ...current, scopes: false }));
    setScopes((current) =>
      on
        ? SERVICE_TOKEN_SCOPES.filter((s) => s === scope || current.includes(s))
        : current.filter((s) => s !== scope),
    );
  };

  return (
    <Section id="create-token" title={t("tokens.create.title")} hint={t("tokens.create.hint")}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {full ? (
          <p className="text-sm text-text-muted">
            {t("tokens.create.limit", { limit: SERVICE_TOKENS.perWorkspace })}
          </p>
        ) : null}
        <TextInput
          label={t("tokens.create.label")}
          description={t("tokens.create.labelHint")}
          autoComplete="off"
          required
          maxLength={SERVICE_TOKENS.labelMaxLength}
          value={label}
          disabled={disabled}
          error={problems.label ? t("tokens.create.labelError") : undefined}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        <fieldset
          className="flex flex-col gap-3"
          disabled={disabled}
          aria-describedby={problems.scopes ? scopesError : undefined}
        >
          <legend className="mb-1 text-sm font-medium">{t("tokens.create.scopes")}</legend>
          {SERVICE_TOKEN_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              label={t(SCOPE_LABELS[scope])}
              description={t(SCOPE_HINTS[scope])}
              checked={scopes.includes(scope)}
              onChange={(event) => toggle(scope, event.currentTarget.checked)}
            />
          ))}
          {problems.scopes ? (
            <FieldError id={scopesError}>{t("tokens.create.scopesError")}</FieldError>
          ) : null}
        </fieldset>
        <Select
          label={t("tokens.create.expiry")}
          description={t("tokens.create.expiryHint")}
          value={days}
          disabled={disabled}
          onChange={(value) => setDays(value as (typeof EXPIRY_DAYS)[number])}
          options={EXPIRY_DAYS.map((value) => ({
            value,
            label: t("tokens.create.days", { days: Number(value) }),
          }))}
        />
        <RadioGroup<Restriction>
          legend={t("tokens.create.restriction")}
          name="token-restriction"
          value={restriction}
          disabled={disabled}
          onChange={setRestriction}
          options={(["none", "own", "key"] as const).map((value) => ({
            value,
            label: t(`tokens.restriction.${value}`),
            description: t(`tokens.restriction.${value}Hint`),
          }))}
        />
        {restriction === "key" ? (
          <TextInput
            label={t("tokens.create.prefix")}
            description={t("tokens.create.prefixHint")}
            autoComplete="off"
            spellCheck={false}
            required
            value={prefix}
            disabled={disabled}
            error={problems.prefix ? t("tokens.create.prefixError") : undefined}
            onChange={(event) => setPrefix(event.currentTarget.value)}
          />
        ) : null}
        {create.isError ? (
          <Callout
            tone="error"
            title={t("tokens.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, create.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<KeySquare className="size-4" />}
            busy={create.isPending}
            disabled={disabled}
          >
            {t("tokens.create.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function restrictionText(t: T, token: ServiceTokenView): string {
  const { restriction } = token;
  if (restriction.kind === "key") return t("tokens.reach.key", { prefix: restriction.prefix });
  return t(restriction.kind === "own" ? "tokens.reach.own" : "tokens.reach.none");
}

function TokenCard({ space, token }: { space: Workspace; token: ServiceTokenView }) {
  const t = useT();
  const announce = useAnnounce();
  const formatDate = useFormatDate();
  const relative = useRelativeTime();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.revokeServiceToken(space.slug, token.id),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: serviceTokensQuery(space.slug) });
      announce(t("tokens.revoked", { label: token.label }));
    },
    onError: () => setConfirming(false),
  });
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-base font-semibold break-words">{token.label}</h3>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge>{t(`role.${token.role}`)}</Badge>
            {token.expired ? <Badge emphasis="strong">{t("tokens.expired")}</Badge> : null}
          </div>
        </div>
        <Button
          size="sm"
          intent="danger"
          icon={<Trash2 className="size-4" />}
          aria-label={t("tokens.revokeLabel", { label: token.label })}
          disabled={revoke.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("tokens.revoke")}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text-muted">
        <li>
          {t("tokens.scopes", {
            scopes: token.scopes.map((scope) => t(SCOPE_LABELS[scope])).join(", "),
          })}
        </li>
        <li>{restrictionText(t, token)}</li>
        <li>
          <time dateTime={token.expiresAt}>
            {t(token.expired ? "tokens.expiredOn" : "tokens.expiresOn", {
              date: formatDate(token.expiresAt),
            })}
          </time>
        </li>
        <li>
          {token.lastUsedAt ? (
            <time dateTime={token.lastUsedAt}>
              {t("tokens.lastUsed", { when: relative(token.lastUsedAt) })}
            </time>
          ) : (
            t("tokens.neverUsed")
          )}
        </li>
        <li>
          {token.createdBy
            ? t("tokens.createdBy", {
                name: token.createdBy.name,
                date: formatDate(token.createdAt),
              })
            : t("tokens.createdOn", { date: formatDate(token.createdAt) })}
        </li>
      </ul>
      {revoke.isError ? (
        <Callout
          tone="error"
          title={t("tokens.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, revoke.error)}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("tokens.confirm.title", { label: token.label })}
        confirmLabel={t("tokens.revoke")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("tokens.confirm.body")}
      </ConfirmDialog>
    </li>
  );
}
