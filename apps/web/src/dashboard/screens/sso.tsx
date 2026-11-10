// The Single sign-on section of a workspace's Members page, for its admins (premium plan E1,
// decision 0016): the redirect URI to register at the identity provider, the issuer, client and
// the verified domains it signs in, a check of the issuer's discovery in plain words, the state
// and removal with confirmation. Hidden while the Worker has single sign-on switched off (the
// settings answer `capacity_unavailable`). The API decides every rule; this explains them.
import {
  lowestPlanWith,
  PLAN_LABELS,
  type SsoDiscoveryProblem,
  type SsoSettings,
  type SsoState,
  type SsoTestResult,
} from "@portifact/contracts";
import { Badge, Button, Callout, Checkbox, ConfirmDialog, CopyField, Panel } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, KeyRound, Save, SearchCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import type { Space } from "../space.tsx";
import { errorMessage } from "./artifact-list.tsx";

type T = ReturnType<typeof useT>;
type WorkspaceSpace = Extract<Space, { kind: "workspace" }>;

export const ssoQuery = (slug: string) => ["workspace", slug, "sso"] as const;

const STATE_LABELS: Record<SsoState, MessageId> = {
  off: "sso.state.off",
  on: "sso.state.on",
  plan: "sso.state.plan",
  domains: "sso.state.domains",
};

const PROBLEMS: Record<SsoDiscoveryProblem, MessageId> = {
  invalid_issuer: "sso.problem.invalid_issuer",
  unreachable: "sso.problem.unreachable",
  timeout: "sso.problem.timeout",
  redirect: "sso.problem.redirect",
  http_error: "sso.problem.http_error",
  too_large: "sso.problem.too_large",
  not_json: "sso.problem.not_json",
  issuer_mismatch: "sso.problem.issuer_mismatch",
  missing_endpoint: "sso.problem.missing_endpoint",
  invalid_endpoint: "sso.problem.invalid_endpoint",
  no_code_flow: "sso.problem.no_code_flow",
  no_pkce: "sso.problem.no_pkce",
  no_signing_algorithm: "sso.problem.no_signing_algorithm",
};

const ERRORS: Partial<Record<string, MessageId>> = {
  forbidden: "members.error.forbidden",
  invalid_input: "sso.error.invalid_input",
  capacity_unavailable: "sso.error.capacity_unavailable",
  version_conflict: "sso.error.version_conflict",
  not_found: "sso.error.not_found",
};

function explain(t: T, error: unknown): string {
  if (error instanceof ApiFailure) {
    const own = ERRORS[error.code];
    if (own) return t(own);
  }
  return errorMessage(t, error);
}

export function SsoPanel({ space }: { space: WorkspaceSpace }) {
  const t = useT();
  const { api } = useDashboard();
  const settings = useQuery({
    queryKey: ssoQuery(space.slug),
    queryFn: () => api.sso(space.slug),
    retry: false,
    ...refreshOptions,
  });
  // Switched off on this deployment: nothing to show.
  if (settings.error instanceof ApiFailure && settings.error.code === "capacity_unavailable") {
    return null;
  }
  if (!settings.data) {
    return settings.isError ? (
      <Panel id="sso" title={t("sso.title")}>
        <Callout tone="error" title={t("sso.loadFailed")} icon={<CircleAlert className="size-5" />}>
          {errorMessage(t, settings.error)}
        </Callout>
      </Panel>
    ) : null;
  }
  return (
    <Panel id="sso" title={t("sso.title")} description={t("sso.description")}>
      <SsoBody space={space} settings={settings.data} />
    </Panel>
  );
}

