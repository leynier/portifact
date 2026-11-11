// The Policies page of a workspace (`/policies?workspace=<slug>`, premium plan E4, decision 0015).
// Every member reads the policies, since they bind everyone, admins included; only admins change
// them. Before a save that changes existing artifacts (public artifacts narrowed, readers removed,
// share links revoked or stopped), the page lists the counts and asks for a confirmation. The
// API decides every rule again; without the plan's feature, the page says only loosening works.
// The network allowlists (decision 0020) are edited here too: only admins see the ranges, every
// other member reads that one exists; saving one asks for a confirmation with who it binds.
import {
  DEFAULT_ACCESS_POLICIES,
  type DefaultAccessPolicy,
  type IpAllowlistView,
  lowestPlanWith,
  PLAN_LABELS,
  type PolicyImpact,
  type PolicyPreview,
  type PublicAccessPolicy,
  SHARE_LINK_POLICIES,
  type ShareLinkPolicy,
  type SingleFamilyLists,
  WORKSPACE_POLICIES,
  type WorkspacePolicy,
  type WorkspacePolicyView,
} from "@portifact/contracts";
import { changedFields, impactTotal, normalizeIpRanges } from "@portifact/domain";
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
  networksLimited: boolean;
  networks: string;
  tokenNetworksLimited: boolean;
  tokenNetworks: string;
}

/** A shown allowlist's lines; a hidden one (not an admin, who cannot save) shows none. */
function linesOf(list: IpAllowlistView): string {
  return Array.isArray(list) ? list.join("\n") : "";
}

function draftOf(policy: WorkspacePolicyView["policy"]): Draft {
  return {
    publicAccess: policy.publicAccess,
    defaultAccess: policy.defaultAccess,
    readersLimited: policy.readerDomains !== null,
    readerDomains: (policy.readerDomains ?? []).join("\n"),
    shareLinks: policy.shareLinks,
    maxDays: policy.shareLinkMaxDays === null ? "" : String(policy.shareLinkMaxDays),
    networksLimited: policy.ipAllowlist !== null,
    networks: linesOf(policy.ipAllowlist),
    tokenNetworksLimited: policy.tokenIpAllowlist !== null,
    tokenNetworks: linesOf(policy.tokenIpAllowlist),
  };
}

type DraftField = "domains" | "days" | "networks" | "tokenNetworks";

/** The ranges a textarea lists, or null when they are not 1 to the maximum valid ranges. */
function rangesOf(text: string): string[] | null {
  const ranges = text
    .split(/[\s,]+/)
    .map((range) => range.trim())
    .filter((range) => range.length > 0);
  if (ranges.length === 0 || ranges.length > WORKSPACE_POLICIES.ipRanges) return null;
  return normalizeIpRanges(ranges).ok ? ranges : null;
}

/** The policy a draft describes, or which field is not valid. */
export function policyOfDraft(
  draft: Draft,
): { ok: true; policy: WorkspacePolicy } | { ok: false; field: DraftField } {
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
  const networks = draft.networksLimited ? rangesOf(draft.networks) : null;
  if (draft.networksLimited && networks === null) return { ok: false, field: "networks" };
  const tokenNetworks = draft.tokenNetworksLimited ? rangesOf(draft.tokenNetworks) : null;
  if (draft.tokenNetworksLimited && tokenNetworks === null) {
    return { ok: false, field: "tokenNetworks" };
  }
  return {
    ok: true,
    policy: {
      publicAccess: draft.publicAccess,
      defaultAccess: draft.defaultAccess,
      readerDomains: draft.readersLimited ? domains : null,
      shareLinks: draft.shareLinks,
      shareLinkMaxDays: maxDays,
      ipAllowlist: networks,
      tokenIpAllowlist: tokenNetworks,
    },
  };
}

/**
 * Whether saving `next` sets or changes a network allowlist the page last showed: the admin is
 * told who it binds before it is saved (decision 0020).
 */
function networksChange(view: WorkspacePolicyView, next: WorkspacePolicy): boolean {
  const shown = view.policy;
  if (!Array.isArray(shown.ipAllowlist) && shown.ipAllowlist !== null) return false;
  if (!Array.isArray(shown.tokenIpAllowlist) && shown.tokenIpAllowlist !== null) return false;
  const current = {
    ...next,
    ipAllowlist: shown.ipAllowlist,
    tokenIpAllowlist: shown.tokenIpAllowlist,
  } as WorkspacePolicy;
  const fields = changedFields(current, {
    ...next,
    ipAllowlist: next.ipAllowlist === null ? null : normalized(next.ipAllowlist),
    tokenIpAllowlist: next.tokenIpAllowlist === null ? null : normalized(next.tokenIpAllowlist),
  });
  return (
    (fields.includes("ipAllowlist") && next.ipAllowlist !== null) ||
    (fields.includes("tokenIpAllowlist") && next.tokenIpAllowlist !== null)
  );
}

