// The Policies page of a workspace (`/policies?workspace=<slug>`, premium plan E4, decision 0015).
// Every member reads the policies, since they bind everyone, admins included; only admins change
// them. Before a save that changes existing artifacts (public artifacts narrowed, readers removed,
// share links revoked or stopped), the page lists the counts and asks for a confirmation. The
// API decides every rule again; without the plan's feature, the page says only loosening works.
import {
  DEFAULT_ACCESS_POLICIES,
  type DefaultAccessPolicy,
  lowestPlanWith,
  PLAN_LABELS,
  type PolicyImpact,
  type PublicAccessPolicy,
  SHARE_LINK_POLICIES,
  type ShareLinkPolicy,
  WORKSPACE_POLICIES,
  type WorkspacePolicy,
  type WorkspacePolicyView,
} from "@portifact/contracts";
import { impactTotal } from "@portifact/domain";
import {
  Button,
  Callout,
  ConfirmDialog,
  PageHeader,
  Panel,
  RadioGroup,
  TextArea,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info, Save, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { type Space, useReadySpace, WORKSPACES_QUERY } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { SpaceBadge } from "./space-parts.tsx";

export const policiesQuery = (slug: string) => ["workspace", slug, "policies"] as const;

type Workspace = Extract<Space, { kind: "workspace" }>;

export function PoliciesScreen() {
  const t = useT();
  useDocumentTitle(t("policies.title"));
  const space = useReadySpace();
  if (space.kind === "personal") {
    return (
      <>
        <PageHeader title={t("policies.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("policies.personal.title")}>{t("policies.personal.body")}</Callout>
      </>
    );
  }
  return <WorkspacePolicies space={space} />;
}

function WorkspacePolicies({ space }: { space: Workspace }) {
  const t = useT();
  const { api } = useDashboard();
  const query = useQuery({
    queryKey: policiesQuery(space.slug),
    queryFn: () => api.policies(space.slug),
  });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("policies.title")}
        meta={<SpaceBadge owner={space} />}
        description={t("policies.description", { workspace: space.name })}
      />
      <Loaded query={query} loading={t("policies.loading")} error={t("policies.loadFailed")}>
        {(view) => (
          // Start over from the server's values whenever they change, such as after a conflict.
          <PolicyForm key={view.revision} space={space} view={view} />
        )}
      </Loaded>
    </div>
  );
}

interface Draft {
  publicAccess: PublicAccessPolicy;
  defaultAccess: DefaultAccessPolicy;
  readersLimited: boolean;
  readerDomains: string;
  shareLinks: ShareLinkPolicy;
  maxDays: string;
}

function draftOf(policy: WorkspacePolicy): Draft {
  return {
    publicAccess: policy.publicAccess,
    defaultAccess: policy.defaultAccess,
    readersLimited: policy.readerDomains !== null,
    readerDomains: (policy.readerDomains ?? []).join("\n"),
    shareLinks: policy.shareLinks,
    maxDays: policy.shareLinkMaxDays === null ? "" : String(policy.shareLinkMaxDays),
  };
}

/** The policy a draft describes, or which field is not valid. */
export function policyOfDraft(
  draft: Draft,
): { ok: true; policy: WorkspacePolicy } | { ok: false; field: "domains" | "days" } {
  const domains = draft.readerDomains
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
  if (
    draft.readersLimited &&
    (domains.length === 0 || domains.length > WORKSPACE_POLICIES.readerDomains)
  ) {
    return { ok: false, field: "domains" };
  }
  const days = draft.maxDays.trim();
  const maxDays = days === "" ? null : Number(days);
  if (
    maxDays !== null &&
    (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > WORKSPACE_POLICIES.shareLinkMaxDays)
  ) {
    return { ok: false, field: "days" };
  }
  return {
    ok: true,
    policy: {
      publicAccess: draft.publicAccess,
      defaultAccess: draft.defaultAccess,
      readerDomains: draft.readersLimited ? domains : null,
      shareLinks: draft.shareLinks,
      shareLinkMaxDays: maxDays,
    },
  };
}

function PolicyForm({ space, view }: { space: Workspace; view: WorkspacePolicyView }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [draft, setDraft] = useState<Draft>(() => draftOf(view.policy));
  const [invalid, setInvalid] = useState<"domains" | "days" | null>(null);
  const [pending, setPending] = useState<{ policy: WorkspacePolicy; impact: PolicyImpact } | null>(
    null,
  );
  // Set after a save that changes existing artifacts: where the admin sees what changed.
  const [applied, setApplied] = useState(false);
  const editable = view.editable;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    // The confirmation carries the impact the admin saw: the API refuses it when that grew.
    mutationFn: async (input: { policy: WorkspacePolicy; confirmed?: PolicyImpact }) =>
      api.savePolicies(space.slug, {
        policy: input.policy,
        revision: view.revision,
        ...(input.confirmed ? { confirmed: input.confirmed } : {}),
      }),
    onSuccess: async (next, input) => {
      setPending(null);
      setApplied(input.confirmed !== undefined);
      queryClient.setQueryData(policiesQuery(space.slug), next);
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY });
      announce(t(input.confirmed ? "policies.savedWithChanges" : "policies.saved"));
    },
    onError: async (error) => {
      setPending(null);
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: policiesQuery(space.slug) });
      }
    },
  });
  const preview = useMutation({
    mutationFn: (policy: WorkspacePolicy) => api.previewPolicies(space.slug, policy),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = policyOfDraft(draft);
    setInvalid(parsed.ok ? null : parsed.field);
    if (!parsed.ok) return;
    const impact = await preview.mutateAsync(parsed.policy).catch(() => null);
    if (!impact) return;
    if (impactTotal(impact) > 0) setPending({ policy: parsed.policy, impact });
    else save.mutate({ policy: parsed.policy });
  };

  const failure = save.error ?? preview.error;
  const plan = PLAN_LABELS[lowestPlanWith("policies")];
  const fieldsDisabled = !editable || save.isPending || preview.isPending;
  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {!editable ? (
        <Callout title={t("policies.readOnly.title")} icon={<Info className="size-5" />}>
          {t("policies.readOnly.body")}
        </Callout>
      ) : null}
      {editable && !view.enabled ? (
        <Callout
          tone="info"
          title={t("policies.planTitle", { plan })}
          icon={<Info className="size-5" />}
        >
          {t("policies.planRequired")}
        </Callout>
      ) : null}
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
        {t("policies.adminsToo")}
      </p>
      <Panel headingLevel={2} title={t("policies.public.legend")}>
        <RadioGroup<PublicAccessPolicy>
          legend={t("policies.public.legend")}
          name="publicAccess"
          value={draft.publicAccess}
          disabled={fieldsDisabled}
          onChange={(value) => set("publicAccess", value)}
          options={[
            {
              value: "allowed",
              label: t("policies.public.allowed"),
              description: t("policies.public.allowedHint"),
            },
            {
              value: "forbidden",
              label: t("policies.public.forbidden"),
              description: t("policies.public.forbiddenHint"),
            },
          ]}
        />
      </Panel>
      <Panel
        headingLevel={2}
        title={t("policies.default.legend")}
        description={t("policies.default.hint")}
      >
        <RadioGroup<DefaultAccessPolicy>
          legend={t("policies.default.legend")}
          name="defaultAccess"
          value={draft.defaultAccess}
          disabled={fieldsDisabled}
          onChange={(value) => set("defaultAccess", value)}
          options={DEFAULT_ACCESS_POLICIES.map((mode) => ({
            // The domain default without a verified domain gives `workspace` (decision 0015).
            value: mode,
            label: t(`access.${mode}`),
            description:
              mode === "domain" && !view.domainVerified
                ? view.policy.defaultAccess === "domain"
                  ? t("policies.default.domainLapsed")
                  : t("policies.default.domainNone")
                : t(`policies.default.${mode}`),
            // The current value stays selectable, so it can be kept.
            disabled:
              mode === "domain" && !view.domainVerified && view.policy.defaultAccess !== "domain",
          }))}
        />
      </Panel>
      <Panel headingLevel={2} title={t("policies.readers.legend")}>
        <div className="flex flex-col gap-4">
          <RadioGroup<"any" | "only">
            legend={t("policies.readers.legend")}
            name="readerDomains"
            value={draft.readersLimited ? "only" : "any"}
            disabled={fieldsDisabled}
            onChange={(value) => set("readersLimited", value === "only")}
            options={[
              {
                value: "any",
                label: t("policies.readers.any"),
                description: t("policies.readers.anyHint"),
              },
              {
                value: "only",
                label: t("policies.readers.only"),
                description: t("policies.readers.onlyHint"),
              },
            ]}
          />
          {draft.readersLimited ? (
            <TextArea
              compact
              label={t("policies.readers.domains")}
              description={t("policies.readers.domainsHint", {
                max: WORKSPACE_POLICIES.readerDomains,
              })}
              value={draft.readerDomains}
              disabled={fieldsDisabled}
              spellCheck={false}
              autoComplete="off"
              error={
                invalid === "domains"
                  ? t("policies.readers.domainsError", { max: WORKSPACE_POLICIES.readerDomains })
                  : undefined
              }
              onChange={(event) => set("readerDomains", event.currentTarget.value)}
            />
          ) : null}
        </div>
      </Panel>
      <Panel headingLevel={2} title={t("policies.links.legend")}>
        <div className="flex flex-col gap-4">
          <RadioGroup<ShareLinkPolicy>
            legend={t("policies.links.legend")}
            name="shareLinks"
            value={draft.shareLinks}
            disabled={fieldsDisabled}
            onChange={(value) => set("shareLinks", value)}
            options={SHARE_LINK_POLICIES.map((value) => ({
              value,
              label: t(`policies.links.${value}`),
              description: t(`policies.links.${value}Hint`),
            }))}
          />
          <TextInput
            label={t("policies.lifetime.label")}
            description={t("policies.lifetime.hint")}
            inputMode="numeric"
            autoComplete="off"
            value={draft.maxDays}
            disabled={fieldsDisabled || draft.shareLinks === "disabled"}
            error={
              invalid === "days"
                ? t("policies.lifetime.error", { max: WORKSPACE_POLICIES.shareLinkMaxDays })
                : undefined
            }
            onChange={(event) => set("maxDays", event.currentTarget.value)}
          />
        </div>
      </Panel>
      {failure ? (
        <Callout
          tone="error"
          title={t("policies.saveFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {failure instanceof ApiFailure && failure.code === "version_conflict"
            ? t("policies.conflict")
            : failure instanceof ApiFailure && failure.code === "policy_refused"
              ? t("policies.impact.stale")
              : errorMessage(t, failure)}
        </Callout>
      ) : null}
      {applied && !failure ? (
        <Callout tone="success" title={t("policies.saved")} icon={<Info className="size-5" />}>
          {t("policies.savedWithChanges")}
        </Callout>
      ) : null}
      {editable ? (
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<Save className="size-4" />}
            busy={save.isPending || preview.isPending}
          >
            {t("policies.save")}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        title={t("policies.impact.title")}
        confirmLabel={t("policies.impact.confirm")}
        cancelLabel={t("policies.impact.cancel")}
        tone="danger"
        busy={save.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) save.mutate({ policy: pending.policy, confirmed: pending.impact });
        }}
      >
        {pending ? <ImpactList space={space} impact={pending.impact} /> : null}
      </ConfirmDialog>
    </form>
  );
}

/** The counts a save changes, one line each. */
function ImpactList({ space, impact }: { space: Workspace; impact: PolicyImpact }) {
  const t = useT();
  const lines = [
    [impact.publicArtifacts, "policies.impact.public"],
    [impact.readersOutside, "policies.impact.readers"],
    [impact.linksRevoked, "policies.impact.revoked"],
    [impact.linksWithoutPassword, "policies.impact.password"],
    [impact.linksOverLifetime, "policies.impact.lifetime"],
  ] as const;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>{t("policies.impact.body", { workspace: space.name })}</p>
      <ul className="list-disc pl-5">
        {lines
          .filter(([count]) => count > 0)
          .map(([count, message]) => (
            <li key={message}>{t(message, { count })}</li>
          ))}
      </ul>
      <p className="text-text-muted">{t("policies.impact.note")}</p>
    </div>
  );
}
