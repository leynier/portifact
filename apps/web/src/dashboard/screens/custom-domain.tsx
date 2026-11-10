// The "Custom domain" group of the artifact's sharing settings (premium plan P7, decision 0006):
// add a hostname, the two DNS records to create with copy buttons, the domain's state and what
// the last check found, "Check again", and removal after a confirmation. While the Portifact bar
// is on, visits to the domain still open in the viewer, so the group says so and offers to turn
// the bar off; it never changes the bar by itself. Owners whose plan does not include custom
// domains get an explanation and no form. The API applies every rule.
import type {
  AccessPolicyView,
  ArtifactSummary,
  CustomDomainList,
  CustomDomainView,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CopyField,
  LoadingState,
  Panel,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Globe, Info, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { accessQuery } from "./access-settings.tsx";
import { errorMessage } from "./artifact-list.tsx";

export const domainQuery = (artifactId: string) => ["artifact", artifactId, "domain"] as const;

const STATE_LABELS: Record<CustomDomainView["state"], MessageId> = {
  pending: "domains.state.pending",
  provisioning: "domains.state.provisioning",
  active: "domains.state.active",
  removing: "domains.state.removing",
};

const PROBLEMS: Record<NonNullable<CustomDomainView["problem"]>, MessageId> = {
  txt_missing: "domains.problem.txt_missing",
  certificate_pending: "domains.problem.certificate_pending",
  cloudflare_unavailable: "domains.problem.cloudflare_unavailable",
  cname_elsewhere: "domains.problem.cname_elsewhere",
};

export function CustomDomainPanel({
  artifact,
  policy,
  disabled,
}: {
  artifact: ArtifactSummary;
  policy: AccessPolicyView;
  disabled: boolean;
}) {
  const t = useT();
  const { api } = useDashboard();
  const domains = useQuery({
    queryKey: domainQuery(artifact.id),
    queryFn: () => api.artifactDomains(artifact.id),
  });

  let body: React.ReactNode;
  if (domains.isPending) body = <LoadingState label={t("domains.loading")} />;
  else if (domains.isError && !domains.data) {
    body = (
      <Callout
        tone="error"
        title={t("domains.loadFailed")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => domains.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, domains.error)}
      </Callout>
    );
  } else {
    body = (
      <DomainBody artifact={artifact} policy={policy} list={domains.data} disabled={disabled} />
    );
  }
  return (
    <Panel headingLevel={3} title={t("domains.title")} description={t("domains.description")}>
      {body}
    </Panel>
  );
}

function DomainBody({
  artifact,
  policy,
  list,
  disabled,
}: {
  artifact: ArtifactSummary;
  policy: AccessPolicyView;
  list: CustomDomainList;
  disabled: boolean;
}) {
  const t = useT();
  const current = list.domains.find((domain) => domain.state !== "removing") ?? null;
  const removing = list.domains.find((domain) => domain.state === "removing") ?? null;
  return (
    <div className="flex flex-col gap-4">
      {list.enabled ? null : (
        <Callout title={t("domains.paidTitle")} icon={<Info className="size-5" />}>
          {t("domains.paid")}
        </Callout>
      )}
      {list.enabled && !list.available ? (
        <Callout title={t("domains.unavailableTitle")} icon={<Info className="size-5" />}>
          {t("domains.unavailable")}
        </Callout>
      ) : null}
      {current ? (
        <DomainCard
          artifactId={artifact.id}
          domain={current}
          canCheck={list.enabled && list.available}
          disabled={disabled}
        />
      ) : removing ? (
        <p className="text-sm text-text-muted">
          {t("domains.removingNote", { hostname: removing.hostname })}
        </p>
      ) : null}
      {current && policy.bar ? <BarNote artifactId={artifact.id} disabled={disabled} /> : null}
      {!current && list.enabled && list.available ? (
        <AddDomainForm
          artifactId={artifact.id}
          disabled={disabled || list.used >= list.limit}
          full={list.used >= list.limit}
          limit={list.limit}
        />
      ) : null}
    </div>
  );
}

