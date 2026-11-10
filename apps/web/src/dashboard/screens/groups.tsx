// The Groups page of a workspace (`/groups?workspace=<slug>`, premium plan T3, decision 0014).
// Only admins manage groups, and only here: creating one by name, renaming it, adding the
// workspace's members to it, removing them and deleting it, each deletion after a confirmation.
// Editors use groups in an artifact's access settings and see only names and counts there. The
// API decides every write again; without the feature in the plan, creating and adding are not
// offered, and the page says groups grant nothing until it returns.
import {
  lowestPlanWith,
  PLAN_LABELS,
  WORKSPACE_GROUPS,
  WorkspaceGroupName,
  type WorkspaceGroupView,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  PageHeader,
  Select,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Info,
  Pencil,
  Trash2,
  Unlink,
  UserMinus,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { type Space, spaceCan, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { membersQuery } from "./members.tsx";
import { SpaceBadge } from "./space-parts.tsx";

export const groupsQuery = (slug: string) => ["workspace", slug, "groups"] as const;
const groupQuery = (slug: string, groupId: string) =>
  ["workspace", slug, "groups", groupId] as const;

type Workspace = Extract<Space, { kind: "workspace" }>;

export function GroupsScreen() {
  const t = useT();
  useDocumentTitle(t("groups.title"));
  const space = useReadySpace();
  if (space.kind === "personal") {
    return (
      <>
        <PageHeader title={t("groups.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("groups.personal.title")}>{t("groups.personal.body")}</Callout>
      </>
    );
  }
  if (!spaceCan(space, "members")) {
    return (
      <>
        <PageHeader title={t("groups.title")} meta={<SpaceBadge owner={space} />} />
        <Callout title={t("groups.adminOnly.title")}>{t("groups.adminOnly.body")}</Callout>
      </>
    );
  }
  return <WorkspaceGroups space={space} />;
}

function WorkspaceGroups({ space }: { space: Workspace }) {
  const t = useT();
  const { api } = useDashboard();
  const list = useQuery({
    queryKey: groupsQuery(space.slug),
    queryFn: () => api.groups(space.slug),
    ...refreshOptions,
  });
  const available = list.data?.available ?? true;
  const full = (list.data?.items.length ?? 0) >= WORKSPACE_GROUPS.perWorkspace;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("groups.title")}
        meta={<SpaceBadge owner={space} />}
        description={t("groups.description", { workspace: space.name })}
      />
      {list.data && !available ? (
        <Callout tone="info" title={t("groups.planTitle")} icon={<Info className="size-5" />}>
          {t("groups.planRequired", { plan: PLAN_LABELS[lowestPlanWith("workspaces")] })}
        </Callout>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <Section id="groups" title={t("groups.list.title")}>
            <Loaded query={list} loading={t("groups.loading")} error={t("groups.loadFailed")}>
              {(data) =>
                data.items.length === 0 ? (
                  <EmptyState
                    title={t("groups.empty.title")}
                    icon={<UsersRound className="size-8" />}
                  >
                    <p>{t("groups.empty.body")}</p>
                  </EmptyState>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {data.items.map((group) => (
                      <GroupCard
                        key={group.id}
                        space={space}
                        group={group}
                        available={data.available}
                      />
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </Section>
        </div>
        <CreateGroup space={space} disabled={!list.data || !available || full} full={full} />
      </div>
    </div>
  );
}

function CreateGroup({
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
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const create = useMutation({
    mutationFn: (value: string) => api.createGroup(space.slug, value),
    onSuccess: async (group) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: groupsQuery(space.slug) });
      announce(t("groups.created", { name: group.name }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = WorkspaceGroupName.safeParse(name);
    setInvalid(!parsed.success);
    if (parsed.success) create.mutate(parsed.data);
  };
  return (
    <Section id="create-group" title={t("groups.create.title")} hint={t("groups.create.hint")}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {full ? (
          <p className="text-sm text-text-muted">
            {t("groups.create.limit", { limit: WORKSPACE_GROUPS.perWorkspace })}
          </p>
        ) : null}
        <TextInput
          label={t("groups.create.name")}
          autoComplete="off"
          required
          maxLength={WORKSPACE_GROUPS.nameMaxLength}
          value={name}
          disabled={disabled}
          error={
            invalid ? t("groups.nameError", { max: WORKSPACE_GROUPS.nameMaxLength }) : undefined
          }
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {create.isError ? (
          <Callout
            tone="error"
            title={t("groups.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, create.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<UsersRound className="size-4" />}
            busy={create.isPending}
            disabled={disabled}
          >
            {t("groups.create.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function GroupCard({
  space,
  group,
  available,
}: {
  space: Workspace;
  group: WorkspaceGroupView;
  available: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: groupsQuery(space.slug) });
  const stop = useMutation({
    mutationFn: () => api.stopGroupSync(space.slug, group.id),
    onSuccess: async () => {
      setStopping(false);
      await refresh();
      announce(t("groups.stopSync.done", { name: group.name }));
    },
    onError: () => setStopping(false),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(space.slug, group.id),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      announce(t("groups.deleted", { name: group.name }));
    },
    onError: () => setConfirming(false),
  });
  const membersId = `group-${group.id}-members`;
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold break-words">
            {group.name}
            {group.directory ? <Badge emphasis="subtle">{t("groups.directory")}</Badge> : null}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t("groups.memberCount", { count: group.members })}
          </p>
          {group.directory ? (
            <p className="mt-1 text-sm text-text-muted">{t("groups.directoryNote")}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<UsersRound className="size-4" />}
            aria-expanded={open}
            aria-controls={membersId}
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? "groups.hideMembers" : "groups.showMembers")}
          </Button>
          {group.directory ? (
            <Button
              size="sm"
              icon={<Unlink className="size-4" />}
              aria-label={t("groups.stopSyncLabel", { name: group.name })}
              disabled={stop.isPending}
              onClick={() => setStopping(true)}
            >
              {t("groups.stopSync")}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                icon={<Pencil className="size-4" />}
                aria-label={t("groups.renameLabel", { name: group.name })}
                onClick={() => setRenaming((value) => !value)}
              >
                {t("groups.rename")}
              </Button>
              <Button
                size="sm"
                intent="danger"
                icon={<Trash2 className="size-4" />}
                aria-label={t("groups.deleteLabel", { name: group.name })}
                disabled={remove.isPending}
                onClick={() => setConfirming(true)}
              >
                {t("groups.delete")}
              </Button>
            </>
          )}
        </div>
      </div>
      {renaming ? (
        <RenameGroup space={space} group={group} onDone={() => setRenaming(false)} />
      ) : null}
      {open ? (
        <div id={membersId}>
          <GroupMembers space={space} group={group} available={available} />
        </div>
      ) : null}
      {remove.isError || stop.isError ? (
        <Callout
          tone="error"
          title={t("groups.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, remove.error ?? stop.error)}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={stopping}
        title={t("groups.stopSync.title", { name: group.name })}
        confirmLabel={t("groups.stopSync")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Unlink className="size-4" />}
        busy={stop.isPending}
        onConfirm={() => stop.mutate()}
        onCancel={() => setStopping(false)}
      >
        {t("groups.stopSync.body")}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming}
        title={t("groups.confirm.title", { name: group.name })}
        confirmLabel={t("groups.delete")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("groups.confirm.body")}
      </ConfirmDialog>
    </li>
  );
}

function RenameGroup({
  space,
  group,
  onDone,
}: {
  space: Workspace;
  group: WorkspaceGroupView;
  onDone(): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [name, setName] = useState(group.name);
  const [invalid, setInvalid] = useState(false);
  const rename = useMutation({
    mutationFn: (value: string) => api.renameGroup(space.slug, group.id, value),
    onSuccess: async (renamed) => {
      await queryClient.invalidateQueries({ queryKey: groupsQuery(space.slug) });
      announce(t("groups.renamed", { name: renamed.name }));
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = WorkspaceGroupName.safeParse(name);
    setInvalid(!parsed.success);
    if (parsed.success) rename.mutate(parsed.data);
  };
  return (
    <form className="flex flex-col gap-3 border-t border-border pt-3" onSubmit={submit} noValidate>
      <TextInput
        label={t("groups.renameField", { name: group.name })}
        autoComplete="off"
        required
        maxLength={WORKSPACE_GROUPS.nameMaxLength}
        value={name}
        error={invalid ? t("groups.nameError", { max: WORKSPACE_GROUPS.nameMaxLength }) : undefined}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      {rename.isError ? (
        <Callout
          tone="error"
          title={t("groups.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, rename.error)}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" intent="primary" busy={rename.isPending}>
          {t("groups.save")}
        </Button>
        <Button onClick={onDone}>{t("account.cancel")}</Button>
      </div>
    </form>
  );
}

function GroupMembers({
  space,
  group,
  available,
}: {
  space: Workspace;
  group: WorkspaceGroupView;
  available: boolean;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const detail = useQuery({
    queryKey: groupQuery(space.slug, group.id),
    queryFn: () => api.group(space.slug, group.id),
  });
  const members = useQuery({
    queryKey: membersQuery(space.slug),
    queryFn: () => api.members(space.slug),
  });
  const [choice, setChoice] = useState("");
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: groupQuery(space.slug, group.id) });
    await queryClient.invalidateQueries({ queryKey: groupsQuery(space.slug), exact: true });
  };
  const add = useMutation({
    mutationFn: (userId: string) => api.addGroupMember(space.slug, group.id, userId),
    onSuccess: async (_, userId) => {
      setChoice("");
      await refresh();
      const name = members.data?.items.find((m) => m.userId === userId)?.name ?? "";
      announce(t("groups.memberAdded", { name, group: group.name }));
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(space.slug, group.id, userId),
    onSuccess: async (_, userId) => {
      const name = detail.data?.items.find((m) => m.userId === userId)?.name ?? "";
      await refresh();
      announce(t("groups.memberRemoved", { name, group: group.name }));
    },
  });
  if (detail.isPending) return <LoadingState label={t("groups.membersLoading")} />;
  if (!detail.data) {
    return (
      <Callout
        tone="error"
        title={t("groups.loadFailed")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, detail.error)}
      </Callout>
    );
  }
  const inGroup = new Set(detail.data.items.map((m) => m.userId));
  const candidates = (members.data?.items ?? []).filter((m) => !inGroup.has(m.userId));
  const failure = add.error ?? remove.error;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {detail.data.items.length === 0 ? (
        <p className="text-sm text-text-muted">{t("groups.noMembers")}</p>
      ) : (
        <ul
          aria-label={t("groups.membersOf", { name: group.name })}
          className="divide-y divide-border rounded-md border border-border"
        >
          {detail.data.items.map((member) => (
            <li
              key={member.userId}
              className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium break-words">{member.name}</span>{" "}
                <span className="text-text-muted break-all">{member.email}</span>
              </span>
              {group.directory ? null : (
                <Button
                  intent="ghost"
                  size="sm"
                  icon={<UserMinus className="size-4" />}
                  aria-label={t("groups.removeMemberLabel", {
                    name: member.name,
                    group: group.name,
                  })}
                  busy={remove.isPending && remove.variables === member.userId}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member.userId)}
                >
                  {t("groups.removeMember")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure ? (
        <Callout
          tone="error"
          title={t("groups.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, failure)}
        </Callout>
      ) : null}
      {available && !group.directory && candidates.length > 0 ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) add.mutate(choice);
          }}
        >
          <div className="min-w-0 flex-1">
            <Select
              label={t("groups.addMember", { name: group.name })}
              value={choice}
              options={[
                { value: "", label: t("groups.chooseMember") },
                ...candidates.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` })),
              ]}
              onChange={setChoice}
            />
          </div>
          <Button
            type="submit"
            icon={<UserPlus className="size-4" />}
            busy={add.isPending}
            disabled={choice === ""}
          >
            {t("groups.add")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
