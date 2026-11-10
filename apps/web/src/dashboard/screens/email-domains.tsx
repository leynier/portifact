// The Domains section of a workspace's Members page, for its admins (premium plan T2, decision
// 0010): add an email domain, the TXT record to create with copy buttons, its state, verify
// again and remove with confirmation. Verified domains let anyone signed in with a verified
// address there read the workspace's artifacts shared with the `domain` mode. The API decides
// every rule; this explains them.
import {
  lowestPlanWith,
  PLAN_LABELS,
  WORKSPACE_DOMAINS,
  type WorkspaceDomainList,
  type WorkspaceDomainView,
} from "@portifact/contracts";
import { Badge, Button, Callout, ConfirmDialog, CopyField, Panel } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, CircleAlert, CircleCheck, Clock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import type { Space } from "../space.tsx";
import { Loaded } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";

type T = ReturnType<typeof useT>;

export const domainsQuery = (slug: string) => ["workspace", slug, "domains"] as const;

/** Domain refusals in the page's words; other codes use the shared messages. */
const DOMAIN_ERRORS: Partial<Record<string, MessageId>> = {
  forbidden: "members.error.forbidden",
  quota_exceeded: "emailDomains.error.quota_exceeded",
  version_conflict: "emailDomains.error.version_conflict",
  capacity_unavailable: "emailDomains.error.capacity_unavailable",
  not_found: "emailDomains.error.not_found",
};

/** `invalid_input` means a refused domain when adding and a record not found when verifying. */
function explain(t: T, error: unknown, step: "add" | "verify"): string {
  if (error instanceof ApiFailure) {
    if (error.code === "invalid_input") {
      return t(step === "add" ? "emailDomains.error.refused" : "emailDomains.error.recordMissing");
    }
    const own = DOMAIN_ERRORS[error.code];
    if (own) return t(own);
  }
  return errorMessage(t, error);
}

export function EmailDomainsPanel({ space }: { space: Extract<Space, { kind: "workspace" }> }) {
  const t = useT();
  const { api } = useDashboard();
  const domains = useQuery({
    queryKey: domainsQuery(space.slug),
    queryFn: () => api.workspaceDomains(space.slug),
    ...refreshOptions,
  });
  return (
    <Panel id="domains" title={t("emailDomains.title")} description={t("emailDomains.description")}>
      <Loaded
        query={domains}
        loading={t("emailDomains.loading")}
        error={t("emailDomains.loadFailed")}
      >
        {(list) => <DomainsBody space={space} list={list} />}
      </Loaded>
    </Panel>
  );
}