function normalized(ranges: string[]): string[] {
  const result = normalizeIpRanges(ranges);
  return result.ok ? result.value : ranges;
}

function PolicyForm({ space, view }: { space: Workspace; view: WorkspacePolicyView }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [draft, setDraft] = useState<Draft>(() => draftOf(view.policy));
  const [invalid, setInvalid] = useState<DraftField | null>(null);
  const [pending, setPending] = useState<{
    policy: WorkspacePolicy;
    preview: PolicyPreview;
  } | null>(null);
  // Set after a save that changes existing artifacts: where the admin sees what changed.
  const [applied, setApplied] = useState(false);
  const editable = view.editable;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    // The confirmation carries the impact the admin saw: the API refuses it when that grew.
    mutationFn: async (input: {
      policy: WorkspacePolicy;
      confirmed?: PolicyImpact;
      families?: SingleFamilyLists;
    }) =>
      api.savePolicies(space.slug, {
        policy: input.policy,
        revision: view.revision,
        ...(input.confirmed ? { confirmed: input.confirmed } : {}),
        // The single-family lists the dialog showed (decision 0020): the API refuses others.
        ...(input.families ? { confirmedSingleFamily: input.families } : {}),
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
    const result = await preview.mutateAsync(parsed.policy).catch(() => null);
    if (!result) return;
    if (impactTotal(result) > 0 || networksChange(view, parsed.policy)) {
      setPending({ policy: parsed.policy, preview: result });
    } else save.mutate({ policy: parsed.policy });
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
      <NetworkPanel
        kind="people"
        view={view}
        limited={draft.networksLimited}
        text={draft.networks}
        disabled={fieldsDisabled}
        invalid={invalid === "networks"}
        onLimited={(value) => set("networksLimited", value)}
        onText={(value) => set("networks", value)}
      />
      <NetworkPanel
        kind="tokens"
        view={view}
        limited={draft.tokenNetworksLimited}
        text={draft.tokenNetworks}
        disabled={fieldsDisabled}
        invalid={invalid === "tokenNetworks"}
        peopleLimited={draft.networksLimited}
        onLimited={(value) => set("tokenNetworksLimited", value)}
        onText={(value) => set("tokenNetworks", value)}
      />
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
              : // The lock-out refusal names the admin's own address, in the API's words.
                errorMessage(t, failure)}
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
        title={
          pending && impactTotal(pending.preview) === 0
            ? t("policies.impact.networksTitle")
            : t("policies.impact.title")
        }
        confirmLabel={
          pending && impactTotal(pending.preview) === 0
            ? familiesOf(pending.preview)
              ? t("policies.impact.familiesConfirm")
              : t("policies.impact.networksConfirm")
            : t("policies.impact.confirm")
        }
        cancelLabel={t("policies.impact.cancel")}
        tone="danger"
        busy={save.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          // Confirmations are only sent for what needs one: changes to existing artifacts, and
          // lists that cover one address family.
          const families = familiesOf(pending.preview);
          save.mutate({
            policy: pending.policy,
            ...(impactTotal(pending.preview) > 0 ? { confirmed: pending.preview } : {}),
            ...(families ? { families } : {}),
          });
        }}
      >
        {pending ? <ImpactList space={space} preview={pending.preview} /> : null}
      </ConfirmDialog>
    </form>
  );
}

/** The single-family lists a preview reported, or undefined when there are none to confirm. */
function familiesOf(preview: PolicyPreview): SingleFamilyLists | undefined {
  const families = preview.networks?.singleFamily;
  return families && (families.people || families.tokens) ? families : undefined;
}

