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
import { CircleAlert, Unplug } from "lucide-react";
import { useState } from "react";
import { useAnnounce, useDashboard, useFormatDate, useT } from "../context.tsx";
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
            <TableCell>{item.openGrants > 0 ? <Revoke item={item} /> : null}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
