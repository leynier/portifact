import {
  AccessMode,
  AnnotationsState,
  ArtifactListFilters,
  type ArtifactListItem,
  ArtifactType,
  LIST_SEARCH_MAX,
  ListedArtifactState,
} from "@portifact/contracts";
import {
  Button,
  buttonClasses,
  Callout,
  CopyField,
  EmptyState,
  LoadingState,
  PageHeader,
  rowControlClasses,
  rowLinkClasses,
  Sheet,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useMediaQuery,
  WIDE_QUERY,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Bot,
  CircleAlert,
  ExternalLink,
  Inbox,
  MessageSquareText,
  RefreshCw,
  SearchX,
  SlidersHorizontal,
  SquareTerminal,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatBytes, useFormatDate, useT } from "../context.tsx";
import { AccessBadge, StateBadge, TypeIcon } from "../presentation.tsx";
import { refreshOptions } from "../refresh.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { TrafficNotice, trafficBlock, useUsage } from "./usage.tsx";

export const ARTIFACTS_QUERY = ["artifacts"] as const;

type T = ReturnType<typeof useT>;

/**
 * The list's search and filters from the URL, so they survive going to an artifact and back
 * and can be shared. A value the API would refuse is dropped, one field at a time.
 */
export function parseListSearch(search: Record<string, unknown>): ArtifactListFilters {
  const filters: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ArtifactListFilters.shape)) {
    const parsed = schema.safeParse(search[name]);
    if (parsed.success && parsed.data !== undefined) filters[name] = parsed.data;
  }
  return filters as ArtifactListFilters;
}

const ANY = "any";

/** The form's values: every select has an "any" option, which means no filter. */
interface FilterValues {
  search: string;
  state: string;
  type: string;
  access: string;
  annotations: string;
}

function formValues(filters: ArtifactListFilters): FilterValues {
  return {
    search: filters.search ?? "",
    state: filters.state ?? ANY,
    type: filters.type ?? ANY,
    access: filters.access ?? ANY,
    annotations: filters.annotations ?? ANY,
  };
}

function filtersOf(values: FilterValues): ArtifactListFilters {
  return parseListSearch({
    search: values.search,
    ...Object.fromEntries(
      (["state", "type", "access", "annotations"] as const)
        .filter((name) => values[name] !== ANY)
        .map((name) => [name, values[name]]),
    ),
  });
}

