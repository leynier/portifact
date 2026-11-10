// Comparing two versions in the history (premium plan P3): choose an earlier and a later
// version, see the files that differ and, for one file, its line diff unified or side by side.
// Whether the owner's plan includes it comes from the version list (the artifact owner's plan,
// a workspace's for a workspace artifact), never from the signed-in user's plan.
import {
  type DownloadKind,
  lowestPlanWith,
  PLAN_LABELS,
  type VersionComparison,
  type VersionSummary,
} from "@portifact/contracts";
import {
  Badge,
  Button,
  Callout,
  DiffView,
  type DiffViewHunk,
  type DiffViewLabels,
  LoadingState,
  Panel,
  RadioGroup,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleAlert, FileDiff, GitCompare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useFormatBytes, useT } from "../context.tsx";
import { errorMessage } from "./artifact-list.tsx";

interface Pair {
  from: string;
  to: string;
}

type Layout = "unified" | "split";

interface ChosenFile {
  kind: DownloadKind;
  path: string;
}

export function CompareVersions({
  artifactId,
  versions,
  versionDiff,
}: {
  artifactId: string;
  versions: VersionSummary[];
  versionDiff: boolean;
}) {
  const t = useT();
  const [from, setFrom] = useState(versions[1]?.id ?? "");
  const [to, setTo] = useState(versions[0]?.id ?? "");
  const [pair, setPair] = useState<Pair | null>(null);

  if (!versionDiff) {
    return (
      <Panel title={t("compare.title")}>
        <p className="text-sm text-text-muted">
          {t("compare.paid", { plan: PLAN_LABELS[lowestPlanWith("versionDiff")] })}
        </p>
      </Panel>
    );
  }
  if (versions.length < 2) {
    return (
      <Panel title={t("compare.title")}>
        <p className="text-sm text-text-muted">{t("compare.needTwo")}</p>
      </Panel>
    );
  }
  const options = versions.map((version) => ({
    value: version.id,
    label: version.current
      ? t("compare.currentOption", { number: version.number })
      : t("history.version", { number: version.number }),
  }));
  return (
    <Panel title={t("compare.title")} description={t("compare.description")}>
      <form
        className="flex flex-col gap-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setPair({ from, to });
        }}
      >
        <div className="sm:w-56">
          <Select label={t("compare.from")} value={from} options={options} onChange={setFrom} />
        </div>
        <div className="sm:w-56">
          <Select label={t("compare.to")} value={to} options={options} onChange={setTo} />
        </div>
        <div>
          <Button type="submit" intent="primary" icon={<GitCompare className="size-4" />}>
            {t("compare.submit")}
          </Button>
        </div>
      </form>
      {pair ? (
        <Comparison key={`${pair.from}-${pair.to}`} artifactId={artifactId} pair={pair} />
      ) : null}
    </Panel>
  );
}

