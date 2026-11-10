// The Members page of a workspace (`/members?workspace=<slug>`, premium plan T1). Every member
// sees who is in the workspace, their roles and the seats; admins change roles, remove members,
// invite by email and revoke or resend pending invitations. The last admin can never be demoted,
// removed or leave, so those controls are disabled with the reason. Every write is decided again
// by the API, whose refusals (no free seat, a rate limit, a role changed meanwhile) are explained
// in the page's own words.
import {
  Email,
  type InvitationView,
  WORKSPACE_ROLES,
  type WorkspaceMemberList,
  type WorkspaceMemberView,
  type WorkspaceRole,
} from "@portifact/contracts";
import {
  Avatar,
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Meter,
  PageHeader,
  Panel,
  Select,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, LogOut, MailPlus, RotateCw, Send, UserMinus, X } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import {
  useAnnounce,
  useDashboard,
  useFormatDate,
  useFormatNumber,
  useFormatPercent,
  useT,
} from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { refreshOptions } from "../refresh.ts";
import { ROLE_LABELS, type Space, spaceCan, useReadySpace, WORKSPACES_QUERY } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded } from "./account.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { EmailDomainsPanel } from "./email-domains.tsx";
import { ScimPanel } from "./scim.tsx";
import { SpaceBadge } from "./space-parts.tsx";
import { SsoPanel } from "./sso.tsx";

type T = ReturnType<typeof useT>;

export const membersQuery = (slug: string) => ["workspace", slug, "members"] as const;
export const invitationsQuery = (slug: string) => ["workspace", slug, "invitations"] as const;

/** What each role may do, as the role options describe them. */
const ROLE_HINTS: Record<WorkspaceRole, MessageId> = {
  admin: "role.admin.hint",
  editor: "role.editor.hint",
  member: "role.member.hint",
};

/** Member and invitation refusals in the page's words; other codes use the shared messages. */
const MEMBER_ERRORS: Partial<Record<string, MessageId>> = {
  forbidden: "members.error.forbidden",
  version_conflict: "members.error.version_conflict",
  not_found: "members.error.not_found",
};
const INVITE_ERRORS: Partial<Record<string, MessageId>> = {
  forbidden: "members.error.forbidden",
  invalid_input: "invite.error.invalid_input",
  rate_limited: "invite.error.rate_limited",
  capacity_unavailable: "invite.error.capacity_unavailable",
  not_found: "invite.error.not_found",
};

function explain(t: T, error: unknown, messages: Partial<Record<string, MessageId>>): string {
  const own = error instanceof ApiFailure ? messages[error.code] : undefined;
  return own ? t(own) : errorMessage(t, error);
}

export function MembersScreen() {
  const t = useT();
  useDocumentTitle(t("members.title"));
  const space = useReadySpace();
  if (space.kind === "personal") {
    return (
      <>
        <PageHeader title={t("members.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("members.personal.title")}>{t("members.personal.body")}</Callout>
      </>
    );
  }
  return <WorkspaceMembers space={space} />;
}

function WorkspaceMembers({ space }: { space: Extract<Space, { kind: "workspace" }> }) {
  const t = useT();
  const { api } = useDashboard();
  const admin = spaceCan(space, "members");
  const members = useQuery({
    queryKey: membersQuery(space.slug),
    queryFn: () => api.members(space.slug),
    ...refreshOptions,
  });
  const invitations = useQuery({
    queryKey: invitationsQuery(space.slug),
    queryFn: () => api.invitations(space.slug),
    enabled: admin,
    ...refreshOptions,
  });
  return (
    <>
      <PageHeader
        title={t("members.title")}
        meta={<SpaceBadge owner={space} />}
        description={t("members.description", { workspace: space.name })}
      />
      <Loaded query={members} loading={t("members.loading")} error={t("members.loadFailed")}>
        {(list) => (
          <div className="flex flex-col gap-6">
            <Seats list={list} />
            <MemberList space={space} list={list} admin={admin} />
            {admin ? (
              <>
                <InviteForm space={space} list={list} />
                <Loaded
                  query={invitations}
                  loading={t("pending.loading")}
                  error={t("pending.loadFailed")}
                >
                  {(pending) => <PendingInvitations space={space} items={pending.items} />}
                </Loaded>
                <EmailDomainsPanel space={space} />
                <SsoPanel space={space} />
                <ScimPanel space={space} />
              </>
            ) : null}
          </div>
        )}
      </Loaded>
    </>
  );
}

/** Seats in use (members and pending invitations) against the plan's seats. */
function Seats({ list }: { list: WorkspaceMemberList }) {
  const t = useT();
  const formatNumber = useFormatNumber();
  const formatPercent = useFormatPercent();
  const { used, limit } = list.seats;
  return (
    <Panel id="seats" title={t("members.seats")}>
      <div className="max-w-xl">
        <Meter
          label={t("members.seatsUsed")}
          value={Math.min(used, limit)}
          max={limit}
          valueText={t("members.seatsValue", {
            used: formatNumber(used),
            limit: formatNumber(limit),
            percent: formatPercent(limit > 0 ? used / limit : 1),
          })}
          nearLimitLabel={t("usage.nearLimit")}
          atLimitLabel={t("usage.atLimit")}
          description={t("members.seatsHint")}
        />
      </div>
    </Panel>
  );
}

/** Sends the caller back to the personal space after leaving or losing the workspace. */
function useLeftWorkspace() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY });
    await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
    await navigate({ to: "/", search: { workspace: undefined } });
  };
}