function SsoBody({ space, settings }: { space: WorkspaceSpace; settings: SsoSettings }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [removing, setRemoving] = useState(false);
  const [checked, setChecked] = useState<SsoTestResult | null>(null);
  const provider = settings.provider;
  const editable = settings.available;
  const copy = {
    copyLabel: t("domains.records.copy"),
    copiedLabel: t("copy.copied"),
    onCopied: () => announce(t("copy.done")),
    onCopyFailed: () => announce(t("copy.failed")),
  };
  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.saveSso>[1]) => api.saveSso(space.slug, input),
    onSuccess: (next) => {
      queryClient.setQueryData(ssoQuery(space.slug), next);
      announce(t("sso.saved"));
    },
  });
  const test = useMutation({
    mutationFn: (issuer: string) => api.testSso(space.slug, issuer),
    onSuccess: (result) => {
      setChecked(result);
      announce(result.ok ? t("sso.testOkShort") : t(PROBLEMS[result.problem]));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeSso(space.slug),
    onSuccess: async () => {
      setRemoving(false);
      await queryClient.invalidateQueries({ queryKey: ssoQuery(space.slug) });
      announce(t("sso.removed"));
    },
    onError: () => setRemoving(false),
  });
  const form = useAppForm({
    defaultValues: {
      issuer: provider?.issuer ?? "",
      clientId: provider?.clientId ?? "",
      clientSecret: "",
      domains: provider?.domains ?? [],
    },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const fields: Record<string, string> = {};
        if (value.issuer.trim() === "") fields.issuer = t("sso.issuerRequired");
        if (value.clientId.trim() === "") fields.clientId = t("sso.clientIdRequired");
        if (!provider && value.clientSecret === "") fields.clientSecret = t("sso.secretRequired");
        if (value.domains.length === 0) fields.domains = t("sso.domainsRequired");
        return Object.keys(fields).length > 0 ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await save.mutateAsync({
          issuer: value.issuer.trim(),
          clientId: value.clientId.trim(),
          ...(value.clientSecret === "" ? {} : { clientSecret: value.clientSecret }),
          domains: value.domains,
        });
        formApi.setFieldValue("clientSecret", "");
      } catch {
        // The callout below explains it.
      }
    },
  });
  const failure = save.error ?? remove.error ?? test.error;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t("sso.stateLabel")}</span>
        <Badge
          icon={
            settings.state === "on" ? (
              <CircleCheck className="size-3.5" />
            ) : (
              <CircleAlert className="size-3.5" />
            )
          }
          emphasis={settings.state === "on" ? undefined : "subtle"}
        >
          {t(STATE_LABELS[settings.state])}
        </Badge>
      </div>
      {!settings.available ? (
        <Callout title={t("sso.planTitle")} icon={<CircleAlert className="size-5" />}>
          {t("sso.plan", { plan: PLAN_LABELS[lowestPlanWith("sso")] })}
        </Callout>
      ) : null}
      {provider && provider.lapsedDomains.length > 0 ? (
        <Callout title={t("sso.lapsedTitle")} icon={<CircleAlert className="size-5" />}>
          {t("sso.lapsed", { domains: provider.lapsedDomains.join(", ") })}
        </Callout>
      ) : null}
      <p className="text-sm text-text-muted">{t("sso.membership")}</p>
      {provider ? (
        <CopyField label={t("sso.redirectUri")} value={provider.redirectUri} {...copy} />
      ) : (
        <p className="text-sm text-text-muted">
          {t("sso.redirectPending", { pattern: settings.redirectUriPattern })}
        </p>
      )}
      {failure ? (
        <Callout tone="error" title={t("sso.saveFailed")} icon={<CircleAlert className="size-5" />}>
          {explain(t, failure)}
        </Callout>
      ) : null}
      {checked ? (
        checked.ok ? (
          <Callout title={t("sso.testOkTitle")} icon={<CircleCheck className="size-5" />}>
            {t("sso.testOk", checked.hosts)}
          </Callout>
        ) : (
          <Callout
            tone="error"
            title={t("sso.testFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {t(PROBLEMS[checked.problem])}
          </Callout>
        )
      ) : null}
      <form.AppForm>
        <form.Form label={t("sso.formLabel")}>
          <div className="flex max-w-3xl flex-col gap-4">
            <form.AppField name="issuer">
              {(field) => (
                <field.TextField
                  label={t("sso.issuer")}
                  description={t("sso.issuerHint")}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  readOnly={provider !== null}
                  disabled={!editable}
                />
              )}
            </form.AppField>
            <form.AppField name="clientId">
              {(field) => (
                <field.TextField
                  label={t("sso.clientId")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!editable}
                />
              )}
            </form.AppField>
            <form.AppField name="clientSecret">
              {(field) => (
                <field.TextField
                  label={t("sso.clientSecret")}
                  description={provider ? t("sso.secretKeep") : t("sso.secretHint")}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={!editable}
                />
              )}
            </form.AppField>
            <form.Field name="domains">
              {(field) => (
                <fieldset className="flex flex-col gap-2" aria-describedby="sso-domains-hint">
                  <legend className="text-sm font-medium">{t("sso.domains")}</legend>
                  <p id="sso-domains-hint" className="text-sm text-text-muted">
                    {settings.verifiedDomains.length > 0
                      ? t("sso.domainsHint")
                      : t("sso.noDomains")}
                  </p>
                  {settings.verifiedDomains.map((domain) => (
                    <Checkbox
                      key={domain}
                      label={domain}
                      checked={field.state.value.includes(domain)}
                      disabled={!editable}
                      onChange={(event) =>
                        field.handleChange(
                          event.currentTarget.checked
                            ? [...field.state.value, domain]
                            : field.state.value.filter((d) => d !== domain),
                        )
                      }
                    />
                  ))}
                  {field.state.meta.errors.length > 0 ? (
                    <p role="alert" className="border-l-2 border-text pl-2 text-sm font-semibold">
                      {String(field.state.meta.errors[0])}
                    </p>
                  ) : null}
                </fieldset>
              )}
            </form.Field>
            <div className="flex flex-wrap gap-2">
              <form.SubmitButton
                intent="primary"
                icon={<Save className="size-4" />}
                busy={save.isPending}
                disabled={!editable}
              >
                {provider ? t("sso.saveChanges") : t("sso.save")}
              </form.SubmitButton>
              <form.Subscribe selector={(state) => state.values.issuer}>
                {(issuer) => (
                  <Button
                    icon={<SearchCheck className="size-4" />}
                    busy={test.isPending}
                    disabled={!editable || issuer.trim() === ""}
                    onClick={() => test.mutate(issuer.trim())}
                  >
                    {t("sso.test")}
                  </Button>
                )}
              </form.Subscribe>
              {provider ? (
                <Button
                  intent="ghost"
                  icon={<Trash2 className="size-4" />}
                  onClick={() => setRemoving(true)}
                >
                  {t("sso.remove")}
                </Button>
              ) : null}
            </div>
          </div>
        </form.Form>
      </form.AppForm>
      <p className="flex items-center gap-2 text-sm text-text-muted">
        <KeyRound aria-hidden="true" className="size-4 shrink-0" />
        {t("sso.scim")}
      </p>
      <ConfirmDialog
        open={removing}
        title={t("sso.confirmRemove.title")}
        confirmLabel={t("sso.confirmRemove.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setRemoving(false)}
      >
        {t("sso.confirmRemove.body")}
      </ConfirmDialog>
    </div>
  );
}