function Comparison({ artifactId, pair }: { artifactId: string; pair: Pair }) {
  const t = useT();
  const formatBytes = useFormatBytes();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const [file, setFile] = useState<ChosenFile | null>(null);
  const comparison = useInfiniteQuery({
    queryKey: ["compare", artifactId, pair.from, pair.to],
    queryFn: ({ pageParam }) => api.compareVersions(artifactId, pair.from, pair.to, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const first = comparison.data?.pages[0];
  useEffect(() => {
    if (first) announce(summaryText(t, first));
  }, [first, announce, t]);

  if (comparison.isPending) return <LoadingState label={t("compare.loading")} />;
  if (comparison.isError || !first) {
    return (
      <Callout
        tone="error"
        title={t("compare.error.title")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, comparison.error)}
      </Callout>
    );
  }
  const files = comparison.data.pages.flatMap((page) => page.files);
  const size = (side: { size: number } | null) =>
    side === null ? t("compare.noFile") : formatBytes(side.size);
  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm font-semibold">{summaryText(t, first)}</p>
      {files.length === 0 ? (
        <p className="text-sm text-text-muted">{t("compare.none")}</p>
      ) : (
        <Table
          caption={t("compare.caption", { from: first.from.number, to: first.to.number })}
          stacked
        >
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("compare.column.file")}</TableHeaderCell>
              <TableHeaderCell>{t("compare.column.change")}</TableHeaderCell>
              <TableHeaderCell>{t("compare.column.size")}</TableHeaderCell>
              <TableHeaderCell>{t("history.column.actions")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {files.map((entry) => (
              <TableRow key={`${entry.kind}/${entry.path}`}>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono break-all">{entry.path}</span>
                    {entry.kind === "source" ? <Badge>{t("compare.source")}</Badge> : null}
                  </span>
                </TableCell>
                <TableCell label={t("compare.column.change")}>
                  {t(`compare.change.${entry.change}`)}
                </TableCell>
                <TableCell label={t("compare.column.size")}>
                  <span className="whitespace-nowrap tabular-nums">
                    {t("compare.sizes", { before: size(entry.before), after: size(entry.after) })}
                  </span>
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    intent="ghost"
                    icon={<FileDiff className="size-4" />}
                    aria-label={t("compare.showLabel", { path: entry.path })}
                    aria-pressed={file?.kind === entry.kind && file.path === entry.path}
                    onClick={() => setFile({ kind: entry.kind, path: entry.path })}
                  >
                    {t("compare.show")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {comparison.hasNextPage ? (
        <div>
          <Button busy={comparison.isFetchingNextPage} onClick={() => comparison.fetchNextPage()}>
            {t("compare.loadMore")}
          </Button>
        </div>
      ) : null}
      {file ? (
        <FileChanges
          key={`${file.kind}/${file.path}`}
          artifactId={artifactId}
          pair={pair}
          file={file}
          onClose={() => setFile(null)}
        />
      ) : null}
    </div>
  );
}

function summaryText(t: ReturnType<typeof useT>, page: VersionComparison): string {
  return t("compare.summary", {
    from: page.from.number,
    to: page.to.number,
    added: page.counts.added,
    removed: page.counts.removed,
    changed: page.counts.changed,
    unchanged: page.counts.unchanged,
  });
}

function FileChanges({
  artifactId,
  pair,
  file,
  onClose,
}: {
  artifactId: string;
  pair: Pair;
  file: ChosenFile;
  onClose: () => void;
}) {
  const t = useT();
  const formatBytes = useFormatBytes();
  const { api } = useDashboard();
  const [layout, setLayout] = useState<Layout>("unified");
  const heading = useRef<HTMLHeadingElement>(null);
  const diff = useInfiniteQuery({
    queryKey: ["compare-file", artifactId, pair.from, pair.to, file.kind, file.path],
    queryFn: ({ pageParam }) => api.fileDiff(artifactId, pair.from, pair.to, file, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) =>
      page.diff.status === "text" ? (page.diff.nextCursor ?? undefined) : undefined,
  });
  // The changes open below the list: take the keyboard and screen reader there.
  useEffect(() => heading.current?.focus(), []);

  const labels: DiffViewLabels = {
    before: t("diff.column.before"),
    after: t("diff.column.after"),
    change: t("diff.column.change"),
    text: t("diff.column.text"),
    added: t("diff.added"),
    removed: t("diff.removed"),
    unchanged: t("diff.unchanged"),
    noNewline: t("diff.noNewline"),
    hunk: (hunk: DiffViewHunk) =>
      t("diff.hunk", { before: hunk.beforeStart, after: hunk.afterStart }),
  };
  const first = diff.data?.pages[0];
  let body: React.ReactNode;
  if (diff.isPending) {
    body = <LoadingState label={t("diff.loading")} />;
  } else if (diff.isError || !first) {
    body = (
      <Callout
        tone="error"
        title={t("compare.error.title")}
        icon={<CircleAlert className="size-5" />}
      >
        {errorMessage(t, diff.error)}
      </Callout>
    );
  } else if (first.diff.status !== "text") {
    const size = (side: { size: number } | null) =>
      side === null ? t("compare.noFile") : formatBytes(side.size);
    body = (
      <p className="text-sm">
        {t(`diff.status.${first.diff.status}`)}{" "}
        {t("compare.sizes", { before: size(first.before), after: size(first.after) })}
      </p>
    );
  } else {
    const hunks = diff.data.pages.flatMap((page) =>
      page.diff.status === "text" ? page.diff.hunks : [],
    );
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t("diff.counts", { added: first.diff.added, removed: first.diff.removed })}
        </p>
        <RadioGroup<Layout>
          legend={t("diff.layout")}
          name="diff-layout"
          layout="row"
          value={layout}
          options={[
            { value: "unified", label: t("diff.unified") },
            { value: "split", label: t("diff.split") },
          ]}
          onChange={setLayout}
        />
        <DiffView
          caption={t("diff.caption", {
            path: file.path,
            from: first.from.number,
            to: first.to.number,
          })}
          hunks={hunks}
          layout={layout}
          labels={labels}
        />
        {diff.hasNextPage ? (
          <div>
            <Button busy={diff.isFetchingNextPage} onClick={() => diff.fetchNextPage()}>
              {t("diff.more")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <section
      aria-labelledby="file-changes-heading"
      className="flex flex-col gap-4 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id="file-changes-heading"
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold break-all"
        >
          {t("diff.title", { path: file.path })}
        </h3>
        <Button size="sm" intent="ghost" icon={<X className="size-4" />} onClick={onClose}>
          {t("diff.close")}
        </Button>
      </div>
      {body}
    </section>
  );
}
