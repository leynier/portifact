// "Data you shared" (`/shared-data`, decision 0026, "The grant"): the artifacts whose pages the
// person allowed to know them and save what they enter, with the grants still open, and a way to
// revoke them. Revoking applies within a minute everywhere the grant was used. What the person
// saved stays with the artifact; deleting or exporting it is the person's right on the artifact's
// own page. Names and hosts are untrusted text, rendered as text only.
import type { DataGrantView } from "@portifact/contracts";
import {
  Button,
  Callout,
  ConfirmDialog,
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
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Download, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
import { safeFileName } from "../publish/download.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { errorMessage } from "./artifact-list.tsx";

export const DATA_GRANTS_QUERY = ["data-grants"] as const;

export function SharedDataScreen() {
  const t = useT();
  useDocumentTitle(t("sharedData.title"));
  const { api } = useDashboard();
  const grants = useInfiniteQuery({
    queryKey: DATA_GRANTS_QUERY,
    queryFn: ({ pageParam }) => api.dataGrants(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const items = grants.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("sharedData.title")} description={t("sharedData.description")} />
      <div className="flex flex-col gap-4">
        {grants.isPending ? (
          <LoadingState label={t("sharedData.loading")} />
        ) : grants.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.failed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, grants.error)}
          </Callout>
        ) : items.length === 0 ? (
          <EmptyState title={t("sharedData.empty")}>{t("sharedData.emptyHint")}</EmptyState>
        ) : (
          <>
            <GrantTable items={items} />
            {grants.hasNextPage ? (
              <div>
                <Button
                  intent="secondary"
                  busy={grants.isFetchingNextPage}
                  onClick={() => void grants.fetchNextPage()}
                >
                  {t("sharedData.more")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function GrantTable({ items }: { items: DataGrantView[] }) {
  const t = useT();
  const date = useFormatDate();
  return (
    <Table caption={t("sharedData.listTitle")} stacked>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t("sharedData.artifact")}</TableHeaderCell>
          <TableHeaderCell>{t("sharedData.since")}</TableHeaderCell>
          <TableHeaderCell>{t("sharedData.status")}</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">{t("sharedData.actions")}</span>
          </TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.artifactId}>
            <TableCell>
              <div className="flex flex-col">
                <span>{item.artifactName ?? t("sharedData.gone")}</span>
                <span className="text-sm text-text-muted">{item.host}</span>
              </div>
            </TableCell>
            <TableCell>{date(item.firstGrantedAt)}</TableCell>
            <TableCell>
              {item.openGrants > 0 && item.expiresAt !== null
                ? t("sharedData.open", { date: date(item.expiresAt) })
                : t("sharedData.ended")}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-2">
                <OwnData item={item} />
                {item.openGrants > 0 ? <Revoke item={item} /> : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Pages one export or delete reads at most: far above what one person writes in an artifact. */
const MAX_PAGES = 200;

/** Every document the person created in the artifact, page by page. */
async function ownRows(
  api: ReturnType<typeof useDashboard>["api"],
  artifactId: string,
): Promise<{ collection: string; id: string }[]> {
  const rows: { collection: string; id: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer: { rows: { collection: string; id: string }[]; next: string | null } =
      await api.ownData(artifactId, after);
    rows.push(...answer.rows);
    if (answer.next === null) return rows;
    after = answer.next;
  }
  return rows;
}

/**
 * What the person saved in the artifact: download it as JSON Lines (their own documents, as
 * stored, untrusted text) or delete it, whether or not a grant is still open.
 */
function OwnData({ item }: { item: DataGrantView }) {
  const t = useT();
  const announce = useAnnounce();
  const { api, save } = useDashboard();
  const [confirming, setConfirming] = useState(false);
  const name = item.artifactName ?? item.host;
  const download = useMutation({
    mutationFn: () => ownRows(api, item.artifactId),
    onSuccess: (rows) => {
      if (rows.length === 0) {
        announce(t("sharedData.nothingSaved", { name }));
        return;
      }
      const fileName = `${safeFileName(name)}-my-data.jsonl`;
      const text = rows.map((row) => JSON.stringify(row)).join("\n");
      save({ fileName, blob: new Blob([`${text}\n`], { type: "application/jsonl" }) });
      announce(t("sharedData.downloaded", { file: fileName }));
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const rows = await ownRows(api, item.artifactId);
      for (const row of rows) await api.deleteOwnDocument(item.artifactId, row.collection, row.id);
      return rows.length;
    },
    onSuccess: (count) => {
      setConfirming(false);
      announce(t("sharedData.deleted", { name, count }));
    },
  });
  return (
    <>
      <Button
        intent="secondary"
        icon={<Download className="size-4" />}
        busy={download.isPending}
        onClick={() => download.mutate()}
        aria-label={t("sharedData.downloadNamed", { name })}
      >
        {t("sharedData.download")}
      </Button>
      <Button
        intent="danger"
        icon={<Trash2 className="size-4" />}
        onClick={() => setConfirming(true)}
        aria-label={t("sharedData.deleteMineNamed", { name })}
      >
        {t("sharedData.deleteMine")}
      </Button>
      {download.isError ? (
        <Callout
          tone="error"
          title={t("sharedData.downloadFailed")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, download.error)}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("sharedData.deleteTitle", { name })}
        confirmLabel={t("sharedData.deleteMine")}
        cancelLabel={t("sharedData.cancel")}
        confirmIcon={<Trash2 className="size-4" />}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("sharedData.deleteBody")}
        {remove.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.deleteFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, remove.error)}
          </Callout>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function Revoke({ item }: { item: DataGrantView }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = item.artifactName ?? item.host;
  const revoke = useMutation({
    mutationFn: () => api.revokeDataGrants(item.artifactId),
    onSuccess: () => {
      setConfirming(false);
      announce(t("sharedData.revoked", { name }));
      void queryClient.invalidateQueries({ queryKey: DATA_GRANTS_QUERY });
    },
  });
  return (
    <>
      <Button
        intent="danger"
        icon={<Unplug className="size-4" />}
        onClick={() => setConfirming(true)}
        aria-label={t("sharedData.revokeNamed", { name })}
      >
        {t("sharedData.revoke")}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t("sharedData.confirmTitle", { name })}
        confirmLabel={t("sharedData.revoke")}
        cancelLabel={t("sharedData.cancel")}
        confirmIcon={<Unplug className="size-4" />}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onCancel={() => setConfirming(false)}
      >
        {t("sharedData.confirmBody")}
        {revoke.isError ? (
          <Callout
            tone="error"
            title={t("sharedData.revokeFailed")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, revoke.error)}
          </Callout>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
