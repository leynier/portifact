// The Stream section of the audit log page (premium plan E3, decision 0019): the space's admins
// point its audit log at an HTTPS endpoint they run (a SIEM collector). Shown only while the
// deployment offers streams (`serviceAvailable`), and only to whoever may read the log; the API
// decides again. Adding one shows its signing secret once with a sample of the signature check;
// each stream shows its state, how far it delivered, any gap and its last requests, and can be
// tested, paused, resumed, given a new secret or removed after a confirmation.
import {
  type AuditStreamAttempt,
  type AuditStreamStart,
  type AuditStreamView,
  lowestPlanWith,
  PLAN_LABELS,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  CodeSample,
  ConfirmDialog,
  CopyField,
  Disclosure,
  EmptyState,
  LoadingState,
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
  Info,
  KeyRound,
  RadioTower,
  Send,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useRelativeTime, useT } from "../context.tsx";
import { refreshOptions } from "../refresh.ts";
import { errorMessage } from "./artifact-list.tsx";

type T = ReturnType<typeof useT>;

export const auditStreamsQuery = (slug: string | undefined) =>
  ["audit-streams", slug ?? ""] as const;
const deliveriesQuery = (slug: string | undefined, id: string) =>
  ["audit-streams", slug ?? "", id, "deliveries"] as const;

/** The documented check, the same recipe as webhooks (Standard Webhooks). Code, not prose. */
export const VERIFY_SAMPLE = `import { createHmac, timingSafeEqual } from "node:crypto";

// secret: the whsec_ value; headers: the request's headers; body: the raw body as text.
export function verify(secret, headers, body) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(
    "v1," + createHmac("sha256", key).update(\`\${id}.\${timestamp}.\${body}\`).digest("base64"),
  );
  return headers["webhook-signature"].split(" ").some((given) => {
    const candidate = Buffer.from(given);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}`;

interface Revealed {
  label: string;
  host: string;
  secret: string;
  rotated: boolean;
}

/** The section, below the log's controls. `days` is the owner's retention. */
export function AuditStreams({ slug, days }: { slug: string | undefined; days: number }) {
  const t = useT();
  const { api } = useDashboard();
  const list = useQuery({
    queryKey: auditStreamsQuery(slug),
    queryFn: () => api.auditStreams(slug),
    ...refreshOptions,
  });
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const data = list.data;
  // Switched off, or nothing to show and nothing the plan allows: the page offers nothing.
  if (!data || !data.serviceAvailable) return null;
  if (!data.available && data.streams.length === 0) return null;
  const full = data.streams.length >= data.limit;
  return (
    <section aria-labelledby="audit-stream-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="audit-stream-title" className="text-lg font-semibold">
          {t("audit.stream.title")}
        </h2>
        <p className="text-sm text-text-muted">
          {t("audit.stream.description", { minutes: data.settleMinutes })}
        </p>
      </div>
      {data.euOwner ? (
        <Callout tone="info" title={t("audit.stream.euTitle")} icon={<Info className="size-5" />}>
          {t("audit.stream.eu")}
        </Callout>
      ) : null}
      {!data.available ? (
        <Callout tone="info" title={t("audit.stream.planTitle")} icon={<Info className="size-5" />}>
          {t("audit.stream.planRequired", { plan: PLAN_LABELS[lowestPlanWith("auditExport")] })}
        </Callout>
      ) : null}
      {revealed ? <SecretOnce revealed={revealed} onDone={() => setRevealed(null)} /> : null}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <section aria-label={t("audit.stream.list")} className="min-w-0 xl:col-span-2">
          {data.streams.length === 0 ? (
            <EmptyState title={t("audit.stream.empty")} icon={<RadioTower className="size-8" />}>
              <p>{t("audit.stream.emptyBody")}</p>
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {data.streams.map((stream) => (
                <StreamCard
                  key={stream.id}
                  slug={slug}
                  stream={stream}
                  available={data.available}
                  onSecret={setRevealed}
                />
              ))}
            </ul>
          )}
        </section>
        <AddStream
          slug={slug}
          days={days}
          disabled={!data.available || full}
          full={full}
          limit={data.limit}
          onCreated={setRevealed}
        />
      </div>
    </section>
  );
}

