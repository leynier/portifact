// The access section of the artifact page (plan section 6, "Acceso"): the three modes with who
// each lets in, the reader list, indexing, embedding and who sees the comments (plan section 8,
// with an exception per reader). The API applies the rules (account age for public, the reader
// cap, the policy generation); this explains them and shows its answers.
import {
  type AccessMode,
  type AccessPolicyView,
  type AccessUpdate,
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
import { type ReactNode, useState } from "react";
import { type Account, ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { ACCOUNT_QUERY } from "./shell.tsx";

export const accessQuery = (artifactId: string) => ["artifact", artifactId, "access"] as const;

const DAY_MS = 86_400_000;
const MODES: readonly AccessMode[] = ["restricted", "authenticated", "public"];
const COMMENT_VISIBILITIES: readonly CommentVisibility[] = ["owner", "everyone"];

/** When the account may first make an artifact public, or null when that is not known. */
export function publicAvailableFrom(account: Account | null | undefined): Date | null {
  if (!account?.createdAt) return null;
  const created = Date.parse(account.createdAt);
  if (Number.isNaN(created)) return null;
  return new Date(created + LIMITS.publicAccessMinAccountAgeDays * DAY_MS);
}

export function AccessSettings({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const { api } = useDashboard();
  const access = useQuery({
    queryKey: accessQuery(artifact.id),
    queryFn: () => api.getAccess(artifact.id),
  });

  let body: ReactNode;
  if (access.isPending) {
    body = <LoadingState label={t("accessSettings.loading")} />;
  } else if (access.isError && !access.data) {
    body = (
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
  } else {
    body = <AccessEditor artifact={artifact} policy={access.data} />;
  }

  return (
    <Panel
      id="access"
      title={t("accessSettings.title")}
      description={t("accessSettings.republish")}
    >
      {body}
    </Panel>
  );
}

/** The message for a failed access change, in the terms of the rule that refused it. */
function useAccessError(): (error: unknown) => string {
  const t = useT();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const days = LIMITS.publicAccessMinAccountAgeDays;
  return (error) => {
    const code = error instanceof ApiFailure ? error.code : "unexpected";
    if (code === "version_conflict") return t("accessSettings.conflict");
    if (code === "quota_exceeded") {
      return t("accessSettings.readersFull", { max: LIMITS.readersPerArtifact });
    }
    if (code === "account_too_new_for_public") {
      const from = publicAvailableFrom(queryClient.getQueryData<Account | null>(ACCOUNT_QUERY));
      return from
        ? t("accessSettings.tooNew", { days, date: formatDate(from.toISOString()) })
        : t("accessSettings.tooNewNoDate", { days });
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

function AccessEditor({
  artifact,
  policy,
}: {
  artifact: ArtifactSummary;
  policy: AccessPolicyView;
}) {
  const t = useT();
  const announce = useAnnounce();
  const describeError = useAccessError();
  const suspended = artifact.state === "suspended";
  const settings = useAccessChange(artifact.id);
  const readers = useAccessChange(artifact.id);
  // A change that shows every comment to everyone waits here for the owner's confirmation.
  const [widening, setWidening] = useState<AccessUpdate | null>(null);
  const saveSettings = async (update: AccessUpdate) => {
    // On failure the callout above, an alert, says why.
    await settings.mutateAsync(update).then(
      () => announce(t("accessSettings.saved")),
      () => {},
    );
  };

  return (
    <div className="flex flex-col gap-8">
      {suspended ? (
        <Callout title={t("accessSettings.suspended")} icon={<Info className="size-5" />} />
      ) : null}
      <div>
        {settings.isError ? (
          <div className="mb-4">
            <Callout
              tone="error"
              title={t("accessSettings.saveFailed.title")}
              icon={<CircleAlert className="size-5" />}
            >
              {describeError(settings.error)}
            </Callout>
          </div>
        ) : null}
        <SettingsForm
          // Start over from the server's values whenever they change, such as after a conflict.
          key={`${policy.mode}:${policy.indexable}:${policy.embeddable}:${policy.bar}:${policy.commentVisibility}`}
          policy={policy}
          disabled={suspended}
          busy={settings.isPending}
          onSave={async (update) => {
            if (!update) {
              announce(t("accessSettings.unchanged"));
              return;
            }
            // Widening is retroactive: every comment already written becomes visible.
            if (update.commentVisibility === "everyone") {
              setWidening(update);
              return;
            }
            await saveSettings(update);
          }}
        />
        <ConfirmDialog
          open={widening !== null}
          title={t("accessSettings.comments.confirm.title")}
          confirmLabel={t("accessSettings.comments.confirm.action")}
          cancelLabel={t("accessSettings.cancel")}
          confirmIcon={<Eye className="size-4" />}
          busy={settings.isPending}
          onConfirm={() => {
            const update = widening;
            setWidening(null);
            if (update) void saveSettings(update);
          }}
          onCancel={() => setWidening(null)}
        >
          {t("accessSettings.comments.confirm.body")}
        </ConfirmDialog>
      </div>
      <Readers
        policy={policy}
        disabled={suspended}
        error={readers.isError ? describeError(readers.error) : undefined}
        pending={readers.isPending ? readers.variables : undefined}
        onChange={(update, done) =>
          readers.mutateAsync(update).then(
            () => {
              announce(done);
              return true;
            },
            () => false,
          )
        }
      />
    </div>
  );
}

interface SettingsValues {
  mode: AccessMode;
  indexable: boolean;
  embeddable: boolean;
  bar: boolean;
  commentVisibility: CommentVisibility;
}

/** The fields that differ from the current policy, or undefined when nothing changed. */
export function settingsChange(
  policy: AccessPolicyView,
  values: SettingsValues,
): AccessUpdate | undefined {
  const update = {
    ...(values.mode === policy.mode ? {} : { mode: values.mode }),
    ...(values.indexable === policy.indexable ? {} : { indexable: values.indexable }),
    ...(values.embeddable === policy.embeddable ? {} : { embeddable: values.embeddable }),
    ...(values.bar === policy.bar ? {} : { bar: values.bar }),
    ...(values.commentVisibility === policy.commentVisibility
      ? {}
      : { commentVisibility: values.commentVisibility }),
  };
  return Object.keys(update).length > 0 ? update : undefined;
}

function SettingsForm({
  policy,
  disabled,
  busy,
  onSave,
}: {
  policy: AccessPolicyView;
  disabled: boolean;
  busy: boolean;
  onSave(update: AccessUpdate | undefined): Promise<void>;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const publicFrom = publicAvailableFrom(queryClient.getQueryData<Account | null>(ACCOUNT_QUERY));
  // Narrowing is always allowed; only opening to the public waits for the account's age.
  const publicLocked =
    policy.mode !== "public" && publicFrom !== null && publicFrom.getTime() > Date.now();

  const form = useAppForm({
    defaultValues: {
      mode: policy.mode,
      indexable: policy.indexable,
      embeddable: policy.embeddable,
      bar: policy.bar,
      commentVisibility: policy.commentVisibility,
    } as SettingsValues,
    onSubmit: ({ value }) => onSave(settingsChange(policy, value)),
  });

  const options = MODES.map((mode) => ({
    value: mode,
    label: t(`access.${mode}`),
    description:
      mode === "public" && publicLocked && publicFrom ? (
        <>
          <span className="block">{t("accessSettings.mode.public")}</span>
          <span className="mt-1 block font-medium text-text">
            {t("accessSettings.mode.publicFrom", {
              date: formatDate(publicFrom.toISOString()),
              days: LIMITS.publicAccessMinAccountAgeDays,
            })}
          </span>
        </>
      ) : (
        t(`accessSettings.mode.${mode}`)
      ),
    disabled: mode === "public" && publicLocked,
  }));

  return (
    <form.AppForm>
      <form.Form label={t("accessSettings.mode.legend")}>
        <div className="flex flex-col gap-6">
          <form.AppField name="mode">
            {(field) => (
              <field.RadioGroupField
                legend={t("accessSettings.mode.legend")}
                options={options}
                disabled={disabled}
              />
            )}
          </form.AppField>
          <div className="flex flex-col gap-4">
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
            <form.AppField name="bar">
              {(field) => (
                <field.CheckboxField
                  label={t("accessSettings.bar.label")}
                  description={t("accessSettings.bar.hint")}
                  disabled={disabled}
                />
              )}
            </form.AppField>
          </div>
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
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <p className="text-sm text-text-muted">{t("accessSettings.comments.exceptions")}</p>
          </div>
          <div>
            <form.SubmitButton icon={<Save className="size-4" />} busy={busy} disabled={disabled}>
              {t("accessSettings.save")}
            </form.SubmitButton>
          </div>
        </div>
      </form.Form>
    </form.AppForm>
  );
}

interface ReadersProps {
  policy: AccessPolicyView;
  disabled: boolean;
  error: string | undefined;
  /** The change being sent, so its control shows as busy. */
  pending: AccessUpdate | undefined;
  /** Sends a change, announces `done` when it applies and says whether it did. */
  onChange(update: AccessUpdate, done: string): Promise<boolean>;
}

function Readers({ policy, disabled, error, pending, onChange }: ReadersProps) {
  const t = useT();
  const max = LIMITS.readersPerArtifact;
  const full = policy.readers.length >= max;

  return (
    <section aria-labelledby="readers-heading" className="border-t border-border pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="readers-heading" className="text-base font-semibold tracking-tight">
          {t("readers.title")}
        </h3>
        <p className="text-sm font-medium tabular-nums">
          {t("readers.count", { count: policy.readers.length, max })}
        </p>
      </div>
      <p className="mt-1 text-sm text-text-muted">{t("readers.hint")}</p>
      <p className="mt-1 text-sm text-text-muted">{t("readers.comments.hint")}</p>
      {error ? (
        <div className="mt-4">
          <Callout
            tone="error"
            title={t("readers.failed.title")}
            icon={<CircleAlert className="size-5" />}
          >
            {error}
          </Callout>
        </div>
      ) : null}
      {policy.readers.length === 0 ? (
        <p className="mt-4 flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-text-muted">
          <UsersRound aria-hidden="true" className="size-4 shrink-0" />
          {t("readers.empty")}
        </p>
      ) : (
        <ul
          aria-label={t("readers.list")}
          className="mt-4 divide-y divide-border rounded-md border border-border"
        >
          {policy.readers.map((email) => (
            <li key={email} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 text-sm break-all">{email}</span>
              <div className="w-56 max-w-full">
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
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        {full ? <p className="mb-3 text-sm font-medium">{t("readers.full", { max })}</p> : null}
        <AddReaderForm
          readers={policy.readers}
          disabled={disabled || full}
          busy={pending?.addReaders !== undefined}
          onAdd={(email) => onChange({ addReaders: [email] }, t("readers.added", { email }))}
        />
      </div>
    </section>
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
  onChange: ReadersProps["onChange"];
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
