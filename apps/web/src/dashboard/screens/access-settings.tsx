// The sharing and comment settings of the artifact page (plan section 6, "Acceso", and section 8):
// the three modes with who each lets in, the reader list with each person's comment exception,
// the Portifact bar, indexing and embedding, whether comments are on and who sees them. Each group
// saves where it is. The API applies the rules (account age for public, the reader cap, the
// policy generation); this explains them and shows its answers.
import {
  type AccessMode,
  type AccessPolicyView,
  type AccessUpdate,
  type AnnotationsState,
  type ArtifactSummary,
  type CommentVisibility,
  Email,
  LIMITS,
  type ReaderCommentVisibility,
} from "@portifact/contracts";
import { Button, Callout, ConfirmDialog, LoadingState, Panel, Select } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Eye,
  Info,
  RefreshCw,
  Save,
  UserMinus,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type Account, ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { threadsQuery } from "../review/use-threads.ts";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { CommentNoticeToggle } from "./comment-notices.tsx";
import { ACCOUNT_QUERY } from "./shell.tsx";

export const accessQuery = (artifactId: string) => ["artifact", artifactId, "access"] as const;

const MINUTE_MS = 60_000;
const MODES: readonly AccessMode[] = ["restricted", "authenticated", "public"];
const COMMENT_VISIBILITIES: readonly CommentVisibility[] = ["owner", "everyone"];
const COMMENT_MODES: readonly AnnotationsState[] = ["open", "locked", "off"];
/** States whose comment mode the owner can change (`checkAnnotationModeChange` in the domain). */
const COMMENT_MODE_STATES: readonly ArtifactSummary["state"][] = ["active", "archived", "draft"];

/** When the account may first make an artifact public, or null when that is not known. */
export function publicAvailableFrom(account: Account | null | undefined): Date | null {
  if (!account?.createdAt) return null;
  const created = Date.parse(account.createdAt);
  if (Number.isNaN(created)) return null;
  return new Date(created + LIMITS.publicAccessMinAccountAgeMinutes * MINUTE_MS);
}

/**
 * The artifact's access policy. It does not refresh on a timer, so a refresh never discards
 * unsaved choices; but when the artifact's access mode (which does refresh) stops matching it,
 * someone changed access elsewhere, such as from the CLI, and the policy is loaded again.
 */
function useAccessPolicy(artifact: ArtifactSummary) {
  const { api } = useDashboard();
  const access = useQuery({
    queryKey: accessQuery(artifact.id),
    queryFn: () => api.getAccess(artifact.id),
  });
  const stale = access.data !== undefined && access.data.mode !== artifact.accessMode;
  const { refetch } = access;
  // Only when the artifact's mode changes: right after a save the policy is ahead of it.
  useEffect(() => {
    if (stale) void refetch();
  }, [artifact.accessMode]);
  return access;
}

/** The policy's loading and error states, shared by every group that edits it. */
function PolicyGate({
  artifact,
  children,
}: {
  artifact: ArtifactSummary;
  children(policy: AccessPolicyView): ReactNode;
}) {
  const t = useT();
  const access = useAccessPolicy(artifact);
  if (access.isPending) return <LoadingState label={t("accessSettings.loading")} />;
  if (access.isError && !access.data) {
    return (
      <Callout
        tone="error"
        title={t("accessSettings.loadFailed.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => access.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, access.error)}
      </Callout>
    );
  }
  return <>{children(access.data)}</>;
}

/** The message for a failed access change, in the terms of the rule that refused it. */
function useAccessError(): (error: unknown) => string {
  const t = useT();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const minutes = LIMITS.publicAccessMinAccountAgeMinutes;
  return (error) => {
    const code = error instanceof ApiFailure ? error.code : "unexpected";
    if (code === "version_conflict") return t("accessSettings.conflict");
    if (code === "quota_exceeded") {
      return t("accessSettings.readersFull", { max: LIMITS.readersPerArtifact });
    }
    if (code === "account_too_new_for_public") {
      const from = publicAvailableFrom(queryClient.getQueryData<Account | null>(ACCOUNT_QUERY));
      return from
        ? t("accessSettings.tooNew", { minutes, date: formatDate(from.toISOString(), true) })
        : t("accessSettings.tooNewNoDate", { minutes });
    }
    return errorMessage(t, error);
  };
}

/** A change to the policy, applied to the cached policy and the artifact when it succeeds. */
function useAccessChange(artifactId: string) {
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  return useMutation({
    mutationFn: (update: AccessUpdate) => api.updateAccess(artifactId, update),
    onSuccess: async (next) => {
      queryClient.setQueryData(accessQuery(artifactId), next);
      await queryClient.invalidateQueries({ queryKey: ["artifact", artifactId], exact: true });
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
    },
    onError: async (error) => {
      // Someone changed the policy meanwhile: load the current one so the next try uses it.
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: accessQuery(artifactId) });
      }
    },
  });
}

