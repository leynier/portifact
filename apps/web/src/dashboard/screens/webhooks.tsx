// The webhooks page (`/webhooks`, premium plan P6, decision 0009): the account's webhooks with
// their state and last attempt, adding one (the signing secret shown once), sending a test,
// the delivery log, disabling, enabling and removing with a confirmation. Without the feature in
// the plan it says which plan includes webhooks; there is no checkout yet, so nothing else is
// offered, and existing webhooks stay listed as paused.
import {
  lowestPlanWith,
  PLAN_LABELS,
  WEBHOOK_EVENTS,
  type WebhookAttempt,
  type WebhookCreated,
  type WebhookEventType,
  type WebhookFormat,
  type WebhookView,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  CopyField,
  Disclosure,
  EmptyState,
  FieldError,
  LoadingState,
  PageHeader,
  RadioGroup,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextInput,
} from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CirclePause,
  CirclePlay,
  CircleSlash,
  Info,
  KeyRound,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useRelativeTime, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { errorMessage } from "./artifact-list.tsx";

export const WEBHOOKS_QUERY = ["webhooks"] as const;
const deliveriesQuery = (id: string) => ["webhooks", id, "deliveries"] as const;

type T = ReturnType<typeof useT>;

export function WebhooksScreen() {
  const t = useT();
  const { api } = useDashboard();
  useDocumentTitle(t("webhooks.title"));
  const list = useQuery({
    queryKey: WEBHOOKS_QUERY,
    queryFn: () => api.webhooks(),
    ...refreshOptions,
  });
  const [created, setCreated] = useState<WebhookCreated | null>(null);
  const available = list.data?.available ?? true;
  const full = (list.data?.webhooks.length ?? 0) >= (list.data?.limit ?? Number.POSITIVE_INFINITY);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("webhooks.title")} description={t("webhooks.description")} />
      {list.data && !available ? (
        <Callout tone="info" title={t("webhooks.planTitle")} icon={<Info className="size-5" />}>
          {t("webhooks.planRequired", { plan: PLAN_LABELS[lowestPlanWith("webhooks")] })}
        </Callout>
      ) : null}
      {created ? <SecretOnce created={created} onDone={() => setCreated(null)} /> : null}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <Section id="webhooks" title={t("webhooks.list.title")}>
            <Loaded
              query={list}
              loading={t("webhooks.list.loading")}
              error={t("webhooks.list.error")}
            >
              {(data) =>
                data.webhooks.length === 0 ? (
                  <EmptyState
                    title={t("webhooks.empty.title")}
                    icon={<Webhook className="size-8" />}
                  >
                    <p>{t("webhooks.empty.body")}</p>
                  </EmptyState>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {data.webhooks.map((webhook) => (
                      <WebhookCard key={webhook.id} webhook={webhook} available={data.available} />
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </Section>
        </div>
        <AddWebhook
          disabled={!list.data || !available || full}
          full={full}
          limit={list.data?.limit ?? 0}
          onCreated={setCreated}
        />
      </div>
    </div>
  );
}

/** The signing secret, shown once after creation; it is never fetched again. */
function SecretOnce({ created, onDone }: { created: WebhookCreated; onDone(): void }) {
  const t = useT();
  const announce = useAnnounce();
  if (!created.secret) return null;
  return (
    <Callout
      tone="info"
      title={t("webhooks.secret.title")}
      icon={<KeyRound className="size-5" />}
      action={<Button onClick={onDone}>{t("webhooks.secret.done")}</Button>}
    >
      <div className="flex flex-col gap-3">
        <p>{t("webhooks.secret.body")}</p>
        <CopyField
          label={t("webhooks.secret.label", { host: created.webhook.host })}
          value={created.secret}
          copyLabel={t("webhooks.secret.copy")}
          copiedLabel={t("copy.copied")}
          onCopied={() => announce(t("copy.done"))}
          onCopyFailed={() => announce(t("copy.failed"))}
        />
      </div>
    </Callout>
  );
}

function AddWebhook({
  disabled,
  full,
  limit,
  onCreated,
}: {
  disabled: boolean;
  full: boolean;
  limit: number;
  onCreated(created: WebhookCreated): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const eventsId = useId();
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<WebhookFormat>("generic");
  const [events, setEvents] = useState<WebhookEventType[]>(["comment.created", "thread.resolved"]);
  const [noEvents, setNoEvents] = useState(false);
  const create = useMutation({
    mutationFn: () => api.createWebhook({ url: url.trim(), format, events }),
    onSuccess: async (created) => {
      setUrl("");
      onCreated(created);
      await queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY });
      announce(t("webhooks.added", { host: created.webhook.host }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (events.length === 0) {
      setNoEvents(true);
      return;
    }
    create.mutate();
  };
  const toggle = (type: WebhookEventType, on: boolean) => {
    setNoEvents(false);
    setEvents((current) =>
      on
        ? WEBHOOK_EVENTS.filter((e) => e === type || current.includes(e))
        : current.filter((e) => e !== type),
    );
  };

  return (
    <Section id="add-webhook" title={t("webhooks.add.title")} hint={t("webhooks.add.hint")}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {full ? (
          <p className="text-sm text-text-muted">{t("webhooks.add.limit", { limit })}</p>
        ) : null}
        <TextInput
          label={t("webhooks.add.url")}
          description={t("webhooks.add.urlHint")}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          value={url}
          disabled={disabled}
          onChange={(event) => setUrl(event.currentTarget.value)}
        />
        <RadioGroup<WebhookFormat>
          legend={t("webhooks.add.format")}
          name="webhook-format"
          value={format}
          disabled={disabled}
          onChange={setFormat}
          options={(["generic", "slack", "discord"] as const).map((value) => ({
            value,
            label: t(`webhooks.format.${value}`),
            description: t(`webhooks.format.${value}Hint`),
          }))}
        />
        <fieldset
          className="flex flex-col gap-3"
          aria-describedby={noEvents ? eventsId : undefined}
        >
          <legend className="mb-1 text-sm font-medium">{t("webhooks.add.events")}</legend>
          {WEBHOOK_EVENTS.map((type) => (
            <Checkbox
              key={type}
              label={t(`webhooks.event.${type}`)}
              checked={events.includes(type)}
              disabled={disabled}
              onChange={(event) => toggle(type, event.currentTarget.checked)}
            />
          ))}
          {noEvents ? <FieldError id={eventsId}>{t("webhooks.add.noEvents")}</FieldError> : null}
        </fieldset>
        {create.isError ? (
          <Callout
            tone="error"
            title={t("webhooks.actionFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, create.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<Webhook className="size-4" />}
            busy={create.isPending}
            disabled={disabled}
          >
            {t("webhooks.add.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function stateBadge(t: T, webhook: WebhookView) {
  if (webhook.state === "active") {
    return <Badge icon={<CirclePlay className="size-3.5" />}>{t("webhooks.state.active")}</Badge>;
  }
  if (webhook.state === "paused") {
    return (
      <Badge emphasis="quiet" icon={<CirclePause className="size-3.5" />}>
        {t("webhooks.state.paused")}
      </Badge>
    );
  }
  return (
    <Badge emphasis="strong" icon={<CircleSlash className="size-3.5" />}>
      {t("webhooks.state.disabled")}
    </Badge>
  );
}

function attemptText(t: T, attempt: WebhookAttempt) {
  const detail =
    attempt.status !== null
      ? String(attempt.status)
      : attempt.error
        ? t(`webhooks.error.${attempt.error}` as Parameters<T>[0])
        : "";
  return `${t(`webhooks.outcome.${attempt.outcome}`)}${detail ? ` (${detail})` : ""}`;
}

function WebhookCard({ webhook, available }: { webhook: WebhookView; available: boolean }) {
  const t = useT();
  const announce = useAnnounce();
  const relative = useRelativeTime();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const host = webhook.host;
  const refresh = () => queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY });
  const test = useMutation({
    mutationFn: () => api.testWebhook(webhook.id),
    onSuccess: () => announce(t("webhooks.testQueued", { host })),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateWebhook(webhook.id, { enabled }),
    onSuccess: async (next) => {
      await refresh();
      announce(t(next.state === "disabled" ? "webhooks.disabled" : "webhooks.enabled", { host }));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeWebhook(webhook.id),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      announce(t("webhooks.removed", { host }));
    },
    onError: () => setConfirming(false),
  });
  const failed = test.error ?? toggle.error ?? remove.error;
  const busy = test.isPending || toggle.isPending || remove.isPending;
  const disabled = webhook.state === "disabled";

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-base font-semibold break-all">{host}</h3>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {stateBadge(t, webhook)}
            <Badge emphasis="subtle">{t(`webhooks.format.${webhook.format}`)}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Send className="size-4" />}
            aria-label={t("webhooks.testLabel", { host })}
            busy={test.isPending}
            disabled={busy || disabled || !available}
            onClick={() => test.mutate()}
          >
            {t("webhooks.test")}
          </Button>
          <Button
            size="sm"
            icon={disabled ? <CirclePlay className="size-4" /> : <CirclePause className="size-4" />}
            aria-label={t(disabled ? "webhooks.enableLabel" : "webhooks.disableLabel", { host })}
            busy={toggle.isPending}
            disabled={busy || (disabled && !available)}
            onClick={() => toggle.mutate(disabled)}
          >
            {t(disabled ? "webhooks.enable" : "webhooks.disable")}
          </Button>
          <Button
            size="sm"
            intent="danger"
            icon={<Trash2 className="size-4" />}
            aria-label={t("webhooks.removeLabel", { host })}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("webhooks.remove")}
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text-muted">
        <li>{webhook.events.map((type) => t(`webhooks.event.${type}`)).join(", ")}</li>
        {webhook.disabledReason ? <li>{t(`webhooks.reason.${webhook.disabledReason}`)}</li> : null}
        {webhook.failures > 0 ? (
          <li>{t("webhooks.failures", { count: webhook.failures })}</li>
        ) : null}
        <li>
          {webhook.lastAttempt ? (
            <time dateTime={webhook.lastAttempt.at}>
              {t("webhooks.lastAttempt", {
                when: relative(webhook.lastAttempt.at),
                outcome: attemptText(t, webhook.lastAttempt),
              })}
            </time>
          ) : (
            t("webhooks.noAttempts")
          )}
        </li>
      </ul>
      {failed ? (
        <Callout
          tone="error"
          title={t("webhooks.actionFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, failed)}
        </Callout>
      ) : null}
      <div className="border-t border-border pt-2">
        <DeliveryLog webhook={webhook} />
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("webhooks.confirm.title", { host })}
        confirmLabel={t("webhooks.remove")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("webhooks.confirm.body")}
      </ConfirmDialog>
    </li>
  );
}

/** The last 7 days of attempts, fetched when it is opened. */
function DeliveryLog({ webhook }: { webhook: WebhookView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      appearance="inline"
      summary={t("webhooks.deliveries")}
      label={t("webhooks.deliveriesOf", { host: webhook.host })}
      onToggle={setOpen}
    >
      {open ? <DeliveryTable webhook={webhook} /> : null}
    </Disclosure>
  );
}

function DeliveryTable({ webhook }: { webhook: WebhookView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  const log = useQuery({
    queryKey: deliveriesQuery(webhook.id),
    queryFn: () => api.webhookDeliveries(webhook.id),
  });
  if (log.isPending) return <LoadingState label={t("webhooks.deliveries.loading")} />;
  if (log.isError) {
    return (
      <Callout
        tone="error"
        title={t("webhooks.deliveries.error")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, log.error)}
      </Callout>
    );
  }
  if (log.data.attempts.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {t("webhooks.deliveries.empty", { days: log.data.retentionDays })}
      </p>
    );
  }
  return (
    <Table caption={t("webhooks.deliveriesOf", { host: webhook.host })} stacked>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("webhooks.deliveries.time")}</TableHeaderCell>
          <TableHeaderCell>{t("webhooks.deliveries.attempt")}</TableHeaderCell>
          <TableHeaderCell>{t("webhooks.deliveries.outcome")}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {log.data.attempts.map((attempt) => (
          <TableRow key={`${attempt.deliveryId}:${attempt.attempt}:${attempt.at}`}>
            <TableCell label={t("webhooks.deliveries.time")}>
              <time dateTime={attempt.at}>{formatDate(attempt.at, true)}</time>
            </TableCell>
            <TableCell label={t("webhooks.deliveries.attempt")} stack="inline">
              {String(attempt.attempt)}
            </TableCell>
            <TableCell label={t("webhooks.deliveries.outcome")} stack="inline">
              {attemptText(t, attempt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