function MemberList({
  space,
  list,
  admin,
}: {
  space: Extract<Space, { kind: "workspace" }>;
  list: WorkspaceMemberList;
  admin: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const left = useLeftWorkspace();
  const [removing, setRemoving] = useState<WorkspaceMemberView | null>(null);
  const [leaving, setLeaving] = useState(false);
  const admins = list.items.filter((member) => member.role === "admin").length;
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQuery(space.slug) });
  const nameOf = (member: WorkspaceMemberView) => member.name.trim() || member.email;

  const change = useMutation({
    mutationFn: ({ member, role }: { member: WorkspaceMemberView; role: WorkspaceRole }) =>
      api.changeMemberRole(space.slug, member.userId, role),
    onSuccess: async (updated, { member }) => {
      await refresh();
      // Demoting yourself changes what the dashboard offers.
      if (member.you) await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY });
      announce(
        t("members.roleChanged", { name: nameOf(member), role: t(ROLE_LABELS[updated.role]) }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: (member: WorkspaceMemberView) => api.removeMember(space.slug, member.userId),
    onSuccess: async (_, member) => {
      setRemoving(null);
      await refresh();
      announce(t("members.removed", { name: nameOf(member) }));
    },
    onError: () => setRemoving(null),
  });
  const leave = useMutation({
    mutationFn: () => api.leaveWorkspace(space.slug),
    onSuccess: async () => {
      setLeaving(false);
      announce(t("members.left", { workspace: space.name }));
      await left();
    },
    onError: () => setLeaving(false),
  });
  const failure = change.error ?? remove.error ?? leave.error;

  return (
    <Panel
      id="members"
      title={t("members.listTitle")}
      actions={
        <p className="text-sm font-medium tabular-nums">
          {t("members.count", { count: list.items.length })}
        </p>
      }
    >
      <div className="flex flex-col gap-4">
        {failure ? (
          <Callout
            tone="error"
            title={t("members.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {explain(t, failure, MEMBER_ERRORS)}
          </Callout>
        ) : null}
        <ul
          aria-label={t("members.caption", { workspace: space.name })}
          className="divide-y divide-border rounded-md border border-border"
        >
          {list.items.map((member) => {
            const lastAdmin = member.role === "admin" && admins <= 1;
            const name = nameOf(member);
            return (
              <li
                key={member.userId}
                className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={member.name} email={member.email} size="md" />
                  <div className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="break-all">{name}</span>
                      {member.you ? <Badge>{t("members.you")}</Badge> : null}
                    </span>
                    <span className="text-xs break-all text-text-muted">{member.email}</span>
                    <span className="text-xs text-text-muted">
                      {t("members.joined", { date: formatDate(member.joinedAt) })}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 md:items-end">
                  <div className="flex flex-wrap items-center gap-2">
                    {admin ? (
                      <div className="min-w-40">
                        <Select
                          label={t("members.roleLabel", { name })}
                          labelVisible={false}
                          value={member.role}
                          disabled={lastAdmin || change.isPending}
                          options={WORKSPACE_ROLES.map((role) => ({
                            value: role,
                            label: t(ROLE_LABELS[role]),
                          }))}
                          onChange={(role) => {
                            if (role !== member.role) change.mutate({ member, role });
                          }}
                        />
                      </div>
                    ) : (
                      <Badge emphasis="subtle">{t(ROLE_LABELS[member.role])}</Badge>
                    )}
                    {member.you ? (
                      <Button
                        intent="ghost"
                        size="sm"
                        icon={<LogOut className="size-4" />}
                        disabled={lastAdmin}
                        busy={leave.isPending}
                        onClick={() => setLeaving(true)}
                      >
                        {t("members.leave")}
                      </Button>
                    ) : admin ? (
                      <Button
                        intent="ghost"
                        size="sm"
                        icon={<UserMinus className="size-4" />}
                        aria-label={t("members.removeNamed", { name })}
                        disabled={lastAdmin}
                        busy={remove.isPending && remove.variables?.userId === member.userId}
                        onClick={() => setRemoving(member)}
                      >
                        {t("members.remove")}
                      </Button>
                    ) : null}
                  </div>
                  {lastAdmin && (admin || member.you) ? (
                    <p className="max-w-xs text-xs text-text-muted md:text-right">
                      {t("members.lastAdmin")}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={t("members.confirmRemove.title", {
          name: removing ? nameOf(removing) : "",
          workspace: space.name,
        })}
        confirmLabel={t("members.confirmRemove.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<UserMinus className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => (removing ? remove.mutate(removing) : undefined)}
        onCancel={() => setRemoving(null)}
      >
        {t("members.confirmRemove.body")}
      </ConfirmDialog>
      <ConfirmDialog
        open={leaving}
        title={t("members.confirmLeave.title", { workspace: space.name })}
        confirmLabel={t("members.leave")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<LogOut className="size-4" />}
        tone="danger"
        busy={leave.isPending}
        onConfirm={() => leave.mutate()}
        onCancel={() => setLeaving(false)}
      >
        {t("members.confirmLeave.body")}
      </ConfirmDialog>
    </Panel>
  );
}

function InviteForm({
  space,
  list,
}: {
  space: Extract<Space, { kind: "workspace" }>;
  list: WorkspaceMemberList;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const full = list.seats.used >= list.seats.limit;
  const members = list.items.map((member) => member.email.toLowerCase());
  const invite = useMutation({
    mutationFn: ({ email, role }: { email: string; role: WorkspaceRole }) =>
      api.invite(space.slug, email, role),
    onSuccess: async (invitation) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invitationsQuery(space.slug) }),
        queryClient.invalidateQueries({ queryKey: membersQuery(space.slug) }),
      ]);
      announce(t("invite.sent", { email: invitation.email }));
    },
  });
  const form = useAppForm({
    defaultValues: { email: "", role: "member" as string },
    validationLogic: revalidateLogic(),
    validators: {
      // The same rule as the API (packages/contracts), with the dashboard's own wording.
      onDynamic: ({ value }) => {
        const parsed = Email.safeParse(value.email.trim());
        if (!parsed.success) return { fields: { email: t("invite.emailInvalid") } };
        if (members.includes(parsed.data.toLowerCase())) {
          return { fields: { email: t("invite.alreadyMember", { email: parsed.data }) } };
        }
        return undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await invite.mutateAsync({
          email: Email.parse(value.email.trim()),
          role: value.role as WorkspaceRole,
        });
        formApi.reset();
      } catch {
        // The callout below explains it.
      }
    },
  });
  return (
    <Panel id="invite" title={t("invite.title")} description={t("invite.description")}>
      <div className="flex flex-col gap-4">
        {full ? (
          <Callout title={t("invite.full.title")} icon={<CircleAlert className="size-5" />}>
            {t("error.seats_exhausted")}
          </Callout>
        ) : null}
        {invite.isError ? (
          <Callout
            tone="error"
            title={t("invite.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {explain(t, invite.error, INVITE_ERRORS)}
          </Callout>
        ) : null}
        <form.AppForm>
          <form.Form label={t("invite.title")}>
            <div className="flex max-w-3xl flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <form.AppField name="email">
                  {(field) => (
                    <field.TextField
                      type="email"
                      label={t("invite.email")}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={full}
                    />
                  )}
                </form.AppField>
              </div>
              <div className="w-48">
                <form.AppField name="role">
                  {(field) => (
                    <field.SelectField
                      label={t("invite.role")}
                      disabled={full}
                      options={WORKSPACE_ROLES.map((role) => ({
                        value: role,
                        label: t(ROLE_LABELS[role]),
                      }))}
                    />
                  )}
                </form.AppField>
              </div>
              <form.SubmitButton
                intent="primary"
                icon={<Send className="size-4" />}
                busy={invite.isPending}
                disabled={full}
              >
                {t("invite.send")}
              </form.SubmitButton>
            </div>
          </form.Form>
        </form.AppForm>
        <ul className="flex flex-col gap-1 text-sm text-text-muted">
          {WORKSPACE_ROLES.map((role) => (
            <li key={role}>
              <span className="font-semibold text-text">{t(ROLE_LABELS[role])}</span>
              {": "}
              {t(ROLE_HINTS[role])}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function PendingInvitations({
  space,
  items,
}: {
  space: Extract<Space, { kind: "workspace" }>;
  items: InvitationView[];
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [revoking, setRevoking] = useState<InvitationView | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: invitationsQuery(space.slug) }),
      queryClient.invalidateQueries({ queryKey: membersQuery(space.slug) }),
    ]);
  const revoke = useMutation({
    mutationFn: (invitation: InvitationView) => api.revokeInvitation(space.slug, invitation.id),
    onSuccess: async (_, invitation) => {
      setRevoking(null);
      await refresh();
      announce(t("pending.revoked", { email: invitation.email }));
    },
    onError: () => setRevoking(null),
  });
  // A new invitation to the same address replaces the pending one, with a new link and week.
  const resend = useMutation({
    mutationFn: (invitation: InvitationView) =>
      api.invite(space.slug, invitation.email, invitation.role),
    onSuccess: async (invitation) => {
      await refresh();
      announce(t("pending.resent", { email: invitation.email }));
    },
  });
  const failure = revoke.error ?? resend.error;
  return (
    <Panel id="pending" title={t("pending.title")} description={t("pending.description")}>
      <div className="flex flex-col gap-4">
        {failure ? (
          <Callout
            tone="error"
            title={t("members.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {explain(t, failure, INVITE_ERRORS)}
          </Callout>
        ) : null}
        {items.length === 0 ? (
          <p className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-text-muted">
            <MailPlus aria-hidden="true" className="size-4 shrink-0" />
            {t("pending.empty")}
          </p>
        ) : (
          <ul
            aria-label={t("pending.title")}
            className="divide-y divide-border rounded-md border border-border"
          >
            {items.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium break-all">
                    {invitation.email}
                    {invitation.source === "directory" ? (
                      <Badge emphasis="subtle">{t("pending.directory")}</Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-text-muted">
                    {invitation.source === "directory"
                      ? t("pending.directoryDetail", {
                          role: t(ROLE_LABELS[invitation.role]),
                          date: formatDate(invitation.expiresAt),
                        })
                      : t("pending.detail", {
                          role: t(ROLE_LABELS[invitation.role]),
                          inviter: invitation.invitedBy ?? t("pending.unknownInviter"),
                          date: formatDate(invitation.expiresAt),
                        })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    intent="ghost"
                    size="sm"
                    icon={<RotateCw className="size-4" />}
                    aria-label={t("pending.resendNamed", { email: invitation.email })}
                    busy={resend.isPending && resend.variables?.id === invitation.id}
                    disabled={resend.isPending}
                    onClick={() => resend.mutate(invitation)}
                  >
                    {t("pending.resend")}
                  </Button>
                  <Button
                    intent="ghost"
                    size="sm"
                    icon={<X className="size-4" />}
                    aria-label={t("pending.revokeNamed", { email: invitation.email })}
                    busy={revoke.isPending && revoke.variables?.id === invitation.id}
                    onClick={() => setRevoking(invitation)}
                  >
                    {t("pending.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={revoking !== null}
        title={t("pending.confirmRevoke.title", { email: revoking?.email ?? "" })}
        confirmLabel={t("pending.confirmRevoke.action")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<X className="size-4" />}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => (revoking ? revoke.mutate(revoking) : undefined)}
        onCancel={() => setRevoking(null)}
      >
        {t("pending.confirmRevoke.body")}
      </ConfirmDialog>
    </Panel>
  );
}
