// The Policies page of a workspace (`/policies?workspace=<slug>`, premium plan E4, decision 0015).
// Every member reads the policies, since they bind everyone, admins included; only admins change
// them. Before a save that changes existing artifacts (public artifacts narrowed, readers removed,
// share links revoked or stopped), the page lists the counts and asks for a confirmation. The
// API decides every rule again; without the plan's feature, the page says only loosening works.
// The network allowlists (decision 0020) are edited here too: only admins see the ranges, every
// other member reads that one exists; saving one asks for a confirmation with who it binds. So
// are the sign-in policies (decision 0021): a maximum session age and the kinds of app allowed to
// act; saving either asks for a confirmation with who it binds, as counts. And "SSO required"
// (decision 0021), offered only where single sign-on is: setting it needs a provider that can
// sign people in and the admin's own session through it, and confirms the members it cuts off.
import {
  type ClientKind,
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
  buttonClasses,
  Callout,
  Checkbox,
  ConfirmDialog,
  PageHeader,
  Panel,
  RadioGroup,
  TextArea,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  CalendarClock,
  CircleAlert,
  Info,
  LogIn,
  MessageSquareX,
  Save,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { ssoReauthUrl } from "../../auth/query.ts";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
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
  sessionLimited: boolean;
  sessionHours: string;
  clientsLimited: boolean;
  clients: ClientKind[];
  ssoRequired: boolean;
  lifeLimited: boolean;
  lifeDays: string;
  commentsLimited: boolean;
  commentDays: string;
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
    sessionLimited: policy.sessionMaxHours !== null,
    sessionHours: policy.sessionMaxHours === null ? "" : String(policy.sessionMaxHours),
    clientsLimited: policy.allowedClients !== null,
    clients: policy.allowedClients ?? ["cli", "oauth_apps"],
    ssoRequired: policy.ssoRequired,
    lifeLimited: policy.artifactMaxDays !== null,
    lifeDays: policy.artifactMaxDays === null ? "" : String(policy.artifactMaxDays),
    commentsLimited: policy.commentRetentionDays !== null,
    commentDays: policy.commentRetentionDays === null ? "" : String(policy.commentRetentionDays),
  };
}

type DraftField =
  | "domains"
  | "days"
  | "networks"
  | "tokenNetworks"
  | "sessionHours"
  | "lifeDays"
  | "commentDays";

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
  const hours = draft.sessionLimited ? Number(draft.sessionHours.trim() || Number.NaN) : null;
  if (
    hours !== null &&
    (!Number.isInteger(hours) ||
      hours < WORKSPACE_POLICIES.sessionMinHours ||
      hours > WORKSPACE_POLICIES.sessionMaxHours)
  ) {
    return { ok: false, field: "sessionHours" };
  }
  const life = draft.lifeLimited ? Number(draft.lifeDays.trim() || Number.NaN) : null;
  if (
    life !== null &&
    (!Number.isInteger(life) ||
      life < WORKSPACE_POLICIES.artifactMinDays ||
      life > WORKSPACE_POLICIES.artifactMaxDays)
  ) {
    return { ok: false, field: "lifeDays" };
  }
  const comments = draft.commentsLimited ? Number(draft.commentDays.trim() || Number.NaN) : null;
  if (
    comments !== null &&
    (!Number.isInteger(comments) ||
      comments < WORKSPACE_POLICIES.commentMinDays ||
      comments > WORKSPACE_POLICIES.commentMaxDays)
  ) {
    return { ok: false, field: "commentDays" };
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
      sessionMaxHours: hours,
      allowedClients: draft.clientsLimited ? draft.clients : null,
      ssoRequired: draft.ssoRequired,
      artifactMaxDays: life,
      // When it takes effect is the server's to decide (decision 0023); this is never read.
      artifactMaxDaysFrom: null,
      commentRetentionDays: comments,
      commentRetentionFrom: null,
      // The server decides it (decision 0023): never the client.
      commentRetentionToken: null,
    },
  };
}

/**
 * Whether saving `next` sets or tightens a sign-in policy (decision 0021): the admin is told who
 * it binds before it is saved.
 */