function DomainsBody({
  space,
  list,
}: {
  space: Extract<Space, { kind: "workspace" }>;
  list: WorkspaceDomainList;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const full = list.items.length >= list.limit;
  const add = useMutation({
    mutationFn: (domain: string) => api.addWorkspaceDomain(space.slug, domain),
    onSuccess: async (domain) => {
      await queryClient.invalidateQueries({ queryKey: domainsQuery(space.slug) });
      announce(t("emailDomains.added", { domain: domain.domain }));
    },
  });
  const form = useAppForm({
    defaultValues: { domain: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        value.domain.trim().length === 0
          ? { fields: { domain: t("emailDomains.domainRequired") } }
          : undefined,
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await add.mutateAsync(value.domain.trim());
        formApi.reset();
      } catch {
        // The callout below explains it.
      }
    },
  });
  return (
    <div className="flex flex-col gap-4">
      {!list.available ? (
        <Callout title={t("emailDomains.planTitle")} icon={<CircleAlert className="size-5" />}>
          {t("emailDomains.plan", { plan: PLAN_LABELS[lowestPlanWith("workspaces")] })}
        </Callout>
      ) : null}
      <p className="text-sm text-text-muted">{t("emailDomains.rules")}</p>
      {add.isError ? (
        <Callout
          tone="error"
          title={t("emailDomains.addFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {explain(t, add.error, "add")}
        </Callout>
      ) : null}
      <form.AppForm>
        <form.Form label={t("emailDomains.add")}>
          <div className="flex max-w-3xl flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <form.AppField name="domain">
                {(field) => (
                  <field.TextField
                    label={t("emailDomains.domain")}
                    description={t("emailDomains.domainHint", { limit: list.limit })}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={full || !list.available}
                  />
                )}
              </form.AppField>
            </div>
            <form.SubmitButton
              intent="primary"
              icon={<Plus className="size-4" />}
              busy={add.isPending}
              disabled={full || !list.available}
            >
              {t("emailDomains.add")}
            </form.SubmitButton>
          </div>
        </form.Form>
      </form.AppForm>
      {list.items.length === 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-text-muted">
          <AtSign aria-hidden="true" className="size-4 shrink-0" />
          {t("emailDomains.empty")}
        </p>
      ) : (
        <ul aria-label={t("emailDomains.title")} className="flex flex-col gap-3">
          {list.items.map((domain) => (
            <DomainItem key={domain.id} space={space} domain={domain} available={list.available} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DomainItem({
  space,
  domain,
  available,
}: {
  space: Extract<Space, { kind: "workspace" }>;
  domain: WorkspaceDomainView;
  available: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [removing, setRemoving] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: domainsQuery(space.slug) });
  const verify = useMutation({
    mutationFn: () => api.verifyWorkspaceDomain(space.slug, domain.id),
    onSuccess: async (next) => {
      await refresh();
      announce(t("emailDomains.verified", { domain: next.domain }));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeWorkspaceDomain(space.slug, domain.id),
    onSuccess: async () => {
      setRemoving(false);
      await refresh();
      announce(t("emailDomains.removed", { domain: domain.domain }));
    },
    onError: () => setRemoving(false),
  });
  const failing = domain.state === "verified" && domain.failedChecks > 0;
  const name = domain.unicode ? `${domain.unicode} (${domain.domain})` : domain.domain;
  const left = WORKSPACE_DOMAINS.maxFailedChecks - domain.failedChecks;
  const copy = {
    copyLabel: t("domains.records.copy"),
    copiedLabel: t("copy.copied"),
    onCopied: () => announce(t("copy.done")),
    onCopyFailed: () => announce(t("copy.failed")),
  };
  const failure = verify.error ?? remove.error;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 font-medium break-all">{name}</span>
        {domain.state === "verified" ? (
          <Badge icon={<CircleCheck className="size-3.5" />}>
            {t("emailDomains.state.verified")}
          </Badge>
        ) : (
          <Badge icon={<Clock className="size-3.5" />} emphasis="subtle">
            {t("emailDomains.state.pending")}
          </Badge>
        )}
      </div>
      <p className="text-sm text-text-muted">
        {domain.state === "verified" && domain.verifiedAt
          ? t("emailDomains.verifiedOn", { date: formatDate(domain.verifiedAt) })
          : domain.expiresAt
            ? t("emailDomains.pendingUntil", { date: formatDate(domain.expiresAt) })
            : null}
      </p>
      {failing ? (
        <Callout title={t("emailDomains.failing.title")} icon={<CircleAlert className="size-5" />}>
          {t("emailDomains.failing.body", { count: domain.failedChecks, left })}
        </Callout>
      ) : null}
      {failure ? (
        <Callout
          tone="error"
          title={t("emailDomains.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {explain(t, failure, "verify")}
        </Callout>
      ) : null}
      {domain.state === "pending" || failing ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
          <p className="text-sm">
            <span className="font-medium">{t("domains.records.type", { type: "TXT" })}</span>{" "}
            <span className="text-text-muted">{t("emailDomains.recordHint")}</span>
          </p>
          <CopyField label={t("domains.records.name")} value={domain.record.name} {...copy} />
          <CopyField label={t("domains.records.value")} value={domain.record.value} {...copy} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {domain.state === "pending" ? (
          <Button
            icon={<RefreshCw className="size-4" />}
            busy={verify.isPending}
            disabled={!available}
            aria-label={t("emailDomains.verifyNamed", { domain: domain.domain })}
            onClick={() => verify.mutate()}
          >
            {t("emailDomains.verify")}
          </Button>
        ) : null}
        <Button
          intent="ghost"
          icon={<Trash2 className="size-4" />}
          aria-label={t("emailDomains.removeNamed", { domain: domain.domain })}
          onClick={() => setRemoving(true)}
        >
          {t("emailDomains.remove")}
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        title={t("emailDomains.confirmRemove.title", { domain: domain.domain })}
        confirmLabel={t("emailDomains.confirmRemove.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setRemoving(false)}
      >
        {t("emailDomains.confirmRemove.body")}
      </ConfirmDialog>
    </li>
  );
}
