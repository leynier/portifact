// "Download your data" (`/data`, decision 0022, second delivery): everything a space holds that
// can be taken out, from routes that already exist. Each artifact with its retained versions and
// their download buttons (the version download route, published files and sources), each artifact's
// access log as CSV and JSON and its records (settings, access, share links, the approval review,
// analytics, comments and their history), the space's records (members, groups, invitations,
// domains, policies, tokens, branding and the like, without secrets), the audit log's export and,
// for a personal space, the account's export; and, while a plan's grace runs, what goes on which
// date. It lists and links; nothing is archived on the server. Offered to the space's admins.
import type {
  ArtifactListItem,
  DownloadKind,
  GraceForecastKind,
  VersionSummary,
} from "@portifact/contracts";
import { accountExportFileName } from "@portifact/contracts/account-export";
import { PLAN_LABELS } from "@portifact/contracts/plans";
import {
  Button,
  backLinkClasses,
  Callout,
  Disclosure,
  PageHeader,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from "@portifact/ui";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, Download, Lock } from "lucide-react";
import { useState } from "react";
import { accessLogCsv, accessLogJson, loadWholeAccessLog } from "../access-log-export.ts";
import { ACCOUNT_EXPORT_PATH, BRAND_PATH } from "../api.ts";
import { useAnnounce, useDashboard, useFormatBytes, useFormatDate, useT } from "../context.tsx";
import { downloadVersion } from "../publish/download.ts";
import { artifactRecordsFile, type RecordsDownload, spaceRecordsFile } from "../records-export.ts";
import { refreshOptions } from "../refresh.ts";
import { type Space, spaceCan, useReadySpace } from "../space.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { Loaded, Section } from "./account.tsx";
import { SpaceBadge } from "./space-parts.tsx";
import { useUsage } from "./usage.tsx";

const KIND_KEYS = {
  versions: "data.kind.versions",
  accessLog: "data.kind.accessLog",
  analytics: "data.kind.analytics",
  auditEvents: "data.kind.auditEvents",
  pins: "data.kind.pins",
} as const satisfies Record<GraceForecastKind, string>;

export function DownloadDataScreen() {
  const t = useT();
  useDocumentTitle(t("data.title"));
  const space = useReadySpace();
  const allowed = spaceCan(space, "plan");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          // Reached from Settings ("Your data"), the grace notice and the Plan page; not the menu.
          <Link to="/settings" hash="data" className={backLinkClasses}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            {t("settings.title")}
          </Link>
        }
        title={t("data.title")}
        meta={<SpaceBadge owner={space} />}
        description={t("data.description")}
      />
      {allowed ? (
        <>
          <GraceSection space={space} />
          <ArtifactsSection space={space} />
          <SpaceRecordsSection space={space} />
          <LogsSection space={space} />
        </>
      ) : (
        <Callout title={t("space.notAllowed.title")} icon={<Lock className="size-5" />}>
          {t("data.adminsOnly", { workspace: space.kind === "workspace" ? space.name : "" })}
        </Callout>
      )}
    </div>
  );
}

