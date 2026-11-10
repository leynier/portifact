// The audit log page (`/audit`, premium plan T10): who changed what in the space, newest first,
// for its admins, with filters by kind of change, person and period. The API decides who may read
// it and what each event holds; this only shows it in plain words. Without the feature in the
// owner's plan it says which plan includes it; there is no checkout yet, so nothing else is offered.
// When the plan includes exporting (Enterprise), admins can download what the filters keep as CSV
// or JSON Lines, every part of it, through the same route as the CLI.
import {
  type AuditEventView,
  type AuditExportFormat,
  type AuditKind,
  lowestPlanWith,
  PLAN_LABELS,
  type PlanName,
  type WorkspaceRole,
} from "@portifact/contracts";
import { auditExportFileName } from "@portifact/domain";
import {
  Button,
  Callout,
  EmptyState,
  LoadingState,
  PageHeader,
  Select,
  type SelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { keepPreviousData, useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { CircleAlert, Download, Info, Lock, RefreshCw, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiFailure, type AuditPageQuery, type DashboardApi } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { useLocale } from "../locale.tsx";
import type { SavedFile } from "../publish/download.ts";
import { refreshOptions } from "../refresh.ts";
import { ROLE_LABELS, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";
import { SpaceBadge } from "./space-parts.tsx";

type T = ReturnType<typeof useT>;

/** Kinds of change as the filter groups them; each group is within the API's kinds per query. */
export const AUDIT_GROUPS = {
  access: [
    "access.changed",
    "share_link.created",
    "share_link.revoked",
    "review.requested",
    "review.changed",
    "review.cancelled",
    "review.verdict",
    "email_domain.verified",
    "email_domain.removed",
  ],
  lifecycle: [
    "artifact.published",
    "artifact.rolled_back",
    "artifact.renewed",
    "artifact.archived",
    "artifact.restored",
    "artifact.deleted",
    "artifact.pinned",
    "artifact.unpinned",
    "artifact.transferred_in",
    "artifact.transferred_out",
  ],
  integrations: [
    "domain.attached",
    "domain.removed",
    "webhook.created",
    "webhook.changed",
    "webhook.removed",
    "brand.changed",
    "brand.removed",
  ],
  members: [
    "member.invited",
    "member.invitation_revoked",
    "member.joined",
    "member.role_changed",
    "member.removed",
    "member.left",
    "plan.granted",
    "plan.removed",
    "service_token.created",
    "service_token.revoked",
    "sso.created",
    "sso.changed",
    "sso.removed",
    "scim_token.created",
    "scim_token.revoked",
    "member.provisioned",
    "scim.changed",
  ],
  policies: ["policy.changed", "policy.enforced"],
  groups: [
    "group.created",
    "group.renamed",
    "group.deleted",
    "group.sync_stopped",
    "group.member_added",
    "group.member_removed",
  ],
} as const satisfies Record<string, readonly AuditKind[]>;
type Group = "all" | keyof typeof AUDIT_GROUPS;

const PERIODS = { day: 1, week: 7, month: 30, all: null } as const;
type Period = keyof typeof PERIODS;

const DAY_MS = 86_400_000;

export const auditQuery = (slug: string | undefined, filters: unknown) =>
  ["audit", slug ?? "", filters] as const;

export function AuditScreen() {
  const t = useT();
  const { api } = useDashboard();
  useDocumentTitle(t("audit.title"));
  const space = useReadySpace();
  const [group, setGroup] = useState<Group>("all");
  const [actor, setActor] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  // The start of the period, fixed when it is chosen so the query key stays stable.
  const [from, setFrom] = useState<string | undefined>(undefined);
  const filters = { group, actor, from };
  const log = useInfiniteQuery({
    queryKey: auditQuery(space.slug, filters),
    queryFn: ({ pageParam }) =>
      api.audit(space.slug, {
        kinds: group === "all" ? undefined : AUDIT_GROUPS[group],
        actor: actor || undefined,
        from,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // The previous filter's rows stay while the next load, so the controls never empty out.
    placeholderData: keepPreviousData,
    ...refreshOptions,
  });

  const events = useMemo(() => log.data?.pages.flatMap((page) => page.events) ?? [], [log.data]);
  const days = log.data?.pages[0]?.retentionDays ?? 90;
  const exportable = log.data?.pages[0]?.exportable;
  const failure = log.error instanceof ApiFailure ? log.error.code : null;

  const header = (
    <PageHeader
      title={t("audit.title")}
      description={t("audit.description", { days })}
      meta={<SpaceBadge owner={space} />}
    />
  );
  if (failure === "plan_required") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Callout tone="info" title={t("audit.planTitle")} icon={<Info className="size-5" />}>
          {t("audit.planRequired", { plan: PLAN_LABELS[lowestPlanWith("audit")] })}
        </Callout>
      </div>
    );
  }
  if (failure === "forbidden") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Callout title={t("audit.forbidden.title")} icon={<Lock className="size-5" />}>
          {t("audit.forbidden.body")}
        </Callout>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <AuditFilters
        group={group}
        onGroup={setGroup}
        actor={actor}
        onActor={setActor}
        actors={events}
        period={period}
        onPeriod={(next) => {
          setPeriod(next);
          const span = PERIODS[next];
          setFrom(span === null ? undefined : new Date(Date.now() - span * DAY_MS).toISOString());
        }}
      />
      {exportable === undefined ? null : exportable ? (
        <AuditExport
          slug={space.slug}
          query={{
            kinds: group === "all" ? undefined : AUDIT_GROUPS[group],
            actor: actor || undefined,
            from,
          }}
        />
      ) : (
        <p className="text-sm text-text-muted">
          {t("audit.export.planRequired", { plan: PLAN_LABELS[lowestPlanWith("auditExport")] })}
        </p>
      )}
      {log.isPending ? (
        <LoadingState label={t("audit.loading")} />
      ) : log.isError && !log.data ? (
        <Callout
          tone="error"
          title={t("audit.error.title")}
          icon={<CircleAlert className="size-5" />}
          action={
            <Button icon={<RefreshCw className="size-4" />} onClick={() => log.refetch()}>
              {t("action.retry")}
            </Button>
          }
        >
          {errorMessage(t, log.error)}
        </Callout>
      ) : events.length === 0 ? (
        <EmptyState title={t("audit.empty.title")} icon={<ScrollText className="size-8" />}>
          <p>{t("audit.empty.body", { days })}</p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <AuditTable events={events} />
          {log.hasNextPage ? (
            <div>
              <Button busy={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
                {t("audit.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Every part of an export, joined in order into one file. */
export async function exportAudit(
  api: DashboardApi,
  slug: string | undefined,
  format: AuditExportFormat,
  query: Omit<AuditPageQuery, "cursor">,
): Promise<SavedFile> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const part = await api.auditExport(slug, format, { ...query, cursor });
    parts.push(part.text);
    cursor = part.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const type = format === "csv" ? "text/csv;charset=utf-8" : "application/jsonl;charset=utf-8";
  return { fileName: auditExportFileName(format), blob: new Blob(parts, { type }) };
}

/** Downloads what the filters keep, as CSV or JSON Lines (Enterprise). */
function AuditExport(props: { slug: string | undefined; query: Omit<AuditPageQuery, "cursor"> }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const exporter = useMutation({
    mutationFn: (format: AuditExportFormat) => exportAudit(api, props.slug, format, props.query),
    onSuccess: (file, format) => {
      save(file);
      announce(t(format === "csv" ? "audit.export.doneCsv" : "audit.export.doneJsonl"));
    },
  });
  return (
    <section aria-label={t("audit.export.label")} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          busy={exporter.isPending && exporter.variables === "csv"}
          onClick={() => exporter.mutate("csv")}
        >
          {t("audit.export.csv")}
        </Button>
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          busy={exporter.isPending && exporter.variables === "jsonl"}
          onClick={() => exporter.mutate("jsonl")}
        >
          {t("audit.export.jsonl")}
        </Button>
      </div>
      <p className="text-sm text-text-muted">{t("audit.export.hint")}</p>
      {exporter.isError ? (
        <Callout
          tone="error"
          title={t("audit.export.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, exporter.error)}
        </Callout>
      ) : null}
    </section>
  );
}

function AuditFilters(props: {
  group: Group;
  onGroup(group: Group): void;
  actor: string;
  onActor(actor: string): void;
  actors: readonly AuditEventView[];
  period: Period;
  onPeriod(period: Period): void;
}) {
  const t = useT();
  const groups: SelectOption<Group>[] = [
    { value: "all", label: t("audit.group.all") },
    { value: "access", label: t("audit.group.access") },
    { value: "lifecycle", label: t("audit.group.lifecycle") },
    { value: "integrations", label: t("audit.group.integrations") },
    { value: "members", label: t("audit.group.members") },
    { value: "groups", label: t("audit.group.groups") },
    { value: "policies", label: t("audit.group.policies") },
  ];
  const periods: SelectOption<Period>[] = [
    { value: "all", label: t("audit.period.all") },
    { value: "day", label: t("audit.period.day") },
    { value: "week", label: t("audit.period.week") },
    { value: "month", label: t("audit.period.month") },
  ];
  // People are offered from what is shown, and the chosen one stays while it filters.
  const people = new Map<string, string>();
  for (const event of props.actors) {
    if (event.actor.type === "member") people.set(event.actor.id, event.actor.name);
    if (event.actor.type === "removed_member") {
      people.set(event.actor.id, `${t("audit.actor.removed")} (${event.actor.id.slice(0, 6)})`);
    }
  }
  if (props.actor && !people.has(props.actor)) people.set(props.actor, props.actor);
  const actors: SelectOption[] = [
    { value: "", label: t("audit.actor.all") },
    ...[...people].map(([value, label]) => ({ value, label })),
  ];
  return (
    <section aria-label={t("audit.filters")} className="flex flex-wrap items-center gap-2">
      <Select
        variant="compact"
        label={t("audit.filter.kind")}
        value={props.group}
        options={groups}
        onChange={props.onGroup}
        active={props.group !== "all"}
      />
      <Select
        variant="compact"
        label={t("audit.filter.actor")}
        value={props.actor}
        options={actors}
        onChange={props.onActor}
        active={props.actor !== ""}
      />
      <Select
        variant="compact"
        label={t("audit.filter.period")}
        value={props.period}
        options={periods}
        onChange={props.onPeriod}
        active={props.period !== "all"}
      />
    </section>
  );
}

function AuditTable({ events }: { events: readonly AuditEventView[] }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { locale } = useLocale();
  return (
    <Table caption={t("audit.caption")} stacked>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("audit.column.when")}</TableHeaderCell>
          <TableHeaderCell>{t("audit.column.who")}</TableHeaderCell>
          <TableHeaderCell>{t("audit.column.what")}</TableHeaderCell>
          <TableHeaderCell>{t("audit.column.on")}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {events.map((event) => (
          <TableRow key={event.id}>
            <TableCell label={t("audit.column.when")}>
              <span className="whitespace-nowrap tabular-nums">{formatDate(event.at, true)}</span>
            </TableCell>
            <TableCell label={t("audit.column.who")}>{actorName(t, event.actor)}</TableCell>
            <TableCell label={t("audit.column.what")}>
              {describeAuditEvent(t, event, locale, formatDate)}
            </TableCell>
            <TableCell label={t("audit.column.on")}>
              <span className="break-all">{targetName(t, event)}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Who acted, as the page shows it: a removed member never by address. */
export function actorName(t: T, actor: AuditEventView["actor"]): string {
  switch (actor.type) {
    case "member":
      return actor.name;
    case "removed_member":
      return t("audit.actor.removed");
    case "service_token":
      return actor.label === null
        ? t("audit.actor.tokenGone")
        : t("audit.actor.token", { label: actor.label });
    case "directory":
      return actor.label === null
        ? t("audit.actor.directoryGone")
        : t("audit.actor.directory", { label: actor.label });
    case "operator":
      return t("audit.actor.operator");
    case "system":
      return t("audit.actor.system");
  }
}

function targetName(t: T, event: AuditEventView): string {
  if (event.artifact) return event.artifact.name ?? t("audit.artifact.gone");
  switch (event.target.type) {
    case "member":
      return event.target.member ? actorName(t, event.target.member) : "";
    case "invitation":
      return t("audit.target.invitation");
    case "service_token":
      return event.target.serviceToken ? actorName(t, event.target.serviceToken) : "";
    case "scim_token":
      return event.target.scimToken ? actorName(t, event.target.scimToken) : "";
    case "group":
      return groupName(t, event);
    case "brand":
    case "plan":
    case "email_domain":
    case "audit_log":
    case "policy":
    case "scim":
      return t("audit.target.space");
    default:
      return "";
  }
}

/** What a directory settings change did, one phrase per field. */
function scimChanges(t: T, d: Record<string, unknown>): string[] {
  const fields = (d.fields as string[] | undefined) ?? ["invitationEmails"];
  const parts: string[] = [];
  if (fields.includes("invitationEmails")) {
    parts.push(t(d.invitationEmails ? "audit.kind.scimEmailsOn" : "audit.kind.scimEmailsOff"));
  }
  for (const mapped of ["editor", "admin"] as const) {
    if (!fields.includes(`${mapped}Group`)) continue;
    const label = t(ROLE_LABELS[mapped]);
    parts.push(
      d[`${mapped}Group`] === null
        ? t("audit.kind.scimRoleOff", { role: label })
        : t("audit.kind.scimRoleOn", { role: label }),
    );
  }
  return parts;
}

const role = (t: T, value: unknown) => t(ROLE_LABELS[value as WorkspaceRole]);
/** A group by its current name; events never store it (decision 0014). */
const groupName = (t: T, event: AuditEventView) => event.group?.name ?? t("audit.target.groupGone");
const flag = (value: unknown) => (value === true ? "true" : "false");

/** What happened, in the dashboard's language. */
export function describeAuditEvent(
  t: T,
  event: AuditEventView,
  locale: string | undefined,
  formatDate: (iso: string) => string,
): string {
  const d = event.detail;
  const member = event.target.member ? actorName(t, event.target.member) : "";
  const simple: Partial<Record<AuditKind, MessageId>> = {
    "artifact.renewed": "audit.kind.renewed",
    "artifact.archived": "audit.kind.archived",
    "artifact.restored": "audit.kind.restored",
    "artifact.deleted": "audit.kind.deleted",
    "artifact.pinned": "audit.kind.pinned",
    "artifact.unpinned": "audit.kind.unpinned",
    "share_link.revoked": "audit.kind.shareLinkRevoked",
    "review.changed": "audit.kind.reviewChanged",
    "review.cancelled": "audit.kind.reviewCancelled",
    "webhook.removed": "audit.kind.webhookRemoved",
    "member.invitation_revoked": "audit.kind.invitationRevoked",
    "plan.removed": "audit.kind.planRemoved",
    "service_token.revoked": "audit.kind.tokenRevoked",
    "scim_token.revoked": "audit.kind.scimTokenRevoked",
  };
  const message = simple[event.kind];
  if (message) return t(message);
  switch (event.kind) {
    case "artifact.published":
      return t(d.first ? "audit.kind.publishedFirst" : "audit.kind.published", {
        version: Number(d.version),
      });
    case "artifact.rolled_back":
      return t("audit.kind.rolledBack", { version: Number(d.version), from: Number(d.from) });
    case "artifact.transferred_in":
      return t("audit.kind.transferredIn", { from: String(d.from) });
    case "artifact.transferred_out":
      return t("audit.kind.transferredOut", { to: String(d.to) });
    case "access.changed":
      return t("audit.kind.accessChanged", { changes: accessChanges(t, d, locale) });
    case "share_link.created":
      return t("audit.kind.shareLinkCreated", {
        password: flag(d.password),
        expires: flag(d.expires),
      });
    case "review.requested":
      return t("audit.kind.reviewRequested", { reviewers: Number(d.reviewers) });
    case "review.verdict":
      return t("audit.kind.reviewVerdict", {
        verdict: String(d.verdict),
        version: Number(d.version),
      });
    case "domain.attached":
      return t("audit.kind.domainAttached", { hostname: String(d.hostname) });
    case "domain.removed":
      return t("audit.kind.domainRemoved", {
        hostname: String(d.hostname),
        reason: String(d.reason),
      });
    case "webhook.created":
      return t("audit.kind.webhookCreated", { format: String(d.format), host: String(d.host) });
    case "webhook.changed":
      return t("audit.kind.webhookChanged", {
        enabled: d.enabled === undefined ? "events" : flag(d.enabled),
      });
    case "brand.changed":
    case "brand.removed": {
      const logo = flag(Array.isArray(d.fields) && d.fields.includes("logo"));
      return t(
        event.kind === "brand.changed" ? "audit.kind.brandChanged" : "audit.kind.brandRemoved",
        {
          logo,
        },
      );
    }
    case "member.invited":
      return t("audit.kind.memberInvited", {
        domain: String(d.emailDomain),
        role: role(t, d.role),
      });
    case "member.joined":
      return d.via === "sso"
        ? t("audit.kind.memberJoinedSso", { member, role: role(t, d.role) })
        : d.via === "directory"
          ? t("audit.kind.memberJoinedDirectory", { member, role: role(t, d.role) })
          : t("audit.kind.memberJoined", { member, role: role(t, d.role) });
    case "member.provisioned":
      return t("audit.kind.memberProvisioned", {
        domain: String(d.emailDomain),
        role: role(t, d.role),
      });
    case "scim_token.created":
      return t("audit.kind.scimTokenCreated", { days: Number(d.days) });
    case "scim.changed":
      return scimChanges(t, d).join("; ");
    case "sso.created":
      return t("audit.kind.ssoCreated", {
        host: String(d.issuerHost),
        count: Number(d.domains),
      });
    case "sso.changed":
      return t("audit.kind.ssoChanged");
    case "sso.removed":
      return t("audit.kind.ssoRemoved");
    case "member.role_changed":
      return t("audit.kind.roleChanged", { member, from: role(t, d.from), to: role(t, d.to) });
    case "member.removed":
      return t("audit.kind.memberRemoved", { member });
    case "member.left":
      return t("audit.kind.memberLeft", { member });
    case "service_token.created":
      return t("audit.kind.tokenCreated", { days: Number(d.days) });
    case "email_domain.verified":
      return t("audit.kind.emailDomainVerified", { domain: String(d.domain) });
    case "email_domain.removed":
      return t("audit.kind.emailDomainRemoved", {
        domain: String(d.domain),
        reason: String(d.reason),
      });
    case "group.created":
      return t("audit.kind.groupCreated", { group: groupName(t, event) });
    case "group.renamed":
      return t("audit.kind.groupRenamed", { group: groupName(t, event) });
    case "group.sync_stopped":
      return t("audit.kind.groupSyncStopped", { group: groupName(t, event) });
    case "group.deleted":
      return t("audit.kind.groupDeleted", { group: groupName(t, event) });
    case "group.member_added":
      return t("audit.kind.groupMemberAdded", { member, group: groupName(t, event) });
    case "group.member_removed":
      return t("audit.kind.groupMemberRemoved", { member, group: groupName(t, event) });
    case "audit.exported":
      return t("audit.kind.exported", { format: String(d.format) });
    case "policy.changed":
      return t("audit.kind.policyChanged", { changes: policyChanges(t, d, locale) });
    case "policy.enforced":
      return t("audit.kind.policyEnforced", { changes: enforcedChanges(t, d, locale) });
    case "plan.granted": {
      const values = { plan: PLAN_LABELS[d.plan as PlanName], seats: Number(d.seats) };
      return typeof d.validUntil === "string"
        ? t("audit.kind.planGrantedUntil", { ...values, until: formatDate(d.validUntil) })
        : t("audit.kind.planGranted", values);
    }
    default:
      return event.kind;
  }
}

/** The fields of a policy change, in the dashboard's language. */
function policyChanges(t: T, d: Record<string, unknown>, locale: string | undefined): string {
  const parts: string[] = [];
  if (d.publicAccess) parts.push(t("audit.policy.public", { value: String(d.publicAccess) }));
  if (d.defaultAccess) parts.push(t("audit.policy.default", { mode: String(d.defaultAccess) }));
  if (d.readerDomains !== undefined) {
    parts.push(
      Array.isArray(d.readerDomains)
        ? t("audit.policy.readers", { domains: d.readerDomains.join(", ") })
        : t("audit.policy.readersAny"),
    );
  }
  if (d.shareLinks) parts.push(t("audit.policy.links", { value: String(d.shareLinks) }));
  if (d.shareLinkMaxDays !== undefined) {
    parts.push(
      d.shareLinkMaxDays === null
        ? t("audit.policy.lifetimeNone")
        : t("audit.policy.lifetime", { days: Number(d.shareLinkMaxDays) }),
    );
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

/** What one step of applying a policy changed, as counts. */
function enforcedChanges(t: T, d: Record<string, unknown>, locale: string | undefined): string {
  const counts = [
    [d.artifactsNarrowed, "audit.policy.narrowed"],
    [d.readersRemoved, "audit.policy.readersRemoved"],
    [d.linksRevoked, "audit.policy.linksRevoked"],
    [d.sessionsEnded, "audit.policy.sessionsEnded"],
  ] as const;
  const parts = counts
    .filter(([count]) => Number(count) > 0)
    .map(([count, message]) => t(message, { count: Number(count) }));
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

function accessChanges(t: T, d: Record<string, unknown>, locale: string | undefined): string {
  const parts: string[] = [];
  if (d.mode) parts.push(t("audit.access.mode", { mode: String(d.mode) }));
  if (d.readersAdded) parts.push(t("audit.access.readersAdded", { count: Number(d.readersAdded) }));
  if (d.readersRemoved) {
    parts.push(t("audit.access.readersRemoved", { count: Number(d.readersRemoved) }));
  }
  if (Array.isArray(d.readerDomains) && d.readerDomains.length > 0) {
    parts.push(t("audit.access.domains", { domains: d.readerDomains.join(", ") }));
  }
  if (d.readerExceptions) {
    parts.push(t("audit.access.exceptions", { count: Number(d.readerExceptions) }));
  }
  if (d.groupsAdded) parts.push(t("audit.access.groupsAdded", { count: Number(d.groupsAdded) }));
  if (d.groupsRemoved) {
    parts.push(t("audit.access.groupsRemoved", { count: Number(d.groupsRemoved) }));
  }
  if (d.groupExceptions) {
    parts.push(t("audit.access.groupExceptions", { count: Number(d.groupExceptions) }));
  }
  if (d.bar !== undefined) parts.push(t("audit.access.bar", { on: flag(d.bar) }));
  if (d.commentVisibility) {
    parts.push(t("audit.access.comments", { visibility: String(d.commentVisibility) }));
  }
  if (d.indexable !== undefined) parts.push(t("audit.access.indexable", { on: flag(d.indexable) }));
  if (d.embeddable !== undefined) {
    parts.push(t("audit.access.embeddable", { on: flag(d.embeddable) }));
  }
  if (d.policy) parts.push(t("audit.access.byPolicy"));
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}