/** The domain's state, what to do next, the records to create and its actions. */
function DomainCard({
  artifactId,
  domain,
  canCheck,
  disabled,
}: {
  artifactId: string;
  domain: CustomDomainView;
  canCheck: boolean;
  disabled: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: domainQuery(artifactId) });
  const verify = useMutation({
    mutationFn: () => api.verifyDomain(domain.hostname),
    // The check's answer is the freshest view of this domain, with what it found (a pending
    // claim's missing record is not stored), so it replaces the listed one without a refetch.
    onSuccess: (view) => {
      announce(t(STATE_LABELS[view.state]));
      queryClient.setQueryData<CustomDomainList>(domainQuery(artifactId), (old) =>
        old
          ? { ...old, domains: old.domains.map((d) => (d.hostname === view.hostname ? view : d)) }
          : old,
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeDomain(domain.hostname),
    onSuccess: async () => {
      setConfirming(false);
      announce(t("domains.removed", { hostname: domain.hostname }));
      await refresh();
    },
  });
  const showRecords =
    domain.state === "pending" ||
    domain.state === "provisioning" ||
    domain.problem === "txt_missing" ||
    domain.problem === "cname_elsewhere";
  const [txt, cname] = domain.records;

  return (
    <section
      aria-label={t("domains.cardLabel", { hostname: domain.hostname })}
      className="flex flex-col gap-4 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Globe aria-hidden="true" className="size-5 shrink-0" />
        <p className="min-w-0 flex-1 text-base font-medium break-all">{domain.hostname}</p>
        <Badge emphasis={domain.state === "active" ? "normal" : "quiet"}>
          {t(STATE_LABELS[domain.state])}
        </Badge>
      </div>
      <p className="text-sm">{t(`domains.next.${domain.state}` as MessageId)}</p>
      {domain.problem ? (
        <Callout
          tone={
            domain.problem === "txt_missing" || domain.problem === "cname_elsewhere"
              ? "error"
              : "info"
          }
          title={t(PROBLEMS[domain.problem])}
          icon={<CircleAlert className="size-5" />}
        >
          {domain.state === "active" && domain.problem === "txt_missing" && domain.missedChecks > 0
            ? t("domains.missedChecks", { count: domain.missedChecks })
            : t(`${PROBLEMS[domain.problem]}.hint` as MessageId)}
        </Callout>
      ) : null}
      {showRecords && txt && cname ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{t("domains.records")}</p>
          <RecordFields
            type="TXT"
            name={txt.name}
            value={txt.value}
            hint={t("domains.records.txtHint")}
          />
          <RecordFields
            type="CNAME"
            name={cname.name}
            value={cname.value}
            hint={t("domains.records.cnameHint")}
          />
        </div>
      ) : null}
      {domain.state === "pending" && domain.claimExpiresAt ? (
        <p className="text-sm text-text-muted">
          {t("domains.claimExpires", { date: formatDate(domain.claimExpiresAt, true) })}
        </p>
      ) : null}
      {verify.isError ? (
        <Callout
          tone="error"
          title={t("domains.checkFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, verify.error)}
        </Callout>
      ) : null}
      {remove.isError ? (
        <Callout
          tone="error"
          title={t("domains.removeFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, remove.error)}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canCheck ? (
          <Button
            intent="secondary"
            icon={<RefreshCw className="size-4" />}
            busy={verify.isPending}
            disabled={disabled || remove.isPending}
            onClick={() => verify.mutate()}
          >
            {t("domains.check")}
          </Button>
        ) : null}
        <Button
          intent="ghost"
          icon={<Trash2 className="size-4" />}
          disabled={disabled || remove.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("domains.remove")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t("domains.confirm.title", { hostname: domain.hostname })}
        confirmLabel={t("domains.remove")}
        cancelLabel={t("domains.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("domains.confirm.body")}
      </ConfirmDialog>
    </section>
  );
}

/** One DNS record: its name and value, each with a copy button. */
function RecordFields({
  type,
  name,
  value,
  hint,
}: {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  hint: string;
}) {
  const t = useT();
  const announce = useAnnounce();
  const copy = {
    copyLabel: t("domains.records.copy"),
    copiedLabel: t("copy.copied"),
    onCopied: () => announce(t("copy.done")),
    onCopyFailed: () => announce(t("copy.failed")),
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
      <p className="text-sm">
        <span className="font-medium">{t("domains.records.type", { type })}</span>{" "}
        <span className="text-text-muted">{hint}</span>
      </p>
      <CopyField label={t("domains.records.name")} value={name} {...copy} />
      <CopyField label={t("domains.records.value")} value={value} {...copy} />
    </div>
  );
}

/** While the bar is on, visits to the domain open in the viewer: say so and offer to turn it off. */
function BarNote({ artifactId, disabled }: { artifactId: string; disabled: boolean }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const turnOff = useMutation({
    mutationFn: () => api.updateAccess(artifactId, { bar: false }),
    onSuccess: (next) => {
      queryClient.setQueryData(accessQuery(artifactId), next);
      announce(t("domains.bar.done"));
    },
  });
  return (
    <Callout
      title={t("domains.bar.title")}
      icon={<Info className="size-5" />}
      action={
        <Button
          intent="secondary"
          size="sm"
          busy={turnOff.isPending}
          disabled={disabled}
          onClick={() => turnOff.mutate()}
        >
          {t("domains.bar.turnOff")}
        </Button>
      }
    >
      <p>{t("domains.bar.body")}</p>
      {turnOff.isError ? (
        <p className="mt-2 font-medium">{errorMessage(t, turnOff.error)}</p>
      ) : null}
    </Callout>
  );
}

function AddDomainForm({
  artifactId,
  disabled,
  full,
  limit,
}: {
  artifactId: string;
  disabled: boolean;
  full: boolean;
  limit: number;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const add = useMutation({
    mutationFn: (hostname: string) => api.addDomain(artifactId, hostname, crypto.randomUUID()),
    onSuccess: async (view) => {
      announce(t("domains.added", { hostname: view.hostname }));
      await queryClient.invalidateQueries({ queryKey: domainQuery(artifactId) });
    },
  });
  const form = useAppForm({
    defaultValues: { hostname: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const hostname = value.hostname.trim();
        if (hostname === "" || /[\s/:@]/.test(hostname) || !hostname.includes(".")) {
          return { fields: { hostname: t("domains.hostname.invalid") } };
        }
        return undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      await add.mutateAsync(value.hostname.trim()).then(
        () => formApi.reset(),
        () => {},
      );
    },
  });
  return (
    <div className="flex flex-col gap-3">
      {full ? <p className="text-sm font-medium">{t("domains.full", { count: limit })}</p> : null}
      {add.isError ? (
        <Callout
          tone="error"
          title={t("domains.addFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, add.error)}
        </Callout>
      ) : null}
      <form.AppForm>
        <form.Form label={t("domains.add")}>
          <div className="flex max-w-xl flex-col gap-4">
            <form.AppField name="hostname">
              {(field) => (
                <field.TextField
                  label={t("domains.hostname.label")}
                  description={t("domains.hostname.hint")}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  maxLength={253}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <div>
              <form.SubmitButton
                intent="secondary"
                icon={<Globe className="size-4" />}
                busy={add.isPending}
                disabled={disabled}
              >
                {t("domains.add")}
              </form.SubmitButton>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}