function signInsChange(view: WorkspacePolicyView, next: WorkspacePolicy): boolean {
  const shown = view.policy;
  const age =
    next.sessionMaxHours !== null &&
    (shown.sessionMaxHours === null || next.sessionMaxHours < shown.sessionMaxHours);
  const clients =
    next.allowedClients !== null &&
    (shown.allowedClients === null ||
      shown.allowedClients.some((kind) => !next.allowedClients?.includes(kind)));
  return age || clients;
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
      outsideProvider?: number;
    }) =>
      api.savePolicies(space.slug, {
        policy: input.policy,
        revision: view.revision,
        ...(input.confirmed ? { confirmed: input.confirmed } : {}),
        // The single-family lists the dialog showed (decision 0020): the API refuses others.
        ...(input.families ? { confirmedSingleFamily: input.families } : {}),
        // The members the provider cannot serve that the dialog showed (decision 0021).
        ...(input.outsideProvider !== undefined
          ? { confirmedOutsideProvider: input.outsideProvider }
          : {}),
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
    if (
      impactTotal(result) > 0 ||
      networksChange(view, parsed.policy) ||
      signInsChange(view, parsed.policy) ||
      (parsed.policy.ssoRequired && !view.policy.ssoRequired)
    ) {
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
      <MaxLifeBanner view={view} />
      <CommentRetentionBanner view={view} />
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
      <CommentRetentionPanel
        limited={draft.commentsLimited}
        days={draft.commentDays}
        disabled={fieldsDisabled}
        invalid={invalid === "commentDays"}
        onLimited={(value) => set("commentsLimited", value)}
        onDays={(value) => set("commentDays", value)}
      />
      <MaxLifePanel
        limited={draft.lifeLimited}
        days={draft.lifeDays}
        disabled={fieldsDisabled}
        invalid={invalid === "lifeDays"}
        onLimited={(value) => set("lifeLimited", value)}
        onDays={(value) => set("lifeDays", value)}
      />
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
      <SessionPanel
        view={view}
        limited={draft.sessionLimited}
        hours={draft.sessionHours}
        disabled={fieldsDisabled}
        invalid={invalid === "sessionHours"}
        onLimited={(value) => set("sessionLimited", value)}
        onHours={(value) => set("sessionHours", value)}
      />
      <ClientsPanel
        limited={draft.clientsLimited}
        clients={draft.clients}
        disabled={fieldsDisabled}
        onLimited={(value) => set("clientsLimited", value)}
        onClients={(value) => set("clients", value)}
      />
      <SsoRequirementPanel
        view={view}
        required={draft.ssoRequired}
        disabled={fieldsDisabled}
        onRequired={(value) => set("ssoRequired", value)}
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
              : failure instanceof ApiFailure && failure.detail === "comment_retention_guard"
                ? t("policies.comments.unavailable")
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
            ? pending.preview.networks
              ? t("policies.impact.networksTitle")
              : pending.preview.sso && !pending.preview.signIns
                ? t("policies.impact.ssoTitle")
                : t("policies.impact.signInsTitle")
            : t("policies.impact.title")
        }
        confirmLabel={
          pending && impactTotal(pending.preview) === 0
            ? familiesOf(pending.preview)
              ? t("policies.impact.familiesConfirm")
              : pending.preview.networks
                ? t("policies.impact.networksConfirm")
                : pending.preview.sso && !pending.preview.signIns
                  ? t("policies.impact.ssoConfirm")
                  : t("policies.impact.signInsConfirm")
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
          const outside =
            pending.policy.ssoRequired && !view.policy.ssoRequired
              ? pending.preview.sso?.outsideProvider
              : undefined;
          save.mutate({
            policy: pending.policy,
            ...(impactTotal(pending.preview) > 0 ? { confirmed: pending.preview } : {}),
            ...(families ? { families } : {}),
            ...(outside !== undefined && outside > 0 ? { outsideProvider: outside } : {}),
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
    [preview.artifactsAtStart, "policies.impact.atStart"],
    [preview.artifactsSoon, "policies.impact.soon"],
    [preview.pinsLifted, "policies.impact.pins"],
    [preview.threadsAtStart, "policies.impact.threads"],
    [preview.messagesAtStart, "policies.impact.messages"],
    [preview.threadsSoon, "policies.impact.threadsSoon"],
  ] as const;
  const artifacts = impactTotal(preview) > 0;
  const networks = preview.networks;
  const signIns = preview.signIns;
  const sso = preview.sso;
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
          {preview.threadsAtStart + preview.threadsSoon > 0 ? (
            <p className="text-text-muted">{t("policies.impact.openThreads")}</p>
          ) : null}
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
      {signIns ? (
        <>
          <ul className="list-disc pl-5">
            <li>{t("policies.impact.signInMembers", { count: signIns.members })}</li>
            {signIns.staleMembers > 0 ? (
              <li>{t("policies.impact.staleMembers", { count: signIns.staleMembers })}</li>
            ) : null}
            {signIns.clientMembers > 0 ? (
              <li>{t("policies.impact.clientMembers", { count: signIns.clientMembers })}</li>
            ) : null}
          </ul>
          <p className="text-text-muted">{t("policies.impact.signInsNote")}</p>
        </>
      ) : null}
      {sso ? (
        <>
          <ul className="list-disc pl-5">
            <li>{t("policies.impact.ssoMembers", { count: sso.members })}</li>
            {sso.outsideProvider > 0 ? (
              <li className="font-semibold">
                {t("policies.impact.ssoOutside", { count: sso.outsideProvider })}
              </li>
            ) : null}
            {sso.withoutSsoSession > 0 ? (
              <li>{t("policies.impact.ssoWithout", { count: sso.withoutSsoSession })}</li>
            ) : null}
          </ul>
          <p className="text-text-muted">{t("policies.impact.ssoNote")}</p>
          <p className="text-text-muted">{t("policies.sso.tradeoff")}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * "SSO required" (decision 0021). Admins see it only where single sign-on is offered
 * (`view.sso`); members see that it is required, never the provider. Requiring it needs a
 * provider that can sign people in and the admin's own session through it: the page explains
 * what is missing and offers the sign-in, which comes back here. Lifting it is always possible.
 */
function SsoRequirementPanel(props: {
  view: WorkspacePolicyView;
  required: boolean;
  disabled: boolean;
  onRequired: (required: boolean) => void;
}) {
  const t = useT();
  const { view } = props;
  const here = useRouterState({ select: (state) => state.location.href });
  const legend = t("policies.sso.legend");
  if (!view.sso) {
    // Members read the rule they follow; a stored requirement is always shown.
    return view.policy.ssoRequired ? (
      <Panel headingLevel={2} title={legend}>
        <p className="text-sm">{t("policies.sso.required")}</p>
      </Panel>
    ) : null;
  }
  const offered = view.sso.offered;
  const canRequire = offered && view.sso.usable && view.sso.yourSession;
  return (
    <Panel headingLevel={2} title={legend} description={t("policies.sso.hint")}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name="ssoRequired"
          value={props.required ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onRequired(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.sso.any"),
              description: t("policies.sso.anyHint"),
            },
            {
              value: "only",
              label: t("policies.sso.only"),
              description: t("policies.sso.onlyHint"),
              // The current value stays selectable, so it can be kept.
              disabled: !canRequire && !view.policy.ssoRequired,
            },
          ]}
        />
        {view.policy.ssoRequired && !offered ? (
          // It binds and nobody can meet it: switched off on this Portifact (decision 0021).
          <Callout tone="error" title={legend} icon={<CircleAlert className="size-5" />}>
            {t("policies.sso.switchedOff")}
          </Callout>
        ) : view.policy.ssoRequired && !view.sso.usable ? (
          <Callout tone="info" title={legend} icon={<CircleAlert className="size-5" />}>
            {t("policies.sso.suspended")}
          </Callout>
        ) : null}
        {offered && !view.sso.usable && !view.policy.ssoRequired ? (
          <p className="text-sm">
            {t("policies.sso.notUsable")}{" "}
            <Link to="/members" className="font-semibold">
              {legend}
            </Link>
          </p>
        ) : null}
        {offered && view.sso.usable && !view.sso.yourSession ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm">{t("policies.sso.signInFirst")}</p>
            <a href={ssoReauthUrl(here)} className={buttonClasses({})}>
              <LogIn aria-hidden="true" className="size-4" />
              {t("space.blockedSso.action")}
            </a>
          </div>
        ) : null}
        <p className="text-sm text-text-muted">{t("policies.sso.tradeoff")}</p>
      </div>
    </Panel>
  );
}

const HOUR_MS = 3_600_000;

/**
 * Every member sees a comment retention that is set (decision 0023): it deletes their comments
 * for good. While it waits for its effective date, the page says from when.
 */
function CommentRetentionBanner({ view }: { view: WorkspacePolicyView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { commentRetentionDays: days, commentRetentionFrom: from } = view.policy;
  if (days === null) return null;
  if (view.commentRetentionInForce === false) {
    // The policy and its guard record disagree (decision 0023, "Restores"): nothing is deleted.
    return (
      <Callout
        tone="error"
        title={t("policies.comments.notInForce")}
        icon={<MessageSquareX className="size-5" />}
      >
        {t("policies.comments.notInForceHint")}
      </Callout>
    );
  }
  const pending = from !== null && from > Date.now();
  return (
    <Callout
      tone={pending ? "info" : undefined}
      title={
        pending
          ? t("policies.comments.pending", { date: formatDate(new Date(from).toISOString()) })
          : t("policies.comments.legend")
      }
      icon={<MessageSquareX className="size-5" />}
    >
      {t("policies.comments.active", { days })}
    </Callout>
  );
}

/**
 * Comment retention (decision 0023): days after a thread's last activity before it is deleted
 * for good, with every message; open threads on an artifact's current version are kept. The page
 * says what it deletes and that it cannot be undone, and that a new or shorter one waits for the
 * notice period.
 */
function CommentRetentionPanel(props: {
  limited: boolean;
  days: string;
  disabled: boolean;
  invalid: boolean;
  onLimited: (limited: boolean) => void;
  onDays: (days: string) => void;
}) {
  const t = useT();
  const legend = t("policies.comments.legend");
  const bounds = {
    min: WORKSPACE_POLICIES.commentMinDays,
    max: WORKSPACE_POLICIES.commentMaxDays,
  };
  return (
    <Panel headingLevel={2} title={legend} description={t("policies.comments.hint")}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name="commentRetentionDays"
          value={props.limited ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onLimited(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.comments.any"),
              description: t("policies.comments.anyHint"),
            },
            {
              value: "only",
              label: t("policies.comments.only"),
              description: t("policies.comments.onlyHint"),
            },
          ]}
        />
        {props.limited ? (
          <TextInput
            label={t("policies.comments.days")}
            description={t("policies.comments.daysHint", bounds)}
            inputMode="numeric"
            autoComplete="off"
            value={props.days}
            disabled={props.disabled}
            error={props.invalid ? t("policies.comments.daysError", bounds) : undefined}
            onChange={(event) => props.onDays(event.currentTarget.value)}
          />
        ) : null}
        <p className="text-sm text-text-muted">
          {t("policies.comments.notice", { days: WORKSPACE_POLICIES.retentionNoticeDays })}
        </p>
      </div>
    </Panel>
  );
}

/**
 * Every member sees a maximum life of artifacts that is set (decision 0023): their work has a
 * deadline. While it waits for its effective date, the page says from when.
 */
function MaxLifeBanner({ view }: { view: WorkspacePolicyView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { artifactMaxDays: days, artifactMaxDaysFrom: from } = view.policy;
  if (days === null) return null;
  if (from !== null && from > Date.now()) {
    return (
      <Callout
        tone="info"
        title={t("policies.maxLife.pending", { date: formatDate(new Date(from).toISOString()) })}
        icon={<CalendarClock className="size-5" />}
      >
        {t("policies.maxLife.pendingBody", { days })}
      </Callout>
    );
  }
  return (
    <Callout title={t("policies.maxLife.legend")} icon={<CalendarClock className="size-5" />}>
      {t("policies.maxLife.active", { days })}
    </Callout>
  );
}

/**
 * The maximum life of artifacts (decision 0023): days after an artifact's last publish or
 * restore before it is archived. The page says what it does in plain words, and that a new or
 * shorter one waits for the notice period.
 */
function MaxLifePanel(props: {
  limited: boolean;
  days: string;
  disabled: boolean;
  invalid: boolean;
  onLimited: (limited: boolean) => void;
  onDays: (days: string) => void;
}) {
  const t = useT();
  const legend = t("policies.maxLife.legend");
  const bounds = {
    min: WORKSPACE_POLICIES.artifactMinDays,
    max: WORKSPACE_POLICIES.artifactMaxDays,
  };
  return (
    <Panel headingLevel={2} title={legend} description={t("policies.maxLife.hint")}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name="artifactMaxDays"
          value={props.limited ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onLimited(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.maxLife.any"),
              description: t("policies.maxLife.anyHint"),
            },
            {
              value: "only",
              label: t("policies.maxLife.only"),
              description: t("policies.maxLife.onlyHint"),
            },
          ]}
        />
        {props.limited ? (
          <TextInput
            label={t("policies.maxLife.days")}
            description={t("policies.maxLife.daysHint", bounds)}
            inputMode="numeric"
            autoComplete="off"
            value={props.days}
            disabled={props.disabled}
            error={props.invalid ? t("policies.maxLife.daysError", bounds) : undefined}
            onChange={(event) => props.onDays(event.currentTarget.value)}
          />
        ) : null}
        <p className="text-sm text-text-muted">
          {t("policies.maxLife.notice", { days: WORKSPACE_POLICIES.retentionNoticeDays })}
        </p>
      </div>
    </Panel>
  );
}

/**
 * The maximum session age (decision 0021): how long after signing in a person may act on the
 * workspace. Every member reads it (it is a rule they follow, and a refusal names it anyway);
 * admins change it, and see how old their own sign-in is, since a shorter limit is refused.
 */
function SessionPanel(props: {
  view: WorkspacePolicyView;
  limited: boolean;
  hours: string;
  disabled: boolean;
  invalid: boolean;
  onLimited: (limited: boolean) => void;
  onHours: (hours: string) => void;
}) {
  const t = useT();
  const { view } = props;
  const legend = t("policies.session.legend");
  const bounds = {
    min: WORKSPACE_POLICIES.sessionMinHours,
    max: WORKSPACE_POLICIES.sessionMaxHours,
  };
  const age =
    view.editable && view.yourSignInAt !== null
      ? Math.max(0, Math.floor((Date.now() - view.yourSignInAt) / HOUR_MS))
      : null;
  return (
    <Panel headingLevel={2} title={legend} description={t("policies.session.hint")}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name="sessionMaxHours"
          value={props.limited ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onLimited(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.session.any"),
              description: t("policies.session.anyHint"),
            },
            {
              value: "only",
              label: t("policies.session.only"),
              description: t("policies.session.onlyHint"),
            },
          ]}
        />
        {props.limited ? (
          <TextInput
            label={t("policies.session.hours")}
            description={t("policies.session.hoursHint", bounds)}
            inputMode="numeric"
            value={props.hours}
            disabled={props.disabled}
            error={props.invalid ? t("policies.session.hoursError", bounds) : undefined}
            onChange={(event) => props.onHours(event.currentTarget.value)}
          />
        ) : null}
        {age !== null ? (
          <p className="text-sm">{t("policies.session.yours", { count: age })}</p>
        ) : null}
        <p className="text-sm text-text-muted">
          {t("policies.session.tokens")} {t("policies.session.limits")}
        </p>
      </div>
    </Panel>
  );
}

/**
 * The kinds of app allowed to act with a person's sign-in (decision 0021). The dashboard is always
 * allowed and shown as such; the page says plainly that self-registered apps choose their own
 * names, so they are allowed or refused as one group.
 */
function ClientsPanel(props: {
  limited: boolean;
  clients: ClientKind[];
  disabled: boolean;
  onLimited: (limited: boolean) => void;
  onClients: (clients: ClientKind[]) => void;
}) {
  const t = useT();
  const legend = t("policies.clients.legend");
  const toggle = (kind: ClientKind, on: boolean) =>
    props.onClients(
      (["cli", "oauth_apps"] as const).filter((each) =>
        each === kind ? on : props.clients.includes(each),
      ),
    );
  return (
    <Panel headingLevel={2} title={legend} description={t("policies.clients.hint")}>
      <div className="flex flex-col gap-4">
        <RadioGroup<"any" | "only">
          legend={legend}
          name="allowedClients"
          value={props.limited ? "only" : "any"}
          disabled={props.disabled}
          onChange={(value) => props.onLimited(value === "only")}
          options={[
            {
              value: "any",
              label: t("policies.clients.any"),
              description: t("policies.clients.anyHint"),
            },
            {
              value: "only",
              label: t("policies.clients.only"),
              description: t("policies.clients.onlyHint"),
            },
          ]}
        />
        {props.limited ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t("policies.clients.which")}</legend>
            <Checkbox label={t("policies.clients.dashboard")} checked disabled />
            <Checkbox
              label={t("policies.clients.cli")}
              description={t("policies.clients.cliHint")}
              checked={props.clients.includes("cli")}
              disabled={props.disabled}
              onChange={(event) => toggle("cli", event.currentTarget.checked)}
            />
            <Checkbox
              label={t("policies.clients.apps")}
              description={t("policies.clients.appsHint")}
              checked={props.clients.includes("oauth_apps")}
              disabled={props.disabled}
              onChange={(event) => toggle("oauth_apps", event.currentTarget.checked)}
            />
          </fieldset>
        ) : null}
        <p className="text-sm text-text-muted">
          {t("policies.clients.tokens")} {t("policies.clients.limits")}
        </p>
      </div>
    </Panel>
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