interface SettingsValues {
  mode: AccessMode;
  indexable: boolean;
  embeddable: boolean;
  bar: boolean;
  commentVisibility: CommentVisibility;
}

/** The given fields that differ from the current policy, or undefined when nothing changed. */
export function settingsChange(
  policy: AccessPolicyView,
  values: Partial<SettingsValues>,
): AccessUpdate | undefined {
  const update: Record<string, unknown> = {};
  for (const key of ["mode", "indexable", "embeddable", "bar", "commentVisibility"] as const) {
    const value = values[key];
    if (value !== undefined && value !== policy[key]) update[key] = value;
  }
  return Object.keys(update).length > 0 ? (update as AccessUpdate) : undefined;
}

/** Saves a group of settings: announces the result, and on failure the callout says why. */
function useSettingsSave(artifactId: string) {
  const announce = useAnnounce();
  const change = useAccessChange(artifactId);
  const save = async (update: AccessUpdate, done: string) => {
    await change.mutateAsync(update).then(
      () => announce(done),
      () => {},
    );
  };
  return { change, save };
}

/** A group's error callout, its save button and whether it has unsaved choices. */
function SaveRow({
  dirty,
  label,
  busy,
  disabled,
}: {
  dirty: boolean;
  label: string;
  busy: boolean;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
      <SubmitInForm label={label} busy={busy} disabled={disabled} />
      {dirty ? (
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <span aria-hidden="true" className="size-2 rounded-full bg-text" />
          {t("settings.unsaved")}
        </p>
      ) : null}
    </div>
  );
}

function SaveError({ title, message }: { title: string; message: string | undefined }) {
  return message ? (
    <Callout tone="error" title={title} icon={<CircleAlert className="size-5" />}>
      {message}
    </Callout>
  ) : null;
}

/**
 * The sharing group of the artifact page: who can open it, the people added and how the link
 * opens, each saved where it is.
 */
