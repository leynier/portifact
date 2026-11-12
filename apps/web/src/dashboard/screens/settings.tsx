// The settings page (`/settings`): the defaults new artifacts start with (applied by the publish
// service for every client), the expiry notice emails, the data export and, in the danger zone,
// account deletion.
import {
  type AccountSettings,
  type AccountSettingsUpdate,
  type CommentVisibility,
  type DefaultAnnotations,
  LIMITS,
  type PersonalAccessMode,
} from "@portifact/contracts";
import { Callout, PageHeader, SectionedPage, ThemeSwitcher } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleAlert, Save } from "lucide-react";
import { type Account, ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { publicAvailableFrom } from "./access-settings.tsx";
import { AccountData, DeleteAccount, Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { LanguageChoice, SETTINGS_QUERY } from "./language.tsx";
import { MyWorkspaces } from "./my-workspaces.tsx";
import { ACCOUNT_QUERY, themeLabels } from "./shell.tsx";
import { SuspensionReasons } from "./suspension-reasons.tsx";

export { SETTINGS_QUERY } from "./language.tsx";

const MODES: readonly PersonalAccessMode[] = ["restricted", "authenticated", "public"];
const ANNOTATIONS: readonly DefaultAnnotations[] = ["off", "open"];
const VISIBILITIES: readonly CommentVisibility[] = ["owner", "everyone"];

/**
 * The defaults for new artifacts: every setting but the email notices and the language, which
 * have their own controls on this page.
 */
type Defaults = Omit<AccountSettings, "expiryNotices" | "commentNotices" | "locale">;

function defaultsOf({
  expiryNotices: _,
  commentNotices: ___,
  locale: __,
  ...defaults
}: AccountSettings): Defaults {
  return defaults;
}

/** The fields that differ from the saved defaults, or undefined when nothing changed. */
export function defaultsChange(
  saved: Defaults,
  values: Defaults,
): AccountSettingsUpdate | undefined {
  const entries = (Object.keys(values) as (keyof Defaults)[])
    .filter((key) => values[key] !== saved[key])
    .map((key) => [key, values[key]]);
  return entries.length > 0 ? (Object.fromEntries(entries) as AccountSettingsUpdate) : undefined;
}

export function SettingsScreen() {
  const t = useT();
  useDocumentTitle(t("settings.title"));
  const account = useQueryClient().getQueryData<Account>(ACCOUNT_QUERY);
  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      <AccountSuspension />
      <SectionedPage
        label={t("settings.sectionsNav")}
        title={t("sections.title")}
        sections={[
          { id: "language", label: t("language.title") },
          { id: "appearance", label: t("settings.appearance.title") },
          { id: "defaults", label: t("settings.defaults.title") },
          { id: "notices", label: t("settings.notices.title") },
          { id: "workspaces", label: t("workspaces.title") },
          { id: "data", label: t("account.data.title") },
          { id: "delete", label: t("settings.danger.title") },
        ]}
      >
        <Section id="language" title={t("language.title")} hint={t("language.hint")}>
          <LanguageChoice variant="field" />
        </Section>
        <Appearance />
        <ArtifactDefaults />
        <EmailNotices />
        <MyWorkspaces />
        <AccountData />
        <DeleteAccount email={account?.email ?? ""} />
      </SectionedPage>
    </>
  );
}

/** The theme for this browser: System, Light or Dark, applied at once and remembered here. */
function Appearance() {
  const t = useT();
  return (
    <Section
      id="appearance"
      title={t("settings.appearance.title")}
      hint={t("settings.appearance.hint")}
    >
      <ThemeSwitcher legend={t("theme.legend")} labels={themeLabels(t)} />
    </Section>
  );
}

function ArtifactDefaults() {
  const t = useT();
  const { api } = useDashboard();
  const settings = useQuery({ queryKey: SETTINGS_QUERY, queryFn: () => api.accountSettings() });
  return (
    <Section id="defaults" title={t("settings.defaults.title")} hint={t("settings.defaults.hint")}>
      <Loaded
        query={settings}
        loading={t("settings.defaults.loading")}
        error={t("settings.defaults.error")}
      >
        {(saved) => {
          const defaults = defaultsOf(saved);
          // A new form when the saved defaults change, so it never shows stale choices; saving
          // the email notices or the language leaves unsaved choices here alone.
          return <DefaultsForm key={JSON.stringify(defaults)} saved={defaults} />;
        }}
      </Loaded>
    </Section>
  );
}

function DefaultsForm({ saved }: { saved: Defaults }) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const publicFrom = publicAvailableFrom(queryClient.getQueryData<Account | null>(ACCOUNT_QUERY));
  // Only opening to the public waits for the account's age; keeping a public default never does.
  const publicLocked =
    saved.defaultAccessMode !== "public" &&
    publicFrom !== null &&
    publicFrom.getTime() > Date.now();

  const save = useMutation({
    mutationFn: (update: AccountSettingsUpdate) => api.updateAccountSettings(update),
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_QUERY, next);
      announce(t("settings.defaults.saved"));
    },
  });

  const form = useAppForm({
    defaultValues: saved,
    validationLogic: revalidateLogic(),
    onSubmit: async ({ value }) => {
      const update = defaultsChange(saved, value);
      if (!update) {
        announce(t("settings.defaults.unchanged"));
        return;
      }
      await save.mutateAsync(update).catch(() => undefined);
    },
  });

  const tooNew =
    save.error instanceof ApiFailure && save.error.code === "account_too_new_for_public";
  const minutes = LIMITS.publicAccessMinAccountAgeMinutes;
  const failure = tooNew
    ? publicFrom
      ? t("accessSettings.tooNew", { minutes, date: formatDate(publicFrom.toISOString(), true) })
      : t("accessSettings.tooNewNoDate", { minutes })
    : errorMessage(t, save.error);

  return (
    <form.AppForm>
      <form.Form label={t("settings.defaults.title")}>
        <div className="flex flex-col gap-6">
          {save.isError ? (
            <Callout
              tone="error"
              title={t("settings.defaults.failed")}
              icon={<CircleAlert className="size-5" />}
            >
              {failure}
            </Callout>
          ) : null}
          <form.AppField name="defaultAccessMode">
            {(field) => (
              <field.RadioGroupField
                legend={t("settings.defaults.access")}
                options={MODES.map((mode) => ({
                  value: mode,
                  label: t(`access.${mode}`),
                  description:
                    mode === "public" && publicLocked && publicFrom ? (
                      <>
                        <span className="block">{t("accessSettings.mode.public")}</span>
                        <span className="mt-1 block font-medium text-text">
                          {t("accessSettings.mode.publicFrom", {
                            date: formatDate(publicFrom.toISOString(), true),
                            minutes,
                          })}
                        </span>
                      </>
                    ) : mode === "restricted" ? (
                      t("settings.defaults.access.restricted")
                    ) : (
                      t(`accessSettings.mode.${mode}`)
                    ),
                  disabled: mode === "public" && publicLocked,
                }))}
              />
            )}
          </form.AppField>
          <form.AppField name="defaultAnnotations">
            {(field) => (
              <field.RadioGroupField
                legend={t("settings.defaults.comments")}
                options={ANNOTATIONS.map((value) => ({
                  value,
                  label: t(`settings.defaults.comments.${value}`),
                  description: t(`settings.defaults.comments.${value}.hint`),
                }))}
              />
            )}
          </form.AppField>
          <form.AppField name="defaultCommentVisibility">
            {(field) => (
              <field.RadioGroupField
                legend={t("accessSettings.comments.legend")}
                options={VISIBILITIES.map((value) => ({
                  value,
                  label: t(`accessSettings.comments.${value}`),
                  description: t(`accessSettings.comments.${value}.hint`),
                }))}
              />
            )}
          </form.AppField>
          <form.AppField name="defaultBar">
            {(field) => (
              <field.CheckboxField
                label={t("settings.defaults.bar.label")}
                description={t("accessSettings.bar.hint")}
              />
            )}
          </form.AppField>
          <div>
            <form.SubmitButton icon={<Save className="size-4" />} busy={save.isPending}>
              {t("settings.defaults.save")}
            </form.SubmitButton>
          </div>
        </div>
      </form.Form>
    </form.AppForm>
  );
}