export function ArtifactListScreen() {
  const t = useT();
  const formatDate = useFormatDate();
  const { api } = useDashboard();
  // The router keeps search keys a route does not validate, so parse again what it hands over.
  const filters = parseListSearch(useSearch({ from: "/" }));
  const navigate = useNavigate();
  const filtered = Object.keys(filters).length > 0;
  useDocumentTitle(t("list.title"));
  // Only to explain a traffic block; the list works the same if usage cannot be loaded.
  const traffic = trafficBlock(useUsage().data);

  const list = useInfiniteQuery({
    queryKey: [...ARTIFACTS_QUERY, filters],
    queryFn: ({ pageParam }) => api.listArtifacts(pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // The last results stay on screen while a new search loads, so the form never moves.
    placeholderData: keepPreviousData,
    ...refreshOptions,
  });
  const apply = (next: ArtifactListFilters) => {
    void navigate({ to: "/", search: next });
  };

  const header = (
    <PageHeader
      title={t("list.title")}
      description={t("list.description")}
      actions={
        <Link to="/publish" className={buttonClasses({ intent: "primary" })}>
          <Upload aria-hidden="true" className="size-4" />
          {t("list.publish")}
        </Link>
      }
    />
  );

  if (list.isPending) {
    return (
      <>
        {header}
        <LoadingState label={t("list.loading")} skeleton={5} />
      </>
    );
  }

  if (list.isError && !list.data) {
    return (
      <>
        {header}
        <Callout
          tone="error"
          title={t("list.error.title")}
          icon={<CircleAlert className="size-5" />}
          action={
            <Button icon={<RefreshCw className="size-4" />} onClick={() => list.refetch()}>
              {t("action.retry")}
            </Button>
          }
        >
          {errorMessage(t, list.error)}
        </Callout>
      </>
    );
  }

  const artifacts = list.data.pages.flatMap((page) => page.items);
  // Without any artifact there is nothing to search; a search that finds nothing keeps the form.
  const searchable = filtered || artifacts.length > 0;
  const searching = list.isPlaceholderData;

  return (
    <>
      {header}
      {traffic ? (
        <div className="mb-6">
          <TrafficNotice block={traffic} link />
        </div>
      ) : null}
      {list.isRefetchError ? (
        <div className="mb-6">
          <Callout title={t("list.refreshFailed.title")} icon={<CircleAlert className="size-5" />}>
            {t("list.refreshFailed.body")}
          </Callout>
        </div>
      ) : null}
      {searchable ? (
        <div className="mb-6">
          <FilterForm filters={filters} filtered={filtered} onApply={apply} />
        </div>
      ) : null}
      {artifacts.length === 0 && !searching ? (
        filtered ? (
          <EmptyState title={t("list.noMatch.title")} icon={<SearchX className="size-8" />}>
            <p role="status">{t("list.noMatch.body")}</p>
          </EmptyState>
        ) : (
          <FirstPublish />
        )
      ) : (
        <>
          <Table caption={t(filtered ? "list.captionFiltered" : "list.caption")} stacked>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("list.column.name")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.state")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.access")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.expires")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.usage")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.activity")}</TableHeaderCell>
                <TableHeaderCell>
                  <span className="sr-only">{t("list.column.actions")}</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {artifacts.map((artifact) => (
                <TableRow key={artifact.id} linked>
                  <TableCell>
                    <span className="flex min-w-40 items-center gap-3">
                      <TypeIcon type={artifact.type} />
                      <span className="flex min-w-0 flex-col">
                        <Link
                          to="/artifacts/$artifactId"
                          params={{ artifactId: artifact.id }}
                          className={`font-semibold ${rowLinkClasses}`}
                        >
                          {artifact.name}
                        </Link>
                        <span className="flex flex-wrap gap-x-2 text-xs text-text-muted">
                          <span>{t(`type.${artifact.type}`)}</span>
                          <span className="font-mono">{artifact.id}</span>
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell stack="inline">
                    <StateBadge state={artifact.state} />
                  </TableCell>
                  <TableCell stack="inline">
                    <AccessBadge mode={artifact.accessMode} />
                  </TableCell>
                  <TableCell stack="inline" label={t("list.column.expires")}>
                    <span className="whitespace-nowrap tabular-nums">
                      {artifact.expiresAt ? formatDate(artifact.expiresAt) : t("list.never")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <UsageCell artifact={artifact} />
                  </TableCell>
                  <TableCell>
                    <ActivityCell artifact={artifact} />
                  </TableCell>
                  <TableCell stack="end">
                    <RowActions artifact={artifact} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <p role="status" className="text-sm text-text-muted">
              {countMessage(t, {
                searching,
                loadingMore: list.isFetchingNextPage,
                filtered,
                count: artifacts.length,
              })}
            </p>
            {list.hasNextPage && !searching ? (
              <Button busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                {t("list.loadMore")}
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {t("list.trafficNote")}{" "}
            <Link to="/account" hash="usage">
              {t("list.trafficLink")}
            </Link>
          </p>
        </>
      )}
    </>
  );
}

/** What the artifact's current version stores and how many versions are kept. */
function UsageCell({ artifact }: { artifact: ArtifactListItem }) {
  const t = useT();
  const formatBytes = useFormatBytes();
  const { activity } = artifact;
  return (
    <>
      <span className="block whitespace-nowrap tabular-nums">
        {activity.currentBytes === null ? t("list.noVersion") : formatBytes(activity.currentBytes)}
      </span>
      <span className="block whitespace-nowrap text-text-muted">
        {t("list.versions", { count: activity.versions })}
      </span>
    </>
  );
}

/** The last update, the open threads while comments can be on, and the last thread change. */
function ActivityCell({ artifact }: { artifact: ArtifactListItem }) {
  const t = useT();
  const formatDate = useFormatDate();
  const { activity } = artifact;
  return (
    <>
      <span className="block min-w-28">
        {t("list.updated", { date: formatDate(artifact.updatedAt) })}
      </span>
      {artifact.annotations !== "off" || activity.openThreads > 0 ? (
        <span
          className={`block min-w-28 ${activity.openThreads > 0 ? "font-semibold" : "text-text-muted"}`}
        >
          {t("list.openThreads", { count: activity.openThreads })}
        </span>
      ) : null}
      {activity.lastAnnotationAt ? (
        <span className="block min-w-28 text-text-muted">
          {t("list.lastComment", { date: formatDate(activity.lastAnnotationAt) })}
        </span>
      ) : null}
    </>
  );
}

/** Quick ways into an artifact from its row: the published page and, while active, review. */
function RowActions({ artifact }: { artifact: ArtifactListItem }) {
  const t = useT();
  const servable = artifact.state === "active";
  return (
    <span className={`flex justify-end gap-1 ${rowControlClasses}`}>
      {servable ? (
        <>
          <a
            href={artifact.url}
            aria-label={t("list.openLabel", { name: artifact.name })}
            title={t("list.open")}
            className={buttonClasses({ intent: "ghost", size: "sm" })}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
          {/* A full page load, so the viewer gets its own policy (frames of this artifact only). */}
          <a
            href={`/view/${encodeURIComponent(artifact.id)}`}
            aria-label={t("list.reviewLabel", { name: artifact.name })}
            title={t("list.review")}
            className={buttonClasses({ intent: "ghost", size: "sm" })}
          >
            <MessageSquareText aria-hidden="true" className="size-4" />
          </a>
        </>
      ) : null}
    </span>
  );
}

/**
 * The empty list teaches the three ways to publish, each with what it needs: the browser upload,
 * the CLI commands and the MCP server URL for agents.
 */
function FirstPublish() {
  const t = useT();
  const announce = useAnnounce();
  const copied = () => announce(t("copy.done"));
  const failed = () => announce(t("copy.failed"));
  const copy = { copiedLabel: t("copy.copied"), onCopied: copied, onCopyFailed: failed };
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <EmptyState
      title={t("list.empty.title")}
      icon={<Inbox className="size-5" />}
      action={
        <ul className="grid w-full gap-4 text-sm lg:grid-cols-3">
          <Way
            icon={<Upload className="size-4" />}
            title={t("list.onboarding.browser.title")}
            body={t("list.onboarding.browser.body")}
          >
            <div>
              <Link to="/publish" className={buttonClasses({ intent: "primary" })}>
                <Upload aria-hidden="true" className="size-4" />
                {t("list.onboarding.browser.action")}
              </Link>
            </div>
          </Way>
          <Way
            icon={<SquareTerminal className="size-4" />}
            title={t("list.onboarding.cli.title")}
            body={t("list.onboarding.cli.body")}
          >
            <CopyField
              kind="command"
              label={t("list.onboarding.cli.install")}
              value="curl -fsSL https://portifact.com/install | bash"
              copyLabel={t("list.onboarding.cli.copy")}
              {...copy}
            />
            <CopyField
              kind="command"
              label={t("list.onboarding.cli.publish")}
              value="portifact publish ./report.html"
              copyLabel={t("list.onboarding.cli.copy")}
              {...copy}
            />
          </Way>
          <Way
            icon={<Bot className="size-4" />}
            title={t("list.onboarding.mcp.title")}
            body={t("list.onboarding.mcp.body")}
          >
            <CopyField
              label={t("list.onboarding.mcp.url")}
              value={mcpUrl}
              copyLabel={t("list.onboarding.mcp.copy")}
              {...copy}
            />
          </Way>
        </ul>
      }
    >
      <p>{t("list.onboarding.lead")}</p>
    </EmptyState>
  );
}

function Way({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-4 rounded-md border border-border bg-surface p-4">
      <div>
        <h3 className="flex items-center gap-2 font-semibold">
          <span aria-hidden="true" className="inline-flex">
            {icon}
          </span>
          {title}
        </h3>
        <p className="mt-1 text-text-muted">{body}</p>
      </div>
      <div className="mt-auto flex flex-col gap-3">{children}</div>
    </li>
  );
}

function countMessage(
  t: T,
  state: { searching: boolean; loadingMore: boolean; filtered: boolean; count: number },
): string {
  if (state.searching) return t("list.searching");
  if (state.loadingMore) return t("list.loadingMore");
  return t(state.filtered ? "list.countFiltered" : "list.count", { count: state.count });
}

/**
 * Search by name or ID and filter by state, type, access and comments, as one compact toolbar.
 * The API applies them, so they cover every page, not only the loaded one. A filter applies as
 * soon as it changes and the search on Enter; both go to the URL.
 */
function FilterForm({
  filters,
  filtered,
  onApply,
}: {
  filters: ArtifactListFilters;
  filtered: boolean;
  onApply(filters: ArtifactListFilters): void;
}) {
  const t = useT();
  const form = useAppForm({
    defaultValues: formValues(filters),
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        value.search.trim().length > LIST_SEARCH_MAX
          ? { fields: { search: t("list.filter.searchTooLong", { max: LIST_SEARCH_MAX }) } }
          : undefined,
    },
    onSubmit: ({ value }) => onApply(filtersOf(value)),
  });
  // Back and forward change the URL: the form follows it.
  const current = JSON.stringify(filters);
  useEffect(() => {
    form.reset(formValues(JSON.parse(current) as ArtifactListFilters));
  }, [current]);

  const wide = useMediaQuery(WIDE_QUERY);
  const [sheet, setSheet] = useState(false);
  // Filters that are on, besides the search, for the narrow layout's "Filters" button.
  const active = (["state", "type", "access", "annotations"] as const).filter(
    (name) => filters[name] !== undefined,
  ).length;
  const any = { value: ANY, label: t("list.filter.any") };
  const applyOnChange = { onChange: () => void form.handleSubmit() };
  const filter = (
    name: "state" | "type" | "access" | "annotations",
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <form.AppField name={name} listeners={applyOnChange}>
      {(field) => (
        <field.SelectField
          variant={wide ? "compact" : "field"}
          label={label}
          active={field.state.value !== ANY}
          options={[any, ...options]}
        />
      )}
    </form.AppField>
  );
  const selects = (
    <>
      {filter(
        "state",
        t("list.filter.state"),
        ListedArtifactState.options.map((value) => ({ value, label: t(`state.${value}`) })),
      )}
      {filter(
        "type",
        t("list.filter.type"),
        ArtifactType.options.map((value) => ({ value, label: t(`type.${value}`) })),
      )}
      {filter(
        "access",
        t("list.filter.access"),
        AccessMode.options.map((value) => ({ value, label: t(`list.access.${value}`) })),
      )}
      {filter(
        "annotations",
        t("list.filter.annotations"),
        AnnotationsState.options.map((value) => ({
          value,
          label: t(`list.annotations.${value}`),
        })),
      )}
    </>
  );
  const clear = filtered ? (
    <span className="inline-flex h-8 items-center px-1">
      <Button intent="link" size="inline" onClick={() => onApply({})}>
        {t("list.filter.clear")}
      </Button>
    </span>
  ) : null;
  return (
    <form.AppForm>
      <form.Form label={t("list.filter.label")}>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 sm:w-80 sm:flex-none">
            <form.AppField name="search">
              {(field) => (
                <field.SearchField
                  label={t("list.filter.search")}
                  placeholder={t("list.filter.searchPlaceholder")}
                  clearLabel={t("list.filter.clearSearch")}
                  autoComplete="off"
                  enterKeyHint="search"
                />
              )}
            </form.AppField>
          </div>
          {wide ? (
            <>
              {selects}
              {clear}
            </>
          ) : (
            // Phones keep the search in sight and put the filters in a sheet.
            <>
              <Button
                size="sm"
                icon={<SlidersHorizontal className="size-4" />}
                aria-haspopup="dialog"
                onClick={() => setSheet(true)}
              >
                {t("list.filter.open")}
                {active > 0 ? (
                  <span className="rounded-xs bg-surface-inverse px-1.5 text-xs font-semibold text-text-inverse tabular-nums">
                    {active}
                    <span className="sr-only"> {t("list.filter.activeCount")}</span>
                  </span>
                ) : null}
              </Button>
              {clear ? <div className="w-full">{clear}</div> : null}
              <Sheet
                open={sheet}
                title={t("list.filter.sheetTitle")}
                closeLabel={t("list.filter.close")}
                onClose={() => setSheet(false)}
                footer={
                  <>
                    {filtered ? (
                      <Button intent="ghost" onClick={() => onApply({})}>
                        {t("list.filter.clear")}
                      </Button>
                    ) : null}
                    <Button intent="primary" onClick={() => setSheet(false)}>
                      {t("list.filter.done")}
                    </Button>
                  </>
                }
              >
                <div className="flex flex-col gap-4">{selects}</div>
              </Sheet>
            </>
          )}
        </div>
      </form.Form>
    </form.AppForm>
  );
}

/** The message for a failed call, from its documented error code. */
export function errorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  return t(`error.${error instanceof ApiFailure ? error.code : "unexpected"}`);
}