/** The counts a save changes, one line each, and who a network allowlist binds. */
function ImpactList({ space, preview }: { space: Workspace; preview: PolicyPreview }) {
  const t = useT();
  const lines = [
    [preview.publicArtifacts, "policies.impact.public"],
    [preview.readersOutside, "policies.impact.readers"],
    [preview.linksRevoked, "policies.impact.revoked"],
    [preview.linksWithoutPassword, "policies.impact.password"],
    [preview.linksOverLifetime, "policies.impact.lifetime"],
  ] as const;
  const artifacts = impactTotal(preview) > 0;
  const networks = preview.networks;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {artifacts ? (
        <>
          <p>{t("policies.impact.body", { workspace: space.name })}</p>
          <ul className="list-disc pl-5">
            {lines
              .filter(([count]) => count > 0)
              .map(([count, message]) => (
                <li key={message}>{t(message, { count })}</li>
              ))}
          </ul>
          <p className="text-text-muted">{t("policies.impact.note")}</p>
        </>
      ) : null}
      {networks ? (
        <>
          <ul className="list-disc pl-5">
            {networks.members > 0 ? (
              <li>{t("policies.impact.members", { count: networks.members })}</li>
            ) : null}
            {networks.tokens > 0 ? (
              <li>{t("policies.impact.tokens", { count: networks.tokens })}</li>
            ) : null}
            {(["people", "tokens"] as const).map((list) => {
              const family = networks.singleFamily[list];
              return family ? (
                <li key={list}>{t("policies.impact.singleFamily", { list, family })}</li>
              ) : null;
            })}
            {networks.unboundTokens > 0 ? (
              <li>{t("policies.impact.unboundTokens", { count: networks.unboundTokens })}</li>
            ) : null}
          </ul>
          <p className="text-text-muted">{t("policies.impact.networksNote")}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * One network allowlist (decision 0020): for people or for service tokens. An admin edits the
 * ranges; any other member sees only that one exists, never the networks.
 */
function NetworkPanel(props: {
  kind: "people" | "tokens";
  view: WorkspacePolicyView;
  limited: boolean;
  text: string;
  disabled: boolean;
  invalid: boolean;
  /** Whether the people list is set in the draft: then unbound tokens are worth a warning. */
  peopleLimited?: boolean;
  onLimited: (limited: boolean) => void;
  onText: (text: string) => void;
}) {
  const t = useT();
  const { kind, view } = props;
  const shown = kind === "people" ? view.policy.ipAllowlist : view.policy.tokenIpAllowlist;
  const legend = t(
    kind === "people" ? "policies.networks.legend" : "policies.tokenNetworks.legend",
  );
  const hint = t(kind === "people" ? "policies.networks.hint" : "policies.tokenNetworks.hint");
  if (shown === "hidden") {
    return (
      <Panel headingLevel={2} title={legend}>
        <p className="text-sm">
          {t(kind === "people" ? "policies.networks.hidden" : "policies.tokenNetworks.hidden")}
        </p>
      </Panel>
    );
  }
  const name = kind === "people" ? "ipAllowlist" : "tokenIpAllowlist";
  return (
    <Panel headingLevel={2} title={legend} description={hint}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name={name}
          value={props.limited ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onLimited(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.networks.any"),
              description: t(
                kind === "people" ? "policies.networks.anyHint" : "policies.tokenNetworks.anyHint",
              ),
            },
            {
              value: "only",
              label: t("policies.networks.only"),
              description: t(
                kind === "people"
                  ? "policies.networks.onlyHint"
                  : "policies.tokenNetworks.onlyHint",
              ),
            },
          ]}
        />
        {props.limited ? (
          <TextArea
            compact
            label={t("policies.networks.ranges")}
            description={t("policies.networks.rangesHint", { max: WORKSPACE_POLICIES.ipRanges })}
            value={props.text}
            disabled={props.disabled}
            spellCheck={false}
            autoComplete="off"
            error={
              props.invalid
                ? t("policies.networks.rangesError", { max: WORKSPACE_POLICIES.ipRanges })
                : undefined
            }
            onChange={(event) => props.onText(event.currentTarget.value)}
          />
        ) : null}
        {props.limited ? (
          <p className="text-sm text-text-muted">{t("policies.networks.bothFamilies")}</p>
        ) : null}
        {kind === "tokens" && !props.limited && props.peopleLimited && view.serviceTokens ? (
          <Callout tone="info" title={legend} icon={<CircleAlert className="size-5" />}>
            {t("policies.impact.unboundTokens", { count: view.serviceTokens })}
          </Callout>
        ) : null}
        {kind === "people" && view.editable && view.yourIp ? (
          <p className="text-sm">{t("policies.networks.yourIp", { ip: view.yourIp })}</p>
        ) : null}
        {kind === "people" ? (
          <p className="text-sm text-text-muted">
            {t("policies.networks.notStored")} {t("policies.networks.limits")}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
