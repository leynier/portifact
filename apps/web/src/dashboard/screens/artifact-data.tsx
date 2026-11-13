// The Data section of the artifact page (decision 0026, delivery 5): read only. It lists the
// artifact's collections with today's counters against the plan's limits, pages through one
// collection's documents and downloads the export file. Documents are written by visitors, so
// each is shown as JSON text in a code sample, never rendered. The API decides who may read
// them (the owner side) and whether artifact data is switched on; while it is off, or for a
// role without it, the section is not shown at all.
import type { CollectionInfo, CollectionMode, DataDescriptionView } from "@portifact/contracts";
import {
  Button,
  Callout,
  CodeSample,
  DetailList,
  EmptyState,
  LoadingState,
  Panel,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, Database, Download, RefreshCw, Rewind } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useFormatBytes, useFormatNumber, useT } from "../context.tsx";
import { buildDataExport } from "../data-export.ts";
import type { MessageId } from "../i18n/en.ts";
import { safeFileName } from "../publish/download.ts";
import { refreshOptions } from "../refresh.ts";
import { errorMessage } from "./artifact-list.tsx";

/** Documents one page of the section shows. */
export const DATA_PAGE_SIZE = 20;

export const artifactDataQuery = (artifactId: string) => ["artifact", artifactId, "data"] as const;

/** The artifact's data description, shared by the page's section list and the section. */
export function useArtifactData(artifactId: string) {
  const { api } = useDashboard();
  return useQuery({
    queryKey: artifactDataQuery(artifactId),
    queryFn: () => api.artifactData(artifactId),
    ...refreshOptions,
  });
}

/**
 * Whether the page shows the section: not while artifact data is off (`not_found`) or for a role
 * the API refuses (`forbidden`).
 */
export function dataSectionShown(query: ReturnType<typeof useArtifactData>): boolean {
  if (query.data) return true;
  if (query.error instanceof ApiFailure) {
    return query.error.code !== "not_found" && query.error.code !== "forbidden";
  }
  return query.isError;
}

const MODES: Record<CollectionMode, MessageId> = {
  own: "artifactData.mode.own",
  append: "artifactData.mode.append",
  read: "artifactData.mode.read",
  shared: "artifactData.mode.shared",
};

