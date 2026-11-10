// The Directory sync (SCIM) section of a workspace's Members page, for its admins (premium plan
// E2, decision 0017): the base URL to paste into the identity provider, the tokens (created with
// the secret shown once, revoked after confirmation), whether provisioned people get the
// invitation email, the last sync and how many provisioned people wait to sign in (they are
// listed with the pending invitations). Hidden while the Worker has SCIM switched off (the
// settings answer `capacity_unavailable`). The API decides every rule; this explains them.
import {
  lowestPlanWith,
  PLAN_LABELS,
  SCIM,
  type ScimOverview,
  type ScimTokenCreated,
  type ScimTokenView,
} from "@portifact/contracts";
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  CopyField,
  Panel,
  Select,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, KeySquare, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import type { Space } from "../space.tsx";
import { errorMessage } from "./artifact-list.tsx";

type WorkspaceSpace = Extract<Space, { kind: "workspace" }>;

export const scimQuery = (slug: string) => ["workspace", slug, "scim"] as const;

const EXPIRY_DAYS = ["30", "90", "180", "365"] as const;

export function ScimPanel({ space }: { space: WorkspaceSpace }) {
  const t = useT();
  const { api } = useDashboard();
  const overview = useQuery({
    queryKey: scimQuery(space.slug),
    queryFn: () => api.scim(space.slug),
    retry: false,
    ...refreshOptions,
  });
  // Switched off on this deployment: nothing to show.
  if (overview.error instanceof ApiFailure && overview.error.code === "capacity_unavailable") {
    return null;
  }
  if (!overview.data) {
    return overview.isError ? (
      <Panel id="scim" title={t("scim.title")}>
        <Callout
          tone="error"
          title={t("scim.loadFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, overview.error)}
        </Callout>
      </Panel>
    ) : null;
  }
  return (
    <Panel id="scim" title={t("scim.title")} description={t("scim.description")}>
      <ScimBody space={space} overview={overview.data} />
    </Panel>
  );
}

function ScimBody({ space, overview }: { space: WorkspaceSpace; overview: ScimOverview }) {
  const t = useT();
  const announce = useAnnounce();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);
  const copy = {
    copiedLabel: t("copy.copied"),
    onCopied: () => announce(t("copy.done")),
    onCopyFailed: () => announce(t("copy.failed")),
  };
  const emails = useMutation({
    mutationFn: (on: boolean) => api.saveScim(space.slug, { invitationEmails: on }),
    onSuccess: (next) => {
      queryClient.setQueryData(scimQuery(space.slug), next);
      announce(t("scim.emailsSaved"));
    },
  });
  return (
    <div className="flex flex-col gap-4">
      {!overview.available ? (
        <Callout title={t("scim.planTitle")} icon={<CircleAlert className="size-5" />}>
          {t("scim.plan", { plan: PLAN_LABELS[lowestPlanWith("scim")] })}
        </Callout>
      ) : null}
      <CopyField
        label={t("scim.baseUrl")}
        value={overview.baseUrl}
        copyLabel={t("scim.baseUrlCopy")}
        {...copy}
      />
      <p className="text-sm text-text-muted">{t("scim.baseUrlHint")}</p>
      <p className="text-sm text-text-muted">{t("scim.rules")}</p>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t("scim.lastSync")}</dt>
          <dd>
            {overview.lastSyncAt === null
              ? t("scim.lastSyncNever")
              : formatDate(overview.lastSyncAt)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t("scim.pendingLabel")}</dt>
          <dd>{t("scim.pending", { count: overview.pending })}</dd>
        </div>
      </dl>
      {created ? (
        <Callout
          tone="info"
          title={t("scim.secret.title")}
          icon={<KeyRound className="size-5" />}
          action={<Button onClick={() => setCreated(null)}>{t("scim.secret.done")}</Button>}
        >
          <div className="flex flex-col gap-3">
            <p>{t("scim.secret.body")}</p>
            <CopyField
              label={t("scim.secret.label", { label: created.token.label })}
              value={created.secret}
              copyLabel={t("scim.secret.copy")}
              {...copy}
            />
          </div>
        </Callout>
      ) : null}
      <TokenList space={space} tokens={overview.tokens} />
      <CreateScimToken
        space={space}
        disabled={!overview.available || overview.tokens.length >= overview.limit}
        full={overview.tokens.length >= overview.limit}
        onCreated={setCreated}
      />
      <Checkbox
        label={t("scim.emails")}
        description={t("scim.emailsHint")}
        checked={overview.invitationEmails}
        disabled={emails.isPending}
        onChange={(event) => emails.mutate(event.currentTarget.checked)}
      />
      {emails.isError ? (
        <Callout
          tone="error"
          title={t("scim.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, emails.error)}
        </Callout>
      ) : null}
    </div>
  );
}

function TokenList({ space, tokens }: { space: WorkspaceSpace; tokens: ScimTokenView[] }) {
  const t = useT();
  const announce = useAnnounce();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [revoking, setRevoking] = useState<ScimTokenView | null>(null);
  const revoke = useMutation({
    mutationFn: (token: ScimTokenView) => api.revokeScimToken(space.slug, token.id),
    onSuccess: async (_, token) => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: scimQuery(space.slug) });
      announce(t("scim.revoked", { label: token.label }));
    },
    onError: () => setRevoking(null),
  });
  return (
    <section aria-labelledby="scim-tokens" className="flex flex-col gap-2">
      <h3 id="scim-tokens" className="text-sm font-medium">
        {t("scim.tokens")}
      </h3>
      {revoke.isError ? (
        <Callout
          tone="error"
          title={t("scim.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, revoke.error)}
        </Callout>
      ) : null}
      {tokens.length === 0 ? (
        <p className="text-sm text-text-muted">{t("scim.tokensEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium break-all">{token.label}</span>
                <span className="text-xs text-text-muted">
                  {t(token.expired ? "scim.tokenExpired" : "scim.tokenExpires", {
                    date: formatDate(token.expiresAt),
                  })}
                  {" · "}
                  {token.lastUsedAt === null
                    ? t("scim.tokenUnused")
                    : t("scim.tokenUsed", { date: formatDate(token.lastUsedAt) })}
                </span>
              </div>
              <Button
                intent="ghost"
                size="sm"
                icon={<Trash2 className="size-4" />}
                aria-label={t("scim.revokeNamed", { label: token.label })}
                busy={revoke.isPending && revoke.variables?.id === token.id}
                onClick={() => setRevoking(token)}
              >
                {t("scim.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={t("scim.confirmRevoke.title", { label: revoking?.label ?? "" })}
        confirmLabel={t("scim.confirmRevoke.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => (revoking ? revoke.mutate(revoking) : undefined)}
        onCancel={() => setRevoking(null)}
      >
        {t("scim.confirmRevoke.body")}
      </ConfirmDialog>
    </section>
  );
}

function CreateScimToken({
  space,
  disabled,
  full,
  onCreated,
}: {
  space: WorkspaceSpace;
  disabled: boolean;
  full: boolean;
  onCreated(created: ScimTokenCreated): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<(typeof EXPIRY_DAYS)[number]>("365");
  const [labelError, setLabelError] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.createScimToken(space.slug, { label: label.trim(), expiresInDays: Number(days) }),
    onSuccess: async (result) => {
      setLabel("");
      onCreated(result);
      await queryClient.invalidateQueries({ queryKey: scimQuery(space.slug) });
      announce(t("scim.created", { label: result.token.label }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const bad = label.trim().length === 0 || label.trim().length > SCIM.labelMaxLength;
    setLabelError(bad);
    if (!bad) create.mutate();
  };
  return (
    <form
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={submit}
      noValidate
      aria-label={t("scim.create")}
    >
      {full ? (
        <p className="text-sm text-text-muted">
          {t("scim.limit", { count: SCIM.tokensPerWorkspace })}
        </p>
      ) : null}
      <TextInput
        label={t("scim.label")}
        description={t("scim.labelHint")}
        autoComplete="off"
        required
        maxLength={SCIM.labelMaxLength}
        value={label}
        disabled={disabled}
        error={labelError ? t("scim.labelRequired") : undefined}
        onChange={(event) => setLabel(event.currentTarget.value)}
      />
      <Select
        label={t("scim.expiry")}
        value={days}
        disabled={disabled}
        onChange={(value) => setDays(value as (typeof EXPIRY_DAYS)[number])}
        options={EXPIRY_DAYS.map((value) => ({
          value,
          label: t("scim.days", { count: Number(value) }),
        }))}
      />
      {create.isError ? (
        <Callout
          tone="error"
          title={t("scim.actionFailed")}
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
          {t("scim.create")}
        </Button>
      </div>
    </form>
  );
}
