// The "Share links" group of the artifact's sharing settings (premium plan P4, decision 0008):
// links that let anyone who holds them read the artifact without an account. The link's URL is
// shown once, right after it is created, with a copy button; the list never has it. Owners whose
// plan does not include share links get an explanation and no form. The API applies every rule
// (the plan, the roles, the 20-link cap, the expiry and password limits).
import {
  type ArtifactSummary,
  SHARE_LINKS,
  type ShareLinkCreated,
  type ShareLinkView,
} from "@portifact/contracts";
import { Button, Callout, ConfirmDialog, CopyField, LoadingState, Panel } from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Info, Link2, Link2Off, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { useOwnerPolicy } from "../space.tsx";
import { errorMessage } from "./artifact-list.tsx";

export const shareLinksQuery = (artifactId: string) =>
  ["artifact", artifactId, "share-links"] as const;

const DAY_MS = 86_400_000;
/** The expiries offered, in days; `never` keeps the link until it is revoked. */
export const EXPIRY_CHOICES = ["never", "1", "7", "30", "90", "365"] as const;
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

/** The ISO expiry of a choice made at `now`, or undefined for `never`. */
export function expiryFor(choice: ExpiryChoice, now: number): string | undefined {
  return choice === "never" ? undefined : new Date(now + Number(choice) * DAY_MS).toISOString();
}