export function ArtifactData({ artifactId, name }: { artifactId: string; name: string }) {
  const t = useT();
  const data = useArtifactData(artifactId);
  if (data.isPending) return <LoadingState label={t("artifactData.loading")} />;
  if (!data.data) {
    return (
      <Callout
        tone="error"
        title={t("artifactData.error.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => data.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, data.error)}
      </Callout>
    );
  }
  const view = data.data;
  if (!view.exists || view.collections.length === 0) {
    return (
      <EmptyState title={t("artifactData.empty.title")} icon={<Database className="size-5" />}>
        {t("artifactData.empty.body")}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Panel
        headingLevel={3}
        title={t("artifactData.collections.title")}
        description={t("artifactData.hint")}
        actions={<ExportButton artifactId={artifactId} name={name} />}
      >
        <div className="flex flex-col gap-4">
          <Collections collections={view.collections} />
          <Usage view={view} />
        </div>
      </Panel>
      <Documents artifactId={artifactId} collections={view.collections} />
    </div>
  );
}

function Collections({ collections }: { collections: CollectionInfo[] }) {
  const t = useT();
  const formatNumber = useFormatNumber();
  const formatBytes = useFormatBytes();
  return (
    <Table caption={t("artifactData.collections.caption")} variant="flush">
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("artifactData.column.collection")}</TableHeaderCell>
          <TableHeaderCell>{t("artifactData.column.mode")}</TableHeaderCell>
          <TableHeaderCell>{t("artifactData.column.documents")}</TableHeaderCell>
          <TableHeaderCell>{t("artifactData.column.size")}</TableHeaderCell>
          <TableHeaderCell>{t("artifactData.column.indexed")}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {collections.map((collection) => (
          <TableRow key={collection.name}>
            <TableCell>
              <span className="font-mono">{collection.name}</span>
            </TableCell>
            <TableCell>{t(MODES[collection.mode])}</TableCell>
            <TableCell>
              <span className="tabular-nums">{formatNumber(collection.documents)}</span>
            </TableCell>
            <TableCell>
              <span className="tabular-nums">{formatBytes(collection.bytes)}</span>
            </TableCell>
            <TableCell>
              {collection.indexed.length === 0
                ? t("artifactData.indexed.none")
                : collection.indexed
                    .map((field) =>
                      field.state === "building"
                        ? t("artifactData.indexed.building", { field: field.field })
                        : field.field,
                    )
                    .join(", ")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Usage({ view }: { view: DataDescriptionView }) {
  const t = useT();
  const formatNumber = useFormatNumber();
  const formatBytes = useFormatBytes();
  const of = (used: number, limit: number) =>
    t("artifactData.usage.ofLimit", { used: formatNumber(used), limit: formatNumber(limit) });
  return (
    <DetailList
      items={[
        {
          term: t("artifactData.usage.stored"),
          detail: t("artifactData.usage.ofLimit", {
            used: formatBytes(view.storedBytes),
            limit: formatBytes(view.limits.bytesPerArtifact),
          }),
        },
        {
          term: t("artifactData.usage.read"),
          detail: of(view.today.read, view.limits.rowsReadPerDay),
        },
        {
          term: t("artifactData.usage.written"),
          detail: of(view.today.growth, view.limits.rowsWrittenPerDay),
        },
        {
          term: t("artifactData.usage.cleanup"),
          detail: of(view.today.cleanup, view.limits.cleanupRowsPerDay),
        },
        {
          term: t("artifactData.usage.export"),
          detail: of(view.today.export, view.limits.exportRowsPerDay),
        },
      ]}
    />
  );
}

function Documents({
  artifactId,
  collections,
}: {
  artifactId: string;
  collections: CollectionInfo[];
}) {
  const t = useT();
  const { api } = useDashboard();
  const [collection, setCollection] = useState(collections[0]?.name ?? "");
  // The cursors of the pages before the current one, so "First page" can go back.
  const [after, setAfter] = useState<string | undefined>(undefined);
  const page = useQuery({
    queryKey: [...artifactDataQuery(artifactId), collection, after ?? ""] as const,
    queryFn: () => api.dataDocuments(artifactId, collection, after, DATA_PAGE_SIZE),
    enabled: collection !== "",
    ...refreshOptions,
  });
  const choose = (name: string) => {
    setCollection(name);
    setAfter(undefined);
  };

  let body: ReactNode;
  if (page.isPending) {
    body = <LoadingState label={t("artifactData.documents.loading")} />;
  } else if (!page.data) {
    body = (
      <Callout
        tone="error"
        title={t("artifactData.documents.error")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => page.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {errorMessage(t, page.error)}
      </Callout>
    );
  } else if (page.data.documents.length === 0) {
    body = <p className="text-sm text-text-muted">{t("artifactData.documents.none")}</p>;
  } else {
    body = (
      <ul className="flex flex-col gap-3">
        {page.data.documents.map((document) => (
          <li key={document._id}>
            <CodeSample
              label={t("artifactData.document.label", { id: document._id })}
              code={JSON.stringify(document, null, 2)}
            />
          </li>
        ))}
      </ul>
    );
  }
  const next = page.data?.next ?? null;
  return (
    <Panel
      headingLevel={3}
      title={t("artifactData.documents.title")}
      description={t("artifactData.untrusted")}
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t("artifactData.collection.label")}
          value={collection}
          options={collections.map((item) => ({ value: item.name, label: item.name }))}
          onChange={choose}
        />
        {body}
        {after !== undefined || next !== null ? (
          <div className="flex flex-wrap gap-2">
            {after !== undefined ? (
              <Button icon={<Rewind className="size-4" />} onClick={() => setAfter(undefined)}>
                {t("artifactData.documents.first")}
              </Button>
            ) : null}
            {next !== null ? (
              <Button icon={<ChevronRight className="size-4" />} onClick={() => setAfter(next)}>
                {t("artifactData.documents.next")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function ExportButton({ artifactId, name }: { artifactId: string; name: string }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const exporting = useMutation({
    mutationFn: () => buildDataExport(artifactId, (after) => api.dataExportPage(artifactId, after)),
    onMutate: () => announce(t("artifactData.exporting")),
    onSuccess: (file) => {
      const fileName = `${safeFileName(name)}-data.jsonl`;
      save({ fileName, blob: new Blob([file.text], { type: "application/jsonl" }) });
      announce(
        file.consistent
          ? t("artifactData.exported", { file: fileName })
          : t("artifactData.exportInconsistent"),
      );
    },
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        icon={<Download className="size-4" />}
        busy={exporting.isPending}
        onClick={() => exporting.mutate()}
      >
        {t("artifactData.export")}
      </Button>
      {exporting.isError ? (
        <Callout tone="error" title={t("artifactData.exportFailed")}>
          {errorMessage(t, exporting.error)}
        </Callout>
      ) : null}
    </div>
  );
}