/** The signing secret, shown once, with how to check each request. */
function SecretOnce({ revealed, onDone }: { revealed: Revealed; onDone(): void }) {
  const t = useT();
  const announce = useAnnounce();
  return (
    <Callout
      tone="info"
      title={t("audit.stream.secret.title")}
      icon={<KeyRound className="size-5" />}
      action={<Button onClick={onDone}>{t("audit.stream.secret.done")}</Button>}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <p>{t("audit.stream.secret.body")}</p>
        {revealed.rotated ? <p>{t("audit.stream.rotate.body")}</p> : null}
        <CopyField
          label={t("audit.stream.secret.label", { label: revealed.label, host: revealed.host })}
          value={revealed.secret}
          copyLabel={t("audit.stream.secret.copy")}
          copiedLabel={t("copy.copied")}
          onCopied={() => announce(t("copy.done"))}
          onCopyFailed={() => announce(t("copy.failed"))}
        />
        <h3 className="text-sm font-semibold">{t("audit.stream.verify.title")}</h3>
        <p>{t("audit.stream.verify.body")}</p>
        <CodeSample label={t("audit.stream.verify.sample")} code={VERIFY_SAMPLE} />
      </div>
    </Callout>
  );
}

function AddStream(props: {
  slug: string | undefined;
  days: number;
  disabled: boolean;
  full: boolean;
  limit: number;
  onCreated(revealed: Revealed): void;
}) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [start, setStart] = useState<AuditStreamStart>("now");
  const create = useMutation({
    mutationFn: () =>
      api.createAuditStream({ label: label.trim(), url: url.trim(), start }, props.slug),
    onSuccess: async (created) => {
      setLabel("");
      setUrl("");
      props.onCreated({
        label: created.stream.label,
        host: created.stream.host,
        secret: created.secret,
        rotated: false,
      });
      await queryClient.invalidateQueries({ queryKey: auditStreamsQuery(props.slug) });
      announce(t("audit.stream.added", { host: created.stream.host }));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <section
      aria-labelledby="audit-stream-add"
      className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4"
    >
      <h3 id="audit-stream-add" className="text-base font-semibold">
        {t("audit.stream.add.title")}
      </h3>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {props.full ? (
          <p className="text-sm text-text-muted">
            {t("audit.stream.add.limit", { limit: props.limit })}
          </p>
        ) : null}
        <TextInput
          label={t("audit.stream.add.label")}
          autoComplete="off"
          required
          maxLength={80}
          value={label}
          disabled={props.disabled}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
        <TextInput
          label={t("audit.stream.add.url")}
          description={t("audit.stream.add.urlHint")}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          value={url}
          disabled={props.disabled}
          onChange={(event) => setUrl(event.currentTarget.value)}
        />
        <RadioGroup<AuditStreamStart>
          legend={t("audit.stream.add.start")}
          name="audit-stream-start"
          value={start}
          disabled={props.disabled}
          onChange={setStart}
          options={[
            {
              value: "now",
              label: t("audit.stream.start.now"),
              description: t("audit.stream.start.nowHint"),
            },
            {
              value: "oldest",
              label: t("audit.stream.start.oldest"),
              description: t("audit.stream.start.oldestHint", { days: props.days }),
            },
          ]}
        />
        {create.isError ? (
          <Callout
            tone="error"
            title={t("audit.stream.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, create.error)}
          </Callout>
        ) : null}
        <div>
          <Button
            type="submit"
            intent="primary"
            icon={<RadioTower className="size-4" />}
            busy={create.isPending}
            disabled={props.disabled}
          >
            {t("audit.stream.add.submit")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function stateBadge(t: T, stream: AuditStreamView) {
  if (stream.state === "active") {
    return (
      <Badge icon={<CirclePlay className="size-3.5" />}>{t("audit.stream.state.active")}</Badge>
    );
  }
  if (stream.state === "paused") {
    return (
      <Badge emphasis="quiet" icon={<CirclePause className="size-3.5" />}>
        {t("audit.stream.state.paused")}
      </Badge>
    );
  }
  return (
    <Badge emphasis="strong" icon={<TriangleAlert className="size-3.5" />}>
      {t("audit.stream.state.attention")}
    </Badge>
  );
}

/** An attempt in plain words: its outcome, the status class, and why it failed. */
export function streamAttemptText(t: T, attempt: AuditStreamAttempt): string {
  const parts = [
    attempt.statusClass,
    attempt.error ? t(`audit.stream.error.${attempt.error}`) : null,
  ].filter((part): part is string => part !== null);
  const outcome = t(`audit.stream.outcome.${attempt.outcome}`);
  return parts.length > 0 ? `${outcome} (${parts.join(", ")})` : outcome;
}

function StreamCard(props: {
  slug: string | undefined;
  stream: AuditStreamView;
  available: boolean;
  onSecret(revealed: Revealed): void;
}) {
  const { slug, stream, available } = props;
  const t = useT();
  const announce = useAnnounce();
  const relative = useRelativeTime();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const { api } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const label = stream.label;
  const refresh = () => queryClient.invalidateQueries({ queryKey: auditStreamsQuery(slug) });
  const test = useMutation({
    mutationFn: () => api.testAuditStream(stream.id, slug),
    onSuccess: async () => {
      await refresh();
      announce(t("audit.stream.testQueued", { label }));
    },
  });
  const toggle = useMutation({
    mutationFn: (state: "active" | "paused") => api.updateAuditStream(stream.id, { state }, slug),
    onSuccess: async (next) => {
      await refresh();
      announce(
        t(next.stream.state === "active" ? "audit.stream.resumed" : "audit.stream.paused", {
          label,
        }),
      );
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.updateAuditStream(stream.id, { rotateSecret: true }, slug),
    onSuccess: async (next) => {
      if (next.secret) {
        props.onSecret({ label, host: next.stream.host, secret: next.secret, rotated: true });
      }
      await refresh();
      announce(t("audit.stream.rotated", { label }));
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeAuditStream(stream.id, slug),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      announce(t("audit.stream.removed", { label }));
    },
    onError: () => setConfirming(false),
  });
  const failed = test.error ?? toggle.error ?? rotate.error ?? remove.error;
  const busy = test.isPending || toggle.isPending || rotate.isPending || remove.isPending;
  const active = stream.state === "active";
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-base font-semibold break-words">{label}</h3>
          <p className="text-sm break-all text-text-muted">{stream.host}</p>
          <div className="mt-1.5 flex flex-wrap gap-2">{stateBadge(t, stream)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Send className="size-4" />}
            aria-label={t("audit.stream.testLabel", { label })}
            busy={test.isPending}
            disabled={busy || !available}
            onClick={() => test.mutate()}
          >
            {t("audit.stream.test")}
          </Button>
          <Button
            size="sm"
            icon={active ? <CirclePause className="size-4" /> : <CirclePlay className="size-4" />}
            aria-label={t(active ? "audit.stream.pauseLabel" : "audit.stream.resumeLabel", {
              label,
            })}
            busy={toggle.isPending}
            disabled={busy || (!active && !available)}
            onClick={() => toggle.mutate(active ? "paused" : "active")}
          >
            {t(active ? "audit.stream.pause" : "audit.stream.resume")}
          </Button>
          <Button
            size="sm"
            icon={<KeyRound className="size-4" />}
            aria-label={t("audit.stream.rotateLabel", { label })}
            busy={rotate.isPending}
            disabled={busy}
            onClick={() => rotate.mutate()}
          >
            {t("audit.stream.rotate")}
          </Button>
          <Button
            size="sm"
            intent="danger"
            icon={<Trash2 className="size-4" />}
            aria-label={t("audit.stream.removeLabel", { label })}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("audit.stream.remove")}
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-text-muted">
        {stream.pausedReason ? <li>{t(`audit.stream.reason.${stream.pausedReason}`)}</li> : null}
        <li>
          {stream.deliveredThrough ? (
            <time dateTime={stream.deliveredThrough}>
              {t("audit.stream.through", { when: relative(stream.deliveredThrough) })}
            </time>
          ) : (
            t("audit.stream.notYet")
          )}
        </li>
        {stream.failures > 0 ? (
          <li>{t("audit.stream.failures", { count: stream.failures })}</li>
        ) : null}
        <li>
          {stream.lastAttempt ? (
            <time dateTime={stream.lastAttempt.at}>
              {t("audit.stream.lastAttempt", {
                when: relative(stream.lastAttempt.at),
                outcome: streamAttemptText(t, stream.lastAttempt),
              })}
            </time>
          ) : (
            t("audit.stream.noAttempts")
          )}
        </li>
        {stream.testPending ? <li>{t("audit.stream.testPending")}</li> : null}
      </ul>
      {stream.lastGap ? (
        <Callout
          tone="info"
          title={t("audit.stream.gapTitle")}
          icon={<TriangleAlert className="size-5" />}
        >
          {t("audit.stream.gap", {
            from: formatDate(stream.lastGap.from, true),
            to: formatDate(stream.lastGap.to, true),
          })}
        </Callout>
      ) : null}
      {failed ? (
        <Callout
          tone="error"
          title={t("audit.stream.failed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, failed)}
        </Callout>
      ) : null}
      <div className="border-t border-border pt-2">
        <DeliveryLog slug={slug} stream={stream} />
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("audit.stream.confirm.title", { label })}
        confirmLabel={t("audit.stream.remove")}
        cancelLabel={t("account.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("audit.stream.confirm.body")}
      </ConfirmDialog>
    </li>
  );
}

/** The last days of requests, fetched when it is opened. */
function DeliveryLog({ slug, stream }: { slug: string | undefined; stream: AuditStreamView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      appearance="inline"
      summary={t("audit.stream.deliveries")}
      label={t("audit.stream.deliveriesOf", { label: stream.label })}
      onToggle={setOpen}
    >
      {open ? <DeliveryTable slug={slug} stream={stream} /> : null}
    </Disclosure>
  );
}

function DeliveryTable({ slug, stream }: { slug: string | undefined; stream: AuditStreamView }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  const log = useQuery({
    queryKey: deliveriesQuery(slug, stream.id),
    queryFn: () => api.auditStreamDeliveries(stream.id, slug),
  });
  if (log.isPending) return <LoadingState label={t("audit.stream.deliveries.loading")} />;
  if (log.isError) {
    return (
      <Callout
        tone="error"
        title={t("audit.stream.deliveries.error")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, log.error)}
      </Callout>
    );
  }
  if (log.data.attempts.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {t("audit.stream.deliveries.empty", { days: log.data.retentionDays })}
      </p>
    );
  }
  return (
    <Table caption={t("audit.stream.deliveriesOf", { label: stream.label })} stacked>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("audit.stream.deliveries.time")}</TableHeaderCell>
          <TableHeaderCell>{t("audit.stream.deliveries.events")}</TableHeaderCell>
          <TableHeaderCell>{t("audit.stream.deliveries.outcome")}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {log.data.attempts.map((attempt, index) => (
          <TableRow key={`${attempt.at}:${index}`}>
            <TableCell label={t("audit.stream.deliveries.time")}>
              <time dateTime={attempt.at}>{formatDate(attempt.at, true)}</time>
            </TableCell>
            <TableCell label={t("audit.stream.deliveries.events")} stack="inline">
              {String(attempt.events)}
            </TableCell>
            <TableCell label={t("audit.stream.deliveries.outcome")} stack="inline">
              {streamAttemptText(t, attempt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
