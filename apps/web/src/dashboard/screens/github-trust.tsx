// The GitHub Actions section of a workspace's Service tokens page (decision 0024): admins trust a
// GitHub repository by its numeric IDs so its workflows exchange GitHub's ID token for a
// short-lived credential instead of a stored token. It lists the trusted repositories, adds one
// (events with what each means for forks, an optional ref and environment, the scopes) and
// removes one after a confirmation. The API decides every write again; switched off on the
// deployment, only the list and removing are offered.
import {
  GITHUB_DEFAULT_EVENTS,
  GITHUB_PRIVILEGED_EVENTS,
  GITHUB_TRUST,
  GITHUB_TRUST_EVENTS,
  GITHUB_TRUST_SCOPES,
  GitHubNumericId,
  GitHubRepo,
  type GitHubTrustEvent,
  type GitHubTrustRuleView,
  type GitHubTrustScope,
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
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, GitBranch, Info, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import type { Space } from "../space.tsx";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";

export const githubTrustQuery = (slug: string) => ["workspace", slug, "github-trust"] as const;

type Workspace = Extract<Space, { kind: "workspace" }>;

const SCOPE_LABELS: Record<GitHubTrustScope, MessageId> = {
  "artifacts:read": "tokens.scope.read",
  "artifacts:write": "tokens.scope.write",
  "artifacts:delete": "tokens.scope.delete",
};

const EVENT_HINTS: Record<GitHubTrustEvent, MessageId> = {
  push: "github.event.pushHint",
  pull_request: "github.event.pull_requestHint",
  workflow_dispatch: "github.event.workflow_dispatchHint",
  merge_group: "github.event.merge_groupHint",
  release: "github.event.releaseHint",
  schedule: "github.event.scheduleHint",
  pull_request_target: "github.event.pull_request_targetHint",
  workflow_run: "github.event.workflow_runHint",
};

export function GitHubTrust({ space, available }: { space: Workspace; available: boolean }) {
  const t = useT();
  const { api } = useDashboard();
  const list = useQuery({
    queryKey: githubTrustQuery(space.slug),
    queryFn: () => api.githubTrust(space.slug),
    ...refreshOptions,
  });
  const enabled = list.data?.enabled ?? false;
  const full = (list.data?.items.length ?? 0) >= (list.data?.limit ?? Number.POSITIVE_INFINITY);
  return (
    <Section id="github-actions" title={t("github.title")} hint={t("github.hint")}>
      <div className="flex flex-col gap-6">
        {list.data && !enabled ? (
          <Callout tone="info" title={t("github.title")} icon={<Info className="size-5" />}>
            {t("github.off")}
          </Callout>
        ) : null}
        {list.data && enabled ? <CopyAudience audience={list.data.audience} /> : null}
        <div className="grid items-start gap-6 xl:grid-cols-3">
          <div className="min-w-0 xl:col-span-2">
            <Loaded query={list} loading={t("github.loading")} error={t("github.loadFailed")}>
              {(data) =>
                data.items.length === 0 ? (
                  <EmptyState
                    title={t("github.empty.title")}
                    icon={<GitBranch className="size-8" />}
                  >
                    <p>{t("github.empty.body")}</p>
                  </EmptyState>
                ) : (
                  <ul className="flex flex-col gap-4" aria-label={t("github.title")}>
                    {data.items.map((rule) => (
                      <RuleCard key={rule.id} space={space} rule={rule} />
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </div>
          {enabled ? (
            <TrustRepository space={space} disabled={!available || full} full={full} />
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function CopyAudience({ audience }: { audience: string }) {
  const t = useT();
  const announce = useAnnounce();
  return (
    <div className="flex flex-col gap-2">
      <CopyField
        label={t("github.audience")}
        value={audience}
        copyLabel={t("tokens.secret.copy")}
        copiedLabel={t("copy.copied")}
        onCopied={() => announce(t("copy.done"))}
        onCopyFailed={() => announce(t("copy.failed"))}
      />
      <p className="text-sm text-text-muted">{t("github.audienceHint")}</p>
    </div>
  );
}

interface Problems {
  repository?: boolean;
  repositoryId?: boolean;
  repositoryOwnerId?: boolean;
  events?: boolean;
  privileged?: boolean;
  ref?: boolean;
  scopes?: boolean;
}

function TrustRepository({
  space,
  disabled,
  full,
}: {
  space: Workspace;
  disabled: boolean;
  full: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const eventsError = useId();
  const scopesError = useId();
  const privilegedError = useId();
  const [repository, setRepository] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [repositoryOwnerId, setRepositoryOwnerId] = useState("");
  const [events, setEvents] = useState<GitHubTrustEvent[]>(() =>
    GITHUB_TRUST_EVENTS.filter((event) => GITHUB_DEFAULT_EVENTS.includes(event)),
  );
  const [privilegedConfirmed, setPrivilegedConfirmed] = useState(false);
  const [ref, setRef] = useState("");
  const [environment, setEnvironment] = useState("");
  const [scopes, setScopes] = useState<GitHubTrustScope[]>(["artifacts:read", "artifacts:write"]);
  const [problems, setProblems] = useState<Problems>({});
  const privileged = events.some((event) => GITHUB_PRIVILEGED_EVENTS.includes(event));
  const create = useMutation({
    mutationFn: () =>
      api.createGitHubTrust(space.slug, {
        repository: repository.trim(),
        repositoryId: repositoryId.trim(),
        repositoryOwnerId: repositoryOwnerId.trim(),
        events,
        ref: ref.trim() === "" ? null : ref.trim(),
        environment: environment.trim() === "" ? null : environment.trim(),
        scopes,
        privilegedConfirmed: privileged && privilegedConfirmed,
      }),
    onSuccess: async (rule) => {
      setRepository("");
      setRepositoryId("");
      setRepositoryOwnerId("");
      setRef("");
      setEnvironment("");
      setPrivilegedConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: githubTrustQuery(space.slug) });
      announce(t("github.created", { repository: rule.repository }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Problems = {
      repository: !GitHubRepo.safeParse(repository.trim()).success,
      repositoryId: !GitHubNumericId.safeParse(repositoryId.trim()).success,
      repositoryOwnerId: !GitHubNumericId.safeParse(repositoryOwnerId.trim()).success,
      events: events.length === 0,
      privileged: privileged && !privilegedConfirmed,
      ref: ref.trim() !== "" && !/^refs\/\S+$/.test(ref.trim()),
      scopes: scopes.length === 0,
    };
    setProblems(next);
    if (Object.values(next).some(Boolean)) return;
    create.mutate();
  };
  const toggle = <V extends string>(catalog: readonly V[], current: V[], value: V, on: boolean) =>
    on
      ? catalog.filter((v) => v === value || current.includes(v))
      : current.filter((v) => v !== value);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={submit}
      noValidate
      aria-labelledby="github-trust-title"
    >
      <div>
        <h3 id="github-trust-title" className="text-base font-semibold">
          {t("github.create.title")}
        </h3>
        <p className="mt-1 text-sm text-text-muted">{t("github.create.hint")}</p>
      </div>
      {full ? (
        <p className="text-sm text-text-muted">
          {t("github.create.limit", { limit: GITHUB_TRUST.perWorkspace })}
        </p>
      ) : null}
      <TextInput
        label={t("github.create.repository")}
        description={t("github.create.repositoryHint")}
        autoComplete="off"
        spellCheck={false}
        required
        value={repository}
        disabled={disabled}
        error={problems.repository ? t("github.create.repositoryError") : undefined}
        onChange={(event) => setRepository(event.currentTarget.value)}
      />
      <TextInput
        label={t("github.create.repositoryId")}
        description={t("github.create.idsHint")}
        inputMode="numeric"
        autoComplete="off"
        required
        value={repositoryId}
        disabled={disabled}
        error={problems.repositoryId ? t("github.create.idError") : undefined}
        onChange={(event) => setRepositoryId(event.currentTarget.value)}
      />
      <TextInput
        label={t("github.create.ownerId")}
        inputMode="numeric"
        autoComplete="off"
        required
        value={repositoryOwnerId}
        disabled={disabled}
        error={problems.repositoryOwnerId ? t("github.create.idError") : undefined}
        onChange={(event) => setRepositoryOwnerId(event.currentTarget.value)}
      />
      <fieldset
        className="flex flex-col gap-3"
        disabled={disabled}
        aria-describedby={problems.events ? eventsError : undefined}
      >
        <legend className="mb-1 text-sm font-medium">{t("github.create.events")}</legend>
        {GITHUB_TRUST_EVENTS.map((event) => (
          <Checkbox
            key={event}
            label={event}
            description={t(EVENT_HINTS[event])}
            checked={events.includes(event)}
            onChange={(change) => {
              const on = change.currentTarget.checked;
              setProblems((current) => ({ ...current, events: false }));
              setEvents((current) => toggle(GITHUB_TRUST_EVENTS, current, event, on));
            }}
          />
        ))}
        {problems.events ? (
          <FieldError id={eventsError}>{t("github.create.eventsError")}</FieldError>
        ) : null}
      </fieldset>
      {privileged ? (
        <Callout
          tone="error"
          title={t("github.create.privilegedError")}
          icon={<CircleAlert className="size-5" />}
          live={false}
        >
          <Checkbox
            label={t("github.create.privileged")}
            checked={privilegedConfirmed}
            disabled={disabled}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setProblems((current) => ({ ...current, privileged: false }));
              setPrivilegedConfirmed(on);
            }}
          />
          {problems.privileged ? (
            <FieldError id={privilegedError}>{t("github.create.privilegedError")}</FieldError>
          ) : null}
        </Callout>
      ) : null}
      <TextInput
        label={t("github.create.ref")}
        description={t("github.create.refHint")}
        autoComplete="off"
        spellCheck={false}
        maxLength={GITHUB_TRUST.refMaxLength}
        value={ref}
        disabled={disabled}
        error={problems.ref ? t("github.create.refError") : undefined}
        onChange={(event) => setRef(event.currentTarget.value)}
      />
      <TextInput
        label={t("github.create.environment")}
        description={t("github.create.environmentHint")}
        autoComplete="off"
        spellCheck={false}
        maxLength={GITHUB_TRUST.environmentMaxLength}
        value={environment}
        disabled={disabled}
        onChange={(event) => setEnvironment(event.currentTarget.value)}
      />
      <fieldset
        className="flex flex-col gap-3"
        disabled={disabled}
        aria-describedby={problems.scopes ? scopesError : undefined}
      >
        <legend className="mb-1 text-sm font-medium">{t("github.create.scopes")}</legend>
        {GITHUB_TRUST_SCOPES.map((scope) => (
          <Checkbox
            key={scope}
            label={t(SCOPE_LABELS[scope])}
            checked={scopes.includes(scope)}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              setProblems((current) => ({ ...current, scopes: false }));
              setScopes((current) => toggle(GITHUB_TRUST_SCOPES, current, scope, on));
            }}
          />
        ))}
        {problems.scopes ? (
          <FieldError id={scopesError}>{t("github.create.scopesError")}</FieldError>
        ) : null}
      </fieldset>
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
          icon={<ShieldCheck className="size-4" />}
          busy={create.isPending}
          disabled={disabled}
        >
          {t("github.create.submit")}
        </Button>
      </div>
    </form>
  );
}

function RuleCard({ space, rule }: { space: Workspace; rule: GitHubTrustRuleView }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.removeGitHubTrust(space.slug, rule.id),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: githubTrustQuery(space.slug) });
      announce(t("github.removed", { repository: rule.repository }));
    },
    onError: () => setConfirming(false),
  });
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-base font-semibold break-words">{rule.repository}</h3>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge>{t("github.rule.live", { count: rule.liveCredentials })}</Badge>
          </div>
        </div>
        <Button
          size="sm"
          intent="danger"
          icon={<Trash2 className="size-4" />}
          aria-label={t("github.removeLabel", { repository: rule.repository })}
          disabled={remove.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("github.remove")}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text-muted">
        <li>
          {t("github.rule.ids", {
            repositoryId: rule.repositoryId,
            ownerId: rule.repositoryOwnerId,
          })}
        </li>
        <li>{t("github.rule.events", { events: rule.events.join(", ") })}</li>
        <li>
          {t("tokens.scopes", {
            scopes: rule.scopes.map((scope) => t(SCOPE_LABELS[scope])).join(", "),
          })}
        </li>
        <li>{t("github.rule.prefix", { prefix: rule.keyPrefix })}</li>
        {rule.ref ? <li>{t("github.rule.ref", { ref: rule.ref })}</li> : null}
        {rule.environment ? (
          <li>{t("github.rule.environment", { environment: rule.environment })}</li>
        ) : null}
      </ul>
      {remove.isError ? (
        <Callout
          tone="error"
          title={t("tokens.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, remove.error)}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("github.confirm.title", { repository: rule.repository })}
        confirmLabel={t("github.remove")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("github.confirm.body")}
      </ConfirmDialog>
    </li>
  );
}