export function ShareLinksPanel({
  artifact,
  disabled,
}: {
  artifact: ArtifactSummary;
  disabled: boolean;
}) {
  const t = useT();
  const { api } = useDashboard();
  const links = useQuery({
    queryKey: shareLinksQuery(artifact.id),
    queryFn: () => api.listShareLinks(artifact.id),
  });
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);
  // The workspace's link policy (decision 0015): a note names it, and the form is not offered
  // while links are disabled. The API refuses what the policy does not allow either way.
  const workspacePolicy = useOwnerPolicy(artifact.owner);
  const linksDisabled = workspacePolicy?.shareLinks === "disabled";
  const policyNotes = workspacePolicy
    ? [
        ...(linksDisabled ? [t("policies.note.linksDisabled")] : []),
        ...(workspacePolicy.shareLinks === "password_required"
          ? [t("policies.note.linksPassword")]
          : []),
        ...(workspacePolicy.shareLinkMaxDays !== null && !linksDisabled
          ? [t("policies.note.linksLifetime", { days: workspacePolicy.shareLinkMaxDays })]
          : []),
      ]
    : [];

  let body: React.ReactNode;
  if (links.isPending) body = <LoadingState label={t("shareLinks.loading")} />;
  else if (links.isError && !links.data) {
    body = (
      <Callout
        tone="error"
        title={t("shareLinks.loadFailed")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => links.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, links.error)}
      </Callout>
    );
  } else {
    const list = links.data;
    const active = list.links.filter((link) => link.state === "active").length;
    body = (
      <div className="flex flex-col gap-4">
        {list.enabled ? null : (
          <Callout title={t("shareLinks.paidTitle")} icon={<Info className="size-5" />}>
            {list.links.length > 0 ? t("shareLinks.paused") : t("shareLinks.paid")}
          </Callout>
        )}
        {policyNotes.map((note) => (
          <p key={note} className="text-sm font-medium">
            {note}
          </p>
        ))}
        {artifact.accessMode === "public" && list.enabled ? (
          <p className="text-sm text-text-muted">{t("shareLinks.publicNote")}</p>
        ) : null}
        {created ? <CreatedLink created={created} onDone={() => setCreated(null)} /> : null}
        <LinkList artifactId={artifact.id} links={list.links} disabled={disabled} />
        {list.enabled && !linksDisabled ? (
          <CreateLinkForm
            artifactId={artifact.id}
            disabled={disabled || active >= list.activeLimit}
            full={active >= list.activeLimit}
            onCreated={setCreated}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Panel headingLevel={3} title={t("shareLinks.title")} description={t("shareLinks.description")}>
      {body}
    </Panel>
  );
}

/** The new link's URL, shown this once with a copy button. */
function CreatedLink({ created, onDone }: { created: ShareLinkCreated; onDone(): void }) {
  const t = useT();
  const announce = useAnnounce();
  return (
    <Callout
      tone="success"
      title={t("shareLinks.created.title", { label: created.link.label })}
      icon={<Link2 className="size-5" />}
      action={
        <Button intent="ghost" size="sm" onClick={onDone}>
          {t("shareLinks.created.done")}
        </Button>
      }
    >
      <p className="mb-3">{t("shareLinks.created.once")}</p>
      <CopyField
        label={t("shareLinks.created.label")}
        value={created.url}
        copyLabel={t("shareLinks.created.copy")}
        copiedLabel={t("copy.copied")}
        onCopied={() => announce(t("copy.done"))}
        onCopyFailed={() => announce(t("copy.failed"))}
      />
    </Callout>
  );
}

function LinkList({
  artifactId,
  links,
  disabled,
}: {
  artifactId: string;
  links: readonly ShareLinkView[];
  disabled: boolean;
}) {
  const t = useT();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState<ShareLinkView | null>(null);
  const revoke = useMutation({
    mutationFn: (link: ShareLinkView) => api.revokeShareLink(artifactId, link.id),
    onSuccess: async (_result, link) => {
      setConfirming(null);
      announce(t("shareLinks.revoked", { label: link.label }));
      await queryClient.invalidateQueries({ queryKey: shareLinksQuery(artifactId) });
    },
  });

  if (links.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-text-muted">
        <Link2 aria-hidden="true" className="size-4 shrink-0" />
        {t("shareLinks.empty")}
      </p>
    );
  }
  return (
    <>
      {revoke.isError ? (
        <Callout
          tone="error"
          title={t("shareLinks.revokeFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, revoke.error)}
        </Callout>
      ) : null}
      <ul
        aria-label={t("shareLinks.list")}
        className="divide-y divide-border rounded-md border border-border"
      >
        {links.map((link) => (
          <li
            key={link.id}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{link.label}</p>
              <p className="text-sm text-text-muted">
                {[
                  link.state === "expired"
                    ? t("shareLinks.expired")
                    : link.expiresAt === null
                      ? t("shareLinks.noExpiry")
                      : t("shareLinks.expires", { date: formatDate(link.expiresAt, true) }),
                  link.hasPassword ? t("shareLinks.withPassword") : t("shareLinks.noPassword"),
                  link.lastUsedOn === null
                    ? t("shareLinks.neverUsed")
                    : t("shareLinks.lastUsed", {
                        date: formatDate(`${link.lastUsedOn}T00:00:00Z`),
                      }),
                ].join(" · ")}
              </p>
            </div>
            <Button
              intent="ghost"
              size="sm"
              icon={<Link2Off className="size-4" />}
              aria-label={t("shareLinks.revokeLabel", { label: link.label })}
              disabled={disabled || revoke.isPending}
              onClick={() => setConfirming(link)}
            >
              {t("shareLinks.revoke")}
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        title={t("shareLinks.confirm.title", { label: confirming?.label ?? "" })}
        confirmLabel={t("shareLinks.revoke")}
        cancelLabel={t("shareLinks.cancel")}
        confirmIcon={<Link2Off className="size-4" />}
        busy={revoke.isPending}
        onConfirm={() => {
          if (confirming) revoke.mutate(confirming);
        }}
        onCancel={() => setConfirming(null)}
      >
        {t("shareLinks.confirm.body")}
      </ConfirmDialog>
    </>
  );
}

function CreateLinkForm({
  artifactId,
  disabled,
  full,
  onCreated,
}: {
  artifactId: string;
  disabled: boolean;
  full: boolean;
  onCreated(created: ShareLinkCreated): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const create = useMutation({
    mutationFn: (input: { label: string; expiresAt?: string; password?: string }) =>
      api.createShareLink(artifactId, input),
    onSuccess: async (created) => {
      onCreated(created);
      announce(t("shareLinks.created.announce"));
      await queryClient.invalidateQueries({ queryKey: shareLinksQuery(artifactId) });
    },
  });
  const form = useAppForm({
    defaultValues: { label: "", expiry: "30" as ExpiryChoice, password: "" },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const label = value.label.trim();
        if (label === "" || label.length > SHARE_LINKS.labelMaxLength) {
          return {
            fields: { label: t("shareLinks.label.invalid", { max: SHARE_LINKS.labelMaxLength }) },
          };
        }
        if (value.password !== "" && value.password.length < SHARE_LINKS.passwordMinLength) {
          return {
            fields: {
              password: t("shareLinks.password.short", { min: SHARE_LINKS.passwordMinLength }),
            },
          };
        }
        return undefined;
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const expiresAt = expiryFor(value.expiry, Date.now());
      await create
        .mutateAsync({
          label: value.label.trim(),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(value.password === "" ? {} : { password: value.password }),
        })
        .then(
          () => formApi.reset(),
          () => {},
        );
    },
  });
  const failure =
    create.error instanceof ApiFailure && create.error.code === "quota_exceeded"
      ? t("shareLinks.full", { max: SHARE_LINKS.activePerArtifact })
      : create.isError
        ? errorMessage(t, create.error)
        : undefined;

  return (
    <div className="border-t border-border pt-4">
      {full ? (
        <p className="mb-3 text-sm font-medium">
          {t("shareLinks.full", { max: SHARE_LINKS.activePerArtifact })}
        </p>
      ) : null}
      {failure ? (
        <div className="mb-3">
          <Callout
            tone="error"
            title={t("shareLinks.createFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {failure}
          </Callout>
        </div>
      ) : null}
      <form.AppForm>
        <form.Form label={t("shareLinks.create")}>
          <div className="flex max-w-xl flex-col gap-4">
            <form.AppField name="label">
              {(field) => (
                <field.TextField
                  label={t("shareLinks.label.label")}
                  description={t("shareLinks.label.hint")}
                  autoComplete="off"
                  maxLength={SHARE_LINKS.labelMaxLength}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.AppField name="expiry">
              {(field) => (
                <field.SelectField
                  label={t("shareLinks.expiry.label")}
                  options={EXPIRY_CHOICES.map((choice) => ({
                    value: choice,
                    label:
                      choice === "never"
                        ? t("shareLinks.expiry.never")
                        : t("shareLinks.expiry.days", { count: Number(choice) }),
                  }))}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  type="password"
                  label={t("shareLinks.password.label")}
                  description={t("shareLinks.password.hint", {
                    min: SHARE_LINKS.passwordMinLength,
                  })}
                  autoComplete="new-password"
                  maxLength={SHARE_LINKS.passwordMaxLength}
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <div>
              <form.SubmitButton
                intent="secondary"
                icon={<Link2 className="size-4" />}
                busy={create.isPending}
                disabled={disabled}
              >
                {t("shareLinks.create")}
              </form.SubmitButton>
            </div>
          </div>
        </form.Form>
      </form.AppForm>
    </div>
  );
}
