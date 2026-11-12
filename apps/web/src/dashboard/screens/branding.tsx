// The Branding page (`/branding`, premium plan P9): the account's admins set the name, link,
// accent color and logo the viewer's bar shows on their artifacts, with a preview of the bar in
// both themes. Whether the plan includes it comes from the API (the owner's plan), never from the
// page. Without it the page says it is part of a paid plan; there is no checkout yet.
import {
  BRAND_LIMITS,
  BrandColor,
  type BrandSettings,
  type BrandUpdate,
} from "@portifact/contracts";
import {
  BrandMark,
  Button,
  Callout,
  ConfirmDialog,
  FilePicker,
  HostingNotice,
  PageHeader,
  ViewerBarPreview,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ImageUp, Info, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import symbol from "../../../../../assets/brand/symbol.svg";
import symbolDark from "../../../../../assets/brand/symbol-dark.svg";
import { ApiFailure, brandLogoPreview } from "../api.ts";
import { useAnnounce, useDashboard, useFormatBytes, useT } from "../context.tsx";
import { spaceCan, useReadySpace, useSpaceSlug } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";
import { RoleNotice, SpaceBadge } from "./space-parts.tsx";
import { SuspensionReasons } from "./suspension-reasons.tsx";

export const BRAND_QUERY = ["account", "branding"] as const;

/** The brand of a space: a workspace by slug, the personal space without one. */
const brandQuery = (workspace: string | undefined) => [...BRAND_QUERY, workspace ?? null] as const;

interface BrandValues {
  name: string;
  link: string;
  accentColor: string;
}

/** The logo's limits as the messages say them. */
const LOGO_LIMITS = {
  kb: BRAND_LIMITS.logoMaxBytes / 1000,
  px: BRAND_LIMITS.logoMaxWidth,
};

const LOGO_TYPES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/** The form's values as the API takes them: empty means none. */
export function brandUpdate(values: BrandValues): BrandUpdate {
  return {
    name: values.name.trim(),
    link: values.link.trim() === "" ? null : values.link.trim(),
    accentColor: values.accentColor.trim() === "" ? null : values.accentColor.trim().toLowerCase(),
  };
}

export function BrandingScreen() {
  const t = useT();
  useDocumentTitle(t("branding.title"));
  const { api } = useDashboard();
  const space = useReadySpace();
  // Only admins set a space's brand; in a personal space the user is its admin.
  const allowed = spaceCan(space, "brand");
  const settings = useQuery({
    queryKey: brandQuery(space.slug),
    queryFn: () => api.brandSettings(space.slug),
    enabled: allowed,
  });
  return (
    <>
      <PageHeader
        title={t("branding.title")}
        meta={<SpaceBadge owner={space} />}
        description={
          space.kind === "workspace"
            ? t("branding.descriptionWorkspace", { workspace: space.name })
            : t("branding.description")
        }
      />
      {allowed ? (
        <Loaded query={settings} loading={t("branding.loading")} error={t("branding.error")}>
          {(data) => <Branding settings={data} />}
        </Loaded>
      ) : (
        <RoleNotice>
          {t("space.notAllowed.branding", {
            workspace: space.kind === "workspace" ? space.name : "",
          })}
        </RoleNotice>
      )}
    </>
  );
}

function Branding({ settings }: { settings: BrandSettings }) {
  const t = useT();
  const brand = settings.brand;
  return (
    <div className="flex flex-col gap-6">
      {settings.suspended ? (
        <Callout
          tone="error"
          title={t("branding.suspendedTitle")}
          icon={<ShieldAlert className="size-5" />}
        >
          {t("branding.suspended")}
          {settings.reason ? (
            <p className="mt-2">
              {t("branding.suspendedReason", { reason: t(`reason.${settings.reason}`) })}
            </p>
          ) : null}
          {settings.statement ? <SuspensionReasons statement={settings.statement} /> : null}
        </Callout>
      ) : null}
      {settings.available ? null : (
        <Callout title={t("branding.paidTitle")} icon={<Info className="size-5" />}>
          {t("branding.paid", { plan: t(`usage.plan.${settings.lowestPlan}`) })}
        </Callout>
      )}
      {settings.available ? (
        // Not keyed by the saved brand: saving keeps the form, its focus and what was typed.
        <BrandForm
          saved={{
            name: brand?.name ?? "",
            link: brand?.link ?? "",
            accentColor: brand?.accentColor ?? "",
          }}
          logo={settings}
        />
      ) : brand ? (
        <Preview
          values={{
            name: brand.name,
            link: brand.link ?? "",
            accentColor: brand.accentColor ?? "",
          }}
          logo={settings}
        />
      ) : null}
      {brand ? <DeleteBrand suspended={settings.suspended} /> : null}
    </div>
  );
}

function BrandForm({ saved, logo }: { saved: BrandValues; logo: BrandSettings }) {
  const slug = useSpaceSlug();
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const save = useMutation({
    mutationFn: (update: BrandUpdate) => api.updateBrand(update, slug),
    onSuccess: (next) => {
      queryClient.setQueryData(brandQuery(slug), next);
      announce(t("branding.form.saved"));
    },
  });
  const form = useAppForm({
    defaultValues: saved,
    validationLogic: revalidateLogic(),
    onSubmit: async ({ value }) => {
      await save.mutateAsync(brandUpdate(value)).catch(() => undefined);
    },
  });
  const failure =
    save.error instanceof ApiFailure && save.error.code === "invalid_input"
      ? t("branding.form.invalid")
      : errorMessage(t, save.error);
  return (
    <>
      <Section id="brand" title={t("branding.form.title")} hint={t("branding.form.hint")}>
        <form.AppForm>
          <form.Form label={t("branding.form.title")}>
            <div className="flex max-w-xl flex-col gap-6">
              {save.isError ? (
                <Callout
                  tone="error"
                  title={t("branding.form.failed")}
                  icon={<CircleAlert className="size-5" />}
                >
                  {failure}
                </Callout>
              ) : null}
              <form.AppField
                name="name"
                validators={{
                  onDynamic: ({ value }) =>
                    value.trim() === ""
                      ? t("branding.form.nameRequired")
                      : [...value.trim()].length > BRAND_LIMITS.nameMaxLength
                        ? t("branding.form.nameTooLong", { max: BRAND_LIMITS.nameMaxLength })
                        : undefined,
                }}
              >
                {(field) => (
                  <field.TextField
                    label={t("branding.form.name")}
                    description={t("branding.form.nameHint", { max: BRAND_LIMITS.nameMaxLength })}
                    autoComplete="organization"
                  />
                )}
              </form.AppField>
              <form.AppField
                name="link"
                validators={{
                  onDynamic: ({ value }) =>
                    value.trim() === "" || /^https:\/\/\S+$/i.test(value.trim())
                      ? undefined
                      : t("branding.form.linkInvalid"),
                }}
              >
                {(field) => (
                  <field.TextField
                    type="url"
                    label={t("branding.form.link")}
                    description={t("branding.form.linkHint")}
                    inputMode="url"
                    autoComplete="url"
                  />
                )}
              </form.AppField>
              <form.AppField
                name="accentColor"
                validators={{
                  onDynamic: ({ value }) =>
                    value.trim() === "" || BrandColor.safeParse(value.trim()).success
                      ? undefined
                      : t("branding.form.colorInvalid"),
                }}
              >
                {(field) => (
                  <field.ColorField
                    label={t("branding.form.color")}
                    description={t("branding.form.colorHint")}
                    pickerLabel={t("branding.form.colorPicker")}
                    placeholder="#1a2b3c"
                  />
                )}
              </form.AppField>
              <div>
                <form.SubmitButton icon={<Save className="size-4" />} busy={save.isPending}>
                  {t("branding.form.save")}
                </form.SubmitButton>
              </div>
            </div>
          </form.Form>
        </form.AppForm>
      </Section>
      <Logo settings={logo} />
      <form.Subscribe selector={(state) => state.values}>
        {(values) => <Preview values={values} logo={logo} />}
      </form.Subscribe>
    </>
  );
}

function Logo({ settings }: { settings: BrandSettings }) {
  const slug = useSpaceSlug();
  const t = useT();
  const announce = useAnnounce();
  const formatBytes = useFormatBytes();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const done = (message: string) => (next: BrandSettings) => {
    queryClient.setQueryData(brandQuery(slug), next);
    announce(message);
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadBrandLogo(file, slug),
    onSuccess: done(t("branding.logo.uploaded")),
  });
  const remove = useMutation({
    mutationFn: () => api.removeBrandLogo(slug),
    onSuccess: done(t("branding.logo.removed")),
  });
  const failed = upload.error ?? remove.error;
  const code = failed instanceof ApiFailure ? failed.code : null;
  const message =
    code === "invalid_input"
      ? t("branding.logo.invalid", LOGO_LIMITS)
      : code === "quota_exceeded"
        ? t("branding.logo.full")
        : errorMessage(t, failed);
  const logo = settings.brand?.logo ?? null;
  return (
    <Section id="logo" title={t("branding.logo.title")} hint={t("branding.logo.hint", LOGO_LIMITS)}>
      <div className="flex flex-col gap-4">
        {failed ? (
          <Callout
            tone="error"
            title={t("branding.logo.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {message}
          </Callout>
        ) : null}
        {settings.brand ? (
          <p className="text-sm">
            {logo
              ? t("branding.logo.current", {
                  type: LOGO_TYPES[logo.type] ?? logo.type,
                  width: logo.width,
                  height: logo.height,
                  size: formatBytes(logo.bytes),
                })
              : t("branding.logo.none")}
          </p>
        ) : (
          <p className="text-sm text-text-muted">{t("branding.logo.needsName")}</p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <FilePicker
            label={logo ? t("branding.logo.replace") : t("branding.logo.choose")}
            icon={<ImageUp className="size-4" />}
            accept="image/png,image/jpeg,image/webp"
            disabled={!settings.brand || upload.isPending}
            onPick={([file]) => {
              if (file) upload.mutate(file);
            }}
          />
          {logo ? (
            <Button
              icon={<Trash2 className="size-4" />}
              busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("branding.logo.remove")}
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/** The bar as visitors will see it, in both themes, from the form's values. */
function Preview({ values, logo }: { values: BrandValues; logo: BrandSettings }) {
  const slug = useSpaceSlug();
  const t = useT();
  const update = brandUpdate(values);
  const stored = logo.brand?.logo ?? null;
  const name = update.name === "" ? t("branding.preview.noName") : update.name;
  const accent =
    update.accentColor && BrandColor.safeParse(update.accentColor).success
      ? update.accentColor
      : null;
  return (
    <Section id="preview" title={t("branding.preview.title")} hint={t("branding.preview.hint")}>
      <div className="grid gap-4 xl:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <ViewerBarPreview
            key={theme}
            theme={theme}
            caption={t(`branding.preview.${theme}`)}
            title={t("branding.preview.sample")}
            brand={
              <BrandMark
                name={name}
                newTabLabel={t("viewer.brandNewTab")}
                accent={accent}
                logo={
                  stored
                    ? {
                        src: brandLogoPreview(stored.sha256, slug),
                        width: stored.width,
                        height: stored.height,
                      }
                    : null
                }
              />
            }
            notice={
              <HostingNotice
                mark={
                  <img
                    src={theme === "dark" ? symbolDark : symbol}
                    alt=""
                    width={16}
                    height={16}
                    className="size-4"
                  />
                }
                poweredBy={t("viewer.hosting.poweredBy")}
                originLabel={t("viewer.hosting.origin")}
                origin={t("branding.preview.origin")}
              />
            }
          />
        ))}
      </div>
    </Section>
  );
}

function DeleteBrand({ suspended }: { suspended: boolean }) {
  const slug = useSpaceSlug();
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteBrand(slug),
    onSuccess: (next) => {
      setConfirming(false);
      queryClient.setQueryData(brandQuery(slug), next);
      announce(t("branding.delete.done"));
    },
    onError: () => setConfirming(false),
  });
  return (
    <Section id="delete" title={t("branding.delete.title")} hint={t("branding.delete.hint")}>
      <div className="flex flex-col gap-4">
        {remove.isError ? (
          <Callout
            tone="error"
            title={t("branding.delete.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, remove.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            intent="danger"
            icon={<Trash2 className="size-4" />}
            disabled={suspended}
            onClick={() => setConfirming(true)}
          >
            {t("branding.delete.action")}
          </Button>
        </div>
        <ConfirmDialog
          open={confirming}
          tone="danger"
          title={t("branding.delete.confirm")}
          confirmLabel={t("branding.delete.action")}
          cancelLabel={t("branding.delete.cancel")}
          confirmIcon={<Trash2 className="size-4" />}
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        >
          {t("branding.delete.body")}
        </ConfirmDialog>
      </div>
    </Section>
  );
}