function EmailNotices() {
  const t = useT();
  const { api } = useDashboard();
  const settings = useQuery({ queryKey: SETTINGS_QUERY, queryFn: () => api.accountSettings() });
  return (
    <Section id="notices" title={t("settings.notices.title")} hint={t("settings.notices.hint")}>
      <Loaded
        query={settings}
        loading={t("settings.defaults.loading")}
        error={t("settings.defaults.error")}
      >
        {(saved) => (
          <NoticesForm
            key={`${saved.expiryNotices}:${saved.commentNotices}`}
            saved={{ expiryNotices: saved.expiryNotices, commentNotices: saved.commentNotices }}
          />
        )}
      </Loaded>
    </Section>
  );
}

interface Notices {
  expiryNotices: boolean;
  commentNotices: boolean;
}

function NoticesForm({ saved }: { saved: Notices }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();

  const save = useMutation({
    mutationFn: (update: Partial<Notices>) => api.updateAccountSettings(update),
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_QUERY, next);
      announce(t("settings.notices.saved"));
    },
  });

  const form = useAppForm({
    defaultValues: saved,
    validationLogic: revalidateLogic(),
    onSubmit: async ({ value }) => {
      const update: Partial<Notices> = {
        ...(value.expiryNotices === saved.expiryNotices
          ? {}
          : { expiryNotices: value.expiryNotices }),
        ...(value.commentNotices === saved.commentNotices
          ? {}
          : { commentNotices: value.commentNotices }),
      };
      if (Object.keys(update).length === 0) {
        announce(t("settings.notices.unchanged"));
        return;
      }
      await save.mutateAsync(update).catch(() => undefined);
    },
  });

  return (
    <form.AppForm>
      <form.Form label={t("settings.notices.title")}>
        <div className="flex flex-col gap-6">
          {save.isError ? (
            <Callout
              tone="error"
              title={t("settings.notices.failed")}
              icon={<CircleAlert className="size-5" />}
            >
              {errorMessage(t, save.error)}
            </Callout>
          ) : null}
          <form.AppField name="expiryNotices">
            {(field) => (
              <field.CheckboxField
                label={t("settings.notices.expiry.label")}
                description={t("settings.notices.expiry.hint")}
              />
            )}
          </form.AppField>
          <form.AppField name="commentNotices">
            {(field) => (
              <field.CheckboxField
                label={t("settings.notices.comments.label")}
                description={t("settings.notices.comments.hint")}
              />
            )}
          </form.AppField>
          <div>
            <form.SubmitButton icon={<Save className="size-4" />} busy={save.isPending}>
              {t("settings.notices.save")}
            </form.SubmitButton>
          </div>
        </div>
      </form.Form>
    </form.AppForm>
  );
}

/** The operator's suspension of the account, with its reasons; nothing when there is none. */
function AccountSuspension() {
  const t = useT();
  const { api } = useDashboard();
  const suspension = useQuery({
    queryKey: ["account-suspension"],
    queryFn: () => api.accountSuspension(),
  });
  const view = suspension.data;
  if (!view?.suspended) return null;
  return (
    <div className="mb-8">
      <Callout tone="error" title={t("settings.suspended.title")} icon={<Ban className="size-5" />}>
        {t("settings.suspended.body", { reason: view.reason ? t(`reason.${view.reason}`) : "" })}
        {view.statement ? <SuspensionReasons statement={view.statement} /> : null}
      </Callout>
    </div>
  );
}
