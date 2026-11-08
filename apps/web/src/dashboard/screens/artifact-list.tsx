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
  EmptyState,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert, Inbox, RefreshCw, Search, SearchX, Upload, X } from "lucide-react";
import { useEffect } from "react";
import { ApiFailure } from "../api.ts";
import { useDashboard, useFormatBytes, useFormatDate, useT } from "../context.tsx";
import { StateBadge } from "../presentation.tsx";
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
        <LoadingState label={t("list.loading")} />
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
          <FilterForm filters={filters} busy={searching} onApply={apply} />
        </div>
      ) : null}
      {artifacts.length === 0 && !searching ? (
        filtered ? (
          <EmptyState title={t("list.noMatch.title")} icon={<SearchX className="size-8" />}>
            <p role="status">{t("list.noMatch.body")}</p>
          </EmptyState>
        ) : (
          <EmptyState title={t("list.empty.title")} icon={<Inbox className="size-8" />}>
            <p>{t("list.empty.body")}</p>
            <p className="mt-3">
              <code className="rounded-xs bg-surface px-2 py-1 font-mono text-text">
                portifact publish ./report.html
              </code>
            </p>
          </EmptyState>
        )
      ) : (
        <>
          <Table caption={t(filtered ? "list.captionFiltered" : "list.caption")}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t("list.column.name")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.type")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.state")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.access")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.expires")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.usage")}</TableHeaderCell>
                <TableHeaderCell>{t("list.column.activity")}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {artifacts.map((artifact) => (
                <TableRow key={artifact.id}>
                  <TableCell>
                    <Link
                      to="/artifacts/$artifactId"
                      params={{ artifactId: artifact.id }}
                      className="font-medium"
                    >
                      {artifact.name}
                    </Link>
                  </TableCell>
                  <TableCell>{t(`type.${artifact.type}`)}</TableCell>
                  <TableCell>
                    <StateBadge state={artifact.state} />
                  </TableCell>
                  <TableCell>{t(`list.access.${artifact.accessMode}`)}</TableCell>
                  <TableCell>
                    {artifact.expiresAt ? formatDate(artifact.expiresAt) : t("list.never")}
                  </TableCell>
                  <TableCell>
                    <UsageCell artifact={artifact} />
                  </TableCell>
                  <TableCell>
                    <ActivityCell artifact={artifact} />
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
      <span className="block">
        {activity.currentBytes === null ? t("list.noVersion") : formatBytes(activity.currentBytes)}
      </span>
      <span className="block text-text-muted">
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
      <span className="block">{t("list.updated", { date: formatDate(artifact.updatedAt) })}</span>
      {artifact.annotations !== "off" || activity.openThreads > 0 ? (
        <span className="block">{t("list.openThreads", { count: activity.openThreads })}</span>
      ) : null}
      {activity.lastAnnotationAt ? (
        <span className="block text-text-muted">
          {t("list.lastComment", { date: formatDate(activity.lastAnnotationAt) })}
        </span>
      ) : null}
    </>
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
 * Search by name or ID and filter by state, type, access and comments. The API applies them,
 * so they cover every page, not only the loaded one. Submitting puts them in the URL.
 */
function FilterForm({
  filters,
  busy,
  onApply,
}: {
  filters: ArtifactListFilters;
  busy: boolean;
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

  const any = (label: string) => ({ value: ANY, label });
  return (
    <form.AppForm>
      <form.Form label={t("list.filter.label")}>
        <div className="flex flex-col gap-4 rounded-md border border-border p-4">
          <form.AppField name="search">
            {(field) => (
              <field.TextField
                type="search"
                label={t("list.filter.search")}
                description={t("list.filter.searchHint")}
                autoComplete="off"
              />
            )}
          </form.AppField>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <form.AppField name="state">
              {(field) => (
                <field.SelectField
                  label={t("list.filter.state")}
                  options={[
                    any(t("list.filter.anyState")),
                    ...ListedArtifactState.options.map((value) => ({
                      value,
                      label: t(`state.${value}`),
                    })),
                  ]}
                />
              )}
            </form.AppField>
            <form.AppField name="type">
              {(field) => (
                <field.SelectField
                  label={t("list.filter.type")}
                  options={[
                    any(t("list.filter.anyType")),
                    ...ArtifactType.options.map((value) => ({ value, label: t(`type.${value}`) })),
                  ]}
                />
              )}
            </form.AppField>
            <form.AppField name="access">
              {(field) => (
                <field.SelectField
                  label={t("list.filter.access")}
                  options={[
                    any(t("list.filter.anyAccess")),
                    ...AccessMode.options.map((value) => ({
                      value,
                      label: t(`list.access.${value}`),
                    })),
                  ]}
                />
              )}
            </form.AppField>
            <form.AppField name="annotations">
              {(field) => (
                <field.SelectField
                  label={t("list.filter.annotations")}
                  options={[
                    any(t("list.filter.anyAnnotations")),
                    ...AnnotationsState.options.map((value) => ({
                      value,
                      label: t(`list.annotations.${value}`),
                    })),
                  ]}
                />
              )}
            </form.AppField>
          </div>
          <div className="flex flex-wrap gap-2">
            <form.SubmitButton icon={<Search className="size-4" />} busy={busy}>
              {t("list.filter.submit")}
            </form.SubmitButton>
            <Button icon={<X className="size-4" />} onClick={() => onApply({})}>
              {t("list.filter.clear")}
            </Button>
          </div>
        </div>
      </form.Form>
    </form.AppForm>
  );
}

/** The message for a failed call, from its documented error code. */
export function errorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  return t(`error.${error instanceof ApiFailure ? error.code : "unexpected"}`);
}