export function SharingSettings({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const suspended = artifact.state === "suspended";
  return (
    <PolicyGate artifact={artifact}>
      {(policy) => (
        <>
          {suspended ? (
            <Callout title={t("accessSettings.suspended")} icon={<Info className="size-5" />} />
          ) : null}
          <AccessModePanel artifact={artifact} policy={policy} disabled={suspended} />
          <ReadersPanel artifact={artifact} policy={policy} disabled={suspended} />
          <LinkSettingsPanel artifact={artifact} policy={policy} disabled={suspended} />
        </>
      )}
    </PolicyGate>
  );
}

interface GroupProps {
  artifact: ArtifactSummary;
  policy: AccessPolicyView;
  disabled: boolean;
}

function AccessModePanel({ artifact, policy, disabled }: GroupProps) {
  const t = useT();
  const announce = useAnnounce();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const describeError = useAccessError();
  const { change, save } = useSettingsSave(artifact.id);
  const publicFrom = publicAvailableFrom(queryClient.getQueryData<Account | null>(ACCOUNT_QUERY));
  // Narrowing is always allowed; only opening to the public waits for the account's age.
  const publicLocked =
    policy.mode !== "public" && publicFrom !== null && publicFrom.getTime() > Date.now();

  const options = MODES.map((mode) => ({
    value: mode,
    label: t(`access.${mode}`),
    description:
      mode === "public" && publicLocked && publicFrom ? (
        <>
          <span className="block">{t("accessSettings.mode.public")}</span>
          <span className="mt-1 block font-medium text-text">
            {t("accessSettings.mode.publicFrom", {
              date: formatDate(publicFrom.toISOString(), true),
              minutes: LIMITS.publicAccessMinAccountAgeMinutes,
            })}
          </span>
        </>
      ) : (
        t(`accessSettings.mode.${mode}`)
      ),
    disabled: mode === "public" && publicLocked,
  }));

  return (
    <Panel
      headingLevel={3}
      title={t("accessSettings.title")}
      description={t("accessSettings.republish")}
    >
      <GroupForm
        // Start over from the server's values whenever they change, such as after a conflict.
        key={policy.mode}
        label={t("accessSettings.mode.legend")}
        defaults={{ mode: policy.mode }}
        changed={(values) => settingsChange(policy, values) !== undefined}
        onSubmit={async (values) => {
          const update = settingsChange(policy, values);
          if (!update) announce(t("accessSettings.unchanged"));
          else await save(update, t("accessSettings.saved"));
        }}
        error={
          <SaveError
            title={t("accessSettings.saveFailed.title")}
            message={change.isError ? describeError(change.error) : undefined}
          />
        }
        save={t("accessSettings.save")}
        busy={change.isPending}
        disabled={disabled}
      >
        {(form) => (
          <form.AppField name="mode">
            {(field) => (
              <field.RadioGroupField
                legend={t("accessSettings.mode.legend")}
                options={options}
                disabled={disabled}
              />
            )}
          </form.AppField>
        )}
      </GroupForm>
    </Panel>
  );
}

function LinkSettingsPanel({ artifact, policy, disabled }: GroupProps) {
  const t = useT();
  const announce = useAnnounce();
  const describeError = useAccessError();
  const { change, save } = useSettingsSave(artifact.id);
  return (
    <Panel
      headingLevel={3}
      title={t("linkSettings.title")}
      description={t("linkSettings.description")}
    >
      <GroupForm
        key={`${policy.bar}:${policy.indexable}:${policy.embeddable}`}
        label={t("linkSettings.title")}
        defaults={{ bar: policy.bar, indexable: policy.indexable, embeddable: policy.embeddable }}
        changed={(values) => settingsChange(policy, values) !== undefined}
        onSubmit={async (values) => {
          const update = settingsChange(policy, values);
          if (!update) announce(t("linkSettings.unchanged"));
          else await save(update, t("linkSettings.saved"));
        }}
        error={
          <SaveError
            title={t("linkSettings.saveFailed.title")}
            message={change.isError ? describeError(change.error) : undefined}
          />
        }
        save={t("linkSettings.save")}
        busy={change.isPending}
        disabled={disabled}
      >
        {(form) => (
          <div className="flex flex-col gap-4">
            <form.AppField name="bar">
              {(field) => (
                <field.CheckboxField
                  label={t("accessSettings.bar.label")}
                  description={t("accessSettings.bar.hint")}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.AppField name="indexable">
              {(field) => (
                <field.CheckboxField
                  label={t("accessSettings.indexable.label")}
                  description={t("accessSettings.indexable.hint")}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.AppField name="embeddable">
              {(field) => (
                <field.CheckboxField
                  label={t("accessSettings.embeddable.label")}
                  description={t("accessSettings.embeddable.hint")}
                  disabled={disabled}
                />
              )}
            </form.AppField>
          </div>
        )}
      </GroupForm>
    </Panel>
  );
}

/** The comments group: whether people can comment and who sees the comments. */
export function CommentSettings({ artifact }: { artifact: ArtifactSummary }) {
  return (
    <PolicyGate artifact={artifact}>
      {(policy) => <CommentSettingsPanel artifact={artifact} policy={policy} />}
    </PolicyGate>
  );
}

interface CommentChange {
  mode?: AnnotationsState;
  visibility?: CommentVisibility;
}

function CommentSettingsPanel({
  artifact,
  policy,
}: {
  artifact: ArtifactSummary;
  policy: AccessPolicyView;
}) {
  const t = useT();
  const announce = useAnnounce();
  const describeError = useAccessError();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const disabled = !COMMENT_MODE_STATES.includes(artifact.state);
  // A change that shows every comment to everyone waits here for the owner's confirmation.
  const [widening, setWidening] = useState<CommentChange | null>(null);
  const change = useMutation({
    mutationFn: async ({ mode, visibility }: CommentChange) => {
      if (mode) await api.setAnnotationMode(artifact.id, mode);
      if (visibility) {
        const next = await api.updateAccess(artifact.id, { commentVisibility: visibility });
        queryClient.setQueryData(accessQuery(artifact.id), next);
      }
    },
    onSettled: async (_data, error) => {
      if (error instanceof ApiFailure && error.code === "version_conflict") {
        await queryClient.invalidateQueries({ queryKey: accessQuery(artifact.id) });
      }
      await queryClient.invalidateQueries({ queryKey: ["artifact", artifact.id], exact: true });
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      await queryClient.invalidateQueries({ queryKey: threadsQuery(artifact.id) });
    },
  });
  const save = (update: CommentChange) =>
    change.mutateAsync(update).then(
      () => announce(t("commentSettings.saved")),
      () => {},
    );
  const changes = (values: { mode: AnnotationsState; commentVisibility: CommentVisibility }) => ({
    ...(values.mode === artifact.annotations ? {} : { mode: values.mode }),
    ...(values.commentVisibility === policy.commentVisibility
      ? {}
      : { visibility: values.commentVisibility }),
  });

  return (
    <Panel headingLevel={3} title={t("commentSettings.title")}>
      <GroupForm
        key={`${artifact.annotations}:${policy.commentVisibility}`}
        label={t("commentSettings.title")}
        defaults={{ mode: artifact.annotations, commentVisibility: policy.commentVisibility }}
        changed={(values) => Object.keys(changes(values)).length > 0}
        onSubmit={async (values) => {
          const update = changes(values);
          if (Object.keys(update).length === 0) {
            announce(t("commentSettings.unchanged"));
            return;
          }
          // Widening is retroactive: every comment already written becomes visible.
          if (update.visibility === "everyone") {
            setWidening(update);
            return;
          }
          await save(update);
        }}
        error={
          <SaveError
            title={t("commentSettings.saveFailed.title")}
            message={change.isError ? describeError(change.error) : undefined}
          />
        }
        save={t("commentSettings.save")}
        busy={change.isPending}
        disabled={disabled}
      >
        {(form) => (
          <div className="flex flex-col gap-6">
            <form.AppField name="mode">
              {(field) => (
                <field.RadioGroupField
                  legend={t("commentSettings.mode.legend")}
                  layout="row"
                  options={COMMENT_MODES.map((value) => ({
                    value,
                    label: t(`commentSettings.mode.${value}`),
                    description: t(`commentSettings.mode.${value}.hint`),
                  }))}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <div className="flex flex-col gap-2">
              <form.AppField name="commentVisibility">
                {(field) => (
                  <field.RadioGroupField
                    legend={t("accessSettings.comments.legend")}
                    options={COMMENT_VISIBILITIES.map((value) => ({
                      value,
                      label: t(`accessSettings.comments.${value}`),
                      description: t(`accessSettings.comments.${value}.hint`),
                    }))}
                    disabled={disabled || artifact.state === "suspended"}
                  />
                )}
              </form.AppField>
              <p className="text-sm text-text-muted">{t("accessSettings.comments.exceptions")}</p>
            </div>
          </div>
        )}
      </GroupForm>
      <ConfirmDialog
        open={widening !== null}
        title={t("accessSettings.comments.confirm.title")}
        confirmLabel={t("accessSettings.comments.confirm.action")}
        cancelLabel={t("accessSettings.cancel")}
        confirmIcon={<Eye className="size-4" />}
        busy={change.isPending}
        onConfirm={() => {
          const update = widening;
          setWidening(null);
          if (update) void save(update);
        }}
        onCancel={() => setWidening(null)}
      >
        {t("accessSettings.comments.confirm.body")}
      </ConfirmDialog>
      <div className="mt-6 border-t border-border pt-6">
        <CommentNoticeToggle artifactId={artifact.id} explainPlan />
      </div>
    </Panel>
  );
}

/** The form of one settings group, typed by its values. */
function useGroupForm<V extends Record<string, unknown>>(
  defaults: V,
  onSubmit: (values: V) => Promise<void>,
) {
  return useAppForm({ defaultValues: defaults, onSubmit: ({ value }) => onSubmit(value) });
}

type GroupFormApi<V extends Record<string, unknown>> = ReturnType<typeof useGroupForm<V>>;

/**
 * One group's form: its fields, the error of its last save, and its save button with the
 * unsaved-changes note, so each setting is saved where it is.
 */
function GroupForm<V extends Record<string, unknown>>({
  label,
  defaults,
  changed,
  onSubmit,
  error,
  save,
  busy,
  disabled,
  children,
}: {
  label: string;
  defaults: V;
  changed(values: V): boolean;
  onSubmit(values: V): Promise<void>;
  error: ReactNode;
  save: string;
  busy: boolean;
  disabled: boolean;
  children(form: GroupFormApi<V>): ReactNode;
}) {
  const form = useGroupForm(defaults, onSubmit);
  return (
    <form.AppForm>
      <form.Form label={label}>
        <div className="flex flex-col gap-5">
          {error}
          {children(form)}
          <form.Subscribe selector={(state) => state.values}>
            {(values) => (
              <SaveRow dirty={changed(values)} label={save} busy={busy} disabled={disabled} />
            )}
          </form.Subscribe>
        </div>
      </form.Form>
    </form.AppForm>
  );
}

function SubmitInForm({
  label,
  busy,
  disabled,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <Button
      type="submit"
      intent="primary"
      icon={<Save className="size-4" />}
      busy={busy}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

interface ReadersChange {
  /** Sends a change, announces `done` when it applies and says whether it did. */
  onChange(update: AccessUpdate, done: string): Promise<boolean>;
}

function ReadersPanel({ artifact, policy, disabled }: GroupProps) {
  const t = useT();
  const announce = useAnnounce();
  const describeError = useAccessError();
  const readers = useAccessChange(artifact.id);
  const pending = readers.isPending ? readers.variables : undefined;
  const max = LIMITS.readersPerArtifact;
  const full = policy.readers.length >= max;
  const onChange: ReadersChange["onChange"] = (update, done) =>
    readers.mutateAsync(update).then(
      () => {
        announce(done);
        return true;
      },
      () => false,
    );

  return (
    <Panel
      headingLevel={3}
      title={t("readers.title")}
      description={
        <>
          <span className="block">{t("readers.hint")}</span>
          <span className="mt-1 block">{t("readers.comments.hint")}</span>
        </>
      }
      actions={
        <p className="text-sm font-medium tabular-nums">
          {t("readers.count", { count: policy.readers.length, max })}
        </p>
      }
    >
      <div className="flex flex-col gap-4">
        <SaveError
          title={t("readers.failed.title")}
          message={readers.isError ? describeError(readers.error) : undefined}
        />
        {policy.readers.length === 0 ? (
          <p className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-text-muted">
            <UsersRound aria-hidden="true" className="size-4 shrink-0" />
            {t("readers.empty")}
          </p>
        ) : (
          <ul
            aria-label={t("readers.list")}
            className="divide-y divide-border rounded-md border border-border"
          >
            {policy.readers.map((email) => (
              // Stacked on narrow screens: the address on its own line, its controls below.
              <li
                key={email}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:py-2"
              >
                <span className="min-w-0 flex-1 text-sm font-medium break-all">{email}</span>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                    <ReaderComments
                      email={email}
                      policy={policy}
                      disabled={disabled || pending !== undefined}
                      onChange={onChange}
                    />
                  </div>
                  <Button
                    intent="ghost"
                    size="sm"
                    icon={<UserMinus className="size-4" />}
                    aria-label={t("readers.removeLabel", { email })}
                    busy={pending?.removeReaders?.includes(email) ?? false}
                    disabled={disabled || pending !== undefined}
                    onClick={() =>
                      onChange({ removeReaders: [email] }, t("readers.removed", { email }))
                    }
                  >
                    {t("readers.remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-border pt-4">
          {full ? <p className="mb-3 text-sm font-medium">{t("readers.full", { max })}</p> : null}
          <AddReaderForm
            readers={policy.readers}
            disabled={disabled || full}
            busy={pending?.addReaders !== undefined}
            onAdd={(email) => onChange({ addReaders: [email] }, t("readers.added", { email }))}
          />
        </div>
      </div>
    </Panel>
  );
}

/** One reader's exception to who sees comments, sent as soon as it changes. */
function ReaderComments({
  email,
  policy,
  disabled,
  onChange,
}: {
  email: string;
  policy: AccessPolicyView;
  disabled: boolean;
  onChange: ReadersChange["onChange"];
}) {
  const t = useT();
  const [widening, setWidening] = useState<ReaderCommentVisibility | null>(null);
  const current: ReaderCommentVisibility =
    policy.readerCommentVisibility.find((entry) => entry.email === email)?.commentVisibility ??
    "inherit";
  const label = (choice: ReaderCommentVisibility) =>
    choice === "inherit"
      ? t(`readers.comments.inherit.${policy.commentVisibility}`)
      : t(`readers.comments.${choice}`);
  const sees = (choice: ReaderCommentVisibility) =>
    choice === "inherit" ? (policy.commentVisibility === "everyone" ? "all" : "own") : choice;
  const send = (choice: ReaderCommentVisibility) =>
    onChange(
      { readerCommentVisibility: [{ email, commentVisibility: choice }] },
      t("readers.comments.changed", { email, choice: label(choice) }),
    );
  return (
    <>
      <Select<ReaderCommentVisibility>
        label={t("readers.comments.label", { email })}
        labelVisible={false}
        value={current}
        options={(["inherit", "all", "own"] as const).map((value) => ({
          value,
          label: label(value),
        }))}
        disabled={disabled}
        onChange={(choice) => {
          // Showing every comment is retroactive, so it waits for a confirmation.
          if (sees(choice) === "all" && sees(current) === "own") setWidening(choice);
          else void send(choice);
        }}
      />
      <ConfirmDialog
        open={widening !== null}
        title={t("readers.comments.confirm.title", { email })}
        confirmLabel={t("accessSettings.comments.confirm.action")}
        cancelLabel={t("accessSettings.cancel")}
        confirmIcon={<Eye className="size-4" />}
        onConfirm={() => {
          const choice = widening;
          setWidening(null);
          if (choice) void send(choice);
        }}
        onCancel={() => setWidening(null)}
      >
        {t("readers.comments.confirm.body", { email })}
      </ConfirmDialog>
    </>
  );
}

function AddReaderForm({
  readers,
  disabled,
  busy,
  onAdd,
}: {
  readers: readonly string[];
  disabled: boolean;
  busy: boolean;
  onAdd(email: string): Promise<boolean>;
}) {
  const t = useT();
  const form = useAppForm({
    defaultValues: { email: "" },
    validationLogic: revalidateLogic(),
    validators: {
      // The same rule as the API (packages/contracts), with the dashboard's own wording.
      onDynamic: ({ value }) => {
        const parsed = Email.safeParse(value.email.trim());
        if (!parsed.success) return { fields: { email: t("readers.invalid") } };
        if (readers.includes(parsed.data)) {
          return { fields: { email: t("readers.duplicate", { email: parsed.data }) } };
        }
        return undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      if (await onAdd(Email.parse(value.email.trim()))) formApi.reset();
    },
  });

  return (
    <form.AppForm>
      <form.Form label={t("readers.add")}>
        <div className="flex max-w-xl flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  type="email"
                  label={t("readers.email.label")}
                  description={t("readers.email.hint")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
              )}
            </form.AppField>
          </div>
          <form.SubmitButton
            intent="secondary"
            icon={<UserPlus className="size-4" />}
            busy={busy}
            disabled={disabled}
          >
            {t("readers.add")}
          </form.SubmitButton>
        </div>
      </form.Form>
    </form.AppForm>
  );
}