/** While a grace runs: until when, and what goes on which date, per kind, with counts. */
function GraceSection({ space }: { space: Space }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  const usage = useUsage(space.slug, true);
  const grace = usage.data?.plan.grace ?? null;
  const forecast = useQuery({
    queryKey: ["grace-forecast", space.slug ?? null],
    queryFn: () => api.graceForecast(space.slug),
    enabled: grace !== null,
    ...refreshOptions,
  });
  if (!grace) return null;
  return (
    <Section id="grace" title={t("data.grace.title")} hint={t("data.grace.hint")}>
      <div className="flex flex-col gap-4">
        <Callout
          title={t("plan.grace.title", {
            plan: PLAN_LABELS[grace.plan],
            date: formatDate(grace.until, true),
          })}
          icon={<Clock className="size-5" />}
        >
          {t("data.grace.body")}
        </Callout>
        <Loaded query={forecast} loading={t("data.grace.loading")} error={t("data.grace.error")}>
          {(view) =>
            view.kinds.length === 0 ? (
              <p className="text-sm text-text-muted">{t("data.grace.nothing")}</p>
            ) : (
              <Table caption={t("data.grace.caption")} variant="flush" stacked>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t("data.grace.column.kind")}</TableHeaderCell>
                    <TableHeaderCell>{t("data.grace.column.count")}</TableHeaderCell>
                    <TableHeaderCell>{t("data.grace.column.from")}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {view.kinds.map((kind) => (
                    // A kind can go in several steps, one per hold end at which its retention drops.
                    <TableRow key={`${kind.kind}:${kind.from}`}>
                      <TableRowHeader>{t(KIND_KEYS[kind.kind])}</TableRowHeader>
                      <TableCell label={t("data.grace.column.count")}>{kind.count}</TableCell>
                      <TableCell label={t("data.grace.column.from")}>
                        {formatDate(kind.from, true)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </Loaded>
      </div>
    </Section>
  );
}

/** Every artifact of the space, a page at a time, each with its retained versions on demand. */
function ArtifactsSection({ space }: { space: Space }) {
  const t = useT();
  const { api } = useDashboard();
  const artifacts = useInfiniteQuery({
    queryKey: ["data-artifacts", space.slug ?? null],
    queryFn: ({ pageParam }) => api.listArtifacts(pageParam, {}, space.slug),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...refreshOptions,
  });
  const items = artifacts.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Section id="artifacts" title={t("data.artifacts.title")} hint={t("data.artifacts.hint")}>
      <div className="flex flex-col gap-3">
        {artifacts.isPending ? <p className="text-sm">{t("data.artifacts.loading")}</p> : null}
        {artifacts.isError ? <Callout tone="error" title={t("data.artifacts.error")} /> : null}
        {artifacts.isSuccess && items.length === 0 ? (
          <p className="text-sm text-text-muted">{t("data.artifacts.none")}</p>
        ) : null}
        {items.map((artifact) => (
          <ArtifactDownloads key={artifact.id} artifact={artifact} space={space} />
        ))}
        {artifacts.hasNextPage ? (
          <div>
            <Button busy={artifacts.isFetchingNextPage} onClick={() => artifacts.fetchNextPage()}>
              {t("data.artifacts.more")}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ArtifactDownloads({ artifact, space }: { artifact: ArtifactListItem; space: Space }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      summary={t("data.artifact.summary", {
        name: artifact.name,
        count: artifact.activity.versions,
      })}
      onToggle={setOpen}
    >
      {open ? <VersionDownloads artifact={artifact} space={space} /> : null}
    </Disclosure>
  );
}

function VersionDownloads({ artifact, space }: { artifact: ArtifactListItem; space: Space }) {
  const t = useT();
  const formatDate = useFormatDate();
  const formatBytes = useFormatBytes();
  const announce = useAnnounce();
  const { api, storage, save } = useDashboard();
  const versions = useInfiniteQuery({
    queryKey: ["data-versions", artifact.id],
    queryFn: ({ pageParam }) => api.listVersions(artifact.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const download = useMutation({
    mutationFn: (input: { version: VersionSummary; kind: DownloadKind }) =>
      downloadVersion({
        api,
        transport: storage,
        artifactId: artifact.id,
        versionId: input.version.id,
        kind: input.kind,
        name: artifact.name,
      }),
    onMutate: () => announce(t("history.downloading")),
    onSuccess: (file) => {
      save(file);
      announce(t("history.downloaded", { file: file.fileName }));
    },
  });
  const accessLog = useMutation({
    mutationFn: async (format: "csv" | "json") => {
      const log = await loadWholeAccessLog(api, artifact.id);
      return format === "csv" ? accessLogCsv(log.entries) : accessLogJson(log);
    },
    onSuccess: (text, format) => {
      save({
        fileName: `${artifact.id}-access-log.${format}`,
        blob: new Blob([text], { type: format === "csv" ? "text/csv" : "application/json" }),
      });
      announce(t("data.accessLog.saved"));
    },
  });
  const records = useRecordsDownload(() => artifactRecordsFile(api, artifact.id, Date.now()));
  const all = versions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {download.isError || accessLog.isError ? (
        <Callout tone="error" title={t("history.downloadFailed.title")} />
      ) : null}
      <RecordsOutcome records={records} />
      <Panel title={t("data.versions.title", { name: artifact.name })} flush>
        <Table
          caption={t("data.versions.caption", { name: artifact.name })}
          variant="flush"
          stacked
        >
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("history.column.version")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.published")}</TableHeaderCell>
              <TableHeaderCell>{t("data.versions.size")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.actions")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {all.map((version) => (
              <TableRow key={version.id}>
                <TableRowHeader>
                  {t("history.version", { number: version.number })}
                  {version.current ? ` (${t("history.current")})` : ""}
                </TableRowHeader>
                <TableCell label={t("history.column.published")}>
                  {formatDate(version.committedAt, true)}
                </TableCell>
                <TableCell label={t("data.versions.size")}>
                  {formatBytes(version.publishedBytes + version.sourceBytes)}
                </TableCell>
                <TableCell label={t("history.column.actions")}>
                  <div className="flex flex-wrap gap-2">
                    {(["published", "source"] as const)
                      .filter((kind) => kind === "published" || version.sourceFiles > 0)
                      .map((kind) => (
                        <Button
                          key={kind}
                          intent="ghost"
                          size="sm"
                          icon={<Download className="size-4" />}
                          aria-label={t(
                            kind === "published"
                              ? "history.downloadLabel"
                              : "history.downloadSourcesLabel",
                            { number: version.number },
                          )}
                          busy={
                            download.isPending &&
                            download.variables.version.id === version.id &&
                            download.variables.kind === kind
                          }
                          disabled={download.isPending}
                          onClick={() => download.mutate({ version, kind })}
                        >
                          {t(kind === "published" ? "history.download" : "history.downloadSources")}
                        </Button>
                      ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {versions.hasNextPage ? (
          <div className="border-t border-border px-5 py-4">
            <Button busy={versions.isFetchingNextPage} onClick={() => versions.fetchNextPage()}>
              {t("history.loadMore")}
            </Button>
          </div>
        ) : null}
      </Panel>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          aria-label={t("data.records.label", { name: artifact.name })}
          busy={records.isPending}
          disabled={records.isPending}
          onClick={() => records.mutate()}
        >
          {t("data.records.button")}
        </Button>
        {spaceCan(space, "access_log")
          ? (["csv", "json"] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                icon={<Download className="size-4" />}
                aria-label={t(
                  format === "csv" ? "data.accessLog.csvLabel" : "data.accessLog.jsonLabel",
                  { name: artifact.name },
                )}
                busy={accessLog.isPending && accessLog.variables === format}
                disabled={accessLog.isPending}
                onClick={() => accessLog.mutate(format)}
              >
                {t(format === "csv" ? "data.accessLog.csv" : "data.accessLog.json")}
              </Button>
            ))
          : null}
      </div>
    </div>
  );
}

/** Downloads a records file, saving it and announcing it. */
function useRecordsDownload(build: () => Promise<RecordsDownload>) {
  const t = useT();
  const announce = useAnnounce();
  const { save } = useDashboard();
  return useMutation({
    mutationFn: build,
    onSuccess: (download) => {
      save(download.file);
      announce(t(download.retryLater ? "data.records.later" : "data.records.saved"));
    },
  });
}

function RecordsOutcome({ records }: { records: ReturnType<typeof useRecordsDownload> }) {
  const t = useT();
  if (records.isError) return <Callout tone="error" title={t("data.records.failed")} />;
  if (records.data?.retryLater) return <Callout title={t("data.records.later")} />;
  return null;
}

/** The space's own records, and its brand's logo when there is one. */
function SpaceRecordsSection({ space }: { space: Space }) {
  const t = useT();
  const { api } = useDashboard();
  const records = useRecordsDownload(() => spaceRecordsFile(api, space, Date.now()));
  const brand = useQuery({
    queryKey: ["data-brand", space.slug ?? null],
    queryFn: () => api.brandSettings(space.slug),
    ...refreshOptions,
  });
  const logo = brand.data?.brand?.logo ?? null;
  const query =
    space.slug === undefined ? "" : `?${new URLSearchParams({ workspace: space.slug })}`;
  return (
    <Section id="space-records" title={t("data.space.title")} hint={t("data.space.hint")}>
      <div className="flex flex-col gap-3">
        <RecordsOutcome records={records} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            icon={<Download className="size-4" />}
            busy={records.isPending}
            disabled={records.isPending}
            onClick={() => records.mutate()}
          >
            {t("data.space.download")}
          </Button>
          {logo ? (
            <a href={`${BRAND_PATH}/logo${query}`} download className="text-sm font-semibold">
              {t("data.space.logo")}
            </a>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/** The space's logs and, for a personal space, the account's own export. */
function LogsSection({ space }: { space: Space }) {
  const t = useT();
  return (
    <Section id="logs" title={t("data.logs.title")} hint={t("data.logs.hint")}>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
        {spaceCan(space, "audit") ? (
          <li>
            <Link to="/audit" className="font-semibold">
              {t("data.logs.audit")}
            </Link>
          </li>
        ) : null}
        {space.kind === "personal" ? (
          <li>
            <a
              href={ACCOUNT_EXPORT_PATH}
              download={accountExportFileName(Date.now())}
              className="font-semibold"
            >
              {t("data.logs.account")}
            </a>
          </li>
        ) : null}
        <li>{t("data.logs.cli")}</li>
      </ul>
    </Section>
  );
}
